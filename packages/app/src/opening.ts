/**
 * The battle's opening view (review 2026-11-24 step 5, item 4): the player's force and the objectives in the free
 * map area, not the whole map and not one unit. Pure: points and sizes in, a camera centre and scale out.
 */

/** No closer than this (px/m): the old opening zoom, men at true scale. */
export const OPENING_MAX_SCALE = 8;
/** The view is never tighter than this across (m): a lone squad on its objective still shows its surroundings. */
export const OPENING_MIN_SPAN_M = 150;
/** Margin around the force and the objectives, as a share of the box on each side. */
export const OPENING_MARGIN = 0.12;

export interface OpeningView { x: number; y: number; scale: number }

/**
 * The centre and scale that show every own point and every circle (objectives; without objectives the caller gives
 * what stands for them: an ambush's range, the first part of a route) in a free area of `free` pixels.
 * `maxScale` caps the zoom. Null without own points (the caller fits the map).
 */
export function openingView(
  points: readonly { x: number; y: number }[],
  circles: readonly { x: number; y: number; radiusM: number }[],
  free: { w: number; h: number },
  maxScale = OPENING_MAX_SCALE,
): OpeningView | null {
  if (points.length === 0 || free.w <= 0 || free.h <= 0) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of points) { if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x; if (p.y < y0) y0 = p.y; if (p.y > y1) y1 = p.y; }
  for (const c of circles) {
    const r = Math.max(0, c.radiusM);
    if (c.x - r < x0) x0 = c.x - r; if (c.x + r > x1) x1 = c.x + r; if (c.y - r < y0) y0 = c.y - r; if (c.y + r > y1) y1 = c.y + r;
  }
  const w = (x1 - x0) * (1 + 2 * OPENING_MARGIN), h = (y1 - y0) * (1 + 2 * OPENING_MARGIN);
  // The scale that fits the box; the shorter screen side shows at least the minimum span.
  const fit = Math.min(free.w / Math.max(w, 1e-6), free.h / Math.max(h, 1e-6));
  const scale = Math.min(maxScale, fit, Math.min(free.w, free.h) / OPENING_MIN_SPAN_M);
  return { x: (x0 + x1) / 2, y: (y0 + y1) / 2, scale };
}
