/** Named scenarios for the headless tools, tests and benchmarks. */
import { type DataSet, formatErrors, loadDataSet } from "@tcs/data";
import { allMembers, buildScenario, demoBattle, freeSpot, vehicleBattle } from "@tcs/scenario";
import { commanderController, shootoutController, vehicleWanderController, wanderController } from "@tcs/ai";
import { hypot2, PI, type BattleInput, type Controller } from "@tcs/sim";
import { readDataFiles } from "./data-files";

export function loadData(includeFixtures = false): DataSet {
  const files = readDataFiles(includeFixtures ? ["core", "factions", "fixtures"] : ["core", "factions"]);
  const { data, errors } = loadDataSet(files);
  if (!data) throw new Error(`data failed to load:\n${formatErrors(errors)}`);
  return data;
}

export interface NamedScenario {
  description: string;
  fixtures?: boolean;
  build(data: DataSet, seed: number, seconds: number): BattleInput;
  controllers?(input: BattleInput): Controller[];
}

const vehicleWanderBoth = (input: BattleInput): Controller[] => [
  vehicleWanderController("blue", input.seed * 2 + 1, input.map),
  vehicleWanderController("red", input.seed * 2 + 2, input.map),
];

const wanderBoth = (input: BattleInput): Controller[] => [
  wanderController("blue", input.seed * 2 + 1, input.map),
  wanderController("red", input.seed * 2 + 2, input.map),
];

/**
 * M7.5d village-occupy: the blue squad occupies the two-storey house nearest to it (Occupy, facing the red squad)
 * and fires at will; the red squad advances to 60 m short of that house on its own side and fires at will.
 */
function occupyControllers(input: BattleInput): Controller[] {
  const centre = (side: string): { unit: number; x: number; y: number } => {
    const f = input.forces.find((x) => x.side === side)!;
    let x = 0, y = 0;
    for (const p of f.placements) { x += p.x / f.placements.length; y += p.y / f.placements.length; }
    return { unit: -1, x, y };
  };
  const b = centre("blue"), r = centre("red");
  let best = -1, bd = Infinity;
  input.map.buildings.forEach((bl, i) => {
    if (!bl.interior || bl.storeys < 2) return;
    let cx = 0, cy = 0;
    const n = bl.footprint.length / 2;
    for (let k = 0; k < n; k++) { cx += bl.footprint[k * 2]! / n; cy += bl.footprint[k * 2 + 1]! / n; }
    const d = Math.hypot(cx - b.x, cy - b.y);
    if (d < bd) { bd = d; best = i; }
  });
  const house = input.map.buildings[best]!;
  let hx = 0, hy = 0;
  const n = house.footprint.length / 2;
  for (let k = 0; k < n; k++) { hx += house.footprint[k * 2]! / n; hy += house.footprint[k * 2 + 1]! / n; }
  const dx = r.x - hx, dy = r.y - hy, dl = Math.hypot(dx, dy) || 1;
  const top = (view: Parameters<Controller["think"]>[0], side: string) => [...view.unit.entries()].filter(([, u]) => u.side === side && u.parent === null).map(([id]) => id);
  const clamp = (v: number, m: number) => Math.min(Math.max(v, 2), m - 2);
  return [
    { side: "blue", think(view, tick) {
      if (tick !== 0) return [];
      return top(view, "blue").flatMap((id) => [
        { tick, issuer: "blue", target: id, kind: "rules" as const, fire: "free" as const },
        { tick, issuer: "blue", target: id, kind: "occupy" as const, building: house.id, facing: Math.atan2(dy, dx) },
      ]);
    } },
    { side: "red", think(view, tick) {
      if (tick !== 0) return [];
      return top(view, "red").flatMap((id) => [
        { tick, issuer: "red", target: id, kind: "rules" as const, fire: "free" as const },
        { tick, issuer: "red", target: id, kind: "move" as const, waypoints: [{ x: clamp(hx + (dx / dl) * 60, input.map.widthM), y: clamp(hy + (dy / dl) * 60, input.map.heightM), mode: "walk" }] },
      ]);
    } },
  ];
}

