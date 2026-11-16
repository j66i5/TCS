/**
 * RECOVERY FROM THE REAR (M11.7b, SPEC 6.7 "recovery and repair states", owner M11 round: "a recovery vehicle can be
 * requested to tow a disabled vehicle"; the M10 off-map machinery reused: offmap.ts, evacuation.ts helpers).
 *
 * Each side with vehicles has its recovery vehicles (Bergepanzer 3 Büffel, BREM-1) as off-map assets: in the battle
 * from tick 0 with their crews, parked off the map, outside the side's strength (like the ambulances). Nobody calls
 * one automatically: the player's `callRecovery` order, or the AI commander's (ai package), names a hull that is
 * immobilised or abandoned (not destroyed, not burning). The side's next waiting recovery vehicle that can tow its
 * mass comes on after a delay (`Streams.recovery`) at the map edge behind the hull, drives toward it and reverses the
 * last `approachM` onto a spot `gapM` from it (the hull is no wreck in the navigation grids from the call on, and the
 * pair does not block each other). It does not drive into fire: while the hull was hit within `hitS` or an enemy is
 * known within `enemyNearM` of it, it waits `waitShortM` short until quiet for `quietS`, and goes back after
 * `giveUpS`. At the hull: the hull's able passengers get out (its crew stays aboard: the driver steers and brakes a
 * towed hull), `hookUpMen` of its crew work `hookUpS` outside (action `hookUp`: exposed like men on foot; a hit or
 * fire on the crew stops them, they go on when quiet). Then it tows the hull (a rigid bar: the hull follows the hitch,
 * `towSystem`, no faster than `towMaxMps`) back to where it came on and both leave the map: the hull is `towAway`
 * (off the map for good, its wounded evacuated, its crew aboard with it), roster `recovery: towed`. A recovery
 * vehicle that cannot drive any more is "lost" (the tow dropped where it is). One run per hull. At the end of the
 * battle every damaged own hull still on the map is settled (`settleVehicles`): recovered by the side holding the
 * ground, else captured. Off: no core/repair.json `recovery`, or `rules.recovery === false`.
 */
import { interruptAction, registerActionHandler, startAction } from "../actions";
import type { Action, VehicleRecovery, VehicleState } from "../components";
import type { SimContext } from "../context";
import type { EventSink } from "../events";
import { secondsToTicks, ticksToSeconds, type EntityId, type SideId } from "../ids";
import { isAble } from "../impair";
import { sideKnowledge, type KnownEnemy } from "../knowledge";
import { atan2, cos, hypot2, PI, sin } from "../math";
import { isOffMap, parkOffMap } from "../offmap";
import { nextRange, Streams } from "../rng";
import type { SimState } from "../state";
import type { Order } from "../orders";
import { getOut } from "./boarding";
import { vehicleHalt, vehicleMove, type OrderResult } from "./drive";
import { canDrive, entryPoint, evacuateAboard, radio, standSpot } from "./evacuation";
import { topOf } from "./nest";
import { endRepairByOrder } from "./repair";
import { holderAt } from "./aftercare";

/** The hook-up action (= mount.ts HOOK_UP; a literal here: handlers register at load, before mount.ts in a cycle). */
const HOOK_UP = "hookUp";
const OPEN_ENDED_TICKS = 1e9;
/** The system runs once a second. */
const STEP_S = 1;
/** A worker suppressed above this stops hooking up (as a repairer outside). */
const SUPPRESSION_STOP = 0.5;

export function recoveryEnabled(ctx: SimContext): boolean {
  return ctx.catalog.recovery !== undefined && ctx.rules.recovery !== false;
}

/** Does this hull need towing (immobilised or abandoned; not destroyed, not burning, not off the map, no asset)? */
export function needsRecovery(ctx: SimContext, state: SimState, v: VehicleState): boolean {
  if (v.offMap !== undefined || isOffMap(v) || v.status === "destroyed" || v.fire !== null) return false;
  if (v.status === "immobilised" || v.status === "abandoned") return true;
  // (A hull without a crew able to drive it: no driver left.)
  return v.unit === null || !canDrive(ctx, state, v);
}

/** The side's next recovery vehicle waiting off the map that can tow `massKg` (lowest id); "heavy": one waits, but
 *  none tows that much; null: none waits. */
