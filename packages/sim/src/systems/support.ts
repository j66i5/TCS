/**
 * FIRE SUPPORT (M6.5c, pulled forward from M8 by the owner): a unit calls mortar fire — high explosive or
 * smoke — on a point. The call goes out by radio (the order's comms delay), then after the faction's
 * `fireSupport.delaySeconds` the rounds land one every `intervalSeconds`, each scattered about the aim point
 * (normal, `dispersionM` one standard deviation, own random stream). High explosive bursts like any other
 * explosive (blast, fragments, craters, suppression); smoke lays a cloud that blocks sight (spotting) for
 * `smokeSeconds` — not bullets. Each side has an allotment of rounds (`rules.support`).
 *
 * RANGING (step fire-support, owner 2026-11-13): a mission opens with `rangingRounds` single rounds, the first off
 * the point by the battery's aiming error (normal, `rangingErrorM` per axis). When the caller or a man of his
 * platoon sees where one fell (his eyes to a few metres above the burst: terrain, walls, woods, smoke), the error
 * shrinks to
 * `rangingCorrection` of itself; unseen, it stays. `rangingSeconds` later the next ranging round, then the whole
 * battery fires for effect: volleys of `tubes` rounds, `volleySpreadSeconds` apart, every `intervalSeconds`, each
 * round scattered by `dispersionM` about the corrected point. The ranging rounds come out of the section's stock
 * too (rule 9), on top of the rounds asked for while there are enough; short of rounds, the mission gives up
 * ranging rounds first (always one for effect). A point once ranged on, with at least one ranging round seen, is
 * remembered with the error left there: a new mission within `registeredM` fires for effect at once (an unobserved
 * point is not remembered: the next mission there ranges again).
 *
 * ON-MAP MORTARS (M8.3a, systems/mortars.ts): a call goes first to the side's set-up (or setting-up) mortar teams
 * that reach the point and hold rounds of the kind; each such tube joins the mission. Their rounds stay in the
 * crews' loads until the tube fires (rule 9: a round is taken out as it leaves the tube); the call's request and
 * the crews' own `processingSeconds`, then each round flies `flightBaseSeconds + flightPerKmSeconds x km` and falls
 * scattered by `dispersionPerKmM` per km of range about the aim. Ranging works as for the battery (the first error
 * from the tube's `aimErrorM` and the location method); one ranging round at a time, the next after the fall and
 * the correction; then every tube fires for effect at its own rate (`roundSeconds`). Rounds in flight are kept in
 * the mission (`flying`). With no team in range and no off-map battery, the call is refused out of range.
 */
import type { SimContext } from "../context";
import type { EventSink } from "../events";
import { secondsToTicks, type EntityId, type SideId } from "../ids";
import { canReport, isAble } from "../impair";
import { sqrt } from "../math";
import { addSmoke } from "../smoke";
import { nextNormal, Streams } from "../rng";
import { newEntity, type FireAmmo, type FireMission, type LocationMethod, type SimState, type SimView, type SupportSection } from "../state";
import { addItems, countItems, emptyContainer, removeItems } from "../items";
import { heightAt } from "../terrain";
import type { FactionDef } from "../catalog";
import type { SoldierState } from "../components";
import { ammoIndexOf } from "../projectiles";
import { detonate } from "./explosions";
import { adjustSkillFactor, bestObserverOf, observerOf, observerSees, observersFor, readErrorM } from "./observers";
import { crewAt, mortarTeams, takeRound, teamRounds, tubeOf, tubeRangeM, tubeReaches, type Tube } from "./mortars";
import { fireRateFactor, noteBeatenZone } from "./morale";


/** Give each side with an allotment its mortar section: an entity whose container holds the rounds. */
export function initSupport(ctx: SimContext, state: SimState): void {
  state.support = [];
  for (const s of ctx.rules.support ?? []) {
    const faction = state.sides.find((x) => x.id === s.side)?.faction;
    const art = s.asset === "artillery";
    const fd = faction ? ctx.catalog.factions[faction] : undefined;
    const fs = art ? fd?.artillery : fd?.fireSupport;
    if (!fs) continue;
    const battery = newEntity(state);
    const c = emptyContainer();
    if (s.he > 0) addItems(c, fs.heAmmo, s.he);
    if (s.smoke > 0) addItems(c, fs.smokeAmmo, s.smoke);
    if ((s.illum ?? 0) > 0 && fs.illumAmmo !== undefined) addItems(c, fs.illumAmmo, s.illum!);
    state.container.set(battery, c);
    const sec: SupportSection = { side: s.side, battery, heType: fs.heAmmo, smokeType: fs.smokeAmmo };
    if (art) sec.asset = "artillery";
    if (fs.illumAmmo !== undefined) sec.illumType = fs.illumAmmo;
    // Planned targets (M8.2a): registered before the battle, with what is left of the battery's error after an
    // observed adjustment there.
    if (s.planned && s.planned.length > 0) {
      sec.registered = s.planned.slice(-REGISTERED_MAX).map((p) => ({
        x: p.x, y: p.y, planned: true as const,
        ex: fs.rangingErrorM * fs.rangingCorrection * nextNormal(state.rng, Streams.support),
        ey: fs.rangingErrorM * fs.rangingCorrection * nextNormal(state.rng, Streams.support),
      }));
    }
    state.support.push(sec);
  }
}

