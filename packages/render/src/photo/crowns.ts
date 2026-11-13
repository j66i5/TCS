/**
 * Trees, hedges, orchards and scrub of the photo map (plan "photo" step "vegetation"): every crown is a lumpy,
 * sun-lit dome stamped onto the ground, taller crowns over lower ones, each with a small contact shadow on what lies
 * below it; the long cast shadows on the ground come from `shadows.ts`. Pure (no Pixi, no DOM, no random, no clock).
 *
 * Crowns are not stored: any rectangle's crowns are generated on demand from world lattices and hashes of lattice
 * indices (woods, scrub, orchards) or of the hedge and its step, so a tile and a larger picture see the same crowns,
 * and the draw order (height, then y, then x, then a hashed id) is a function of the crown alone, so tiles join byte
 * for byte.
 *
 * - woods and tree lines: a jittered lattice, about 3 crowns per 4 m cell (one big crown per cell below 2 px/m),
 *   r 2.0-3.3 m, 12-20 m tall; the wood's outline follows the ground painter's warped field edges;
 * - scrub: 60 % of the same lattice, r 0.9-1.5 m, 2 m;
 * - orchards: a 7 m grid (+-0.4 m, about 6 % gaps), r 1.6-2.1 m, 5 m: the visible grid tells orchard from wood;
 * - hedges: a crown every 1.1 m along the line (+-0.35 m), r 1.2-1.8 m (at least 1.3 px), 2.5 m; 8 % hedgerow
 *   trees (r 2.6-3.6 m, darker, 10 m);
 * - lanes: crowns whose centre lies within (half-width + 0.75 r) of a road, or (half-width + 0.9 r) of a stream, are
 *   dropped, so tracks and streams cut open lanes through woods and hedges.
 */
import type { MapDef } from "@tcs/sim";
import type { FlatColours } from "../flat/paint";
import { band, hash2, vnoise as vnoiseImp } from "./noise";
import { SUN, SHADOW_K, SHADOW_MAX } from "./light";

/** Crown kinds (also the tie-break of the draw order). */
export const CK = { Wood: 0, Scrub: 1, Orchard: 2, Hedge: 3 } as const;

/** Wood lattice spacing (m): three crowns per 4 m cell. */
export const WOOD_S = 4 / Math.sqrt(3);
/** Coarse wood lattice (one crown per 4 m), below this many px/m. */
export const COARSE_BELOW_PPM = 2;
export const ORCHARD_G = 7;
export const HEDGE_STEP = 1.1;
/** Smallest hedge crown on screen (px radius), so a hedge never thins to nothing far out. */
export const HEDGE_MIN_PX = 1.3;
/** Crowns (and their shadows) reach at most this far (m) beyond their centre: the gather margin of a picture. */
export const CROWN_REACH = 16;
/** Lane clearance: crown centre at least half-width + LANE_K * r from a road's centre line (streams: STREAM_K). */
export const LANE_K = 0.75;
export const STREAM_K = 0.9;

/** Per map: what the vegetation painter needs (built once in `prep`). */
export interface VegPrep {
  cols: number; rows: number; cs: number; widthM: number; heightM: number;
  veg: Uint8Array;
  /** Per vegetation value (1-based palette index): 0 none / low cover, 1 wood, 2 orchard, 3 scrub; and its colour. */
  kindOf: Uint8Array;
  colOf: Int32Array;
  hedgeCol: number;
  /** Hedges: polylines with their bounding boxes. */
  hedges: { pts: Float32Array; minX: number; minY: number; maxX: number; maxY: number }[];
  /** Lane segments: ax, ay, bx, by, half-width, k (6 per segment), bucketed by LANE_B metres (CSR). */
  segs: Float32Array;
  segStart: Int32Array; segItems: Int32Array; sbc: number; sbr: number;
}
const LANE_B = 32;

