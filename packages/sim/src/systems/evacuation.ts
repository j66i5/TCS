/**
 * AMBULANCE RUNS FROM THE REAR (SPEC 9.1 "ground evacuation vehicles as off-map assets with request procedure and
 * delay"; M10.6a). Owner answers: the full chain up to an aid station off the map; automatic, the player can call one
 * (answer 4); new Boxer ambulance and BMM hulls (Q-4); the delay is 10-15 min plus the drive (Q-6).
 *
 * Each side's ambulances are off-map assets (offmap.ts): in the battle from tick 0 with their crews, parked off the
 * map. When `requestAt` casualties lie at a platoon's Verwundetennest and no ambulance is already coming to it, the
 * platoon calls one (the player can call one earlier: `callAmbulance`). The side's next waiting ambulance comes onto
 * the map after a delay drawn between `delayMinS` and `delayMaxS` (the "medical" stream), at the map edge behind the
 * nest (away from the enemy the platoon knows, on ground its wheels reach), drives to `standM` short of the nest and
 * halts. Its crew takes the men lying there aboard one by one, T1 first, lying or sitting as its layouts allow (the
 * fetch on a litter and the lift are abstracted as a time; the crew is not drawn getting out). It leaves when full, or
 * when nobody has come aboard for `waitS` and nobody else is on the way to the nest (at most `maxStayS` after it
 * arrived), drives back to where it came on and leaves the map: the living wounded aboard are evacuated
 * (`SoldierState.evacuated`, `medical.evacuated`). One run per hull. A hull that loses its driver or its wheels on the
 * map is stranded ("lost": an ordinary hull from then on). Same rules for every side, player and AI.
 */
import { onAir } from "../comms";
import type { SoldierState, VehicleState } from "../components";
type VehicleClass = "tracked" | "wheeled";
import type { SimContext } from "../context";
import type { EventSink } from "../events";
import { secondsToTicks, ticksToSeconds, type DefId, type EntityId, type SideId } from "../ids";
import { canReport, isAble } from "../impair";
import { atan2, cos, hypot2, sin } from "../math";
import { hasDriver, isMounted } from "../mount";
import { nearestPassable } from "../nav";
import { navFor } from "../navctx";
import { assetServing, isOffMap, parkOffMap } from "../offmap";
import { nextRange, Streams } from "../rng";
import type { SimState } from "../state";
import { liesAboard, placesFit, placesUsed, seatCasualty } from "./boarding";
import { planVehicleRoute, vehicleHalt, vehicleMove, type OrderResult } from "./drive";
import { handOver } from "./aftercare";
import { careEnabled, treatedNow } from "./medical";
import { nestOf, setNest, siteNest, topOf } from "./nest";

const servingAsset = assetServing;

/** The side's next ambulance waiting off the map (lowest id), if any. */
function readyAsset(state: SimState, side: SideId): EntityId | null {
  for (const [vid, v] of state.vehicle.entries()) if (v.offMap?.kind === "ambulance" && v.offMap.phase === "ready" && v.side === side) return vid;
  return null;
}

/** A man of unit `uid` who can speak on the radio (its leader first). */
function speaker(state: SimState, uid: EntityId): EntityId | null {
  const u = state.unit.get(uid);
  if (!u) return null;
  if (u.leader !== null && canReport(state.soldier.get(u.leader))) return u.leader;
  for (const m of u.members) if (canReport(state.soldier.get(m))) return m;
  for (const c of u.children) { const m = speaker(state, c); if (m !== null) return m; }
  return null;
}

export function radio(state: SimState, events: EventSink, uid: EntityId, key: string, params: Record<string, string | number> = {}): void {
  const u = state.unit.get(uid), from = speaker(state, uid);
  if (!u || from === null || !onAir(state, uid)) return; // (M11.6: a flat radio sends nothing)
  events.emit({ kind: "radio", tick: state.tick, side: u.side, from, key, params: { callsign: u.callsign, ...params } });
}

