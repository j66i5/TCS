/**
 * Vehicle scenarios (M7.1c; tools and `?scenario=vehicles` only — vehicles stay out of every other battle until
 * M7.4a): platoons of infantry fighting vehicles with a dismount squad on foot beside each, on a generated map.
 * The crews come from the faction's crew templates (`vehicle` set); each vehicle is a roster record (fuel full,
 * stowage from data). Nothing faction-specific in code: the crew and squad templates are options or data.
 */
import { buildCatalog, type DataSet } from "@tcs/data";
import {
  buildNavGrid, flatMap, nearestPassable, newVehicleRecord, PI,
  type BattleInput, type ForceInput, type MapDef, type NavGrid, type Placement, type UnitInput, type VehicleRecord,
} from "@tcs/sim";
import { allMembers, buildForce, buildForceWithVehicles } from "./forces";
import { defaultRules, freeSpot, SIDES } from "./demo";
import { generateMap, type MapKind } from "./mapgen/index";

export interface VehicleBattleOptions {
  seed: number;
  factions: [string, string];
  /** Crew template per side (a template with `vehicle`); default: the faction's carrier crew (`crewTemplateOf`). */
  crewTemplates?: [string, string];
  /** M7.6c: the carrier class of the default crews (`crewTemplateOf`), one for both sides or [blue, red];
   * default: the manifest's `platoonTemplate`. */
  carriers?: CarrierClass | [CarrierClass, CarrierClass];
  /** Squad on foot that goes with each vehicle; default: the faction's demo template. */
  squadTemplates?: [string, string];
  /** Platoons per side, and vehicles (each with its squad) per platoon. */
  platoonsPerSide?: number;
  vehiclesPerPlatoon?: number;
  /** Generated map kind; omitted = flat. */
  mapKind?: MapKind;
  mapWidthM?: number;
  mapHeightM?: number;
  timeLimitSeconds?: number;
  /** M11.7b: each side also gets its faction's recovery vehicles off the map (manifest `recovery`). Default false. */
  recovery?: boolean;
}

/**
 * The battle without recovery vehicles (M11.7b, `--no-recovery`): their crews, hulls and off-map entries taken out of
 * every force, and `rules.recovery` off. They come after every other entity, so nothing else changes its id.
 */
export function withoutRecovery(input: BattleInput): BattleInput {
  for (const f of input.forces) {
    const ids = new Set((f.offMap ?? []).filter((a) => a.kind === "recovery").map((a) => a.vehicleId));
    if (ids.size === 0) continue;
    f.offMap = f.offMap!.filter((a) => !ids.has(a.vehicleId));
    f.vehicles = f.vehicles?.filter((r) => !ids.has(r.vehicleId));
    f.units = f.units.filter((u) => u.vehicleId === undefined || !ids.has(u.vehicleId));
  }
  input.rules.recovery = false;
  return input;
}

/**
 * Recovery vehicles off the map (M11.7b): the faction manifest's `recovery` crews and hulls (fresh roster records),
 * appended to the force as off-map assets waiting to be called. Nothing without a manifest entry.
 */
export function addRecoveryAssets(data: DataSet, catalog: BattleInput["catalog"], force: ForceInput, seed: number): void {
  const rcv = data.factions[force.faction]?.manifest.recovery;
  const vtype = rcv ? data.factions[force.faction]!.units[rcv.template]?.vehicle : undefined;
  const def = vtype === undefined ? undefined : catalog.vehicles[vtype];
  if (!rcv || !def) return;
  for (let k = 0; k < rcv.count; k++) {
    const crew = buildForceWithVehicles(data, { faction: force.faction, template: rcv.template, seed: seed + k, keyPrefix: `${force.side}-rcv${k + 1}`, number: k + 1 }).unit;
    crew.vehicleId = crew.key;
    force.units.push(crew);
    (force.vehicles ??= []).push(newVehicleRecord(catalog, vtype!, crew.key));
    (force.offMap ??= []).push({ vehicleId: crew.key, kind: "recovery" });
  }
}

/**
 * The military police off the map (M11.9b): the faction manifest's `mp` crews and hulls (fresh roster records),
 * appended to the force as off-map assets waiting to be called to a prisoner collection point. Nothing without a
 * manifest entry.
 */
export function addMpAssets(data: DataSet, catalog: BattleInput["catalog"], force: ForceInput, seed: number): void {
  const mp = data.factions[force.faction]?.manifest.mp;
  const vtype = mp ? data.factions[force.faction]!.units[mp.template]?.vehicle : undefined;
  const def = vtype === undefined ? undefined : catalog.vehicles[vtype];
  if (!mp || !def) return;
  for (let k = 0; k < mp.count; k++) {
    const crew = buildForceWithVehicles(data, { faction: force.faction, template: mp.template, seed: seed + k, keyPrefix: `${force.side}-mp${k + 1}`, number: k + 1 }).unit;
    crew.vehicleId = crew.key;
    force.units.push(crew);
    (force.vehicles ??= []).push(newVehicleRecord(catalog, vtype!, crew.key));
    (force.offMap ??= []).push({ vehicleId: crew.key, kind: "mp" });
  }
}