export function prepareVegetation(map: MapDef, col: FlatColours): VegPrep {
  const nV = map.vegetationPalette.length + 1;
  const kindOf = new Uint8Array(nV), colOf = new Int32Array(nV);
  for (let v = 1; v < nV; v++) { kindOf[v] = col.treeKind[v] ?? 0; colOf[v] = col.vegetation[v] ?? 0x4b583c; }
  const hedges: VegPrep["hedges"] = [];
  for (const o of map.obstacles) {
    if (o.kind !== "hedge" || o.points.length < 4) continue;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let k = 0; k < o.points.length; k += 2) { minX = Math.min(minX, o.points[k]!); maxX = Math.max(maxX, o.points[k]!); minY = Math.min(minY, o.points[k + 1]!); maxY = Math.max(maxY, o.points[k + 1]!); }
    hedges.push({ pts: Float32Array.from(o.points), minX, minY, maxX, maxY });
  }
  // Lane segments: roads and streams.
  const segL: number[] = [];
  for (const r of map.roads) for (let k = 0; k + 3 < r.points.length; k += 2) segL.push(r.points[k]!, r.points[k + 1]!, r.points[k + 2]!, r.points[k + 3]!, r.widthM / 2, LANE_K);
  for (const w of map.water) if (w.kind === "stream") for (let k = 0; k + 3 < w.points.length; k += 2) segL.push(w.points[k]!, w.points[k + 1]!, w.points[k + 2]!, w.points[k + 3]!, w.widthM / 2, STREAM_K);
  const segs = Float32Array.from(segL), ns = segL.length / 6;
  const sbc = Math.ceil(map.widthM / LANE_B) + 1, sbr = Math.ceil(map.heightM / LANE_B) + 1;
  const lists: number[][] = Array.from({ length: sbc * sbr }, () => []);
  for (let s = 0; s < ns; s++) {
    const ax = segs[s * 6]!, ay = segs[s * 6 + 1]!, bx = segs[s * 6 + 2]!, by = segs[s * 6 + 3]!, reach = segs[s * 6 + 4]! + 4;
    const c0 = Math.max(0, Math.floor((Math.min(ax, bx) - reach) / LANE_B)), c1 = Math.min(sbc - 1, Math.floor((Math.max(ax, bx) + reach) / LANE_B));
    const r0 = Math.max(0, Math.floor((Math.min(ay, by) - reach) / LANE_B)), r1 = Math.min(sbr - 1, Math.floor((Math.max(ay, by) + reach) / LANE_B));
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) lists[r * sbc + c]!.push(s);
  }
  const segStart = new Int32Array(sbc * sbr + 1);
  for (let b = 0; b < sbc * sbr; b++) segStart[b + 1] = segStart[b]! + lists[b]!.length;
  const segItems = new Int32Array(segStart[sbc * sbr]!);
  for (let b = 0; b < sbc * sbr; b++) segItems.set(lists[b]!, segStart[b]!);
  return {
    cols: map.cols, rows: map.rows, cs: map.cellSizeM, widthM: map.widthM, heightM: map.heightM,
    veg: map.vegetation, kindOf, colOf, hedgeCol: col.obstacle["hedge"] ?? 0x3f4c33, hedges, segs, segStart, segItems, sbc, sbr,
  };
}

/** Is a crown of radius r at (x, y) in a lane (too close to a road or stream)? */
function inLane(v: VegPrep, x: number, y: number, r: number): boolean {
  const bc = Math.floor(x / LANE_B), br = Math.floor(y / LANE_B);
  if (bc < 0 || br < 0 || bc >= v.sbc || br >= v.sbr) return false;
  const b = br * v.sbc + bc, segs = v.segs;
  for (let q = v.segStart[b]!; q < v.segStart[b + 1]!; q++) {
    const o = v.segItems[q]! * 6;
    const ax = segs[o]!, ay = segs[o + 1]!, ex = segs[o + 2]! - ax, ey = segs[o + 3]! - ay, clear = segs[o + 4]! + segs[o + 5]! * r;
    const L2 = ex * ex + ey * ey || 1e-9;
    let u = ((x - ax) * ex + (y - ay) * ey) / L2;
    u = u < 0 ? 0 : u > 1 ? 1 : u;
    const dx = x - ax - u * ex, dy = y - ay - u * ey;
    if (dx * dx + dy * dy < clear * clear) return true;
  }
  return false;
}

