/**
 * RECONNAISSANCE QUADCOPTERS (M9.4a, SPEC 6.7 "small reconnaissance quadcopters": a unit item with battery life, an
 * operator who is busy while flying, a video feed that creates contacts).
 *
 * The drone is an item (`ItemTypeDef.drone`, the airframe) carried with its batteries (counted items with a charge
 * in Wh, rule 9) by a man of the platoon headquarters (owner M9 round). Ordered to fly (`drone` order, op "fly"),
 * he launches it (`launchSeconds`, an action); the airframe and the fullest battery move into the drone's own
 * container and the drone becomes an entity with a Transform (z: height above the ground). While it is up he flies
 * it (the action "flyDrone"): he does not fire, throw or move (systems that see an action leave him be), and the
 * drone's cameras search the ground under it (spotting.ts `droneScan`); what they see he passes on over the radio
 * with the usual delay (owner M9 round; contacts.ts `droneFeed`).
 *
 * Flight: it climbs to its height, flies straight to the point it was sent to at its cruise speed (not beyond its
 * control range from its operator) and hovers there. The battery drains at `powerW`; when what is left is just
 * enough to come home with `reserveShare` to spare, it comes home on its own ("battery low"); empty, it falls and is
 * lost. Ordered home (op "home"), it flies back to its operator, lands and is recovered into his load (the battery
 * with what charge is left). If its operator is hit or busy with something else, another able man of his unit
 * within reach of the controller takes it over; with nobody for `ALONE_HOME_SECONDS` it comes home on its own, and
 * if nobody is there when it lands it is lost.
 *
 * Seen, heard and shot at, AI use (M9.4b) and the observer of fire (M9.5) come later.
 */
import { onAir } from "../comms";
import { registerActionHandler, startAction } from "../actions";
import type { DroneState } from "../components";
import type { SimContext } from "../context";
import type { DroneDef } from "../catalog";
import type { EventSink } from "../events";
import { secondsToTicks, TICK_HZ, type EntityId } from "../ids";
import { isAble } from "../impair";
import { emptyContainer, transferItems, type Container } from "../items";
import { fullestSpare } from "../power";
import { atan2, exp, PI, sqrt } from "../math";
import { nextFloat, Streams } from "../rng";
import { heightAt } from "../terrain";
import { newEntity, type SimState } from "../state";
import { isCowering } from "./morale";

/** Seconds a drone without an operator hovers before it comes home on its own. */
const ALONE_HOME_SECONDS = 30;
/** How far from the controller another man can be to take it over (m), and how near its landing point a man must
 *  be to recover a drone that lands without an operator. */
const TAKE_OVER_M = 30;
/** Horizontal distance at which it is over its goal or home (m). */
const ARRIVE_M = 2;
/** The action a man flying a drone is busy with (its duration is open-ended: it ends when the drone lands). */
export const FLY_ACTION = "flyDrone";
const LAUNCH_ACTION = "launchDrone";
const OPEN_ENDED_TICKS = 1e9;

/** The drone definition of an item, if it is a quadcopter. */
export function droneDefOf(ctx: SimContext, item: string): DroneDef | undefined {
  return ctx.catalog.items[item]?.drone;
}

/** The airframe a man carries (the first quadcopter item in his load), if any. */
function airframeOf(ctx: SimContext, box: Container | undefined): string | undefined {
  if (!box) return undefined;
  for (const st of box.stacks) if (st.count > 0 && ctx.catalog.items[st.type]?.drone !== undefined) return st.type;
  return undefined;
}

/** Wh of the fullest battery of this type in a container (0: none). (M11.6: the shared battery helper.) */
function bestCharge(box: Container | undefined, battery: string): number {
  return Math.max(0, fullestSpare(box, battery));
}

/** The drone's battery stack (in its own container). */
function batteryStack(ctx: SimContext, state: SimState, id: EntityId, d: DroneState): { charge?: number } | undefined {
  const def = droneDefOf(ctx, d.item);
  return def ? state.container.get(id)?.stacks.find((s) => s.type === def.battery) : undefined;
}

