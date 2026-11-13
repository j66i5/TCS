/**
 * Flat pixel map (M7.5b, plan m7.5 §4; owner answer 3): flat muted colours from the appearance palette, crisp
 * pixel edges (nearest sampling, no blending), thin dark outlines round fields, roads, water and tree crowns, no
 * hill shading; contour lines in their own layer, shown only zoomed out. Buildings are separate layers
 * (`buildings.ts`: floors, and roofs that fade).
 *
 * One painter (`paintRegion`) draws any rectangle of the map at any resolution, pixel for pixel in plain
 * JavaScript (no canvas, no anti-aliasing, so it also runs in tests): the whole map at about 1 px/m once, and
 * close up detail tiles of 64 m at 4 px/m built lazily (at most one per frame, the last 48 kept). Patterns are
 * keyed to world positions, so tiles join seamlessly. Original art (docs/ASSETS.md).
 */
import { BufferImageSource, Container, Sprite, Texture } from "pixi.js";
import { heightAt, type MapDef, type TerrainCatalog } from "@tcs/sim";
import type { Appearance } from "@tcs/data";

export const TILE_M = 64;
export const TILE_PPM = 4;
export const TILE_CACHE = 48;

type TreeKind = 0 | 1 | 2 | 3; // 0 none / low cover, 1 wood, 2 orchard, 3 scrub
export interface FlatColours {
  /** Per surface palette index. */
  surface: number[];
  /** Per vegetation value (1-based palette index; 0 unused). */
  vegetation: number[];
  treeKind: TreeKind[];
  /** Surface texture per surface palette index: 0 plain, 1 furrows, 2 stubble rows. */
  surfaceTex: number[];
  obstacle: Record<string, number>;
  road: Record<string, number>;
  waterDeep: number;
  waterShallow: number;
  outline: number;
  /** Per map cell: flat colour, ground kind (-1 under trees; for the seams), texture 0/1/2. */
  cellColour: Int32Array;
  cellKey: Int32Array;
  cellTex: Uint8Array;
  /** Edge wobble lattice (every WOBBLE_M metres), two offsets per node, metres. */
  wob: Float32Array;
  wobCols: number;
}

const hexN = (c: string | undefined, d: number) => (c ? parseInt(c.slice(1), 16) : d);
export const shade = (c: number, f: number) => {
  const r = Math.min(255, Math.round(((c >> 16) & 255) * f)), g = Math.min(255, Math.round(((c >> 8) & 255) * f)), b = Math.min(255, Math.round((c & 255) * f));
  return (r << 16) | (g << 8) | b;
};
const mix = (a: number, b: number, t: number) => {
  const ch = (s: number) => Math.round(((a >> s) & 255) * (1 - t) + ((b >> s) & 255) * t);
  return (ch(16) << 16) | (ch(8) << 8) | ch(0);
};

/** Edge wobble of fields and woods: a smooth offset (m) interpolated from a lattice every 8 m. */
const WOBBLE_M = 8, WOBBLE_A = 1.6;