/**
 * Where an ambulance comes onto the map for the nest at (px, py) of top unit `top`: on the edge behind it (away from
 * the mean of the enemy contacts its men hold, else the nearest edge), 10 m in, on a wheeled-grid cell in the nest's
 * region (else the nearest such cell along the edges). Heading: toward the nest.
 */
export function entryPoint(ctx: SimContext, state: SimState, top: EntityId, px: number, py: number, cls: VehicleClass = "wheeled"): { x: number; y: number; heading: number } | null {
  const W = ctx.map.widthM, H = ctx.map.heightM;
  let tx = 0, ty = 0, tn = 0;
  const walk = (uid: EntityId) => {
    const u = state.unit.get(uid);
    if (!u) return;
    for (const m of u.members) {
      const s = state.soldier.get(m);
      if (!s || !isAble(s)) continue;
      for (const c of s.contacts) { if (c.down || c.surrendered) continue; tx += c.x; ty += c.y; tn++; }
    }
    for (const c of u.children) walk(c);
  };
  walk(top);
  let bx: number, by: number;
  const L = tn > 0 ? hypot2(px - tx / tn, py - ty / tn) : 0;
  if (L > 1) { bx = (px - tx / tn) / L; by = (py - ty / tn) / L; }
  else {
    const dW = px, dE = W - px, dN = py, dS = H - py, mn = Math.min(dW, dE, dN, dS);
    [bx, by] = mn === dW ? [-1, 0] : mn === dE ? [1, 0] : mn === dN ? [0, -1] : [0, 1];
  }
  // The edge that ray leaves by: snap it to the edge it is nearest to (an ambulance comes along a side, not a corner).
  const tE = Math.min(bx > 0 ? (W - px) / bx : bx < 0 ? -px / bx : Infinity, by > 0 ? (H - py) / by : by < 0 ? -py / by : Infinity);
  let ex = px + bx * tE, ey = py + by * tE;
  const dW = ex, dE = W - ex, dN = ey, dS = H - ey, mn = Math.min(dW, dE, dN, dS);
  const IN = 10;
  if (mn === dW) ex = IN; else if (mn === dE) ex = W - IN; else if (mn === dN) ey = IN; else ey = H - IN;
  // (M11.7b: a tracked recovery vehicle comes on where its tracks reach.)
  const g = navFor(ctx, cls).grid;
  const pc = Math.floor(px / g.cellM), pr = Math.floor(py / g.cellM);
  const pi = nearestPassable(g, Math.min(Math.max(px, 1), W - 1), Math.min(Math.max(py, 1), H - 1), 25);
  const region = pi >= 0 ? g.region[pi]! : pc >= 0 && pr >= 0 && pc < g.cols && pr < g.rows ? g.region[pr * g.cols + pc]! : 0;
  let cell = nearestPassable(g, ex, ey, 40, region === 0 ? undefined : region);
  if (cell < 0) {
    // Along the edges (a few cells in): the nearest cell of the nest's region to the wanted point.
    let best = -1, bd = Infinity;
    const k = Math.max(1, Math.round(IN / g.cellM));
    const tryCell = (c: number, r: number) => {
      if (c < 0 || r < 0 || c >= g.cols || r >= g.rows) return;
      const i = r * g.cols + c;
      if (g.cost[i]! <= 0 || (region !== 0 && g.region[i] !== region)) return;
      const x = (c + 0.5) * g.cellM, y = (r + 0.5) * g.cellM, d = (x - ex) * (x - ex) + (y - ey) * (y - ey);
      if (d < bd) { bd = d; best = i; }
    };
    for (let c = 0; c < g.cols; c++) { tryCell(c, k); tryCell(c, g.rows - 1 - k); }
    for (let r = 0; r < g.rows; r++) { tryCell(k, r); tryCell(g.cols - 1 - k, r); }
    cell = best;
  }
  if (cell < 0) return null;
  const x = (cell % g.cols + 0.5) * g.cellM, y = (Math.floor(cell / g.cols) + 0.5) * g.cellM;
  return { x, y, heading: atan2(py - y, px - x) };
}

/**
 * Call the side's next waiting ambulance to rear point `pid` of top unit `top`. Returns the ambulance, or why not:
 * "none" (none waiting), "coming" (one is already on its way there), "noEntry" (no edge it can come on by).
 */
