/**
 * OFF-MAP ENTITY STATE (M10.6a; SPEC 9.1 "ground evacuation vehicles as off-map assets", reused by M11 supply runs and
 * M13). An off-map asset is an ordinary vehicle entity with its crew, in the stores from tick 0, carrying
 * `VehicleState.offMap`. While it is off the map (phases ready, called, away) every system skips it: each loop over
 * the vehicle store tests `isOffMap` first (architecture test), and its men are aboard it, so every soldier loop's
 * mount gate passes them by. It stands parked at `OFF_MAP_PARK`, far outside every map, where no projectile, sight
 * line or grid reaches. A combat vehicle on a rear run (M10.6b, `VehicleState.rearRun`) is off the map the same way
 * while it is "away", and stays of its force.
 */
import type { SoldierState, VehicleState } from "./components";
import type { EntityId } from "./ids";
import type { SimState, SimView } from "./state";

/** Where off-map vehicles (and their men) stand: far outside any map (m). */
export const OFF_MAP_PARK = { x: -10000, y: -10000 } as const;

/** Is this vehicle off the map right now (an asset waiting, on its way to the edge, or gone; a combat vehicle away on
 *  a rear run, M10.6b; a hull towed off the map, M11.7b)? */
export function isOffMap(v: { offMap?: VehicleState["offMap"]; rearRun?: VehicleState["rearRun"]; towAway?: true } | undefined): boolean {
  if (v?.towAway === true) return true;
  const o = v?.offMap;
  if (o !== undefined) return o.phase === "ready" || o.phase === "called" || o.phase === "away";
  return v?.rearRun?.phase === "away";
}

/** Is this man off the map (aboard an off-map vehicle)? */
export function isOffMapMan(state: SimView, s: Pick<SoldierState, "mount"> | undefined): boolean {
  const vid = s?.mount?.vehicle;
  return vid !== undefined && isOffMap(state.vehicle.get(vid));
}

/** Is this unit the crew of an off-map asset (counted in no side's strength, ordered by nobody)? */
export function isAssetUnit(state: SimView, uid: EntityId | undefined): boolean {
  return uid !== undefined && state.unit.get(uid)?.asset !== undefined;
}

/** Is this man one of an asset's crew? */
export function isAssetMan(state: SimView, id: EntityId): boolean {
  return isAssetUnit(state, state.identity.get(id)?.unit);
}

/** The asset (an ambulance) on a run to rear point `pid` (called, on its way or there), if any. */
export function assetServing(state: SimView, pid: EntityId): EntityId | null {
  for (const [vid, v] of state.vehicle.entries()) {
    const o = v.offMap;
    if (o !== undefined && o.point === pid && (o.phase === "called" || o.phase === "inbound" || o.phase === "loading")) return vid;
  }
  return null;
}

/** Put a vehicle and the men aboard at the off-map park (its drive at rest). */
export function parkOffMap(state: SimState, vid: EntityId): void {
  const v = state.vehicle.req(vid), t = state.transform.req(vid);
  t.x = OFF_MAP_PARK.x; t.y = OFF_MAP_PARK.y; t.z = 0;
  const d = v.drive;
  d.route = []; d.routeIdx = 0; d.arrived = true; d.endHeading = null; d.yieldTo = null; d.speed = 0; d.yawRate = 0;
  d.trackL = 0; d.trackR = 0; d.throttle = 0; d.brake = 1; d.steer = 0; d.stuckTicks = 0; d.replans = 0;
  d.progressX = t.x; d.progressY = t.y; d.backX = t.x; d.backY = t.y; d.crossing = null; delete d.escape; delete d.towCapMps;
  for (const sid of v.seats) {
    if (sid === null) continue;
    const mt = state.transform.get(sid);
    if (mt) { mt.x = t.x; mt.y = t.y; mt.z = 0; }
  }
}
