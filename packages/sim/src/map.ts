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
import { canonicalJson, hashText } from "./hash";

export const MAX_MAP_SIZE_M = 4000;
/**
 * Format 2 (M7.5c) adds building interiors (rooms, inner walls, stairs, upper-floor openings). A map without any
 * interior is written as format 1, byte for byte as before (equivalence proof: maps, catalog and goldens of
 * battles without interiors are unchanged). Both are read.
 */
export const MAP_FORMAT_VERSION = 2;

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
  /** Floor of the opening (0 = ground floor, absent = 0; M7.5c). sillM/headM are above that floor. */
  floor?: number;
}

/** A room of a building's interior (M7.5c): a convex polygon, counter-clockwise like the footprint. */
export interface Room {
  id: number;
  floor: number;
  poly: Coords;
  kind: "room" | "hall" | "stair";
}

/** A doorway in an inner wall: always open (plan §7.8). */
export interface InnerDoor {
  /** Distance of the doorway's centre from the wall's first point, m. */
  offsetM: number;
  widthM: number;
  /** Height of its top above the floor, m. */
  headM: number;
}

/** An inner wall on one floor: from the floor to the ceiling, with doorways. */
export interface InnerWall {
  id: number;
  floor: number;
  ax: number; ay: number; bx: number; by: number;
  thicknessM: number;
  material: DefId;
  doors: InnerDoor[];
}

/** A flight of stairs from `floor` up to `floor + 1`, in room `room`: from (x0, y0) (bottom) to (x1, y1) (top). */
export interface Stair {
  id: number;
  floor: number;
  room: number;
  x0: number; y0: number; x1: number; y1: number;
  widthM: number;
}

export interface Interior {
  rooms: Room[];
  walls: InnerWall[];
  stairs: Stair[];
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
  /** Rooms, inner walls and stairs on every floor (M7.5c); absent = one hollow shell (format 1). */
  interior?: Interior;
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
    format: "tcs-map", formatVersion: hasInteriors(m) ? MAP_FORMAT_VERSION : 1,
    id: m.id, name: m.name, widthM: m.widthM, heightM: m.heightM, cellSizeM: m.cellSizeM, cols: m.cols, rows: m.rows,
    heights: toBase64(hb),
    surfacePalette: [...m.surfacePalette], surface: toBase64(m.surface),
    vegetationPalette: [...m.vegetationPalette], vegetation: toBase64(m.vegetation),
    obstacles: m.obstacles, buildings: m.buildings, roads: m.roads, water: m.water, meta: m.meta,
  };
}

export function mapFromFile(f: MapFile): MapDef {
  if (f.format !== "tcs-map" || !(f.formatVersion === 1 || f.formatVersion === MAP_FORMAT_VERSION)) {
    throw new Error(`not a TCS map file of format version 1..${MAP_FORMAT_VERSION}`);
  }
  if (f.cols !== Math.ceil(f.widthM / f.cellSizeM) || f.rows !== Math.ceil(f.heightM / f.cellSizeM)) {
    throw new Error(`map '${f.id}': grid ${f.cols} x ${f.rows} does not cover ${f.widthM} x ${f.heightM} m in ${f.cellSizeM} m cells`);
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

/** Does any building of the map have an interior (format 2)? */
export function hasInteriors(m: Pick<MapDef, "buildings">): boolean {
  for (const b of m.buildings) if (b.interior) return true;
  return false;
}

/**
 * The same map without interiors (M7.5c equivalence): no rooms, no upper-floor openings, the generator version
 * of the map before interiors. `generateMap(..., { interiors: false })` gives exactly this (tested).
 */
export function stripInteriors(m: MapDef, versionWithout = 1): MapDef {
  if (!hasInteriors(m)) return m;
  return {
    ...m,
    buildings: m.buildings.map((b) => {
      const { interior: _i, ...rest } = b;
      void _i;
      return { ...rest, openings: b.openings.filter((o) => (o.floor ?? 0) === 0) };
    }),
    meta: { ...m.meta, version: versionWithout },
  };
}

/** Content hash of a map (same map <=> same fingerprint). */
export function mapFingerprint(m: MapDef): string {
  return hashText(canonicalJson(mapToFile(m)));
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
