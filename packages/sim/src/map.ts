/**
 * MAP (SPEC 6.1). Static terrain of a battle: a heightfield plus terrain layers.
 *
 * Coordinates: metres. x grows east, y grows south, origin at the north-west corner; z is height.
 * Grids: the map is divided into `cols x rows` square cells of `cellSizeM` (2..5 m).
 *  - heights:    (cols+1) x (rows+1) samples at cell CORNERS, metres above datum, row-major.
 *  - surface:    one byte per cell, index into `surfacePalette` (data IDs).
 *  - vegetation: one byte per cell, 0 = none, i = `vegetationPalette[i-1]`.
 * Vector layers: linear obstacles (walls, hedges, fences, embankments), buildings (wall polygon with
 * material/thickness, doors and windows, storeys), roads, water. Kinds and materials are data IDs.
 *
 * The map never changes during a battle. Damage (breaches, craters, thinned vegetation) is SimState
 * (`state.terrain`), so it saves and replays. The map is part of the BattleInput; its fingerprint is
 * stored in the state and checked when a save is loaded.
 */
import type { DefId } from "./ids";
import { hashText } from "./hash";

export const MAX_MAP_SIZE_M = 4000;
export const MAP_FORMAT_VERSION = 1;

/** Polyline or polygon as a flat list x0, y0, x1, y1, ... */
export type Coords = number[];

export interface LinearObstacle {
  id: number;
  kind: DefId;
  points: Coords;
  heightM: number;
  thicknessM: number;
  material: DefId;
}

export interface Opening {
  /** Index of the wall: edge from footprint vertex `wall` to `wall + 1`. */
  wall: number;
  /** Distance of the opening's centre from the wall's first vertex, m. */
  offsetM: number;
  widthM: number;
  kind: "door" | "window";
  /** Height of the bottom and top of the opening above the floor, m. */
  sillM: number;
  headM: number;
}

export interface Building {
  id: number;
  kind: DefId;
  /** Outer wall polygon, counter-clockwise in screen coordinates (y down). */
  footprint: Coords;
  storeys: number;
  storeyHeightM: number;
  wallMaterial: DefId;
  wallThicknessM: number;
  openings: Opening[];
  roofColour: string;
}

export interface Road {
  id: number;
  points: Coords;
  widthM: number;
  surface: DefId;
}

export interface WaterBody {
  id: number;
  kind: "pond" | "stream";
  /** Pond: polygon. Stream: centre line. */
  points: Coords;
  /** Stream width, m (0 for ponds). */
  widthM: number;
  depthM: number;
}

export interface MapMeta {
  /** Generator or importer that produced the map, e.g. "tcs-mapgen". */
  generator: string;
  /** Map kind, e.g. "village". */
  kind: string;
  seed: number;
  /** Generator version: a changed generator must bump it so old saves are refused. */
  version: number;
}

export interface MapDef {
  id: string;
  name: string;
  widthM: number;
  heightM: number;
  cellSizeM: number;
  cols: number;
  rows: number;
  heights: Float32Array;
  surfacePalette: DefId[];
  surface: Uint8Array;
  vegetationPalette: DefId[];
  vegetation: Uint8Array;
  obstacles: LinearObstacle[];
  buildings: Building[];
  roads: Road[];
  water: WaterBody[];
  meta: MapMeta;
}

/** An empty map of one surface type, flat at 0 m. */
export function flatMap(id: string, widthM: number, heightM: number, cellSizeM = 4, surface: DefId = "grass"): MapDef {
  if (widthM > MAX_MAP_SIZE_M || heightM > MAX_MAP_SIZE_M) throw new Error("map too large");
  const cols = Math.ceil(widthM / cellSizeM);
  const rows = Math.ceil(heightM / cellSizeM);
  return {
    id, name: id, widthM, heightM, cellSizeM, cols, rows,
    heights: new Float32Array((cols + 1) * (rows + 1)),
    surfacePalette: [surface],
    surface: new Uint8Array(cols * rows),
    vegetationPalette: [],
    vegetation: new Uint8Array(cols * rows),
    obstacles: [], buildings: [], roads: [], water: [],
    meta: { generator: "flat", kind: "flat", seed: 0, version: 1 },
  };
}

