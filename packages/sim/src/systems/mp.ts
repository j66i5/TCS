/**
 * MILITARY POLICE FROM THE REAR (M11.9b, plan docs/plans/m11-mp-pow.md 4.9; values core/prisoners.json `mp`, the same
 * for every side; GC III art. 19-20: prisoners evacuated from the combat zone as soon as possible).
 *
 * Each side's military police team (a Feldjägertrupp, a military police section: the manifest's `mp`) is an off-map
 * asset (offmap.ts): in the battle from tick 0 with its crew, parked off the map, outside the side's strength. It is
 * called to a platoon's prisoner collection point when the point holds its first prisoner who can walk (automatic,
 * once the platoon's radio works), or by the player's `callMp`. It comes on after a delay drawn between `delayMinS`
 * and `delayMaxS` (stream "mp") at the map edge behind the point (entryPoint, as the ambulance), drives to `standM`
 * short of it and halts. It does not drive into fire: while the point is not quiet (a known enemy within `enemyNearM`
 * of it, or a man held or guarding there suppressed within `quietS`) it waits `waitShortM` short (what the platoon's men know of the enemy, as for moving the point back), going back after
 * `giveUpS` of waiting in all (the recovery vehicle's rule). At the point its men other than the driver get out and
 * TAKE OVER THE GUARD (the squads' guards walk back to their squads at once: prisoners.ts `mpTakeOver`), and the
 * walking prisoners held there board one by one, officers first, then NCOs, then men (by id within a group): each
 * walks to its rear door and takes `loadS` to get in (registration and loading). It takes no more than its passenger
 * seats. It leaves when full, or when nobody it could take is left at or bound for the point, or `heldMaxS` after it
 * arrived: its men get back in and it drives back to where it came on. Off the map the prisoners aboard are
 * EVACUATED (`captive.evacTick`, `pow.evacuated`; a wounded one is handed to the captor's medical chain then); they
 * stay entities, off the map with the hull (isOffMapMan). It is ready again `backS` after it left (the seats it used
 * are free again; the evacuated men keep their mount pointer to it and stay off the map), and is called again if
 * prisoners still wait. A hull that cannot drive any more is stranded ("lost", an ordinary hull from then on): its
 * prisoners get out and wait at the point again. The hull is not a protected vehicle (no emblem); a hit on it with
 * prisoners aboard is a `law.hit` "prisoner" (conduct.ts). Same rules for every side, player and AI.
 */
import { onAir } from "../comms";
import type { OffMapAsset, PrisonerGroup, VehicleState } from "../components";
import type { SimContext } from "../context";
import type { EventSink, SimEvent } from "../events";
import { secondsToTicks, ticksToSeconds, type EntityId, type SideId } from "../ids";
import { isAble } from "../impair";
import { cos, hypot2, sin } from "../math";
import { parkOffMap } from "../offmap";
import { nextRange, Streams } from "../rng";
import type { SimState, SimView } from "../state";
import type { OrderResult } from "./drive";
import { vehicleHalt, vehicleMove } from "./drive";
import { exitWorld, getOut, seatIn } from "./boarding";
import { backAwayAndGo, canDrive, driveTo, entryPoint, HELD_UP_NEAR_M, radio, standSpot } from "./evacuation";
import { handOver, hasBattleWound } from "./aftercare";
import { topOf } from "./nest";
import { guardSpot, halt, headingFor, heldPrisoner, knownEnemies, mpTakeOver, prisonerGroup, walks, walkTo } from "./prisoners";
import { interruptAction } from "../actions";

type MpDef = NonNullable<NonNullable<SimContext["catalog"]["prisoners"]>["mp"]>;

/** How far it backs straight away from the point before it turns for home (m: twice a wheeled hull's U-turn). */
const BACK_OFF_M = 40;
/** Its turn short of the point: from `TURN_M` short of its spot, forward `TURN_FWD_M` and `TURN_SIDE_M` to one side,
 *  then backing up to the spot (m). */