/** Rounds the side may still call: its off-map section's container, and (M8.3a) its mortar teams' loads. */
export function supportLeft(state: SimView, side: SideId, ammo: FireAmmo, catalog?: SimContext["catalog"], asset: "mortar" | "artillery" = "mortar"): number {
  let n = 0;
  const s = sectionOf(state, side, asset);
  const c = s ? state.container.get(s.battery) : undefined;
  if (s && c) {
    const type = ammo === "he" ? s.heType : ammo === "smoke" ? s.smokeType : s.illumType;
    for (const st of c.stacks) if (st.type === type) n += st.count;
  }
  if (catalog && asset === "mortar" && ammo !== "illum") {
    for (const team of mortarTeams(state, side)) {
      const u = state.unit.get(team);
      if (!u) continue;
      for (const m of u.members) {
        const box = state.container.get(m);
        if (!box) continue;
        for (const st of box.stacks) { const def = catalog.items[st.type]?.mortar; if (def) { n += teamRounds(state, team, ammo === "he" ? def.he : def.smoke); break; } }
      }
    }
  }
  return n;
}

/** The fire support of a caller's faction (absent: none). */
type FireSupportDef = NonNullable<FactionDef["fireSupport"]>;

/** A side's off-map section of an asset (M8.4: mortars or the artillery battery). */
export function sectionOf<T extends { side: SideId; asset?: "artillery" }>(state: { support: readonly T[] }, side: SideId, asset: "mortar" | "artillery"): T | undefined {
  return state.support.find((x) => x.side === side && (x.asset === "artillery") === (asset === "artillery"));
}

/** The fire support asset of a faction (M8.4). */
export function assetDef(ctx: SimContext, faction: string, asset: "mortar" | "artillery" | undefined): FireSupportDef | undefined {
  const f = ctx.catalog.factions[faction];
  return asset === "artillery" ? f?.artillery : f?.fireSupport;
}

/**
 * Counter-battery (M8.4, owner M8 screen 2 (a), abstract): a battery that has fired `missionsBeforeMove` missions
 * displaces for `moveSeconds` and takes no calls meanwhile. A model of real counter-fire with losses can replace it.
 */
export interface CounterBatteryModel {
  /** Can the section take a call now? */
  available(fs: FireSupportDef, sec: SupportSection, tick: number): boolean;
  /** A mission was started: what it does to the section (it may set it moving after the mission's rounds). */
  afterMission(fs: FireSupportDef, sec: SupportSection, tick: number, missionTicks: number): void;
}
export const DISPLACE_MODEL: CounterBatteryModel = {
  available: (_fs, sec, tick) => sec.movingUntil === undefined || tick >= sec.movingUntil,
  afterMission: (fs, sec, tick, missionTicks) => {
    const cb = fs.counterBattery;
    if (!cb) return;
    sec.missions = (sec.missions ?? 0) + 1;
    if (sec.missions >= cb.missionsBeforeMove) { sec.missions = 0; sec.movingUntil = tick + missionTicks + secondsToTicks(cb.moveSeconds); }
  },
};

/** Seconds from the call reaching the section to the first volley for effect at a point not yet ranged on. */
export function secondsToEffect(fs: FireSupportDef): number {
  return fs.delaySeconds + fs.rangingRounds * fs.rangingSeconds;
}

/**
 * The call-for-fire chain's phases (M8.2a), seconds: the radio call, processing (computing, laying), the flight;
 * their sum is `delaySeconds`, the call reaching the section to the first round landing (before it, the order's
 * own comms delay).
 */
export function missionPhases(fs: FireSupportDef): { requestS: number; processingS: number; flightS: number } {
  const requestS = Math.min(fs.requestSeconds ?? 0, fs.delaySeconds);
  const flightS = Math.min(fs.flightSeconds ?? 0, fs.delaySeconds - requestS);
  return { requestS, processingS: fs.delaySeconds - requestS - flightS, flightS };
}

/** The first round's aiming error (one standard deviation per axis, m) for a point located by `method` at
 *  `distM` from the man who located it (M8.2a): the battery's own error and the location error together. */
export function firstRoundErrorM(fs: FireSupportDef, method: Exclude<LocationMethod, "registered">, distM: number, ownErrorM = fs.rangingErrorM): number {
  const L = fs.locationError?.[method];
  const loc = L ? L.baseM + L.perM * distM : 0;
  return sqrt(ownErrorM * ownErrorM + loc * loc);
}

/**
 * How the caller locates (x, y) for the first round (M8.2a; M9.5): by map or eye estimate; with a laser rangefinder
 * if he has one and sees the point; through his platoon's drone camera if one sees it (its slant range); by the
 * side's off-map reconnaissance drone (rules.airRecon). The method with the smallest first-round error is used.
 */
export function locateTarget(ctx: SimContext, state: SimState, fs: FireSupportDef, caller: EntityId, x: number, y: number, ownErrorM = fs.rangingErrorM): { method: Exclude<LocationMethod, "registered">; sd: number } {
  const t = state.transform.get(caller);
  const dist = t ? sqrt((t.x - x) * (t.x - x) + (t.y - y) * (t.y - y)) : 0;
  const o = observerOf(ctx, state, caller);
  let method: Exclude<LocationMethod, "registered"> = fs.locationError && o !== null && o.laser && observerSees(ctx, state, o, x, y) ? "laser" : "estimate";
  let sd = firstRoundErrorM(fs, method, dist, ownErrorM);
  const L = fs.locationError;
  if (L?.drone || L?.air) {
    for (const ob of observersFor(ctx, state, caller)) {
      if (ob.kind !== "drone" && ob.kind !== "air") continue;
      const kind = ob.kind;
      if (!L[kind] || !observerSees(ctx, state, ob, x, y)) continue;
      const slant = sqrt((ob.x - x) * (ob.x - x) + (ob.y - y) * (ob.y - y) + (ob.z - heightAt(ctx.map, x, y)) * (ob.z - heightAt(ctx.map, x, y))); // ground: ok (a point on the ground)
      const e = firstRoundErrorM(fs, kind, kind === "air" ? 0 : slant, ownErrorM);
      if (e < sd) { sd = e; method = kind; }
    }
  }
  return { method, sd };
}