export function callAmbulance(ctx: SimContext, state: SimState, events: EventSink, top: EntityId, pid: EntityId, ordered: boolean): EntityId | "none" | "coming" | "noEntry" {
  const E = ctx.catalog.medical?.evacuation;
  const u = state.unit.get(top), p = state.rear.get(pid);
  if (!E || !u || !p) return "none";
  if (servingAsset(state, pid) !== null) return "coming";
  const vid = readyAsset(state, u.side);
  if (vid === null) return "none";
  const entry = entryPoint(ctx, state, top, p.x, p.y);
  if (!entry) return "noEntry";
  const delayS = nextRange(state.rng, Streams.medical, E.delayMinS, E.delayMaxS);
  const due = state.tick + secondsToTicks(delayS);
  const v = state.vehicle.req(vid);
  v.offMap = { kind: "ambulance", phase: "called", point: pid, unit: top, callTick: state.tick, enterTick: due, entry, ...(ordered ? { ordered: true as const } : {}) };
  const dueS = Math.round(delayS);
  events.emit({ kind: "medical.ambulance", tick: state.tick, side: u.side, vehicle: vid, phase: "called", point: pid, unit: top, dueS, ...(ordered ? { ordered: true } : {}) });
  // (The player's call is answered by the order's own acknowledgement.)
  if (!ordered) radio(state, events, top, "radio.ambulanceCalled", { min: Math.round(dueS / 60) });
  return vid;
}

/**
 * The player's `callAmbulance` order (M10.6a): the target's platoon calls an ambulance to its nest (sited now if it
 * has none). Unable, with a radio reason, when none is left or one is already coming.
 */
export function callAmbulanceOrder(ctx: SimContext, state: SimState, events: EventSink, target: EntityId, ordered: boolean): OrderResult {
  if (!careEnabled(ctx)) return "unable";
  const uid = state.unit.has(target) ? target : state.identity.get(target)?.unit;
  if (uid === undefined || state.unit.get(uid)?.asset !== undefined) return "unable";
  const top = topOf(state, uid);
  let pid = nestOf(state, top);
  if (pid === null) {
    const at = siteNest(ctx, state, top);
    if (!at) return "unable";
    pid = setNest(ctx, state, events, top, at.x, at.y, "sited");
    if (pid === null) return "unable";
  }
  const r = callAmbulance(ctx, state, events, top, pid, ordered);
  if (r === "none") return { unable: "radio.noAmbulance" };
  if (r === "coming") return { unable: "radio.ambulanceComing" };
  if (r === "noEntry") return { unable: "radio.ambulanceNoWay" };
  return true;
}

/** Can this hull still drive (a driver aboard, wheels and engine working, the crew not getting out)? */
export function canDrive(ctx: SimContext, state: SimState, v: VehicleState): boolean {
  const def = ctx.catalog.vehicles[v.def];
  return def !== undefined && v.unit !== null && v.crewReaction !== "bailOut" && (v.status === "ok" || v.status === "disarmed") && hasDriver(state, v, def);
}

/**
 * Where to stop for the nest at (px, py): `standM` short of it on the side the hull comes from, else the nearest
 * ground its wheels reach from where it is (a nest in a wood: at the wood's edge; the crew carries the men further).
 */
export function standSpot(ctx: SimContext, from: { x: number; y: number }, px: number, py: number, standM: number, cls: VehicleClass = "wheeled"): { x: number; y: number } {
  const L = hypot2(from.x - px, from.y - py);
  const sx = L > 1 ? px + ((from.x - px) / L) * standM : px, sy = L > 1 ? py + ((from.y - py) / L) * standM : py;
  const g = navFor(ctx, cls).grid;
  const clampX = (x: number) => Math.min(Math.max(x, 1), ctx.map.widthM - 1), clampY = (y: number) => Math.min(Math.max(y, 1), ctx.map.heightM - 1);
  const fi = nearestPassable(g, clampX(from.x), clampY(from.y), 10);
  const region = fi >= 0 ? g.region[fi]! : 0;
  const i = nearestPassable(g, clampX(sx), clampY(sy), Math.ceil(STAND_SEARCH_M / g.cellM), region);
  return i >= 0 ? { x: (i % g.cols + 0.5) * g.cellM, y: (Math.floor(i / g.cols) + 0.5) * g.cellM } : { x: sx, y: sy };
}