const TURN_M = 25, TURN_FWD_M = 8, TURN_SIDE_M = 14;
/** A prisoner at the door boards when within this of it (m). */
const DOOR_M = 2.5;
/** ... or within this of the hull's end (m). */
const HULL_STEP_M = 1.5;
/** A prisoner who has not reached the door in this long is passed over (s). */
const BOARD_GIVE_UP_S = 300;
/** Its men waiting to get back in: it leaves without those not at the door after this long (s). */
const MOUNT_WAIT_S = 120;
const GROUP_ORDER: Record<PrisonerGroup, number> = { officer: 0, nco: 1, man: 2 };

export function mpEnabled(ctx: SimContext): boolean {
  return ctx.catalog.prisoners?.mp !== undefined;
}

/** The side's next MP hull waiting off the map (lowest id), if any. */
function readyMp(state: SimState, side: SideId): EntityId | null {
  for (const [vid, v] of state.vehicle.entries()) if (v.offMap?.kind === "mp" && v.offMap.phase === "ready" && v.side === side) return vid;
  return null;
}

/** How many MP hulls of the side wait off the map (for the interface). */
export function mpLeft(state: SimView, side: SideId): number {
  let n = 0;
  for (const [, v] of state.vehicle.entries()) if (v.offMap?.kind === "mp" && v.offMap.phase === "ready" && v.side === side) n++;
  return n;
}

/** The MP hull on a run to point `pid` (called, on its way, waiting or there), if any. */
export function mpServing(state: SimView, pid: EntityId): EntityId | null {
  for (const [vid, v] of state.vehicle.entries()) {
    const o = v.offMap;
    if (o?.kind === "mp" && o.point === pid && (o.phase === "called" || o.phase === "inbound" || o.phase === "waiting" || o.phase === "loading")) return vid;
  }
  return null;
}

/** The walking prisoners held at point `pid` (not aboard, not on the way to the hull), in boarding order. */
function boardable(ctx: SimContext, state: SimState, pid: EntityId): EntityId[] {
  const out: EntityId[] = [];
  // mounted: ok (held() takes men on foot only)
  for (const [id, s] of state.soldier.entries()) {
    if (!heldPrisoner(s) || s.captive!.point !== pid || s.captive!.vehicle !== undefined || s.atNest !== undefined || state.carry.has(id) || !walks(state, s)) continue;
    s.captive!.group ??= prisonerGroup(ctx, state, id);
    out.push(id);
  }
  return out.sort((a, b) => GROUP_ORDER[state.soldier.req(a).captive!.group!] - GROUP_ORDER[state.soldier.req(b).captive!.group!] || a - b);
}

/** Are prisoners on their way to point `pid` (walked there by an escort, or waiting for one in the platoon)? */
function boundFor(state: SimState, pid: EntityId, top: EntityId): boolean {
  // mounted: ok (held() takes men on foot only)
  for (const [, s] of state.soldier.entries()) {
    const c = s.captive;
    if (!c || !heldPrisoner(s) || c.point !== undefined || s.atNest !== undefined) continue;
    if (c.escort !== undefined && state.soldier.get(c.escort)?.guard?.point === pid) return true;
    if (c.escort === undefined && c.unit !== undefined && state.unit.has(c.unit) && topOf(state, c.unit) === top && walks(state, s)) return true;
  }
  return false;
}

/**
 * Call side's MP to collection point `pid`. Returns the hull, or why not: "none" (none waiting), "coming" (one is
 * already on its way there), "noEntry" (no edge it can come on by).
 */