/** The side's mortar teams that can take a mission on (x, y) (and the screen's other end): set up or setting up,
 *  enough crew at the tube, in range, holding rounds of the kind. `inRange: false` lists those only out of range. */
function onMapTubes(ctx: SimContext, state: SimState, side: SideId, x: number, y: number, ammo: "he" | "smoke", x2: number, y2: number): { ok: Tube[]; outOfRange: number } {
  const ok: Tube[] = [];
  let outOfRange = 0;
  for (const team of mortarTeams(state, side)) {
    const u = state.unit.get(team), tube = tubeOf(ctx, state, team);
    if (!u?.mortar || !tube || u.mortar.state === "packed") continue;
    if (crewAt(state, tube).length < tube.def.crewMin) continue;
    if (teamRounds(state, team, ammo === "he" ? tube.def.he : tube.def.smoke) <= 0) continue;
    if (tubeReaches(tube, x, y) && tubeReaches(tube, x2, y2)) ok.push(tube); else outOfRange++;
  }
  return { ok, outOfRange };
}

/** Start a fire mission (from a delivered `callFire` order). False if nobody can call or nothing is left; "range"
 *  (M8.3a) if the side's only mortars are on the map and none reaches the point. */
export function callFire(ctx: SimContext, state: SimState, events: EventSink, side: SideId, callers: readonly EntityId[], x: number, y: number, ammo: FireAmmo, rounds: number, line?: { x2: number; y2: number }, opts: { asset?: "artillery"; fuse?: "airburst"; dangerClose?: boolean } = {}): boolean | "range" | "dangerClose" | "moving" | "guided" | "noFuse" {
  // A screen (M8.1): ranging and registration at the line's middle, the rounds for effect along it.
  let lx = 0, ly = 0;
  if (line && ammo === "smoke") { lx = (line.x2 - x) / 2; ly = (line.y2 - y) / 2; x += lx; y += ly; }
  const caller = callers.find((m) => canReport(state.soldier.get(m)));
  const faction = caller !== undefined ? state.identity.get(caller)?.faction : undefined;
  const fs = faction ? assetDef(ctx, faction, opts.asset) : undefined;
  if (caller === undefined || !fs) return false;
  // Danger close (M8.4): a call this close to own men must say so.
  if (fs.dangerCloseM !== undefined && !opts.dangerClose && ownMenWithin(state, side, x - lx, y - ly, x + lx, y + ly, fs.dangerCloseM)) return "dangerClose";
  if (opts.fuse === "airburst" && fs.airburstHeightM === undefined) return "noFuse";
  const sec = sectionOf(state, side, opts.asset ?? "mortar");
  const c = sec ? state.container.get(sec.battery) : undefined;
  // On-map mortars first (M8.3a): the teams that reach the point (both ends of a screen); not for illumination.
  const om = opts.asset !== "artillery" && ammo !== "illum" ? onMapTubes(ctx, state, side, x - lx, y - ly, ammo, x + lx, y + ly) : { ok: [], outOfRange: 0 };
  if (om.ok.length > 0) return callOnMap(ctx, state, events, fs, side, caller, om.ok, x, y, lx, ly, ammo as "he" | "smoke", rounds, opts);
  const type = sec ? (ammo === "he" ? sec.heType : ammo === "smoke" ? sec.smokeType : sec.illumType ?? "") : "";
  if (!sec || !c || type === "" || countItems(c, type) <= 0) return om.outOfRange > 0 ? "range" : false;
  // A guided round (reserved, SPEC 6.8): refused until M9.
  if ((ctx.catalog.ammo[type]?.guidance ?? "unguided") !== "unguided") return "guided";
  if (!DISPLACE_MODEL.available(fs, sec, state.tick)) return "moving";
  // Ranging first, unless the section has already ranged on a point this close (its error there is known);
  // illumination needs none (M8.4).
  const r2 = fs.registeredM * fs.registeredM;
  const reg = sec.registered?.find((p) => (p.x - x) * (p.x - x) + (p.y - y) * (p.y - y) <= r2);
  const ranging = reg || ammo === "illum" ? 0 : fs.rangingRounds;
  // The rounds leave the section's stock now (they are fired as the mission runs): the ranging rounds on top of
  // those asked for while there are enough; short, the ranging rounds go first, one always left for effect.
  const n = removeItems(c, type, Math.min(rounds + ranging, countItems(c, type))).reduce((a, st) => a + st.count, 0);
  if (n <= 0) return false;
  const m: FireMission = { side, caller, x, y, ammo, left: n, nextTick: state.tick + secondsToTicks(fs.delaySeconds) };
  if (opts.asset === "artillery") m.asset = "artillery";
  if (opts.fuse === "airburst") m.fuse = "airburst";
  if (opts.dangerClose) m.dangerClose = true;
  const rg = Math.min(ranging, n - 1);
  if (rg > 0) m.ranging = rg;
  if (lx !== 0 || ly !== 0) { m.lx = lx; m.ly = ly; m.effect = n - rg; m.fired = 0; }
  // How the point was located (M8.2a): a registered or planned point; else a laser rangefinder if the caller has
  // one and sees the point; else a map or eye estimate. The first round's error follows from it.
  let sd = 0;
  if (reg) { m.ex = reg.ex; m.ey = reg.ey; m.method = "registered"; } else {
    const loc = locateTarget(ctx, state, fs, caller, x, y);
    m.method = loc.method; sd = loc.sd;
    if (sd > 0) {
      m.ex = sd * nextNormal(state.rng, Streams.support);
      m.ey = sd * nextNormal(state.rng, Streams.support);
    }
  }
  state.fireMissions.push(m);
  DISPLACE_MODEL.afterMission(fs, sec, state.tick, secondsToTicks(secondsToEffect(fs) + Math.ceil(n / Math.max(1, fs.tubes)) * fs.intervalSeconds));
  events.emit({ kind: "support.call", tick: state.tick, side, caller, x, y, ammo, method: m.method, errorM: Math.round(sd), firstS: fs.delaySeconds, ...(m.asset ? { asset: m.asset } : {}), ...(m.dangerClose ? { dangerClose: true } : {}) });
  radio(state, events, m, m.method === "registered" ? "radio.fireCallRegistered" : m.method === "laser" ? "radio.fireCallLaser" : m.method === "drone" ? "radio.fireCallDrone" : m.method === "air" ? "radio.fireCallAir" : "radio.fireCall", { s: Math.round(fs.delaySeconds) });
  return true;
}