function readyRecovery(ctx: SimContext, state: SimState, side: SideId, massKg: number): EntityId | "heavy" | null {
  let heavy = false;
  for (const [vid, v] of state.vehicle.entries()) {
    if (v.offMap?.kind !== "recovery" || v.offMap.phase !== "ready" || v.side !== side) continue;
    const r = ctx.catalog.vehicles[v.def]?.recovery;
    if (!r) continue;
    if (massKg <= r.towMaxKg) return vid;
    heavy = true;
  }
  return heavy ? "heavy" : null;
}

/** How many recovery vehicles of the side still wait off the map (for the interface). */
export function recoveryLeft(state: SimState, side: SideId): number {
  let n = 0;
  for (const [, v] of state.vehicle.entries()) if (v.offMap?.kind === "recovery" && v.offMap.phase === "ready" && v.side === side) n++;
  return n;
}

/** The crew unit of the hull: its crew, else the crew that left it (lowest id), else null. */
function crewOf(state: SimState, vid: EntityId, v: VehicleState): EntityId | null {
  if (v.unit !== null) return v.unit;
  for (const [uid, u] of state.unit.entries()) if (u.exVehicle === vid) return uid;
  return null;
}

/**
 * Call a recovery vehicle for hull `vid` of `side` (the player's or the AI's `callRecovery` order; `caller`: the
 * unit that calls, for the edge it comes from when the hull has no crew). True, or the refusal's radio key.
 */
export function callRecovery(ctx: SimContext, state: SimState, events: EventSink, vid: EntityId, caller: EntityId | null, ordered: boolean): OrderResult {
  if (!recoveryEnabled(ctx)) return "unable";
  const R = ctx.catalog.recovery!;
  const v = state.vehicle.get(vid), def = v ? ctx.catalog.vehicles[v.def] : undefined;
  if (!v || !def) return "unable";
  if (v.recoveryBy !== undefined) return { unable: "radio.recoveryAlready" };
  if (!needsRecovery(ctx, state, v)) return { unable: "radio.recoveryNotNeeded" };
  const rid = readyRecovery(ctx, state, v.side, def.massKg);
  if (rid === null) return { unable: "radio.noRecovery" };
  if (rid === "heavy") return { unable: "radio.recoveryTooHeavy" };
  const rv = state.vehicle.req(rid), rdef = ctx.catalog.vehicles[rv.def]!;
  const crew = crewOf(state, vid, v) ?? caller;
  const t = state.transform.req(vid);
  const top = crew !== null ? topOf(state, crew) : null;
  const entry = top !== null ? entryPoint(ctx, state, top, t.x, t.y, rdef.class) : null;
  if (!entry) return { unable: "radio.recoveryNoWay" };
  const delayS = nextRange(state.rng, Streams.recovery, R.delayMinS, R.delayMaxS);
  rv.offMap = { kind: "recovery", phase: "called", target: vid, ...(top !== null ? { unit: top } : {}), callTick: state.tick, enterTick: state.tick + secondsToTicks(delayS), entry, ...(ordered ? { ordered: true as const } : {}) };
  v.recoveryBy = rid;
  const dueS = Math.round(delayS);
  events.emit({ kind: "vehicle.recovery", tick: state.tick, side: v.side, vehicle: rid, target: vid, phase: "called", dueS, ...(ordered ? { ordered: true as const } : {}) });
  if (!ordered && top !== null) radio(state, events, top, "radio.recoveryCalled", { min: Math.round(dueS / 60) });
  return true;
}

/**
 * The `callRecovery` order: the hull named (`vehicle`), else the target crew's hull, else the hull the target crew
 * left (bailed out).
 */
export function callRecoveryOrder(ctx: SimContext, state: SimState, events: EventSink, order: Order & { kind: "callRecovery" }): OrderResult {
  const uid = state.unit.has(order.target) ? order.target : state.identity.get(order.target)?.unit;
  const u = uid === undefined ? undefined : state.unit.get(uid);
  if (u?.asset !== undefined) return "unable";
  const vid = order.vehicle ?? u?.vehicle ?? u?.exVehicle;
  if (vid === undefined || !state.vehicle.has(vid)) return "unable";
  if (u && state.vehicle.req(vid).side !== u.side) return "unable";
  return callRecovery(ctx, state, events, vid, uid ?? null, order.player === true);
}

