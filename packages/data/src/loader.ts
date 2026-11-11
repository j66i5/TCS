/**
 * Data loader. Pure: takes already-parsed JSON files keyed by their path (relative to packages/data),
 * validates each against its schema, checks cross-references, and reports every problem readably:
 *
 *   factions/de/units.json: units[0].members[2].role: unknown role 'riflemann' (known: leader, rifleman)
 *
 * Reading files from disk (Node) or bundling them (browser, Vite) is the caller's job; see node.ts and
 * the app's data import.
 */
import type { z } from "zod";
import {
  BodyFile, type BodyT,
  BuildingsFile, MaterialsFile, ObstaclesFile, SurfacesFile, VegetationFile,
  type BuildingKindT, type MaterialT, type ObstacleKindT, type SurfaceT, type VegetationT,
  DoctrineFile, FactionManifest, ItemsFile, MovementModesFile, NamesFile, QualitiesFile, RanksFile, RolesFile,
  StringsFile, UnitsFile,
  type DoctrineT, type FactionManifestT, type ItemT, type MovementModeT, type NamesT, type QualityT, type RankT,
  type RoleT, type UnitTemplateT,
} from "./schemas";

export interface DataError {
  file: string;
  path: string;
  message: string;
  severity: "error" | "warning";
}

export type StringTables = Record<string, Record<string, string>>; // lang -> key -> text

export interface FactionPack {
  dir: string;
  manifest: FactionManifestT;
  ranks: Record<string, RankT>;
  roles: Record<string, RoleT>;
  names: NamesT;
  items: Record<string, ItemT>;
  units: Record<string, UnitTemplateT>;
  doctrine: DoctrineT;
  strings: StringTables;
}

export interface TerrainData {
  materials: Record<string, MaterialT>;
  surfaces: Record<string, SurfaceT>;
  vegetation: Record<string, VegetationT>;
  obstacles: Record<string, ObstacleKindT>;
  buildings: Record<string, BuildingKindT>;
}

export interface DataSet {
  body: BodyT | null;
  terrain: TerrainData;
  movementModes: Record<string, MovementModeT>;
  qualities: Record<string, QualityT>;
  strings: StringTables;
  factions: Record<string, FactionPack>;
}

export interface LoadResult {
  data: DataSet | null;
  errors: DataError[];
}

export const FACTION_FILES = [
  "manifest.json", "ranks.json", "roles.json", "names.json", "items.json", "units.json", "doctrine.json",
] as const;

function fmtPath(path: ReadonlyArray<PropertyKey>): string {
  let s = "";
  for (const p of path) s += typeof p === "number" ? `[${p}]` : s === "" ? String(p) : `.${String(p)}`;
  return s || "(root)";
}

function parse<S extends z.ZodType>(schema: S, file: string, raw: unknown, errors: DataError[]): z.infer<S> | null {
  if (raw === undefined) {
    errors.push({ file, path: "(file)", message: "required file is missing", severity: "error" });
    return null;
  }
  const r = schema.safeParse(raw);
  if (r.success) return r.data;
  for (const issue of r.error.issues) {
    errors.push({ file, path: fmtPath(issue.path), message: issue.message, severity: "error" });
  }
  return null;
}

function indexById<T extends { id: string }>(list: T[], file: string, key: string, errors: DataError[]): Record<string, T> {
  const out: Record<string, T> = {};
  list.forEach((x, i) => {
    if (out[x.id]) errors.push({ file, path: `${key}[${i}].id`, message: `duplicate id '${x.id}'`, severity: "error" });
    out[x.id] = x;
  });
  return out;
}

const known = (rec: Record<string, unknown>) => {
  const ks = Object.keys(rec);
  return ks.length > 12 ? `${ks.slice(0, 12).join(", ")}, ...` : ks.join(", ");
};

