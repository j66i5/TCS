/**
 * Once per map (plan "photo" step "ground" 3): everything the photo ground painter needs that does not depend on the
 * tile, so tiles stay cheap and join seamlessly. Deterministic and row-major; pure (no Pixi, no DOM).
 *
 * - fields: connected parts of the map with the same ground (the flat painter's `cellKey`, which already gives cells
 *   under roads, floors and water the ground of their neighbours);
 * - per field: a brightness tint, a warm/cool shift, and the furrow direction (the long side of the field, plus a
 *   small hashed jitter);
 * - per cell: the field's colour, what texture it carries, and how far it is from the field edge (in cells, at most 4);
 * - a 2 m grid of slowly varying values: the domain warp of the field edges, broad tone patches and mottling, hue
 *   drift, dry patches, hillshade from the heights, and the furrow phase wobble.
 */
import { heightAt, type MapDef } from "@tcs/sim";
import type { FlatColours } from "../flat/paint";
import { fbm as fbmImp, hash2, smoothstep as smoothstepImp, vnoise as vnoiseImp } from "./noise";
import { hillshade as hillshadeImp } from "./light";
import { buildStamps, prepareVegetation, type Stamp, type VegPrep } from "./crowns";
import { prepareLines, type LinePrep } from "./lines";

/** Ground textures of the photo painter. */
export const Tex = { Grass: 0, Plough: 1, Rows: 2, Meadow: 3, Garden: 4, Forest: 5, Worn: 6, Hard: 7 } as const;
export type Tex = (typeof Tex)[keyof typeof Tex];

/** Grade of the finished picture (appearance.json `photo.grade`). */
export interface PhotoGrade { desaturate: number; contrast: number; warm: number; grain: number }
export const DEFAULT_GRADE: PhotoGrade = { desaturate: 0.28, contrast: 0.06, warm: 0.02, grain: 0.03 };

/** The macro grid: one node every MACRO_M metres, MACRO_CH values per node. */
export const MACRO_M = 2;
export const MACRO_CH = 7;
/** Channels of the macro grid. */
export const M_WX = 0, M_WY = 1, M_TONE = 2, M_HUE = 3, M_DRY = 4, M_HILL = 5, M_PHASE = 6;
/** Edge distance cap (cells). */
export const EDGE_CAP = 4;

export interface PhotoPrep {
  cols: number; rows: number; cs: number; widthM: number; heightM: number;
  /** Per cell: field id, colour (0..255 floats, field tint in), texture, edge distance (cells, 0..EDGE_CAP). */
  field: Int32Array;
  r: Float32Array; g: Float32Array; b: Float32Array;
  tex: Uint8Array;
  edge: Uint8Array;
  /** Per field: furrow direction (unit vector along the rows). */
  fcos: Float32Array; fsin: Float32Array;
  macro: Float32Array; mcols: number; mrows: number;
  /** Colour margins and dry patches lean toward (grass, straw). */
  grass: [number, number, number];
  straw: [number, number, number];
  grade: PhotoGrade;
  /** Trees, hedges, orchards, scrub (step "vegetation"). */
  veg: VegPrep;
  /** Roads, water, walls, fences, embankments, building shadows (step "built"). */
  lines: LinePrep;
  /** Crown stamps per ppm, built on first use (at most about 10 ms each). */
  stamps: Map<number, Stamp[]>;
}

/** The crown stamps of a prep at `ppm` (built once). */
export function stampsFor(p: PhotoPrep, ppm: number): Stamp[] {
  let s = p.stamps.get(ppm);
  if (!s) { s = buildStamps(ppm); p.stamps.set(ppm, s); }
  return s;
}

const rgb = (c: number): [number, number, number] => [(c >> 16) & 255, (c >> 8) & 255, c & 255];

/** Texture of a ground by its surface and vegetation ids (presentation only). */
function texOf(surface: string, veg: string | undefined): Tex {
  if (veg === "crops") return Tex.Rows;
  if (veg === "tall-grass") return Tex.Meadow;
  switch (surface) {
    case "ploughed": return Tex.Plough;
    case "stubble": return Tex.Rows;
    case "meadow": return Tex.Meadow;
    case "garden": return Tex.Garden;
    case "forest-floor": return Tex.Forest;
    case "yard": case "mud": case "dirt-track": return Tex.Worn;
    case "gravel": case "concrete": case "asphalt": case "floor": return Tex.Hard;
    default: return Tex.Grass;
  }
}

