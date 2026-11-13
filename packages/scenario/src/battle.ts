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
  atan2, buildBallistics, buildMapIndex, buildNavGrid, heightAt, hypot2, nearestPassable, newVehicleRecord, PI, sight, TICK_HZ,
  type BattleInput, type Catalog, type ForceInput, type MapDef, type NavGrid, type ObjectiveDef, type Placement, type SimContext, type UnitInput, type VehicleRecord,
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
  /** With vehicles: the attacker's hulls start in dead ground, out of the defenders' sight (owner 2026-11-13;
   *  default true). False: the old line across the attacker's map edge (for comparisons). */
  deadGroundStart?: boolean;
}

/** Mortar rounds each side may call (game values). */
export const SCENARIO_SUPPORT = { attackerHe: 24, attackerSmoke: 12, defenderHe: 12, defenderSmoke: 4 } as const;

/** Points of the main and the second objective, and what each man down costs his side. */
export const SCENARIO_POINTS = { main: 100, second: 50, perManDown: 5, vehicleLost: 20, vehicleImmobilised: 10 } as const;

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
  // The defender is built first: the attacker's start (dead ground) depends on where the defenders stand.
  let observers: { x: number; y: number; z: number }[] = [];
  const buildSide = (side: "blue" | "red", s: number): ForceInput => {
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
    const fv = withVehicles ? placeVehicles(catalog, map, built.flatMap((b) => b.vehicles), attacking, side, mainP, dx, W, H, attacking && def.deadGroundStart !== false ? { observers, objectives: [mainP, secondP] } : null) : null;
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
        const sp = defenceSpots(mainP, secondP, dx)[Math.min(gi, 3)]!;
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
    if (!attacking) {
      // What the defence sees from (dead ground for the attacker's start): its vehicles' sights and its men.
      const eye = (type: string) => { const vd = catalog.vehicles[type]; let z = vd?.body.heightM ?? 2.5; for (const q of vd?.seats ?? []) for (const k of q.sensors ?? []) z = Math.max(z, k.pos?.[2] ?? 0); return z; };
      observers = [
        ...(fv?.vehiclePlacements ?? []).map((p) => ({ x: p.x, y: p.y, z: eye(force.vehicles?.find((r) => r.vehicleId === p.vehicleId)?.type ?? "") })),
        ...defenceSpots(mainP, secondP, dx).map((p) => ({ x: p.x, y: p.y, z: 1.7 })),
      ];
    }
    return force;
  };
  const forces: ForceInput[] = [];
  const dIdx = SIDES.indexOf(defender), aIdx = SIDES.indexOf(def.attacker);
  forces[dIdx] = buildSide(defender, dIdx);
  forces[aIdx] = buildSide(def.attacker, aIdx);
  const rules = defaultRules(def.timeLimitSeconds ?? 2400);
  rules.objectives = objectives;
  rules.victory = { casualtyPoints: SCENARIO_POINTS.perManDown, endOnDefeat: true };
  // Vehicles (M7.4a, owner Q9): an IFV destroyed or abandoned costs 20 points, immobilised 10.
  if (forces.some((f) => (f.vehicles?.length ?? 0) > 0)) rules.victory.vehiclePoints = { lost: SCENARIO_POINTS.vehicleLost, immobilised: SCENARIO_POINTS.vehicleImmobilised };
  // Mortar rounds (owner, M6 review: support fire pulled forward): the attacker more, with smoke.
  rules.support = SIDES.map((side, s) => {
    const k = catalog.factions[def.factions[s]!]?.fireSupport?.roundsFactor ?? 1;
    const att = side === def.attacker;
    return { side, he: Math.round(k * (att ? SCENARIO_SUPPORT.attackerHe : SCENARIO_SUPPORT.defenderHe)), smoke: Math.round(k * (att ? SCENARIO_SUPPORT.attackerSmoke : SCENARIO_SUPPORT.defenderSmoke)) };
  });
  return { map, catalog, forces, rules, seed: def.seed, orders: [] };
}

interface SoldierGroup { men: string[]; carrier: string | undefined }

/** Where the defence stands at the start: its platoon's men behind the main objective's centre, two squads at
 *  its front corners (inside its 40 m ring), one squad in front of the second objective. */
