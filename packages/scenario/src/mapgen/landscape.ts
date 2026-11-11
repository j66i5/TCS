/**
 * Building blocks shared by all map kinds: relief, field systems with hedges and tracks, woods, streams.
 */
import { atan2, chance, cos, nextFloat, nextRange, sin, type Coords } from "@tcs/sim";
import type { MapBuilder } from "./builder";
import { OCC_BUILDING, OCC_RESERVED, OCC_ROAD, OCC_WATER } from "./builder";
import { fbm } from "./noise";
import { distToPolyline } from "./geom";

const R = "mapgen/landscape";

/** Rolling relief: fractal noise with `reliefM` peak-to-trough, optionally a valley along a line. */
export function paintRelief(b: MapBuilder, seed: number, reliefM: number, scaleM: number, valley?: { points: Coords; depthM: number; widthM: number }): void {
  const w = b.cols + 1;
  for (let r = 0; r <= b.rows; r++) {
    for (let c = 0; c <= b.cols; c++) {
      const x = c * b.cellSizeM, y = r * b.cellSizeM;
      let h = 100 + (fbm(x / scaleM, y / scaleM, seed, 5) - 0.5) * 2 * reliefM;
      if (valley) {
        const d = distToPolyline(x, y, valley.points);
        if (d < valley.widthM) {
          const t = 1 - d / valley.widthM;
          h -= valley.depthM * t * t * (3 - 2 * t);
        }
      }
      b.heights[r * w + c] = Math.fround(h);
    }
  }
}

