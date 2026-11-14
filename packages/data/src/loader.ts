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
  BodyFile, type BodyT, FormationsFile, type FormationT,
  BehaviourFile, type BehaviourT, ShootingFile, type ShootingT, SpottingFile, type SpottingT, WoundsFile, type WoundsT,
  AmmunitionFile, BallisticsFile, WeaponsFile, type AmmoT, type BallisticsT, type ItemT as ItemTT, type WeaponT,
  BuildingsFile, MaterialsFile, ObstaclesFile, SurfacesFile, VegetationFile,
  type BuildingKindT, type MaterialT, type ObstacleKindT, type SurfaceT, type VegetationT,
  DoctrineFile, FactionManifest, ItemsFile, MovementModesFile, NamesFile, QualitiesFile, RanksFile, RolesFile,
  StringsFile, UnitsFile, VehiclesFile, type VehicleT,
  CoreAppearanceFile, FactionAppearanceFile, type CoreAppearanceT, type FactionAppearanceT,
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
  ammunition: Record<string, AmmoT>;
  weapons: Record<string, WeaponT>;
  dir: string;
  manifest: FactionManifestT;
  ranks: Record<string, RankT>;
  roles: Record<string, RoleT>;
  names: NamesT;
  items: Record<string, ItemT>;
  units: Record<string, UnitTemplateT>;
  /** Vehicle types (M7; optional file vehicles.json). */
  vehicles: Record<string, VehicleT>;
  doctrine: DoctrineT;
  strings: StringTables;
  /** Look (M7.5; optional file appearance.json): uniform tones and vehicle paint. Not in the catalog. */
  appearance?: FactionAppearanceT;
}

export interface TerrainData {
  materials: Record<string, MaterialT>;
  surfaces: Record<string, SurfaceT>;
  vegetation: Record<string, VegetationT>;
  obstacles: Record<string, ObstacleKindT>;
  buildings: Record<string, BuildingKindT>;
}

export interface DataSet {
  wounds: WoundsT | null;
  shooting: ShootingT | null;
  spotting: SpottingT | null;
  behaviour: BehaviourT | null;
  ballistics: BallisticsT | null;
  body: BodyT | null;
  formations: Record<string, FormationT>;
  terrain: TerrainData;
  movementModes: Record<string, MovementModeT>;
  qualities: Record<string, QualityT>;
  strings: StringTables;
  factions: Record<string, FactionPack>;
  /** The flat map palette (M7.5; optional file core/appearance.json). Not in the catalog. */
  appearance?: CoreAppearanceT;
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

