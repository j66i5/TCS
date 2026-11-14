/**
 * Cast shadows and ambient darkening on the ground of the photo map (plan "photo" step "vegetation" 3, decision 10).
 * One shadow buffer per picture on a 1 m grid of world nodes, combined by maximum (no double darkening):
 *
 * - cast shadows: a node is in shadow when, looking toward the sun, something within reach stands tall enough to
 *   cast its shadow there (`SHADOW_K` m of shadow per m of height, at most `SHADOW_MAX`; the ground right below a
 *   crown's trunk side stays lit), strength 0.45;
 * - at most 0.2 on ground under a crown (the ground painter's forest floor is already in shade);
 * - ambient darkening of about 0.18 for 1-2 m round every wood edge, hedge and bush;
 * - two 3 x 3 box blurs (a soft edge of about 1.5 m), then read bilinearly per pixel, with a slight blue lift.
 *
 * Nodes are on whole metres of the world and depend only on crowns within `CROWN_REACH`, so pictures join. Pure.
 */
import type { Crowns } from "./crowns";
import { SHADOW_DIR, shadowLen } from "./crowns";

export const SHADOW_STRENGTH = 0.45;
export const AMBIENT = 0.18;
/** Most cast shadow on ground under a crown (the forest floor is painted in shade already). */
export const UNDER = 0.2;
/** Margin (nodes) of the raw grid beyond the picture: blur, sun-ward reach of the shadow, cover blur. */
const BLUR_M = 2, REACH_M = 8;

export interface ShadowGrid { nx0: number; ny0: number; nw: number; nh: number; s: Float32Array }

/** The shadow grid for the world rectangle [bx0, bx1) x [by0, by1) from `crowns` (all crowns within CROWN_REACH). */
export function shadowGrid(c: Crowns, bx0: number, by0: number, bx1: number, by1: number): ShadowGrid {
  // Output nodes (bilinear: one beyond each side).
  const nx0 = Math.floor(bx0) - 1, ny0 = Math.floor(by0) - 1, nx1 = Math.ceil(bx1) + 1, ny1 = Math.ceil(by1) + 1;
  const nw = nx1 - nx0 + 1, nh = ny1 - ny0 + 1;
  // Raw grid: blur margin; the height grid also reaches sun-ward (west, north) and the cover blur.
  const rx0 = nx0 - BLUR_M, ry0 = ny0 - BLUR_M, rw = nw + 2 * BLUR_M, rh = nh + 2 * BLUR_M;
  const hx0 = rx0 - REACH_M, hy0 = ry0 - REACH_M, hw = rw + REACH_M + 3, hh = rh + REACH_M + 3;
  const hgt = new Float32Array(hw * hh), cover = new Float32Array(hw * hh);
  for (let i = 0; i < c.n; i++) {
    const x = c.x[i]!, y = c.y[i]!, r = c.r[i]!, h = c.h[i]!;
    const i0 = Math.max(0, Math.ceil(x - r) - hx0), i1 = Math.min(hw - 1, Math.floor(x + r) - hx0);
    const j0 = Math.max(0, Math.ceil(y - r) - hy0), j1 = Math.min(hh - 1, Math.floor(y + r) - hy0);
    const rr = r * r;
    for (let j = j0; j <= j1; j++) {
      const dy = j + hy0 - y;
      for (let ii = i0; ii <= i1; ii++) {
        const dx = ii + hx0 - x;
        if (dx * dx + dy * dy > rr) continue;
        const k = j * hw + ii;
        if (hgt[k]! < h) hgt[k] = h;
        cover[k] = 1;
      }
    }
  }
  // Cover blurred over 5 x 5 (ambient reaches about 2 m out).
  const cb = boxBlur(boxBlur(cover, hw, hh, 2), hw, hh, 0);
  // Raw shadow: sun-ward samples every 0.75 m up to the longest shadow.
  const raw = new Float32Array(rw * rh);
  const ux = -SHADOW_DIR.x, uy = -SHADOW_DIR.y, NS = 8, STEP = 0.75;
  const offI = new Int32Array(NS), tS = new Float32Array(NS);
  for (let s = 0; s < NS; s++) { const t = (s + 1) * STEP; tS[s] = t; offI[s] = Math.round(t * uy) * hw + Math.round(t * ux); }
  for (let j = 0; j < rh; j++) for (let i = 0; i < rw; i++) {
    const hk = (j + REACH_M) * hw + (i + REACH_M);
    let v = 0;
    for (let s = 0; s < NS; s++) {
      const h = hgt[hk + offI[s]!]!;
      if (h <= 0) continue;
      const L = shadowLen(h), t = tS[s]!;
      if (t <= L + 0.4 && t >= 0.3 * L) { v = SHADOW_STRENGTH; break; }
    }
    // Under a crown the ground is the forest floor, already painted in shade: only a little more there.
    if (cover[hk]! > 0 && v > UNDER) v = UNDER;
    const a = AMBIENT * Math.min(1, cb[hk]! * 1.6);
    raw[j * rw + i] = v > a ? v : a;
  }
  // Two 3 x 3 box blurs, then crop to the output nodes.
  const bl = boxBlur(boxBlur(raw, rw, rh, 1), rw, rh, 1);
  const s = new Float32Array(nw * nh);
  for (let j = 0; j < nh; j++) for (let i = 0; i < nw; i++) s[j * nw + i] = bl[(j + BLUR_M) * rw + i + BLUR_M]!;
  return { nx0, ny0, nw, nh, s };
}