export function callMp(ctx: SimContext, state: SimState, events: EventSink, pid: EntityId, ordered: boolean): EntityId | "none" | "coming" | "noEntry" {
  const MP = ctx.catalog.prisoners?.mp;
  const p = state.rear.get(pid);
  if (!MP || !p || p.kind !== "prisoners") return "none";
  if (mpServing(state, pid) !== null) return "coming";
  const vid = readyMp(state, p.side);
  if (vid === null) return "none";
  const v = state.vehicle.req(vid);
  const entry = entryPoint(ctx, state, p.unit, p.x, p.y, ctx.catalog.vehicles[v.def]?.class ?? "wheeled");
  if (!entry) return "noEntry";
  const delayS = nextRange(state.rng, Streams.mp, MP.delayMinS, MP.delayMaxS);
  v.offMap = { kind: "mp", phase: "called", point: pid, unit: p.unit, callTick: state.tick, enterTick: state.tick + secondsToTicks(delayS), entry, ...(ordered ? { ordered: true as const } : {}) };
  const dueS = Math.round(delayS);
  events.emit({ kind: "pow.mp", tick: state.tick, side: p.side, vehicle: vid, point: pid, phase: "called", dueS, ...(ordered ? { ordered: true as const } : {}) });
  if (!ordered) radio(state, events, p.unit, "radio.mpCalled", { min: Math.round(dueS / 60) });
  return vid;
}

/** The player's `callMp`: the target's platoon calls its side's military police to its collection point. */
export function callMpOrder(ctx: SimContext, state: SimState, events: EventSink, target: EntityId): OrderResult {
  if (!mpEnabled(ctx)) return "unable";
  const uid = state.unit.has(target) ? target : state.identity.get(target)?.unit;
  if (uid === undefined || state.unit.get(uid)?.asset !== undefined) return "unable";
  const top = topOf(state, uid);
  let pid: EntityId | null = null;
  for (const [id, p] of state.rear.entries()) if (p.kind === "prisoners" && p.unit === top) { pid = id; break; }
  if (pid === null || (boardable(ctx, state, pid).length === 0 && !boundFor(state, pid, top))) return { unable: "radio.mpNoPrisoners" };
  const r = callMp(ctx, state, events, pid, true);
  if (r === "coming") return { unable: "radio.mpComing" };
  if (r === "none") return { unable: "radio.mpNone" };
  if (r === "noEntry") return { unable: "radio.mpNoWay" };
  return true;
}

/** Each second: automatic calls, then each MP hull's run. Nothing in a battle without MP hulls. */
export function mpSystem(ctx: SimContext, state: SimState, events: EventSink): void {
  if (state.vehicle.size === 0 || !mpEnabled(ctx)) return;
  if (state.tick % secondsToTicks(1) !== 0) return;
  let runs: EntityId[] | null = null, ready = false;
  // off-map: ok (the MP hulls themselves, on the map or not)
  for (const [vid, v] of state.vehicle.entries()) {
    const o = v.offMap;
    if (o?.kind !== "mp") continue;
    if (o.phase === "ready") ready = true;
    else if (o.phase !== "lost") (runs ??= []).push(vid);
  }
  if (runs === null && !ready) return;
  if (ready && state.rear.size > 0) {
    for (const [pid, p] of state.rear.entries()) {
      if (p.kind !== "prisoners" || mpServing(state, pid) !== null || readyMp(state, p.side) === null) continue;
      if (!onAir(state, p.unit) || boardable(ctx, state, pid).length === 0) continue;
      callMp(ctx, state, events, pid, false);
    }
  }
  if (runs === null) return;
  for (const vid of runs) stepRun(ctx, state, events, vid);
}

function emit(state: SimState, events: EventSink, vid: EntityId, v: VehicleState, phase: Extract<SimEvent, { kind: "pow.mp" }>["phase"], extra: { aboard?: number; why?: string } = {}): void {
  const o = v.offMap!;
  events.emit({ kind: "pow.mp", tick: state.tick, side: v.side, vehicle: vid, ...(o.point !== undefined ? { point: o.point } : {}), phase, ...(o.ordered ? { ordered: true as const } : {}), ...extra });
}

/** Is collection point `pid` quiet for the MP (no known enemy within enemyNearM, nobody there suppressed)? */
function quietAt(ctx: SimContext, state: SimState, MP: MpDef, pid: EntityId): boolean {
  const p = state.rear.req(pid);
  // (What the platoon's men know: fresh, not down, not giving up — the rule that moves the point back.)
  for (const e of knownEnemies(ctx, state, p.unit)) if (hypot2(e.x - p.x, e.y - p.y) < MP.enemyNearM) return false;
  const seek = ctx.catalog.behaviour.decisions.seekCoverSuppression;
  // mounted: ok (prisoners and guards at the point are on foot)
  for (const [, s] of state.soldier.entries()) {
    if ((s.captive?.point === pid && heldPrisoner(s)) || s.guard?.point === pid) if (s.mental.suppression >= seek) return false;
  }
  return true;
}

