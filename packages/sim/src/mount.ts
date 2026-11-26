/**
 * Mounted men and vehicles (M7): small helpers every system uses to tell a man aboard a vehicle from a man on
 * foot, and to find a vehicle's crew. Mounted men stay soldiers (Identity, Transform copied from the seat).
 */
import type { ComponentKind, StationKind, VehicleDef } from "./catalog";
import type { SoldierState, VehicleState } from "./components";
import type { DefId, EntityId, SideId } from "./ids";
import { isAble } from "./impair";
import { countItems } from "./items";
import type { SimState, SimView } from "./state";
import { unitSoldiers } from "./systems/orders";

/** Crew seat order: a crew unit's members take the crew seats in this order unless a placement names a seat. */
export const CREW_STATION_ORDER: readonly StationKind[] = ["commander", "gunner", "loader", "driver"];

/** The action of a crewman out on his vehicle's roof (M9.3a: reloading a launcher from outside). */
export const ROOF_ACTION = "reloadOutside";
/** M11.7a: a crewman repairing his hull from outside (a track, a wheel side), on the ground beside it. */
export const REPAIR_OUTSIDE = "repairOutside";
/** M11.7a: a crewman repairing inside the hull (coax, radio): under armour, but off his station. */
export const REPAIR_INSIDE = "repairInside";
/** M11.7b (reserved): a recovery crewman outside hooking up a tow. */
export const HOOK_UP = "hookUp";
/** Actions of a man who keeps his seat but is outside the hull: exposed like a man on foot (M9.3a, M11.7a). */
export const OUTSIDE_ACTIONS: readonly string[] = [ROOF_ACTION, REPAIR_OUTSIDE, HOOK_UP];

/**
 * Is this man aboard but outside the hull: out on the roof reloading (M9.3a), or beside it repairing or hooking up
 * (M11.7a/b)? Then he is a target and a body like a man on foot. (The name stays from M9.3a; `isOutside` is the
 * same test.)
 */
export function onRoof(state: SimState | SimView, id: EntityId): boolean {
  if (state.action.size === 0) return false;
  const k = state.action.get(id)?.kind;
  return k === ROOF_ACTION || k === REPAIR_OUTSIDE || k === HOOK_UP;
}
/** Aboard but outside (M11.7a: render and UI draw him as a man on foot). */
export const isOutside = onRoof;
/** Standing on top of his hull (M9.3a): only the roof reloader; a man beside it is on the ground. */
export function onRoofTop(state: SimState | SimView, id: EntityId): boolean {
  return state.action.size > 0 && state.action.get(id)?.kind === ROOF_ACTION;
}

export function isMounted(s: SoldierState | undefined): boolean {
  return s?.mount !== undefined;
}

/** Able and on foot: the men every foot-soldier loop is about. */
export function isExposed(s: SoldierState | undefined): boolean {
  return isAble(s) && s!.mount === undefined;
}

/** The vehicle a mounted man rides in, else the man himself. */
export function platformOf(state: SimState, id: EntityId): EntityId {
  return state.soldier.get(id)?.mount?.vehicle ?? id;
}

/** Side of a soldier (identity) or of a vehicle. */
export function sideOfEntity(state: SimState, id: EntityId): SideId | null {
  return state.identity.get(id)?.side ?? state.vehicle.get(id)?.side ?? null;
}

/** Index of the first seat of this station kind, or -1. */
export function stationSeat(def: VehicleDef, kind: StationKind): number {
  return def.seats.findIndex((s) => s.station === kind);
}

/** The man in the first seat of this kind, or null. */
export function occupant(v: VehicleState, def: VehicleDef, kind: StationKind): EntityId | null {
  const i = stationSeat(def, kind);
  return i < 0 ? null : v.seats[i] ?? null;
}

/** An able driver in the driver's seat (no driver, no movement). */
export function hasDriver(state: SimState, v: VehicleState, def: VehicleDef): boolean {
  const d = occupant(v, def, "driver");
  return d !== null && isAble(state.soldier.get(d));
}

/** `unitSoldiers` without the men aboard vehicles. */
export function footSoldiers(state: SimState, unit: EntityId): EntityId[] {
  return unitSoldiers(state, unit).filter((id) => state.soldier.get(id)?.mount === undefined);
}

/** The unit whose fire rules govern this unit's fire: a crew unit governs itself, others their top unit. */
export function fireTop(state: SimState, unit: EntityId): EntityId {
  let u = unit;
  for (;;) {
    const x = state.unit.get(u);
    if (!x || x.vehicle !== undefined || x.parent === null) return u;
    u = x.parent;
  }
}

/** Count of items of a type in a vehicle's container. */
export function vehicleItems(state: SimState, v: EntityId, item: DefId): number {
  const c = state.container.get(v);
  return c ? countItems(c, item) : 0;
}

/**
 * Condition (0..1) of a vehicle's components of one kind (M7.4b): the worst of them; 1 when it has none (a
 * vehicle without that part listed works as before).
 */
export function compCondition(v: { readonly comp: readonly number[] }, def: VehicleDef, kind: ComponentKind): number {
  const comps = def.components;
  if (!comps) return 1;
  let c = 1;
  for (let k = 0; k < comps.length; k++) if (comps[k]!.kind === kind) { const x = v.comp[k] ?? 1; if (x < c) c = x; }
  return c;
}

/**
 * Balance pass 5 (F4): do hits on carriers call a squad riding in `vid` out? Its own carrier was hit, or another of
 * its side's carriers within `nearM` of it (the fire is on this part of the column). `hit`: the side's carriers hit
 * since the last look. Pure: the AI commander uses it now, the mounted assault drill later. (A whole side no longer
 * gets out because one carrier 1.5 km away was struck.)
 */
export function carrierHitNear(state: SimState | SimView, vid: EntityId, hit: readonly EntityId[], nearM: number): boolean {
  if (hit.length === 0) return false;
  if (hit.includes(vid)) return true;
  const t = state.transform.get(vid);
  if (!t) return false;
  for (const h of hit) {
    const ht = state.transform.get(h);
    if (ht && (ht.x - t.x) * (ht.x - t.x) + (ht.y - t.y) * (ht.y - t.y) <= nearM * nearM) return true;
  }
  return false;
}