/** Wh left in a drone's battery. */
export function droneChargeWh(ctx: SimContext, state: SimState, id: EntityId): number {
  const d = state.drone.get(id);
  return d ? batteryStack(ctx, state, id, d)?.charge ?? 0 : 0;
}

/** The men of a unit who could fly its drone: its own members (the headquarters of a platoon), not sub-units. */
function crewOf(state: SimState, unit: EntityId): EntityId[] {
  return state.unit.get(unit)?.members ?? [];
}

/** The unit an order target means: a unit, or a man's unit. */
function unitOfTarget(state: SimState, target: EntityId): EntityId | null {
  if (state.unit.has(target)) return target;
  return state.identity.get(target)?.unit ?? null;
}

/** The drone of a unit in the air, if any (ID order). */
export function airborneDroneOf(state: SimState, unit: EntityId): EntityId | null {
  for (const [id, d] of state.drone.entries()) if (d.unit === unit) return id;
  return null;
}

/** A man of the unit who can launch its drone now: able, on foot, carrying an airframe and a battery with charge
 *  above the reserve. The order's target first, then the unit's members in ID order. */
function launcherOf(ctx: SimContext, state: SimState, target: EntityId, unit: EntityId): EntityId | null {
  const men = state.soldier.has(target) ? [target, ...crewOf(state, unit).filter((m) => m !== target)] : crewOf(state, unit);
  for (const m of men) {
    const s = state.soldier.get(m);
    if (!s || !isAble(s) || s.mount !== undefined) continue;
    const box = state.container.get(m), item = airframeOf(ctx, box);
    const def = item === undefined ? undefined : droneDefOf(ctx, item);
    const cap = def ? ctx.catalog.items[def.battery]?.chargeCapacity ?? 0 : 0;
    if (def && bestCharge(box, def.battery) > def.reserveShare * cap) return m;
  }
  return null;
}

/** The man who would launch the unit's drone once out of his vehicle (a drone order with `dismount`): null if the
 *  drone is up or someone on foot can launch it; else an able man aboard carrying an airframe and a battery with
 *  charge above the reserve (the order's target first, then the unit's members in ID order). */
export function droneRiderOf(ctx: SimContext, state: SimState, target: EntityId): EntityId | null {
  const unit = unitOfTarget(state, target);
  if (unit === null || airborneDroneOf(state, unit) !== null || launcherOf(ctx, state, target, unit) !== null) return null;
  const men = state.soldier.has(target) ? [target, ...crewOf(state, unit).filter((m) => m !== target)] : crewOf(state, unit);
  for (const m of men) {
    const s = state.soldier.get(m);
    if (!s || !isAble(s) || s.mount === undefined || !s.impair.canWalk) continue;
    const box = state.container.get(m), item = airframeOf(ctx, box);
    const def = item === undefined ? undefined : droneDefOf(ctx, item);
    const cap = def ? ctx.catalog.items[def.battery]?.chargeCapacity ?? 0 : 0;
    if (def && bestCharge(box, def.battery) > def.reserveShare * cap) return m;
  }
  return null;
}

/** Whether a unit (or a man) has a drone to order: one in the air or one that could be launched. */
export function hasDrone(ctx: SimContext, state: SimState, target: EntityId): boolean {
  const unit = unitOfTarget(state, target);
  if (unit === null) return false;
  if (airborneDroneOf(state, unit) !== null) return true;
  const men = state.soldier.has(target) ? [target] : crewOf(state, unit);
  return men.some((m) => airframeOf(ctx, state.container.get(m)) !== undefined);
}

/** A `drone` order (M9.4a): "fly" sends the unit's drone to (x, y) (launching it first if it is on the ground),
 *  "home" brings it back to land. Returns false if nothing can be done. */