/** A registered or planned point near (x, y) (the side's fire direction keeps one list), or undefined. */
function registeredNear(state: SimState, fs: FireSupportDef, side: SideId, x: number, y: number) {
  const r2 = fs.registeredM * fs.registeredM;
  return sectionOf(state, side, "mortar")?.registered?.find((p) => (p.x - x) * (p.x - x) + (p.y - y) * (p.y - y) <= r2);
}

/** Seconds of flight of a round from this tube to (x, y). */
export function flightSecondsOf(tube: Tube, x: number, y: number): number {
  return tube.def.flightBaseSeconds + (tube.def.flightPerKmSeconds * tubeRangeM(tube, x, y)) / 1000;
}

/** Start an on-map mission (M8.3a) with these tubes. Rounds stay with the crews until fired. */
function callOnMap(ctx: SimContext, state: SimState, events: EventSink, fs: FireSupportDef, side: SideId, caller: EntityId, tubes: Tube[], x: number, y: number, lx: number, ly: number, ammo: "he" | "smoke", rounds: number, opts: { fuse?: "airburst"; dangerClose?: boolean } = {}): true {
  const reg = registeredNear(state, fs, side, x, y);
  const ranging = reg ? 0 : fs.rangingRounds;
  const ph = missionPhases(fs);
  // As the battery: no more rounds than the crews hold, the ranging rounds on top while there are enough, one
  // always left for effect.
  let held = 0;
  for (const t of tubes) held += teamRounds(state, t.team, ammo === "he" ? t.def.he : t.def.smoke);
  const n = Math.min(rounds + ranging, held), rg = Math.min(ranging, n - 1);
  let proc = 0, own = 0;
  for (const t of tubes) { proc = Math.max(proc, t.def.processingSeconds); own = Math.max(own, t.def.aimErrorM); }
  const m: FireMission = {
    side, caller, x, y, ammo, left: n, nextTick: state.tick + secondsToTicks(ph.requestS + proc),
    tubes: tubes.map((t) => t.team), tubeNext: tubes.map(() => 0), flying: [],
  };
  if (opts.fuse === "airburst") m.fuse = "airburst";
  if (opts.dangerClose) m.dangerClose = true;
  if (rg > 0) m.ranging = rg;
  if (lx !== 0 || ly !== 0) { m.lx = lx; m.ly = ly; m.effect = n - rg; m.fired = 0; }
  let sd = 0;
  if (reg) { m.ex = reg.ex; m.ey = reg.ey; m.method = "registered"; } else {
    const loc = locateTarget(ctx, state, fs, caller, x, y, own);
    m.method = loc.method; sd = loc.sd;
    if (sd > 0) { m.ex = sd * nextNormal(state.rng, Streams.support); m.ey = sd * nextNormal(state.rng, Streams.support); }
  }
  state.fireMissions.push(m);
  const firstS = Math.round(ph.requestS + proc + flightSecondsOf(tubes[0]!, x, y));
  events.emit({ kind: "support.call", tick: state.tick, side, caller, x, y, ammo, method: m.method, errorM: Math.round(sd), firstS });
  radio(state, events, m, m.method === "registered" ? "radio.fireCallRegistered" : m.method === "laser" ? "radio.fireCallLaser" : m.method === "drone" ? "radio.fireCallDrone" : m.method === "air" ? "radio.fireCallAir" : "radio.fireCall", { s: firstS });
  return true;
}

/**
 * How fast the crew works its tube (M8.3b): each of the `crew` places counts with the man in it — his fire-rate
 * factor (steady 1, shaken 0.7, pinned 0.35; morale.ts) — an empty place counts 0. A full steady crew fires at
 * `roundSeconds`, two of four at half the rate, a crew all pinned at about a third; below `crewMin` it stops.
 */
export function crewRate(ctx: SimContext, state: SimView, tube: Tube): number {
  const crew = crewAt(state, tube);
  if (crew.length < tube.def.crewMin) return 0;
  let sum = 0;
  for (const m of crew.slice(0, tube.def.crew)) { const s = state.soldier.get(m); if (s && state.tick >= s.stunnedUntilTick) sum += fireRateFactor(ctx, s as SoldierState); }
  return sum / tube.def.crew;
}

