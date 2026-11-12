/**
 * Vehicle scenarios (M7.1c; tools and `?scenario=vehicles` only — vehicles stay out of every other battle until
 * M7.4a): platoons of infantry fighting vehicles with a dismount squad on foot beside each, on a generated map.
 * The crews come from the faction's crew templates (`vehicle` set); each vehicle is a roster record (fuel full,
 * stowage from data). Nothing faction-specific in code: the crew and squad templates are options or data.
 */
import { buildCatalog, type DataSet } from "@tcs/data";
import {
  buildNavGrid, flatMap, nearestPassable, PI,
  type BattleInput, type ForceInput, type MapDef, type NavGrid, type Placement, type UnitInput, type VehicleRecord,
} from "@tcs/sim";
import { allMembers, buildForce } from "./forces";
import { defaultRules, freeSpot, SIDES } from "./demo";
import { generateMap, type MapKind } from "./mapgen/index";

export interface VehicleBattleOptions {
  seed: number;
  factions: [string, string];
  /** Crew template per side (a template with `vehicle`); default: the faction's first crew template. */
  crewTemplates?: [string, string];
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
}

/** The first crew template (one with a vehicle) of a faction, by id order. */
export function crewTemplateOf(data: DataSet, faction: string): string {
  const pack = data.factions[faction];
  const ids = pack ? Object.keys(pack.units).sort().filter((id) => pack.units[id]!.vehicle !== undefined) : [];
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
    const crewT = opts.crewTemplates?.[s] ?? crewTemplateOf(data, faction);
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
    return { side, faction, units, placements, vehicles, vehiclePlacements };
  });
  return { map, catalog, forces, rules: defaultRules(opts.timeLimitSeconds ?? 600), seed: opts.seed, orders: [] };
}
