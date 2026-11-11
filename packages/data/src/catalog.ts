/** Turns a validated DataSet into the Catalog the simulation runs with. */
import { canonicalJson, hashText, type BodyDef, type Catalog, type ItemTypeDef, type TerrainCatalog } from "@tcs/sim";
import type { DataSet } from "./loader";

/** Build a catalog containing the given factions (and all core data). */
export function buildCatalog(data: DataSet, factionIds: string[]): Catalog {
  const items: Record<string, ItemTypeDef> = {};
  const factions: Catalog["factions"] = {};
  for (const fid of [...new Set(factionIds)].sort()) {
    const pack = data.factions[fid];
    if (!pack) throw new Error(`faction '${fid}' is not loaded (loaded: ${Object.keys(data.factions).join(", ")})`);
    factions[fid] = { id: fid, nameKey: pack.manifest.nameKey, doctrine: { ...pack.doctrine.values }, defaultFormation: pack.doctrine.defaultFormation };
    for (const it of Object.values(pack.items)) {
      const d: ItemTypeDef = { id: it.id, massKg: it.massKg, category: it.category };
      if (it.chargeCapacity !== undefined) d.chargeCapacity = it.chargeCapacity;
      if (it.chargeMassKg !== undefined) d.chargeMassKg = it.chargeMassKg;
      if (it.chargeItem !== undefined) d.chargeItem = it.chargeItem;
      items[it.id] = d;
    }
  }
  const movementModes: Catalog["movementModes"] = {};
  for (const m of Object.values(data.movementModes)) {
    movementModes[m.id] = { id: m.id, class: m.class, speedMps: m.speedMps, posture: m.posture, exertion: m.exertion };
  }
  const qualities: Catalog["qualities"] = {};
  for (const q of Object.values(data.qualities)) qualities[q.id] = { id: q.id, skills: { ...q.skills } };
  // Weapons and ammunition of the factions taking part.
  const ammo: Catalog["ammo"] = {};
  const weapons: Catalog["weapons"] = {};
  const noProv = <T extends object>(o: T) => {
    const { sources: _s, confidence: _c, note: _n, nameKey: _k, ...rest } = o as T & Record<string, unknown>;
    return JSON.parse(JSON.stringify(rest)) as unknown;
  };
  for (const fid of Object.keys(factions)) {
    const pack = data.factions[fid]!;
    for (const a of Object.values(pack.ammunition)) ammo[a.id] = noProv(a) as Catalog["ammo"][string];
    for (const w of Object.values(pack.weapons)) weapons[w.id] = noProv(w) as Catalog["weapons"][string];
  }
  if (!data.ballistics) throw new Error("core/ballistics.json is missing or invalid");
  const ballistics = noProv(data.ballistics) as Catalog["ballistics"];
  const ammoIds = Object.keys(ammo).sort();
  if (!data.shooting) throw new Error("core/shooting.json is missing or invalid");
  const shooting = { aim: noProv(data.shooting.aim), fire: noProv(data.shooting.fire) } as Catalog["shooting"];
  const formations: Catalog["formations"] = {};
  for (const f of Object.values(data.formations)) formations[f.id] = { id: f.id, slots: f.slots.map(([a, b]) => [a, b] as [number, number]) };
  const body = { items, movementModes, qualities, factions, terrain: terrainCatalog(data), body: bodyCatalog(data), formations, ballistics, shooting, ammo, ammoIds, weapons };
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

/** Body parameters without provenance fields. */
export function bodyCatalog(data: DataSet): BodyDef {
  const b = data.body;
  if (!b) throw new Error("core/body.json is missing or invalid");
  const strip = <T extends object>(o: T) => {
    const { sources: _s, confidence: _c, note: _n, ...rest } = o as T & { sources?: unknown; confidence?: unknown; note?: unknown };
    return JSON.parse(JSON.stringify(rest)) as Omit<T, "sources" | "confidence" | "note">;
  };
  const postures = {} as BodyDef["postures"];
  for (const p of b.postures) postures[p.id] = { heightM: p.heightM, speedFactor: p.speedFactor, muzzleHeightM: p.muzzleHeightM };
  return { postures, transitions: strip(b.transitions), movement: strip(b.movement), physiology: strip(b.physiology) };
}