/** A meandering line from one map edge to the opposite one (roads, streams). */
export function meander(b: MapBuilder, seed: number, from: "west" | "north", at: number, amplitudeM: number, wavelengthM: number, stepM = 50): Coords {
  const pts: Coords = [];
  const len = from === "west" ? b.widthM : b.heightM;
  for (let s = 0; s <= len + 0.1; s += stepM) {
    const off = (fbm(s / wavelengthM, 0.5, seed, 3) - 0.5) * 2 * amplitudeM;
    if (from === "west") pts.push(Math.min(s, b.widthM), clamp(at + off, 5, b.heightM - 5));
    else pts.push(clamp(at + off, 5, b.widthM - 5), Math.min(s, b.heightM));
  }
  return pts;
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

interface Parcel { x0: number; y0: number; x1: number; y1: number; use: number; leaf: boolean; a?: Parcel; b?: Parcel; splitX?: boolean; at?: number }

/** Land uses for fields: [surface, vegetation, weight]. */
const FIELD_USES: [string, string | null, number][] = [
  ["stubble", "crops", 30],
  ["ploughed", null, 22],
  ["meadow", null, 18],
  ["grass", "tall-grass", 10],
  ["stubble", null, 12],
  ["grass", null, 8],
];

export interface FieldOptions {
  /** Cells for which this returns true are left alone (settlements, forest). */
  exclude?: (x: number, y: number) => boolean;
  hedgeChance: number;
  treelineChance: number;
  trackChance: number;
  /** Long side of a field, m. */
  maxLenM: number;
}

/**
 * Field system: the map is cut into long rectangular parcels (rotated a little, as real field systems
 * rarely align with north), each with a land use; some boundaries become hedges, tree lines or tracks.
 * Paints only free cells. Returns boundary lines for the caller to turn into hedges after roads exist.
 */
export function paintFields(b: MapBuilder, seed: number, o: FieldOptions): { hedges: Coords[]; treelines: Coords[]; tracks: Coords[] } {
  const ang = nextRange(b.rng, R, -0.35, 0.35);
  const ca = cos(ang), sa = sin(ang);
  const mx = b.widthM / 2, my = b.heightM / 2;
  const E = (b.widthM + b.heightM) * 0.75;
  const totalW = FIELD_USES.reduce((s, u) => s + u[2], 0);
  const pickUse = () => {
    let x = nextFloat(b.rng, R) * totalW;
    for (let i = 0; i < FIELD_USES.length; i++) { x -= FIELD_USES[i]![2]; if (x < 0) return i; }
    return 0;
  };
  const leaves: Parcel[] = [];
  const split = (p: Parcel): Parcel => {
    const w = p.x1 - p.x0, h = p.y1 - p.y0;
    const long = Math.max(w, h), short = Math.min(w, h);
    const done = (long < o.maxLenM && short < o.maxLenM * 0.45) || short < 50;
    if (done) { p.leaf = true; p.use = pickUse(); leaves.push(p); return p; }
    p.splitX = w >= h;
    // Split the long side; strips: prefer cutting so the pieces become long and narrow.
    p.at = (p.splitX ? p.x0 : p.y0) + long * nextRange(b.rng, R, 0.3, 0.7);
    p.a = split(p.splitX ? { x0: p.x0, y0: p.y0, x1: p.at, y1: p.y1, use: 0, leaf: false } : { x0: p.x0, y0: p.y0, x1: p.x1, y1: p.at, use: 0, leaf: false });
    p.b = split(p.splitX ? { x0: p.at, y0: p.y0, x1: p.x1, y1: p.y1, use: 0, leaf: false } : { x0: p.x0, y0: p.at, x1: p.x1, y1: p.y1, use: 0, leaf: false });
    return p;
  };
  const root = split({ x0: -E, y0: -E, x1: E, y1: E, use: 0, leaf: false });
  const find = (u: number, v: number): Parcel => {
    let p = root;
    while (!p.leaf) p = (p.splitX ? u < p.at! : v < p.at!) ? p.a! : p.b!;
    return p;
  };
  const toLocal = (x: number, y: number) => ({ u: (x - mx) * ca + (y - my) * sa, v: -(x - mx) * sa + (y - my) * ca });
  const toWorld = (u: number, v: number) => ({ x: mx + u * ca - v * sa, y: my + u * sa + v * ca });

  const sids = FIELD_USES.map((u) => b.sid(u[0]));
  const vids = FIELD_USES.map((u) => b.vid(u[1]));
  for (let r = 0; r < b.rows; r++) {
    for (let c = 0; c < b.cols; c++) {
      const i = r * b.cols + c;
      if (b.occ[i] !== 0) continue;
      const x = b.cx(c), y = b.cy(r);
      if (o.exclude?.(x, y)) continue;
      const { u, v } = toLocal(x, y);
      const p = find(u, v);
      b.surface[i] = sids[p.use]!;
      b.vegetation[i] = vids[p.use]!;
    }
  }

  // Boundaries: each parcel owns its east and south edge (so shared edges appear once).
  const hedges: Coords[] = [], treelines: Coords[] = [], tracks: Coords[] = [];
  for (const p of leaves) {
    for (const [u0, v0, u1, v1] of [[p.x1, p.y0, p.x1, p.y1], [p.x0, p.y1, p.x1, p.y1]] as const) {
      const a = toWorld(u0, v0), z = toWorld(u1, v1);
      const line = clipLine(a.x, a.y, z.x, z.y, b.widthM, b.heightM);
      if (!line) continue;
      const roll = nextFloat(b.rng, R);
      if (roll < o.hedgeChance) hedges.push(line);
      else if (roll < o.hedgeChance + o.treelineChance) treelines.push(line);
      else if (roll < o.hedgeChance + o.treelineChance + o.trackChance) tracks.push(line);
    }
  }
  return { hedges, treelines, tracks };
}

/** Liang-Barsky clip of a segment to the map rectangle (inset 1 m). */
function clipLine(x0: number, y0: number, x1: number, y1: number, w: number, h: number): Coords | null {
  let t0 = 0, t1 = 1;
  const dx = x1 - x0, dy = y1 - y0;
  const edges: [number, number][] = [[-dx, x0 - 1], [dx, w - 1 - x0], [-dy, y0 - 1], [dy, h - 1 - y0]];
  for (const [p, q] of edges) {
    if (p === 0) { if (q < 0) return null; continue; }
    const t = q / p;
    if (p < 0) { if (t > t1) return null; if (t > t0) t0 = t; }
    else { if (t < t0) return null; if (t < t1) t1 = t; }
  }
  if (t1 - t0 < 1e-6) return null;
  return [x0 + dx * t0, y0 + dy * t0, x0 + dx * t1, y0 + dy * t1];
}

/**
 * Add a linear obstacle along `line`, but split it wherever it would cross a road, water, a building,
 * reserved settlement ground or woodland: hedges do not run across roads or through houses.
 */
export function addObstacleAvoiding(b: MapBuilder, kind: string, line: Coords, avoidVeg: number[] = []): void {
  const stepM = b.cellSizeM / 2;
  let cur: Coords = [];
  const flush = () => { if (cur.length >= 4 && segLen(cur) > 8) b.addObstacle(kind, simplify(cur)); cur = []; };
  for (let i = 0; i + 3 < line.length; i += 2) {
    const ax = line[i]!, ay = line[i + 1]!, bx = line[i + 2]!, by = line[i + 3]!;
    const l = Math.max(Math.abs(bx - ax), Math.abs(by - ay));
    const n = Math.max(1, Math.ceil(l / stepM));
    for (let k = 0; k <= n; k++) {
      const x = ax + ((bx - ax) * k) / n, y = ay + ((by - ay) * k) / n;
      const c = Math.floor(x / b.cellSizeM), r = Math.floor(y / b.cellSizeM);
      const cell = r * b.cols + c;
      const blocked = c < 0 || r < 0 || c >= b.cols || r >= b.rows
        || (b.occ[cell]! & (OCC_ROAD | OCC_WATER | OCC_BUILDING | OCC_RESERVED)) !== 0
        || avoidVeg.includes(b.vegetation[cell]!);
      if (blocked) flush();
      else cur.push(x, y);
    }
  }
  flush();
}

function segLen(c: Coords): number {
  let l = 0;
  for (let i = 0; i + 3 < c.length; i += 2) l += Math.abs(c[i + 2]! - c[i]!) + Math.abs(c[i + 3]! - c[i + 1]!);
  return l;
}

/** Drop interior points that lie on a straight line (keeps files small). */
function simplify(c: Coords): Coords {
  if (c.length <= 4) return c;
  const out: Coords = [c[0]!, c[1]!];
  for (let i = 2; i + 3 < c.length; i += 2) {
    const ax = out[out.length - 2]!, ay = out[out.length - 1]!, bx = c[i]!, by = c[i + 1]!, cx = c[i + 2]!, cy = c[i + 3]!;
    const cross = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if (Math.abs(cross) > 0.5) out.push(bx, by);
  }
  out.push(c[c.length - 2]!, c[c.length - 1]!);
  return out;
}

/** Tree lines: bands of trees and bushes along a line, on free cells. */
export function paintTreeline(b: MapBuilder, line: Coords, halfWidthM: number): void {
  const v = b.vid("treeline");
  b.forPolyline(line, halfWidthM, (i) => { if (b.occ[i] === 0) b.vegetation[i] = v; });
}

/** Woods where fractal noise exceeds `threshold`; a fringe of scrub just below it. Free cells only. */
export function paintWoods(b: MapBuilder, seed: number, threshold: number, scaleM: number, exclude?: (x: number, y: number) => boolean): void {
  const wood = b.vid("woodland"), scrub = b.vid("scrub"), floor = b.sid("forest-floor");
  for (let r = 0; r < b.rows; r++) {
    for (let c = 0; c < b.cols; c++) {
      const i = r * b.cols + c;
      if (b.occ[i] !== 0) continue;
      const x = b.cx(c), y = b.cy(r);
      if (exclude?.(x, y)) continue;
      const n = fbm(x / scaleM, y / scaleM, seed, 4);
      if (n > threshold) { b.vegetation[i] = wood; b.surface[i] = floor; }
      else if (n > threshold - 0.02) b.vegetation[i] = scrub;
    }
  }
}

/** Polyline helpers for roads leaving a point at an angle. */
export function ray(x: number, y: number, angle: number, lengthM: number, bendSeed: number, b: MapBuilder): Coords {
  const pts: Coords = [x, y];
  const steps = Math.max(2, Math.ceil(lengthM / 40));
  let a = angle, px = x, py = y;
  for (let k = 1; k <= steps; k++) {
    a += (fbm(k * 0.3, bendSeed * 0.01, bendSeed, 2) - 0.5) * 0.35;
    px += cos(a) * (lengthM / steps);
    py += sin(a) * (lengthM / steps);
    pts.push(clamp(px, 0, b.widthM), clamp(py, 0, b.heightM));
    if (px <= 0 || py <= 0 || px >= b.widthM || py >= b.heightM) break;
  }
  return pts;
}

export function angleOf(tx: number, ty: number): number {
  return atan2(ty, tx);
}

export { chance };