/**
 * The first point of the hull's way to `g` that is within `reachM` of the nest at (px, py): it stops there rather
 * than manoeuvre round the last obstacles beside the men (a wheeled hull turns wide; the crew carries the men the
 * rest). `g` itself when the way never comes that close before its end.
 */
export function cutShort(ctx: SimContext, v: VehicleState, t: { x: number; y: number }, g: { x: number; y: number }, px: number, py: number, reachM: number): { x: number; y: number } {
  const def = ctx.catalog.vehicles[v.def];
  if (!def) return g;
  const route = planVehicleRoute(ctx, def.class, t.x, t.y, [{ x: g.x, y: g.y, mode: ctx.catalog.medical!.evacuation!.pace }]);
  if (!route || route.length < 2) return g;
  const r2 = reachM * reachM;
  for (let i = 1; i < route.length; i++) {
    const a = route[i - 1]!, b = route[i]!;
    const L = hypot2(b.x - a.x, b.y - a.y), n = Math.max(1, Math.ceil(L / 2));
    for (let k = 1; k <= n; k++) {
      const x = a.x + ((b.x - a.x) * k) / n, y = a.y + ((b.y - a.y) * k) / n;
      if ((x - px) * (x - px) + (y - py) * (y - py) <= r2) return { x, y };
    }
  }
  return g;
}

/** A hull stops once its way comes within standM + this of the nest (m). */
export const STOP_SLACK_M = 50;
/** A hull held up (stuck, or planning its way again) this close to the nest stops where it is (m). */
export const HELD_UP_NEAR_M = 80;

/** How far from its spot short of the nest an ambulance looks for ground its wheels reach (m). */
const STAND_SEARCH_M = 150;

/** Route the hull to (x, y) at the evacuation pace (the last `NEAR_M` at `nearPace` when `slowEnd`). True if it has a route.
 *  `pace` / `nearPace`: other paces (a combat vehicle's rear run, M10.6b). */
export function driveTo(ctx: SimContext, state: SimState, vid: EntityId, x: number, y: number, slowEnd = false, pace?: DefId, nearPace?: DefId): boolean {
  const E = ctx.catalog.medical!.evacuation;
  const P = pace ?? E!.pace, NP = nearPace ?? E?.nearPace ?? P;
  const t = state.transform.req(vid), L = hypot2(x - t.x, y - t.y);
  if (slowEnd && L > NEAR_M * 2) {
    const k = (L - NEAR_M) / L;
    return vehicleMove(ctx, state, vid, [{ x: t.x + (x - t.x) * k, y: t.y + (y - t.y) * k, mode: P }, { x, y, mode: NP }], undefined) === true;
  }
  return vehicleMove(ctx, state, vid, [{ x, y, mode: slowEnd ? NP : P }], undefined) === true;
}

/** The men lying at nest `pid` who could go aboard (alive, on foot, not carried), T1 first by their tag. */
export function waitingAt(state: SimState, pid: EntityId, men: readonly EntityId[]): EntityId[] {
  const out: EntityId[] = [];
  for (const c of men) {
    const s = state.soldier.get(c);
    if (!s || s.atNest !== pid || !s.physiology.alive || isMounted(s) || s.captive !== null || state.carry.has(c)) continue;
    out.push(c);
  }
  const cat = (c: EntityId) => state.soldier.req(c).triage?.cat ?? 2;
  return out.sort((a, b) => cat(a) - cat(b) || a - b);
}

/** Is anyone on the way to nest `pid` (a carrying party, or a man walking there)? */
export function comingTo(state: SimState, pid: EntityId): boolean {
  for (const [, c] of state.carry.entries()) if (c.point === pid) return true;
  return false;
}