/**
 * M7.5e house-clear (plan m7.5e step polish): the demo squads on the village, both sides under the AI commander.
 * Blue (one squad) holds the two-storey house nearest the map's middle (the objective, 30 m ring) and starts 15 m
 * behind it; its commander sites it around the house (window places and men outside). Red (two squads under one
 * platoon, with 12 mortar bombs and 4 smoke) starts `HOUSE_CLEAR_FRONT_M` east of the house and attacks: its
 * commander orders the house cleared once it assaults. The commander commands platoons' squads, so each side's
 * squads are put under a platoon with no men of its own.
 */
const HOUSE_CLEAR_FRONT_M = 200;
function houseClearBattle(data: DataSet, seed: number, seconds: number): BattleInput {
  const input = demoBattle(data, { seed, factions: ["de", "ru"], timeLimitSeconds: seconds, mapKind: "village", unitsPerSide: 2 });
  const W = input.map.widthM, H = input.map.heightM;
  let best = -1, bd = Infinity, hx = 0, hy = 0;
  input.map.buildings.forEach((bl, i) => {
    if (!bl.interior || bl.storeys < 2) return;
    const n = bl.footprint.length / 2;
    let cx = 0, cy = 0;
    for (let k = 0; k < n; k++) { cx += bl.footprint[k * 2]! / n; cy += bl.footprint[k * 2 + 1]! / n; }
    const d = hypot2(cx - W / 2, cy - H / 2);
    if (cx + HOUSE_CLEAR_FRONT_M < W - 20 && d < bd) { bd = d; best = i; hx = cx; hy = cy; }
  });
  if (best < 0) throw new Error("house-clear: no two-storey house with an interior on this map");
  // The house's half-width along x (blue starts 15 m behind its west wall).
  const fp = input.map.buildings[best]!.footprint;
  let minX = Infinity;
  for (let k = 0; k < fp.length; k += 2) minX = Math.min(minX, fp[k]!);
  for (const f of input.forces) {
    const units = f.side === "blue" ? f.units.slice(0, 1) : f.units;
    f.units = [{ key: `${f.side}-p`, callsign: `${f.side}-p`, echelon: "platoon", leaderIndex: -1, members: [], subunits: units }];
    f.placements = [];
    units.forEach((u, ui) => {
      const men = allMembers(u);
      const x = f.side === "blue" ? minX - 15 : hx + HOUSE_CLEAR_FRONT_M;
      const y = f.side === "blue" ? hy : hy + (ui - (units.length - 1) / 2) * 70;
      men.forEach((m, mi) => {
        const p = freeSpot(input.map, input.catalog, x, y + (mi - (men.length - 1) / 2) * 6);
        f.placements.push({ personId: m.personId, x: p.x, y: p.y, heading: f.side === "blue" ? 0 : PI });
      });
    });
  }
  input.rules.objectives = [{ id: "main", nameKey: "objective.main", x: hx, y: hy, radiusM: 30, points: 100, holder: "blue" }];
  input.rules.victory = { casualtyPoints: 5, endOnDefeat: true };
  input.rules.support = [{ side: "red", he: 12, smoke: 4 }];
  return input;
}

