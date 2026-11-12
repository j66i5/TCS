/**
 * Mounted men and vehicles (M7): small helpers every system uses to tell a man aboard a vehicle from a man on
 * foot, and to find a vehicle's crew. Mounted men stay soldiers (Identity, Transform copied from the seat).
 */
import type { StationKind, VehicleDef } from "./catalog";
import type { SoldierState, VehicleState } from "./components";
import type { DefId, EntityId, SideId } from "./ids";
import { isAble } from "./impair";
import { countItems } from "./items";
import type { SimState } from "./state";
import { unitSoldiers } from "./systems/orders";

/** Crew seat order: a crew unit's members take the crew seats in this order unless a placement names a seat. */
export const CREW_STATION_ORDER: readonly StationKind[] = ["commander", "gunner", "loader", "driver"];

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
