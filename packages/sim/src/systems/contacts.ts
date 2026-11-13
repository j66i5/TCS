/**
 * CONTACTS AND SHARING (SPEC 6.5, M3.3): what each soldier knows of the enemy, and how it spreads.
 *
 * Sources: his own eyes (the enemies he has in sight: an exact position), his ears (an enemy shot within
 * hearing range: owner decision — the direction at once, a position only if he is seen; the direction carries
 * an error and the distance is a rough guess), and reports from comrades. A contact keeps the position as it
 * was last known; its uncertainty grows with age, and it is forgotten after a while.
 *
 * Sharing: what a man sees or hears himself he passes on to the men of his unit (his top-level unit) — by voice
 * to those within the comms model's voice range, by radio to the others after the comms model's delay; at most
 * every few seconds per enemy. Reports are not passed on again. A unit calls a new contact out on the radio log.
 * All of it passes through the CommsModel, so a richer model (radio nets, jamming: M14) changes it in one place.
 *
 * Surrender (M6.6): a man who sees an enemy who has given up marks his own contact `surrendered` — the only
 * place the flag is created — and passes that news on at once; a report carries it, and nothing clears it
 * while the contact lasts. Who may be fired at is decided on this flag, never on the enemy's real state.
 */
import type { Contact, SoldierState } from "../components";
import type { SimContext } from "../context";
import type { EventSink, SimEvent } from "../events";
import { secondsToTicks, TICK_HZ, type EntityId } from "../ids";
import { canReport, isAble, isCaptive } from "../impair";
import { atan2, cos, PI, sin, sqrt } from "../math";
import { nextNormal, Streams } from "../rng";
import type { SimState } from "../state";
import { cellIndex } from "../terrain";
import { unitSoldiers } from "./orders";

/** Uncertainty of a contact now: its own, plus how far the man may have moved since. */
export function contactErrorM(ctx: SimContext, c: Contact, tick: number): number {
  // (A vehicle can have gone much farther than a man on foot, M7.3.)
  const drift = c.cls === "vehicle" ? ctx.catalog.spotting.vehicles.driftMps : ctx.catalog.spotting.contacts.driftMps;
  return c.errM + drift * Math.max(0, tick - c.tick) / TICK_HZ;
}

function findContact(list: Contact[], target: EntityId): number {
  let lo = 0, hi = list.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1, t = list[mid]!.target;
    if (t === target) return mid;
    if (t < target) lo = mid + 1; else hi = mid - 1;
  }
  return -(lo + 1);
}

/**
 * Put a contact into a man's list (sorted by target), or update it if the news is better: what he sees beats
 * everything; otherwise the one that is more certain NOW (its uncertainty plus how far the man may have moved
 * since) wins — so an exact sighting reported a few seconds ago beats a fresh guess from the sound of a shot.
 * Returns true if the contact is new to him.
 */
function learn(ctx: SimContext, list: Contact[], c: Omit<Contact, "reportedTick">, reportedTick: number, now: number): boolean {
  const i = findContact(list, c.target);
  if (i >= 0) {
    const old = list[i]!;
    // "He gave up" is kept even from a vaguer report, and never taken back.
    if (c.surrendered === true && old.surrendered !== true) old.surrendered = true;
    // "He is down" likewise (package A).
    if (c.down === true && old.down !== true) old.down = true;
    // What he knows a vehicle to be is kept (its type once identified, M7.3).
    if (c.cls !== undefined) old.cls = c.cls;
    if (c.vtype !== undefined) old.vtype = c.vtype;
    if (c.kind !== "seen" && contactErrorM(ctx, c as Contact, now) > contactErrorM(ctx, old, now)) return false;
    old.x = c.x; old.y = c.y; old.errM = c.errM; old.kind = c.kind; old.tick = c.tick;
    // His height (M7.5 review fix): what was seen or reported replaces it; a sound keeps the last known one.
    if (c.z !== undefined) old.z = c.z;
    else if (c.kind !== "heard" && old.z !== undefined) delete old.z;
    // His posture (soldier AI package A): what was seen or reported replaces it; a sound keeps the last seen one.
    if (c.posture !== undefined) old.posture = c.posture;
    if (c.heading !== undefined) { old.heading = c.heading; old.vx = c.vx ?? 0; old.vy = c.vy ?? 0; }
    return false;
  }
  list.splice(-(i + 1), 0, { ...c, reportedTick });
  return true;
}