/** Colours of a map from the appearance palette (falling back to the terrain data's own colours). */
export function flatColours(map: MapDef, t: TerrainCatalog, app: Appearance | null): FlatColours {
  const pal = app?.map;
  const surface = map.surfacePalette.map((id) => pal?.surfaces[id] ?? hexN(t.surfaces[id]?.colour, 0xff00ff));
  const vegetation = [0, ...map.vegetationPalette.map((id) => pal?.vegetation[id] ?? hexN(t.vegetation[id]?.colour, 0xff00ff))];
  // How a vegetation type is drawn (presentation only): trees, orchard rows, bushes, or flat low cover.
  const treeKind: TreeKind[] = [0, ...map.vegetationPalette.map((id): TreeKind => (id === "woodland" || id === "treeline" ? 1 : id === "orchard" ? 2 : id === "scrub" ? 3 : 0))];
  const surfaceTex = map.surfacePalette.map((id) => (id === "ploughed" ? 1 : id === "stubble" ? 2 : 0));
  const obstacle: Record<string, number> = {};
  for (const [id, k] of Object.entries(t.obstacles)) obstacle[id] = hexN(k.colour, 0xffffff);
  const road: Record<string, number> = {};
  for (const r of map.roads) road[r.surface] ??= pal?.surfaces[r.surface] ?? hexN(t.surfaces[r.surface]?.colour, 0x777777);
  // Per cell: what the ground looks like. Cells drawn as lines or shapes on top (roads, building floors, water)
  // take the most common ground of their neighbours, so no band of road colour shows past a road.
  const N = map.cols * map.rows, C = map.cols, R = map.rows;
  const under = new Set<number>();
  const roadSurf = new Set(map.roads.map((r) => r.surface));
  map.surfacePalette.forEach((id, i) => { if (roadSurf.has(id) || id === "floor" || id === "water-shallow" || id === "water-deep") under.add(i); });
  const cellColour = new Int32Array(N), cellKey = new Int32Array(N), cellTex = new Uint8Array(N);
  const own = (k: number): [number, number, number] => {
    const sIdx = map.surface[k]!, v = map.vegetation[k]!, tk = v > 0 ? treeKind[v]! : 0;
    const c = v > 0 && tk === 0 ? vegetation[v]! : tk === 1 ? mix(surface[sIdx]!, vegetation[v]!, 0.55) : surface[sIdx]!;
    return [c, tk === 1 ? -1 : sIdx * 256 + v, v > 0 && tk === 0 ? 2 : surfaceTex[sIdx]!];
  };
  for (let k = 0; k < N; k++) {
    let src = k;
    if (under.has(map.surface[k]!) && map.vegetation[k] === 0) {
      const c0 = k % C, r0 = (k - c0) / C, count = new Map<number, number>();
      let best = -1, bestN = 0;
      for (let rad = 1; rad <= 4 && best < 0; rad++) {
        for (let dr = -rad; dr <= rad; dr++) for (let dc = -rad; dc <= rad; dc++) {
          if (Math.max(Math.abs(dr), Math.abs(dc)) !== rad) continue;
          const c = c0 + dc, r = r0 + dr;
          if (c < 0 || r < 0 || c >= C || r >= R) continue;
          const j = r * C + c;
          if (under.has(map.surface[j]!) && map.vegetation[j] === 0) continue;
          const n = (count.get(j) ?? 0) + 1; count.set(j, n);
          if (best < 0 || n > bestN) { best = j; bestN = n; }
        }
      }
      if (best >= 0) src = best;
    }
    const [c, key, tex] = own(src);
    cellColour[k] = c; cellKey[k] = key; cellTex[k] = tex;
  }
  const wobCols = Math.ceil(map.widthM / WOBBLE_M) + 2, wobRows = Math.ceil(map.heightM / WOBBLE_M) + 2;
  const wob = new Float32Array(wobCols * wobRows * 2);
  for (let r = 0; r < wobRows; r++) for (let c = 0; c < wobCols; c++) {
    wob[(r * wobCols + c) * 2] = (hash(c, r, 1) - 0.5) * 2 * WOBBLE_A;
    wob[(r * wobCols + c) * 2 + 1] = (hash(c, r, 2) - 0.5) * 2 * WOBBLE_A;
  }
  return {
    surface, vegetation, treeKind, surfaceTex, obstacle, road,
    waterDeep: pal?.surfaces["water-deep"] ?? hexN(t.surfaces["water-deep"]?.colour, 0x365669),
    waterShallow: pal?.surfaces["water-shallow"] ?? hexN(t.surfaces["water-shallow"]?.colour, 0x4d6e80),
    outline: pal?.outline ?? 0x1d2419,
    cellColour, cellKey, cellTex, wob, wobCols,
  };
}