/**
 * The battle without the military police (M11.9b, `--no-mp`): their crews, hulls and off-map entries taken out of every
 * force. They come after every other entity, so nothing else changes its id.
 */
export function withoutMp(input: BattleInput): BattleInput {
  for (const f of input.forces) {
    const ids = new Set((f.offMap ?? []).filter((a) => a.kind === "mp").map((a) => a.vehicleId));
    if (ids.size === 0) continue;
    f.offMap = f.offMap!.filter((a) => !ids.has(a.vehicleId));
    f.vehicles = f.vehicles?.filter((r) => !ids.has(r.vehicleId));
    f.units = f.units.filter((u) => u.vehicleId === undefined || !ids.has(u.vehicleId));
    if (f.vehicles?.length === 0) delete f.vehicles;
  }
  return input;
}

/**
 * Supply vehicles off the map (M11.4b): the faction manifest's `supply` crews and hulls (fresh roster records), appended
 * to the force as off-map assets waiting to be called for a delivery. Nothing without a manifest entry.
 */
export function addSupplyAssets(data: DataSet, catalog: BattleInput["catalog"], force: ForceInput, seed: number): void {
  const sup = data.factions[force.faction]?.manifest.supply;
  const vtype = sup ? data.factions[force.faction]!.units[sup.template]?.vehicle : undefined;
  const def = vtype === undefined ? undefined : catalog.vehicles[vtype];
  if (!sup || !def) return;
  for (let k = 0; k < sup.count; k++) {
    const crew = buildForceWithVehicles(data, { faction: force.faction, template: sup.template, seed: seed + k, keyPrefix: `${force.side}-sup${k + 1}`, number: k + 1 }).unit;
    crew.vehicleId = crew.key;
    force.units.push(crew);
    (force.vehicles ??= []).push(newVehicleRecord(catalog, vtype!, crew.key));
    (force.offMap ??= []).push({ vehicleId: crew.key, kind: "supply" });
  }
}

/** Carrier class of a generated platoon (M7.6c): which of the manifest's `platoonTemplates` a battle uses. */
export type CarrierClass = "tracked" | "wheeled";

/** The platoon template of a faction for a carrier class: `platoonTemplates[cls]`, else `platoonTemplate`. */
export function platoonTemplateOf(data: DataSet, faction: string, carriers?: CarrierClass): string | undefined {
  const m = data.factions[faction]?.manifest;
  return (carriers !== undefined ? m?.platoonTemplates?.[carriers] : undefined) ?? m?.platoonTemplate;
}

/**
 * The crew template of a fighting vehicle that carries a squad (not an ambulance, not a tank) of a faction: one of
 * the carriage crews of its platoon for that carrier class (M7.6c: `platoonTemplateOf`), first by id; a faction
 * whose platoon has none: the first such template by id (as before M7.6c).
 */
export function crewTemplateOf(data: DataSet, faction: string, carriers?: CarrierClass): string {
  const pack = data.factions[faction];
  // (M10.6-data: a fighting vehicle's crew, not an ambulance's: ambulances come from off the map, M10.6a. M7.6a: a
  // vehicle with passenger seats, so a tank never becomes the default carrier of these battles.)
  const fighting = (id: string) => {
    const v = pack!.units[id]?.vehicle, vd = v === undefined ? undefined : pack!.vehicles[v];
    return vd !== undefined && vd.ambulance === undefined && vd.seats.some((q) => q.station === "passenger");
  };
  if (!pack) throw new Error(`faction '${faction}' has no vehicle crew template`);
  const pt = platoonTemplateOf(data, faction, carriers);
  const plat = pt === undefined ? undefined : pack.units[pt];
  const carried = [...new Set((plat?.carriage ?? []).map((c) => plat!.subunits[c.crew]).filter((x): x is string => x !== undefined))].sort().filter(fighting);
  if (carried.length > 0) return carried[0]!;
  const ids = Object.keys(pack.units).sort().filter(fighting);
  if (ids.length === 0) throw new Error(`faction '${faction}' has no vehicle crew template`);
  return ids[0]!;
}

/**
 * Blue in the west, red in the east, each platoon a column of vehicles 15 m apart (facing the enemy) with its
 * squads on foot beside them. Vehicles stand on ground their class can drive (the class grid with extra
 * clearance, in the map's main connected area).
 */
