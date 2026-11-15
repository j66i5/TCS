/**
 * AMMUNITION EXPENDITURE (M7.3, plan C4): what each side fired, split by source, from the event stream alone
 * (rule 5: tools and the after-action review read events, never internals). A round fired from a vehicle's
 * station (`shot.fired.vehicle`) is credited to the vehicle — cannon rounds by ammunition, the coaxial machine
 * gun apart — not to the gunner's personal tally; rifles and machine guns on foot are "small arms"; grenades
 * thrown or launched; anti-tank rounds by type (M7.4a; M9.3b: missiles from a team's post among them); smoke salvos by vehicle; guided missiles by vehicle.
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
  /** M8.6: fire support rounds landed, by "asset:kind" ("mortar:he", "artillery:illum" ...). Absent: none. */
  support?: Record<string, number>;
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
      if (e.indirect) continue; // (an on-map mortar round, M8.3b: counted with the fire missions, not small arms)
      if (e.vehicle === undefined) {
        // (M9.3b: a guided missile from a team's post is counted with the anti-tank rounds, by ammunition.)
        if (catalog.ammo[e.ammo]?.guided !== undefined) s.rockets[e.ammo] = (s.rockets[e.ammo] ?? 0) + 1;
        else s.smallArms++;
        continue;
      }
      const v = veh(s, e.vehicle);
      // (M7.6a: a tank's main gun counts as the cannon; a missile fired through it as a missile.)
      const wt = catalog.weapons[e.weapon]?.type;
      if (wt === "autocannon" || (wt === "tank-gun" && catalog.ammo[e.ammo]?.guided === undefined)) v.cannon[e.ammo] = (v.cannon[e.ammo] ?? 0) + 1;
      else if (catalog.ammo[e.ammo]?.guided !== undefined) v.missiles[e.ammo] = (v.missiles[e.ammo] ?? 0) + 1;
      else v.coax++;
    } else if (e.kind === "support.round") {
      const sp = (side(e.side).support ??= {});
      const k = `${e.asset}:${e.ammo}`;
      sp[k] = (sp[k] ?? 0) + 1;
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