/** Can this team's tube fire a round of the mission's kind now: set up, enough crew at it, a round left. */
function tubeCanFire(ctx: SimContext, state: SimState, tube: Tube | null, ammo: FireAmmo): boolean {
  const ms = tube ? state.unit.get(tube.team)?.mortar : undefined;
  if (!tube || ms?.state !== "ready") return false;
  if (crewRate(ctx, state, tube) <= 0) return false;
  return ammo !== "illum" && teamRounds(state, tube.team, ammo === "he" ? tube.def.he : tube.def.smoke) > 0;
}

/** Could it fire later (it is still setting up, with crew and rounds)? */
function tubeMayFire(state: SimState, tube: Tube | null, ammo: FireAmmo): boolean {
  const ms = tube ? state.unit.get(tube.team)?.mortar : undefined;
  if (!tube || !ms || ms.state === "packed") return false;
  if (crewAt(state, tube).length < tube.def.crewMin) return false;
  return ammo !== "illum" && teamRounds(state, tube.team, ammo === "he" ? tube.def.he : tube.def.smoke) > 0;
}

/** One round leaves an on-map tube (rule 9: out of the crew's loads now): where it will fall, when. */
function fireTube(ctx: SimContext, state: SimState, events: EventSink, m: FireMission, tube: Tube, ranging: boolean, announce: boolean): boolean {
  const type = m.ammo === "he" ? tube.def.he : tube.def.smoke;
  if (!takeRound(state, tube, type)) return false;
  let ax = m.x + (m.ex ?? 0), ay = m.y + (m.ey ?? 0);
  if (!ranging && m.effect !== undefined) {
    const k = m.fired ?? 0, f = m.effect > 1 ? (2 * k) / (m.effect - 1) - 1 : 0;
    ax += (m.lx ?? 0) * f; ay += (m.ly ?? 0) * f;
    m.fired = k + 1;
  }
  const W = ctx.map.widthM, H = ctx.map.heightM;
  const sd = (tube.def.dispersionPerKmM * tubeRangeM(tube, ax, ay)) / 1000;
  const x = Math.min(Math.max(ax + sd * nextNormal(state.rng, Streams.support), 1), W - 1);
  const y = Math.min(Math.max(ay + sd * nextNormal(state.rng, Streams.support), 1), H - 1);
  const flightS = flightSecondsOf(tube, ax, ay);
  const land = state.tick + Math.max(1, secondsToTicks(flightS));
  (m.flying ?? (m.flying = [])).push({ tick: land, x, y, ammo: type, ranging, ...(announce ? { announce: true as const } : {}) });
  events.emit({ kind: "mortar.fired", tick: state.tick, side: m.side, unit: tube.team, gunner: tube.carrier, x: tube.x, y: tube.y, tx: ax, ty: ay, ammo: type, flightS: Math.round(flightS) });
  // Its signature (M8.3b): the flash shows the crew (the carrier counts as firing for the enemy's spotting) and the
  // report carries `hearingRangeM` (contacts: the enemy hears the tube and guesses where it is).
  const ws = state.weapon.get(tube.carrier);
  if (ws) ws.lastShotTick = state.tick;
  { const cs = state.soldier.get(tube.carrier); if (cs && ctx.catalog.medical !== undefined) cs.protLostTick = state.tick; } // (M10.7b: firing is not self-defence)
  const tz = heightAt(ctx.map, tube.x, tube.y) + 1; // ground: ok (the tube's muzzle on its baseplate)
  events.emit({ kind: "shot.fired", tick: state.tick, shooter: tube.carrier, x: tube.x, y: tube.y, z: tz, dirX: 0, dirY: 0, weapon: tube.item, ammo: type, indirect: true, loudM: tube.def.hearingRangeM });
  if (announce) {
    events.emit({ kind: "support.shot", tick: state.tick, side: m.side, caller: m.caller, x: m.x, y: m.y, flightS: Math.round(flightS) });
    radio(state, events, m, "radio.fireShot", { s: Math.round(flightS) });
  }
  return true;
}

/** A ranging round has fallen at (x, y): the best observer corrects the aim (M8.2b); the radio and the event. */
function adjustAfterFall(ctx: SimContext, state: SimState, events: EventSink, fs: FireSupportDef, m: FireMission, x: number, y: number, by: ReturnType<typeof bestObserverOf>, left: number): void {
  const seen = by !== null;
  const missM = Math.round(sqrt((x - m.x) * (x - m.x) + (y - m.y) * (y - m.y)));
  if (by) {
    // The observer who read it best (M8.2b): all but the correction share of the error goes, his reading error
    // comes in (skill, distance, laser).
    const c = Math.min(1, fs.rangingCorrection * adjustSkillFactor(fs, by.skill));
    const read = readErrorM(fs, by, sqrt((by.x - x) * (by.x - x) + (by.y - y) * (by.y - y)));
    m.ex = (m.ex ?? 0) * c + (read > 0 ? read * nextNormal(state.rng, Streams.support) : 0);
    m.ey = (m.ey ?? 0) * c + (read > 0 ? read * nextNormal(state.rng, Streams.support) : 0);
    m.observed = true;
  }
  events.emit({ kind: "support.ranging", tick: state.tick, side: m.side, caller: m.caller, x, y, tx: m.x, ty: m.y, ammo: m.ammo, seen, missM, left, ...(by ? { observer: by.who, observerKind: by.kind } : {}) });
  radio(state, events, m, seen ? "radio.fireAdjust" : "radio.fireUnobserved", { miss: missM });
}