// ---------------------------------------------------------------- the hook-up action

function hookStop(state: SimState, actor: EntityId, a: Action): string | null {
  const rid = Number(a.params["vehicle"]), rv = state.vehicle.get(rid), s = state.soldier.get(actor);
  if (!rv || rv.offMap?.phase !== "hookUp" || rv.status === "destroyed" || rv.fire !== null) return "unable";
  if (!s || !isAble(s) || s.mount?.vehicle !== rid || !s.impair.canUseArms || !s.impair.canWalk) return "unable";
  if (rv.lastHitTick >= a.startTick) return "hit";
  if (s.mental.suppression > SUPPRESSION_STOP) return "underFire";
  const u = rv.unit === null ? undefined : state.unit.get(rv.unit);
  if (u !== undefined && u.underFireTick > a.startTick) return "underFire";
  return null;
}
registerActionHandler(HOOK_UP, {
  check(_ctx, state, actor, a) { return hookStop(state, actor, a); },
  complete() { /* open-ended: the run ends it */ },
});

/** Seat indices of the men hooking up now. */
function hookWorkers(state: SimState, rid: EntityId, v: VehicleState): number[] {
  const out: number[] = [];
  if (state.action.size === 0) return out;
  for (let k = 0; k < v.seats.length; k++) {
    const m = v.seats[k];
    if (m === null || m === undefined) continue;
    const a = state.action.get(m);
    if (a?.kind === HOOK_UP && Number(a.params["vehicle"]) === rid) out.push(k);
  }
  return out;
}

/** Free, able crewmen to hook up: not the driver first (the mechanic's seat, then the commander), the driver last. */
function freeHookMen(ctx: SimContext, state: SimState, v: VehicleState, n: number): number[] {
  const def = ctx.catalog.vehicles[v.def]!;
  const order = ["loader", "gunner", "commander", "driver"] as const;
  const out: number[] = [];
  for (const kind of order) {
    for (let k = 0; k < def.seats.length && out.length < n; k++) {
      if (def.seats[k]!.station !== kind) continue;
      const m = v.seats[k];
      if (m === null || m === undefined || state.action.has(m)) continue;
      const s = state.soldier.get(m);
      if (!isAble(s) || !s!.impair.canUseArms || !s!.impair.canWalk) continue;
      out.push(k);
    }
  }
  return out;
}

// ---------------------------------------------------------------- the run

/** Is the hull's surroundings quiet for the recovery vehicle (not hit within hitS, no enemy known within enemyNearM)? */
function quietAt(ctx: SimContext, state: SimState, side: SideId, tv: VehicleState, tt: { x: number; y: number }, near: (side: SideId) => KnownEnemy[]): boolean {
  const R = ctx.catalog.recovery!;
  if (state.tick - tv.lastHitTick < secondsToTicks(R.hitS)) return false;
  for (const e of near(side)) if (hypot2(e.x - tt.x, e.y - tt.y) < R.enemyNearM) return false;
  return true;
}

/** Each second: every recovery vehicle on a run (see the header). Returns at once without recovery vehicles. */
export function recoverySystem(ctx: SimContext, state: SimState, events: EventSink): void {
  if (state.vehicle.size === 0 || !recoveryEnabled(ctx)) return;
  if (state.tick % secondsToTicks(STEP_S) !== 0) return;
  let runs: EntityId[] | null = null;
  // off-map: ok (the assets themselves, on the map or not)
  for (const [vid, v] of state.vehicle.entries()) {
    const o = v.offMap;
    if (o?.kind === "recovery" && o.phase !== "ready" && o.phase !== "away" && o.phase !== "lost") (runs ??= []).push(vid);
  }
  if (runs === null) return;
  const known = new Map<SideId, KnownEnemy[]>();
  // mounted: ok (sideKnowledge lists men on foot and hulls only)
  const near = (side: SideId) => { let k = known.get(side); if (!k) { k = sideKnowledge(ctx, state, side); known.set(side, k); } return k; };
  for (const rid of runs) stepRun(ctx, state, events, rid, near);
}