function hash(ix: number, iy: number, s = 0): number {
  let h = Math.imul(ix ^ Math.imul(s, 0x5bd1e995), 0x27d4eb2d) ^ Math.imul(iy, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** RGB -> little-endian RGBA word, opaque. */
const word = (c: number) => (0xff000000 | ((c & 255) << 16) | (c & 0xff00) | ((c >> 16) & 255)) >>> 0;
const unword = (w: number) => ((w & 255) << 16) | (w & 0xff00) | ((w >> 16) & 255);

/**
 * Paint the map rectangle (x0, y0, w, h) metres at `ppm` pixels per metre: RGBA bytes, row by row, opaque.
 * Everything but buildings: ground, low cover, tree crowns with shadows, water, roads, walls, hedges, fences.
 */
export function paintRegion(map: MapDef, col: FlatColours, x0: number, y0: number, w: number, h: number, ppm: number): Uint8Array {
  const W = Math.max(1, Math.round(w * ppm)), H = Math.max(1, Math.round(h * ppm));
  const out = new Uint32Array(W * H);
  const C = map.cols, R = map.rows, cs = map.cellSizeM, px = 1 / ppm;
  const cellAt = (x: number, y: number) => {
    const c = Math.min(C - 1, Math.max(0, Math.floor(x / cs))), r = Math.min(R - 1, Math.max(0, Math.floor(y / cs)));
    return r * C + c;
  };
  // ---- ground: one flat colour per (wobbled) cell, a light texture, dark seams between different grounds
  const key = new Int32Array(W * H); // what kind of ground (for the seams)
  const wob = col.wob, wc = col.wobCols;
  for (let j = 0; j < H; j++) {
    const y = y0 + (j + 0.5) * px, gy = Math.floor(y * ppm);
    const fy = y / WOBBLE_M, iy = Math.floor(fy), ty = fy - iy;
    for (let i = 0; i < W; i++) {
      const x = x0 + (i + 0.5) * px, gx = Math.floor(x * ppm);
      const fx = x / WOBBLE_M, ix = Math.floor(fx), tx = fx - ix;
      const a = (iy * wc + ix) * 2, b = a + 2, c = a + wc * 2, d = c + 2;
      const ox = (wob[a]! * (1 - tx) + wob[b]! * tx) * (1 - ty) + (wob[c]! * (1 - tx) + wob[d]! * tx) * ty;
      const oy = (wob[a + 1]! * (1 - tx) + wob[b + 1]! * tx) * (1 - ty) + (wob[c + 1]! * (1 - tx) + wob[d + 1]! * tx) * ty;
      const k = cellAt(x + ox, y + oy);
      const tex = col.cellTex[k]!;
      let f = 1;
      if (tex === 1 && Math.floor(y / 1.5) % 2 === 0) f = 0.92;
      else if (tex === 2 && Math.floor(x / 1.5) % 2 === 0) f = 0.95;
      const hh = hash(gx, gy, 7);
      if (hh < 0.07) f *= 0.93; else if (hh > 0.965) f *= 1.06;
      out[j * W + i] = word(f === 1 ? col.cellColour[k]! : shade(col.cellColour[k]!, f));
      key[j * W + i] = col.cellKey[k]!;
    }
  }
  // Seams: where the ground changes, the pixel takes the darker outline tone (thin, 1 px).
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const k = key[j * W + i]!;
    if (k < 0) continue;
    if ((i + 1 < W && key[j * W + i + 1] !== k && key[j * W + i + 1]! >= 0) || (j + 1 < H && key[(j + 1) * W + i] !== k && key[(j + 1) * W + i]! >= 0)) {
      out[j * W + i] = word(shade(unword(out[j * W + i]!), 0.82));
    }
  }
  // ---- trees and bushes: a jittered layout per cell, drawn row by row (lower crowns in front), shadows first
  const m = 6; // crowns and their shadows reach this far out of their cell
  const c0 = Math.max(0, Math.floor((x0 - m) / cs)), c1 = Math.min(C - 1, Math.floor((x0 + w + m) / cs));
  const r0 = Math.max(0, Math.floor((y0 - m) / cs)), r1 = Math.min(R - 1, Math.floor((y0 + h + m) / cs));
  const G = 7; // orchard rows, m
  const forEachTree = (f: (x: number, y: number, r: number, c: number) => void) => {
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
      const v = map.vegetation[r * C + c]!;
      if (v === 0) continue;
      const tk = col.treeKind[v]!, vc = col.vegetation[v]!;
      if (tk === 1 && ppm < 2) {
        // Far out: one big crown per cell (small crowns would only make a speckle).
        f((c + 0.3 + 0.4 * hash(c, r, 11)) * cs, (r + 0.3 + 0.4 * hash(c, r, 21)) * cs, 2.8 + 1.2 * hash(c, r, 31), shade(vc, 0.94 + 0.12 * hash(c, r, 41)));
      } else if (tk === 1) {
        for (let q = 0; q < 2; q++) f((c + 0.15 + 0.7 * hash(c, r, 11 + q)) * cs, (r + 0.15 + 0.7 * hash(c, r, 21 + q)) * cs, 1.9 + 0.9 * hash(c, r, 31 + q), shade(vc, 0.94 + 0.12 * hash(c, r, 41 + q)));
      } else if (tk === 3) {
        if (hash(c, r, 51) < 0.65) f((c + 0.2 + 0.6 * hash(c, r, 52)) * cs, (r + 0.2 + 0.6 * hash(c, r, 53)) * cs, 0.8 + 0.6 * hash(c, r, 54), vc);
      }
    }
    // Orchards: trees on a regular grid where the cell is orchard.
    for (let gy = Math.floor((y0 - m) / G); gy <= Math.floor((y0 + h + m) / G); gy++) for (let gx = Math.floor((x0 - m) / G); gx <= Math.floor((x0 + w + m) / G); gx++) {
      const x = (gx + 0.5) * G, y = (gy + 0.5) * G;
      if (x < 0 || y < 0 || x >= map.widthM || y >= map.heightM) continue;
      const v = map.vegetation[cellAt(x, y)]!;
      if (v > 0 && col.treeKind[v] === 2) f(x, y, 1.7, col.vegetation[v]!);
    }
  };
  const shadowed = new Uint8Array(W * H);
  forEachTree((tx, ty, tr) => {
    // Shadow (south-east): darken the ground once.
    const sx = tx + 0.45 * tr, sy = ty + 0.6 * tr, rr = tr * tr;
    const i0 = Math.max(0, Math.floor((sx - tr - x0) * ppm)), i1 = Math.min(W - 1, Math.ceil((sx + tr - x0) * ppm));
    const j0 = Math.max(0, Math.floor((sy - tr - y0) * ppm)), j1 = Math.min(H - 1, Math.ceil((sy + tr - y0) * ppm));
    for (let j = j0; j <= j1; j++) {
      const dy = y0 + (j + 0.5) * px - sy;
      for (let i = i0; i <= i1; i++) {
        const dx = x0 + (i + 0.5) * px - sx, p = j * W + i;
        if (dx * dx + dy * dy > rr || shadowed[p]) continue;
        shadowed[p] = 1;
        out[p] = word(shade(unword(out[p]!), 0.72));
      }
    }
  });
  const edge = Math.max(px, 0.3);
  forEachTree((tx, ty, tr, tc) => {
    const dark = word(shade(tc, 0.55)), lite = word(shade(tc, 1.2)), low = word(shade(tc, 0.86)), mid = word(tc);
    const rr = tr * tr, inner = (tr - edge) * (tr - edge), hl = (tr * 0.72) * (tr * 0.72);
    const i0 = Math.max(0, Math.floor((tx - tr - x0) * ppm)), i1 = Math.min(W - 1, Math.ceil((tx + tr - x0) * ppm));
    const j0 = Math.max(0, Math.floor((ty - tr - y0) * ppm)), j1 = Math.min(H - 1, Math.ceil((ty + tr - y0) * ppm));
    for (let j = j0; j <= j1; j++) {
      const dy = y0 + (j + 0.5) * px - ty;
      for (let i = i0; i <= i1; i++) {
        const dx = x0 + (i + 0.5) * px - tx, d2 = dx * dx + dy * dy;
        if (d2 > rr) continue;
        const sdir = (dx + dy) / tr;
        out[j * W + i] = d2 > inner ? dark : sdir < -0.5 && d2 < hl ? lite : sdir > 0.55 ? low : mid;
      }
    }
  });
  // ---- lines: water, roads, linear obstacles (outline pass, then fill pass)
  const stampLine = (pts: readonly number[], halfW: number, colour: number, closed = false, dotted = false) => {
    const n = pts.length / 2;
    for (let k = 0; k < (closed ? n : n - 1); k++) {
      const ax = pts[2 * k]!, ay = pts[2 * k + 1]!, bx = pts[(2 * ((k + 1) % n))]!, by = pts[(2 * ((k + 1) % n)) + 1]!;
      const hw = Math.max(halfW, px * 0.5);
      const i0 = Math.max(0, Math.floor((Math.min(ax, bx) - hw - x0) * ppm)), i1 = Math.min(W - 1, Math.ceil((Math.max(ax, bx) + hw - x0) * ppm));
      const j0 = Math.max(0, Math.floor((Math.min(ay, by) - hw - y0) * ppm)), j1 = Math.min(H - 1, Math.ceil((Math.max(ay, by) + hw - y0) * ppm));
      if (i0 > i1 || j0 > j1) continue;
      const ex = bx - ax, ey = by - ay, L2 = ex * ex + ey * ey || 1e-9;
      const wd = word(colour);
      for (let j = j0; j <= j1; j++) {
        const py = y0 + (j + 0.5) * px;
        for (let i = i0; i <= i1; i++) {
          const qx = x0 + (i + 0.5) * px;
          let u = ((qx - ax) * ex + (py - ay) * ey) / L2;
          u = u < 0 ? 0 : u > 1 ? 1 : u;
          const dx = qx - ax - u * ex, dy = py - ay - u * ey;
          if (dx * dx + dy * dy > hw * hw) continue;
          if (dotted && (Math.floor(qx * ppm) + Math.floor(py * ppm)) % 3 === 0) continue;
          out[j * W + i] = wd;
        }
      }
    }
  };
  const fillPoly = (pts: readonly number[], colour: number) => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let k = 0; k < pts.length; k += 2) { minX = Math.min(minX, pts[k]!); maxX = Math.max(maxX, pts[k]!); minY = Math.min(minY, pts[k + 1]!); maxY = Math.max(maxY, pts[k + 1]!); }
    const i0 = Math.max(0, Math.floor((minX - x0) * ppm)), i1 = Math.min(W - 1, Math.ceil((maxX - x0) * ppm));
    const j0 = Math.max(0, Math.floor((minY - y0) * ppm)), j1 = Math.min(H - 1, Math.ceil((maxY - y0) * ppm));
    const wd = word(colour), n = pts.length / 2;
    for (let j = j0; j <= j1; j++) {
      const py = y0 + (j + 0.5) * px;
      for (let i = i0; i <= i1; i++) {
        const qx = x0 + (i + 0.5) * px;
        let inside = false;
        for (let a = 0, b = n - 1; a < n; b = a++) {
          const ay = pts[2 * a + 1]!, by = pts[2 * b + 1]!;
          if ((ay > py) !== (by > py) && qx < ((pts[2 * b]! - pts[2 * a]!) * (py - ay)) / (by - ay) + pts[2 * a]!) inside = !inside;
        }
        if (inside) out[j * W + i] = wd;
      }
    }
  };
  const ol = Math.max(px, 0.35); // outline width, m (at least one pixel)
  for (const wb of map.water) {
    if (wb.kind === "pond") { stampLine(wb.points, ol, shade(col.waterDeep, 0.6), true); fillPoly(wb.points, col.waterDeep); }
    else stampLine(wb.points, wb.widthM / 2 + ol, shade(col.waterShallow, 0.62));
  }
  for (const wb of map.water) if (wb.kind === "stream") stampLine(wb.points, wb.widthM / 2, col.waterShallow);
  for (const r of map.roads) stampLine(r.points, r.widthM / 2 + ol, shade(col.road[r.surface] ?? 0x777777, 0.68));
  for (const r of map.roads) stampLine(r.points, r.widthM / 2, col.road[r.surface] ?? 0x777777);
  for (const o of map.obstacles) {
    const c = col.obstacle[o.kind] ?? 0xffffff;
    if (o.kind === "hedge") { stampLine(o.points, 1.3 + ol, shade(c, 0.55)); }
    else if (o.kind === "embankment") { stampLine(o.points, o.thicknessM / 2 + ol, shade(c, 0.7)); }
    else if (o.thicknessM * ppm >= 1.5) stampLine(o.points, o.thicknessM / 2 + ol, shade(c, 0.5));
  }
  for (const o of map.obstacles) {
    const c = col.obstacle[o.kind] ?? 0xffffff;
    if (o.kind === "hedge") {
      stampLine(o.points, 1.3, c);
      if (ppm >= 2) stampLine(o.points, 0.45, shade(c, 1.18), false, true); // a broken lighter crest
    } else if (o.kind === "embankment") stampLine(o.points, o.thicknessM / 2, c);
    else if (o.kind === "wire-fence") stampLine(o.points, Math.max(o.thicknessM, px) / 2, c, false, true);
    else stampLine(o.points, Math.max(o.thicknessM, px) / 2, o.kind === "wooden-fence" ? shade(c, 0.85) : c);
  }
  return new Uint8Array(out.buffer);
}