/** An on-map mission's tick (M8.3a): rounds in flight land, then the tubes fire what is due. */
function stepOnMap(ctx: SimContext, state: SimState, events: EventSink, fs: FireSupportDef, m: FireMission): void {
  const tick = state.tick;
  const fl = m.flying ?? [];
  const splash = secondsToTicks(fs.splashSeconds ?? 0);
  for (const f of fl) {
    if (f.announce && !f.splashed && splash > 0 && tick >= f.tick - splash && tick < f.tick) {
      f.splashed = true;
      events.emit({ kind: "support.splash", tick, side: m.side, caller: m.caller, x: m.x, y: m.y, inS: Math.round((f.tick - tick) / 60) });
      radio(state, events, m, "radio.fireSplash");
    }
  }
  // (Each round lands at its own tick: tubes at different ranges fly different times, so `flying` is not in
  // landing order.)
  if (fl.some((f) => f.tick <= tick)) {
    const due = fl.filter((f) => f.tick <= tick);
    m.flying = fl.filter((f) => f.tick > tick);
    for (const f of due) {
      // (A ranging round: seen or not before its own smoke is in the way.)
      const by = f.ranging ? bestObserverOf(ctx, state, fs, observersFor(ctx, state, m.caller), f.x, f.y) : null;
      landRound(ctx, state, events, fs, m, f.x, f.y, f.ammo);
      if (!f.ranging) continue;
      adjustAfterFall(ctx, state, events, fs, m, f.x, f.y, by, m.ranging ?? 0);
      delete m.wait;
      // The next round after the correction (the fall-to-fall time less the flight, at least a few seconds).
      m.nextTick = tick + secondsToTicks(Math.max(ON_MAP_CORRECTION_MIN_S, fs.rangingSeconds - (fs.flightSeconds ?? 0)));
      if ((m.ranging ?? 0) === 0) { delete m.ranging; if (m.observed) register(state, fs, m); }
    }
  }
  if (m.left <= 0 || tick < m.nextTick || m.wait) return;
  const tubes = (m.tubes ?? []).map((team) => tubeOf(ctx, state, team));
  if ((m.ranging ?? 0) > 0) {
    // One ranging round at a time, from the first tube that can fire.
    const i = tubes.findIndex((t) => tubeCanFire(ctx, state, t, m.ammo));
    if (i < 0) { if (!tubes.some((t) => tubeMayFire(state, t, m.ammo))) m.left = 0; return; }
    if (fireTube(ctx, state, events, m, tubes[i]!, true, true)) { m.ranging = m.ranging! - 1; m.left--; m.wait = true; }
    return;
  }
  // Fire for effect: every tube at its own rate; "fire for effect" and the shot/splash calls with the first round
  // that leaves (not before: the tubes may still be setting up).
  let any = false;
  const next = m.tubeNext ?? (m.tubeNext = tubes.map(() => 0));
  for (let i = 0; i < tubes.length && m.left > 0; i++) {
    const t = tubes[i]!;
    if (!tubeCanFire(ctx, state, t, m.ammo)) { if (tubeMayFire(state, t, m.ammo)) any = true; continue; }
    any = true;
    if (tick < next[i]!) continue;
    const first = m.volley === undefined;
    if (!fireTube(ctx, state, events, m, t!, false, first)) continue;
    if (first) { m.volley = 0; if (m.ex !== undefined) radio(state, events, m, "radio.fireForEffect"); }
    m.volley!++;
    m.left--;
    // The crew's rate (M8.3b): fewer men, or men pinned or shaken, fire slower.
    const rate = crewRate(ctx, state, t!);
    next[i] = tick + Math.max(1, secondsToTicks(t!.def.roundSeconds / Math.max(rate, 0.05)));
  }
  if (!any) m.left = 0;
}
const ON_MAP_CORRECTION_MIN_S = 4;

/**
 * What a call at (x, y) (a screen: to (x2, y2)) could get now, per fire support asset of the caller's faction (M8.6,
 * for the interface; read-only): who would fire it (the mortar teams on the map, else the off-map section), the
 * rounds of each kind left, about how long until fire for effect (the comms delay of the order not included; a
 * registered point skips ranging), danger close to own men, an airburst fuse, in range, the battery displacing.
 */