function emit(state: SimState, events: EventSink, rid: EntityId, rv: VehicleState, phase: "entered" | "waiting" | "arrived" | "hookedUp" | "departed" | "away" | "lost" | "cancelled" | "noRoute", extra: { why?: string } = {}): void {
  const o = rv.offMap!;
  events.emit({ kind: "vehicle.recovery", tick: state.tick, side: rv.side, vehicle: rid, target: o.target ?? -1, phase, ...(o.ordered ? { ordered: true as const } : {}), ...extra });
}

/** The run is over for the hull (cancelled, lost, or towed away): it is an ordinary hull (a wreck again) or gone. */
function releaseTarget(state: SimState, o: NonNullable<VehicleState["offMap"]>): void {
  const tv = o.target === undefined ? undefined : state.vehicle.get(o.target);
  if (!tv) return;
  delete tv.recoveryBy; delete tv.towedBy;
}

/** Back to where it came on, without the hull (stood down, or gave up). */
function goBack(ctx: SimContext, state: SimState, events: EventSink, rid: EntityId, why: string): void {
  const R = ctx.catalog.recovery!;
  const rv = state.vehicle.req(rid), o = rv.offMap!;
  stopHook(state, events, rid, rv, why);
  emit(state, events, rid, rv, "cancelled", { why });
  if (o.unit !== undefined) radio(state, events, o.unit, why === "notNeeded" ? "radio.recoveryNotNeeded" : "radio.recoveryLeaving");
  releaseTarget(state, o);
  o.phase = "outbound"; o.departTick = state.tick;
  delete o.goal; delete o.waitTick; delete o.noisyTick;
  const entry = o.entry!;
  vehicleMove(ctx, state, rid, [{ x: entry.x, y: entry.y, mode: R.pace }], undefined);
  o.retryTick = state.tick + secondsToTicks(R.retryS);
}

function stopHook(state: SimState, events: EventSink, rid: EntityId, rv: VehicleState, why: string): void {
  for (const k of hookWorkers(state, rid, rv)) interruptAction(state, events, rv.seats[k]!, why);
}

/** Its spot by the hull (reversed up to it, facing back the way it came) and the point it turns at, short of it. */
function spots(ctx: SimContext, state: SimState, rid: EntityId, rv: VehicleState, tid: EntityId): { s: { x: number; y: number }; a: { x: number; y: number } } {
  const R = ctx.catalog.recovery!;
  const rdef = ctx.catalog.vehicles[rv.def]!, tdef = ctx.catalog.vehicles[state.vehicle.req(tid).def]!;
  const rt = state.transform.req(rid), tt = state.transform.req(tid);
  const L = hypot2(rt.x - tt.x, rt.y - tt.y);
  const ux = L > 1 ? (rt.x - tt.x) / L : 1, uy = L > 1 ? (rt.y - tt.y) / L : 0;
  const off = tdef.body.lengthM / 2 + R.gapM + rdef.body.lengthM / 2;
  const s = standSpot(ctx, rt, tt.x + ux * off, tt.y + uy * off, 0, rdef.class);
  const a = standSpot(ctx, rt, s.x + ux * R.approachM, s.y + uy * R.approachM, 0, rdef.class);
  return { s, a };
}

