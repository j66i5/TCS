/**
 * FIELD REPAIR (M11.7a, SPEC 6.7 "crew react", owner M11 round: "crews fix light damage with parts and time").
 *
 * A crew drill, the same for both sides: once a second each damaged hull with its crew aboard, halted, not burning
 * and quiet (not hit for `quietS`, its crew not under fire for `underFireS`, for work outside no enemy known to its
 * side within `enemyNearM`) starts the next task `repairTaskFor` gives (core/repair.json: a broken track, a holed
 * wheel side, the coaxial machine gun, the radio). The men (`freeRepairMen`) keep their seats but are busy with the
 * open-ended action `repairOutside` (on the ground beside the hull, exposed like men on foot: mount.ts `onRoof`) or
 * `repairInside` (under armour, off their stations). Each pass adds their work (`workRate` x the step) until the
 * task's man-minutes are done; then the parts are taken out of the hull's container (`removeItems`, rule 9) and the
 * component is back at `restoreTo` (with the task's chance; a failed task leaves it beyond the crew), and the hull's
 * status is worked out again (`recomputeStatus`: immobilised -> ok or disarmed). A hit on the hull, fire on the crew
 * (outside), suppression, a fire, the crew bailing out or the hull moving stops the work; the progress and the parts
 * are kept and the work resumes after the quiet period. The player's `repair` order skips the quiet period (not a
 * hit in the last `orderHitS`). Off: no core/repair.json or `rules.repair === false`.
 */
import { interruptAction, registerActionHandler, startAction } from "../actions";
import type { Action, VehicleState } from "../components";
import type { SimContext } from "../context";
import type { EventSink } from "../events";
import { secondsToTicks, type EntityId, type SideId } from "../ids";
import { isAble } from "../impair";
import { removeItems } from "../items";
import { sideKnowledge, type KnownEnemy } from "../knowledge";
import { hypot2 } from "../math";
import { isOffMap } from "../offmap";
import { freeRepairMen, repairTaskFor, repairWorkers, workRate, type RepairPick, type RepairRefusal } from "../repair";
import { nextFloat, Streams } from "../rng";
import type { SimState } from "../state";
import type { OrderResult } from "./drive";
import { recomputeStatus } from "./armour";
import { radio } from "./evacuation";

/** The two actions (= mount.ts REPAIR_OUTSIDE / REPAIR_INSIDE; literals here: this module may load before mount.ts
 *  in an import cycle, and the handlers register at load). */
const REPAIR_OUTSIDE = "repairOutside", REPAIR_INSIDE = "repairInside";
/** A repair action runs until the drill ends it (open-ended, like a drone's flight). */
const OPEN_ENDED_TICKS = 1e9;
/** A hull this slow counts as halted. */
const HALTED_MPS = 0.3;

const enabled = (ctx: SimContext) => ctx.catalog.repair !== undefined && ctx.rules.repair !== false;

/** Why a man at work on the hull stops now (the action's check), or null. */
function stopWhy(ctx: SimContext, state: SimState, actor: EntityId, a: Action, outside: boolean): string | null {
  const vid = Number(a.params["vehicle"]), v = state.vehicle.get(vid), s = state.soldier.get(actor);
  if (!v || v.status === "destroyed" || v.status === "abandoned" || isOffMap(v)) return "unable";
  if (v.fire !== null) return "burning";
  if (v.crewReaction === "bailOut") return "bailOut";
  if (!s || !isAble(s) || s.mount?.vehicle !== vid || !s.impair.canUseArms) return "unable";
  if (!v.repair || v.repair.comp !== Number(a.params["comp"])) return "unable";
  if (Math.abs(v.drive.speed) > HALTED_MPS) return "moving";
  if (v.lastHitTick >= a.startTick) return "hit";
  if (outside) {
    const R = ctx.catalog.repair!;
    if (s.mental.suppression > R.suppressionStop) return "underFire";
    const u = v.unit === null ? undefined : state.unit.get(v.unit);
    if (u !== undefined && u.underFireTick > a.startTick) return "underFire";
  }
  return null;
}