/** A growable list of crowns (struct of arrays). */
export class Crowns {
  n = 0;
  x: number[] = []; y: number[] = []; r: number[] = []; h: number[] = [];
  cr: number[] = []; cg: number[] = []; cb: number[] = [];
  variant: number[] = []; kind: number[] = []; key: number[] = [];
  clear(): void { this.n = 0; }
  push(x: number, y: number, r: number, h: number, colour: number, tint: number, hue: number, variant: number, kind: number, id: number): void {
    const i = this.n++;
    const hq = Math.round(h * 8);
    this.x[i] = x; this.y[i] = y; this.r[i] = r; this.h[i] = hq / 8;
    this.cr[i] = ((colour >> 16) & 255) * tint * (1 + hue); this.cg[i] = ((colour >> 8) & 255) * tint; this.cb[i] = (colour & 255) * tint * (1 - hue);
    this.variant[i] = variant; this.kind[i] = kind;
    // Draw order: height, y, x (1/16 m), then a hashed id; a function of the crown alone.
    this.key[i] = ((hq * 65536 + Math.round(y * 16)) * 65536 + Math.round(x * 16)) * 256 + ((kind << 6) | (id & 63));
  }
  /** Indices in draw order. */
  order(): Int32Array {
    const idx = new Int32Array(this.n);
    for (let i = 0; i < this.n; i++) idx[i] = i;
    const key = this.key;
    idx.sort((a, b) => key[a]! - key[b]!);
    return idx;
  }
}

/** Bilinear read of a macro channel (the ground painter's domain warp), so woods follow the same soft edges. */
function macroAt(macro: Float32Array, mc: number, mr: number, ch: number, nch: number, mM: number, x: number, y: number): number {
  let mx = x / mM, my = y / mM;
  if (mx < 0) mx = 0; if (my < 0) my = 0; if (mx > mc - 1.001) mx = mc - 1.001; if (my > mr - 1.001) my = mr - 1.001;
  const i = Math.floor(mx), j = Math.floor(my), tx = mx - i, ty = my - j, o = (j * mc + i) * nch + ch;
  return macro[o]! * (1 - tx) * (1 - ty) + macro[o + nch]! * tx * (1 - ty) + macro[o + mc * nch]! * (1 - tx) * ty + macro[o + mc * nch + nch]! * tx * ty;
}

export interface WarpGrid { macro: Float32Array; mcols: number; mrows: number; ch: number; wx: number; wy: number; mM: number }

/**
 * The crowns whose centres lie in [x0, x1) x [y0, y1), for painting at `ppm` (coarse wood lattice below 2 px/m).
 * Appends to `out`.
 */