export function vehicleBattle(data: DataSet, opts: VehicleBattleOptions): BattleInput {
  const catalog = buildCatalog(data, [...opts.factions]);
  const W = opts.mapWidthM ?? 1200, H = opts.mapHeightM ?? 900;
  const map: MapDef = opts.mapKind ? generateMap(catalog.terrain, { kind: opts.mapKind, seed: opts.seed, widthM: W, heightM: H }) : flatMap("vehicles-flat", W, H);
  const plats = opts.platoonsPerSide ?? 1, per = opts.vehiclesPerPlatoon ?? 2;
  const grids = new Map<string, NavGrid>();
  const forces: ForceInput[] = SIDES.map((side, s) => {
    const faction = opts.factions[s]!;
    const carriers = Array.isArray(opts.carriers) ? opts.carriers[s] : opts.carriers;
    const crewT = opts.crewTemplates?.[s] ?? crewTemplateOf(data, faction, carriers);
    const squadT = opts.squadTemplates?.[s] ?? data.factions[faction]?.manifest.demoTemplate ?? "demo-team";
    const vtype = data.factions[faction]!.units[crewT]!.vehicle!;
    const def = catalog.vehicles[vtype];
    if (!def) throw new Error(`vehicle type '${vtype}' not in the catalog`);
    let grid = grids.get(def.class);
    if (!grid) { grid = buildNavGrid(map, catalog.terrain, def.class, 2, 0, [], { clearanceCells: 3 }); grids.set(def.class, grid); }
    const mainRegion = grid.region[Math.floor(H / 2 / 2) * grid.cols + Math.floor(W / 2 / 2)] ?? 0;
    const units: UnitInput[] = [], placements: Placement[] = [], vehicles: VehicleRecord[] = [];
    const vehiclePlacements: NonNullable<ForceInput["vehiclePlacements"]> = [];
    const heading = s === 0 ? 0 : PI;
    for (let p = 0; p < plats; p++) {
      const key = `${side}-${p + 1}`;
      const subunits: UnitInput[] = [];
      const cy = (H * (p + 1)) / (plats + 1);
      for (let k = 0; k < per; k++) {
        const seed = opts.seed * 131 + s * 17 + p * 7 + k;
        const crew = buildForce(data, { faction, template: crewT, seed, keyPrefix: `${key}-v${k + 1}`, number: p * per + k + 1 });
        const squad = buildForce(data, { faction, template: squadT, seed: seed + 1000, keyPrefix: `${key}-s${k + 1}`, number: p * per + k + 1 });
        // The squad rides in this vehicle when it mounts (M7.2); a vehicle without passenger seats (a tank, M7.6a)
        // carries nobody.
        if (def.seats.some((q) => q.station === "passenger")) squad.carrierId = crew.key;
        subunits.push(crew, squad);
        // The vehicle: a fresh roster record (fuel full, stowage from data).
        vehicles.push({
          vehicleId: crew.key, type: vtype,
          load: [{ type: def.fuel.item, count: 1, charge: def.fuel.capacityL }, ...def.stowed.map((st) => (st.charge === undefined ? { type: st.item, count: st.count } : { type: st.item, count: st.count, charge: st.charge }))],
        });
        const x0 = s === 0 ? W * 0.1 : W * 0.9;
        const y0 = cy + (k - (per - 1) / 2) * 15;
        const cell = nearestPassable(grid, Math.min(Math.max(x0, 1), W - 1), Math.min(Math.max(y0, 1), H - 1), 60, mainRegion);
        const vx = cell < 0 ? x0 : ((cell % grid.cols) + 0.5) * grid.cellM, vy = cell < 0 ? y0 : (Math.floor(cell / grid.cols) + 0.5) * grid.cellM;
        vehiclePlacements.push({ vehicleId: crew.key, x: vx, y: vy, heading });
        crew.vehicleId = crew.key;
        // Crewmen whose template names their seat take it (MemberSlot.seat -> Placement.seat).
        const slots = data.factions[faction]!.units[crewT]!.members;
        crew.members.forEach((m, mi) => {
          const sid = slots[mi]?.seat;
          const seat = sid === undefined ? -1 : def.seats.findIndex((q) => q.id === sid);
          if (seat >= 0) placements.push({ personId: m.personId, x: vx, y: vy, heading, seat });
        });
        // The squad on foot beside its vehicle, on the side away from the enemy, in a loose line.
        const men = allMembers(squad);
        men.forEach((m, mi) => {
          const q = freeSpot(map, catalog, vx + (s === 0 ? -10 : 10), vy + (mi - (men.length - 1) / 2) * 3);
          placements.push({ personId: m.personId, x: q.x, y: q.y, heading });
        });
      }
      units.push({ key, callsign: `${p + 1}`, echelon: "platoon", leaderIndex: -1, members: [], subunits });
    }
    const force: ForceInput = { side, faction, units, placements, vehicles, vehiclePlacements };
    if (opts.recovery === true) addRecoveryAssets(data, catalog, force, opts.seed * 47 + s * 19);
    return force;
  });
  return { map, catalog, forces, rules: defaultRules(opts.timeLimitSeconds ?? 600), seed: opts.seed, orders: [] };
}