/** The men aboard who are passengers (lying or sitting), ascending seat. */
export function aboard(v: VehicleState, ctx: SimContext): EntityId[] {
  const def = ctx.catalog.vehicles[v.def];
  const out: EntityId[] = [];
  if (!def) return out;
  v.seats.forEach((o, i) => { if (o !== null && def.seats[i]?.station === "passenger") out.push(o); });
  return out;
}

/** Each second with the medical system: automatic calls, then each ambulance's run (see the header). */
export function evacuationSystem(ctx: SimContext, state: SimState, events: EventSink): void {
  if (!careEnabled(ctx)) return;
  const M = ctx.catalog.medical!, E = M.evacuation;
  if (!E || !M.nest) return;
  if (state.tick % Math.max(1, secondsToTicks(M.care.stepS)) !== 0) return;
  // The ambulances (ascending id); nothing to do in a battle without any.
  let assets: EntityId[] | null = null;
  // (M11.4b: an ambulance the player sent with supplies is on a delivery run: delivery.ts steps it.)
  for (const [vid, v] of state.vehicle.entries()) if (v.offMap?.kind === "ambulance" && v.offMap.cargo === undefined) (assets ??= []).push(vid);
  if (assets === null) return;
  // Who lies at which nest (one pass over the men).
  let atNest: Map<EntityId, EntityId[]> | null = null;
  for (const [id, s] of state.soldier.entries()) {
    if (s.atNest === undefined || isMounted(s)) continue;
    const l = (atNest ??= new Map()).get(s.atNest);
    if (l) l.push(id); else atNest.set(s.atNest, [id]);
  }
  // ---- automatic calls: a nest with casualties waiting and no ambulance coming
  if (atNest) {
    for (const pid of [...atNest.keys()].sort((a, b) => a - b)) {
      const p = state.rear.get(pid);
      if (!p || p.kind !== "medical") continue;
      if (waitingAt(state, pid, atNest.get(pid)!).length < E.requestAt) continue;
      if (servingAsset(state, pid) !== null || readyAsset(state, p.side) === null) continue;
      if (!onAir(state, p.unit)) continue; // (M11.6: the platoon's radios flat: the casualties wait for a radio)
      callAmbulance(ctx, state, events, p.unit, pid, false);
    }
  }
  // ---- each ambulance's run
  for (const vid of assets) stepRun(ctx, state, events, vid, atNest);
}