export function gatherCrowns(v: VegPrep, warp: WarpGrid, x0: number, y0: number, x1: number, y1: number, ppm: number, out: Crowns): void {
  const C = v.cols, R = v.rows, cs = v.cs, veg = v.veg, kindOf = v.kindOf, colOf = v.colOf;
  const coarse = ppm < COARSE_BELOW_PPM;
  const warpAt = (x: number, y: number, ch: number) => macroAt(warp.macro, warp.mcols, warp.mrows, ch, warp.ch, warp.mM, x, y);
  const vegAt = (x: number, y: number): number => {
    const c = Math.floor(x / cs), r = Math.floor(y / cs);
    return c < 0 || r < 0 || c >= C || r >= R ? 0 : veg[r * C + c]!;
  };
  // ---- woods (and tree lines) and scrub on the jittered lattice
  const lattice = (S: number, woodOnly: boolean, scrubOnly: boolean) => {
    const i0 = Math.floor(x0 / S) - 1, i1 = Math.floor(x1 / S) + 1, j0 = Math.floor(y0 / S) - 1, j1 = Math.floor(y1 / S) + 1;
    const salt = S === WOOD_S ? 0 : 0x400;
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const x = (i + 0.5 + 0.8 * (hash2(i, j, 0x101 + salt) - 0.5)) * S, y = (j + 0.5 + 0.8 * (hash2(i, j, 0x102 + salt) - 0.5)) * S;
      if (x < x0 || x >= x1 || y < y0 || y >= y1) continue;
      const vv = vegAt(x + warpAt(x, y, warp.wx), y + warpAt(x, y, warp.wy));
      if (vv === 0) continue;
      const k = kindOf[vv]!;
      const hA = hash2(i, j, 0x103 + salt), hB = hash2(i, j, 0x104 + salt), hC = hash2(i, j, 0x105 + salt), hD = hash2(i, j, 0x106 + salt);
      if (k === 1 && !scrubOnly) {
        const r = coarse ? 2.8 + 1.2 * hA : 2.0 + 1.3 * hA;
        if (inLane(v, x, y, r)) continue;
        out.push(x, y, r, 12 + 8 * hB, colOf[vv]!, (0.88 + 0.24 * hC) * (1 + 0.07 * vnoiseImp(x / 23, y / 23, 71)), 0.06 * (hD - 0.5), Math.floor(hD * 4) & 3, CK.Wood, i * 7 + j * 13);
      } else if (k === 3 && !woodOnly) {
        if (hash2(i, j, 0x107) >= 0.6) continue;
        const r = 0.9 + 0.6 * hA;
        if (inLane(v, x, y, r)) continue;
        out.push(x, y, r, 2, colOf[vv]!, 0.88 + 0.24 * hC, 0.06 * (hD - 0.5), Math.floor(hD * 4) & 3, CK.Scrub, i * 7 + j * 13);
      }
    }
  };
  if (coarse) { lattice(4, true, false); lattice(WOOD_S, false, true); } else lattice(WOOD_S, false, false);
  // ---- orchards: a regular grid where the (unwarped) cell is orchard
  const G = ORCHARD_G;
  for (let gy = Math.floor(y0 / G) - 1; gy <= Math.floor(y1 / G) + 1; gy++) for (let gx = Math.floor(x0 / G) - 1; gx <= Math.floor(x1 / G) + 1; gx++) {
    const x = (gx + 0.5) * G + 0.8 * (hash2(gx, gy, 0x201) - 0.5), y = (gy + 0.5) * G + 0.8 * (hash2(gx, gy, 0x202) - 0.5);
    if (x < x0 || x >= x1 || y < y0 || y >= y1) continue;
    const vv = vegAt(x, y);
    if (vv === 0 || kindOf[vv] !== 2 || hash2(gx, gy, 0x203) < 0.06) continue;
    const r = 1.6 + 0.5 * hash2(gx, gy, 0x204);
    if (inLane(v, x, y, r)) continue;
    const hD = hash2(gx, gy, 0x206);
    out.push(x, y, r, 5, colOf[vv]!, 0.9 + 0.2 * hash2(gx, gy, 0x205), 0.05 * (hD - 0.5), Math.floor(hD * 4) & 3, CK.Orchard, gx * 7 + gy * 13);
  }
  // ---- hedges: a crown every HEDGE_STEP metres along the line
  const minR = HEDGE_MIN_PX / ppm;
  for (let o = 0; o < v.hedges.length; o++) {
    const hg = v.hedges[o]!;
    if (hg.maxX < x0 - 4 || hg.minX >= x1 + 4 || hg.maxY < y0 - 4 || hg.minY >= y1 + 4) continue;
    const p = hg.pts;
    let n = 0, carry = 0.5 * HEDGE_STEP;
    for (let k = 0; k + 3 < p.length; k += 2) {
      const ax = p[k]!, ay = p[k + 1]!, ex = p[k + 2]! - ax, ey = p[k + 3]! - ay, L = Math.sqrt(ex * ex + ey * ey);
      if (L < 1e-6) continue;
      const ux = ex / L, uy = ey / L;
      let s = carry;
      for (; s < L; s += HEDGE_STEP, n++) {
        const ja = (hash2(o, n, 0x301) - 0.5) * 0.7, jp = (hash2(o, n, 0x302) - 0.5) * 0.7;
        const x = ax + ux * (s + ja) - uy * jp, y = ay + uy * (s + ja) + ux * jp;
        if (x < x0 || x >= x1 || y < y0 || y >= y1) continue;
        const tree = hash2(o, n, 0x303) < 0.08;
        const hA = hash2(o, n, 0x304), hD = hash2(o, n, 0x306);
        let r = tree ? 2.6 + 1.0 * hA : 1.2 + 0.6 * hA;
        if (r < minR) r = minR;
        if (inLane(v, x, y, r)) continue;
        out.push(x, y, r, tree ? 10 : 2.5, v.hedgeCol, (tree ? 0.84 : 0.9) + 0.2 * hash2(o, n, 0x305), 0.05 * (hD - 0.5), Math.floor(hD * 4) & 3, CK.Hedge, o * 31 + n);
      }
      carry = s - L;
    }
  }
}

