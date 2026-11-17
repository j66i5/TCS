/**
 * SUPPLY POINTS AND CACHES ON THE MAP (M11.3). Pure functions of the read-only view: `cacheMarkers` lists the caches
 * the player's side knows of — its own (its supply points with their fill), and the enemy's its men have seen
 * (`cache.known`) — and `supplySourceNear` the own cache a "Resupply" order would send the men to.
 */
import type { Catalog, EntityId, SimView } from "@tcs/sim";

export interface CacheMarker {
  cache: EntityId;
  x: number;
  y: number;
  /** Own, enemy (known), or nobody's colour (empty / burnt). */
  own: boolean;
  /** Whose it is (side id). */
  side: string;
  /** A platoon's supply point (and the top unit it serves: the `supplyPoint` order's target when dragged). */
  point: boolean;
  unit?: EntityId;
  /** Rounds of ammunition in it, and how full its crates and cans are (0..1; null: nothing to fill). */
  rounds: number;
  fill: number | null;
  empty: boolean;
  burning: boolean;
  burnt: boolean;
  /** M11.4a: in bearers' hands (drawn above them so the men show). */
  carried?: boolean;
}

/** The caches side `side` knows of. */
export function cacheMarkers(view: SimView, catalog: Catalog, side: string): CacheMarker[] {
  const out: CacheMarker[] = [];
  for (const [id, c] of view.cache.entries()) {
    const own = c.side === side;
    if (!own && !(c.known?.includes(side) ?? false)) continue;
    const t = view.transform.get(id);
    if (!t) continue;
    let rounds = 0, charge = 0, cap = 0;
    const k = view.container.get(id);
    if (k) for (const s of k.stacks) {
      const d = catalog.items[s.type];
      if (s.charge !== undefined && d?.chargeItem !== undefined) { rounds += s.charge * s.count; charge += s.charge * s.count; cap += (d.chargeCapacity ?? 0) * s.count; }
      else if (s.charge === undefined && catalog.ammo[s.type] !== undefined) rounds += s.count;
    }
    out.push({
      cache: id, x: t.x, y: t.y, own, side: c.side, point: c.kind === "point", ...(c.top !== undefined ? { unit: c.top } : {}),
      // (An enemy cache: what the player can tell from afar is that it is there, not how full it is.)
      rounds: own ? rounds : 0, fill: own && cap > 0 ? charge / cap : null, empty: own ? (k?.stacks.length ?? 0) === 0 : false,
      burning: c.cookoff !== undefined, burnt: c.burnt === true, ...(c.carried === true ? { carried: true } : {}),
    });
  }
  return out;
}

/** The own supply-point marker under a point (within `tolM`), or null. */
export function supplyPointAt(markers: readonly CacheMarker[], x: number, y: number, tolM: number): CacheMarker | null {
  let best: CacheMarker | null = null, bestD = tolM;
  for (const m of markers) { if (!m.own || !m.point || m.unit === undefined) continue; const d = Math.hypot(m.x - x, m.y - y); if (d <= bestD) { best = m; bestD = d; } }
  return best;
}

/**
 * The own cache a "Resupply" order would use for these men: not burning, something in it, within `supply.take.reachM`
 * of their middle (the nearest). Null: none (the button is not offered).
 */
export function supplySourceNear(view: SimView, catalog: Catalog, side: string, men: readonly EntityId[]): EntityId | null {
  const R = catalog.supply?.take.reachM;
  if (R === undefined) return null;
  let cx = 0, cy = 0, n = 0;
  for (const m of men) {
    const s = view.soldier.get(m), t = view.transform.get(m);
    if (!s || !t || !s.physiology.alive || s.mount !== undefined || s.captive !== null || s.casualty !== "none") continue;
    cx += t.x; cy += t.y; n++;
  }
  if (n === 0) return null;
  cx /= n; cy /= n;
  let best: EntityId | null = null, bestD = R;
  for (const [id, c] of view.cache.entries()) {
    if (c.side !== side || c.cookoff !== undefined || c.carried === true || (view.container.get(id)?.stacks.length ?? 0) === 0) continue;
    const t = view.transform.get(id);
    if (!t) continue;
    const d = Math.hypot(t.x - cx, t.y - cy);
    if (d <= bestD) { bestD = d; best = id; }
  }
  return best;
}