// ---------------------------------------------------------------- file format

/**
 * Map file: JSON with the grids as base64 of little-endian binary (Float32 heights, Uint8 layers).
 * Decision 2026-11-11 (DECISIONS.md): the heightfield lives inside the JSON instead of a separate
 * heightmap image; an image export/import is a tool feature for the editor/importer milestone.
 */
export interface MapFile {
  format: "tcs-map";
  formatVersion: number;
  id: string;
  name: string;
  widthM: number;
  heightM: number;
  cellSizeM: number;
  cols: number;
  rows: number;
  heights: string;
  surfacePalette: DefId[];
  surface: string;
  vegetationPalette: DefId[];
  vegetation: string;
  obstacles: LinearObstacle[];
  buildings: Building[];
  roads: Road[];
  water: WaterBody[];
  meta: MapMeta;
}

export function mapToFile(m: MapDef): MapFile {
  const hb = new Uint8Array(m.heights.length * 4);
  const dv = new DataView(hb.buffer);
  for (let i = 0; i < m.heights.length; i++) dv.setFloat32(i * 4, m.heights[i]!, true);
  return {
    format: "tcs-map", formatVersion: MAP_FORMAT_VERSION,
    id: m.id, name: m.name, widthM: m.widthM, heightM: m.heightM, cellSizeM: m.cellSizeM, cols: m.cols, rows: m.rows,
    heights: toBase64(hb),
    surfacePalette: [...m.surfacePalette], surface: toBase64(m.surface),
    vegetationPalette: [...m.vegetationPalette], vegetation: toBase64(m.vegetation),
    obstacles: m.obstacles, buildings: m.buildings, roads: m.roads, water: m.water, meta: m.meta,
  };
}

export function mapFromFile(f: MapFile): MapDef {
  if (f.format !== "tcs-map" || f.formatVersion !== MAP_FORMAT_VERSION) {
    throw new Error(`not a TCS map file of format version ${MAP_FORMAT_VERSION}`);
  }
  const hb = fromBase64(f.heights);
  const n = (f.cols + 1) * (f.rows + 1);
  if (hb.length !== n * 4) throw new Error(`map '${f.id}': heights have ${hb.length / 4} samples, expected ${n}`);
  const dv = new DataView(hb.buffer, hb.byteOffset, hb.byteLength);
  const heights = new Float32Array(n);
  for (let i = 0; i < n; i++) heights[i] = dv.getFloat32(i * 4, true);
  const surface = fromBase64(f.surface);
  const vegetation = fromBase64(f.vegetation);
  if (surface.length !== f.cols * f.rows || vegetation.length !== f.cols * f.rows) {
    throw new Error(`map '${f.id}': layer size does not match ${f.cols} x ${f.rows} cells`);
  }
  const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
  return {
    id: f.id, name: f.name, widthM: f.widthM, heightM: f.heightM, cellSizeM: f.cellSizeM, cols: f.cols, rows: f.rows,
    heights, surfacePalette: [...f.surfacePalette], surface, vegetationPalette: [...f.vegetationPalette], vegetation,
    obstacles: clone(f.obstacles), buildings: clone(f.buildings), roads: clone(f.roads), water: clone(f.water), meta: { ...f.meta },
  };
}

/** Content hash of a map (same map <=> same fingerprint). */
export function mapFingerprint(m: MapDef): string {
  return hashText(JSON.stringify(mapToFile(m)));
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function toBase64(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + B64[(n >> 6) & 63]! + B64[n & 63]!;
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i]! << 16;
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + "==";
  } else if (rest === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + B64[(n >> 6) & 63]! + "=";
  }
  return out;
}

export function fromBase64(s: string): Uint8Array {
  const lookup = new Int16Array(128).fill(-1);
  for (let i = 0; i < B64.length; i++) lookup[B64.charCodeAt(i)] = i;
  const clean = s.replace(/=+$/, "");
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let o = 0, buf = 0, bits = 0;
  for (let i = 0; i < clean.length; i++) {
    const v = lookup[clean.charCodeAt(i)] ?? -1;
    if (v < 0) throw new Error("invalid base64");
    buf = (buf << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (buf >> bits) & 255;
    }
  }
  return out;
}