/** Its crew other than the driver (seat indices), and the seat each had. */
function outsideMen(ctx: SimContext, state: SimState, v: VehicleState): EntityId[] {
  const out: EntityId[] = [];
  if (v.unit === null) return out;
  for (const m of state.unit.req(v.unit).members) { const s = state.soldier.get(m); if (s && s.mount === undefined && s.physiology.alive && s.captive === null) out.push(m); }
  return out.sort((a, b) => a - b);
}

/** The door prisoners and its men get in by: its exit nearest the point (where they come from), on the ground. */
function door(ctx: SimContext, state: SimState, vid: EntityId, v: VehicleState): { x: number; y: number } {
  const def = ctx.catalog.vehicles[v.def]!, t = state.transform.req(vid);
  const p = v.offMap?.point !== undefined ? state.rear.get(v.offMap.point) : undefined;
  let best = exitWorld(def, 0, t.x, t.y, t.heading), bd = Infinity;
  if (p) for (let k = 0; k < def.ramp.exits.length; k++) {
    const e = exitWorld(def, k, t.x, t.y, t.heading), d = hypot2(e.x - p.x, e.y - p.y);
    if (d < bd) { bd = d; best = e; }
  }
  return best;
}

/** At the door, or held up against the hull on the way round to it (within half its length and a step of its centre). */
function atHull(ctx: SimContext, state: SimState, vid: EntityId, v: VehicleState, p: { x: number; y: number }, dr: { x: number; y: number }): boolean {
  if (hypot2(p.x - dr.x, p.y - dr.y) <= DOOR_M) return true;
  const t = state.transform.req(vid);
  return hypot2(p.x - t.x, p.y - t.y) <= ctx.catalog.vehicles[v.def]!.body.lengthM / 2 + HULL_STEP_M;
}

function freePassengerSeat(ctx: SimContext, v: VehicleState): number {
  const def = ctx.catalog.vehicles[v.def]!;
  return def.seats.findIndex((q, i) => q.station === "passenger" && v.seats[i] === null);
}

/** Prisoners aboard (not yet evacuated). */
function prisonersAboard(state: SimState, v: VehicleState): EntityId[] {
  const out: EntityId[] = [];
  for (const m of v.seats) { if (m === null) continue; const c = state.soldier.get(m)?.captive; if (c?.vehicle !== undefined && c.evacTick === undefined) out.push(m); }
  return out;
}

function goBack(ctx: SimContext, state: SimState, events: EventSink, vid: EntityId, why: string): void {
  const MP = ctx.catalog.prisoners!.mp!;
  const v = state.vehicle.req(vid), o = v.offMap!;
  emit(state, events, vid, v, "cancelled", { why });
  if (o.unit !== undefined) radio(state, events, o.unit, "radio.mpLeaving", { n: 0 });
  o.phase = "outbound"; o.departTick = state.tick;
  delete o.goal; delete o.waitTick; delete o.noisyTick;
  driveTo(ctx, state, vid, o.entry!.x, o.entry!.y, false, MP.pace, MP.nearPace);
  o.retryTick = state.tick + secondsToTicks(MP.retryS);
}

