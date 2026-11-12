/**
 * SCENARIO FORMAT AND GENERATOR (M6, owner decisions 2026-11-12): platoon against platoon, one side attacks,
 * the other defends; points for the objectives held at the end minus a share for men down; a side that breaks
 * or is wiped out loses at once.
 *
 * A scenario is plain data (`ScenarioDef`, JSON-safe): what kind of battle, the seed, the map kind, the faction
 * of each side and which side attacks. `buildScenario` turns it into a BattleInput deterministically (the same
 * definition always gives the same battle). Blue always starts in the west, red in the east; either may attack.
 */
import { buildCatalog, type DataSet } from "@tcs/data";
import {
  buildNavGrid, hypot2, nearestPassable, newVehicleRecord, PI,
  type BattleInput, type Catalog, type ForceInput, type MapDef, type NavGrid, type ObjectiveDef, type Placement, type UnitInput, type VehicleRecord,
} from "@tcs/sim";
import { defaultRules, freeSpot, SIDES } from "./demo";
import { allMembers, buildForceWithVehicles, withoutVehicles, type ForceVehicle } from "./forces";
import { generateMap, type MapKind } from "./mapgen/index";

export interface ScenarioDef {
  kind: "platoon-attack";
  seed: number;
  mapKind: MapKind;
  /** Faction of blue (west) and red (east). */
  factions: [string, string];
  /** Which side attacks: the other holds the objectives at the start. */
  attacker: "blue" | "red";
  /** Platoons on the attacking side (owner, M6 review: two against one); the defender always has one. */
  attackerPlatoons?: number;
  /** Unit template per side (defaults: the faction manifest's platoon template, else its demo template). */
  templates?: [string, string];
  timeLimitSeconds?: number;
  mapWidthM?: number;
  mapHeightM?: number;
  /** With vehicles (M7.2; owner Q26: opt-in until M7.4a): the platoons' crews and vehicles take part; the attacker
   *  starts mounted at its map edge, the defender's vehicles stand behind its main objective with only their
   *  crews aboard. Off: the same platoons on foot, without their crews (as before M7.2). */
  vehicles?: boolean;
}

/** Mortar rounds each side may call (game values). */
export const SCENARIO_SUPPORT = { attackerHe: 24, attackerSmoke: 12, defenderHe: 12, defenderSmoke: 4 } as const;

/** Points of the main and the second objective, and what each man down costs his side. */
export const SCENARIO_POINTS = { main: 100, second: 50, perManDown: 5 } as const;

function centroid(c: number[]): { x: number; y: number } {
  let x = 0, y = 0;
  const n = c.length / 2;
  for (let i = 0; i < c.length; i += 2) { x += c[i]!; y += c[i + 1]!; }
  return { x: x / n, y: y / n };
}

/** The building nearest to a point within `maxM` (its centre), else the point itself. */
function nearBuilding(map: MapDef, x: number, y: number, maxM: number, not: { x: number; y: number }[] = []): { x: number; y: number } {
  let best: { x: number; y: number } | null = null, bestD = maxM;
  for (const b of map.buildings) {
    const c = centroid(b.footprint);
    if (not.some((p) => hypot2(p.x - c.x, p.y - c.y) < 80)) continue;
    const d = hypot2(c.x - x, c.y - y);
    if (d < bestD) { bestD = d; best = c; }
  }
  return best ?? { x, y };
}