/** Build the per-map data of the photo painter. `col` is the flat colour set built from the photo palette. */
export function preparePhoto(map: MapDef, col: FlatColours, grade: PhotoGrade = DEFAULT_GRADE): PhotoPrep {
  const C = map.cols, R = map.rows, N = C * R, cs = map.cellSizeM;
  const key = col.cellKey;
  // ---- fields: 4-connected components of equal ground key (row-major flood fill, so ids are stable)
  const field = new Int32Array(N).fill(-1);
  const stack = new Int32Array(N);
  let nf = 0;
  for (let k0 = 0; k0 < N; k0++) {
    if (field[k0] !== -1) continue;
    const kk = key[k0]!;
    let sp = 0;
    stack[sp++] = k0; field[k0] = nf;
    while (sp > 0) {
      const k = stack[--sp]!, c = k % C;
      if (c > 0 && field[k - 1] === -1 && key[k - 1] === kk) { field[k - 1] = nf; stack[sp++] = k - 1; }
      if (c < C - 1 && field[k + 1] === -1 && key[k + 1] === kk) { field[k + 1] = nf; stack[sp++] = k + 1; }
      if (k >= C && field[k - C] === -1 && key[k - C] === kk) { field[k - C] = nf; stack[sp++] = k - C; }
      if (k + C < N && field[k + C] === -1 && key[k + C] === kk) { field[k + C] = nf; stack[sp++] = k + C; }
    }
    nf++;
  }
  // ---- per field: second moments of the cell centres -> the longer grid direction
  const sx = new Float64Array(nf), sy = new Float64Array(nf), sxx = new Float64Array(nf), syy = new Float64Array(nf), cnt = new Float64Array(nf);
  for (let k = 0; k < N; k++) {
    const f = field[k]!, x = k % C, y = (k - x) / C;
    sx[f]! += x; sy[f]! += y; sxx[f]! += x * x; syy[f]! += y * y; cnt[f]!++;
  }
  const fcos = new Float32Array(nf), fsin = new Float32Array(nf);
  const tint = new Float32Array(nf), warm = new Float32Array(nf);
  for (let f = 0; f < nf; f++) {
    const n = cnt[f]!, mx = sx[f]! / n, my = sy[f]! / n;
    const cxx = sxx[f]! / n - mx * mx, cyy = syy[f]! / n - my * my;
    const jitter = (hash2(f, 3, 0x51) - 0.5) * 2 * (4 * Math.PI / 180);
    // Along the grid, the longer way: fields are built of grid cells, and the principal axis of a large, irregular
    // field (an L shape, a field wrapped round a village) runs on a slant that reads wrong for furrows and tramlines.
    const a = (cxx >= cyy ? 0 : Math.PI / 2) + jitter;
    fcos[f] = Math.cos(a); fsin[f] = Math.sin(a);
    tint[f] = (hash2(f, 1, 0x52) - 0.5) * 2;
    warm[f] = (hash2(f, 2, 0x53) - 0.5) * 2;
  }
  // ---- per cell: colour, texture
  const r = new Float32Array(N), g = new Float32Array(N), b = new Float32Array(N), tex = new Uint8Array(N);
  const sPal = map.surfacePalette, vPal = map.vegetationPalette;
  for (let k = 0; k < N; k++) {
    const kk = key[k]!, f = field[k]!;
    let c: number, t: Tex;
    if (kk < 0) { c = col.surface[map.surface[k]!]!; t = Tex.Forest; } // under trees: forest floor, mostly hidden
    else { c = col.cellColour[k]!; t = texOf(sPal[kk >> 8]!, (kk & 255) > 0 ? vPal[(kk & 255) - 1] : undefined); }
    let [cr, cg, cb] = rgb(c);
    let br = 1 + 0.06 * tint[f]!;
    if (t === Tex.Garden) br = 1 + 0.12 * tint[f]!;
    if (t === Tex.Forest) br *= 0.62;
    if (t === Tex.Rows && kk >= 0 && (kk & 255) > 0) br *= 1.06; // standing crops a little lighter
    const w = 0.025 * warm[f]!;
    cr *= br * (1 + w); cg *= br; cb *= br * (1 - w);
    r[k] = cr; g[k] = cg; b[k] = cb; tex[k] = t;
  }
  // ---- edge distance: multi-source BFS from cells with a 4-neighbour of another field, capped
  const edge = new Uint8Array(N).fill(EDGE_CAP);
  const q = new Int32Array(N);
  let qh = 0, qt = 0;
  for (let k = 0; k < N; k++) {
    const f = field[k]!, c = k % C;
    if ((c > 0 && field[k - 1] !== f) || (c < C - 1 && field[k + 1] !== f) || (k >= C && field[k - C] !== f) || (k + C < N && field[k + C] !== f)) { edge[k] = 0; q[qt++] = k; }
  }
  while (qh < qt) {
    const k = q[qh++]!, d = edge[k]! + 1, c = k % C;
    if (d >= EDGE_CAP) continue;
    if (c > 0 && edge[k - 1]! > d) { edge[k - 1] = d; q[qt++] = k - 1; }
    if (c < C - 1 && edge[k + 1]! > d) { edge[k + 1] = d; q[qt++] = k + 1; }
    if (k >= C && edge[k - C]! > d) { edge[k - C] = d; q[qt++] = k - C; }
    if (k + C < N && edge[k + C]! > d) { edge[k + C] = d; q[qt++] = k + C; }
  }
  // ---- macro grid (2 m) from x = y = 0, one node beyond the right and bottom edges (readers clamp below 0)
  const mcols = Math.ceil(map.widthM / MACRO_M) + 2, mrows = Math.ceil(map.heightM / MACRO_M) + 2;
  const macro = new Float32Array(mcols * mrows * MACRO_CH);
  const fbm = fbmImp, vnoise = vnoiseImp, smoothstep = smoothstepImp, hillshade = hillshadeImp, height = heightAt; // locals: hot loop
  // Heights at the nodes once; the hillshade slopes from neighbouring nodes.
  const hts = new Float32Array(mcols * mrows);
  for (let j = 0; j < mrows; j++) for (let i = 0; i < mcols; i++) {
    // ground: ok (presentation: hillshade of the terrain picture)
    hts[j * mcols + i] = height(map, Math.min(map.widthM, i * MACRO_M), Math.min(map.heightM, j * MACRO_M));
  }
  // The slow channels (wavelengths of 15 m and more) on an 8 m grid, read bilinearly: a sixteenth of the noise calls.
  const CO = 4, ccols = Math.ceil(mcols / CO) + 1, crows = Math.ceil(mrows / CO) + 1, slow = new Float32Array(ccols * crows * 4);
  for (let j = 0; j < crows; j++) for (let i = 0; i < ccols; i++) {
    const x = i * CO * MACRO_M, y = j * CO * MACRO_M, o = (j * ccols + i) * 4;
    slow[o] = 0.05 * vnoise(x / 50, y / 50, 17);
    slow[o + 1] = 0.025 * vnoise(x / 40, y / 40, 23);
    slow[o + 2] = 0.06 * smoothstep(0.18, 0.55, fbm(x, y, 23, 3, 29));
    slow[o + 3] = 0.6 * vnoise(x / 15, y / 15, 31);
  }
  for (let j = 0; j < mrows; j++) {
    const y = j * MACRO_M, jm = j > 0 ? j - 1 : j, jp = j < mrows - 1 ? j + 1 : j;
    const cj = Math.floor(j / CO), ty = (j - cj * CO) / CO;
    for (let i = 0; i < mcols; i++) {
      const x = i * MACRO_M, o = (j * mcols + i) * MACRO_CH, im = i > 0 ? i - 1 : i, ip = i < mcols - 1 ? i + 1 : i;
      const ci = Math.floor(i / CO), tx = (i - ci * CO) / CO;
      const s00 = (cj * ccols + ci) * 4, s10 = s00 + 4, s01 = s00 + ccols * 4, s11 = s01 + 4;
      const w00 = (1 - tx) * (1 - ty), w10 = tx * (1 - ty), w01 = (1 - tx) * ty, w11 = tx * ty;
      macro[o + M_WX] = 1.8 * fbm(x, y, 10, 2, 11);
      macro[o + M_WY] = 1.8 * fbm(x, y, 10, 2, 13);
      macro[o + M_TONE] = slow[s00]! * w00 + slow[s10]! * w10 + slow[s01]! * w01 + slow[s11]! * w11 + 0.05 * fbm(x, y, 7, 2, 19);
      macro[o + M_HUE] = slow[s00 + 1]! * w00 + slow[s10 + 1]! * w10 + slow[s01 + 1]! * w01 + slow[s11 + 1]! * w11;
      macro[o + M_DRY] = slow[s00 + 2]! * w00 + slow[s10 + 2]! * w10 + slow[s01 + 2]! * w01 + slow[s11 + 2]! * w11;
      const dx = (hts[j * mcols + ip]! - hts[j * mcols + im]!) / ((ip - im) * MACRO_M), dy = (hts[jp * mcols + i]! - hts[jm * mcols + i]!) / ((jp - jm) * MACRO_M);
      macro[o + M_HILL] = hillshade(dx, dy);
      macro[o + M_PHASE] = slow[s00 + 3]! * w00 + slow[s10 + 3]! * w10 + slow[s01 + 3]! * w01 + slow[s11 + 3]! * w11;
    }
  }
  const grassC = col.surface[sPal.indexOf("grass")] ?? 0x68774f;
  return {
    cols: C, rows: R, cs, widthM: map.widthM, heightM: map.heightM,
    field, r, g, b, tex, edge, fcos, fsin, macro, mcols, mrows,
    grass: rgb(grassC), straw: [0xb4, 0xa8, 0x7c], grade,
    veg: prepareVegetation(map, col), lines: prepareLines(map, col, rgb(grassC)), stamps: new Map(),
  };
}