function stepRun(ctx: SimContext, state: SimState, events: EventSink, vid: EntityId): void {
  const MP = ctx.catalog.prisoners!.mp!;
  const v = state.vehicle.req(vid), o = v.offMap!, tick = state.tick;
  if (o.phase === "away") {
    if (tick < (o.backTick ?? 0)) return;
    v.offMap = { kind: "mp", phase: "ready" };
    emit(state, events, vid, v, "ready");
    return;
  }
  const pid = o.point ?? null;
  const p = pid === null ? undefined : state.rear.get(pid);
  if (o.phase === "called") {
    if (tick < (o.enterTick ?? 0)) return;
    // (Nobody left for it — all taken to the nest, dead, gone: stood down, it waits off the map for the next call.)
    if (!p || pid === null || (boardable(ctx, state, pid).length === 0 && !boundFor(state, pid, p.unit))) {
      emit(state, events, vid, v, "cancelled", { why: "notNeeded" });
      v.offMap = { kind: "mp", phase: "ready" };
      return;
    }
    const entry = o.entry!;
    const t = state.transform.req(vid);
    t.x = entry.x; t.y = entry.y; t.z = 0; t.heading = entry.heading;
    const d = v.drive;
    d.progressX = entry.x; d.progressY = entry.y; d.progressTick = tick; d.backX = entry.x; d.backY = entry.y; d.brake = 0;
    v.movedTick = tick;
    o.phase = "inbound";
    emit(state, events, vid, v, "entered");
    o.retryTick = tick;
  }
  if (!canDrive(ctx, state, v)) { strand(ctx, state, events, vid, v, o); return; }
  const t = state.transform.req(vid);
  if (o.phase === "inbound" || o.phase === "waiting") {
    if (!p || pid === null) { goBack(ctx, state, events, vid, "notNeeded"); return; }
    const dP = hypot2(t.x - p.x, t.y - p.y);
    const quiet = quietAt(ctx, state, MP, pid);
    if (!quiet) o.noisyTick = tick;
    if (o.phase === "waiting") {
      o.waitedS = (o.waitedS ?? 0) + 1;
      if (o.waitedS >= MP.giveUpS) { goBack(ctx, state, events, vid, "underFire"); return; }
      if (tick - (o.noisyTick ?? -1e9) < secondsToTicks(MP.quietS)) return;
      o.phase = "inbound"; delete o.goal;
    } else if (!quiet && dP <= MP.waitShortM + 20) {
      // Short of a point under fire: it halts and waits for quiet (radioed the first time).
      vehicleHalt(state, vid);
      const first = o.waitTick === undefined;
      o.phase = "waiting"; o.waitTick = tick;
      emit(state, events, vid, v, "waiting");
      if (first && o.unit !== undefined) radio(state, events, o.unit, "radio.mpWaiting");
      return;
    }
    const moved = !o.goal || hypot2(o.goal.px - p.x, o.goal.py - p.y) > MP.standM;
    if (moved || (v.drive.arrived && tick >= (o.retryTick ?? 0) && hypot2(t.x - o.goal!.x, t.y - o.goal!.y) > 10)) {
      const r = mpApproach(ctx, state, vid, p);
      o.goal = r.goal;
      const ok = r.ok;
      if (!ok) emit(state, events, vid, v, "noRoute");
      o.retryTick = tick + secondsToTicks(MP.retryS);
    }
    let there = mpThere(ctx, state, vid, o.goal!);
    if (!there && ticksToSeconds(tick - (o.enterTick ?? tick)) - (o.waitedS ?? 0) >= MP.heldMaxS) {
      if (hypot2(t.x - o.goal!.x, t.y - o.goal!.y) <= 40) there = true;
      else { goBack(ctx, state, events, vid, "noRoute"); return; }
    }
    if (there) arrive(ctx, state, events, vid, v, pid);
    return;
  }
  if (o.phase === "loading") { stepLoading(ctx, state, events, vid, v, MP); return; }
  if (o.phase === "outbound") {
    const entry = o.entry!;
    if (hypot2(t.x - entry.x, t.y - entry.y) <= MP.edgeM || ticksToSeconds(tick - (o.departTick ?? tick)) >= MP.heldMaxS) { offTheMap(ctx, state, events, vid, v); return; }
    if (v.drive.arrived && tick >= (o.retryTick ?? 0)) {
      if (!driveTo(ctx, state, vid, entry.x, entry.y, false, MP.pace, MP.nearPace)) emit(state, events, vid, v, "noRoute");
      o.retryTick = tick + secondsToTicks(MP.retryS);
    }
  }
}

