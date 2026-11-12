/**
 * Terrain queries over a MapDef: height, surface, vegetation, movement cost, and a spatial index of
 * wall segments (obstacles and building walls) for neighbourhood queries (SPEC 4.4: spatial hashing).
 * Pure arithmetic only, so results are identical on every engine.
 */
import type { MovementClass, TerrainCatalog } from "./catalog";
import type { DefId } from "./ids";
import { MAX_MAP_SIZE_M, type MapDef } from "./map";

/** Index of the cell containing (x, y), or -1 outside the map. */
export function cellIndex(m: MapDef, x: number, y: number): number {
  if (x < 0 || y < 0 || x >= m.widthM || y >= m.heightM) return -1;
  const c = Math.floor(x / m.cellSizeM);
  const r = Math.floor(y / m.cellSizeM);
  if (c >= m.cols || r >= m.rows) return -1;
  return r * m.cols + c;
}

/** Ground height at (x, y), bilinear between the four surrounding samples. Clamped to the map. */
export function heightAt(m: MapDef, x: number, y: number): number {
  const fx = Math.min(Math.max(x / m.cellSizeM, 0), m.cols);
  const fy = Math.min(Math.max(y / m.cellSizeM, 0), m.rows);
  const c = Math.min(Math.floor(fx), m.cols - 1);
  const r = Math.min(Math.floor(fy), m.rows - 1);
  const tx = fx - c, ty = fy - r;
  const w = m.cols + 1;
  const h00 = m.heights[r * w + c]!, h10 = m.heights[r * w + c + 1]!;
  const h01 = m.heights[(r + 1) * w + c]!, h11 = m.heights[(r + 1) * w + c + 1]!;
  return (h00 * (1 - tx) + h10 * tx) * (1 - ty) + (h01 * (1 - tx) + h11 * tx) * ty;
}

/** Gradient (dh/dx, dh/dy) at (x, y) from central differences over one cell. */
export function slopeAt(m: MapDef, x: number, y: number): { dx: number; dy: number } {
  const d = m.cellSizeM / 2;
  return {
    dx: (heightAt(m, x + d, y) - heightAt(m, x - d, y)) / (2 * d),
    dy: (heightAt(m, x, y + d) - heightAt(m, x, y - d)) / (2 * d),
  };
}

export function surfaceAt(m: MapDef, x: number, y: number): DefId | null {
  const i = cellIndex(m, x, y);
  return i < 0 ? null : (m.surfacePalette[m.surface[i]!] ?? null);
}

export function vegetationAt(m: MapDef, x: number, y: number): DefId | null {
  const i = cellIndex(m, x, y);
  if (i < 0) return null;
  const v = m.vegetation[i]!;
  return v === 0 ? null : (m.vegetationPalette[v - 1] ?? null);
}

/**
 * Movement time multiplier of a cell for a movement class: surface cost x vegetation cost.
 * null = impassable (deep water; vehicles in woods or buildings). Walls are handled by navigation (M1.2).
 */
export function cellMoveCost(m: MapDef, t: TerrainCatalog, cell: number, cls: MovementClass): number | null {
  const s = t.surfaces[m.surfacePalette[m.surface[cell]!]!];
  if (!s) return null;
  const sc = s.moveCost[cls];
  if (sc === null) return null;
  const v = m.vegetation[cell]!;
  if (v === 0) return sc;
  const veg = t.vegetation[m.vegetationPalette[v - 1]!];
  const vc = veg ? veg.moveCost[cls] : 1;
  return vc === null ? null : sc * vc;
}

// ---------------------------------------------------------------- spatial index

/** A wall segment: part of a linear obstacle or of a building's outer wall. */
export interface Segment {
  ax: number; ay: number; bx: number; by: number;
  /** "obstacle" or "building", and that thing's id; `part` = segment/wall index within it. */
  owner: "obstacle" | "building";
  id: number;
  part: number;
}

