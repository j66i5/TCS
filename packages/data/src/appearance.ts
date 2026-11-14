/**
 * Appearance (M7.5, plan m7.5 §1.1): how things LOOK — uniform tones, vehicle paint, the flat map palette.
 * Built beside `buildCatalog` from the same data set but kept OUT of the catalog and its fingerprint: changing a
 * colour never changes a battle, a save or a golden replay (test: appearance.test.ts).
 * A faction without an appearance file gets the neutral look (so any new faction pack works at once).
 */
import type { DataSet } from "./loader";
import type { CoreAppearanceT, FactionAppearanceT } from "./schemas";

export interface FactionLook {
  uniform: { base: number; dark: number; light: number; helmet: number; skin: number };
  vehicle: { hull: number; dark: number };
}

export interface Appearance {
  /** Per faction id taking part (and the neutral look for unknown ids via `lookOf`). */
  factions: Record<string, FactionLook>;
  /** Flat map palette (used from M7.5b on): colours by surface, vegetation and building kind id. */
  map: { surfaces: Record<string, number>; vegetation: Record<string, number>; roofs: Record<string, number>; floors: Record<string, number>; outline: number };
  /** Photo map palette and grade (plan "photo"); absent: the photo map uses `map` and its default grade. */
  photo?: PhotoPalette;
  /** Painted emblems by vehicle type id (M10.6-data), from the factions taking part. */
  markings?: Record<string, VehicleMarking>;
}

/** A painted emblem a vehicle type carries (M10.6-data). */
export type VehicleMarking = "red-cross";

export interface PhotoPalette {
  surfaces: Record<string, number>; vegetation: Record<string, number>; obstacles: Record<string, number>;
  /** Roof and floor colours by building kind (step "built"); absent kinds fall back to `map`. */
  roofs: Record<string, number>; floors: Record<string, number>;
  grade?: { desaturate: number; contrast: number; warm: number; grain: number };
}

/** The neutral look: grey-green uniform and paint, for a faction that has no appearance file. */
export const NEUTRAL_LOOK: FactionLook = {
  uniform: { base: 0x6b6f5e, dark: 0x45483c, light: 0x8d917e, helmet: 0x55594a, skin: 0xc9a27e },
  vehicle: { hull: 0x4a4f42, dark: 0x2c2f27 },
};

const hex = (c: string) => parseInt(c.slice(1), 16);
const hexRec = (r: Record<string, string>) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, hex(v)]));

function factionLook(a: FactionAppearanceT): FactionLook {
  const u = a.uniform, v = a.vehicle;
  return { uniform: { base: hex(u.base), dark: hex(u.dark), light: hex(u.light), helmet: hex(u.helmet), skin: hex(u.skin) }, vehicle: { hull: hex(v.hull), dark: hex(v.dark) } };
}

function mapPalette(a: CoreAppearanceT | undefined): Appearance["map"] {
  if (!a) return { surfaces: {}, vegetation: {}, roofs: {}, floors: {}, outline: 0x1d2419 };
  return { surfaces: hexRec(a.surfaces), vegetation: hexRec(a.vegetation), roofs: hexRec(a.roofs), floors: hexRec(a.floors), outline: hex(a.outline) };
}

/** The look of the given factions (all core palette entries). Unknown ids or missing files: the neutral look. */
export function buildAppearance(data: DataSet, factionIds: readonly string[]): Appearance {
  const factions: Record<string, FactionLook> = {};
  for (const fid of [...new Set(factionIds)].sort()) {
    const a = data.factions[fid]?.appearance;
    factions[fid] = a ? factionLook(a) : NEUTRAL_LOOK;
  }
  const ph = data.appearance?.photo;
  const photo: PhotoPalette | undefined = ph ? { surfaces: hexRec(ph.surfaces ?? {}), vegetation: hexRec(ph.vegetation ?? {}), obstacles: hexRec(ph.obstacles ?? {}), roofs: hexRec(ph.roofs ?? {}), floors: hexRec(ph.floors ?? {}), ...(ph.grade ? { grade: { ...ph.grade } } : {}) } : undefined;
  const markings: Record<string, VehicleMarking> = {};
  for (const fid of Object.keys(factions)) for (const [k, m] of Object.entries(data.factions[fid]?.appearance?.markings ?? {}).sort(([a], [b]) => (a < b ? -1 : 1))) markings[k] = m;
  return { factions, map: mapPalette(data.appearance), ...(photo ? { photo } : {}), ...(Object.keys(markings).length > 0 ? { markings } : {}) };
}

/** A faction's look, the neutral one if it has none. */
export function lookOf(app: Appearance | null | undefined, faction: string): FactionLook {
  return app?.factions[faction] ?? NEUTRAL_LOOK;
}
