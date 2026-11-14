/**
 * Roads, tracks, water, bridges, walls, fences, embankments and building ground shadows of the photo map (plan
 * "photo" step "built"). Pure (no Pixi, no DOM, no random, no clock); everything keyed to world metres, so tiles join.
 *
 * - Roads and tracks: the signed distance e = d - halfWidth, the minimum over all road segments with the winning
 *   segment kept (wider roads win where roads meet, ends get round caps: no pinch at junctions). The edge is wobbled
 *   by noise (+-0.18 m paved, +-0.4 m tracks), the alpha ramp is about one pixel, a dusty verge of 1.5 m fades into the
 *   field. Asphalt: neutral dark grey, worn lighter edges, 3 m patches. Gravel: coarse grain. Dirt tracks: lighter,
 *   two darker ruts, a lighter crown and a grassy centre strip when 3 m or wider. At least 2.4 px wide at any zoom.
 * - Water: streams by distance to the centre line, ponds by distance to the shore (inside test), a damp mud bank of
 *   1.4 m, shallow colour at the edge grading to deep, a slow sheen and fine ripples. No outline. Streams at least
 *   2 px wide.
 * - Bridges: where a road crosses water, a deck in the road colour with a lit (west-north-west) and a shaded edge, a
 *   narrow dark band of water under each edge and the deck's soft shadow on the water toward the east-south-east.
 * - Walls: a pale band (at least 0.6 m and 1.5 px) with a block texture and a lighter crest, a cast shadow along the
 *   sun and ambient darkening at the foot. Wooden fences: a thin dark line with posts (from 4 px/m) and a faint
 *   shadow; wire fences a lighter broken line; no fences below 2.5 px/m. Embankments: lit on the sun side, shaded on
 *   the other.
 * - Building ground shadows: the footprint swept along the sun (convex hull of the footprint and its shadow), alpha
 *   0.5, a soft edge of 0.9 m. They are part of the ground, so they stay when the roof fades.
 *
 * Shadows go into one buffer combined by maximum with the crowns' shadows (`shadows.ts`), applied once.
 */
import type { MapDef } from "@tcs/sim";
import type { FlatColours } from "../flat/paint";
import { band, hash2, vnoise as vnoiseImp } from "./noise";
import { SHADOW_K, SHADOW_MAX, SUN } from "./light";

/** Road kinds (presentation). */
export const RK = { Paved: 0, Gravel: 1, Dirt: 2 } as const;
/** Obstacle kinds drawn here (hedges are crowns). */
export const OK_ = { Wall: 0, Wooden: 1, Wire: 2, Embankment: 3 } as const;

/** Minimum on-screen widths (px; plan section 2). */
export const ROAD_MIN_PX = 2.4, STREAM_MIN_PX = 2, WALL_MIN_PX = 1.5;
/** Fences appear from this many px/m. */
export const FENCE_FROM_PPM = 2.5;
/** Dust verge of roads (m), bank of water (m), the pond's shallow rim outside its polygon (m). */
export const VERGE_M = 1.5, BANK_M = 1.4, POND_RIM_M = 1.5;
/** Building shadows: strength and penumbra (m). Height of a pitched roof above the eaves (m). */
export const BUILDING_SHADOW = 0.5, BUILDING_PENUMBRA = 0.9, ROOF_RISE_M = 2.2;
/** Deck of a bridge: height above the water (m). */
export const DECK_H = 2;
/** A road is a bridge deck within this distance (m) of water (the abutments reach onto the banks). */
export const DECK_REACH = 0.8;
/** How far (m) a line feature reaches beyond its centre line plus half-width (wobble, verge, bank). */
const LINE_REACH = 2.2;
/** Mud of banks, dust of verges (photo palette; presentation constants). */
const MUD = [0x5c, 0x4e, 0x3f] as const;
const DUST = [0x9c, 0x8f, 0x76] as const;

const SH_LEN = Math.sqrt(SUN.x * SUN.x + SUN.y * SUN.y);
/** Shadow direction on the ground (unit, toward the east-south-east). */
const SDX = -SUN.x / SH_LEN, SDY = -SUN.y / SH_LEN;

export interface LinePrep {
  /** Road segments: ax, ay, bx, by, half-width, road index, kind (RS per segment). */
  rseg: Float32Array; nr: number;
  /** Per road: colour (r, g, b, 0..255). */
  rcol: Float32Array;
  /** Stream segments: ax, ay, bx, by, half-width (SS per segment). */
  sseg: Float32Array; ns: number;
  ponds: { pts: Float64Array; minX: number; minY: number; maxX: number; maxY: number }[];
  /** Obstacle segments (not hedges): ax, ay, bx, by, half-width, kind, height, arc length at a, colour (OS per segment). */
  oseg: Float32Array; no: number;
  /** Building ground shadows: convex hulls of footprint + shadow. */
  bshadow: { pts: Float64Array; minX: number; minY: number; maxX: number; maxY: number }[];
  waterShallow: [number, number, number]; waterDeep: [number, number, number];
  grass: [number, number, number];
}
const RS = 7, SS = 5, OS = 9;