/** Load and validate everything under `files`. Faction packs are found at any `.../factions/<id>/`. */
export function loadDataSet(files: Record<string, unknown>): LoadResult {
  const errors: DataError[] = [];
  const mm = parse(MovementModesFile, "core/movement-modes.json", files["core/movement-modes.json"], errors);
  const q = parse(QualitiesFile, "core/qualities.json", files["core/qualities.json"], errors);
  const strings: StringTables = {};
  for (const [path, raw] of Object.entries(files)) {
    const m = /^core\/strings\.([a-z]{2})\.json$/.exec(path);
    if (m) strings[m[1]!] = parse(StringsFile, path, raw, errors) ?? {};
  }
  if (!strings["en"]) errors.push({ file: "core/strings.en.json", path: "(file)", message: "required file is missing", severity: "error" });

  const T = (f: string) => `core/terrain/${f}.json`;
  const mats = parse(MaterialsFile, T("materials"), files[T("materials")], errors);
  const surfs = parse(SurfacesFile, T("surfaces"), files[T("surfaces")], errors);
  const vegs = parse(VegetationFile, T("vegetation"), files[T("vegetation")], errors);
  const obst = parse(ObstaclesFile, T("obstacles"), files[T("obstacles")], errors);
  const blds = parse(BuildingsFile, T("buildings"), files[T("buildings")], errors);
  const terrain: TerrainData = {
    materials: mats ? indexById(mats.materials, T("materials"), "materials", errors) : {},
    surfaces: surfs ? indexById(surfs.surfaces, T("surfaces"), "surfaces", errors) : {},
    vegetation: vegs ? indexById(vegs.vegetation, T("vegetation"), "vegetation", errors) : {},
    obstacles: obst ? indexById(obst.obstacles, T("obstacles"), "obstacles", errors) : {},
    buildings: blds ? indexById(blds.buildings, T("buildings"), "buildings", errors) : {},
  };
  obst?.obstacles.forEach((o, i) => {
    if (!terrain.materials[o.material]) errors.push({ file: T("obstacles"), path: `obstacles[${i}].material`, message: `unknown material '${o.material}' (known: ${known(terrain.materials)})`, severity: "error" });
  });
  blds?.buildings.forEach((b, i) => {
    if (!terrain.materials[b.wallMaterial]) errors.push({ file: T("buildings"), path: `buildings[${i}].wallMaterial`, message: `unknown material '${b.wallMaterial}' (known: ${known(terrain.materials)})`, severity: "error" });
  });

  const body = parse(BodyFile, "core/body.json", files["core/body.json"], errors);
  if (body) {
    for (const from of ["standing", "crouching", "prone"]) for (const to of ["standing", "crouching", "prone"]) {
      if (from !== to && body.transitions.values[`${from}>${to}`] === undefined) {
        errors.push({ file: "core/body.json", path: `transitions.values`, message: `missing posture change '${from}>${to}'`, severity: "error" });
      }
    }
  }
  const data: DataSet = {
    body,
    terrain,
    movementModes: mm ? indexById(mm.movementModes, "core/movement-modes.json", "movementModes", errors) : {},
    qualities: q ? indexById(q.qualities, "core/qualities.json", "qualities", errors) : {},
    strings,
    factions: {},
  };

  // Group faction files by directory.
  const dirs = new Map<string, string>(); // dir -> faction folder name
  for (const path of Object.keys(files)) {
    const m = /^(.*?factions\/([^/]+))\/[^/]+\.json$/.exec(path);
    if (m) dirs.set(m[1]!, m[2]!);
  }
  const itemOwner = new Map<string, string>();
  for (const [dir, folder] of [...dirs.entries()].sort()) {
    const pack = loadFaction(files, dir, folder, data, errors);
    if (!pack) continue;
    if (data.factions[pack.manifest.id]) {
      errors.push({ file: `${dir}/manifest.json`, path: "id", message: `faction id '${pack.manifest.id}' is already loaded from ${data.factions[pack.manifest.id]!.dir}`, severity: "error" });
      continue;
    }
    for (const id of Object.keys(pack.items)) {
      const other = itemOwner.get(id);
      if (other) errors.push({ file: `${dir}/items.json`, path: id, message: `item id '${id}' is also defined in ${other}; item ids must be globally unique (prefix them with the faction id)`, severity: "error" });
      itemOwner.set(id, `${dir}/items.json`);
    }
    data.factions[pack.manifest.id] = pack;
  }
  const hasErrors = errors.some((e) => e.severity === "error");
  return { data: hasErrors ? null : data, errors };
}