export function droneOrder(ctx: SimContext, state: SimState, events: EventSink, target: EntityId, op: "fly" | "home", x?: number, y?: number, altM?: number): boolean {
  const unit = unitOfTarget(state, target);
  if (unit === null) return false;
  const id = airborneDroneOf(state, unit);
  if (id !== null) {
    const d = state.drone.req(id), def = droneDefOf(ctx, d.item);
    if (!def) return false;
    if (op === "home") { d.mode = "home"; d.goal = null; return true; }
    if (d.low === true || x === undefined || y === undefined) return false; // coming home on a low battery
    d.goal = { x, y };
    if (altM !== undefined) d.altGoal = Math.min(def.maxAltitudeM, Math.max(def.minAltitudeM, altM));
    if (d.mode !== "climb") d.mode = "fly";
    return true;
  }
  if (op === "home" || x === undefined || y === undefined) return false;
  const man = launcherOf(ctx, state, target, unit);
  if (man === null) return false;
  const def = droneDefOf(ctx, airframeOf(ctx, state.container.get(man))!)!;
  const mv = state.mover.get(man);
  if (mv) { mv.waypoints = []; mv.speedMps = 0; }
  startAction(state, events, man, LAUNCH_ACTION, secondsToTicks(def.launchSeconds), { x, y, alt: altM ?? def.altitudeM, unit });
  return true;
}

/** The launch (an action of `launchSeconds`): the airframe and the fullest battery leave his load; the drone rises
 *  from where he stands, and he flies it. */
registerActionHandler(LAUNCH_ACTION, {
  check(ctx, state, actor) {
    const s = state.soldier.get(actor);
    if (!s || !isAble(s) || s.mount !== undefined) return "unable";
    return airframeOf(ctx, state.container.get(actor)) === undefined ? "no-drone" : null;
  },
  complete(ctx, state, actor, a, events) {
    const box = state.container.get(actor), t = state.transform.get(actor), side = state.identity.get(actor)?.side;
    const item = airframeOf(ctx, box), def = item === undefined ? undefined : droneDefOf(ctx, item);
    if (!box || !t || side === undefined || !item || !def) return;
    const charge = bestCharge(box, def.battery);
    if (charge <= 0) return;
    const id = newEntity(state);
    state.container.set(id, emptyContainer());
    // (M11.6, rule 9: the airframe and the battery move with the one generic transfer.)
    transferItems(ctx.catalog, state.container, { from: actor, to: id, type: item, count: 1 });
    transferItems(ctx.catalog, state.container, { from: actor, to: id, type: def.battery, count: 1, charge });
    state.transform.set(id, { x: t.x, y: t.y, z: 0, heading: t.heading });
    const gx = Number(a.params["x"]), gy = Number(a.params["y"]);
    const alt = Math.min(def.maxAltitudeM, Math.max(def.minAltitudeM, Number(a.params["alt"])));
    state.drone.set(id, { side, unit: Number(a.params["unit"]), item, operator: actor, mode: "climb", goal: { x: gx, y: gy }, altGoal: alt, homeX: t.x, homeY: t.y, seen: [] });
    startAction(state, events, actor, FLY_ACTION, OPEN_ENDED_TICKS, { drone: id });
    events.emit({ kind: "drone.launched", tick: state.tick, drone: id, operator: actor, side, item, wh: charge });
    radio(state, events, actor, "radio.droneUp");
  },
});

/** Flying it: lasts while the drone is up (it ends when the drone lands or is lost). */
registerActionHandler(FLY_ACTION, {
  check(_ctx, state, actor, a) {
    const d = state.drone.get(Number(a.params["drone"]));
    return d && d.operator === actor ? null : "landed";
  },
  complete() { /* open-ended: never reached while the drone is up */ },
});

function radio(state: SimState, events: EventSink, from: EntityId, key: string): void {
  const ident = state.identity.get(from);
  if (!ident || !onAir(state, ident.unit)) return; // (M11.6: a flat radio sends nothing)
  const callsign = state.unit.get(ident.unit)?.callsign ?? "";
  events.emit({ kind: "radio", tick: state.tick, side: ident.side, from, key, params: { callsign } });
}

/** Whether `m` is flying drone `id` right now. */
function flying(state: SimState, m: EntityId, id: EntityId): boolean {
  const a = state.action.get(m);
  return a !== undefined && a.kind === FLY_ACTION && Number(a.params["drone"]) === id;
}