function stepRun(ctx: SimContext, state: SimState, events: EventSink, vid: EntityId, atNest: Map<EntityId, EntityId[]> | null): void {
  const E = ctx.catalog.medical!.evacuation!;
  const v = state.vehicle.req(vid), o = v.offMap!;
  const tick = state.tick;
  if (o.phase === "ready" || o.phase === "away" || o.phase === "lost") return;
  // The nest it was called to (moved meanwhile, or gone: the platoon's nest now).
  let pid = o.point ?? null;
  if (pid !== null && !state.rear.has(pid)) pid = o.unit !== undefined ? nestOf(state, o.unit) : null;
  const p = pid === null ? undefined : state.rear.get(pid);
  if (o.phase === "called") {
    if (tick < (o.enterTick ?? 0)) return;
    // (Nobody waiting at the nest any more, and nobody on the way to it — returned to duty, died, taken by their own
    // vehicle: the call is stood down and it waits off the map for the next.)
    if (!p || pid === null || (waitingAt(state, pid, atNest?.get(pid) ?? []).length === 0 && !comingTo(state, pid))) {
      events.emit({ kind: "medical.ambulance", tick, side: v.side, vehicle: vid, phase: "cancelled", ...(pid !== null ? { point: pid } : {}) });
      v.offMap = { kind: "ambulance", phase: "ready" };
      return;
    }
    const entry = o.entry ?? entryPoint(ctx, state, p.unit, p.x, p.y);
    if (!entry) { o.retryTick = tick + secondsToTicks(E.retryS); return; }
    // Onto the map at its entry point.
    const t = state.transform.req(vid);
    t.x = entry.x; t.y = entry.y; t.z = 0; t.heading = entry.heading;
    const d = v.drive;
    d.progressX = entry.x; d.progressY = entry.y; d.progressTick = tick; d.backX = entry.x; d.backY = entry.y; d.brake = 0;
    v.movedTick = tick;
    o.phase = "inbound";
    events.emit({ kind: "medical.ambulance", tick, side: v.side, vehicle: vid, phase: "entered", point: pid!, unit: p.unit });
    o.point = pid!;
    o.retryTick = tick;
  }
  if (!canDrive(ctx, state, v) && o.phase !== "loading") {
    o.phase = "lost";
    delete o.loading;
    events.emit({ kind: "medical.ambulance", tick, side: v.side, vehicle: vid, phase: "lost", ...(pid !== null ? { point: pid } : {}) });
    return;
  }
  const t = state.transform.req(vid);
  if (o.phase === "inbound") {
    if (!p || pid === null) { leave(ctx, state, events, vid); return; }
    o.point = pid;
    // (Re-)route when the nest moved or the last try failed.
    const moved = !o.goal || hypot2(o.goal.px - p.x, o.goal.py - p.y) > E.standM;
    if (moved || (v.drive.arrived && tick >= (o.retryTick ?? 0) && hypot2(t.x - o.goal!.x, t.y - o.goal!.y) > 10)) {
      const g = cutShort(ctx, v, t, standSpot(ctx, t, p.x, p.y, E.standM), p.x, p.y, E.standM + STOP_SLACK_M);
      o.goal = { x: g.x, y: g.y, px: p.x, py: p.y };
      if (!driveTo(ctx, state, vid, g.x, g.y, true)) {
        events.emit({ kind: "medical.ambulance", tick, side: v.side, vehicle: vid, phase: "noRoute", point: pid });
        o.retryTick = tick + secondsToTicks(E.retryS);
        // (No way to the nest for maxStayS since it came on: it goes back with whoever is aboard.)
        if (ticksToSeconds(tick - (o.enterTick ?? tick)) >= E.maxStayS) leave(ctx, state, events, vid);
        return;
      }
      o.retryTick = tick + secondsToTicks(E.retryS);
    }
    const dNest = hypot2(t.x - p.x, t.y - p.y);
    let near = dNest <= E.standM + 10 || hypot2(t.x - o.goal!.x, t.y - o.goal!.y) <= 6;
    // (Held up by the ground close to the men — a gap it cannot turn through: it stops there, the crew carries.)
    if (!near && dNest <= HELD_UP_NEAR_M && (v.drive.stuckTicks > 0 || v.drive.replans >= 2) && Math.abs(v.drive.speed) < 0.5) near = true;
    // (Held up on the way for maxStayS: close enough it stops where it is; else it gives up and goes back.)
    if (!near && ticksToSeconds(tick - (o.enterTick ?? tick)) >= E.maxStayS) {
      if (hypot2(t.x - o.goal!.x, t.y - o.goal!.y) <= 40) near = true;
      else { leave(ctx, state, events, vid); return; }
    }
    if (!near) return;
    vehicleHalt(state, vid);
    o.phase = "loading"; o.arriveTick = tick; o.lastLoadTick = tick;
    events.emit({ kind: "medical.ambulance", tick, side: v.side, vehicle: vid, phase: "arrived", point: pid, unit: p.unit });
    if (v.unit !== null) radio(state, events, v.unit, "radio.ambulanceArrived");
    return;
  }
  if (o.phase === "loading") {
    if (!p || pid === null) { leave(ctx, state, events, vid); return; }
    // The nest moved away: after it (whoever is being carried aboard stays where he lies).
    if (o.goal && hypot2(o.goal.px - p.x, o.goal.py - p.y) > E.standM * 2) {
      delete o.loading;
      // (With men aboard it takes them back now; empty, it goes after the nest.)
      if (aboard(v, ctx).length > 0) { leave(ctx, state, events, vid); return; }
      o.phase = "inbound"; delete o.goal;
      return;
    }
    const def = ctx.catalog.vehicles[v.def]!;
    if (o.loading) {
      const c = o.loading.casualty, s = state.soldier.get(c);
      if (tick < o.loading.doneTick) return;
      if (s && s.physiology.alive && s.atNest === pid && !isMounted(s) && !state.carry.has(c)) {
        // (The medic finishing a treatment on him first.)
        if (treatedNow(state).has(c)) { o.loading.doneTick = tick + secondsToTicks(5); return; }
        if (seatCasualty(ctx, state, vid, c, events)) {
          delete s.atNest;
          o.lastLoadTick = tick;
          events.emit({ kind: "medical.ambulance", tick, side: v.side, vehicle: vid, phase: "loaded", point: pid, casualty: c });
        }
      }
      delete o.loading;
    }
    if (!canDrive(ctx, state, v)) {
      o.phase = "lost";
      events.emit({ kind: "medical.ambulance", tick, side: v.side, vehicle: vid, phase: "lost", point: pid });
      return;
    }
    // The next man: the first (T1 first) its places still fit.
    const waiting = waitingAt(state, pid, atNest?.get(pid) ?? []);
    const used = placesUsed(state, v, def);
    let next: EntityId | null = null;
    for (const c of waiting) {
      const lies = liesAboard(ctx, state.soldier.req(c));
      if (placesFit(ctx, def, used.lying + (lies ? 1 : 0), used.sitting + (lies ? 0 : 1))) { next = c; break; }
    }
    if (next !== null) {
      const ct = state.transform.req(next);
      const walkS = (2 * hypot2(ct.x - t.x, ct.y - t.y)) / E.carryMps;
      o.loading = { casualty: next, doneTick: tick + secondsToTicks(def.ramp.loadCasualtySeconds + E.loadSecondsExtra + walkS) };
      return;
    }
    // Nobody to take now: full (men left waiting), or wait a while for more on their way.
    const full = waiting.length > 0;
    const since = ticksToSeconds(tick - (o.lastLoadTick ?? tick)), stay = ticksToSeconds(tick - (o.arriveTick ?? tick));
    if (full || stay >= E.maxStayS || (since >= E.waitS && !comingTo(state, pid))) leave(ctx, state, events, vid);
    return;
  }
  if (o.phase === "outbound") {
    const entry = o.entry!;
    if (hypot2(t.x - entry.x, t.y - entry.y) <= E.edgeM) { offTheMap(ctx, state, events, vid); return; }
    // (Held up on its way back for maxStayS — men lying in its way, ground it cannot turn on: it finds another way
    // off the map, which is not simulated; its wounded are evacuated as on any other run.)
    if (ticksToSeconds(tick - (o.departTick ?? tick)) >= E.maxStayS) { offTheMap(ctx, state, events, vid); return; }
    if (v.drive.arrived && tick >= (o.retryTick ?? 0)) {
      if (!driveTo(ctx, state, vid, entry.x, entry.y)) events.emit({ kind: "medical.ambulance", tick, side: v.side, vehicle: vid, phase: "noRoute" });
      o.retryTick = tick + secondsToTicks(E.retryS);
    }
  }
}

