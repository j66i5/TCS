/** Turns a validated DataSet into the Catalog the simulation runs with. */
import { canonicalJson, hashText, type Catalog, type ItemTypeDef, type TerrainCatalog } from "@tcs/sim";
import type { DataSet } from "./loader";

/** Build a catalog containing the given factions (and all core data). */
export function buildCatalog(data: DataSet, factionIds: string[]): Catalog {
  const items: Record<string, ItemTypeDef> = {};
  const factions: Catalog["factions"] = {};
  for (const fid of [...new Set(factionIds)].sort()) {
    const pack = data.factions[fid];
    if (!pack) throw new Error(`faction '${fid}' is not loaded (loaded: ${Object.keys(data.factions).join(", ")})`);
    factions[fid] = { id: fid, nameKey: pack.manifest.nameKey, doctrine: { ...pack.doctrine.values } };
    for (const it of Object.values(pack.items)) {
      const d: ItemTypeDef = { id: it.id, massKg: it.massKg, category: it.category };
      if (it.chargeCapacity !== undefined) d.chargeCapacity = it.chargeCapacity;
      if (it.chargeMassKg !== undefined) d.chargeMassKg = it.chargeMassKg;
      if (it.chargeItem !== undefined) d.chargeItem = it.chargeItem;
      items[it.id] = d;
    }
  }
  const movementModes: Catalog["movementModes"] = {};
  for (const m of Object.values(data.movementModes)) movementModes[m.id] = { id: m.id, class: m.class, speedMps: m.speedMps };
  const qualities: Catalog["qualities"] = {};
  for (const q of Object.values(data.qualities)) qualities[q.id] = { id: q.id, skills: { ...q.skills } };
  const body = { items, movementModes, qualities, factions, terrain: terrainCatalog(data) };
  return { fingerprint: hashText(canonicalJson(body)), ...body };
}

/** Terrain definitions without provenance fields (sources, confidence, notes stay in the data set). */
export function terrainCatalog(data: DataSet): TerrainCatalog {
  const strip = <T extends { sources: unknown; confidence: unknown; note?: unknown; nameKey: unknown }>(rec: Record<string, T>) => {
    const out: Record<string, Omit<T, "sources" | "confidence" | "note" | "nameKey">> = {};
    for (const [k, v] of Object.entries(rec).sort(([a], [b]) => (a < b ? -1 : 1))) {
      const { sources: _s, confidence: _c, note: _n, nameKey: _k, ...rest } = v;
      out[k] = JSON.parse(JSON.stringify(rest)) as Omit<T, "sources" | "confidence" | "note" | "nameKey">;
    }
    return out;
  };
  const t = data.terrain;
  return {
    materials: strip(t.materials),
    surfaces: strip(t.surfaces),
    vegetation: strip(t.vegetation),
    obstacles: strip(t.obstacles),
    buildings: strip(t.buildings) as TerrainCatalog["buildings"],
  };
}