export interface MapIndex {
  bucketM: number;
  bcols: number;
  brows: number;
  segments: Segment[];
  /** For each bucket, indices into `segments` (ascending). */
  buckets: number[][];
  /** Scratch for `segmentsInRectInto`: the query generation each segment was last collected in. */
  stamp: Uint32Array;
  stampGen: number;
}

/** Build a bucket grid of all wall segments. Derived data: rebuilt from the map, never saved. */
export function buildMapIndex(m: MapDef, bucketM = 32): MapIndex {
  const bcols = Math.max(1, Math.ceil(m.widthM / bucketM));
  const brows = Math.max(1, Math.ceil(m.heightM / bucketM));
  const segments: Segment[] = [];
  for (const o of m.obstacles) {
    for (let i = 0; i + 3 < o.points.length; i += 2) {
      segments.push({ ax: o.points[i]!, ay: o.points[i + 1]!, bx: o.points[i + 2]!, by: o.points[i + 3]!, owner: "obstacle", id: o.id, part: i / 2 });
    }
  }
  for (const b of m.buildings) {
    const n = b.footprint.length / 2;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      segments.push({ ax: b.footprint[i * 2]!, ay: b.footprint[i * 2 + 1]!, bx: b.footprint[j * 2]!, by: b.footprint[j * 2 + 1]!, owner: "building", id: b.id, part: i });
    }
  }
  const buckets: number[][] = Array.from({ length: bcols * brows }, () => []);
  segments.forEach((s, si) => {
    const c0 = clampI(Math.floor(Math.min(s.ax, s.bx) / bucketM), bcols), c1 = clampI(Math.floor(Math.max(s.ax, s.bx) / bucketM), bcols);
    const r0 = clampI(Math.floor(Math.min(s.ay, s.by) / bucketM), brows), r1 = clampI(Math.floor(Math.max(s.ay, s.by) / bucketM), brows);
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) buckets[r * bcols + c]!.push(si);
  });
  return { bucketM, bcols, brows, segments, buckets, stamp: new Uint32Array(segments.length), stampGen: 0 };
}

const clampI = (v: number, n: number) => (v < 0 ? 0 : v >= n ? n - 1 : v);

/** Indices of segments whose bounding boxes may touch the rectangle; ascending, no duplicates. */
export function segmentsInRect(ix: MapIndex, x0: number, y0: number, x1: number, y1: number): number[] {
  const c0 = clampI(Math.floor(Math.min(x0, x1) / ix.bucketM), ix.bcols), c1 = clampI(Math.floor(Math.max(x0, x1) / ix.bucketM), ix.bcols);
  const r0 = clampI(Math.floor(Math.min(y0, y1) / ix.bucketM), ix.brows), r1 = clampI(Math.floor(Math.max(y0, y1) / ix.bucketM), ix.brows);
  const seen = new Set<number>();
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) for (const si of ix.buckets[r * ix.bcols + c]!) seen.add(si);
  return [...seen].sort((a, b) => a - b);
}

/**
 * Allocation-free `segmentsInRect`: writes the same indices, in the same (strictly ascending) order, into `out`
 * and returns how many. `out` grows if it is too short (a plain array the caller keeps as scratch).
 * The caller must finish with the list before the next call that writes the same `out`.
 */
export function segmentsInRectInto(ix: MapIndex, x0: number, y0: number, x1: number, y1: number, out: number[]): number {
  const c0 = clampI(Math.floor(Math.min(x0, x1) / ix.bucketM), ix.bcols), c1 = clampI(Math.floor(Math.max(x0, x1) / ix.bucketM), ix.bcols);
  const r0 = clampI(Math.floor(Math.min(y0, y1) / ix.bucketM), ix.brows), r1 = clampI(Math.floor(Math.max(y0, y1) / ix.bucketM), ix.brows);
  let gen = ix.stampGen + 1;
  if (gen > 0xfffffff0) { ix.stamp.fill(0); gen = 1; }
  ix.stampGen = gen;
  const stamp = ix.stamp;
  let n = 0;
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
    const list = ix.buckets[r * ix.bcols + c]!;
    for (let q = 0; q < list.length; q++) {
      const si = list[q]!;
      if (stamp[si] === gen) continue;
      stamp[si] = gen;
      out[n++] = si;
    }
  }
  // Each bucket's list is ascending, so a few buckets' worth is nearly sorted: an insertion sort is cheap.
  // A large rectangle collects many: then a pass over the stamps in id order is cheaper (same result).
  if (n > 64 && n * n > 16 * stamp.length) {
    let k = 0;
    for (let si = 0; si < stamp.length; si++) if (stamp[si] === gen) out[k++] = si;
    return k;
  }
  for (let i = 1; i < n; i++) {
    const v = out[i]!;
    let j = i - 1;
    while (j >= 0 && out[j]! > v) { out[j + 1] = out[j]!; j--; }
    out[j + 1] = v;
  }
  return n;
}