/**
 * Route MP hull `vid` to collection point `p` (also for the lab's drive alone): it turns short of the point (forward off
 * to one side, then backing up to its spot `standM` short): its rear door to the prisoners, its nose away from them,
 * so it never turns through the men there when it leaves. Close already: straight to the spot.
 */
export function mpApproach(ctx: SimContext, state: SimState, vid: EntityId, p: { x: number; y: number }): { goal: { x: number; y: number; px: number; py: number }; ok: boolean } {
  const MP = ctx.catalog.prisoners!.mp!;
  const v = state.vehicle.req(vid), t = state.transform.req(vid);
  const cls = ctx.catalog.vehicles[v.def]!.class;
  const g = standSpot(ctx, t, p.x, p.y, MP.standM, cls);
  const L = hypot2(t.x - g.x, t.y - g.y), ux = L > 1 ? (t.x - g.x) / L : 0, uy = L > 1 ? (t.y - g.y) / L : 0;
  const a = standSpot(ctx, t, g.x + ux * TURN_M, g.y + uy * TURN_M, 0, cls);
  const w = standSpot(ctx, t, a.x - ux * TURN_FWD_M - uy * TURN_SIDE_M, a.y - uy * TURN_FWD_M + ux * TURN_SIDE_M, 0, cls);
  const far = L > TURN_M + 5;
  const ok = (far && vehicleMove(ctx, state, vid, [{ x: a.x, y: a.y, mode: MP.pace }, { x: w.x, y: w.y, mode: MP.nearPace }, { x: g.x, y: g.y, mode: MP.nearPace, reverse: true }], undefined) === true)
    || driveTo(ctx, state, vid, g.x, g.y, true, MP.pace, MP.nearPace);
  return { goal: { x: g.x, y: g.y, px: p.x, py: p.y }, ok };
}

/** Is MP hull `vid` at its spot for `goal` (there and halted, or held up close to the point)? */
export function mpThere(ctx: SimContext, state: SimState, vid: EntityId, goal: { x: number; y: number; px: number; py: number }): boolean {
  const MP = ctx.catalog.prisoners!.mp!;
  const v = state.vehicle.req(vid), t = state.transform.req(vid);
  const dP = hypot2(t.x - goal.px, t.y - goal.py);
  if ((dP <= MP.standM + 10 && v.drive.arrived) || hypot2(t.x - goal.x, t.y - goal.y) <= 4) return true;
  return dP <= HELD_UP_NEAR_M && (v.drive.stuckTicks > 0 || v.drive.replans >= 2) && Math.abs(v.drive.speed) < 0.5;
}

/** At the point: halted; it takes over the guard, its men (all but the driver) get out. */
function arrive(ctx: SimContext, state: SimState, events: EventSink, vid: EntityId, v: VehicleState, pid: EntityId): void {
  const o = v.offMap!;
  vehicleHalt(state, vid);
  o.phase = "loading"; o.mpStep = "out"; o.arriveTick = state.tick; o.lastLoadTick = state.tick; o.taken ??= 0;
  emit(state, events, vid, v, "arrived");
  if (o.unit !== undefined) radio(state, events, o.unit, "radio.mpArrived");
  mpTakeOver(ctx, state, events, pid, vid);
  const def = ctx.catalog.vehicles[v.def]!;
  const exits = Math.max(1, def.ramp.exits.length);
  for (let k = 0; k < v.seats.length; k++) {
    const m = v.seats[k];
    if (m === null || m === undefined || def.seats[k]!.station === "driver" || def.seats[k]!.station === "passenger") continue;
    const s = state.soldier.get(m);
    if (!isAble(s) || !s!.impair.canWalk) continue;
    interruptAction(state, events, m, "getOut");
    getOut(ctx, state, m, vid, k % exits, events);
  }
}