/** Drive back to the entry point (with whoever is aboard). */
function leave(ctx: SimContext, state: SimState, events: EventSink, vid: EntityId): void {
  const E = ctx.catalog.medical!.evacuation!;
  const v = state.vehicle.req(vid), o = v.offMap!;
  delete o.loading;
  o.phase = "outbound"; o.departTick = state.tick;
  const entry = o.entry ?? (() => { const t = state.transform.req(vid); return { x: t.x, y: t.y, heading: t.heading }; })();
  o.entry = entry;
  const n = aboard(v, ctx).length;
  events.emit({ kind: "medical.ambulance", tick: state.tick, side: v.side, vehicle: vid, phase: "departed", ...(o.point !== undefined ? { point: o.point } : {}), aboard: n });
  if (v.unit !== null) radio(state, events, v.unit, "radio.ambulanceLeaving", { n });
  const p = o.point !== undefined ? state.rear.get(o.point) : undefined;
  if (!backAwayAndGo(ctx, state, vid, p, entry, E.pace, E.nearPace)) events.emit({ kind: "medical.ambulance", tick: state.tick, side: v.side, vehicle: vid, phase: "noRoute" });
  o.retryTick = state.tick + secondsToTicks(E.retryS);
}

/**
 * Drive from the rear point `p` to `to`: facing the point, with men lying ahead, it first backs away from them, then
 * turns for `to` (near the point at the slow `nearPace`, so that its look-ahead for men in its way does not reach the
 * men lying there). True if it has a route.
 */
