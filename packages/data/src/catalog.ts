/** Turns a validated DataSet into the Catalog the simulation runs with. */
import { canonicalJson, hashText, type Catalog, type ItemTypeDef } from "@tcs/sim";
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
  for (const m of Object.values(data.movementModes)) movementModes[m.id] = { id: m.id, speedMps: m.speedMps };
  const qualities: Catalog["qualities"] = {};
  for (const q of Object.values(data.qualities)) qualities[q.id] = { id: q.id, skills: { ...q.skills } };
  const body = { items, movementModes, qualities, factions };
  return { fingerprint: hashText(canonicalJson(body)), ...body };
}