// ---------------------------------------------------------------- stamps

/** One pre-shaded crown: the pixels it touches, relative to its centre pixel. */
export interface Stamp {
  n: number;
  dx: Int16Array; dy: Int16Array;
  /** Crown cover (0..1), contact shadow on what lies below (0..1), and the lit colour multipliers. */
  a: Float32Array; sh: Float32Array; mR: Float32Array; mG: Float32Array; mB: Float32Array;
}
export const STAMP_RADII = 8;
/** Crown shading: the shaded side's floor, the sun's share, and the contact shadow on what lies below. */
export const SHADE_MIN = 0.52, SHADE_SUN = 0.62, CONTACT = 0.25;
export const STAMP_VARIANTS = 4;
const R_MIN = 0.9, R_MAX = 4.0;
/** The radius of each stamp bucket (geometric from 0.9 to 4.0 m). */
export const stampRadius = (b: number) => R_MIN * Math.pow(R_MAX / R_MIN, b / (STAMP_RADII - 1));
const BUCKET_EDGES: number[] = Array.from({ length: STAMP_RADII - 1 }, (_, b) => Math.sqrt(stampRadius(b) * stampRadius(b + 1)));
export function stampBucket(r: number): number {
  let b = 0;
  while (b < STAMP_RADII - 1 && r > BUCKET_EDGES[b]!) b++;
  return b;
}

/** Shadow direction on the ground (unit, toward the east-south-east). */
const SH_LEN = Math.sqrt(SUN.x * SUN.x + SUN.y * SUN.y);
export const SHADOW_DIR = { x: -SUN.x / SH_LEN, y: -SUN.y / SH_LEN } as const;

/**
 * Pre-shade one crown stamp at `ppm`. A crown seen from above is a cluster of foliage clumps: a central dome and
 * 5-8 smaller domes round it (hashed per variant), their union giving the lumpy outline and dark creases between
 * clumps; a fine leaf texture (0.3 m bumps and speckle, band-limited) on top. Lit by the sun
 * (0.52 + 0.62 max(0, n . sun): never black), darker toward the rim (gaps between crowns), an alpha edge one pixel wide, and a soft
 * contact shadow toward the east-south-east on whatever lies below.
 */