function defenceSpots(mainP: { x: number; y: number }, secondP: { x: number; y: number }, dx: number): { x: number; y: number }[] {
  return [{ x: mainP.x + dx * 10, y: mainP.y }, { x: mainP.x - dx * 14, y: mainP.y - 20 }, { x: mainP.x - dx * 14, y: mainP.y + 20 }, { x: secondP.x - dx * 8, y: secondP.y }];
}

/** Dead ground (owner 2026-11-13): candidate starts this far apart, at least this far from every objective, and on
 *  the attacker's side of this share of the map. A spot is hidden from an observer when the line to a hull's middle
 *  and to its top is blocked (ground, walls, roofs) or seen through less than this share (woods, hedges); a group
 *  of hulls stays within groupRadiusM of its first spot. */
const DEAD_GROUND = { stepM: 20, minFromObjectiveM: 600, ownShare: 0.4, edgeM: 30, seenAbove: 0.15, spacingM: 20, groupRadiusM: 200 } as const;

/**
 * The attacker's vehicle starts in dead ground (owner 2026-11-13): spots on its side of the map, at least 600 m
 * from the objectives, that no defender (its vehicles' sights, its men) can see, sampled every 20 m. The spot
 * hidden from everyone and nearest the usual start (the middle of the attacker's edge) anchors the group; the
 * hulls take the hidden spots nearest it, 20 m apart. Where too few spots are hidden from all, the least seen
 * ones are used (on open, flat ground that is the usual line at the edge); a group stays within 200 m. Deterministic: the map and the
 * defenders' places only.
 */
function deadGroundStarts(
  catalog: Catalog, map: MapDef, grid: NavGrid, region: number, n: number, side: string, hullHeightM: number,
  observers: readonly { x: number; y: number; z: number }[], objectives: readonly { x: number; y: number }[], W: number, H: number,
): { x: number; y: number }[] | null {
  if (observers.length === 0 || n === 0) return null;
  const D = DEAD_GROUND;
  const mapIndex = buildMapIndex(map);
  const ctx = { catalog, map, mapIndex, ballistics: buildBallistics(map, catalog, mapIndex, TICK_HZ) } as unknown as SimContext;
  const homeX = side === "blue" ? W * 0.08 : W * 0.92, homeY = H / 2;
  const cands: { x: number; y: number; seen: number; home: number }[] = [];
  for (let x = D.edgeM; x <= W - D.edgeM; x += D.stepM) {
    if (side === "blue" ? x > W * D.ownShare : x < W * (1 - D.ownShare)) continue;
    for (let y = D.edgeM; y <= H - D.edgeM; y += D.stepM) {
      if (objectives.some((o) => hypot2(o.x - x, o.y - y) < D.minFromObjectiveM)) continue;
      const cell = nearestPassable(grid, x, y, 0, region);
      if (cell < 0) continue;
      const g = heightAt(map, x, y);
      let seen = 0;
      for (const o of observers) {
        const oz = heightAt(map, o.x, o.y) + o.z;
        for (const h of [1.2, hullHeightM - 0.1]) {
          const r = sight(ctx, o.x, o.y, oz, x, y, g + h);
          if (r.blockedBy === null && r.visibility >= D.seenAbove) { seen++; break; }
        }
      }
      cands.push({ x, y, seen, home: hypot2(x - homeX, y - homeY) });
    }
  }
  if (cands.length === 0) return null;
  cands.sort((a, b) => a.seen - b.seen || a.home - b.home || a.x - b.x || a.y - b.y);
  // A group round each of the best anchors: the least seen spots nearest it, at least 20 m apart. The group seen
  // least wins, then the tighter one, then the one nearer the usual start.
  let best: { x: number; y: number; seen: number }[] | null = null, bestCost = Infinity;
  for (const anchor of cands.slice(0, 80)) {
    const near = [...cands].sort((a, b) => a.seen - b.seen || hypot2(a.x - anchor.x, a.y - anchor.y) - hypot2(b.x - anchor.x, b.y - anchor.y) || a.x - b.x || a.y - b.y);
    const out: { x: number; y: number; seen: number }[] = [];
    let seen = 0, spread = 0;
    for (const c of near) {
      if (out.length >= n) break;
      if (out.some((p) => hypot2(p.x - c.x, p.y - c.y) < D.spacingM - 1e-6) || hypot2(c.x - anchor.x, c.y - anchor.y) > D.groupRadiusM) continue;
      out.push(c); seen += c.seen; spread = Math.max(spread, hypot2(c.x - anchor.x, c.y - anchor.y));
    }
    if (out.length < n) continue;
    const cost = seen * 1000 + spread + 0.3 * anchor.home;
    if (cost < bestCost) { bestCost = cost; best = out; }
  }
  if (!best) return null;
  lastDeadGround = { seen: best.map((c) => c.seen), observers: observers.length, candidates: cands.length, hidden: cands.filter((c) => c.seen === 0).length };
  return best.map((c) => ({ x: c.x, y: c.y }));
}