function stepRun(ctx: SimContext, state: SimState, events: EventSink, rid: EntityId, near: (side: SideId) => KnownEnemy[]): void {
  const R = ctx.catalog.recovery!;
  const rv = state.vehicle.req(rid), o = rv.offMap!, tick = state.tick;
  const tid = o.target;
  const tv = tid === undefined ? undefined : state.vehicle.get(tid);
  if (o.phase === "called") {
    if (tick < (o.enterTick ?? 0)) return;
    // (The hull no longer needs it — destroyed, burning, driving again: stood down, it waits for the next call.)
    if (!tv || tid === undefined || !needsRecovery(ctx, state, tv)) {
      emit(state, events, rid, rv, "cancelled", { why: "notNeeded" });
      releaseTarget(state, o);
      rv.offMap = { kind: "recovery", phase: "ready" };
      return;
    }
    const entry = o.entry!;
    const t = state.transform.req(rid);
    t.x = entry.x; t.y = entry.y; t.z = 0; t.heading = entry.heading;
    const d = rv.drive;
    d.progressX = entry.x; d.progressY = entry.y; d.progressTick = tick; d.backX = entry.x; d.backY = entry.y; d.brake = 0;
    rv.movedTick = tick;
    o.phase = "inbound";
    emit(state, events, rid, rv, "entered");
    o.retryTick = tick;
  }
  if (!canDrive(ctx, state, rv)) {
    // Stranded on the map (no driver, immobilised, its crew getting out): an ordinary hull from now on; the tow drops.
    stopHook(state, events, rid, rv, "lost");
    const towing = o.phase === "towing";
    o.phase = "lost";
    emit(state, events, rid, rv, "lost");
    releaseTarget(state, o);
    if (towing && tv) vehicleHalt(state, tid!);
    delete rv.drive.towCapMps;
    return;
  }
  const t = state.transform.req(rid);
  if (o.phase === "inbound" || o.phase === "waiting") {
    if (!tv || tid === undefined || !needsRecovery(ctx, state, tv)) { goBack(ctx, state, events, rid, "notNeeded"); return; }
    const tt = state.transform.req(tid);
    const dT = hypot2(t.x - tt.x, t.y - tt.y);
    const quiet = quietAt(ctx, state, rv.side, tv, tt, near);
    if (!quiet) o.noisyTick = tick;
    if (o.phase === "waiting") {
      if (ticksToSeconds(tick - (o.waitTick ?? tick)) >= R.giveUpS) { goBack(ctx, state, events, rid, "underFire"); return; }
      if (tick - (o.noisyTick ?? -1e9) < secondsToTicks(R.quietS)) return;
      o.phase = "inbound"; delete o.goal;
    } else if (!quiet && dT <= R.waitShortM + 20) {
      // Short of a hull under fire: it halts and waits for quiet.
      vehicleHalt(state, rid);
      o.phase = "waiting"; o.waitTick = tick;
      emit(state, events, rid, rv, "waiting");
      if (o.unit !== undefined) radio(state, events, o.unit, "radio.recoveryWaiting");
      return;
    }
    // (Re-)route: first time, or the last try ended short of its spot.
    const atSpot = o.goal !== undefined && hypot2(t.x - o.goal.x, t.y - o.goal.y) <= R.standTolM;
    if (atSpot && Math.abs(rv.drive.speed) < 0.3) { beginHookUp(ctx, state, events, rid, rv, tid, tv); return; }
    if (!o.goal || (rv.drive.arrived && tick >= (o.retryTick ?? 0))) {
      const { s, a } = spots(ctx, state, rid, rv, tid);
      o.goal = { x: s.x, y: s.y, px: tt.x, py: tt.y };
      // A held-up approach close to the hull: it hooks up from where it is (the bar is long enough within twice its tolerance).
      if (rv.drive.arrived && hypot2(t.x - s.x, t.y - s.y) <= R.standTolM * 2 && (rv.drive.replans > 0 || rv.drive.stuckTicks > 0)) { beginHookUp(ctx, state, events, rid, rv, tid, tv); return; }
      const far = hypot2(t.x - a.x, t.y - a.y) > 3;
      const ok = vehicleMove(ctx, state, rid, [...(far ? [{ x: a.x, y: a.y, mode: R.pace }] : []), { x: s.x, y: s.y, mode: R.nearPace, reverse: true }], undefined) === true;
      if (!ok) emit(state, events, rid, rv, "noRoute");
      o.retryTick = tick + secondsToTicks(R.retryS);
      // (No way to the hull for heldMaxS since it came on: it goes back.)
      if (!ok && ticksToSeconds(tick - (o.enterTick ?? tick)) >= R.heldMaxS) goBack(ctx, state, events, rid, "noRoute");
    }
    return;
  }
  if (o.phase === "hookUp") {
    if (!tv || tid === undefined || tv.status === "destroyed" || tv.fire !== null) { goBack(ctx, state, events, rid, "notNeeded"); return; }
    const rdef = ctx.catalog.vehicles[rv.def]!, rec = rdef.recovery!;
    const men = hookWorkers(state, rid, rv);
    if (men.length > 0) {
      o.hookDoneS = (o.hookDoneS ?? 0) + STEP_S * Math.min(1, men.length / rec.hookUpMen);
      if (o.hookDoneS >= rec.hookUpS) { startTow(ctx, state, events, rid, rv, tid, tv); return; }
      if (men.length < rec.hookUpMen) setHookMen(ctx, state, events, rid, rv, rec.hookUpMen - men.length);
      return;
    }
    // Nobody at it (stopped by fire, or none free): again once quiet.
    const u = rv.unit === null ? undefined : state.unit.get(rv.unit);
    if (tick - rv.lastHitTick < secondsToTicks(R.quietS) || (u !== undefined && tick - u.underFireTick < secondsToTicks(R.quietS))) return;
    setHookMen(ctx, state, events, rid, rv, rec.hookUpMen);
    return;
  }
  if (o.phase === "towing" || o.phase === "outbound") {
    const entry = o.entry!;
    const held = ticksToSeconds(tick - (o.departTick ?? tick)) >= R.heldMaxS;
    if (hypot2(t.x - entry.x, t.y - entry.y) <= R.edgeM || held) { offTheMap(ctx, state, events, rid); return; }
    if (rv.drive.arrived && tick >= (o.retryTick ?? 0)) {
      if (vehicleMove(ctx, state, rid, [{ x: entry.x, y: entry.y, mode: R.pace }], undefined) !== true) emit(state, events, rid, rv, "noRoute");
      o.retryTick = tick + secondsToTicks(R.retryS);
    }
  }
}

