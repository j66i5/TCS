/**
 * Procedural test maps (SPEC 6.1). `generateMap(terrain, { kind, seed })` -> MapDef.
 * Deterministic: same terrain data + kind + seed + size => identical map (same fingerprint).
 */
import { createRng, type MapDef, type TerrainCatalog } from "@tcs/sim";
import { MapBuilder } from "./builder";
import { furnishInteriors } from "./interiors";
import { farmland, industrial, village, woodland } from "./kinds";

export const MAP_KINDS = ["village", "woodland", "farmland", "industrial"] as const;
export type MapKind = (typeof MAP_KINDS)[number];
/**
 * Bump when generator output changes for the same inputs (old saves are then refused). Version 2 (M7.5c) adds
 * interiors; a map generated with `interiors: false` is version 1, identical to the maps before M7.5c.
 */
export const MAPGEN_VERSION = 2;
export const MAPGEN_VERSION_NO_INTERIORS = 1;

export interface MapGenOptions {
  kind: MapKind;
  seed: number;
  widthM?: number;
  heightM?: number;
  cellSizeM?: number;
  /** Rooms, inner walls, stairs and upper windows in every building (M7.5c). Default true. */
  interiors?: boolean;
}

export function generateMap(terrain: TerrainCatalog, o: MapGenOptions): MapDef {
  const w = o.widthM ?? 2000, h = o.heightM ?? 2000, cell = o.cellSizeM ?? 4;
  if (cell < 2 || cell > 5) throw new Error("cell size must be 2..5 m (SPEC 6.1)");
  const b = new MapBuilder(w, h, cell, terrain, createRng(o.seed), "grass");
  const seed = o.seed >>> 0;
  const gen = { village, woodland, farmland, industrial }[o.kind];
  if (!gen) throw new Error(`unknown map kind '${o.kind}' (known: ${MAP_KINDS.join(", ")})`);
  const style = gen(b, seed);
  const interiors = o.interiors ?? true;
  // After every building: its own stream, so the rest of the map is the same with or without interiors.
  if (interiors) furnishInteriors(b.map.buildings, terrain, b.rng);
  return b.build(`${o.kind}-${seed}`, `${o.kind} ${seed} (${style})`, { generator: "tcs-mapgen", kind: o.kind, seed, version: interiors ? MAPGEN_VERSION : MAPGEN_VERSION_NO_INTERIORS });
}

export { mapStats, checkMap, type MapStats } from "./stats";

/**
 * Reserved interface for importing real-world terrain from open elevation and map data (SPEC 6.1, 9.8).
 * Implemented in a later milestone; the generator and an importer both produce a MapDef.
 */
export interface TerrainImporter {
  id: string;
  importMap(source: unknown, terrain: TerrainCatalog): MapDef;
}