const rgb = (c: number): [number, number, number] => [(c >> 16) & 255, (c >> 8) & 255, c & 255];

/** Convex hull (monotone chain) of points [x0, y0, ...]: counter-clockwise in y-up terms. */
export function convexHull(p: readonly number[]): number[] {
  const n = p.length / 2, idx = Array.from({ length: n }, (_, i) => i);
  idx.sort((a, b) => p[2 * a]! - p[2 * b]! || p[2 * a + 1]! - p[2 * b + 1]!);
  const cross = (o: number, a: number, b: number) => (p[2 * a]! - p[2 * o]!) * (p[2 * b + 1]! - p[2 * o + 1]!) - (p[2 * a + 1]! - p[2 * o + 1]!) * (p[2 * b]! - p[2 * o]!);
  const lo: number[] = [], hi: number[] = [];
  for (const i of idx) { while (lo.length >= 2 && cross(lo[lo.length - 2]!, lo[lo.length - 1]!, i) <= 0) lo.pop(); lo.push(i); }
  for (let k = idx.length - 1; k >= 0; k--) { const i = idx[k]!; while (hi.length >= 2 && cross(hi[hi.length - 2]!, hi[hi.length - 1]!, i) <= 0) hi.pop(); hi.push(i); }
  const h = lo.slice(0, -1).concat(hi.slice(0, -1));
  return h.flatMap((i) => [p[2 * i]!, p[2 * i + 1]!]);
}

/** Signed distance (m) from (x, y) to a polygon's outline: positive inside. */
export function polySd(p: ArrayLike<number>, x: number, y: number): number {
  const n = p.length >> 1;
  let inside = false, best = Infinity;
  for (let a = 0, b = n - 1; a < n; b = a++) {
    const ax = p[2 * a]!, ay = p[2 * a + 1]!, bx = p[2 * b]!, by = p[2 * b + 1]!;
    if ((ay > y) !== (by > y) && x < ((bx - ax) * (y - ay)) / (by - ay) + ax) inside = !inside;
    const ex = bx - ax, ey = by - ay, L2 = ex * ex + ey * ey || 1e-12;
    let u = ((x - ax) * ex + (y - ay) * ey) / L2;
    u = u < 0 ? 0 : u > 1 ? 1 : u;
    const dx = x - ax - u * ex, dy = y - ay - u * ey, d2 = dx * dx + dy * dy;
    if (d2 < best) best = d2;
  }
  const d = Math.sqrt(best);
  return inside ? d : -d;
}

export function prepareLines(map: MapDef, col: FlatColours, grass: [number, number, number]): LinePrep {
  // ---- roads (one colour per road; kind by surface)
  const rl: number[] = [], rc: number[] = [];
  map.roads.forEach((r, ri) => {
    const kind = r.surface === "dirt-track" || r.surface === "mud" ? RK.Dirt : r.surface === "gravel" ? RK.Gravel : RK.Paved;
    const [cr, cg, cb] = rgb(col.road[r.surface] ?? 0x777777);
    // Dirt tracks a little lighter than the soil (worn, dry), plan "built" 1.
    const k = kind === RK.Dirt ? 1.06 : 1;
    rc.push(cr * k, cg * k, cb * k);
    for (let i = 0; i + 3 < r.points.length; i += 2) rl.push(r.points[i]!, r.points[i + 1]!, r.points[i + 2]!, r.points[i + 3]!, r.widthM / 2, ri, kind);
    if (r.points.length === 2) rl.push(r.points[0]!, r.points[1]!, r.points[0]!, r.points[1]!, r.widthM / 2, ri, kind);
  });
  // ---- water
  const sl: number[] = [];
  const ponds: LinePrep["ponds"] = [];
  for (const w of map.water) {
    if (w.kind === "stream") { for (let i = 0; i + 3 < w.points.length; i += 2) sl.push(w.points[i]!, w.points[i + 1]!, w.points[i + 2]!, w.points[i + 3]!, w.widthM / 2); }
    else if (w.points.length >= 6) ponds.push({ pts: Float64Array.from(w.points), ...bbox(w.points) });
  }
  // ---- walls, fences, embankments
  const ol: number[] = [];
  for (const o of map.obstacles) {
    if (o.kind === "hedge") continue;
    const kind = o.kind === "wooden-fence" ? OK_.Wooden : o.kind === "wire-fence" ? OK_.Wire : o.kind === "embankment" ? OK_.Embankment : OK_.Wall;
    const c = col.obstacle[o.kind] ?? 0xb0aa9e;
    let s = 0;
    for (let i = 0; i + 3 < o.points.length; i += 2) {
      const ax = o.points[i]!, ay = o.points[i + 1]!, bx = o.points[i + 2]!, by = o.points[i + 3]!;
      ol.push(ax, ay, bx, by, o.thicknessM / 2, kind, o.heightM, s, c);
      s += Math.sqrt((bx - ax) * (bx - ax) + (by - ay) * (by - ay));
    }
  }
  // ---- building ground shadows: the hull of the footprint and the footprint moved along the shadow
  const bshadow: LinePrep["bshadow"] = [];
  for (const b of map.buildings) {
    const flat = b.kind === "warehouse" || b.kind === "apartment-block" || b.kind === "office";
    const h = b.storeys * b.storeyHeightM + (flat ? 0.6 : ROOF_RISE_M);
    const L = Math.min(SHADOW_MAX, SHADOW_K * h), fp = b.footprint;
    const all = [...fp];
    for (let k = 0; k < fp.length; k += 2) all.push(fp[k]! + SDX * L, fp[k + 1]! + SDY * L);
    const hull = convexHull(all);
    bshadow.push({ pts: Float64Array.from(hull), ...bbox(hull) });
  }
  return {
    rseg: Float32Array.from(rl), nr: rl.length / RS, rcol: Float32Array.from(rc),
    sseg: Float32Array.from(sl), ns: sl.length / SS, ponds,
    oseg: Float32Array.from(ol), no: ol.length / OS, bshadow,
    waterShallow: rgb(col.waterShallow), waterDeep: rgb(col.waterDeep), grass,
  };
}