for (const [kind, outside] of [[REPAIR_OUTSIDE, true], [REPAIR_INSIDE, false]] as const) {
  registerActionHandler(kind, {
    check(ctx, state, actor, a) {
      const why = stopWhy(ctx, state, actor, a, outside);
      if (why !== null) { const v = state.vehicle.get(Number(a.params["vehicle"])); if (v?.repair && v.repair.stopWhy === undefined) v.repair.stopWhy = why; }
      return why;
    },
    complete() { /* open-ended: the drill ends it */ },
  });
}

/** Can this crew work at its hull at all now (aboard, halted, not burning, not bailing out)? */
function canWork(v: VehicleState): boolean {
  return v.unit !== null && v.fire === null && v.crewReaction !== "bailOut" && v.status !== "destroyed" && v.status !== "abandoned" && v.towedBy === undefined
    && Math.abs(v.drive.speed) <= HALTED_MPS && (v.drive.arrived || v.drive.route.length === 0);
}

function partKey(kind: string): string { return `vehicle.comp.${kind}`; }

/** Sum of the work rates of the given seats' men. */
function rateOf(ctx: SimContext, state: SimState, v: VehicleState, def: NonNullable<ReturnType<typeof defOf>>, seats: number[]): number {
  let r = 0;
  for (const k of seats) r += workRate(ctx.catalog, state.soldier.get(v.seats[k]!), def.seats[k]!.station);
  return r;
}
const defOf = (ctx: SimContext, v: VehicleState) => ctx.catalog.vehicles[v.def];

/** Put the chosen men to work (their action, a crouch outside). */
function setToWork(state: SimState, events: EventSink, vid: EntityId, v: VehicleState, pick: RepairPick, seats: number[], slot0: number): void {
  const kind = pick.task.outside ? REPAIR_OUTSIDE : REPAIR_INSIDE;
  seats.forEach((k, i) => {
    const m = v.seats[k]!;
    startAction(state, events, m, kind, OPEN_ENDED_TICKS, { vehicle: vid, comp: pick.k, slot: slot0 + i });
    const s = state.soldier.get(m);
    if (pick.task.outside && s && s.posture !== "crouching") { s.posture = "crouching"; s.postureTo = null; events.emit({ kind: "posture.changed", tick: state.tick, soldier: m, posture: "crouching" }); }
  });
}

/** End the work of every man at this hull (task done, failed or dropped). */
function stopAll(state: SimState, events: EventSink, vid: EntityId, v: VehicleState, why: string): void {
  for (const k of repairWorkers(state, vid, v)) interruptAction(state, events, v.seats[k]!, why);
}

/**
 * Start (or resume) the hull's next task now if men are free, the quiet rule (or the player's order) allows it.
 * Returns the refusal for the order path, or null when started / waiting for men.
 */
function tryStart(ctx: SimContext, state: SimState, events: EventSink, vid: EntityId, v: VehicleState, near: (side: SideId) => KnownEnemy[], ordered: boolean): RepairRefusal | "quiet" | "busy" | null {
  const R = ctx.catalog.repair!, def = defOf(ctx, v)!, tick = state.tick;
  const pick = repairTaskFor(ctx.catalog, state, vid, v, def);
  if (typeof pick === "string") { if (v.repair) delete v.repair; return pick; }
  if (v.repair && v.repair.comp !== pick.k) delete v.repair; // (that task is done with: a fresh one)
  const isOrdered = ordered || v.repair?.ordered === true;
  if (tick - v.lastHitTick < secondsToTicks(isOrdered ? R.orderHitS : R.quietS)) return "quiet";
  const u = v.unit === null ? undefined : state.unit.get(v.unit);
  if (u !== undefined && tick - u.underFireTick < secondsToTicks(R.underFireS)) return "quiet";
  if (pick.task.outside && !isOrdered) {
    const t = state.transform.req(vid), r2 = R.enemyNearM;
    for (const e of near(v.side)) if (hypot2(e.x - t.x, e.y - t.y) < r2) return "quiet";
  }
  const seats = freeRepairMen(state, v, def, pick.task.outside, pick.task.men);
  if (seats.length === 0) { if (ordered && !v.repair) v.repair = newRepair(state, pick, true); return "busy"; }
  // (Resumed: work had been done on it. A task an order set aside for want of a free man starts here.)
  const resumed = v.repair !== undefined && v.repair.doneManS > 0;
  const rep = v.repair ??= newRepair(state, pick, isOrdered);
  if (ordered) rep.ordered = true;
  rep.working = true; rep.lastWorkTick = tick; delete rep.stopWhy;
  setToWork(state, events, vid, v, pick, seats, 0);
  const etaS = Math.round((rep.needManS - rep.doneManS) / Math.max(0.05, rateOf(ctx, state, v, def, seats)));
  events.emit({ kind: "vehicle.repair", tick, vehicle: vid, component: pick.k, part: pick.kind, phase: resumed ? "resumed" : "started", etaS, ...(rep.ordered ? { ordered: true as const } : {}) });
  if (v.unit !== null && !resumed && !ordered) radio(state, events, v.unit, "radio.vehicleRepairing", { partKey: partKey(pick.kind), min: Math.max(1, Math.round(etaS / 60)) });
  return null;
}