/** Take a drone off the map: recovered into `into`'s load, or lost. */
function endDrone(ctx: SimContext, state: SimState, events: EventSink, id: EntityId, d: DroneState, into: EntityId | null, reason: "battery" | "noOperator" | "shot" | null): void {
  const box = state.container.get(id);
  const battery = droneDefOf(ctx, d.item)?.battery;
  const wh = box?.stacks.find((x) => x.type === battery)?.charge;
  // (M11.6, rule 9: recovered through the one generic transfer; a man's load has no mass limit.)
  if (into !== null && box && state.container.has(into)) {
    for (const st of box.stacks.map((x) => ({ ...x }))) transferItems(ctx.catalog, state.container, { from: id, to: into, type: st.type, count: st.count, ...(st.charge !== undefined ? { charge: st.charge } : {}) });
  }
  if (d.operator !== null && flying(state, d.operator, id)) state.action.delete(d.operator);
  state.drone.delete(id);
  state.container.delete(id);
  state.transform.delete(id);
  if (into !== null) {
    events.emit({ kind: "drone.landed", tick: state.tick, drone: id, side: d.side, by: into, ...(wh !== undefined ? { wh } : {}) });
    radio(state, events, into, "radio.droneLanded");
  } else {
    events.emit({ kind: "drone.lost", tick: state.tick, drone: id, side: d.side, reason: reason ?? "noOperator", ...(reason === "shot" && d.hitBy !== undefined ? { by: d.hitBy } : {}) });
    const lead = d.operator ?? state.unit.get(d.unit)?.members.find((m) => isAble(state.soldier.get(m)));
    if (lead !== undefined) radio(state, events, lead, "radio.droneLost");
  }
}

/** Keep someone flying it: its operator again once he is free, or another able man of its unit near the controller. */
function keepOperator(state: SimState, events: EventSink, id: EntityId, d: DroneState): void {
  const tick = state.tick;
  if (d.operator !== null) {
    const s = state.soldier.get(d.operator);
    if (s && isAble(s) && s.mount === undefined) {
      if (flying(state, d.operator, id)) { delete d.aloneSince; return; }
      // Busy with something else (taking cover, treated): he picks the controller up again when he is free.
      if (!state.action.has(d.operator) && !isCowering(s)) { startAction(state, events, d.operator, FLY_ACTION, OPEN_ENDED_TICKS, { drone: id }); delete d.aloneSince; return; }
      d.aloneSince ??= tick;
      return;
    }
    // Hit, captive or aboard: another man of the unit near him takes the controller.
    const at = state.transform.get(d.operator);
    d.operator = null;
    d.aloneSince ??= tick;
    if (at) { d.homeX = at.x; d.homeY = at.y; }
  }
  d.aloneSince ??= tick;
  for (const m of crewOf(state, d.unit)) {
    const s = state.soldier.get(m), t = state.transform.get(m);
    if (!s || !t || !isAble(s) || s.mount !== undefined || state.action.has(m) || isCowering(s)) continue;
    if ((t.x - d.homeX) * (t.x - d.homeX) + (t.y - d.homeY) * (t.y - d.homeY) > TAKE_OVER_M * TAKE_OVER_M) continue;
    d.operator = m;
    delete d.aloneSince;
    startAction(state, events, m, FLY_ACTION, OPEN_ENDED_TICKS, { drone: id });
    return;
  }
}

