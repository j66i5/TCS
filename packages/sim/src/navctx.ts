/** Access to the navigation grid of a movement class, built lazily from the map (derived, never saved). */
import type { MovementClass } from "./catalog";
import type { SimContext } from "./context";
import { buildNavGrid, createNavSearch, type NavGrid, type NavSearch } from "./nav";

export function navFor(ctx: SimContext, cls: MovementClass): { grid: NavGrid; search: NavSearch } {
  let n = ctx.nav[cls];
  if (!n) {
    const grid = buildNavGrid(ctx.map, ctx.catalog.terrain, cls);
    n = { grid, search: createNavSearch(grid) };
    ctx.nav[cls] = n;
  }
  return n;
}
