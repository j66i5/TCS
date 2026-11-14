/**
 * AMMUNITION EXPENDITURE (M7.3, plan C4): what each side fired, split by source, from the event stream alone
 * (rule 5: tools and the after-action review read events, never internals). A round fired from a vehicle's
 * station (`shot.fired.vehicle`) is credited to the vehicle — cannon rounds by ammunition, the coaxial machine
 * gun apart — not to the gunner's personal tally; rifles and machine guns on foot are "small arms"; grenades
 * thrown or launched; anti-tank rounds by type (M7.4a); smoke salvos by vehicle; guided missiles by vehicle.
 */
import type { Catalog } from "./catalog";
import type { SimEvent } from "./events";
import type { EntityId } from "./ids";
import type { SimView } from "./state";

export interface SideExpenditure {
  smallArms: number;
  grenades: number;
  /** Hand smoke grenades thrown (D1; not in `grenades`). */
  handSmoke: number;
  /** Shoulder-fired anti-tank rounds by ammunition id (M7.4a). */
  rockets: Record<string, number>;
  /** Per vehicle (its roster id): cannon rounds by ammunition id, coaxial rounds, smoke salvos, guided missiles by
   *  ammunition id (owner 2026-11-13). */
  vehicles: Record<string, { cannon: Record<string, number>; coax: number; smoke: number; missiles: Record<string, number> }>;
}

export type Expenditure = Record<string, SideExpenditure>;

/** Add one tick's events to the tally (`view`: the state after that tick, for sides and vehicle ids). */
export function tallyExpenditure(out: Expenditure, events: readonly SimEvent[], view: SimView, catalog: Catalog): void {
  const sideOf = (id: EntityId) => view.identity.get(id)?.side ?? view.vehicle.get(id)?.side;
  const side = (s: string) => (out[s] ??= { smallArms: 0, grenades: 0, handSmoke: 0, rockets: {}, vehicles: {} });
  const veh = (s: SideExpenditure, vid: EntityId) => { const key = view.vehicle.get(vid)?.vehicleId ?? String(vid); return (s.vehicles[key] ??= { cannon: {}, coax: 0, smoke: 0, missiles: {} }); };
  for (const e of events) {
    if (e.kind === "shot.fired") {
      const sd = sideOf(e.vehicle ?? e.shooter);
      if (sd === undefined) continue;
      const s = side(sd);
      if (e.vehicle === undefined) { s.smallArms++; continue; }
      const v = veh(s, e.vehicle);
      if (catalog.weapons[e.weapon]?.type === "autocannon") v.cannon[e.ammo] = (v.cannon[e.ammo] ?? 0) + 1;
      else if (catalog.ammo[e.ammo]?.guided !== undefined) v.missiles[e.ammo] = (v.missiles[e.ammo] ?? 0) + 1;
      else v.coax++;
    } else if (e.kind === "grenade.launched") {
      const sd = sideOf(e.soldier);
      if (sd === undefined) continue;
      if (e.method === "direct") { const r = side(sd).rockets; r[e.ammo] = (r[e.ammo] ?? 0) + 1; }
      else if (catalog.ammo[e.ammo]?.smoke !== undefined) side(sd).handSmoke++;
      else side(sd).grenades++;
    } else if (e.kind === "vehicle.smoke") {
      const sd = sideOf(e.vehicle);
      if (sd !== undefined) veh(side(sd), e.vehicle).smoke++;
    }
  }
}