function bbox(p: ArrayLike<number>): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let k = 0; k < p.length; k += 2) { minX = Math.min(minX, p[k]!); maxX = Math.max(maxX, p[k]!); minY = Math.min(minY, p[k + 1]!); maxY = Math.max(maxY, p[k + 1]!); }
  return { minX, minY, maxX, maxY };
}

/**
 * Scratch of one picture: the line grid is the picture plus a pad of P pixels on every side (so the deck shadow can
 * look a metre toward the sun at the picture's edge), at global pixel (lgx0, lgy0).
 */
export interface LineScratch {
  P: number; LW: number; LH: number; lgx0: number; lgy0: number;
  /** Water: signed distance to the water's edge (negative in the water), depth 0..1, coverage after painting. */
  we: Float32Array; wd: Float32Array; wa: Float32Array;
  /** Roads: e = d - halfWidth (min), the winning segment. */
  re: Float32Array; rs: Int32Array;
}

export function lineScratch(W: number, H: number, gx0: number, gy0: number, ppm: number): LineScratch {
  const P = Math.ceil(1.2 * ppm) + 1, LW = W + 2 * P, LH = H + 2 * P, N = LW * LH;
  return { P, LW, LH, lgx0: gx0 - P, lgy0: gy0 - P, we: new Float32Array(N).fill(1e9), wd: new Float32Array(N), wa: new Float32Array(N), re: new Float32Array(N).fill(1e9), rs: new Int32Array(N).fill(-1) };
}

/** Pixel range of the line grid that a world box touches (or null). */
function range(s: LineScratch, ppm: number, x0: number, y0: number, x1: number, y1: number) {
  const i0 = Math.max(0, Math.floor(x0 * ppm) - s.lgx0), i1 = Math.min(s.LW - 1, Math.ceil(x1 * ppm) - s.lgx0);
  const j0 = Math.max(0, Math.floor(y0 * ppm) - s.lgy0), j1 = Math.min(s.LH - 1, Math.ceil(y1 * ppm) - s.lgy0);
  return i0 > i1 || j0 > j1 ? null : { i0, i1, j0, j1 };
}