function setHookMen(ctx: SimContext, state: SimState, events: EventSink, rid: EntityId, rv: VehicleState, n: number): void {
  const have = hookWorkers(state, rid, rv).length;
  freeHookMen(ctx, state, rv, n).forEach((k, i) => {
    const m = rv.seats[k]!;
    startAction(state, events, m, HOOK_UP, OPEN_ENDED_TICKS, { vehicle: rid, slot: have + i });
    const s = state.soldier.get(m);
    if (s && s.posture !== "crouching") { s.posture = "crouching"; s.postureTo = null; events.emit({ kind: "posture.changed", tick: state.tick, soldier: m, posture: "crouching" }); }
  });
}

/** At the hull: halted; the hull's able passengers get out, its crew stays aboard; the men go out to hook up. */
function beginHookUp(ctx: SimContext, state: SimState, events: EventSink, rid: EntityId, rv: VehicleState, tid: EntityId, tv: VehicleState): void {
  const o = rv.offMap!;
  vehicleHalt(state, rid);
  o.phase = "hookUp"; o.arriveTick = state.tick; o.hookDoneS = 0;
  emit(state, events, rid, rv, "arrived");
  if (o.unit !== undefined) radio(state, events, o.unit, "radio.recoveryArrived");
  // Any repair on the hull ends (the recovery takes over; the progress stays with the hull).
  endRepairByOrder(state, events, tid);
  const tdef = ctx.catalog.vehicles[tv.def]!;
  const exits = Math.max(1, tdef.ramp.exits.length);
  for (let k = 0; k < tv.seats.length; k++) {
    const m = tv.seats[k];
    if (m === null || m === undefined || tdef.seats[k]!.station !== "passenger") continue;
    const s = state.soldier.get(m);
    // (The wounded stay aboard: they leave the battle with the hull.)
    if (!isAble(s) || !s!.impair.canWalk || s!.wounds.length > 0 && !s!.impair.canFight) continue;
    interruptAction(state, events, m, "getOut");
    getOut(ctx, state, m, tid, k % exits, events);
  }
  setHookMen(ctx, state, events, rid, rv, ctx.catalog.vehicles[rv.def]!.recovery!.hookUpMen);
}

/** Hooked up: the men back in, the hull on the bar (its own drive off), away to where it came on. */
function startTow(ctx: SimContext, state: SimState, events: EventSink, rid: EntityId, rv: VehicleState, tid: EntityId, tv: VehicleState): void {
  const R = ctx.catalog.recovery!;
  const o = rv.offMap!;
  stopHook(state, events, rid, rv, "hookedUp");
  const rdef = ctx.catalog.vehicles[rv.def]!, tdef = ctx.catalog.vehicles[tv.def]!;
  const rt = state.transform.req(rid), tt = state.transform.req(tid);
  vehicleHalt(state, tid);
  endRepairByOrder(state, events, tid);
  tv.towedBy = rid;
  const hx = rt.x - cos(rt.heading) * rdef.body.lengthM / 2, hy = rt.y - sin(rt.heading) * rdef.body.lengthM / 2;
  const L = hypot2(hx - tt.x, hy - tt.y);
  o.towLenM = Math.min(Math.max(L, tdef.body.lengthM / 2 + 0.5), tdef.body.lengthM / 2 + R.gapM + R.standTolM);
  // (The end of the hull nearer the hitch is hooked: towed forward, or backward by its rear.)
  o.towRear = cos(tt.heading) * (hx - tt.x) + sin(tt.heading) * (hy - tt.y) < 0;
  o.phase = "towing"; o.departTick = state.tick;
  rv.drive.towCapMps = rdef.recovery!.towMaxMps;
  emit(state, events, rid, rv, "hookedUp");
  emit(state, events, rid, rv, "departed");
  if (o.unit !== undefined) radio(state, events, o.unit, "radio.recoveryLeaving");
  const entry = o.entry!;
  if (vehicleMove(ctx, state, rid, [{ x: entry.x, y: entry.y, mode: R.pace }], undefined) !== true) emit(state, events, rid, rv, "noRoute");
  o.retryTick = state.tick + secondsToTicks(R.retryS);
}

