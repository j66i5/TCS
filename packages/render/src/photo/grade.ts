/**
 * The photo grade (plan "photo" step "ground" 5): a light [1 2 1] blur (from 2 px/m; it needs a one-pixel apron
 * round the tile, painted and then cropped, so tiles still join), then a slight desaturation, a little contrast, a
 * warm lift, a saturation cap (readability: ground never louder than the units) and grain keyed to the global pixel
 * grid. Pure (no Pixi, no DOM).
 */
import { TABLE } from "./noise";
import type { PhotoGrade } from "./prep";

/** Readability cap (plan section 2): no painted pixel above this HSV saturation. */
export const SAT_CAP = 0.4;
const PIVOT = 118;

/**
 * Grade `src` (SW x SH words) into RGBA bytes of W x H. With `apron` 1 the source is one pixel larger on every side
 * and blurred (half blur, half sharp); with 0 it is graded as it is. `gx0`, `gy0`: global pixel of out (0, 0).
 */
export function gradeInto(src: Uint32Array, SW: number, apron: 0 | 1, W: number, H: number, gx0: number, gy0: number, g: PhotoGrade): Uint8Array {
  const out = new Uint8Array(W * H * 4);
  const keep = 1 - g.desaturate, con = 1 + g.contrast, warmR = 1 + g.warm * 0.6, warmG = 1 + g.warm * 0.15, warmB = 1 - g.warm * 0.3, grain = g.grain;
  const T = TABLE;
  for (let j = 0; j < H; j++) {
    const sj = j + apron;
    for (let i = 0; i < W; i++) {
      const si = i + apron, s = sj * SW + si;
      let r: number, gg: number, b: number;
      const c = src[s]!;
      if (apron) {
        // [1 2 1] x [1 2 1] / 16, mixed 50 % with the sharp pixel.
        const n = src[s - SW - 1]!, n2 = src[s - SW]!, n3 = src[s - SW + 1]!, w = src[s - 1]!, e = src[s + 1]!, sw = src[s + SW - 1]!, s2 = src[s + SW]!, se = src[s + SW + 1]!;
        const br = (n & 255) + 2 * (n2 & 255) + (n3 & 255) + 2 * (w & 255) + 4 * (c & 255) + 2 * (e & 255) + (sw & 255) + 2 * (s2 & 255) + (se & 255);
        const bg = ((n >>> 8) & 255) + 2 * ((n2 >>> 8) & 255) + ((n3 >>> 8) & 255) + 2 * ((w >>> 8) & 255) + 4 * ((c >>> 8) & 255) + 2 * ((e >>> 8) & 255) + ((sw >>> 8) & 255) + 2 * ((s2 >>> 8) & 255) + ((se >>> 8) & 255);
        const bb = ((n >>> 16) & 255) + 2 * ((n2 >>> 16) & 255) + ((n3 >>> 16) & 255) + 2 * ((w >>> 16) & 255) + 4 * ((c >>> 16) & 255) + 2 * ((e >>> 16) & 255) + ((sw >>> 16) & 255) + 2 * ((s2 >>> 16) & 255) + ((se >>> 16) & 255);
        r = 0.5 * (c & 255) + br / 32; gg = 0.5 * ((c >>> 8) & 255) + bg / 32; b = 0.5 * ((c >>> 16) & 255) + bb / 32;
      } else { r = c & 255; gg = (c >>> 8) & 255; b = (c >>> 16) & 255; }
      // Desaturate, contrast round a mid tone, warm lift.
      const L = 0.299 * r + 0.587 * gg + 0.114 * b;
      r = L + (r - L) * keep; gg = L + (gg - L) * keep; b = L + (b - L) * keep;
      r = (PIVOT + (r - PIVOT) * con) * warmR; gg = (PIVOT + (gg - PIVOT) * con) * warmG; b = (PIVOT + (b - PIVOT) * con) * warmB;
      // Saturation cap.
      const mx = r > gg ? (r > b ? r : b) : (gg > b ? gg : b), mn = r < gg ? (r < b ? r : b) : (gg < b ? gg : b);
      if (mx > 0 && mx - mn > SAT_CAP * mx) {
        const L2 = 0.299 * r + 0.587 * gg + 0.114 * b;
        const k = (SAT_CAP * 0.985 * L2) / (mx - mn - SAT_CAP * 0.985 * (mx - L2));
        if (k > 0 && k < 1) { r = L2 + (r - L2) * k; gg = L2 + (gg - L2) * k; b = L2 + (b - L2) * k; }
      }
      // Grain from the lattice, keyed to the global pixel.
      const gx = gx0 + i, gy = gy0 + j;
      const f = 1 + grain * T[((gy & 255) << 8) | ((gx + 89 * ((gy >> 8) & 255) + 47 * ((gx >> 8) & 255)) & 255)]!;
      r *= f; gg *= f; b *= f;
      const o = (j * W + i) * 4;
      out[o] = r < 0 ? 0 : r > 255 ? 255 : r + 0.5; out[o + 1] = gg < 0 ? 0 : gg > 255 ? 255 : gg + 0.5; out[o + 2] = b < 0 ? 0 : b > 255 ? 255 : b + 0.5; out[o + 3] = 255;
    }
  }
  return out;
}