export function buildScenario(data: DataSet, def: ScenarioDef): BattleInput {
  const catalog = buildCatalog(data, [...def.factions]);
  const W = def.mapWidthM ?? 1200, H = def.mapHeightM ?? 900;
  const map = generateMap(catalog.terrain, { kind: def.mapKind, seed: def.seed, widthM: W, heightM: H });
  const defender = def.attacker === "blue" ? "red" : "blue";
  // Objectives on the defender's side of the map: the main one at a building near its middle, the second at
  // another building (or the ground) on a flank.
  const dx = defender === "red" ? 1 : -1;
  const mainP = nearBuilding(map, W / 2 + dx * W * 0.2, H / 2, 250);
  let secondP = nearBuilding(map, W / 2 + dx * W * 0.1, H / 2 + (def.seed % 2 === 0 ? 1 : -1) * H * 0.2, 200, [mainP]);
  // The two areas never overlap (their radii are 40 and 30 m): at least 90 m apart.
  if (hypot2(secondP.x - mainP.x, secondP.y - mainP.y) < 90) secondP = { x: mainP.x, y: Math.min(Math.max(mainP.y + (mainP.y < H / 2 ? 1 : -1) * 120, 20), H - 20) };
  const objectives: ObjectiveDef[] = [
    { id: "main", nameKey: "objective.main", x: mainP.x, y: mainP.y, radiusM: 40, points: SCENARIO_POINTS.main, holder: defender },
    { id: "second", nameKey: "objective.second", x: secondP.x, y: secondP.y, radiusM: 30, points: SCENARIO_POINTS.second, holder: defender },
  ];
  const forces: ForceInput[] = SIDES.map((side, s) => {
    const faction = def.factions[s]!;
    const pack = data.factions[faction];
    const template = def.templates?.[s] ?? pack?.manifest.platoonTemplate ?? pack?.manifest.demoTemplate ?? "demo-team";
    const count = side === def.attacker ? Math.max(1, def.attackerPlatoons ?? 2) : 1;
    const built = Array.from({ length: count }, (_, k) => buildForceWithVehicles(data, { faction, template, seed: def.seed * 31 + s * 7 + k * 101, keyPrefix: `${side}-${k + 1}`, number: k + 1 }));
    const withVehicles = def.vehicles === true && built.some((b) => b.vehicles.length > 0);
    const units = built.map((b) => (withVehicles ? b.unit : withoutVehicles(b.unit)));
    const placements: Placement[] = [];
    const heading = side === "blue" ? 0 : PI; // facing the other side
    const attacking = side === def.attacker;
    const fv = withVehicles ? placeVehicles(catalog, map, built.flatMap((b) => b.vehicles), attacking, side, mainP, dx, W, H) : null;
    if (fv) placements.push(...fv.placements);
    // Each sub-unit (squad) and each platoon's own men get a spot; men stand in a loose line, 6 m apart.
    // (With vehicles: crews are in their seats, and the attacker's carried men start aboard.)
    const footGroups = (unit: UnitInput): SoldierGroup[] => {
      const kids = unit.subunits.filter((u) => u.vehicleId === undefined);
      return unit.subunits.length > 0 ? [{ men: unit.members.map((m) => m.personId), carrier: unit.carrierId }, ...kids.map((u) => ({ men: allMembers(u).map((m) => m.personId), carrier: u.carrierId }))].filter((g) => g.men.length > 0) : [{ men: allMembers(unit).map((m) => m.personId), carrier: unit.carrierId }];
    };
    const groups = units.flatMap(footGroups);
    if (fv && attacking) {
      for (const g of groups) {
        const vp = g.carrier === undefined ? undefined : fv.vehiclePlacements.find((p) => p.vehicleId === g.carrier);
        if (!vp) throw new Error(`scenario: no vehicle for carried men ${g.men[0] ?? ""}`);
        for (const pid of g.men) placements.push({ personId: pid, x: vp.x, y: vp.y, heading: vp.heading, mountedIn: vp.vehicleId });
      }
    } else groups.map((g) => g.men).forEach((men, gi) => {
      let cx: number, cy: number;
      if (side === defender) {
        // Defence: the platoon's men behind the main objective's centre and two squads at its front corners (all
        // inside its 40 m ring), one squad at the second objective, in front of its centre.
        const spots = [{ x: mainP.x + dx * 10, y: mainP.y }, { x: mainP.x - dx * 14, y: mainP.y - 20 }, { x: mainP.x - dx * 14, y: mainP.y + 20 }, { x: secondP.x - dx * 8, y: secondP.y }];
        const sp = spots[Math.min(gi, spots.length - 1)]!;
        cx = sp.x; cy = sp.y;
      } else {
        // Attack: start in a line of squads near the own map edge, opposite the objectives.
        cx = side === "blue" ? W * 0.08 : W * 0.92;
        cy = H / 2 + (gi - (groups.length - 1) / 2) * (groups.length > 4 ? 45 : 70);
      }
      men.forEach((m, mi) => {
        const p = freeSpot(map, catalog, cx, cy + (mi - (men.length - 1) / 2) * 6);
        placements.push({ personId: m, x: p.x, y: p.y, heading });
      });
    });
    const force: ForceInput = { side, faction, units, placements, posture: side === def.attacker ? "attack" : "defend" };
    if (fv) { force.vehicles = fv.records; force.vehiclePlacements = fv.vehiclePlacements; }
    return force;
  });
  const rules = defaultRules(def.timeLimitSeconds ?? 2400);
  rules.objectives = objectives;
  rules.victory = { casualtyPoints: SCENARIO_POINTS.perManDown, endOnDefeat: true };
  // Mortar rounds (owner, M6 review: support fire pulled forward): the attacker more, with smoke.
  rules.support = SIDES.map((side, s) => {
    const k = catalog.factions[def.factions[s]!]?.fireSupport?.roundsFactor ?? 1;
    const att = side === def.attacker;
    return { side, he: Math.round(k * (att ? SCENARIO_SUPPORT.attackerHe : SCENARIO_SUPPORT.defenderHe)), smoke: Math.round(k * (att ? SCENARIO_SUPPORT.attackerSmoke : SCENARIO_SUPPORT.defenderSmoke)) };
  });
  return { map, catalog, forces, rules, seed: def.seed, orders: [] };
}

