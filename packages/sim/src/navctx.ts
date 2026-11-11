/** Access to navigation grids, built lazily from the map (derived, never saved). */
import type { MovementClass } from "./catalog";
import type { SimContext } from "./context";
import { buildNavGrid, createNavSearch, type NavGrid, type NavSearch } from "./nav";

/**
 * Grid for a movement class. `coverWeight` > 0 gives the cover-seeking variant used for planning routes
 * (open ground costs more); movement speed always uses the plain grid (weight 0).
 */
export function navFor(ctx: SimContext, cls: MovementClass, coverWeight = 0): { grid: NavGrid; search: NavSearch } {
  const key = coverWeight > 0 ? `${cls}:cover:${coverWeight}` : cls;
  let n = ctx.nav[key];
  if (!n) {
    const grid = buildNavGrid(ctx.map, ctx.catalog.terrain, cls, 2, coverWeight, ctx.breaches);
    n = { grid, search: createNavSearch(grid) };
    ctx.nav[key] = n;
  }
  return n;
}