export function backAwayAndGo(ctx: SimContext, state: SimState, vid: EntityId, p: { x: number; y: number } | undefined, to: { x: number; y: number }, pace: DefId, nearPace: DefId): boolean {
  const t = state.transform.req(vid);
  if (p && cos(t.heading) * (p.x - t.x) + sin(t.heading) * (p.y - t.y) > 0) {
    const bx = t.x - cos(t.heading) * BACK_OFF_M, by = t.y - sin(t.heading) * BACK_OFF_M;
    const L = hypot2(to.x - bx, to.y - by), k = L > NEAR_M ? NEAR_M / L : 1;
    const mx = bx + (to.x - bx) * k, my = by + (to.y - by) * k;
    if (bx > 2 && by > 2 && bx < ctx.map.widthM - 2 && by < ctx.map.heightM - 2 && vehicleMove(ctx, state, vid, [{ x: bx, y: by, mode: nearPace, reverse: true }, { x: mx, y: my, mode: nearPace }, { x: to.x, y: to.y, mode: pace }], undefined) === true) return true;
  }
  return driveTo(ctx, state, vid, to.x, to.y, false, pace, nearPace);
}

/** How far an ambulance backs away from the nest before it turns for home (m; room for a wheeled hull's turn). */
const BACK_OFF_M = 25;
/** How far from there it keeps to the slow pace (m). */
const NEAR_M = 30;

/** Off the map: its living wounded are evacuated; the hull waits at the off-map park (one run per hull). */
function offTheMap(ctx: SimContext, state: SimState, events: EventSink, vid: EntityId): void {
  const v = state.vehicle.req(vid), o = v.offMap!;
  // Every living wounded man aboard leaves the battle with it (a wounded crewman too).
  evacuateAboard(ctx, state, events, vid, "ambulance", () => true);
  const n = aboard(v, ctx).length;
  o.phase = "away"; o.leftTick = state.tick;
  delete o.goal; delete o.retryTick;
  parkOffMap(state, vid);
  if (v.unit !== null) { const u = state.unit.get(v.unit); if (u) u.moving = false; }
  events.emit({ kind: "medical.ambulance", tick: state.tick, side: v.side, vehicle: vid, phase: "away", ...(o.point !== undefined ? { point: o.point } : {}), aboard: n });
}

/** Is this vehicle an ambulance on a run on the map (for the interface)? */
export function onRun(v: VehicleState): boolean {
  return v.offMap?.kind === "ambulance" && !isOffMap(v) && v.offMap.phase !== "lost";
}

/**
 * Hand over the living wounded aboard vehicle `vid` at the map edge (M10.6a ambulances; M10.6b rear runs: `who` picks
 * which of them, a combat vehicle's fit crew stays with it): each is evacuated, and his Role 1 outcome is settled now.
 */
export function evacuateAboard(ctx: SimContext, state: SimState, events: EventSink, vid: EntityId, via: "ambulance" | "vehicle", who: (sid: EntityId, s: SoldierState) => boolean): number {
  const v = state.vehicle.req(vid);
  let n = 0;
  for (const sid of v.seats) {
    if (sid === null) continue;
    const s: SoldierState | undefined = state.soldier.get(sid);
    if (!s || !s.physiology.alive || s.wounds.length === 0 || s.evacuated !== undefined || !who(sid, s)) continue;
    s.evacuated = { tick: state.tick, vehicle: vid, via };
    delete s.atNest; delete s.evacOrdered; delete s.evacRetryTick;
    let woundedTick = state.tick;
    for (const w of s.wounds) woundedTick = Math.min(woundedTick, w.tickInflicted);
    events.emit({ kind: "medical.evacuated", tick: state.tick, side: v.side, casualty: sid, vehicle: vid, woundedTick, via });
    handOver(ctx, state, events, sid, "own", state.tick);
    n++;
  }
  return n;
}