function topUnit(state: SimState, soldier: EntityId): EntityId | null {
  let u: EntityId | null = state.identity.get(soldier)?.unit ?? null;
  for (;;) {
    if (u === null) return null;
    const p: EntityId | null = state.unit.get(u)?.parent ?? null;
    if (p === null) return u;
    u = p;
  }
}

/** Bearing in whole degrees, 0 = north (up the map), clockwise. */
function bearingDeg(dx: number, dy: number): number {
  const b = Math.round((atan2(dx, -dy) * 180) / PI);
  return b < 0 ? b + 360 : b;
}

export function contactSystem(ctx: SimContext, state: SimState, events: EventSink): void {
  const K = ctx.catalog.spotting.contacts, tick = state.tick;
  const forget = secondsToTicks(K.forgetSeconds), reportEvery = secondsToTicks(K.reportEverySeconds);
  // (`news`: new to him, or he has just seen that the man gave up — passed on at once.)
  const fresh: { who: EntityId; c: Omit<Contact, "reportedTick">; isNew: boolean; news: boolean }[] = [];

  // ---- deliver reports that have arrived
  if (state.contactReports.length > 0) {
    const keep = [];
    for (const r of state.contactReports) {
      if (r.deliverTick > tick) { keep.push(r); continue; }
      const s = state.soldier.get(r.to);
      if (!s || !isAble(s)) continue;
      learn(ctx, s.contacts, r.contact, tick, tick); // reports are not passed on again
    }
    state.contactReports = keep;
  }

  // ---- what each man sees this tick (only men who scanned: their `seen` was confirmed now)
  // mounted: ok men aboard see nothing (spotting gives them no `seen`)
  for (const [id, s] of state.soldier.entries()) {
    if (s.seen.length === 0) continue;
    const me = state.transform.get(id);
    if (!me) continue;
    for (const e of s.seen) {
      if (e.lastTick !== tick) continue;
      const t = state.transform.get(e.target);
      if (!t) continue;
      const range = sqrt((t.x - me.x) * (t.x - me.x) + (t.y - me.y) * (t.y - me.y));
      const k = findContact(s.contacts, e.target), isNew = k < 0;
      // With his own eyes, this tick: he sees that the man has given up (the only place the flag is created).
      const gaveUp = isCaptive(state.soldier.get(e.target));
      const c: Omit<Contact, "reportedTick"> = { target: e.target, x: t.x, y: t.y, errM: K.seenErrorM + K.seenErrorPerM * range, kind: "seen", tick, ...(gaveUp ? { surrendered: true as const } : {}) };
      // A man on foot upstairs (M7.5 review fix): the height he was seen at.
      const ts = state.soldier.get(e.target);
      // He sees him lying hit (package A).
      const isDown = ts !== undefined && ts.casualty !== "none";
      if (isDown) c.down = true;
      if (t.z > 0 && ts?.mount === undefined) c.z = t.z;
      // A man on foot: the posture he is seen in (what the shooter aims at, package A).
      if (ts !== undefined && ts.mount === undefined) c.posture = ts.posture;
      // A vehicle (M7.3): its heading and movement; its type once within the range it can be told at (owner Q6).
      const veh = state.vehicle.size > 0 ? state.vehicle.get(e.target) : undefined;
      if (veh) {
        const def = ctx.catalog.vehicles[veh.def];
        c.cls = "vehicle"; c.heading = t.heading; c.vx = cos(t.heading) * veh.drive.speed; c.vy = sin(t.heading) * veh.drive.speed;
        if (def && range <= def.signature.identifyM) c.vtype = veh.def;
      }
      const news = isNew || (gaveUp && s.contacts[k]!.surrendered !== true) || (isDown && s.contacts[k]!.down !== true);
      learn(ctx, s.contacts, c, -1e9, tick);
      fresh.push({ who: id, c, isNew, news });
    }
  }

  // ---- he saw him fall (package A): a man he had in sight moments ago is down (a man killed drops out of sight at
  // once, so the sighting above never shows him lying). Each man every half second, staggered.
  // mounted: ok a crew's contacts are kept the same way
  for (const [id, s] of state.soldier.entries()) {
    if ((id + tick) % 30 !== 0 || s.contacts.length === 0 || !isAble(s)) continue;
    for (const c of s.contacts) {
      if (c.down === true || c.kind !== "seen" || tick - c.tick > 2 * TICK_HZ || c.cls === "vehicle") continue;
      const ts = state.soldier.get(c.target);
      if (ts === undefined || ts.casualty === "none") continue;
      c.down = true;
      // (News he passes on at once, like a surrender.)
      const { reportedTick: _r, ...known } = c;
      fresh.push({ who: id, c: known, isNew: false, news: true });
    }
  }

  // ---- what each man hears: an enemy shot within hearing range gives its direction and a rough distance
  const shots = (events.events as SimEvent[]).filter((e): e is Extract<SimEvent, { kind: "shot.fired" }> => e.kind === "shot.fired");
  if (shots.length > 0) {
    const hear2 = K.hearingRangeM * K.hearingRangeM, every = secondsToTicks(K.heardEverySeconds);
    const bearErr = (K.bearingErrorDeg * PI) / 180;
    // One sound per shooter per tick is enough (a burst is one sound).
    // (A cannon or coaxial machine gun is heard as its vehicle, M7.3.)
    const shooters = [...new Set(shots.map((e) => e.vehicle ?? e.shooter))].sort((a, b) => a - b);
    // Everyone who can hear, once per tick (ID order).
    const L: { id: EntityId; side: string; x: number; y: number; s: SoldierState }[] = [];
    for (const [id, s] of state.soldier.entries()) {
      if (!isAble(s) || s.mount !== undefined) continue; // men aboard hear nothing outside (M7)
      const t = state.transform.get(id), side = state.identity.get(id)?.side;
      if (t && side !== undefined) L.push({ id, side, x: t.x, y: t.y, s });
    }
    for (const shooter of shooters) {
      const side = state.identity.get(shooter)?.side ?? state.vehicle.get(shooter)?.side, st = state.transform.get(shooter);
      if (side === undefined || !st) continue;
      for (const l of L) {
        if (l.side === side) continue;
        const id = l.id, s = l.s, me = l;
        const dx = st.x - me.x, dy = st.y - me.y, d2 = dx * dx + dy * dy;
        if (d2 > hear2) continue;
        const i = findContact(s.contacts, shooter);
        const range = sqrt(d2);
        // Heard him moments ago, or knows where he is better than a sound could tell: nothing new.
        if (i >= 0 && (tick - s.contacts[i]!.tick < every || contactErrorM(ctx, s.contacts[i]!, tick) <= Math.max(10, K.rangeErrorFraction * range))) continue;
        const a = atan2(dy, dx) + bearErr * nextNormal(state.rng, Streams.contacts);
        const guess = Math.max(10, range * (1 + K.rangeErrorFraction * nextNormal(state.rng, Streams.contacts)));
        const gx = Math.min(Math.max(me.x + cos(a) * guess, 0), ctx.map.widthM), gy = Math.min(Math.max(me.y + sin(a) * guess, 0), ctx.map.heightM);
        const c: Omit<Contact, "reportedTick"> = { target: shooter, x: gx, y: gy, errM: Math.max(10, K.rangeErrorFraction * range), kind: "heard" as const, tick, ...(state.vehicle.has(shooter) ? { cls: "vehicle" as const } : {}) };
        const isNew = i < 0;
        learn(ctx, s.contacts, c, -1e9, tick);
        fresh.push({ who: id, c, isNew, news: isNew });
      }
    }
  }

  // ---- engines (M7.3): every few seconds, each man on foot hears the vehicles within their noise range
  if (state.vehicle.size > 0) hearEngines(ctx, state, fresh);

  // ---- pass on what he saw or heard himself; call new contacts out on the radio
  const called = new Set<EntityId>();
  // The men of each top unit, worked out once per tick (a platoon with many squads reports often, M7.3).
  const menOf = new Map<EntityId, EntityId[]>();
  for (const f of fresh) {
    const s = state.soldier.req(f.who);
    const i = findContact(s.contacts, f.c.target);
    if (i < 0) continue;
    const own = s.contacts[i]!;
    // What he sees he repeats now and then (the enemy moves); a sound only when it is new to him; that a man
    // has given up at once. A man who cannot speak (airway wound) passes nothing on.
    if (!f.news && (f.c.kind !== "seen" || tick - own.reportedTick < reportEvery)) continue;
    if (!canReport(s)) continue;
    own.reportedTick = tick;
    const top = topUnit(state, f.who);
    if (top === null) continue;
    const reported = { ...f.c, kind: "reported" as const, errM: f.c.errM + K.reportedErrorM };
    // mounted: ok what a comrade reports reaches men aboard by radio/intercom
    let men = menOf.get(top);
    if (!men) { men = unitSoldiers(state, top); menOf.set(top, men); }
    for (const m of men) {
      const ms = state.soldier.get(m);
      if (m === f.who || !isAble(ms)) continue;
      // He does not tell a comrade what that man already knows at least as well (unless it is news to him
      // that the enemy has given up).
      const k = findContact(ms!.contacts, f.c.target);
      if (k >= 0 && contactErrorM(ctx, ms!.contacts[k]!, tick) <= reported.errM && (reported.surrendered !== true || ms!.contacts[k]!.surrendered === true) && (reported.down !== true || ms!.contacts[k]!.down === true)) continue;
      const d = ctx.comms.contactShareDelayTicks(state, ctx.rules.comms, f.who, m);
      if (d === null) continue;
      state.contactReports.push({ deliverTick: tick + d + secondsToTicks(K.voiceDelaySeconds), from: f.who, to: m, contact: reported });
    }
    // Call-out: a contact new to him, his unit not having called out for a while (not about a man who gave up).
    const u = state.unit.get(top);
    if (f.isNew && f.c.surrendered !== true && u && !called.has(top) && tick - u.lastCallTick >= secondsToTicks(K.callEverySeconds)) {
      called.add(top);
      u.lastCallTick = tick;
      const me = state.transform.req(f.who);
      const dx = f.c.x - me.x, dy = f.c.y - me.y;
      const ident = state.identity.req(f.who);
      const callsign = state.unit.get(ident.unit)?.callsign ?? u.callsign;
      events.emit(f.c.kind === "seen"
        ? { kind: "radio", tick, side: ident.side, from: f.who, key: "radio.contactSeen", params: { callsign, range: Math.round(sqrt(dx * dx + dy * dy) / 10) * 10, bearing: bearingDeg(dx, dy) } }
        : { kind: "radio", tick, side: ident.side, from: f.who, key: "radio.contactHeard", params: { callsign, bearing: bearingDeg(dx, dy) } });
    }
  }

  // ---- forget old contacts (once a second per man, staggered), and those he saw die
  // mounted: ok contacts age for every man
  const forgetVeh = secondsToTicks(ctx.catalog.spotting.vehicles.forgetSeconds);
  for (const [id, s] of state.soldier.entries()) {
    if ((id + tick) % TICK_HZ !== 0 || s.contacts.length === 0) continue;
    s.contacts = s.contacts.filter((c) => tick - c.tick <= (c.cls === "vehicle" ? forgetVeh : forget) && !(c.kind === "seen" && state.soldier.get(c.target)?.physiology.alive === false));
  }
}

