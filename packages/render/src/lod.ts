/**
 * Zoom levels (M7.5b, plan m7.5 §4; owner answer 1: true scale close, unit symbols far, opening zoomed in;
 * owner's morning review 2026-11-13: soldier figures always at true scale, no minimum figure size).
 *   close    >= CLOSE_SCALE px/m: roofs faded; pixel soldiers at true size (16 art px per metre)
 *   figure   FIGURE_SCALE .. CLOSE_SCALE: pixel soldiers at true size (never under ~8 px; hysteresis lets
 *            them shrink to about 7 px before the dots take over)
 *   dots     SYMBOL_SCALE .. FIGURE_SCALE: men as small discs in the side's colour, hulls at true size
 *   symbols  below SYMBOL_SCALE: a symbol per unit and per vehicle (stacked when close)
 * Each boundary has 10 % hysteresis: a level is entered at its threshold and left only 10 % below it, so a
 * pinch that hovers at a boundary does not flicker between looks.
 */
export const CLOSE_SCALE = 16;
/** A man is 1 m on screen (`SPRITE_M`): figures start where he is 8 px, smaller is unreadable (dots). */
export const FIGURE_SCALE = 8;
export const SYMBOL_SCALE = 1.2;
/** The battle opens at this zoom on the player's lead unit. */
export const OPENING_SCALE = 8;
export const HYSTERESIS = 1.1;

export type Lod = 0 | 1 | 2 | 3;
export const LOD_SYMBOLS: Lod = 0, LOD_DOTS: Lod = 1, LOD_FIGURE: Lod = 2, LOD_CLOSE: Lod = 3;
const T = [SYMBOL_SCALE, FIGURE_SCALE, CLOSE_SCALE];

/** The zoom level at `scale` px/m given the level shown last (null: none yet). */
export function lodFor(scale: number, prev: Lod | null): Lod {
  let up = 0, down = 0;
  for (const t of T) { if (scale >= t) up++; if (scale >= t / HYSTERESIS) down++; }
  if (prev === null) return up as Lod;
  if (prev < up) return up as Lod;
  if (prev > down) return down as Lod;
  return prev;
}
