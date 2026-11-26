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

/**
 * Verification fix: below this (px/m) the force and the objectives together are too small to read (an upright phone,
 * an attack along the map's long side: the whole map as a band, the force one stacked symbol). The view then shows
 * the force at this scale (looser only if the force itself needs it), pushed as far toward the objectives as keeps
 * every own man in it; the objectives outside the view are pointed at from its edge (`edgeMarker`).
 */
export const OPENING_MIN_SCALE = 0.6;

export interface OpeningView { x: number; y: number; scale: number; /** False: the objectives (or what stands for them) are not all in the view. */ whole: boolean }

/**
 * The centre and scale that show every own point and every circle (objectives; without objectives the caller gives
 * what stands for them: an ambush's range, the exit of a route) in a free area of `free` pixels. `maxScale` caps the
 * zoom. When both do not fit at `OPENING_MIN_SCALE`: the force, toward the circles. Null without own points (the
 * caller fits the map).
 */
export function openingView(
  points: readonly { x: number; y: number }[],
  circles: readonly { x: number; y: number; radiusM: number }[],
  free: { w: number; h: number },
  maxScale = OPENING_MAX_SCALE,
): OpeningView | null {
  if (points.length === 0 || free.w <= 0 || free.h <= 0) return null;
  let fx0 = Infinity, fy0 = Infinity, fx1 = -Infinity, fy1 = -Infinity;
  for (const p of points) { if (p.x < fx0) fx0 = p.x; if (p.x > fx1) fx1 = p.x; if (p.y < fy0) fy0 = p.y; if (p.y > fy1) fy1 = p.y; }
  let x0 = fx0, y0 = fy0, x1 = fx1, y1 = fy1;
  for (const c of circles) {
    const r = Math.max(0, c.radiusM);
    if (c.x - r < x0) x0 = c.x - r; if (c.x + r > x1) x1 = c.x + r; if (c.y - r < y0) y0 = c.y - r; if (c.y + r > y1) y1 = c.y + r;
  }
  const m = 1 + 2 * OPENING_MARGIN;
  // The scale that fits a box with its margin; the shorter screen side shows at least the minimum span.
  const fitOf = (w: number, h: number) => Math.min(free.w / Math.max(w * m, 1e-6), free.h / Math.max(h * m, 1e-6));
  const cap = Math.min(maxScale, Math.min(free.w, free.h) / OPENING_MIN_SPAN_M);
  const all = fitOf(x1 - x0, y1 - y0);
  if (circles.length === 0 || all >= OPENING_MIN_SCALE) return { x: (x0 + x1) / 2, y: (y0 + y1) / 2, scale: Math.min(cap, all), whole: true };
  // The force alone, as much ground toward the objectives as the minimum scale shows.
  const scale = Math.min(cap, fitOf(fx1 - fx0, fy1 - fy0), OPENING_MIN_SCALE);
  const tx = (x0 + x1) / 2, ty = (y0 + y1) / 2, cx = (fx0 + fx1) / 2, cy = (fy0 + fy1) / 2;
  // (Shifted toward the whole box's centre while the force's box with its margin stays inside.)
  const slackX = Math.max(0, free.w / scale / 2 - ((fx1 - fx0) * m) / 2), slackY = Math.max(0, free.h / scale / 2 - ((fy1 - fy0) * m) / 2);
  const toward = (c: number, t: number, slack: number) => c + Math.max(-slack, Math.min(slack, t - c));
  return { x: toward(cx, tx, slackX), y: toward(cy, ty, slackY), scale, whole: false };
}

/**
 * Where a place outside a screen rectangle is pointed at from its edge: the point on the rectangle's border (inset by
 * `pad`) on the line from its centre to the place, and the direction (rad, screen: 0 = right, clockwise). Null when
 * the place is inside the rectangle.
 */
export function edgeMarker(p: { x: number; y: number }, rect: { x: number; y: number; w: number; h: number }, pad = 0): { x: number; y: number; angle: number } | null {
  if (p.x >= rect.x && p.x <= rect.x + rect.w && p.y >= rect.y && p.y <= rect.y + rect.h) return null;
  const hw = Math.max(1, rect.w / 2 - pad), hh = Math.max(1, rect.h / 2 - pad);
  const cx = rect.x + rect.w / 2, cy = rect.y + rect.h / 2, dx = p.x - cx, dy = p.y - cy;
  const k = Math.min(Math.abs(dx) > 1e-9 ? hw / Math.abs(dx) : Infinity, Math.abs(dy) > 1e-9 ? hh / Math.abs(dy) : Infinity);
  return { x: cx + dx * k, y: cy + dy * k, angle: Math.atan2(dy, dx) };
}