/** Off the map: the recovery vehicle (and the hull it tows) leave the battle. */
function offTheMap(ctx: SimContext, state: SimState, events: EventSink, rid: EntityId): void {
  const rv = state.vehicle.req(rid), o = rv.offMap!;
  const tid = o.target, tv = tid === undefined ? undefined : state.vehicle.get(tid);
  const towed = o.phase === "towing" && tv !== undefined && tv.towedBy === rid;
  o.phase = "away"; o.leftTick = state.tick;
  delete o.goal; delete o.retryTick;
  parkOffMap(state, rid);
  if (rv.unit !== null) { const u = state.unit.get(rv.unit); if (u) u.moving = false; }
  if (towed) {
    // Its living wounded are evacuated with it; its fit crew goes with the hull (of the force, off the map).
    evacuateAboard(ctx, state, events, tid!, "vehicle", () => true);
    delete tv.towedBy;
    tv.towAway = true;
    tv.recovery = { state: "towed", tick: state.tick, ...days(ctx, tv) };
    parkOffMap(state, tid!);
    if (tv.unit !== null) { const u = state.unit.get(tv.unit); if (u) u.moving = false; }
  } else releaseTarget(state, o);
  emit(state, events, rid, rv, "away");
}

/** Workshop days for a hull (campaign input): per damaged component its kind's days x (1 - condition); an abandoned
 *  hull without damage `abandonedDays`. */
function days(ctx: SimContext, v: VehicleState): { repairDays?: number } {
  const W = ctx.catalog.repair?.workshopDays, def = ctx.catalog.vehicles[v.def];
  let d = 0;
  def?.components?.forEach((c, k) => { const x = v.comp[k] ?? 1; if (x < 1) d += (W?.[c.kind] ?? 1) * (1 - x); });
  if (d === 0 && v.status === "abandoned") d = ctx.catalog.recovery?.abandonedDays ?? 0;
  return d > 0 ? { repairDays: Math.round(d * 10) / 10 } : {};
}

// ---------------------------------------------------------------- the tow (every tick)

/**
 * A towed hull follows its recovery vehicle's hitch on a rigid bar (after the drive, before the men's seats follow
 * their hulls): its centre stays `towLenM` from the hitch, it points at it (or away, hooked by the rear).
 */
export function towSystem(ctx: SimContext, state: SimState): void {
  if (state.vehicle.size === 0) return;
  for (const [tid, tv] of state.vehicle.entries()) {
    if (tv.towedBy === undefined || isOffMap(tv)) continue;
    const rid = tv.towedBy, rv = state.vehicle.get(rid), o = rv?.offMap;
    if (!rv || !o || o.phase !== "towing") continue;
    const rdef = ctx.catalog.vehicles[rv.def]!;
    const rt = state.transform.req(rid), tt = state.transform.req(tid);
    const hx = rt.x - cos(rt.heading) * rdef.body.lengthM / 2, hy = rt.y - sin(rt.heading) * rdef.body.lengthM / 2;
    const dx = hx - tt.x, dy = hy - tt.y, L = hypot2(dx, dy);
    if (L < 1e-6) continue;
    const len = o.towLenM ?? L;
    const nx = hx - (dx / L) * len, ny = hy - (dy / L) * len;
    const moved = hypot2(nx - tt.x, ny - tt.y);
    tt.x = nx; tt.y = ny;
    const h = atan2(dy, dx);
    tt.heading = o.towRear ? (h > 0 ? h - PI : h + PI) : h;
    tv.drive.speed = rv.drive.speed; tv.drive.yawRate = 0;
    if (moved > 0.005) tv.movedTick = state.tick;
  }
}