function newRepair(state: SimState, pick: RepairPick, ordered: boolean): NonNullable<VehicleState["repair"]> {
  return { comp: pick.k, needManS: pick.task.manMin * 60, doneManS: 0, startTick: state.tick, lastWorkTick: state.tick, working: false, ...(ordered ? { ordered: true as const } : {}) };
}

/** The task is done: roll its chance, use up its parts, the component back, the status again. */
function finish(ctx: SimContext, state: SimState, events: EventSink, vid: EntityId, v: VehicleState): void {
  const def = defOf(ctx, v)!, rep = v.repair!, k = rep.comp, comp = def.components![k]!;
  const task = ctx.catalog.repair!.tasks[comp.kind]!, parts = def.repair!.parts[comp.kind] ?? [];
  stopAll(state, events, vid, v, "repairDone");
  delete v.repair;
  // Parts are used up either way (a barrel changed on a gun that still does not work); a task that cannot fail
  // never draws (plan B11).
  const c = state.container.get(vid);
  const used: { item: string; count: number }[] = [];
  for (const p of parts) { if (c) removeItems(c, p.item, p.count); used.push({ item: p.item, count: p.count }); }
  const ok = task.chance >= 1 || nextFloat(state.rng, Streams.repair) < task.chance;
  if (!ok) {
    (v.repairBeyond ??= []).push(k);
    events.emit({ kind: "vehicle.repair", tick: state.tick, vehicle: vid, component: k, part: comp.kind, phase: "failed", ...(used.length > 0 ? { parts: used } : {}) });
    if (v.unit !== null) radio(state, events, v.unit, "radio.repairFailed", { partKey: partKey(comp.kind) });
    return;
  }
  v.comp[k] = Math.max(v.comp[k] ?? 0, task.restoreTo);
  recomputeStatus(v, def);
  events.emit({ kind: "vehicle.repair", tick: state.tick, vehicle: vid, component: k, part: comp.kind, phase: "done", status: v.status, ...(used.length > 0 ? { parts: used } : {}) });
  if (v.unit !== null) radio(state, events, v.unit, "radio.vehicleRepaired", { partKey: partKey(comp.kind) });
}

/**
 * The drill, once per `repair.stepS` (after the crews' reactions): work done, tasks finished, work stopped, new or
 * resumed tasks. Returns at once without core/repair.json, with `rules.repair === false` or without vehicles.
 */