export interface FireOption {
  asset: "mortar" | "artillery"; onMap: boolean; he: number; smoke: number; illum: number; etaS: number;
  dangerClose: boolean; airburst: boolean; inRange: boolean; moving: boolean;
}
export function fireOptions(ctx: SimContext, state: SimState, side: SideId, faction: string, x: number, y: number, x2 = x, y2 = y): FireOption[] {
  const out: FireOption[] = [];
  const mx = (x + x2) / 2, my = (y + y2) / 2;
  for (const asset of ["mortar", "artillery"] as const) {
    const fs = assetDef(ctx, faction, asset);
    if (!fs) continue;
    const dangerClose = fs.dangerCloseM !== undefined && ownMenWithin(state, side, x, y, x2, y2, fs.dangerCloseM);
    const airburst = fs.airburstHeightM !== undefined;
    const sec = sectionOf(state, side, asset);
    const box = sec ? state.container.get(sec.battery) : undefined;
    const count = (t: string | undefined) => (box && t ? countItems(box, t) : 0);
    if (asset === "mortar") {
      const he = onMapTubes(ctx, state, side, x, y, "he", x2, y2), sm = onMapTubes(ctx, state, side, x, y, "smoke", x2, y2);
      const tubes = he.ok.length > 0 ? he.ok : sm.ok;
      if (tubes.length > 0) {
        const ph = missionPhases(fs);
        let proc = 0, fl = Infinity, nHe = 0, nSm = 0;
        for (const t of tubes) { proc = Math.max(proc, t.def.processingSeconds); fl = Math.min(fl, flightSecondsOf(t, mx, my)); }
        for (const t of he.ok) nHe += teamRounds(state, t.team, t.def.he);
        for (const t of sm.ok) nSm += teamRounds(state, t.team, t.def.smoke);
        // (To effect: the first round, then each ranging round's fall, correction and flight; none on a registered
        // point.)
        const reg = registeredNear(state, fs, side, mx, my) !== undefined;
        const cycle = fl + Math.max(ON_MAP_CORRECTION_MIN_S, fs.rangingSeconds - (fs.flightSeconds ?? 0));
        out.push({ asset, onMap: true, he: nHe, smoke: nSm, illum: count(sec?.illumType), etaS: Math.round(ph.requestS + proc + fl + (reg ? 0 : fs.rangingRounds * cycle)), dangerClose, airburst, inRange: true, moving: false });
        continue;
      }
      if (!sec) {
        if (he.outOfRange + sm.outOfRange > 0) out.push({ asset, onMap: true, he: 0, smoke: 0, illum: 0, etaS: 0, dangerClose, airburst, inRange: false, moving: false });
        continue;
      }
    }
    if (!sec) continue;
    const r2 = fs.registeredM * fs.registeredM;
    const reg = sec.registered?.some((p) => (p.x - mx) * (p.x - mx) + (p.y - my) * (p.y - my) <= r2) ?? false;
    out.push({
      asset, onMap: false, he: count(sec.heType), smoke: count(sec.smokeType), illum: count(sec.illumType),
      etaS: Math.round(fs.delaySeconds + (reg ? 0 : fs.rangingRounds * fs.rangingSeconds)), dangerClose, airburst, inRange: true,
      moving: !DISPLACE_MODEL.available(fs, sec, state.tick),
    });
  }
  return out;
}

/** Is any able man of the side within `r` of the segment (x0, y0)-(x1, y1) (a point when both ends are equal)? */
function ownMenWithin(state: SimState, side: SideId, x0: number, y0: number, x1: number, y1: number, r: number): boolean {
  const dx = x1 - x0, dy = y1 - y0, L2 = dx * dx + dy * dy, r2 = r * r;
  // mounted: ok men aboard vehicles are own men too (danger close counts them)
  for (const [id, s] of state.soldier.entries()) {
    if (state.identity.get(id)?.side !== side || !isAble(s)) continue;
    const t = state.transform.get(id);
    if (!t) continue;
    const k = L2 > 0 ? Math.min(1, Math.max(0, ((t.x - x0) * dx + (t.y - y0) * dy) / L2)) : 0;
    const ex = t.x - (x0 + k * dx), ey = t.y - (y0 + k * dy);
    if (ex * ex + ey * ey <= r2) return true;
  }
  return false;
}

/** One mortar round lands at (x, y): high explosive bursts, smoke lays its cloud. `heAmmo`: an on-map tube's round. */
function landRound(ctx: SimContext, state: SimState, events: EventSink, fs: FireSupportDef, m: FireMission, x: number, y: number, heAmmo = fs.heAmmo): void {
  // (M11.1: an off-map round names its item, for the conservation guard; an on-map tube's round was counted at its shot.)
  const sec = m.tubes === undefined ? sectionOf(state, m.side, m.asset ?? "mortar") : undefined;
  const item = sec ? (m.ammo === "he" ? sec.heType : m.ammo === "smoke" ? sec.smokeType : sec.illumType) : undefined;
  events.emit({ kind: "support.round", tick: state.tick, side: m.side, asset: m.asset ?? "mortar", ammo: m.ammo, x, y, ...(item !== undefined ? { item } : {}), ...(m.method !== undefined ? { method: m.method } : {}) });
  if (m.ammo === "illum") {
    // A flare (M8.4): ejected over the point, it sinks under its parachute while it burns (its light: flares.ts).
    const type = sectionOf(state, m.side, m.asset ?? "mortar")?.illumType ?? fs.illumAmmo;
    const il = type !== undefined ? ctx.catalog.ammo[type]?.illum : undefined;
    if (il) {
      (state.flares ?? (state.flares = [])).push({ x, y, z: heightAt(ctx.map, x, y) + il.heightM, startTick: state.tick, untilTick: state.tick + secondsToTicks(il.burnSeconds), descentMps: il.descentMps, candela: il.candela, side: m.side }); // ground: ok (a flare over the ground)
      events.emit({ kind: "support.illum", tick: state.tick, x, y, side: m.side, burnS: il.burnSeconds });
    }
    return;
  }
  if (m.ammo === "he") {
    const idx = ammoIndexOf(ctx.catalog, heAmmo);
    // (M8.4: an airburst fuse sets it off `airburstHeightM` over the ground.)
    const z = heightAt(ctx.map, x, y) + (m.fuse === "airburst" && fs.airburstHeightM !== undefined ? fs.airburstHeightM : 0.05); // ground: ok (a bomb on or over the ground)
    if (idx >= 0) detonate(ctx, state, events, x, y, z, idx, m.caller);
    // The enemy near it remember the mission's beaten zone (soldier AI package B).
    noteBeatenZone(ctx, state, x, y, m.side);
  } else {
    addSmoke(ctx, state, x, y, fs.smokeRadiusM, fs.smokeSeconds, fs.smokeTopM ?? 15, fs.smokeBurnSeconds ?? 0);
    events.emit({ kind: "support.smoke", tick: state.tick, x, y, radiusM: fs.smokeRadiusM, side: m.side });
  }
}

