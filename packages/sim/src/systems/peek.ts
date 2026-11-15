/**
 * A FEW METRES ASIDE (shared by the drills and a man's own look for an enemy he has lost; sight realism step 4).
 *
 * `forEachSidestep` walks the spots a few metres to either side of a man, across the line to a point `at` (so never
 * closer to it), in the order of `offsets`: on the ground he can walk on, outdoors, inside the map, and at least
 * `soldier.minSpacingM` from every other man of his side on foot. The caller tests each spot (a line of fire or a
 * view from there) and stops the walk by returning true.
 */
import type { SimContext } from "../context";
import type { EntityId } from "../ids";
import { indoorAt } from "../interior-nav";
import { hypot2 } from "../math";
import { navCostAt } from "../nav";
import { navFor } from "../navctx";
import type { Posture } from "../orders";
import type { SimState } from "../state";
import { friendInLine, lineOfFireTo } from "./fire";

/**
 * His best line of fire to a point from any of `postures` (2 clear, 1 into cover near it, 0 none), none with a
 * comrade in it (another squad bounding beside his, a man of his own half); `from`: as if he were there.
 */
export function lineFor(ctx: SimContext, state: SimState, m: EntityId, x: number, y: number, h: number, postures: Posture[], from?: { x: number; y: number; z: number }): number {
  if (friendInLine(ctx, state, m, x, y, 0, from)) return 0;
  let q = 0;
  for (const p of postures) { q = Math.max(q, lineOfFireTo(ctx, state, m, x, y, h, p, ctx.catalog.behaviour.drills.suppressShortM, from)); if (q === 2) break; }
  return q;
}

/**
 * Calls `visit(x, y)` for each free spot `offsets` metres to his side (right of the line to `at` for a positive
 * offset), in that order, until `visit` returns true. Returns whether one did. Nothing for a man indoors or up a
 * floor, or one standing on `at`.
 */
export function forEachSidestep(ctx: SimContext, state: SimState, m: EntityId, at: { x: number; y: number }, offsets: readonly number[], visit: (x: number, y: number) => boolean): boolean {
  const t = state.transform.req(m);
  if (t.z > 0 || indoorAt(ctx, t.x, t.y) >= 0) return false;
  const L = hypot2(at.x - t.x, at.y - t.y);
  if (L < 1) return false;
  const px = -(at.y - t.y) / L, py = (at.x - t.x) / L;
  const side = state.identity.req(m).side, grid = navFor(ctx, "foot").grid, minM = ctx.catalog.behaviour.soldier.minSpacingM;
  for (const off of offsets) {
    const x = t.x + px * off, y = t.y + py * off;
    if (x < 1 || y < 1 || x > ctx.map.widthM - 1 || y > ctx.map.heightM - 1 || navCostAt(grid, x, y) <= 0 || indoorAt(ctx, x, y) >= 0) continue;
    let crowded = false;
    for (const [o, id] of state.identity.entries()) {
      // (Men aboard a vehicle take no room on the ground.)
      if (o === m || id.side !== side || !state.soldier.has(o) || state.soldier.get(o)!.mount !== undefined) continue;
      const ot = state.transform.req(o);
      if (hypot2(ot.x - x, ot.y - y) < minM) { crowded = true; break; }
    }
    if (crowded) continue;
    if (visit(x, y)) return true;
  }
  return false;
}