/**
 * Contour lines (2.5 m, every fourth one bold) as RGBA with alpha, premultiplied, at `ppm` over the whole map.
 */
export function paintContours(map: MapDef, ppm: number): Uint8Array {
  const W = Math.max(1, Math.round(map.widthM * ppm)), H = Math.max(1, Math.round(map.heightM * ppm)), px = 1 / ppm;
  const out = new Uint8Array(W * H * 4);
  let row = new Float32Array(W + 1), next = new Float32Array(W + 1);
  const fill = (a: Float32Array, j: number) => { for (let i = 0; i <= W; i++) a[i] = heightAt(map, Math.min(map.widthM - 0.01, (i + 0.5) * px), Math.min(map.heightM - 0.01, (j + 0.5) * px)); };
  fill(row, 0);
  const ink = [0x3a, 0x2e, 0x1f];
  for (let j = 0; j < H; j++) {
    fill(next, Math.min(H - 1, j + 1));
    for (let i = 0; i < W; i++) {
      const h0 = row[i]!, hr = row[i + 1]!, hd = next[i]!;
      const lo = Math.min(h0, hr, hd), hi = Math.max(h0, hr, hd);
      if (Math.floor(lo / 2.5) === Math.floor(hi / 2.5)) continue;
      const major = Math.floor(lo / 10) !== Math.floor(hi / 10);
      const a = major ? 0.55 : 0.28, o = (j * W + i) * 4;
      out[o] = Math.round(ink[0]! * a); out[o + 1] = Math.round(ink[1]! * a); out[o + 2] = Math.round(ink[2]! * a); out[o + 3] = Math.round(255 * a);
    }
    [row, next] = [next, row];
  }
  return out;
}

