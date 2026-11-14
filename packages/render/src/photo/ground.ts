/**
 * The photo ground (plan "photo" step "ground" 4): fields with soft, organic edges and natural colour variation,
 * ploughed furrows that follow the field, crop rows with tramlines, meadow tufts, garden rows, worn yards. Writes
 * opaque RGBA words. Pure (no Pixi, no DOM); every pattern keyed to world metres, so tiles join.
 *
 * Per pixel: the 2 m macro grid (warp, tone, hue, dry patches, hillshade, furrow phase) read bilinearly; a finer
 * domain warp; the four nearest cells of the warped point, the field with the largest bilinear weight wins (so
 * stair-stepped cell edges come out as smooth curves) and blends into the runner-up over about a metre; then the
 * field's texture, tone octaves and a contrast-stretched clump octave. Amplitudes follow the readability caps (plan decision 9).
 */
import { band, tri as triImp, vnoise as vnoiseImp } from "./noise";
import * as P from "./prep";
import type { PhotoPrep } from "./prep";

/** Field-edge transition width (m) of the colour blend. */
export const EDGE_SOFT_M = 1.2;

export interface GroundOptions { furrows?: boolean }

/**
 * Paint the ground into `out` (W x H words, row-major) for the pixels gx0..gx0+W-1, gy0..gy0+H-1 of the global
 * pixel grid at `ppm` (pixel centres at (g + 0.5) / ppm metres).
 */