/**
 * Engine noise (M7.3, plan §10): within the vehicle's noise range (idling or moving) x (base + the surface's
 * noise) x (1 - rainK x rain), longer downwind and shorter upwind, a man on foot hears a vehicle: its direction
 * and a rough distance, as for a shot. Every `engineEverySeconds`; men aboard hear nothing outside.
 */
export function engineRangeM(ctx: SimContext, state: SimState, vid: EntityId, lx: number, ly: number): number {
  const v = state.vehicle.get(vid), t = state.transform.get(vid);
  const def = v ? ctx.catalog.vehicles[v.def] : undefined;
  if (!v || !t || !def || v.status === "destroyed" || v.status === "abandoned") return 0;
  const V = ctx.catalog.spotting.vehicles, env = state.environment;
  const moving = Math.abs(v.drive.speed) > V.movingAboveMps;
  const base = moving ? def.signature.noiseMovingM : def.signature.noiseIdleM;
  const cell = cellIndex(ctx.map, t.x, t.y);
  const surf = ctx.catalog.terrain.surfaces[ctx.map.surfacePalette[ctx.map.surface[cell] ?? 0] ?? ""];
  let k = (V.surfaceBase + (surf?.noise ?? 0.4)) * Math.max(0, 1 - V.rainK * env.rain);
  const wl = sqrt(env.windX * env.windX + env.windY * env.windY);
  const dx = lx - t.x, dy = ly - t.y, dl = sqrt(dx * dx + dy * dy);
  if (wl > 0.1 && dl > 1e-6) {
    const ca = (dx * env.windX + dy * env.windY) / (wl * dl);
    k *= ca >= 0 ? 1 + (V.downwind - 1) * ca : 1 + (1 - V.upwind) * ca;
  }
  return base * k;
}