function stepLoading(ctx: SimContext, state: SimState, events: EventSink, vid: EntityId, v: VehicleState, MP: MpDef): void {
  const o = v.offMap!, tick = state.tick;
  const pid = o.point!, p = state.rear.get(pid);
  const men = outsideMen(ctx, state, v);
  const dr = door(ctx, state, vid, v);
  if (o.mpStep === "out" && p) {
    // Its men stand guard over the prisoners (at the guards' places).
    men.forEach((m, k) => {
      const at = guardSpot(ctx, p, k);
      const tm = state.transform.req(m);
      if (state.mover.get(m) && hypot2(tm.x - at.x, tm.y - at.y) > 3 && !headingFor(state, m, at.x, at.y, 1)) walkTo(ctx, state, m, at.x, at.y, false);
    });
    const b = o.boarding;
    if (b) {
      const ps = state.soldier.get(b.prisoner);
      if (!ps || !heldPrisoner(ps) || ps.captive!.point !== pid || !walks(state, ps) || ticksToSeconds(tick - b.sinceTick) > BOARD_GIVE_UP_S) {
        if (ps?.captive) delete ps.captive.vehicle;
        delete o.boarding;
      } else if (b.doneTick === undefined) {
        const tp = state.transform.req(b.prisoner);
        if (atHull(ctx, state, vid, v, tp, dr)) { halt(state, b.prisoner); b.doneTick = tick + secondsToTicks(MP.loadS); }
        else if (!headingFor(state, b.prisoner, dr.x, dr.y, 1)) walkTo(ctx, state, b.prisoner, dr.x, dr.y, true);
        return;
      } else if (tick >= b.doneTick) {
        const seat = freePassengerSeat(ctx, v);
        if (seat >= 0) {
          seatIn(state, ctx.catalog.vehicles[v.def]!, vid, seat, b.prisoner, events);
          ps.captive!.vehicle = vid;
          o.taken = (o.taken ?? 0) + 1; o.lastLoadTick = tick;
          events.emit({ kind: "pow.boarded", tick, soldier: b.prisoner, side: state.identity.req(b.prisoner).side, by: v.side, vehicle: vid, group: ps.captive!.group ?? "man" });
        } else delete ps.captive!.vehicle;
        delete o.boarding;
      } else return;
    }
    // The next: officers first, then NCOs, then men; while it has a seat free.
    const next = freePassengerSeat(ctx, v) >= 0 ? boardable(ctx, state, pid)[0] : undefined;
    if (next !== undefined) {
      state.soldier.req(next).captive!.vehicle = vid;
      o.boarding = { prisoner: next, sinceTick: tick };
      walkTo(ctx, state, next, dr.x, dr.y, true);
      return;
    }
    const full = freePassengerSeat(ctx, v) < 0;
    const stay = ticksToSeconds(tick - (o.arriveTick ?? tick));
    if (!full && stay < MP.heldMaxS && boundFor(state, pid, p.unit)) return;
    o.mpStep = "mount"; o.waitTick = tick;
  }
  // Its men get back in (the seats they had are free: crew seats), then it leaves.
  const def = ctx.catalog.vehicles[v.def]!;
  let waiting = 0;
  for (const m of men) {
    const s = state.soldier.req(m);
    if (!isAble(s) || !s.impair.canWalk) continue;
    const tm = state.transform.req(m);
    if (atHull(ctx, state, vid, v, tm, dr)) {
      let seat = def.seats.findIndex((q, i) => q.station !== "passenger" && q.station !== "driver" && v.seats[i] === null);
      if (seat < 0) seat = freePassengerSeat(ctx, v);
      if (seat >= 0) { seatIn(state, def, vid, seat, m, events); continue; }
    } else if (!headingFor(state, m, dr.x, dr.y, 1)) walkTo(ctx, state, m, dr.x, dr.y, false);
    waiting++;
  }
  if (waiting > 0 && ticksToSeconds(tick - (o.waitTick ?? tick)) < MOUNT_WAIT_S) return;
  leave(ctx, state, events, vid, v, MP);
}