/** Point-in-polygon (even-odd rule) for a flat coordinate list. */
export function pointInPolygon(poly: readonly number[], x: number, y: number): boolean {
  let inside = false;
  const n = poly.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = poly[i * 2]!, yi = poly[i * 2 + 1]!, xj = poly[j * 2]!, yj = poly[j * 2 + 1]!;
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** The building containing (x, y), if any (linear scan; use the index for many queries). */
export function buildingAt(m: MapDef, x: number, y: number): number | null {
  for (const b of m.buildings) if (pointInPolygon(b.footprint, x, y)) return b.id;
  return null;
}

/** Check a map against the catalog: sizes consistent, every referenced data ID known. Returns problems. */
export function validateMap(m: MapDef, t: TerrainCatalog): string[] {
  const p: string[] = [];
  if (!(m.cellSizeM >= 2 && m.cellSizeM <= 5)) p.push(`cell size ${m.cellSizeM} m is outside 2..5 m`);
  if (!(m.widthM > 0 && m.heightM > 0 && m.widthM <= MAX_MAP_SIZE_M && m.heightM <= MAX_MAP_SIZE_M)) p.push(`map size ${m.widthM} x ${m.heightM} m is outside 0..${MAX_MAP_SIZE_M} m`);
  if (m.cols !== Math.ceil(m.widthM / m.cellSizeM) || m.rows !== Math.ceil(m.heightM / m.cellSizeM)) {
    p.push(`grid ${m.cols} x ${m.rows} does not cover ${m.widthM} x ${m.heightM} m in ${m.cellSizeM} m cells`);
  }
  if (m.heights.length !== (m.cols + 1) * (m.rows + 1)) p.push("heights length does not match grid");
  if (m.surface.length !== m.cols * m.rows) p.push("surface length does not match grid");
  if (m.vegetation.length !== m.cols * m.rows) p.push("vegetation length does not match grid");
  m.surfacePalette.forEach((s) => { if (!t.surfaces[s]) p.push(`unknown surface '${s}'`); });
  m.vegetationPalette.forEach((s) => { if (!t.vegetation[s]) p.push(`unknown vegetation '${s}'`); });
  for (let i = 0; i < m.surface.length; i++) if (m.surface[i]! >= m.surfacePalette.length) { p.push(`surface index out of palette at cell ${i}`); break; }
  for (let i = 0; i < m.vegetation.length; i++) if (m.vegetation[i]! > m.vegetationPalette.length) { p.push(`vegetation index out of palette at cell ${i}`); break; }
  for (const o of m.obstacles) {
    if (!t.obstacles[o.kind]) p.push(`obstacle ${o.id}: unknown kind '${o.kind}'`);
    if (!t.materials[o.material]) p.push(`obstacle ${o.id}: unknown material '${o.material}'`);
  }
  for (const b of m.buildings) {
    if (!t.buildings[b.kind]) p.push(`building ${b.id}: unknown kind '${b.kind}'`);
    if (!t.materials[b.wallMaterial]) p.push(`building ${b.id}: unknown material '${b.wallMaterial}'`);
  }
  for (const r of m.roads) if (!t.surfaces[r.surface]) p.push(`road ${r.id}: unknown surface '${r.surface}'`);
  return p;
}