  // Foot paces name the vehicle pace a vehicle given them drives at (M7).
  mm?.movementModes.forEach((m, i) => {
    if (m.class !== "foot") return;
    for (const cls of ["tracked", "wheeled"] as const) {
      const v = mm.movementModes.find((x) => x.id === m.vehiclePace[cls]);
      if (!v || v.class !== cls) errors.push({ file: "core/movement-modes.json", path: `movementModes[${i}].vehiclePace.${cls}`, message: `'${m.vehiclePace[cls]}' is not a ${cls} pace`, severity: "error" });
    }
  });
  const body = parse(BodyFile, "core/body.json", files["core/body.json"], errors);
  if (body) {
    for (const from of ["standing", "crouching", "prone"]) for (const to of ["standing", "crouching", "prone"]) {
      if (from !== to && body.transitions.values[`${from}>${to}`] === undefined) {
        errors.push({ file: "core/body.json", path: `transitions.values`, message: `missing posture change '${from}>${to}'`, severity: "error" });
      }
    }
  }
  const fm = parse(FormationsFile, "core/formations.json", files["core/formations.json"], errors);
  const ballistics = parse(BallisticsFile, "core/ballistics.json", files["core/ballistics.json"], errors);
  surfs?.surfaces.forEach((s, i) => {
    if (!terrain.materials[s.material]) errors.push({ file: T("surfaces"), path: `surfaces[${i}].material`, message: `unknown material '${s.material}' (known: ${known(terrain.materials)})`, severity: "error" });
  });
  const shooting = parse(ShootingFile, "core/shooting.json", files["core/shooting.json"], errors);
  const wounds = parse(WoundsFile, "core/wounds.json", files["core/wounds.json"], errors);
  const spotting = parse(SpottingFile, "core/spotting.json", files["core/spotting.json"], errors);
  const behaviour = parse(BehaviourFile, "core/behaviour.json", files["core/behaviour.json"], errors);
  const data: DataSet = {
    wounds,
    shooting,
    spotting,
    behaviour,
    ballistics,
    body,
    formations: fm ? indexById(fm.formations, "core/formations.json", "formations", errors) : {},
    terrain,
    movementModes: mm ? indexById(mm.movementModes, "core/movement-modes.json", "movementModes", errors) : {},
    qualities: q ? indexById(q.qualities, "core/qualities.json", "qualities", errors) : {},
    strings,
    factions: {},
  };
  // Appearance (M7.5): presentation only, outside the catalog; its keys must name terrain entries.
  if (files["core/appearance.json"] !== undefined) {
    const ap = parse(CoreAppearanceFile, "core/appearance.json", files["core/appearance.json"], errors);
    if (ap) {
      const check = (group: "surfaces" | "vegetation" | "roofs" | "floors", known2: Record<string, unknown>) => {
        for (const k of Object.keys(ap[group])) if (!known2[k]) errors.push({ file: "core/appearance.json", path: `${group}.${k}`, message: `unknown id '${k}' (known: ${known(known2)})`, severity: "error" });
      };
      check("surfaces", terrain.surfaces); check("vegetation", terrain.vegetation); check("roofs", terrain.buildings); check("floors", terrain.buildings);
      const ph = ap.photo, checkPh = (group: "surfaces" | "vegetation" | "obstacles" | "roofs" | "floors", known2: Record<string, unknown>) => {
        for (const k of Object.keys(ph?.[group] ?? {})) if (!known2[k]) errors.push({ file: "core/appearance.json", path: `photo.${group}.${k}`, message: `unknown id '${k}' (known: ${known(known2)})`, severity: "error" });
      };
      checkPh("surfaces", terrain.surfaces); checkPh("vegetation", terrain.vegetation); checkPh("obstacles", terrain.obstacles);
      checkPh("roofs", terrain.buildings); checkPh("floors", terrain.buildings);
      data.appearance = ap;
    }
  }

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
  if (doctrine && !data.formations[doctrine.defaultFormation]) {
    errors.push({ file: f("doctrine.json"), path: "defaultFormation", message: `unknown formation '${doctrine.defaultFormation}' (known: ${known(data.formations)})`, severity: "error" });
  }
  if (!data.qualities[manifest.defaultQuality]) {
    errors.push({ file: f("manifest.json"), path: "defaultQuality", message: `unknown quality '${manifest.defaultQuality}' (known: ${known(data.qualities)})`, severity: "error" });
  }
  // Optional files: packs without weapons simply have none.
  const ammoF = files[f("ammunition.json")] === undefined ? { ammunition: [] } : parse(AmmunitionFile, f("ammunition.json"), files[f("ammunition.json")], errors);
  const weaponsF = files[f("weapons.json")] === undefined ? { weapons: [] } : parse(WeaponsFile, f("weapons.json"), files[f("weapons.json")], errors);
  const vehiclesF = files[f("vehicles.json")] === undefined ? { vehicles: [] } : parse(VehiclesFile, f("vehicles.json"), files[f("vehicles.json")], errors);
  if (!ammoF || !weaponsF || !vehiclesF) return null;
  const appearance: FactionAppearanceT | null = files[f("appearance.json")] === undefined ? null : parse(FactionAppearanceFile, f("appearance.json"), files[f("appearance.json")], errors);
  ammoF.ammunition.forEach((a, i) => {
    if (itemsF.items.some((it) => it.id === a.id)) {
      errors.push({ file: f("ammunition.json"), path: `ammunition[${i}].id`, message: `'${a.id}' is also defined in items.json; ammunition becomes an item automatically`, severity: "error" });
    }
    if ((a.kind === "tracer") !== a.tracer && (a.kind === "tracer" || a.kind === "ball")) {
      errors.push({ file: f("ammunition.json"), path: `ammunition[${i}].tracer`, message: `kind '${a.kind}' and tracer ${a.tracer} contradict each other`, severity: "error" });
    }
  });
  ammoF.ammunition.forEach((a, i) => {
    const at = (k: string) => ({ file: f("ammunition.json"), path: `ammunition[${i}].${k}`, severity: "error" as const });
    if (a.explosive) {
      const fr = ammoF.ammunition.find((x) => x.id === a.explosive!.fragmentAmmo);
      if (!fr) errors.push({ ...at("explosive.fragmentAmmo"), message: `unknown ammunition '${a.explosive.fragmentAmmo}'` });
      else if (fr.kind !== "fragment") errors.push({ ...at("explosive.fragmentAmmo"), message: `'${fr.id}' must be of kind "fragment"` });
      if ((a.fuse === "time") !== (a.explosive.fuseSeconds !== undefined)) errors.push({ ...at("explosive.fuseSeconds"), message: `a "time" fuse needs fuseSeconds, other fuses must not have it` });
      if (a.explosive.fragmentVelocityMps[0] > a.explosive.fragmentVelocityMps[1]) errors.push({ ...at("explosive.fragmentVelocityMps"), message: "give the lower speed first" });
    }
    if (a.delivery) {
      if (!a.explosive && !(a.smoke && a.delivery.method === "thrown")) errors.push({ ...at("delivery"), message: "only explosive munitions (or hand smoke grenades) can be thrown or launched" });
      if (a.explosive && a.smoke) errors.push({ ...at("smoke"), message: "a munition is either explosive or a smoke grenade" });
      if (a.delivery.method === "launched") {
        if (a.delivery.velocityMps === undefined) errors.push({ ...at("delivery.velocityMps"), message: "a launched munition needs its muzzle velocity" });
        if (a.delivery.launcher === undefined || !itemsF.items.some((it) => it.id === a.delivery!.launcher)) errors.push({ ...at("delivery.launcher"), message: `unknown launcher item '${a.delivery.launcher ?? ""}'` });
      }
    }
  });
  itemsF.items.forEach((it, i) => {
    if ((it.tracerItem === undefined) !== (it.tracerEvery === undefined)) errors.push({ file: f("items.json"), path: `items[${i}].tracerItem`, message: "tracerItem and tracerEvery belong together", severity: "error" });
    if (it.tracerItem !== undefined && !ammoF.ammunition.some((a) => a.id === it.tracerItem && a.tracer)) errors.push({ file: f("items.json"), path: `items[${i}].tracerItem`, message: `'${it.tracerItem}' is not a tracer ammunition of this faction`, severity: "error" });
  });
  // Fire support (M6.5c): its rounds must be ammunition of this faction (HE with an explosive, a smoke round).
  const fs = doctrine?.fireSupport;
  if (fs) {
    const he = ammoF.ammunition.find((a) => a.id === fs.heAmmo);
    if (!he || !he.explosive) errors.push({ file: f("doctrine.json"), path: "fireSupport.heAmmo", message: `'${fs.heAmmo}' is not an explosive ammunition of this faction`, severity: "error" });
    if (!ammoF.ammunition.some((a) => a.id === fs.smokeAmmo && a.kind === "smoke")) errors.push({ file: f("doctrine.json"), path: "fireSupport.smokeAmmo", message: `'${fs.smokeAmmo}' is not a smoke ammunition of this faction`, severity: "error" });
  }
  // Every kind of ammunition is also a counted item (SPEC 4.3 rule 9): one round = one item of cartridge mass.
  const roundItems: ItemTT[] = ammoF.ammunition.map((a) => ({
    id: a.id, nameKey: a.nameKey, category: "ammunition", massKg: a.cartridgeMassKg,
    sources: a.sources, confidence: a.confidence, ...(a.note === undefined ? {} : { note: a.note }),
  }));
  itemsF.items.push(...roundItems);
  const pack: FactionPack = {
    ammunition: indexById(ammoF.ammunition, f("ammunition.json"), "ammunition", errors),
    weapons: indexById(weaponsF.weapons, f("weapons.json"), "weapons", errors),
    dir,
    manifest,
    ranks: indexById(ranksF.ranks, f("ranks.json"), "ranks", errors),
    roles: indexById(rolesF.roles, f("roles.json"), "roles", errors),
    names,
    items: indexById(itemsF.items, f("items.json"), "items", errors),
    units: indexById(unitsF.units, f("units.json"), "units", errors),
    vehicles: indexById(vehiclesF.vehicles, f("vehicles.json"), "vehicles", errors),
    doctrine,
    strings,
    ...(appearance ? { appearance } : {}),
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
  weaponsF.weapons.forEach((wp, i) => {
    const mag = pack.items[wp.feed.magazine];
    const magPath = `weapons[${i}].feed.magazine`;
    if (!mag) errors.push({ file: f("weapons.json"), path: magPath, message: `unknown item '${wp.feed.magazine}'`, severity: "error" });
    else if (mag.chargeItem === undefined || mag.chargeCapacity === undefined) {
      errors.push({ file: f("weapons.json"), path: magPath, message: `item '${mag.id}' is not a magazine or belt (it needs chargeItem and chargeCapacity)`, severity: "error" });
    } else {
      const round = pack.ammunition[mag.chargeItem];
      if (round && mag.chargeMassKg !== undefined && Math.abs(mag.chargeMassKg - round.cartridgeMassKg) > 1e-9) {
        errors.push({ file: f("items.json"), path: `${mag.id}.chargeMassKg`, message: `${mag.chargeMassKg} kg per round, but '${round.id}' weighs ${round.cartridgeMassKg} kg: a magazine and its loose rounds must weigh the same`, severity: "error" });
      }
    }
    const belt = itemsF.items.find((it) => it.id === wp.feed.magazine);
    if (belt?.tracerItem !== undefined && wp.ammo[belt.tracerItem] === undefined) {
      errors.push({ file: f("weapons.json"), path: `weapons[${i}].ammo`, message: `the belt '${belt.id}' mixes in '${belt.tracerItem}', but this weapon lists no muzzle velocity for it`, severity: "error" });
    }
    const ids = Object.keys(wp.ammo);
    if (ids.length === 0) errors.push({ file: f("weapons.json"), path: `weapons[${i}].ammo`, message: "a weapon needs at least one kind of ammunition", severity: "error" });
    for (const a of ids) {
      const ad = pack.ammunition[a];
      if (!ad) errors.push({ file: f("weapons.json"), path: `weapons[${i}].ammo.${a}`, message: `unknown ammunition '${a}' (known: ${known(pack.ammunition)})`, severity: "error" });
      else if (ad.calibre !== wp.calibre) errors.push({ file: f("weapons.json"), path: `weapons[${i}].ammo.${a}`, message: `calibre ${ad.calibre} does not fit this ${wp.calibre} weapon`, severity: "error" });
    }
    if (mag && mag.chargeItem !== undefined && !ids.includes(mag.chargeItem)) {
      errors.push({ file: f("weapons.json"), path: `weapons[${i}].feed.magazine`, message: `magazine '${mag.id}' holds '${mag.chargeItem}', which this weapon does not fire`, severity: "error" });
    }
  });
  itemsF.items.forEach((it, i) => {
    if (it.sensor !== undefined && data.spotting && !data.spotting.sensors[it.sensor]) errors.push({ file: f("items.json"), path: `items[${i}].sensor`, message: `unknown sensor kind '${it.sensor}' (core/spotting.json sensors)`, severity: "error" });
  });
  if (manifest.demoTemplate !== undefined && !pack.units[manifest.demoTemplate]) {
    errors.push({ file: f("manifest.json"), path: "demoTemplate", message: `unknown unit template '${manifest.demoTemplate}' (known: ${known(pack.units)})`, severity: "error" });
  }
  unitsF.units.forEach((u, i) => {
    const p = `units[${i}]`;
    if (u.leaderIndex >= u.members.length) {
      errors.push({ file: f("units.json"), path: `${p}.leaderIndex`, message: `leaderIndex ${u.leaderIndex} but only ${u.members.length} members`, severity: "error" });
    }
    u.members.forEach((m, j) => {
      if (!pack.roles[m.role]) errors.push({ file: f("units.json"), path: `${p}.members[${j}].role`, message: `unknown role '${m.role}' (known: ${known(pack.roles)})`, severity: "error" });
      if (m.weapon !== undefined) {
        const wd = pack.weapons[m.weapon];
        if (!wd) errors.push({ file: f("units.json"), path: `${p}.members[${j}].weapon`, message: `unknown weapon '${m.weapon}' (known: ${known(pack.weapons)})`, severity: "error" });
        else if (!m.load.some((l) => l.item === wd.feed.magazine)) {
          errors.push({ file: f("units.json"), path: `${p}.members[${j}].load`, message: `carries a ${m.weapon} but no '${wd.feed.magazine}' for it`, severity: "warning" });
        }
      }
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
  checkVehicles(pack, vehiclesF.vehicles, unitsF.units, data, f, errors);
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
  weaponsF.weapons.forEach((r, i) => needKey(r.nameKey, f("weapons.json"), `weapons[${i}].nameKey`));
  vehiclesF.vehicles.forEach((r, i) => needKey(r.nameKey, f("vehicles.json"), `vehicles[${i}].nameKey`));
  return pack;
}

/** Cross-checks of vehicles.json and of crew and carriage templates (M7). */
function checkVehicles(
  pack: FactionPack, vehicles: VehicleT[], units: UnitTemplateT[], data: DataSet, f: (n: string) => string, errors: DataError[],
): void {
  const file = f("vehicles.json");
  vehicles.forEach((v, i) => {
    const err = (path: string, message: string, severity: "error" | "warning" = "error") => errors.push({ file, path: `vehicles[${i}].${path}`, message, severity });
    const st = v.drive.steering;
    if (st.kind !== v.class) err("drive.steering.kind", `a ${v.class} vehicle needs ${v.class} steering`);
    if (v.class === "tracked" && (v.body.trackGaugeM === undefined || v.body.trackContactM === undefined)) err("body", "a tracked vehicle needs trackGaugeM and trackContactM");
    if (v.class === "wheeled" && v.body.wheelbaseM === undefined) err("body.wheelbaseM", "a wheeled vehicle needs its wheelbase");
    const asc = (gs: { toKmh: number }[]) => gs.every((g, k) => k === 0 || g.toKmh > gs[k - 1]!.toKmh);
    if (!asc(v.drive.gears)) err("drive.gears", "gear bands must rise");
    if (!asc(v.drive.reverseGears)) err("drive.reverseGears", "gear bands must rise");
    if (Math.abs(v.drive.gears[v.drive.gears.length - 1]!.toKmh - v.drive.topSpeedKmh) > 1e-9) err("drive.gears", "the top gear must end at topSpeedKmh");
    if (Math.abs(v.drive.reverseGears[v.drive.reverseGears.length - 1]!.toKmh - v.drive.reverseTopSpeedKmh) > 1e-9) err("drive.reverseGears", "the top reverse gear must end at reverseTopSpeedKmh");
    const tank = pack.items[v.fuel.item];
    if (!tank) err("fuel.item", `unknown item '${v.fuel.item}'`);
    else if (tank.chargeCapacity === undefined || tank.chargeCapacity < v.fuel.capacityL) err("fuel.item", `'${tank.id}' must hold its charge in litres, at least ${v.fuel.capacityL}`);
    else if (tank.chargeItem !== undefined) err("fuel.item", `'${tank.id}' is a magazine (chargeItem), not a tank`);
    const ids = new Set<string>();
    v.seats.forEach((s, k) => { if (ids.has(s.id)) err(`seats[${k}].id`, `duplicate seat '${s.id}'`); ids.add(s.id); });
    const drivers = v.seats.filter((s) => s.station === "driver").length;
    if (drivers !== 1) err("seats", `exactly one driver seat is needed (found ${drivers})`);
    v.seats.forEach((s, k) => s.sensors?.forEach((x, j) => {
      if (data.spotting && !data.spotting.sensors[x.kind]) err(`seats[${k}].sensors[${j}].kind`, `unknown sensor kind '${x.kind}' (core/spotting.json sensors)`);
    }));
    const kinds = new Set(v.seats.map((s) => s.station));
    v.stations.forEach((sn, k) => {
      if (!kinds.has(sn.operator)) err(`stations[${k}].operator`, `no ${sn.operator} seat on this vehicle`);
      sn.weapons.forEach((w, j) => {
        const p = `stations[${k}].weapons[${j}]`;
        const wd = pack.weapons[w.weapon];
        if (!wd) { err(`${p}.weapon`, `unknown weapon '${w.weapon}'`); return; }
        w.feeds.forEach((fd, q) => {
          const it = pack.items[fd.item];
          if (!it) err(`${p}.feeds[${q}].item`, `unknown item '${fd.item}'`);
          else if (it.chargeItem === undefined || wd.ammo[it.chargeItem] === undefined) err(`${p}.feeds[${q}].item`, `'${fd.item}' must hold rounds (chargeItem) that '${w.weapon}' fires`);
          else if (it.chargeCapacity !== undefined && fd.ready.charge > it.chargeCapacity) err(`${p}.feeds[${q}].ready.charge`, `more than '${fd.item}' holds`);
        });
        if (w.feedKind === "single" && w.roundLoadSeconds === undefined) err(`${p}.roundLoadSeconds`, "a single-round feed needs roundLoadSeconds");
        if (w.loaderStation !== undefined && !kinds.has(w.loaderStation)) err(`${p}.loaderStation`, `no ${w.loaderStation} seat on this vehicle`);
        if (w.noLoaderFactor !== undefined && w.loaderStation === undefined) err(`${p}.noLoaderFactor`, "noLoaderFactor needs a loaderStation");
      });
    });
    v.stowed.forEach((x, k) => { if (!pack.items[x.item]) err(`stowed[${k}].item`, `unknown item '${x.item}'`); });
    if (v.cookOffAmmo !== undefined && !pack.ammunition[v.cookOffAmmo]) err("cookOffAmmo", `unknown ammunition '${v.cookOffAmmo}'`);
    // Armour (M7.4a): known materials, one plate per part and face, a turret plate only with a turret.
    if (v.armour) {
      const seen = new Set<string>();
      v.armour.plates.forEach((pl, k) => {
        if (data.terrain && !data.terrain.materials[pl.material]) err(`armour.plates[${k}].material`, `unknown material '${pl.material}'`);
        if (pl.part === "turret" && !v.body.turret) err(`armour.plates[${k}].part`, "a turret plate on a vehicle without a turret");
        const key = `${pl.part}/${pl.face}`;
        if (seen.has(key)) err(`armour.plates[${k}]`, `two plates for ${key}`);
        seen.add(key);
      });
      for (const part of v.body.turret ? ["hull", "turret"] : ["hull"]) for (const face of ["front", "side", "rear", "top"]) {
        if (!seen.has(`${part}/${face}`)) err("armour.plates", `no plate for ${part}/${face}`, "warning");
      }
    }
    v.components?.parts.forEach((c, k) => {
      if (c.part === "turret" && !v.body.turret) err(`components.parts[${k}].part`, "a turret component on a vehicle without a turret");
      if (v.components!.parts.findIndex((x) => x.id === c.id) !== k) err(`components.parts[${k}].id`, `component '${c.id}' twice`);
    });
    // M7.4b: extinguisher charges, active protection charges and add-on tiles are counted items.
    if (v.extinguisher && !pack.items[v.extinguisher.item]) err("extinguisher.item", `unknown item '${v.extinguisher.item}'`);
    if (v.activeProtection && !pack.items[v.activeProtection.item]) err("activeProtection.item", `unknown item '${v.activeProtection.item}'`);
    v.armour?.tiles?.forEach((t, k) => {
      if (!pack.items[t.item]) err(`armour.tiles[${k}].item`, `unknown item '${t.item}'`);
      if (t.part === "turret" && !v.body.turret) err(`armour.tiles[${k}].part`, "a turret tile on a vehicle without a turret");
    });
  });
  // Crew and carriage templates.
  const byId = new Map(vehicles.map((v) => [v.id, v]));
  units.forEach((u, i) => {
    const err = (path: string, message: string, severity: "error" | "warning" = "error") => errors.push({ file: f("units.json"), path: `units[${i}].${path}`, message, severity });
    if (u.vehicle !== undefined) {
      const v = byId.get(u.vehicle);
      if (!v) err("vehicle", `unknown vehicle '${u.vehicle}' (known: ${known(pack.vehicles)})`);
      else {
        const crewSeats = v.seats.filter((s) => s.station !== "passenger");
        if (u.members.length > crewSeats.length) err("members", `${u.members.length} crew but '${v.id}' has ${crewSeats.length} crew seats`);
        const used = new Set<string>();
        u.members.forEach((m, j) => {
          if (m.seat === undefined) return;
          if (!v.seats.some((s) => s.id === m.seat)) err(`members[${j}].seat`, `'${v.id}' has no seat '${m.seat}'`);
          else if (used.has(m.seat)) err(`members[${j}].seat`, `seat '${m.seat}' is taken twice`);
          used.add(m.seat);
        });
      }
    } else if (u.members.some((m) => m.seat !== undefined)) err("members", "only a crew template (with `vehicle`) can name seats");
    u.carriage?.forEach((c, k) => {
      const crewT = u.subunits[c.crew] === undefined ? undefined : pack.units[u.subunits[c.crew]!];
      if (!crewT) { err(`carriage[${k}].crew`, `no sub-unit ${c.crew}`); return; }
      const v = crewT.vehicle === undefined ? undefined : byId.get(crewT.vehicle);
      if (!v) { err(`carriage[${k}].crew`, `sub-unit ${c.crew} ('${crewT.id}') is not a vehicle crew`); return; }
      let men = c.hq === true ? u.members.length : 0;
      if (c.hq === true && u.carriage!.filter((x) => x.hq === true).length > 1) err(`carriage[${k}].hq`, "only one vehicle carries the headquarters");
      for (const ci of c.carries) {
        const t = u.subunits[ci] === undefined ? undefined : pack.units[u.subunits[ci]!];
        if (!t || ci === c.crew) { err(`carriage[${k}].carries`, `no sub-unit ${ci} to carry`); continue; }
        men += t.members.length;
      }
      const seats = v.seats.filter((s) => s.station === "passenger").length;
      if (men > seats) err(`carriage[${k}].carries`, `${men} men to carry but '${v.id}' has ${seats} passenger seats`, "warning");
    });
  });
}

export function formatErrors(errors: DataError[]): string {
  return errors.map((e) => `${e.severity === "error" ? "ERROR  " : "warning"} ${e.file}: ${e.path}: ${e.message}`).join("\n");
}
