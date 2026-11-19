/**
 * COUNTED HOLDINGS (M12.1a): what roster records hold, counted as the sim's ledger counts the state (sim/ledger.ts):
 * every stack as items; its charge as rounds of its cartridge (`chargeItem`) or as its charge kind (litres, Wh, ml);
 * a hull's ready belts as rounds (absent: full from the data). The campaign's books: a battle takes `in - out` of the
 * records it was given; men and hulls that leave the force take their loads with them (written off); a replenishment
 * delivers the difference to the standard loads. So, per item: start + delivered - battles' net - written off = now.
 */
import type { Catalog, ItemStack, SoldierRecord, UnitInput, VehicleRecord } from "@tcs/sim";
import type { CampaignForce, Holdings } from "./record";
import { membersOf } from "./record";

export function emptyHoldings(): Holdings { return { ammo: {}, charge: {}, items: {} }; }

function add(m: Record<string, number>, k: string, n: number): void {
  if (n === 0) return;
  const v = (m[k] ?? 0) + n;
  if (v === 0) delete m[k]; else m[k] = v;
}

function rounds(catalog: Catalog, h: Holdings, item: string, n: number): void {
  const d = catalog.items[item];
  if (d?.chargeItem !== undefined) add(h.ammo, d.chargeItem, n);
  else if (d?.chargeKind !== undefined) add(h.charge, d.chargeKind, n);
}

export function addStacks(catalog: Catalog, h: Holdings, stacks: readonly ItemStack[], sign = 1): void {
  for (const s of stacks) {
    add(h.items, s.type, sign * s.count);
    if (s.charge !== undefined) rounds(catalog, h, s.type, sign * s.charge * s.count);
    else if (catalog.ammo[s.type] !== undefined) add(h.ammo, s.type, sign * s.count);
  }
}

export function addMan(catalog: Catalog, h: Holdings, m: SoldierRecord, sign = 1): void { addStacks(catalog, h, m.load, sign); }

export function addHull(catalog: Catalog, h: Holdings, v: VehicleRecord, sign = 1): void {
  addStacks(catalog, h, v.load, sign);
  const def = catalog.vehicles[v.type];
  if (!def) return;
  let k = 0;
  for (const st of def.stations) for (const w of st.weapons) {
    w.feeds.forEach((f, fi) => rounds(catalog, h, f.item, sign * (v.ready?.[k]?.[fi]?.rounds ?? f.ready.count * f.ready.charge)));
    k++;
  }
}

export function addUnits(catalog: Catalog, h: Holdings, units: readonly UnitInput[], sign = 1): void {
  for (const u of units) for (const m of membersOf(u)) addMan(catalog, h, m, sign);
}

/** a + sign * b, in place on a. */
export function addHoldings(a: Holdings, b: Holdings, sign = 1): Holdings {
  for (const k of ["ammo", "charge", "items"] as const) for (const [id, n] of Object.entries(b[k]).sort()) add(a[k], id, sign * n);
  return a;
}

/** Everything a force holds: its battalion's men, its hulls in service and in the workshop, its recovering and
 *  unassigned men (they keep their loads). The dead, missing and captured are not the force's. */
export function forceHoldings(catalog: Catalog, f: CampaignForce): Holdings {
  const h = emptyHoldings();
  addUnits(catalog, h, [f.battalion]);
  for (const v of f.vehicles) addHull(catalog, h, v);
  for (const w of f.workshop) addHull(catalog, h, w.record);
  for (const p of [...f.pools.recovering, ...f.pools.unassigned, ...f.pools.replacements]) addMan(catalog, h, p.record);
  return h;
}

/** Charge differences below this are rounding (litres burnt in fractions). */
export const HOLDINGS_EPS = 1e-6;

/** The ids whose amounts differ between a and b by more than `eps` (an empty object: equal). */
export function holdingsDiff(a: Holdings, b: Holdings, eps = HOLDINGS_EPS): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of ["ammo", "charge", "items"] as const) {
    const ids = new Set([...Object.keys(a[k]), ...Object.keys(b[k])]);
    for (const id of [...ids].sort()) { const d = (a[k][id] ?? 0) - (b[k][id] ?? 0); if (Math.abs(d) > eps) out[`${k}:${id}`] = d; }
  }
  return out;
}