export function repairSystem(ctx: SimContext, state: SimState, events: EventSink): void {
  if (state.vehicle.size === 0 || !enabled(ctx)) return;
  const R = ctx.catalog.repair!;
  const every = Math.max(1, secondsToTicks(R.stepS));
  if (state.tick % every !== 0) return;
  const stepS = every / 60;
  const known = new Map<SideId, KnownEnemy[]>();
  // mounted: ok (sideKnowledge lists men on foot and hulls only)
  const near = (side: SideId) => { let k = known.get(side); if (!k) { k = sideKnowledge(ctx, state, side); known.set(side, k); } return k; };
  for (const [vid, v] of state.vehicle.entries()) {
    if (isOffMap(v)) continue;
    const def = defOf(ctx, v);
    if (!def?.repair || !def.components) continue;
    const rep = v.repair;
    if (rep === undefined) {
      let damaged = false;
      for (let k = 0; k < v.comp.length; k++) if (v.comp[k]! < 1) { damaged = true; break; }
      if (!damaged || !canWork(v)) continue;
      tryStart(ctx, state, events, vid, v, near, false);
      continue;
    }
    const seats = repairWorkers(state, vid, v);
    if (seats.length > 0) {
      rep.doneManS += rateOf(ctx, state, v, def, seats) * stepS;
      rep.lastWorkTick = state.tick;
      if (rep.doneManS >= rep.needManS) { finish(ctx, state, events, vid, v); if (canWork(v)) tryStart(ctx, state, events, vid, v, near, false); continue; }
      // A man short (busy when it started, or back from his other task): he joins in.
      const task = R.tasks[def.components[rep.comp]!.kind];
      if (task && seats.length < task.men) {
        const more = freeRepairMen(state, v, def, task.outside, task.men - seats.length);
        if (more.length > 0) setToWork(state, events, vid, v, { k: rep.comp, kind: def.components[rep.comp]!.kind, task, parts: [] }, more, seats.length);
      }
      continue;
    }
    if (rep.working) {
      rep.working = false;
      const why = rep.stopWhy ?? "unable";
      delete rep.stopWhy;
      events.emit({ kind: "vehicle.repair", tick: state.tick, vehicle: vid, component: rep.comp, part: def.components[rep.comp]?.kind ?? "", phase: "interrupted", why });
      if (v.unit !== null) radio(state, events, v.unit, "radio.repairStopped", { partKey: partKey(def.components[rep.comp]?.kind ?? "") });
      // A hit or a bail-out ends an order's urgency only for the quiet rule's hit window (orderHitS), not the order.
      continue;
    }
    if (canWork(v)) tryStart(ctx, state, events, vid, v, near, false);
  }
}

/**
 * The player's `repair` order to a crew unit (plan §4): refused when there is nothing to repair, the parts are
 * missing, it is beyond the crew, the hull was hit within `orderHitS` or is burning; else the task starts now
 * (no waiting for the quiet period), or as soon as a man is free.
 */
export function repairOrder(ctx: SimContext, state: SimState, events: EventSink, vid: EntityId): OrderResult {
  if (!enabled(ctx)) return { unable: "radio.repairNothing" };
  const v = state.vehicle.get(vid), def = v ? defOf(ctx, v) : undefined;
  if (!v || !def || v.unit === null || isOffMap(v)) return "unable";
  if (v.fire !== null) return { unable: "radio.repairBurning" };
  if (v.status === "destroyed" || v.status === "abandoned" || v.crewReaction === "bailOut") return "unable";
  const pick = repairTaskFor(ctx.catalog, state, vid, v, def);
  if (pick === "nothing") return { unable: "radio.repairNothing" };
  if (pick === "noParts") return { unable: "radio.repairNoParts" };
  if (pick === "beyondCrew") return { unable: "radio.repairBeyond" };
  if (state.tick - v.lastHitTick < secondsToTicks(ctx.catalog.repair!.orderHitS)) return { unable: "radio.repairUnderFire" };
  if (v.repair?.working === true && v.repair.comp === pick.k) { v.repair.ordered = true; return true; }
  if (!canWork(v)) return { unable: "radio.repairMoving" };
  // mounted: ok (sideKnowledge lists men on foot and hulls only)
  const r = tryStart(ctx, state, events, vid, v, (side) => sideKnowledge(ctx, state, side), true);
  if (r === "quiet") return { unable: "radio.repairUnderFire" };
  return true;
}

/** A move order to a crew ends its repair (plan §4; the progress is kept): the men get back to their stations. */
export function endRepairByOrder(state: SimState, events: EventSink, vid: EntityId): void {
  const v = state.vehicle.get(vid);
  if (!v?.repair) return;
  if (v.repair.working) v.repair.stopWhy = "ordered";
  delete v.repair.ordered;
  stopAll(state, events, vid, v, "ordered");
}