const texOf = (data: Uint8Array, width: number, height: number, mode: "nearest" | "linear") =>
  new Texture({ source: new BufferImageSource({ resource: data, width, height, format: "rgba8unorm", alphaMode: "premultiplied-alpha", scaleMode: mode }) });

/** Base resolution for a map: about 1 px/m, at most 2048 px a side. */
export const basePpm = (map: MapDef) => Math.min(1, 2048 / Math.max(map.widthM, map.heightM));

/**
 * The flat map: the base picture, the detail tiles above it (close up only) and the contour layer (zoomed out
 * only). `update` is called every frame with the camera.
 */
export class FlatTerrain {
  readonly root = new Container();
  readonly base: Sprite;
  readonly contours: Sprite;
  private tiles = new Container();
  private cache = new Map<string, { sprite: Sprite; used: number }>();
  private frame = 0;
  private ppm: number;

  constructor(private map: MapDef, private colours: FlatColours) {
    this.ppm = basePpm(map);
    const W = Math.round(map.widthM * this.ppm), H = Math.round(map.heightM * this.ppm);
    this.base = new Sprite(texOf(paintRegion(map, colours, 0, 0, map.widthM, map.heightM, this.ppm), W, H, "nearest"));
    this.base.width = map.widthM; this.base.height = map.heightM;
    this.contours = new Sprite(texOf(paintContours(map, this.ppm), W, H, "linear"));
    this.contours.width = map.widthM; this.contours.height = map.heightM;
    this.root.addChild(this.base, this.tiles, this.contours);
  }