/** A radio call from the man who called the mission (keys, rule 12). */
function radio(state: SimState, events: EventSink, m: FireMission, key: string, params: Record<string, string | number> = {}): void {
  const u = state.identity.get(m.caller)?.unit;
  events.emit({ kind: "radio", tick: state.tick, side: m.side, from: m.caller, key, params: { callsign: (u !== undefined ? state.unit.get(u)?.callsign : undefined) ?? "", ...params } });
}

/** Remember the point a mission has ranged on, with the error left there (one entry per point, a few per side). */
const REGISTERED_MAX = 6;
function register(state: SimState, fs: FireSupportDef, m: FireMission): void {
  const sec = sectionOf(state, m.side, m.asset ?? "mortar");
  if (!sec) return;
  const list = sec.registered ?? (sec.registered = []);
  const r2 = fs.registeredM * fs.registeredM;
  const i = list.findIndex((p) => (p.x - m.x) * (p.x - m.x) + (p.y - m.y) * (p.y - m.y) <= r2);
  if (i >= 0) list.splice(i, 1);
  list.push({ x: m.x, y: m.y, ex: m.ex ?? 0, ey: m.ey ?? 0 });
  if (list.length > REGISTERED_MAX) list.shift();
}

export function supportSystem(ctx: SimContext, state: SimState, events: EventSink): void {
  if (state.smoke.length > 0) state.smoke = state.smoke.filter((c) => c.untilTick > state.tick);
  if (state.flares !== undefined && state.flares.length > 0) state.flares = state.flares.filter((f) => f.untilTick > state.tick);
  if (state.fireMissions.length === 0) return;
  const W = ctx.map.widthM, H = ctx.map.heightM;
  for (const m of state.fireMissions) {
    if (m.left <= 0 && (m.flying?.length ?? 0) === 0) continue;
    const faction = state.identity.get(m.caller)?.faction ?? "";
    const fs = assetDef(ctx, faction, m.asset);
    if (!fs) { m.left = 0; m.flying = []; continue; }
    if (m.tubes !== undefined) { stepOnMap(ctx, state, events, fs, m); continue; }
    // "Shot" and "splash" (M8.2a) for each ranging round and the first volley for effect.
    if (state.tick < m.nextTick) {
      if ((m.ranging ?? 0) > 0 || m.volley === undefined) {
        const flight = secondsToTicks(missionPhases(fs).flightS), splash = secondsToTicks(fs.splashSeconds ?? 0);
        if (flight > 0 && m.shotFor !== m.nextTick && state.tick >= m.nextTick - flight) {
          m.shotFor = m.nextTick;
          events.emit({ kind: "support.shot", tick: state.tick, side: m.side, caller: m.caller, x: m.x, y: m.y, flightS: Math.round((m.nextTick - state.tick) / 60) });
          radio(state, events, m, "radio.fireShot", { s: Math.round((m.nextTick - state.tick) / 60) });
        }
        if (splash > 0 && m.splashFor !== m.nextTick && state.tick >= m.nextTick - splash) {
          m.splashFor = m.nextTick;
          events.emit({ kind: "support.splash", tick: state.tick, side: m.side, caller: m.caller, x: m.x, y: m.y, inS: Math.round((m.nextTick - state.tick) / 60) });
          radio(state, events, m, "radio.fireSplash");
        }
      }
      continue;
    }
    let ax = m.x + (m.ex ?? 0), ay = m.y + (m.ey ?? 0);
    // A screen's round for effect: its place along the line (evenly, end to end).
    if (m.effect !== undefined && (m.ranging ?? 0) <= 0) {
      const k = m.fired ?? 0, f = m.effect > 1 ? (2 * k) / (m.effect - 1) - 1 : 0;
      ax += (m.lx ?? 0) * f; ay += (m.ly ?? 0) * f;
      m.fired = k + 1;
    }
    const x = Math.min(Math.max(ax + fs.dispersionM * nextNormal(state.rng, Streams.support), 1), W - 1);
    const y = Math.min(Math.max(ay + fs.dispersionM * nextNormal(state.rng, Streams.support), 1), H - 1);
    // (A ranging round: seen or not before its own smoke is in the way.)
    const ranging = (m.ranging ?? 0) > 0;
    const by = ranging ? bestObserverOf(ctx, state, fs, observersFor(ctx, state, m.caller), x, y) : null;
    landRound(ctx, state, events, fs, m, x, y);
    m.left--;
    if (ranging) {
      // A ranging round: the caller corrects the aim if he saw where it fell.
      m.ranging = m.ranging! - 1;
      adjustAfterFall(ctx, state, events, fs, m, x, y, by, m.ranging);
      // Only an observed point is remembered: unseen, the error is still the battery's full one, and a later
      // mission there must range again rather than fire for effect with it.
      if (m.ranging === 0) { delete m.ranging; if (m.observed) register(state, fs, m); }
      m.nextTick = state.tick + Math.max(1, secondsToTicks(fs.rangingSeconds));
      continue;
    }
    // Fire for effect: volleys of the battery's tubes.
    if (m.volley === undefined) {
      m.volley = 0;
      if (m.ex !== undefined) radio(state, events, m, "radio.fireForEffect");
    }
    m.volley++;
    if (m.volley >= fs.tubes) { m.volley = 0; m.nextTick = state.tick + Math.max(1, secondsToTicks(fs.intervalSeconds)); }
    else m.nextTick = state.tick + Math.max(1, secondsToTicks(fs.volleySpreadSeconds));
  }
  state.fireMissions = state.fireMissions.filter((m) => m.left > 0 || (m.flying?.length ?? 0) > 0);
}