/** Separable box blur of radius `r` (r 0: a copy). Edges clamp. */
function boxBlur(a: Float32Array, w: number, h: number, r: number): Float32Array {
  if (r === 0) return a;
  const t = new Float32Array(w * h), o = new Float32Array(w * h), n = 2 * r + 1;
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    let s = 0;
    for (let d = -r; d <= r; d++) { const x = i + d < 0 ? 0 : i + d >= w ? w - 1 : i + d; s += a[j * w + x]!; }
    t[j * w + i] = s / n;
  }
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    let s = 0;
    for (let d = -r; d <= r; d++) { const y = j + d < 0 ? 0 : j + d >= h ? h - 1 : j + d; s += t[y * w + i]!; }
    o[j * w + i] = s / n;
  }
  return o;
}

/**
 * Darken `buf` (W x H words; global pixel gx0, gy0 at `ppm`) by the shadow grid, read bilinearly, combined by maximum
 * with `extra` (per pixel, 0..1: buildings, walls, fences; step "built"). Either may be null.
 */
export function applyShadows(g: ShadowGrid | null, buf: Uint32Array, W: number, H: number, gx0: number, gy0: number, ppm: number, extra: Float32Array | null = null): void {
  if (!g && !extra) return;
  const s = g?.s, nw = g?.nw ?? 0, px = 1 / ppm, nx0 = g?.nx0 ?? 0, ny0 = g?.ny0 ?? 0;
  for (let j = 0; j < H; j++) {
    const y = (gy0 + j + 0.5) * px - ny0, jj = Math.floor(y), ty = y - jj;
    for (let i = 0; i < W; i++) {
      const p = j * W + i;
      let v = extra ? extra[p]! : 0;
      if (s) {
        const x = (gx0 + i + 0.5) * px - nx0, ii = Math.floor(x), tx = x - ii, o = jj * nw + ii;
        const a = s[o]!, b = s[o + 1]!, c = s[o + nw]!, d = s[o + nw + 1]!;
        if (a + b + c + d >= 0.004) { const gv = a + (b - a) * tx + (c - a + (d - c - b + a) * tx) * ty; if (gv > v) v = gv; }
      }
      if (v < 0.001) continue;
      const w = buf[p]!, k = 1 - v, kb = k * (1 + 0.05 * v);
      const r = (w & 255) * k + 0.5 | 0, gg = ((w >>> 8) & 255) * k + 0.5 | 0, bb = ((w >>> 16) & 255) * kb + 0.5 | 0;
      buf[p] = (0xff000000 | ((bb > 255 ? 255 : bb) << 16) | (gg << 8) | r) >>> 0;
    }
  }
}