/** Every tick: operator, battery, flight, landing. */
export function droneSystem(ctx: SimContext, state: SimState, events: EventSink): void {
  if (state.drone.size === 0) return;
  const dt = 1 / TICK_HZ, tick = state.tick;
  for (const [id, d] of state.drone.toEntries()) {
    const def = droneDefOf(ctx, d.item), t = state.transform.get(id);
    if (!def || !t) continue;
    // Hit (M9.4b): it falls when the round that hit it gets there.
    if (d.hitTick !== undefined && tick >= d.hitTick) {
      if (d.hitBy !== undefined && isAble(state.soldier.get(d.hitBy))) radio(state, events, d.hitBy, "radio.droneDown");
      endDrone(ctx, state, events, id, d, null, "shot");
      continue;
    }
    keepOperator(state, events, id, d);
    // Its operator stands still while he flies it.
    if (d.operator !== null) {
      const mv = state.mover.get(d.operator);
      if (mv && mv.waypoints.length > 0) mv.holdUntilTick = tick + 1;
      const ot = state.transform.get(d.operator);
      if (ot) { d.homeX = ot.x; d.homeY = ot.y; }
    } else if (d.mode !== "home" && d.aloneSince !== undefined && tick - d.aloneSince >= secondsToTicks(ALONE_HOME_SECONDS)) {
      d.mode = "home"; d.goal = null;
    }
    // The battery.
    const bat = batteryStack(ctx, state, id, d);
    const charge = (bat?.charge ?? 0) - (def.powerW * dt) / 3600;
    if (bat) bat.charge = Math.max(0, charge);
    if (charge <= 0) { endDrone(ctx, state, events, id, d, null, "battery"); continue; }
    const hx = d.homeX - t.x, hy = d.homeY - t.y, home = sqrt(hx * hx + hy * hy);
    const cap = ctx.catalog.items[def.battery]?.chargeCapacity ?? 0;
    const need = ((home / def.cruiseMps + t.z / def.climbMps) * def.powerW) / 3600 + def.reserveShare * cap;
    if (charge <= need && d.low !== true) {
      d.low = true; d.mode = "home"; d.goal = null;
      if (d.operator !== null) radio(state, events, d.operator, "radio.droneLow");
    }
    // Height.
    const climb = def.climbMps * dt;
    if (d.mode === "home" && home <= ARRIVE_M) {
      t.z = Math.max(0, t.z - climb);
      if (t.z <= 0) { landHome(ctx, state, events, id, d); }
      continue;
    }
    if (t.z < d.altGoal) t.z = Math.min(d.altGoal, t.z + climb); else if (t.z > d.altGoal) t.z = Math.max(d.altGoal, t.z - climb);
    if (d.mode === "climb") {
      if (t.z >= d.altGoal - 0.01) d.mode = d.goal ? "fly" : "hover";
      continue;
    }
    // Across the ground: to its goal, or home.
    const tx = d.mode === "home" ? d.homeX : d.goal?.x, ty = d.mode === "home" ? d.homeY : d.goal?.y;
    if (tx === undefined || ty === undefined || d.mode === "hover") continue;
    const dx = tx - t.x, dy = ty - t.y, dist = sqrt(dx * dx + dy * dy);
    if (dist <= ARRIVE_M) { if (d.mode === "fly") d.mode = "hover"; continue; }
    const step = Math.min(dist, def.cruiseMps * dt);
    const nx = t.x + (dx / dist) * step, ny = t.y + (dy / dist) * step;
    // Not beyond its control range from its operator (it stops at the edge and hovers).
    if (d.mode === "fly" && d.operator !== null) {
      const ox = nx - d.homeX, oy = ny - d.homeY;
      if (ox * ox + oy * oy > def.controlRangeM * def.controlRangeM) { d.mode = "hover"; continue; }
    }
    t.x = Math.min(Math.max(nx, 0), ctx.map.widthM); t.y = Math.min(Math.max(ny, 0), ctx.map.heightM);
    t.heading = atan2(dy, dx);
  }
}

/** Landed at home: into its operator's load, or the nearest able man of its unit there; else it is lost. */
function landHome(ctx: SimContext, state: SimState, events: EventSink, id: EntityId, d: DroneState): void {
  let into: EntityId | null = d.operator;
  if (into === null) {
    let best = TAKE_OVER_M * TAKE_OVER_M;
    for (const m of crewOf(state, d.unit)) {
      const s = state.soldier.get(m), t = state.transform.get(m);
      if (!s || !t || !isAble(s) || s.mount !== undefined) continue;
      const q = (t.x - d.homeX) * (t.x - d.homeX) + (t.y - d.homeY) * (t.y - d.homeY);
      if (q <= best) { best = q; into = m; }
    }
  }
  endDrone(ctx, state, events, id, d, into, into === null ? "noOperator" : null);
}