// ---------------------------------------------------------------- orders to towed hulls

/**
 * An order meets a hull being recovered (M11.7b, plan B4): to the crew of a hull on the bar or towed away, or getting
 * aboard one, it is refused (fire discipline excepted). Null: nothing to do with a tow.
 */
export function towGate(state: SimState, order: Order): OrderResult | null {
  if (order.kind === "fire" || order.kind === "ceaseFire" || order.kind === "rules" || order.kind === "ambush" || order.kind === "callRecovery") return null;
  let vid: EntityId | undefined = state.unit.get(order.target)?.vehicle;
  if (vid === undefined && order.kind === "mount") {
    const uid = state.unit.has(order.target) ? order.target : state.identity.get(order.target)?.unit;
    for (let u: EntityId | null = uid ?? null; u !== null && vid === undefined; u = state.unit.get(u)?.parent ?? null) vid = state.unit.get(u)?.carrier;
    if (order.vehicle !== undefined) vid = order.vehicle;
  }
  const v = vid === undefined ? undefined : state.vehicle.get(vid);
  if (!v) return null;
  if (v.towAway === true) return { unable: "radio.towedAway" };
  if (v.towedBy !== undefined) return { unable: "radio.underTow" };
  // (Getting aboard a hull a recovery vehicle is hooking up: no.)
  if (order.kind === "mount" && v.recoveryBy !== undefined && state.vehicle.get(v.recoveryBy)?.offMap?.phase === "hookUp") return { unable: "radio.underTow" };
  return null;
}

// ---------------------------------------------------------------- end of battle

/**
 * The end-of-battle settlement of the hulls (M11.7b, D18): every hull of a force still on the map that is damaged,
 * immobilised or abandoned is recovered by its own side if that side holds the ground there (more able men within
 * `holdM`, else the nearest able man's), else captured by the side that does (`capturedBy`); a hull that still
 * drives with its crew is never captured; a destroyed hull is lost. Each gets its `recovery` record.
 */
export function settleVehicles(ctx: SimContext, state: SimState, events: EventSink): void {
  if (state.vehicle.size === 0) return;
  const holdM = ctx.catalog.medical?.role1?.holdM ?? 150;
  let able: { side: SideId; x: number; y: number }[] | null = null;
  const ableMen = () => {
    if (able) return able;
    able = [];
    // mounted: ok (a man aboard holds the ground where his hull stands)
    for (const [id, ident] of state.identity.entries()) {
      const s = state.soldier.get(id);
      if (!s || !isAble(s) || state.unit.get(ident.unit)?.asset !== undefined) continue;
      const vid = s.mount?.vehicle;
      if (vid !== undefined && isOffMap(state.vehicle.get(vid))) continue;
      const t = state.transform.get(vid !== undefined ? vid : id);
      if (t) able.push({ side: ident.side, x: t.x, y: t.y });
    }
    return able;
  };
  for (const [vid, v] of state.vehicle.entries()) {
    // (Assets are not of the force; a hull towed away has its record.)
    if (v.offMap !== undefined || isOffMap(v) || v.recovery !== null) continue;
    let damaged = false;
    for (const c of v.comp) if (c < 1) { damaged = true; break; }
    let st: VehicleRecovery["state"] | null = null, by: SideId | null = null;
    if (v.status === "destroyed") st = "lost";
    else if (v.towedBy !== undefined) st = "recovered";
    else if (damaged || v.status !== "ok") {
      if (v.unit !== null && canDrive(ctx, state, v)) st = "recovered";
      else {
        const t = state.transform.req(vid);
        const holder = holderAt(ableMen(), t.x, t.y, holdM) ?? v.side;
        if (holder === v.side) st = "recovered";
        else { st = "captured"; by = holder; }
      }
    }
    if (st === null) continue;
    v.recovery = { state: st, tick: state.tick, ...(st !== "lost" ? days(ctx, v) : {}) };
    if (by !== null) v.capturedBy = by;
    events.emit({ kind: "vehicle.settled", tick: state.tick, vehicle: vid, side: v.side, state: st, ...(by !== null ? { by } : {}) });
  }
}
