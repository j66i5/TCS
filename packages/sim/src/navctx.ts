/** Access to navigation grids, built lazily from the map (derived, never saved). */
import type { MovementClass } from "./catalog";
import type { SimContext } from "./context";
import { buildNavGrid, createNavSearch, ensureNavGrid, patchNavGrid, type NavGrid, type NavSearch } from "./nav";

/** Clearance (cells of 2 m) of the vehicle grids: hard blocks grow by one cell (M7). */
export const VEHICLE_CLEARANCE_CELLS = 1;

/**
 * Grid for a movement class. `coverWeight` > 0 gives the cover-seeking variant used for planning routes
 * (open ground costs more); movement speed always uses the plain grid (weight 0). Vehicle classes use the
 * grid with clearance (`tracked:c1`, `wheeled:c1`), on which a hole in a wall counts only if a hull fits.
 */
export function navFor(ctx: SimContext, cls: MovementClass, coverWeight = 0): { grid: NavGrid; search: NavSearch } {
  const vehicle = cls !== "foot";
  const key = vehicle ? `${cls}:c${VEHICLE_CLEARANCE_CELLS}` : coverWeight > 0 ? `${cls}:cover:${coverWeight}` : cls;
  let n = ctx.nav[key];
  if (!n) {
    const grid = buildNavGrid(ctx.map, ctx.catalog.terrain, cls, 2, vehicle ? 0 : coverWeight, ctx.breaches,
      vehicle ? { clearanceCells: VEHICLE_CLEARANCE_CELLS, minBreachM: widestHull(ctx, cls) + 0.5, stamps: ctx.navStamps } : { stamps: ctx.navStamps });
    n = { grid, search: createNavSearch(grid) };
    ctx.nav[key] = n;
  }
  ensureNavGrid(n.grid);
  return n;
}

/** Widest hull of a vehicle class in the data, m (3 m if none). */
function widestHull(ctx: SimContext, cls: MovementClass): number {
  let w = 0;
  for (const id of Object.keys(ctx.catalog.vehicles).sort()) { const v = ctx.catalog.vehicles[id]!; if (v.class === cls) w = Math.max(w, v.body.widthM); }
  return w > 0 ? w : 2.5;
}

/** Re-derive every built grid inside a rectangle (m) after terrain damage (M7.1c; replaces a full rebuild). */
export function patchNavGrids(ctx: SimContext, x0: number, y0: number, x1: number, y1: number): void {
  for (const key of Object.keys(ctx.nav).sort()) {
    patchNavGrid(ctx.nav[key]!.grid, ctx.map, ctx.catalog.terrain, ctx.breaches, ctx.navStamps, x0, y0, x1, y1);
  }
}