export function buildStamp(rb: number, variant: number, ppm: number): Stamp {
  const vnoise = vnoiseImp;
  const ox = SHADOW_DIR.x * 0.4 * rb, oy = SHADOW_DIR.y * 0.4 * rb;
  const R = Math.ceil((rb * 1.12 + 0.4 * rb + 0.6) * ppm) + 1, D = 2 * R + 1;
  const vo = 37 * variant + 11;
  const bLeaf = band(0.3, ppm), bSpeck = band(0.25, ppm);
  // Clumps: x, y, radius, base height (the cluster is a dome: outer clumps sit lower).
  const nc = 5 + Math.min(3, Math.floor(rb)), cl: number[] = [0, 0, 0.68 * rb, 0.12 * rb];
  for (let q = 0; q < nc; q++) {
    const ang = (q + 0.35 * hash2(variant, q, 0x601)) * (2 * Math.PI / nc), dist = rb * (0.42 + 0.18 * hash2(variant, q, 0x602));
    cl.push(Math.cos(ang) * dist, Math.sin(ang) * dist, rb * (0.42 + 0.14 * hash2(variant, q, 0x603)), -0.05 * rb);
  }
  const NCL = cl.length / 4;
  // Height field on the pixel grid (one pixel border for the slopes) and the signed cover distance.
  const hf = new Float32Array((D + 2) * (D + 2)), cov = new Float32Array((D + 2) * (D + 2)).fill(-1e9);
  for (let j = -R - 1; j <= R + 1; j++) for (let i = -R - 1; i <= R + 1; i++) {
    const x = i / ppm, y = j / ppm, k = (j + R + 1) * (D + 2) + (i + R + 1);
    if (x * x + y * y > (rb * 1.12 + 1 / ppm) * (rb * 1.12 + 1 / ppm)) continue;
    let h = -1e9, c = -1e9;
    for (let q = 0; q < NCL; q++) {
      const ddx = x - cl[4 * q]!, ddy = y - cl[4 * q + 1]!, rq = cl[4 * q + 2]!, d2 = ddx * ddx + ddy * ddy;
      const lim = rq - c; // a closer clump edge only when d < rq - c
      if (lim > 0 && d2 < lim * lim) c = rq - Math.sqrt(d2);
      else if (c < -1e8) c = rq - Math.sqrt(d2);
      if (d2 < rq * rq) { const z = cl[4 * q + 3]! + Math.sqrt(rq * rq - d2); if (z > h) h = z; }
    }
    cov[k] = c;
    hf[k] = h > -1e8 ? h + 0.07 * bLeaf * vnoise(x / 0.3 + vo, y / 0.3 - vo, 62) * rb : 0;
  }
  const NN = D * D, dx = new Int16Array(NN), dy = new Int16Array(NN), a = new Float32Array(NN), sh = new Float32Array(NN), mR = new Float32Array(NN), mG = new Float32Array(NN), mB = new Float32Array(NN);
  let n = 0;
  const step = 2 / ppm;
  for (let j = -R; j <= R; j++) for (let i = -R; i <= R; i++) {
    const x = i / ppm, y = j / ppm, k = (j + R + 1) * (D + 2) + (i + R + 1);
    const sx0 = x - ox, sy0 = y - oy, far = rb + 0.35;
    if (cov[k]! < -1e8 && sx0 * sx0 + sy0 * sy0 > far * far) continue;
    const d = Math.sqrt(x * x + y * y);
    let al = cov[k]! * ppm + 0.5;
    al = al < 0 ? 0 : al > 1 ? 1 : al;
    const sx = x - ox, sy = y - oy, ds = Math.sqrt(sx * sx + sy * sy);
    let s = (rb - ds) / 0.6 + 0.5;
    s = (s < 0 ? 0 : s > 1 ? 1 : s) * CONTACT;
    if (al < 0.004 && s < 0.004) continue;
    let mul = 0;
    if (al > 0) {
      // Slopes; a neighbour outside the crown counts as this pixel (no false rim from the zero height outside).
      const hc = hf[k]!, hl = cov[k - 1]! > 0 ? hf[k - 1]! : hc, hr = cov[k + 1]! > 0 ? hf[k + 1]! : hc;
      const hu = cov[k - D - 2]! > 0 ? hf[k - D - 2]! : hc, hd = cov[k + D + 2]! > 0 ? hf[k + D + 2]! : hc;
      const gx = (hr - hl) / step, gy = (hd - hu) / step;
      const nl = 1 / Math.sqrt(gx * gx + gy * gy + 1);
      const l = (-gx * SUN.x - gy * SUN.y + SUN.z) * nl;
      const u = d / (rb * 1.1);
      const ao = 0.84 + 0.16 * (u >= 1 ? 0 : Math.sqrt(1 - u * u));
      mul = (SHADE_MIN + SHADE_SUN * (l > 0 ? l : 0)) * ao * (1 + 0.09 * bSpeck * vnoise(x / 0.25 - vo, y / 0.25 + vo, 64));
    }
    dx[n] = i; dy[n] = j; a[n] = al; sh[n] = s;
    mR[n] = mul * (1 + 0.1 * (mul - 0.75)); mG[n] = mul; mB[n] = mul * (1 - 0.12 * (mul - 0.75));
    n++;
  }
  return { n, dx: dx.slice(0, n), dy: dy.slice(0, n), a: a.slice(0, n), sh: sh.slice(0, n), mR: mR.slice(0, n), mG: mG.slice(0, n), mB: mB.slice(0, n) };
}