interface SoldierGroup { men: string[]; carrier: string | undefined }

/** Spacing of the vehicles at the start, m. */
const VEHICLE_SPACING_M = 20;

/**
 * Where a side's vehicles start (M7.2, plan §11): the attacker's in a line across its map edge, 8 % in, facing
 * the enemy; the defender's 60-120 m behind the main objective. Each on ground its class can drive (the class
 * grid with extra clearance, in the map's main connected area). Crewmen whose template names a seat take it.
 */
function placeVehicles(
  catalog: Catalog, map: MapDef, vehicles: ForceVehicle[], attacking: boolean, side: string, mainP: { x: number; y: number }, dx: number, W: number, H: number,
): { records: VehicleRecord[]; vehiclePlacements: NonNullable<ForceInput["vehiclePlacements"]>; placements: Placement[] } {
  const records: VehicleRecord[] = [], vehiclePlacements: NonNullable<ForceInput["vehiclePlacements"]> = [], placements: Placement[] = [];
  const grids = new Map<string, NavGrid>();
  const heading = side === "blue" ? 0 : PI;
  vehicles.forEach((fv, i) => {
    const def = catalog.vehicles[fv.type];
    if (!def) throw new Error(`scenario: vehicle type '${fv.type}' not in the catalog`);
    let grid = grids.get(def.class);
    if (!grid) { grid = buildNavGrid(map, catalog.terrain, def.class, 2, 0, [], { clearanceCells: 3 }); grids.set(def.class, grid); }
    const mainRegion = grid.region[Math.floor(H / 2 / 2) * grid.cols + Math.floor(W / 2 / 2)] ?? 0;
    const lat = (i - (vehicles.length - 1) / 2) * VEHICLE_SPACING_M;
    // Attack: a line across the own edge. Defence: behind the main objective (away from the attack), staggered.
    const x0 = attacking ? (side === "blue" ? W * 0.08 : W * 0.92) : mainP.x + dx * (60 + (i % 2) * 60);
    const y0 = attacking ? H / 2 + lat : mainP.y + lat * 1.5;
    const cell = nearestPassable(grid, Math.min(Math.max(x0, 1), W - 1), Math.min(Math.max(y0, 1), H - 1), 80, mainRegion);
    const taken = (x: number, y: number) => vehiclePlacements.some((p) => hypot2(p.x - x, p.y - y) < 12);
    let vx = cell < 0 ? x0 : ((cell % grid.cols) + 0.5) * grid.cellM, vy = cell < 0 ? y0 : (Math.floor(cell / grid.cols) + 0.5) * grid.cellM;
    // Never two hulls on the same spot: step along the line until free.
    for (let k = 1; taken(vx, vy) && k < 40; k++) {
      const c2 = nearestPassable(grid, vx, Math.min(Math.max(vy + (k % 2 === 0 ? 1 : -1) * k * 6, 1), H - 1), 40, mainRegion);
      if (c2 >= 0) { vx = ((c2 % grid.cols) + 0.5) * grid.cellM; vy = (Math.floor(c2 / grid.cols) + 0.5) * grid.cellM; }
    }
    records.push(newVehicleRecord(catalog, fv.type, fv.vehicleId));
    vehiclePlacements.push({ vehicleId: fv.vehicleId, x: vx, y: vy, heading });
    for (const cs of fv.crewSeats) {
      const seat = def.seats.findIndex((q) => q.id === cs.seat);
      if (seat >= 0) placements.push({ personId: cs.personId, x: vx, y: vy, heading, seat });
    }
  });
  return { records, vehiclePlacements, placements };
}