export function paintGround(p: PhotoPrep, out: Uint32Array, W: number, H: number, gx0: number, gy0: number, ppm: number, opt: GroundOptions = {}): void {
  // Imported functions copied into locals (module getters cost a lot in a hot loop under vitest/tsx).
  const vnoise = vnoiseImp, tri = triImp;
  const { EDGE_CAP, MACRO_CH, MACRO_M, M_DRY, M_HILL, M_HUE, M_PHASE, M_TONE, M_WX, M_WY, Tex } = P;
  const px = 1 / ppm, C = p.cols, R = p.rows, cs = p.cs, ics = 1 / cs;
  const macro = p.macro, mc = p.mcols, MCH = MACRO_CH, iM = 1 / MACRO_M;
  const fieldA = p.field, rA = p.r, gA = p.g, bA = p.b, texA = p.tex, edgeA = p.edge, fcos = p.fcos, fsin = p.fsin;
  const [grR, grG, grB] = p.grass, [stR, stG, stB] = p.straw;
  const soft = cs / (2 * EDGE_SOFT_M);
  // Band limits for this resolution (plan section 2): fine patterns fade out where they would alias.
  const bWarp2 = band(2.5, ppm), bClump = band(1.6, ppm), bClump2 = band(0.7, ppm), bFur = opt.furrows === false ? 0 : band(1.1, ppm), bRow = band(0.7, ppm);
  const bClod = band(0.33, ppm), bTuft = band(0.9, ppm), bGarden = band(0.6, ppm), bDust = band(3, ppm);
  const tramOn = ppm >= 0.6, tramHalf = 0.2, tramW = Math.max(tramHalf, 0.5 * px), tramA = Math.min(1, (2 * tramHalf) * ppm);
  const TX_PLOUGH = Tex.Plough, TX_ROWS = Tex.Rows, TX_MEADOW = Tex.Meadow, TX_GARDEN = Tex.Garden, TX_WORN = Tex.Worn, TX_GRASS = Tex.Grass;
  const fid = [0, 0, 0, 0], fw = [0, 0, 0, 0], fk = [0, 0, 0, 0];
  for (let j = 0; j < H; j++) {
    const y = (gy0 + j + 0.5) * px;
    // (The blur apron reaches half a pixel outside the map: clamped to the first macro node, never a negative index.)
    const my = y > 0 ? y * iM : 0, mj = Math.floor(my), ty = my - mj;
    for (let i = 0; i < W; i++) {
      const x = (gx0 + i + 0.5) * px;
      // ---- macro grid, bilinear
      const mx = x > 0 ? x * iM : 0, mi = Math.floor(mx), tx = mx - mi;
      const o00 = (mj * mc + mi) * MCH, o10 = o00 + MCH, o01 = o00 + mc * MCH, o11 = o01 + MCH;
      const w00 = (1 - tx) * (1 - ty), w10 = tx * (1 - ty), w01 = (1 - tx) * ty, w11 = tx * ty;
      let wx = macro[o00 + M_WX]! * w00 + macro[o10 + M_WX]! * w10 + macro[o01 + M_WX]! * w01 + macro[o11 + M_WX]! * w11;
      let wy = macro[o00 + M_WY]! * w00 + macro[o10 + M_WY]! * w10 + macro[o01 + M_WY]! * w01 + macro[o11 + M_WY]! * w11;
      const tone = macro[o00 + M_TONE]! * w00 + macro[o10 + M_TONE]! * w10 + macro[o01 + M_TONE]! * w01 + macro[o11 + M_TONE]! * w11;
      const hue = macro[o00 + M_HUE]! * w00 + macro[o10 + M_HUE]! * w10 + macro[o01 + M_HUE]! * w01 + macro[o11 + M_HUE]! * w11;
      const dry = macro[o00 + M_DRY]! * w00 + macro[o10 + M_DRY]! * w10 + macro[o01 + M_DRY]! * w01 + macro[o11 + M_DRY]! * w11;
      const hill = macro[o00 + M_HILL]! * w00 + macro[o10 + M_HILL]! * w10 + macro[o01 + M_HILL]! * w01 + macro[o11 + M_HILL]! * w11;
      const phase = macro[o00 + M_PHASE]! * w00 + macro[o10 + M_PHASE]! * w10 + macro[o01 + M_PHASE]! * w01 + macro[o11 + M_PHASE]! * w11;
      if (bWarp2 > 0) { wx += 0.5 * bWarp2 * vnoise(x * 0.4, y * 0.4, 5); wy += 0.5 * bWarp2 * vnoise(x * 0.4, y * 0.4, 7); }
      // ---- the four cells round the warped point
      const u = (x + wx) * ics - 0.5, v = (y + wy) * ics - 0.5;
      let c0 = Math.floor(u), r0 = Math.floor(v);
      const fu = u - c0, fv = v - r0;
      let c1 = c0 + 1, r1 = r0 + 1;
      if (c0 < 0) c0 = 0; if (c1 < 0) c1 = 0; if (c0 > C - 1) c0 = C - 1; if (c1 > C - 1) c1 = C - 1;
      if (r0 < 0) r0 = 0; if (r1 < 0) r1 = 0; if (r0 > R - 1) r0 = R - 1; if (r1 > R - 1) r1 = R - 1;
      const k00 = r0 * C + c0, k10 = r0 * C + c1, k01 = r1 * C + c0, k11 = r1 * C + c1;
      const a00 = (1 - fu) * (1 - fv), a10 = fu * (1 - fv), a01 = (1 - fu) * fv, a11 = fu * fv;
      const f00 = fieldA[k00]!, f10 = fieldA[k10]!, f01 = fieldA[k01]!, f11 = fieldA[k11]!;
      const edgeM = (edgeA[k00]! * a00 + edgeA[k10]! * a10 + edgeA[k01]! * a01 + edgeA[k11]! * a11) * cs;
      let cr: number, cg: number, cb: number, k: number;
      if (f00 === f10 && f00 === f01 && f00 === f11) {
        k = k00; cr = rA[k]!; cg = gA[k]!; cb = bA[k]!;
      } else {
        // Sum the weights per field; the largest wins, blended into the runner-up near the contour.
        let n = 1;
        fid[0] = f00; fw[0] = a00; fk[0] = k00;
        for (let c = 1; c < 4; c++) {
          const f = c === 1 ? f10 : c === 2 ? f01 : f11, w = c === 1 ? a10 : c === 2 ? a01 : a11, kk = c === 1 ? k10 : c === 2 ? k01 : k11;
          let q = 0;
          while (q < n && fid[q] !== f) q++;
          if (q < n) fw[q]! += w; else { fid[n] = f; fw[n] = w; fk[n] = kk; n++; }
        }
        let b1 = 0, b2 = -1;
        for (let q = 1; q < n; q++) if (fw[q]! > fw[b1]!) b1 = q;
        for (let q = 0; q < n; q++) if (q !== b1 && (b2 < 0 || fw[q]! > fw[b2]!)) b2 = q;
        k = fk[b1]!;
        const k2 = fk[b2]!;
        let t = 0.5 + (fw[b1]! - fw[b2]!) * soft;
        t = t >= 1 ? 1 : t * t * (3 - 2 * t);
        cr = rA[k2]! + (rA[k]! - rA[k2]!) * t; cg = gA[k2]! + (gA[k]! - gA[k2]!) * t; cb = bA[k2]! + (bA[k]! - bA[k2]!) * t;
      }
      const tex = texA[k]!;
      // ---- margins: fields darker and grassier near their edge; yards lighter and dustier
      const near = edgeM >= 4 ? 0 : 1 - edgeM * 0.25;
      if (near > 0 && edgeM < EDGE_CAP * cs) {
        if (tex === TX_PLOUGH || tex === TX_ROWS || tex === TX_MEADOW) {
          const m = 0.2 * near, d = 1 - 0.06 * near;
          cr = (cr + (grR - cr) * m) * d; cg = (cg + (grG - cg) * m) * d; cb = (cb + (grB - cb) * m) * d;
        } else if (tex === TX_WORN) { const d = 1 + 0.05 * near; cr *= d; cg *= d; cb *= d; }
      }
      // ---- dry patches toward straw (open grass and crops only)
      if (dry > 0.001 && (tex === TX_GRASS || tex === TX_MEADOW || tex === TX_ROWS)) {
        cr += (stR - cr) * dry; cg += (stG - cg) * dry; cb += (stB - cb) * dry;
      }
      // ---- brightness: tone octaves, hillshade, clumps, the field's texture
      let f = 1 + tone + hill;
      if (bClump > 0) {
        // Clumps of growth: two octaves, contrast-stretched so they read as patches with edges, not soft clouds.
        let cl = (vnoise(x * 0.625, y * 0.625, 41) + 0.5 * bClump2 * vnoise(x * 1.43, y * 1.43, 43)) * 1.6;
        cl = cl < -1 ? -1 : cl > 1 ? 1 : cl;
        f += 0.05 * bClump * cl;
      }
      if (tex === TX_PLOUGH) {
        const fi = fieldA[k]!, ca = fcos[fi]!, sa = fsin[fi]!;
        // Furrows along the field's long axis.
        const s = -x * sa + y * ca;
        if (bFur > 0) f += 0.07 * bFur * tri((s + phase) / 1.1);
        if (bClod > 0) f += 0.04 * bClod * (vnoise(x * 3, y * 3, 43));
      } else if (tex === TX_ROWS) {
        const fi = fieldA[k]!, ca = fcos[fi]!, sa = fsin[fi]!;
        const s = -x * sa + y * ca + phase;
        if (bRow > 0) f += 0.04 * bRow * tri(s / 0.7);
        if (tramOn) {
          // Tramline pairs 1.8 m apart every 18 m (area-true: thin lines get fainter, not wider).
          const t = s - Math.floor(s / 18) * 18;
          let d = t < 0.9 ? Math.abs(t) : Math.abs(t - 1.8);
          if (t > 9) d = Math.min(d, 18 - t);
          if (d < tramW) f -= 0.10 * tramA * (1 - d / tramW);
        }
        f += 0.03 * vnoise(x / 30, y / 30, 47); // growth and wind patches
      } else if (tex === TX_MEADOW) {
        if (bTuft > 0) { const tf = vnoise(x / 0.9, y / 0.9, 53); if (tf > 0.45) f -= 0.08 * bTuft * (tf - 0.45) * 1.8; }
      } else if (tex === TX_GARDEN) {
        const fi = fieldA[k]!;
        if (bGarden > 0) f += 0.06 * bGarden * tri((-x * fsin[fi]! + y * fcos[fi]!) / 0.6);
      } else if (tex === TX_WORN) {
        if (bDust > 0) f += 0.05 * bDust * vnoise(x / 3, y / 3, 59);
      }
      cr *= f * (1 + hue); cg *= f; cb *= f * (1 - hue);
      const R8 = cr < 0 ? 0 : cr > 255 ? 255 : cr + 0.5 | 0, G8 = cg < 0 ? 0 : cg > 255 ? 255 : cg + 0.5 | 0, B8 = cb < 0 ? 0 : cb > 255 ? 255 : cb + 0.5 | 0;
      out[j * W + i] = (0xff000000 | (B8 << 16) | (G8 << 8) | R8) >>> 0;
    }
  }
}