function hearEngines(ctx: SimContext, state: SimState, fresh: { who: EntityId; c: Omit<Contact, "reportedTick">; isNew: boolean; news: boolean }[]): void {
  const K = ctx.catalog.spotting.contacts, V = ctx.catalog.spotting.vehicles, tick = state.tick;
  const every = Math.max(1, secondsToTicks(V.engineEverySeconds));
  if (tick % every !== 0) return;
  const bearErr = (K.bearingErrorDeg * PI) / 180;
  // The listeners, once (men on foot able to hear).
  const L: { id: EntityId; side: string; x: number; y: number; s: SoldierState }[] = [];
  // mounted: ok men aboard are skipped below
  for (const [id, s] of state.soldier.entries()) {
    if (!isAble(s) || s.mount !== undefined) continue;
    const side = state.identity.get(id)?.side, me = state.transform.get(id);
    if (side !== undefined && me) L.push({ id, side, x: me.x, y: me.y, s });
  }
  const wind = Math.max(1, ctx.catalog.spotting.vehicles.downwind);
  for (const [vid, v] of state.vehicle.entries()) {
    const vt = state.transform.get(vid);
    if (!vt) continue;
    // The farthest it can be heard (downwind): men beyond are not looked at further.
    const Rmax = engineRangeM(ctx, state, vid, vt.x, vt.y) * wind;
    if (Rmax <= 0) continue;
    for (const l of L) {
      if (l.side === v.side) continue;
      const id = l.id, s = l.s;
      const dx = vt.x - l.x, dy = vt.y - l.y, d2 = dx * dx + dy * dy;
      if (d2 > Rmax * Rmax) continue;
      const i = findContact(s.contacts, vid);
      // Heard (or seen) it lately: nothing new.
      if (i >= 0 && tick - s.contacts[i]!.tick < 3 * every) continue;
      const R = engineRangeM(ctx, state, vid, l.x, l.y);
      if (d2 > R * R) continue;
      const range = sqrt(d2);
      if (i >= 0 && contactErrorM(ctx, s.contacts[i]!, tick) <= Math.max(10, K.rangeErrorFraction * range)) continue;
      const me = l;
      const a = atan2(dy, dx) + bearErr * nextNormal(state.rng, Streams.contacts);
      const guess = Math.max(10, range * (1 + K.rangeErrorFraction * nextNormal(state.rng, Streams.contacts)));
      const gx = Math.min(Math.max(me.x + cos(a) * guess, 0), ctx.map.widthM), gy = Math.min(Math.max(me.y + sin(a) * guess, 0), ctx.map.heightM);
      const c: Omit<Contact, "reportedTick"> = { target: vid, x: gx, y: gy, errM: Math.max(10, K.rangeErrorFraction * range), kind: "heard", tick, cls: "vehicle" };
      const isNew = i < 0;
      learn(ctx, s.contacts, c, -1e9, tick);
      fresh.push({ who: id, c, isNew, news: isNew });
    }
  }
}