/** All stamps for one `ppm` (STAMP_RADII x STAMP_VARIANTS), index b * STAMP_VARIANTS + variant. */
export function buildStamps(ppm: number): Stamp[] {
  const out: Stamp[] = [];
  for (let b = 0; b < STAMP_RADII; b++) for (let v = 0; v < STAMP_VARIANTS; v++) out.push(buildStamp(stampRadius(b), v, ppm));
  return out;
}

/**
 * Stamp crowns (in draw order) into `buf` (W x H words; global pixel gx0, gy0 at `ppm`). Each crown first darkens
 * what lies below by its contact shadow, then covers it with its lit colour.
 */
export function blitCrowns(c: Crowns, order: Int32Array, stamps: Stamp[], buf: Uint32Array, W: number, H: number, gx0: number, gy0: number, ppm: number): void {
  const NV = STAMP_VARIANTS;
  for (let q = 0; q < order.length; q++) {
    const i = order[q]!;
    const st = stamps[stampBucket(c.r[i]!) * NV + c.variant[i]!]!;
    const px = Math.floor(c.x[i]! * ppm) - gx0, py = Math.floor(c.y[i]! * ppm) - gy0;
    const cr = c.cr[i]!, cg = c.cg[i]!, cb = c.cb[i]!;
    const sdx = st.dx, sdy = st.dy, sa = st.a, ssh = st.sh, mR = st.mR, mG = st.mG, mB = st.mB;
    for (let k = 0; k < st.n; k++) {
      const x = px + sdx[k]!, y = py + sdy[k]!;
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      const p = y * W + x, w = buf[p]!;
      const keep = 1 - ssh[k]!, al = sa[k]!;
      let r = (w & 255) * keep, g = ((w >>> 8) & 255) * keep, b = ((w >>> 16) & 255) * keep;
      if (al > 0) { r += (cr * mR[k]! - r) * al; g += (cg * mG[k]! - g) * al; b += (cb * mB[k]! - b) * al; }
      const R8 = r > 255 ? 255 : r + 0.5 | 0, G8 = g > 255 ? 255 : g + 0.5 | 0, B8 = b > 255 ? 255 : b + 0.5 | 0;
      buf[p] = (0xff000000 | (B8 << 16) | (G8 << 8) | R8) >>> 0;
    }
  }
}

/** Shadow length (m) on the ground of something `h` metres tall. */
export const shadowLen = (h: number) => Math.min(SHADOW_MAX, SHADOW_K * h);