/** Rasterise segments' (distance - half-width) into a min buffer over the line grid. */
function rasterSegs(segs: Float32Array, stride: number, n: number, hwMin: number, reach: number, s: LineScratch, ppm: number, e: Float32Array, win: Int32Array | null, depth: Float32Array | null): void {
  const px = 1 / ppm;
  for (let q = 0; q < n; q++) {
    const o = q * stride, ax = segs[o]!, ay = segs[o + 1]!, bx = segs[o + 2]!, by = segs[o + 3]!;
    const hw = Math.max(segs[o + 4]!, hwMin), m = hw + reach;
    const r = range(s, ppm, Math.min(ax, bx) - m, Math.min(ay, by) - m, Math.max(ax, bx) + m, Math.max(ay, by) + m);
    if (!r) continue;
    const ex = bx - ax, ey = by - ay, L2 = ex * ex + ey * ey || 1e-12;
    for (let j = r.j0; j <= r.j1; j++) {
      const y = (s.lgy0 + j + 0.5) * px;
      for (let i = r.i0; i <= r.i1; i++) {
        const x = (s.lgx0 + i + 0.5) * px;
        let u = ((x - ax) * ex + (y - ay) * ey) / L2;
        u = u < 0 ? 0 : u > 1 ? 1 : u;
        const dx = x - ax - u * ex, dy = y - ay - u * ey, d = Math.sqrt(dx * dx + dy * dy), v = d - hw, k = j * s.LW + i;
        const cur = e[k]!;
        if (win) {
          // Roads: where two cover the pixel the wider wins (no narrow track drawn across a main road's edge).
          const w0 = win[k]!;
          if (w0 >= 0 && cur < 0.5 && v < 0.5) {
            const h0 = segs[w0 * stride + 4]!;
            const hr = segs[o + 4]!;
            if (hr > h0 + 0.01 || (Math.abs(hr - h0) <= 0.01 && v < cur)) { e[k] = v; win[k] = q; }
            continue;
          }
          if (v < cur) { e[k] = v; win[k] = q; }
        } else if (v < cur) e[k] = v;
        if (depth) { const dd = 1 - d / hw; if (dd > depth[k]!) depth[k] = dd; }
      }
    }
  }
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const pack = (r: number, g: number, b: number) => (0xff000000 | ((b < 0 ? 0 : b > 255 ? 255 : b + 0.5 | 0) << 16) | ((g < 0 ? 0 : g > 255 ? 255 : g + 0.5 | 0) << 8) | (r < 0 ? 0 : r > 255 ? 255 : r + 0.5 | 0)) >>> 0;

/**
 * Embankments (before water and roads): a raised strip, lit on the sun side and shaded on the other, its soil
 * showing through the grass toward the crest.
 */
export function paintEmbankments(lp: LinePrep, buf: Uint32Array, W: number, H: number, gx0: number, gy0: number, ppm: number): void {
  const px = 1 / ppm, seg = lp.oseg;
  for (let q = 0; q < lp.no; q++) {
    const o = q * OS;
    if (seg[o + 5] !== OK_.Embankment) continue;
    const ax = seg[o]!, ay = seg[o + 1]!, bx = seg[o + 2]!, by = seg[o + 3]!, hw = seg[o + 4]!, c = seg[o + 8]!;
    const m = hw + 1;
    const i0 = Math.max(0, Math.floor((Math.min(ax, bx) - m) * ppm) - gx0), i1 = Math.min(W - 1, Math.ceil((Math.max(ax, bx) + m) * ppm) - gx0);
    const j0 = Math.max(0, Math.floor((Math.min(ay, by) - m) * ppm) - gy0), j1 = Math.min(H - 1, Math.ceil((Math.max(ay, by) + m) * ppm) - gy0);
    if (i0 > i1 || j0 > j1) continue;
    const ex = bx - ax, ey = by - ay, L = Math.sqrt(ex * ex + ey * ey) || 1e-9, L2 = L * L, nx = -ey / L, ny = ex / L;
    // Which side faces the sun: the normal's dot with the direction toward the sun on the ground.
    const lit = -(nx * SDX + ny * SDY);
    const cr = (c >> 16) & 255, cg = (c >> 8) & 255, cb = c & 255;
    for (let j = j0; j <= j1; j++) {
      const y = (gy0 + j + 0.5) * px;
      for (let i = i0; i <= i1; i++) {
        const x = (gx0 + i + 0.5) * px;
        const u = ((x - ax) * ex + (y - ay) * ey) / L2;
        if (u < 0 || u > 1) continue; // segments meet end to end: no caps (no double shading at joints)
        const side = (x - ax) * nx + (y - ay) * ny, ad = side < 0 ? -side : side;
        if (ad > hw + 0.5) continue;
        const cov = clamp01((hw + 0.5 - ad) / 1.0);
        // Slopes on the outer 70 %, a flat crest in the middle.
        const slope = clamp01((ad - 0.3 * hw) / (0.2 * hw)) * (side < 0 ? -1 : 1);
        const f = 1 + 0.16 * lit * slope;
        const soil = 0.3 * clamp01(1 - ad / hw) * (0.7 + 0.3 * vnoiseImp(x / 3, y / 3, 81));
        const p = j * W + i, w = buf[p]!;
        const r0 = w & 255, g0 = (w >>> 8) & 255, b0 = (w >>> 16) & 255;
        const r = (r0 + (cr - r0) * soil) * f, g = (g0 + (cg - g0) * soil) * f, b = (b0 + (cb - b0) * soil) * f;
        buf[p] = pack(r0 + (r - r0) * cov, g0 + (g - g0) * cov, b0 + (b - b0) * cov);
      }
    }
  }
}

/** Water: streams and ponds, with banks. Fills the scratch's water buffers; paints the picture part. */
export function paintWater(lp: LinePrep, s: LineScratch, buf: Uint32Array, W: number, H: number, ppm: number): void {
  if (lp.ns === 0 && lp.ponds.length === 0) return;
  const px = 1 / ppm, we = s.we, wd = s.wd, wa = s.wa, LW = s.LW;
  rasterSegs(lp.sseg, SS, lp.ns, (STREAM_MIN_PX / 2) * px, BANK_M + 0.6, s, ppm, we, null, wd);
  for (const pd of lp.ponds) {
    const m = POND_RIM_M + BANK_M + 0.6;
    const r = range(s, ppm, pd.minX - m, pd.minY - m, pd.maxX + m, pd.maxY + m);
    if (!r) continue;
    for (let j = r.j0; j <= r.j1; j++) {
      const y = (s.lgy0 + j + 0.5) * px;
      for (let i = r.i0; i <= r.i1; i++) {
        const x = (s.lgx0 + i + 0.5) * px, sd = polySd(pd.pts, x, y), k = j * LW + i;
        const v = -(sd + POND_RIM_M);
        if (v < we[k]!) we[k] = v;
        const dd = clamp01((sd + POND_RIM_M) / 6);
        if (dd > wd[k]!) wd[k] = dd;
      }
    }
  }
  const [sr, sg, sb] = lp.waterShallow, [dr, dg, db] = lp.waterDeep;
  const bRip = band(0.8, ppm), bBank = band(1.2, ppm), P = s.P;
  for (let j = 0; j < s.LH; j++) {
    const y = (s.lgy0 + j + 0.5) * px, inPic = j >= P && j < P + H;
    for (let i = 0; i < LW; i++) {
      const k = j * LW + i, e0 = we[k]!;
      if (e0 > BANK_M + 0.5) continue;
      const x = (s.lgx0 + i + 0.5) * px;
      const e = e0 + 0.25 * vnoiseImp(x / 2.3, y / 2.3, 83) + 0.1 * bBank * vnoiseImp(x / 0.9, y / 0.9, 85);
      const a = clamp01(0.5 - e * ppm);
      wa[k] = a;
      if (!inPic || i < P || i >= P + W) continue;
      const p = (j - P) * W + (i - P), w = buf[p]!;
      let r = w & 255, g = (w >>> 8) & 255, b = (w >>> 16) & 255;
      // Damp mud bank.
      if (e > -0.3 && e < BANK_M) {
        const t = 0.5 * clamp01(1 - e / BANK_M) * (0.75 + 0.25 * vnoiseImp(x / 1.7, y / 1.7, 87));
        r += (MUD[0] - r) * t; g += (MUD[1] - g) * t; b += (MUD[2] - b) * t;
      }
      if (a > 0) {
        const d = clamp01(wd[k]! * 1.25);
        const f = 1 + 0.1 * vnoiseImp(x / 14, y / 9, 89) + 0.04 * bRip * vnoiseImp(x / 0.8, y / 0.35, 91);
        const wr = (sr + (dr - sr) * d) * f, wg = (sg + (dg - sg) * d) * f, wb = (sb + (db - sb) * d) * f;
        r += (wr - r) * a; g += (wg - g) * a; b += (wb - b) * a;
      }
      buf[p] = pack(r, g, b);
    }
  }
}

/** Roads and tracks, then bridges where a road crosses water (deck, dark water under its edges, its shadow). */
export function paintRoads(lp: LinePrep, s: LineScratch, buf: Uint32Array, W: number, H: number, ppm: number): void {
  if (lp.nr === 0) return;
  const px = 1 / ppm, re = s.re, rs = s.rs, LW = s.LW, P = s.P, seg = lp.rseg, rcol = lp.rcol, wa = s.wa;
  const vnoise = vnoiseImp;
  rasterSegs(seg, RS, lp.nr, (ROAD_MIN_PX / 2) * px, VERGE_M + 0.6, s, ppm, re, rs, null);
  const [gr, gg, gb] = lp.grass;
  const bRut = band(0.5, ppm), bGrit = band(0.3, ppm), bPatch = band(1.2, ppm);
  // The deck's shadow on the water: the pixel a deck-height shadow length toward the sun.
  const dL = SHADOW_K * DECK_H, sOff = Math.round(-SDY * dL * ppm) * LW + Math.round(-SDX * dL * ppm);
  for (let j = P; j < P + H; j++) {
    const y = (s.lgy0 + j + 0.5) * px;
    for (let i = P; i < P + W; i++) {
      const k = j * LW + i, e0 = re[k]!;
      if (e0 > VERGE_M + 0.5) continue;
      const q = rs[k]!, o = q * RS, ri = seg[o + 5]!, kind = seg[o + 6]!, hw = Math.max(seg[o + 4]!, (ROAD_MIN_PX / 2) * px);
      const x = (s.lgx0 + i + 0.5) * px;
      const wobA = kind === RK.Paved ? 0.18 : 0.4;
      const e = e0 + wobA * (0.7 * vnoise(x / 2.1, y / 2.1, 101) + 0.3 * vnoise(x / 0.7, y / 0.7, 103));
      const a = clamp01(0.5 - e * ppm), d = e0 + hw; // distance from the centre line
      const p = (j - P) * W + (i - P), w = buf[p]!;
      let r = w & 255, g = (w >>> 8) & 255, b = (w >>> 16) & 255;
      const deck = s.we[k]! < DECK_REACH;
      // Verge: dust into the field (not on water).
      if (e > -0.5 && e < VERGE_M && !deck) {
        const patch = 0.6 + 0.4 * vnoise(x / 4, y / 4, 105);
        const t = 0.3 * patch * (1 - clamp01(e / VERGE_M));
        const vr = kind === RK.Dirt ? rcol[ri * 3]! : DUST[0], vg = kind === RK.Dirt ? rcol[ri * 3 + 1]! : DUST[1], vb = kind === RK.Dirt ? rcol[ri * 3 + 2]! : DUST[2];
        r += (vr - r) * t; g += (vg - g) * t; b += (vb - b) * t;
      }
      if (deck && e > 0 && e < 0.45) { const t = 0.3 * (1 - e / 0.45); r *= 1 - t; g *= 1 - t; b *= 1 - t * 0.8; } // dark water under the deck edge
      if (a > 0) {
        let cr = rcol[ri * 3]!, cg = rcol[ri * 3 + 1]!, cb = rcol[ri * 3 + 2]!;
        let f = 1 + 0.06 * vnoise(x / 9, y / 9, 107) + 0.05 * bPatch * vnoise(x / 3, y / 3, 109);
        const edgeIn = -e; // metres inside the edge
        if (kind === RK.Paved) {
          if (edgeIn < 0.6) f *= 1 + 0.06 * (1 - edgeIn / 0.6); // worn, dusty edges
          f += 0.03 * bGrit * (hash2(Math.floor(x * 4), Math.floor(y * 4), 111) - 0.5);
        } else if (kind === RK.Gravel) {
          f += 0.1 * bGrit * (hash2(Math.floor(x * 4), Math.floor(y * 4), 113) - 0.5);
        } else {
          // Dirt track: two ruts, a lighter crown, a grassy centre strip on wider tracks.
          const rut = Math.abs(d - 0.55 * hw);
          if (rut < 0.3) f *= 1 - 0.14 * bRut * (1 - rut / 0.3) * (0.7 + 0.3 * vnoise(x / 1.5, y / 1.5, 115));
          else if (d < 0.4 * hw) f *= 1.04;
          if (hw >= 1.5 && d < 0.22 * hw) {
            const t = 0.45 * bRut * clamp01((0.22 * hw - d) / 0.25) * (0.5 + 0.5 * vnoise(x / 1.3, y / 1.3, 117));
            cr += (gr - cr) * t; cg += (gg - cg) * t; cb += (gb - cb) * t;
          }
          f += 0.06 * bGrit * (hash2(Math.floor(x * 3), Math.floor(y * 3), 119) - 0.5);
        }
        if (deck) {
          // Bridge deck: lit edge on the sun side, shaded edge on the other.
          // A parapet kerb 0.4 m wide on each side (at least a pixel), lit or shaded; the deck a little lighter.
          if (edgeIn < Math.max(0.4, px)) {
            const ax = seg[o]!, ay = seg[o + 1]!, ex = seg[o + 2]! - ax, ey = seg[o + 3]! - ay;
            const side = (x - ax) * -ey + (y - ay) * ex >= 0 ? 1 : -1, L = Math.sqrt(ex * ex + ey * ey) || 1;
            const towardSun = -(side * -ey / L * SDX + side * ex / L * SDY);
            f *= towardSun > 0 ? 1.35 : 0.62;
          } else f *= 1.06;
        }
        cr *= f; cg *= f; cb *= f;
        r += (cr - r) * a; g += (cg - g) * a; b += (cb - b) * a;
      }
      buf[p] = pack(r, g, b);
    }
  }
  // Bridges: the deck's shadow on the water beside it (toward the east-south-east).
  if (lp.ns + lp.ponds.length === 0) return;
  for (let j = P; j < P + H; j++) for (let i = P; i < P + W; i++) {
    const k = j * LW + i;
    if (wa[k]! < 0.3 || re[k]! < 0.1) continue;
    const k2 = k + sOff;
    if (re[k2]! < 0 && s.we[k2]! < DECK_REACH) {
      const p = (j - P) * W + (i - P), w = buf[p]!, sh = 0.42;
      buf[p] = pack((w & 255) * (1 - sh), ((w >>> 8) & 255) * (1 - sh), ((w >>> 16) & 255) * (1 - sh * 0.9));
    }
  }
}

/**
 * Ground shadows of buildings, walls and fences, and the ambient darkening at the foot of walls, into `sh` (W x H,
 * 0..1, combined by maximum).
 */
export function lineShadows(lp: LinePrep, sh: Float32Array, W: number, H: number, gx0: number, gy0: number, ppm: number): boolean {
  const px = 1 / ppm;
  let any = false;
  for (const bs of lp.bshadow) {
    const m = BUILDING_PENUMBRA;
    const i0 = Math.max(0, Math.floor((bs.minX - m) * ppm) - gx0), i1 = Math.min(W - 1, Math.ceil((bs.maxX + m) * ppm) - gx0);
    const j0 = Math.max(0, Math.floor((bs.minY - m) * ppm) - gy0), j1 = Math.min(H - 1, Math.ceil((bs.maxY + m) * ppm) - gy0);
    if (i0 > i1 || j0 > j1) continue;
    any = true;
    for (let j = j0; j <= j1; j++) {
      const y = (gy0 + j + 0.5) * px;
      for (let i = i0; i <= i1; i++) {
        const x = (gx0 + i + 0.5) * px, sd = polySd(bs.pts, x, y);
        if (sd < -m) continue;
        const t = clamp01(0.5 + sd / m), v = BUILDING_SHADOW * t * t * (3 - 2 * t), p = j * W + i;
        if (v > sh[p]!) sh[p] = v;
      }
    }
  }
  const seg = lp.oseg, fences = ppm >= FENCE_FROM_PPM;
  for (let q = 0; q < lp.no; q++) {
    const o = q * OS, kind = seg[o + 5]!;
    if (kind === OK_.Embankment || (kind !== OK_.Wall && !fences)) continue;
    const ax = seg[o]!, ay = seg[o + 1]!, bx = seg[o + 2]!, by = seg[o + 3]!;
    const wall = kind === OK_.Wall, hw = wall ? Math.max(seg[o + 4]!, 0.3, (WALL_MIN_PX / 2) * px) : 0.08;
    const L = Math.min(SHADOW_MAX, SHADOW_K * seg[o + 6]!), sx = SDX * L, sy = SDY * L;
    const strength = wall ? 0.48 : kind === OK_.Wooden ? 0.12 : 0.05, amb = wall ? 0.22 : 0, ambW = 1.0, soft = wall ? 0.4 : 0.15;
    const m = hw + L + ambW + soft;
    const i0 = Math.max(0, Math.floor((Math.min(ax, bx) - m) * ppm) - gx0), i1 = Math.min(W - 1, Math.ceil((Math.max(ax, bx) + m) * ppm) - gx0);
    const j0 = Math.max(0, Math.floor((Math.min(ay, by) - m) * ppm) - gy0), j1 = Math.min(H - 1, Math.ceil((Math.max(ay, by) + m) * ppm) - gy0);
    if (i0 > i1 || j0 > j1) continue;
    any = true;
    const ex = bx - ax, ey = by - ay, L2 = ex * ex + ey * ey || 1e-12;
    // The shadow: the segment swept along (sx, sy), as distance to the parallelogram a, b, b + s, a + s.
    const det = ex * sy - ey * sx;
    for (let j = j0; j <= j1; j++) {
      const y = (gy0 + j + 0.5) * px;
      for (let i = i0; i <= i1; i++) {
        const x = (gx0 + i + 0.5) * px, p = j * W + i;
        let u = ((x - ax) * ex + (y - ay) * ey) / L2;
        u = u < 0 ? 0 : u > 1 ? 1 : u;
        const dx = x - ax - u * ex, dy = y - ay - u * ey, d = Math.sqrt(dx * dx + dy * dy);
        let v = amb > 0 && d < hw + ambW ? amb * (1 - (d - hw) / ambW) : 0;
        // Distance to the swept band: solve x - a = U e + T s.
        let dist: number;
        if (Math.abs(det) > 1e-9) {
          const rx = x - ax, ry = y - ay, U = (rx * sy - ry * sx) / det, T = (ex * ry - ey * rx) / det;
          if (U >= 0 && U <= 1 && T >= 0 && T <= 1) dist = 0;
          else {
            // Nearest of the four edges.
            dist = Math.min(segD(x, y, ax, ay, bx, by), segD(x, y, ax + sx, ay + sy, bx + sx, by + sy), segD(x, y, ax, ay, ax + sx, ay + sy), segD(x, y, bx, by, bx + sx, by + sy));
          }
        } else dist = d;
        dist -= hw;
        if (dist < soft) { const t = clamp01(0.5 - dist / soft); const c = strength * t; if (c > v) v = c; }
        if (v > sh[p]!) sh[p] = v;
      }
    }
  }
  return any;
}

function segD(x: number, y: number, ax: number, ay: number, bx: number, by: number): number {
  const ex = bx - ax, ey = by - ay, L2 = ex * ex + ey * ey || 1e-12;
  let u = ((x - ax) * ex + (y - ay) * ey) / L2;
  u = u < 0 ? 0 : u > 1 ? 1 : u;
  const dx = x - ax - u * ex, dy = y - ay - u * ey;
  return Math.sqrt(dx * dx + dy * dy);
}

/** Walls (a pale band with blocks, a lighter crest, lit and shaded faces) and fences, after the shadows. */
export function paintWalls(lp: LinePrep, buf: Uint32Array, W: number, H: number, gx0: number, gy0: number, ppm: number): void {
  const px = 1 / ppm, seg = lp.oseg, fences = ppm >= FENCE_FROM_PPM, bBlock = band(0.33, ppm), bPost = ppm >= 4 ? 1 : 0;
  for (let q = 0; q < lp.no; q++) {
    const o = q * OS, kind = seg[o + 5]!;
    if (kind === OK_.Embankment || (kind !== OK_.Wall && !fences)) continue;
    const ax = seg[o]!, ay = seg[o + 1]!, bx = seg[o + 2]!, by = seg[o + 3]!, s0 = seg[o + 7]!, c = seg[o + 8]!;
    const wall = kind === OK_.Wall;
    const hw = wall ? Math.max(seg[o + 4]!, 0.3, (WALL_MIN_PX / 2) * px) : Math.max(0.08, 0.5 * px);
    const m = hw + 0.2;
    const i0 = Math.max(0, Math.floor((Math.min(ax, bx) - m) * ppm) - gx0), i1 = Math.min(W - 1, Math.ceil((Math.max(ax, bx) + m) * ppm) - gx0);
    const j0 = Math.max(0, Math.floor((Math.min(ay, by) - m) * ppm) - gy0), j1 = Math.min(H - 1, Math.ceil((Math.max(ay, by) + m) * ppm) - gy0);
    if (i0 > i1 || j0 > j1) continue;
    const ex = bx - ax, ey = by - ay, L = Math.sqrt(ex * ex + ey * ey) || 1e-9, L2 = L * L, nx = -ey / L, ny = ex / L;
    const litSide = -(nx * SDX + ny * SDY) > 0 ? 1 : -1;
    const cr = (c >> 16) & 255, cg = (c >> 8) & 255, cb = c & 255;
    // Thin fences are drawn area-true: their alpha shrinks with their width in pixels.
    const thin = wall ? 1 : Math.min(1, 0.16 * ppm) * (kind === OK_.Wooden ? 0.55 : 0.4);
    for (let j = j0; j <= j1; j++) {
      const y = (gy0 + j + 0.5) * px;
      for (let i = i0; i <= i1; i++) {
        const x = (gx0 + i + 0.5) * px;
        let u = ((x - ax) * ex + (y - ay) * ey) / L2;
        u = u < 0 ? 0 : u > 1 ? 1 : u;
        const dx = x - ax - u * ex, dy = y - ay - u * ey, d = Math.sqrt(dx * dx + dy * dy);
        const s = s0 + u * L;
        let a = clamp01(0.5 - (d - hw) * ppm) * thin;
        if (kind === OK_.Wire && hash2(Math.floor(s / 0.45), q, 121) < 0.35) a = 0; // broken line
        // Fence posts every 2.5 m (from 4 px/m).
        let post = 0;
        if (kind === OK_.Wooden && bPost) {
          const ps = s - Math.round(s / 2.5) * 2.5;
          if (ps * ps + d * d < 0.12 * 0.12 + px * px * 0.25) post = 1;
        }
        if (a <= 0 && !post) continue;
        const p = j * W + i, w = buf[p]!;
        let r = w & 255, g = (w >>> 8) & 255, b = (w >>> 16) & 255;
        if (wall) {
          const side = (x - ax) * nx + (y - ay) * ny;
          let f = 1 + 0.1 * bBlock * (hash2(Math.floor(s / 0.33), Math.floor((side + hw) / 0.25) + 7 * q, 123) - 0.5) * 2;
          if (d < 0.3 * hw) f *= 1.03; // crest
          else f *= side * litSide > 0 ? 1.02 : 0.84;
          f *= 1 + 0.05 * vnoiseImp(x / 2.5, y / 2.5, 125); // weathering
          r += (cr * f - r) * a; g += (cg * f - g) * a; b += (cb * f - b) * a;
        } else if (kind === OK_.Wooden) {
          const k = 1 - 0.18 * a - 0.3 * post;
          r *= k; g *= k; b *= k * 0.98;
        } else {
          r += (Math.min(255, r * 1.18) - r) * a; g += (Math.min(255, g * 1.18) - g) * a; b += (Math.min(255, b * 1.18) - b) * a;
        }
        buf[p] = pack(r, g, b);
      }
    }
  }
}

/** Does the picture need the line grid at all? (no roads, no water: skip it.) */
export const hasLines = (lp: LinePrep) => lp.nr + lp.ns + lp.ponds.length > 0;
export { LINE_REACH };
