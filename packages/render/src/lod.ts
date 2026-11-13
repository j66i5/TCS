/**
 * Zoom levels (M7.5b, plan m7.5 §4; owner answer 1: true scale close, unit symbols far, opening zoomed in).
 *   close    >= CLOSE_SCALE px/m: roofs faded; pixel soldiers, at true size (16 art px per metre) once that
 *            is larger than the readable minimum (MIN_FIGURE_PX)
 *   figure   FIGURE_SCALE .. CLOSE_SCALE: pixel soldiers at the readable minimum size
 *   dots     SYMBOL_SCALE .. FIGURE_SCALE: men as small discs in the side's colour, hulls at true size
 *   symbols  below SYMBOL_SCALE: a symbol per unit and per vehicle (stacked when close)
 * Each boundary has 10 % hysteresis: a level is entered at its threshold and left only 10 % below it, so a
 * pinch that hovers at a boundary does not flicker between looks.
 */
export const CLOSE_SCALE = 16;
export const FIGURE_SCALE = 5;
export const SYMBOL_SCALE = 1.2;
/** The battle opens at this zoom on the player's lead unit. */
export const OPENING_SCALE = 8;
/**
 * Smallest soldier sprite on screen (CSS px): readable on a phone. The sprite is drawn at
 * `max(true size, figurePx(resolution))`, so it never jumps in size between levels and is at true scale once true
 * size is the larger (from about 24 px/m).
 */
export const MIN_FIGURE_PX = 24;

/** The minimum sprite size snapped to a whole number of device pixels per art pixel (crisp pixel art). */
export function figurePx(resolution: number): number {
  const k = Math.max(1, Math.round((MIN_FIGURE_PX * resolution) / 16));
  return (16 * k) / resolution;
}
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