/** Diagnostics of the last dead-ground choice (tools and tests): observers seeing each start, hidden spots. */
export let lastDeadGround: { seen: number[]; observers: number; candidates: number; hidden: number } | null = null;

/** Spacing of the vehicles at the start, m. */
const VEHICLE_SPACING_M = 20;

/**
 * Where a side's vehicles start (M7.2, plan §11): the attacker's in a line across its map edge, 8 % in, facing
 * the enemy; the defender's 60-120 m behind the main objective. Each on ground its class can drive (the class
 * grid with extra clearance, in the map's main connected area). Crewmen whose template names a seat take it.
 */
function placeVehicles(
  catalog: Catalog, map: MapDef, vehicles: ForceVehicle[], attacking: boolean, side: string, mainP: { x: number; y: number }, dx: number, W: number, H: number,
  dead: { observers: readonly { x: number; y: number; z: number }[]; objectives: readonly { x: number; y: number }[] } | null = null,
): { records: VehicleRecord[]; vehiclePlacements: NonNullable<ForceInput["vehiclePlacements"]>; placements: Placement[] } {
  const records: VehicleRecord[] = [], vehiclePlacements: NonNullable<ForceInput["vehiclePlacements"]> = [], placements: Placement[] = [];
  const grids = new Map<string, NavGrid>();
  let heading = side === "blue" ? 0 : PI;
  // Dead ground for the attacker's start (owner 2026-11-13): spots chosen for the first vehicle's class.
  let starts: { x: number; y: number }[] | null = null;
  if (dead && vehicles.length > 0) {
    const def0 = catalog.vehicles[vehicles[0]!.type];
    if (def0) {
      const grid = buildNavGrid(map, catalog.terrain, def0.class, 2, 0, [], { clearanceCells: 3 });
      grids.set(def0.class, grid);
      const mainRegion = grid.region[Math.floor(H / 2 / 2) * grid.cols + Math.floor(W / 2 / 2)] ?? 0;
      let tallest = 0;
      for (const fv of vehicles) tallest = Math.max(tallest, catalog.vehicles[fv.type]?.body.heightM ?? 2.5);
      starts = deadGroundStarts(catalog, map, grid, mainRegion, vehicles.length, side, tallest, dead.observers, dead.objectives, W, H);
      if (starts) {
        // Facing the main objective from the group's middle.
        let sx = 0, sy = 0;
        for (const p of starts) { sx += p.x; sy += p.y; }
        heading = atan2(mainP.y - sy / starts.length, mainP.x - sx / starts.length);
      }
    }
  }
  vehicles.forEach((fv, i) => {
    const def = catalog.vehicles[fv.type];
    if (!def) throw new Error(`scenario: vehicle type '${fv.type}' not in the catalog`);
    let grid = grids.get(def.class);
    if (!grid) { grid = buildNavGrid(map, catalog.terrain, def.class, 2, 0, [], { clearanceCells: 3 }); grids.set(def.class, grid); }
    const mainRegion = grid.region[Math.floor(H / 2 / 2) * grid.cols + Math.floor(W / 2 / 2)] ?? 0;
    const lat = (i - (vehicles.length - 1) / 2) * VEHICLE_SPACING_M;
    // Attack: a line across the own edge. Defence: behind the main objective (away from the attack), staggered.
    const x0 = starts ? starts[i]!.x : attacking ? (side === "blue" ? W * 0.08 : W * 0.92) : mainP.x + dx * (60 + (i % 2) * 60);
    const y0 = starts ? starts[i]!.y : attacking ? H / 2 + lat : mainP.y + lat * 1.5;
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