  /**
   * Per frame: sampling by zoom (nearest when enlarged), contours only zoomed out, detail tiles over the visible
   * area when `detail` (one new tile at most, nearest the centre first).
   */
  update(view: { x: number; y: number; w: number; h: number }, scale: number, detail: boolean, contours: boolean): void {
    this.frame++;
    const mode = scale >= this.ppm ? "nearest" : "linear";
    if (this.base.texture.source.scaleMode !== mode) this.base.texture.source.scaleMode = mode;
    this.contours.visible = contours;
    this.tiles.visible = detail;
    if (!detail) return;
    const tx0 = Math.max(0, Math.floor(view.x / TILE_M)), ty0 = Math.max(0, Math.floor(view.y / TILE_M));
    const tx1 = Math.min(Math.ceil(this.map.widthM / TILE_M) - 1, Math.floor((view.x + view.w) / TILE_M));
    const ty1 = Math.min(Math.ceil(this.map.heightM / TILE_M) - 1, Math.floor((view.y + view.h) / TILE_M));
    for (const t of this.cache.values()) t.sprite.visible = false;
    let want: { k: string; tx: number; ty: number; d: number } | null = null;
    const cx = view.x + view.w / 2, cy = view.y + view.h / 2;
    for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) {
      const k = `${tx},${ty}`, t = this.cache.get(k);
      if (t) { t.sprite.visible = true; t.used = this.frame; continue; }
      const d = ((tx + 0.5) * TILE_M - cx) ** 2 + ((ty + 0.5) * TILE_M - cy) ** 2;
      if (!want || d < want.d) want = { k, tx, ty, d };
    }
    if (want) this.buildTile(want.k, want.tx, want.ty);
  }

  /** Build every tile over an area now (the opening view, so the first picture is complete). */
  prime(view: { x: number; y: number; w: number; h: number }): void {
    for (let ty = Math.max(0, Math.floor(view.y / TILE_M)); ty <= Math.floor((view.y + view.h) / TILE_M); ty++) {
      for (let tx = Math.max(0, Math.floor(view.x / TILE_M)); tx <= Math.floor((view.x + view.w) / TILE_M); tx++) {
        if (tx * TILE_M >= this.map.widthM || ty * TILE_M >= this.map.heightM) continue;
        const k = `${tx},${ty}`;
        if (!this.cache.has(k)) this.buildTile(k, tx, ty);
      }
    }
  }

  private buildTile(k: string, tx: number, ty: number): void {
    const x = tx * TILE_M, y = ty * TILE_M, w = Math.min(TILE_M, this.map.widthM - x), h = Math.min(TILE_M, this.map.heightM - y);
    const W = Math.round(w * TILE_PPM), H = Math.round(h * TILE_PPM);
    const s = new Sprite(texOf(paintRegion(this.map, this.colours, x, y, w, h, TILE_PPM), W, H, "nearest"));
    s.position.set(x, y); s.width = w; s.height = h;
    this.tiles.addChild(s);
    this.cache.set(k, { sprite: s, used: this.frame });
    if (this.cache.size > TILE_CACHE) {
      let old: string | null = null, oldest = Infinity;
      for (const [kk, t] of this.cache) if (t.used < oldest && kk !== k) { oldest = t.used; old = kk; }
      if (old !== null) { const t = this.cache.get(old)!; this.tiles.removeChild(t.sprite); t.sprite.destroy({ texture: true, textureSource: true }); this.cache.delete(old); }
    }
  }

  destroy(): void { this.root.destroy({ children: true, texture: true, textureSource: true }); }
}