export const SCENARIOS: Record<string, NamedScenario> = {
  "house-clear": {
    description: "M7.5e: on the village, a German squad holds a two-storey house (the objective) sited by the AI commander (some men at windows, the rest outside); two Russian squads with mortar support attack it from 200 m under the AI commander, which orders the house cleared (stack at the door, grenade in, room by room).",
    build: houseClearBattle,
    controllers: (input) => [commanderController("blue", input), commanderController("red", input)],
  },
  "village-occupy": {
    description: "M7.5d: the demo squads on the village; the German squad occupies the nearest two-storey house (Occupy: window places across both floors, facing the enemy) and fires at will; the Russian squad advances to 60 m short of it.",
    build: (data, seed, seconds) => demoBattle(data, { seed, factions: ["de", "ru"], timeLimitSeconds: seconds, mapKind: "village", frontM: 300 }),
    controllers: occupyControllers,
  },
  demo: {
    description: "A German Panzergrenadier dismount squad vs a Russian motor-rifle squad on a generated 2 x 2 km village map; both wander.",
    build: (data, seed, seconds) => demoBattle(data, { seed, factions: ["de", "ru"], timeLimitSeconds: seconds, mapKind: "village" }),
    controllers: wanderBoth,
  },
  "demo-flat": {
    description: "The same two squads on a flat, empty 400 x 300 m map.",
    build: (data, seed, seconds) => demoBattle(data, { seed, factions: ["de", "ru"], timeLimitSeconds: seconds }),
    controllers: wanderBoth,
  },
  shootout: {
    description: "M2 demonstration, firing-range style: the two squads 250 m apart on an open flat field under a fixed script (prone, fire, one grenade each, cease fire after 150 s).",
    build: (data, seed, seconds) => demoBattle(data, { seed, factions: ["de", "ru"], timeLimitSeconds: seconds, mapWidthM: 800, mapHeightM: 600, frontM: 250 }),
    controllers: () => [shootoutController("blue"), shootoutController("red")],
  },
  "demo-fixture": {
    description: "Made-up fixture faction (xf) vs Germany: proves factions are pure data.",
    fixtures: true,
    build: (data, seed, seconds) =>
      demoBattle(data, { seed, factions: ["xf", "de"], templates: ["porter-band", "demo-team"], timeLimitSeconds: seconds }),
    controllers: wanderBoth,
  },
  platoon: {
    description: "M6 first playable: a generated platoon attack against a platoon holding two objectives (village; blue = Germany attacks from the west, red = Russia defends); both commanded by the AI commander.",
    build: (data, seed, seconds) => buildScenario(data, { kind: "platoon-attack", seed, mapKind: "village", factions: ["de", "ru"], attacker: "blue", timeLimitSeconds: seconds }),
    controllers: (input) => [commanderController("blue", input), commanderController("red", input)],
  },
  "platoon-ru": {
    description: "The same with the sides swapped: Russia (red, east) attacks, Germany (blue, west) defends; farmland.",
    build: (data, seed, seconds) => buildScenario(data, { kind: "platoon-attack", seed, mapKind: "farmland", factions: ["de", "ru"], attacker: "red", timeLimitSeconds: seconds }),
    controllers: (input) => [commanderController("blue", input), commanderController("red", input)],
  },
  "platoon-vehicles": {
    description: "M7.2: the platoon battle with vehicles (village; Germany attacks): the attacking platoons ride in their Pumas from the map edge and get out short of the objective; the defender's BMP-2s stand behind its position (M7.3: the vehicles fire their guns; rounds do not penetrate hulls until M7.4a).",
    build: (data, seed, seconds) => buildScenario(data, { kind: "platoon-attack", seed, mapKind: "village", factions: ["de", "ru"], attacker: "blue", timeLimitSeconds: seconds, vehicles: true }),
    controllers: (input) => [commanderController("blue", input), commanderController("red", input)],
  },
  "platoon-ru-vehicles": {
    description: "M7.2: the same with the sides swapped on farmland: Russia attacks mounted in BMP-2s, Germany defends with its Pumas behind its position.",
    build: (data, seed, seconds) => buildScenario(data, { kind: "platoon-attack", seed, mapKind: "farmland", factions: ["de", "ru"], attacker: "red", timeLimitSeconds: seconds, vehicles: true }),
    controllers: (input) => [commanderController("blue", input), commanderController("red", input)],
  },
  vehicles: {
    description: "M7.1c: a platoon of two Pumas with their squads on foot against two BMP-2s with theirs, on a generated 1200 x 900 m farmland map; vehicles and squads wander (M7.3: crews fire on their own when fired upon).",
    build: (data, seed, seconds) => vehicleBattle(data, { seed, factions: ["de", "ru"], mapKind: "farmland", timeLimitSeconds: seconds }),
    controllers: vehicleWanderBoth,
  },
  "vehicles-fixture": {
    description: "M7.1c: the fixture faction's wheeled cart (xf) against Pumas on a flat 800 x 600 m field; proves vehicles are pure data (wheeled class, two-man crew).",
    fixtures: true,
    build: (data, seed, seconds) => vehicleBattle(data, { seed, factions: ["xf", "de"], squadTemplates: ["porter-band", "pzgren-schuetzentrupp"], mapWidthM: 800, mapHeightM: 600, timeLimitSeconds: seconds }),
    controllers: vehicleWanderBoth,
  },
  "bench-combined": {
    description: "Benchmark (M7.3, plan C32): bench-vehicles (30 IFVs and about 270 men moving) with everyone free to fire; the perf test adds a load of 20,000 live projectiles.",
    build: (data, seed, seconds) => vehicleBattle(data, { seed, factions: ["de", "ru"], platoonsPerSide: 5, vehiclesPerPlatoon: 3, mapKind: "farmland", mapWidthM: 2000, mapHeightM: 2000, timeLimitSeconds: seconds }),
    controllers: (input) => [
      freeFire(vehicleWanderController("blue", input.seed * 2 + 1, input.map, 60)),
      freeFire(vehicleWanderController("red", input.seed * 2 + 2, input.map, 60)),
    ],
  },
  "bench-vehicles": {
    description: "Benchmark (M7.1c): 15 IFVs per side (30), each with its squad on foot (about 300 men in all), on a generated 2 x 2 km farmland map, all moving.",
    build: (data, seed, seconds) => vehicleBattle(data, { seed, factions: ["de", "ru"], platoonsPerSide: 5, vehiclesPerPlatoon: 3, mapKind: "farmland", mapWidthM: 2000, mapHeightM: 2000, timeLimitSeconds: seconds }),
    controllers: (input) => [
      vehicleWanderController("blue", input.seed * 2 + 1, input.map, 60),
      vehicleWanderController("red", input.seed * 2 + 2, input.map, 60),
    ],
  },
  bench: {
    description: "Benchmark: 38 four-man teams per side (304 soldiers; the old placeholder team, kept so the benchmark stays comparable) on a generated 2 x 2 km farmland map, all moving.",
    build: (data, seed, seconds) =>
      demoBattle(data, { seed, factions: ["de", "ru"], templates: ["demo-team", "demo-team"], unitsPerSide: 38, mapKind: "farmland", timeLimitSeconds: seconds }),
    controllers: (input) => [
      // Every unit gets a new long-distance move order every 60 s (heavier than real play; see DECISIONS.md).
      wanderController("blue", input.seed * 2 + 1, input.map, 60),
      wanderController("red", input.seed * 2 + 2, input.map, 60),
    ],
  },
};

/** A controller that first sets every platoon of its side to fire at will (benchmarks), then does what `c` does. */
function freeFire(c: Controller): Controller {
  return {
    side: c.side,
    think(view, tick) {
      const out = c.think(view, tick);
      if (tick === 0) for (const [id, u] of view.unit.entries()) if (u.side === c.side && u.parent === null) out.push({ tick, issuer: c.side, target: id, kind: "rules", fire: "free" });
      return out;
    },
  };
}

export function getScenario(name: string): NamedScenario {
  const s = SCENARIOS[name];
  if (!s) throw new Error(`unknown scenario '${name}'. Known: ${Object.keys(SCENARIOS).join(", ")}`);
  return s;
}
