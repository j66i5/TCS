/**
 * Noise for the photo map (plan "photo" decision 4): an integer hash, a 256 x 256 lattice of values in [-1, 1] and
 * smooth value noise read from it. Everything is keyed to world metres (or to global pixel indices for grain), so
 * any tile of the map paints the same bytes wherever it is cut. No `Math.random`, no clock. Pure: no Pixi, no DOM.
 */

/** A 32-bit integer hash of two integers and a salt, in [0, 1). */
export function hash2(ix: number, iy: number, s = 0): number {
  let h = Math.imul(ix ^ Math.imul(s, 0x5bd1e995), 0x27d4eb2d) ^ Math.imul(iy, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export const LATTICE = 256;
/** The lattice: 256 x 256 values in [-1, 1] from the hash (the same on every run and every machine). */
export const TABLE: Float32Array = (() => {
  const t = new Float32Array(LATTICE * LATTICE);
  for (let y = 0; y < LATTICE; y++) for (let x = 0; x < LATTICE; x++) t[y * LATTICE + x] = hash2(x, y, 0x7c5) * 2 - 1;
  return t;
})();

/**
 * Smooth value noise at (x, y) in lattice units, in [-1, 1]; `salt` shifts the read so channels are independent.
 * The lattice repeats every 256 units (callers scale world metres so the repeat is far larger than a map).
 */
export function vnoise(x: number, y: number, salt = 0): number {
  const fx = Math.floor(x), fy = Math.floor(y);
  let tx = x - fx, ty = y - fy;
  tx = tx * tx * (3 - 2 * tx); ty = ty * ty * (3 - 2 * ty);
  const ix = (fx + salt * 37) & 255, iy = (fy + salt * 91) & 255, ix1 = (ix + 1) & 255, iy1 = (iy + 1) & 255;
  const r0 = iy << 8, r1 = iy1 << 8;
  const a = TABLE[r0 + ix]!, b = TABLE[r0 + ix1]!, c = TABLE[r1 + ix]!, d = TABLE[r1 + ix1]!;
  return a + (b - a) * tx + (c - a + (d - c - b + a) * tx) * ty;
}

/** Fractal value noise: `oct` octaves from wavelength `wl` metres down, each half the last; result about [-1, 1]. */
export function fbm(x: number, y: number, wl: number, oct: number, salt = 0): number {
  let f = 1 / wl, a = 1, s = 0, n = 0;
  for (let o = 0; o < oct; o++) { s += a * vnoise(x * f, y * f, salt + o * 3); n += a; f *= 2.03; a *= 0.5; }
  return s / n;
}

/** Ridged noise (clumps: sharp-edged blobs rather than soft clouds), wavelength `wl` metres, in about [-1, 1]. */
export function ridged(x: number, y: number, wl: number, salt = 0): number {
  const v = 1 - Math.abs(vnoise(x / wl, y / wl, salt));
  return v * v * 2 - 1;
}

/** 0 below e0, 1 above e1, smooth between. */
export function smoothstep(e0: number, e1: number, x: number): number {
  const t = x <= e0 ? 0 : x >= e1 ? 1 : (x - e0) / (e1 - e0);
  return t * t * (3 - 2 * t);
}

/**
 * Band limit (plan section 2): how much of a pattern of period `periodM` to paint at `ppm`, so nothing finer than
 * about three pixels a period is drawn (no moiré on the base map).
 */
export const band = (periodM: number, ppm: number) => smoothstep(2.0, 3.2, periodM * ppm);

/**
 * Smooth periodic wave of period 1 in [-1, 1] (furrows, rows): a smoothstep of a triangle wave, close to a cosine
 * (few harmonics, so no herringbone aliasing when the furrows run slanted across the pixels), cheaper than `Math.cos`
 * and the same on every engine.
 */
export function tri(u: number): number {
  const t = Math.abs(2 * (u - Math.floor(u)) - 1);
  return 2 * t * t * (3 - 2 * t) - 1;
}