/**
 * Hit boxes (M9.4b; the hook for M14's attack drones): the chance that one round aimed at (ax, ay, az) hits drone
 * `id`, fired from (fx, fy, fz) with a total spread of `spreadRad` (aim and the weapon's dispersion, one standard
 * deviation; `aerialAimMrad` is added for firing up at it) at muzzle velocity `v0`. Its area over the spread at
 * that range (a round normal spread), less the
 * shooter's misjudged lead on a drone that moves (`leadErrorShare` of its travel during the flight) and the distance
 * between where he aims and where it is; at most `maxHitChance`.
 */
export function droneHitChance(ctx: SimContext, state: SimState, id: EntityId, fx: number, fy: number, fz: number, ax: number, ay: number, az: number, spreadRad: number, v0: number): number {
  const d = state.drone.get(id), t = state.transform.get(id), DR = ctx.catalog.spotting.drone;
  const def = d ? droneDefOf(ctx, d.item) : undefined;
  if (!d || !t || !def || !DR || v0 <= 0) return 0;
  const tz = heightAt(ctx.map, t.x, t.y) + t.z; // ground: ok (a drone flies its height over the ground)
  const dx = t.x - fx, dy = t.y - fy, dz = tz - fz, slant = sqrt(dx * dx + dy * dy + dz * dz);
  const moving = d.mode === "fly" || d.mode === "home" ? def.cruiseMps : d.mode === "climb" ? def.climbMps : 0;
  const lead = moving * (slant / v0) * DR.leadErrorShare;
  const aim = DR.aerialAimMrad / 1000;
  const spread2 = spreadRad * spreadRad + aim * aim;
  const sigma2 = spread2 * slant * slant + lead * lead + 0.01;
  const ox = ax - t.x, oy = ay - t.y, oz = az - tz, off2 = ox * ox + oy * oy + oz * oz;
  return Math.min(DR.maxHitChance, def.areaM2 / (2 * PI * sigma2)) * exp(-off2 / (2 * sigma2));
}

/** A round fired at drone `id` (M9.4b): one draw against its hit chance x `killShare` (not every hit downs it); such
 *  a hit brings it down when the round gets there (`droneSystem`). */
export function shootAtDrone(ctx: SimContext, state: SimState, id: EntityId, by: EntityId, fx: number, fy: number, fz: number, ax: number, ay: number, az: number, spreadRad: number, v0: number): void {
  const p = droneHitChance(ctx, state, id, fx, fy, fz, ax, ay, az, spreadRad, v0) * (ctx.catalog.spotting.drone?.killShare ?? 1);
  const u = nextFloat(state.rng, Streams.fire);
  const d = state.drone.get(id), t = state.transform.get(id);
  if (!d || !t || u >= p || d.hitTick !== undefined) return;
  const slant = sqrt((t.x - fx) * (t.x - fx) + (t.y - fy) * (t.y - fy) + (az - fz) * (az - fz));
  d.hitTick = state.tick + Math.max(1, Math.round((slant / v0) * TICK_HZ));
  d.hitBy = by;
}

/** How recently a man must have seen an enemy drone to fire at it (s): men look for drones every fourth scan, as for
 *  vehicles, so the window is wider than for men (M9.4b). */
export const DRONE_SEEN_S = 6;

/** Where a man sees an enemy drone now (M9.4b): its place and height above the ground, if it is in his `seen` within
 *  `withinTicks`. */
export function droneInSight(state: SimState, man: EntityId, id: EntityId, withinTicks: number): { x: number; y: number; z: number } | null {
  const s = state.soldier.get(man), t = state.transform.get(id);
  if (!s || !t || !state.drone.has(id)) return null;
  const e = s.seen.find((x) => x.target === id);
  return e && state.tick - e.lastTick <= withinTicks ? { x: t.x, y: t.y, z: t.z } : null;
}