function loadFaction(
  files: Record<string, unknown>, dir: string, folder: string, data: DataSet, errors: DataError[],
): FactionPack | null {
  const f = (name: string) => `${dir}/${name}`;
  const manifest = parse(FactionManifest, f("manifest.json"), files[f("manifest.json")], errors);
  const ranksF = parse(RanksFile, f("ranks.json"), files[f("ranks.json")], errors);
  const rolesF = parse(RolesFile, f("roles.json"), files[f("roles.json")], errors);
  const names = parse(NamesFile, f("names.json"), files[f("names.json")], errors);
  const itemsF = parse(ItemsFile, f("items.json"), files[f("items.json")], errors);
  const unitsF = parse(UnitsFile, f("units.json"), files[f("units.json")], errors);
  const doctrine = parse(DoctrineFile, f("doctrine.json"), files[f("doctrine.json")], errors);
  const strings: StringTables = {};
  for (const [path, raw] of Object.entries(files)) {
    if (!path.startsWith(`${dir}/strings.`)) continue;
    const m = /strings\.([a-z]{2})\.json$/.exec(path);
    if (m) strings[m[1]!] = parse(StringsFile, path, raw, errors) ?? {};
  }
  if (!strings["en"]) errors.push({ file: f("strings.en.json"), path: "(file)", message: "required file is missing", severity: "error" });
  if (!manifest || !ranksF || !rolesF || !names || !itemsF || !unitsF || !doctrine) return null;

  if (manifest.id !== folder) {
    errors.push({ file: f("manifest.json"), path: "id", message: `id '${manifest.id}' must equal the folder name '${folder}'`, severity: "error" });
  }
  if (!data.qualities[manifest.defaultQuality]) {
    errors.push({ file: f("manifest.json"), path: "defaultQuality", message: `unknown quality '${manifest.defaultQuality}' (known: ${known(data.qualities)})`, severity: "error" });
  }
  const pack: FactionPack = {
    dir,
    manifest,
    ranks: indexById(ranksF.ranks, f("ranks.json"), "ranks", errors),
    roles: indexById(rolesF.roles, f("roles.json"), "roles", errors),
    names,
    items: indexById(itemsF.items, f("items.json"), "items", errors),
    units: indexById(unitsF.units, f("units.json"), "units", errors),
    doctrine,
    strings,
  };

  // Cross references.
  itemsF.items.forEach((it, i) => {
    if (it.chargeItem && !pack.items[it.chargeItem]) {
      errors.push({ file: f("items.json"), path: `items[${i}].chargeItem`, message: `unknown item '${it.chargeItem}'`, severity: "error" });
    }
    if ((it.chargeCapacity === undefined) !== (it.chargeMassKg === undefined)) {
      errors.push({ file: f("items.json"), path: `items[${i}]`, message: "chargeCapacity and chargeMassKg must be given together", severity: "error" });
    }
  });
  unitsF.units.forEach((u, i) => {
    const p = `units[${i}]`;
    if (u.leaderIndex >= u.members.length) {
      errors.push({ file: f("units.json"), path: `${p}.leaderIndex`, message: `leaderIndex ${u.leaderIndex} but only ${u.members.length} members`, severity: "error" });
    }
    u.members.forEach((m, j) => {
      if (!pack.roles[m.role]) errors.push({ file: f("units.json"), path: `${p}.members[${j}].role`, message: `unknown role '${m.role}' (known: ${known(pack.roles)})`, severity: "error" });
      if (!pack.ranks[m.rank]) errors.push({ file: f("units.json"), path: `${p}.members[${j}].rank`, message: `unknown rank '${m.rank}' (known: ${known(pack.ranks)})`, severity: "error" });
      m.load.forEach((l, k) => {
        const def = pack.items[l.item];
        if (!def) errors.push({ file: f("units.json"), path: `${p}.members[${j}].load[${k}].item`, message: `unknown item '${l.item}'`, severity: "error" });
        else if (l.charge !== undefined && (def.chargeCapacity === undefined || l.charge > def.chargeCapacity)) {
          errors.push({ file: f("units.json"), path: `${p}.members[${j}].load[${k}].charge`, message: `charge ${l.charge} exceeds capacity of '${l.item}'`, severity: "error" });
        }
      });
    });
    u.subunits.forEach((s, j) => {
      if (!pack.units[s]) errors.push({ file: f("units.json"), path: `${p}.subunits[${j}]`, message: `unknown unit template '${s}'`, severity: "error" });
    });
  });
  // Cycle check in unit templates.
  const visiting = new Set<string>();
  const done = new Set<string>();
  const visit = (id: string): boolean => {
    if (done.has(id)) return true;
    if (visiting.has(id)) return false;
    visiting.add(id);
    for (const s of pack.units[id]?.subunits ?? []) if (!visit(s)) return false;
    visiting.delete(id);
    done.add(id);
    return true;
  };
  for (const id of Object.keys(pack.units)) {
    if (!visit(id)) {
      errors.push({ file: f("units.json"), path: id, message: "unit templates contain a cycle (a unit contains itself)", severity: "error" });
      break;
    }
  }
  // String keys referenced by this pack must exist (faction table or core table, English).
  const en = { ...(data.strings["en"] ?? {}), ...(strings["en"] ?? {}) };
  const needKey = (key: string, file: string, path: string) => {
    if (en[key] === undefined) errors.push({ file, path, message: `string key '${key}' not found in strings.en.json`, severity: "error" });
  };
  needKey(manifest.nameKey, f("manifest.json"), "nameKey");
  ranksF.ranks.forEach((r, i) => { needKey(r.nameKey, f("ranks.json"), `ranks[${i}].nameKey`); needKey(r.abbrKey, f("ranks.json"), `ranks[${i}].abbrKey`); });
  rolesF.roles.forEach((r, i) => needKey(r.nameKey, f("roles.json"), `roles[${i}].nameKey`));
  itemsF.items.forEach((r, i) => needKey(r.nameKey, f("items.json"), `items[${i}].nameKey`));
  return pack;
}

export function formatErrors(errors: DataError[]): string {
  return errors.map((e) => `${e.severity === "error" ? "ERROR  " : "warning"} ${e.file}: ${e.path}: ${e.message}`).join("\n");
}