function leave(ctx: SimContext, state: SimState, events: EventSink, vid: EntityId, v: VehicleState, MP: MpDef): void {
  const o = v.offMap!;
  const p = o.point !== undefined ? state.rear.get(o.point) : undefined;
  if (p?.mp === vid) delete p.mp;
  delete o.boarding; delete o.mpStep;
  o.phase = "outbound"; o.departTick = state.tick;
  const n = prisonersAboard(state, v).length;
  emit(state, events, vid, v, "departed", { aboard: n });
  if (o.unit !== undefined) radio(state, events, o.unit, "radio.mpLeaving", { n });
  // (It backs straight away from the point first — far enough that turning for home never sweeps through the men
  // there —, then drives off.)
  const t = state.transform.req(vid), e = o.entry!;
  let ok = false;
  if (p && cos(t.heading) * (p.x - t.x) + sin(t.heading) * (p.y - t.y) > 0) {
    const bx = t.x - cos(t.heading) * BACK_OFF_M, by = t.y - sin(t.heading) * BACK_OFF_M;
    if (bx > 2 && by > 2 && bx < ctx.map.widthM - 2 && by < ctx.map.heightM - 2) ok = vehicleMove(ctx, state, vid, [{ x: bx, y: by, mode: MP.nearPace, reverse: true }, { x: e.x, y: e.y, mode: MP.pace }], undefined) === true;
  }
  if (!ok && !backAwayAndGo(ctx, state, vid, p, e, MP.pace, MP.nearPace)) emit(state, events, vid, v, "noRoute");
  o.retryTick = state.tick + secondsToTicks(MP.retryS);
}

/** Off the map: the prisoners aboard are evacuated; ready again `backS` later with its seats free. */
function offTheMap(ctx: SimContext, state: SimState, events: EventSink, vid: EntityId, v: VehicleState): void {
  const MP = ctx.catalog.prisoners!.mp!;
  const o = v.offMap!;
  const aboard = prisonersAboard(state, v);
  for (const m of aboard) {
    const s = state.soldier.req(m), c = s.captive!;
    c.evacTick = state.tick;
    const wounded = s.wounds.length > 0;
    events.emit({ kind: "pow.evacuated", tick: state.tick, soldier: m, side: state.identity.req(m).side, by: v.side, vehicle: vid, group: c.group ?? "man", wounded });
    if (wounded && hasBattleWound(s)) handOver(ctx, state, events, m, "captor", state.tick);
  }
  o.phase = "away"; o.leftTick = state.tick; o.backTick = state.tick + secondsToTicks(MP.backS);
  delete o.goal; delete o.retryTick;
  parkOffMap(state, vid);
  // (The evacuated men's places are free for its next run; they stay aboard it off the map: their mount points at it.)
  for (let k = 0; k < v.seats.length; k++) { const m = v.seats[k]; if (m !== null && m !== undefined && aboard.includes(m)) v.seats[k] = null; }
  if (v.unit !== null) { const u = state.unit.get(v.unit); if (u) u.moving = false; }
  emit(state, events, vid, v, "away", { aboard: aboard.length });
}

/** Stranded on the map: an ordinary hull from now on; its prisoners get out and wait at their point again. */
function strand(ctx: SimContext, state: SimState, events: EventSink, vid: EntityId, v: VehicleState, o: OffMapAsset): void {
  const p = o.point !== undefined ? state.rear.get(o.point) : undefined;
  if (p?.mp === vid) delete p.mp;
  const b = o.boarding;
  if (b) { const c = state.soldier.get(b.prisoner)?.captive; if (c && c.evacTick === undefined && state.soldier.get(b.prisoner)?.mount === undefined) delete c.vehicle; }
  delete o.boarding; delete o.mpStep;
  o.phase = "lost";
  emit(state, events, vid, v, "lost");
  const def = ctx.catalog.vehicles[v.def]!;
  if (v.status === "destroyed") return;
  const exits = Math.max(1, def.ramp.exits.length);
  for (const m of prisonersAboard(state, v)) {
    const s = state.soldier.req(m);
    if (!s.physiology.alive) continue;
    getOut(ctx, state, m, vid, 0 % exits, events);
    delete s.captive!.vehicle;
  }
}
