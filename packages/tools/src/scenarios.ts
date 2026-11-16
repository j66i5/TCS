/** Named scenarios for the headless tools, tests and benchmarks. */
import { type DataSet, formatErrors, loadDataSet } from "@tcs/data";
import { allMembers, buildForce, buildScenario, demoBattle, freeSpot, holdBattle, vehicleBattle, type CarrierClass } from "@tcs/scenario";
import { commanderController, shootoutController, vehicleWanderController, waveCommanders, wanderController } from "@tcs/ai";
import { healthyPhysiology, hypot2, PI, type BattleInput, type Controller, type Order, type UnitInput } from "@tcs/sim";
import { readDataFiles } from "./data-files";
import { aglSetup } from "./labs/agl";

export function loadData(includeFixtures = false): DataSet {
  const files = readDataFiles(includeFixtures ? ["core", "factions", "fixtures"] : ["core", "factions"]);
  const { data, errors } = loadDataSet(files);
  if (!data) throw new Error(`data failed to load:\n${formatErrors(errors)}`);
  return data;
}

export interface ScenarioOptions { carriers?: CarrierClass | [CarrierClass, CarrierClass] }

/** Parse a carriers argument (M7.6c): "tracked" | "wheeled", or "blue,red" (each tracked | wheeled); else null. */
export function parseCarriers(v: string | undefined): CarrierClass | [CarrierClass, CarrierClass] | null {
  if (v === undefined) return null;
  const ok = (x: string): x is CarrierClass => x === "tracked" || x === "wheeled";
  const p = v.split(",");
  if (p.length === 1 && ok(p[0]!)) return p[0];
  if (p.length === 2 && ok(p[0]!) && ok(p[1]!)) return [p[0], p[1]];
  return null;
}

export interface NamedScenario {
  description: string;
  fixtures?: boolean;
  /** `opts.carriers` (M7.6c, headless `--carriers`): the carrier class per side for the scenarios that take it. */
  build(data: DataSet, seed: number, seconds: number, opts?: ScenarioOptions): BattleInput;
  /** True when `build` uses `opts.carriers` (headless warns when `--carriers` goes to a scenario without it). */
  takesCarriers?: boolean;
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
  "hold-resupply": {
    description: "M11.1: a German platoon on foot holds the village centre against three Russian platoons coming in waves from the east at 0, 15 and 30 minutes (a sixth of the attacker's usual mortar allotment); the defenders dig in where they are sited in the first 90 s (fighting positions); a supply point of cans 150 m behind the village; 60 minutes. The battle where ammunition runs short (`--no-resupply` for comparisons).",
    build: (data, seed, seconds) => holdBattle(data, { seed, factions: ["de", "ru"], timeLimitSeconds: seconds }),
    controllers: (input) => [commanderController("blue", input), waveCommanders("red", input)],
  },
  "hold-resupply-ru": {
    description: "M11.1: hold-resupply with the sides swapped: a Russian platoon holds the village centre against three German platoons in waves from the west.",
    build: (data, seed, seconds) => holdBattle(data, { seed, factions: ["de", "ru"], defender: "red", timeLimitSeconds: seconds }),
    controllers: (input) => [waveCommanders("blue", input), commanderController("red", input)],
  },
  "platoon-ru": {
    description: "The same with the sides swapped: Russia (red, east) attacks, Germany (blue, west) defends; farmland.",
    build: (data, seed, seconds) => buildScenario(data, { kind: "platoon-attack", seed, mapKind: "farmland", factions: ["de", "ru"], attacker: "red", timeLimitSeconds: seconds }),
    controllers: (input) => [commanderController("blue", input), commanderController("red", input)],
  },
  "platoon-mortars": {
    description: "M8.3a: the platoon battle on foot (village; Germany attacks) with on-map mortars instead of the off-map allotment: a German 120 mm section (two tubes) at the attacker's map edge, a Russian 82 mm 2B14 section (two tubes) 250 m behind the defence; they set up on their own and fire the commanders' calls.",
    build: (data, seed, seconds) => buildScenario(data, { kind: "platoon-attack", seed, mapKind: "village", factions: ["de", "ru"], attacker: "blue", timeLimitSeconds: seconds, mortars: true }),
    controllers: (input) => [commanderController("blue", input), commanderController("red", input)],
  },
  "platoon-ru-mortars": {
    description: "M8.3a: the same with the sides swapped on farmland (Russia attacks), on-map mortars on both sides.",
    build: (data, seed, seconds) => buildScenario(data, { kind: "platoon-attack", seed, mapKind: "farmland", factions: ["de", "ru"], attacker: "red", timeLimitSeconds: seconds, mortars: true }),
    controllers: (input) => [commanderController("blue", input), commanderController("red", input)],
  },
  "platoon-artillery": {
    description: "M8.4/M8.5: the platoon battle on foot (village; Germany attacks) with each side's off-map 155 / 152 mm allotment as well as its mortars; the AI calls the guns beyond danger close (airburst on men in the open).",
    build: (data, seed, seconds) => buildScenario(data, { kind: "platoon-attack", seed, mapKind: "village", factions: ["de", "ru"], attacker: "blue", timeLimitSeconds: seconds, artillery: true }),
    controllers: (input) => [commanderController("blue", input), commanderController("red", input)],
  },
  "platoon-vehicles": {
    description: "M7.2: the platoon battle with vehicles (village; Germany attacks): the attacking platoons ride in their Pumas from the map edge and get out short of the objective; the defender's BMP-2s stand behind its position (M7.3: the vehicles fire their guns; rounds do not penetrate hulls until M7.4a). M9.3b: the Russian side also has its Metis-M team 300 m behind its position.",
    takesCarriers: true,
    build: (data, seed, seconds, o) => buildScenario(data, { kind: "platoon-attack", seed, mapKind: "village", factions: ["de", "ru"], attacker: "blue", timeLimitSeconds: seconds, vehicles: true, missileTeams: true, ...(o?.carriers ? { carriers: o.carriers } : {}) }),
    controllers: (input) => [commanderController("blue", input), commanderController("red", input)],
  },
  "platoon-ru-vehicles": {
    description: "M7.2: the same with the sides swapped on farmland: Russia attacks mounted in BMP-2s, Germany defends with its Pumas behind its position. M9.3b: the Russian side's Metis-M team starts 150 m behind its start on a flank and takes up an overwatch post.",
    takesCarriers: true,
    build: (data, seed, seconds, o) => buildScenario(data, { kind: "platoon-attack", seed, mapKind: "farmland", factions: ["de", "ru"], attacker: "red", timeLimitSeconds: seconds, vehicles: true, missileTeams: true, ...(o?.carriers ? { carriers: o.carriers } : {}) }),
    controllers: (input) => [commanderController("blue", input), commanderController("red", input)],
  },
  "platoon-vehicles-wheeled": {
    description: "M7.6c: the mounted platoon battle in wheeled carriers (village; Germany attacks): a Jaegerzug in four GTK Boxers (12.7 mm on the FLW 200) against a motor-rifle platoon in three BTR-82A (2A72 30 mm) with its Metis-M team.",
    takesCarriers: true,
    build: (data, seed, seconds, o) => buildScenario(data, { kind: "platoon-attack", seed, mapKind: "village", factions: ["de", "ru"], attacker: "blue", timeLimitSeconds: seconds, vehicles: true, missileTeams: true, carriers: o?.carriers ?? "wheeled" }),
    controllers: (input) => [commanderController("blue", input), commanderController("red", input)],
  },
  "platoon-ru-vehicles-wheeled": {
    description: "M7.6c: the same with the sides swapped on farmland: Russia attacks mounted in BTR-82A, the Jaegerzug defends with its GTK Boxers behind its position.",
    takesCarriers: true,
    build: (data, seed, seconds, o) => buildScenario(data, { kind: "platoon-attack", seed, mapKind: "farmland", factions: ["de", "ru"], attacker: "red", timeLimitSeconds: seconds, vehicles: true, missileTeams: true, carriers: o?.carriers ?? "wheeled" }),
    controllers: (input) => [commanderController("blue", input), commanderController("red", input)],
  },
  "platoon-vehicles-mixed": {
    description: "M7.6c: wheeled against tracked (village; Germany attacks): the Jaegerzug in GTK Boxers against the motor-rifle platoon in BMP-2s with its Metis-M team.",
    takesCarriers: true,
    build: (data, seed, seconds, o) => buildScenario(data, { kind: "platoon-attack", seed, mapKind: "village", factions: ["de", "ru"], attacker: "blue", timeLimitSeconds: seconds, vehicles: true, missileTeams: true, carriers: o?.carriers ?? ["wheeled", "tracked"] }),
    controllers: (input) => [commanderController("blue", input), commanderController("red", input)],
  },
  "assault-group": {
    description: "M7.6d: the Russian assault group attacks on foot (village): two shturmovye gruppy (13 men each: command, two assault teams with RPG-7V and RPO-A, a fire team with PKP and SVD, a reserve with spare RPO-A) and an AGS-30 team against the German Panzergrenadierzug on foot defending (no vehicles, no missile teams).",
    build: (data, seed, seconds) => buildScenario(data, { kind: "platoon-attack", seed, mapKind: "village", factions: ["de", "ru"], attacker: "red", timeLimitSeconds: seconds, assaultGroup: "red", aglTeams: "attacker" }),
    controllers: (input) => [commanderController("blue", input), commanderController("red", input)],
  },
  "bench-agl": {
    description: "M7.6d: an AGS-30 team (west) and a German GMW team on its tripod (east) on a flat, open 1400 x 1200 m field, each 800 m from six enemy men standing in the open, 300 m apart north and south (everyone else holds fire); the teams set up and fire on their own.",
    build: (data, seed, seconds) => {
      const input = aglSetup(data, "ru", 800, seed);
      input.rules.timeLimitSeconds = seconds;
      const red = input.forces[1]!, blue = input.forces[0]!;
      const crew = new Set(red.units.flatMap((u) => [u, ...u.subunits]).filter((u) => u.vehicleId !== undefined || u.key.startsWith("ru-agl")).flatMap((u) => u.members.map((m) => m.personId)));
      let k = 0;
      for (const pl of red.placements) if (!crew.has(pl.personId) && k < 6) { pl.x = 400; pl.y = 300 + (k - 2.5) * 3; pl.heading = 0; k++; }
      const team = buildForce(data, { faction: "de", template: data.factions["de"]!.manifest.aglTeamTemplate!, seed: seed * 7 + 2, keyPrefix: "de-agl", number: 1 });
      blue.units.push(team);
      allMembers(team).forEach((m, i) => blue.placements.push({ personId: m.personId, x: 1200, y: 300 + (i === 0 ? 0 : i % 2 === 1 ? 3 : -3) * Math.ceil(i / 2), heading: PI }));
      return input;
    },
    controllers: () => [holdFire("blue"), holdFire("red")],
  },
  "platoon-vehicles-tanks": {
    description: "M7.6b: platoon-vehicles (village; Germany attacks mounted in Pumas, the BMP-2s and a Metis-M team defend) with two Leopard 2A7V (Panzer-Halbzug) on the attacker's side: they start in dead ground behind the Pumas, take hull-down posts in overwatch and bound with the attack.",
    takesCarriers: true,
    build: (data, seed, seconds, o) => buildScenario(data, { kind: "platoon-attack", seed, mapKind: "village", factions: ["de", "ru"], attacker: "blue", timeLimitSeconds: seconds, vehicles: true, missileTeams: true, tanks: "attacker", ...(o?.carriers ? { carriers: o.carriers } : {}) }),
    controllers: (input) => [commanderController("blue", input), commanderController("red", input)],
  },
  "platoon-ru-vehicles-tanks": {
    description: "M7.6b: platoon-ru-vehicles (farmland; Russia attacks mounted in BMP-2s, the Pumas defend) with two T-72B3M on the attacker's side in overwatch.",
    takesCarriers: true,
    build: (data, seed, seconds, o) => buildScenario(data, { kind: "platoon-attack", seed, mapKind: "farmland", factions: ["de", "ru"], attacker: "red", timeLimitSeconds: seconds, vehicles: true, missileTeams: true, tanks: "attacker", ...(o?.carriers ? { carriers: o.carriers } : {}) }),
    controllers: (input) => [commanderController("blue", input), commanderController("red", input)],
  },
  "platoon-vehicles-tanks-both": {
    description: "M7.6b: platoon-vehicles-tanks with tanks on both sides: two Leopard 2A7V with the attack, two T-72B3M behind the defence (tank against tank).",
    takesCarriers: true,
    build: (data, seed, seconds, o) => buildScenario(data, { kind: "platoon-attack", seed, mapKind: "village", factions: ["de", "ru"], attacker: "blue", timeLimitSeconds: seconds, vehicles: true, missileTeams: true, tanks: true, ...(o?.carriers ? { carriers: o.carriers } : {}) }),
    controllers: (input) => [commanderController("blue", input), commanderController("red", input)],
  },
  "bench-tanks": {
    description: "Benchmark (M7.6b): bench-vehicles with tank crews: 15 Leopard 2A7V against 15 T-90M (5 platoons of 3 per side), their squads walking, on a 2 x 2 km farmland map, all moving (return fire).",
    build: (data, seed, seconds) => vehicleBattle(data, { seed, factions: ["de", "ru"], platoonsPerSide: 5, vehiclesPerPlatoon: 3, mapKind: "farmland", mapWidthM: 2000, mapHeightM: 2000, timeLimitSeconds: seconds, crewTemplates: ["leopard2a7v-besatzung", "t90m-ekipazh"] }),
    controllers: (input) => [vehicleWanderController("blue", input.seed * 2 + 1, input.map, 60), vehicleWanderController("red", input.seed * 2 + 2, input.map, 60)],
  },
  vehicles: {
    description: "M7.1c: a platoon of two Pumas with their squads on foot against two BMP-2s with theirs, on a generated 1200 x 900 m farmland map; vehicles and squads wander (M7.3: crews fire on their own when fired upon).",
    takesCarriers: true,
    build: (data, seed, seconds, o) => vehicleBattle(data, { seed, factions: ["de", "ru"], mapKind: "farmland", timeLimitSeconds: seconds, ...(o?.carriers ? { carriers: o.carriers } : {}) }),
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
  "bench-missile-team": {
    description: "M9.3b: four Russian Metis-M teams at the east edge of a flat, open 1600 x 900 m field against two German platoons of Pumas (four, each with its squad on foot) wandering across the middle; the teams set up and fire on their own (the BMP-2 platoons stand still, holding fire).",
    build: (data, seed, seconds) => {
      const input = vehicleBattle(data, { seed, factions: ["de", "ru"], platoonsPerSide: 2, vehiclesPerPlatoon: 2, mapWidthM: 1600, mapHeightM: 900, timeLimitSeconds: seconds });
      const red = input.forces.find((f) => f.side === "red")!;
      const tpl = data.factions["ru"]!.manifest.missileTeamTemplate!;
      for (let k = 0; k < 4; k++) {
        const team = buildForce(data, { faction: "ru", template: tpl, seed: seed * 43 + k, keyPrefix: `red-a${k + 1}`, number: k + 1 });
        red.units.push(team);
        allMembers(team).forEach((m, mi) => {
          const p = freeSpot(input.map, input.catalog, 1600 * 0.93 + (mi % 2) * 4, 900 * (k + 1) / 5 + mi * 3);
          red.placements.push({ personId: m.personId, x: p.x, y: p.y, heading: PI });
        });
      }
      return input;
    },
    controllers: (input) => [vehicleWanderController("blue", input.seed * 2 + 1, input.map, 60), holdFire("red")],
  },
  "bench-medical": {
    description: "Benchmark (M10.4b): bench-vehicles (30 IFVs, about 270 men) with every third man of each squad down from the start (a bleeding thigh wound, unconscious): the squads get in at once, carrying their wounded to the vehicles (care, carrying parties, loading); from 45 s the vehicles wander, with whoever is aboard.",
    build: (data, seed, seconds) => woundEveryThird(vehicleBattle(data, { seed, factions: ["de", "ru"], platoonsPerSide: 5, vehiclesPerPlatoon: 3, mapKind: "farmland", mapWidthM: 2000, mapHeightM: 2000, timeLimitSeconds: seconds })),
    controllers: (input) => [
      mountFirst(vehicleWanderController("blue", input.seed * 2 + 1, input.map, 45), 45),
      mountFirst(vehicleWanderController("red", input.seed * 2 + 2, input.map, 45), 45),
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
  "bench-drones": {
    description: "Benchmark (M9.4a): the bench battle (304 men moving) with a quadcopter at every fifth team (8 per side, 16 in the air), each sent to a new point every 90 s.",
    build: (data, seed, seconds) => {
      const input = demoBattle(data, { seed, factions: ["de", "ru"], templates: ["demo-team", "demo-team"], unitsPerSide: 38, mapKind: "farmland", timeLimitSeconds: seconds });
      for (const f of input.forces) {
        const pre = f.faction === "de" ? "de" : "ru";
        f.units.forEach((u, k) => {
          const cap = input.catalog.items[`${pre}-drone-battery`]?.chargeCapacity;
          if (k % 5 !== 0 || cap === undefined || !u.members[0]) return;
          u.members[0].load.push({ type: `${pre}-quadcopter`, count: 1 }, { type: `${pre}-drone-battery`, count: 2, charge: cap });
        });
      }
      return input;
    },
    controllers: (input) => [
      both(wanderController("blue", input.seed * 2 + 1, input.map, 60), droneWander("blue", input.seed * 2 + 11, input.map, 90)),
      both(wanderController("red", input.seed * 2 + 2, input.map, 60), droneWander("red", input.seed * 2 + 12, input.map, 90)),
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

/** A controller that only sets every unit of its side but the missile teams to hold fire (M9.3b bench). */
function holdFire(side: "blue" | "red"): Controller {
  return {
    side,
    think(view, tick) {
      const out: ReturnType<Controller["think"]> = [];
      if (tick === 0) for (const [id, u] of view.unit.entries()) if (u.side === side && u.parent === null && u.missileTeam === undefined) out.push({ tick, issuer: side, target: id, kind: "rules", fire: "hold" });
      return out;
    },
  };
}

/** Two controllers of one side as one (their orders together; the first one's state saved). */
function both(a: Controller, b: Controller): Controller {
  return { side: a.side, think: (view, tick) => [...a.think(view, tick), ...b.think(view, tick)] };
}

/** Benchmarks (M9.4a): every `intervalSeconds`, each top unit of the side whose men carry a quadcopter (or have it
 *  up) sends it to a random point in the middle of the map. */
function droneWander(side: string, seed: number, map: { widthM: number; heightM: number }, intervalSeconds: number): Controller {
  let r = (seed * 2654435761) >>> 0;
  const rand = () => { r = (Math.imul(r, 1664525) + 1013904223) >>> 0; return r / 4294967296; };
  const every = Math.round(intervalSeconds * 60);
  return {
    side,
    think(view, tick) {
      if (tick % every !== 0) return [];
      const out: Order[] = [];
      for (const [id, u] of view.unit.entries()) {
        if (u.side !== side || u.parent !== null) continue;
        const has = [...view.drone.values()].some((d) => d.unit === id) || u.members.some((m) => view.container.get(m)?.stacks.some((st) => st.type.endsWith("-quadcopter") && st.count > 0));
        if (has) out.push({ tick, issuer: side, target: id, kind: "drone", op: "fly", x: map.widthM * (0.3 + 0.4 * rand()), y: map.heightM * (0.2 + 0.6 * rand()) });
      }
      return out;
    },
  };
}

/** Every third man of each unit on foot starts down: unconscious with a bleeding thigh wound (bench-medical). */
function woundEveryThird(input: BattleInput): BattleInput {
  const walk = (u: UnitInput): void => {
    if (u.vehicleId === undefined) u.members.forEach((m, i) => {
      if (i % 3 !== 2) return;
      m.wounds = [{ id: 1, zone: "legL", mechanism: "bullet", severity: 0.45, bleedingLps: 0.004, compressible: true, airway: false, breathing: false, consciousness: false, tickInflicted: 0, treatments: [] }];
      m.status = "incapacitated";
      m.physiology = { ...healthyPhysiology(), consciousness: 0.2, shock: 0.2, bloodVolumeL: 4.4 };
    });
    u.subunits.forEach(walk);
  };
  for (const f of input.forces) f.units.forEach(walk);
  return input;
}

/** At tick 0 every unit of its side with a carrier gets in; after `holdS` seconds `c` moves the vehicles (bench-medical). */
function mountFirst(c: Controller, holdS: number): Controller {
  return {
    side: c.side,
    think(view, tick) {
      if (tick === 0) {
        const out = [];
        for (const [id, u] of view.unit.entries()) if (u.side === c.side && u.carrier !== undefined) out.push({ tick, issuer: c.side, target: id, kind: "mount" as const });
        return out;
      }
      // Then only the vehicles move (the squads stay with them, aboard or not).
      return tick < holdS * 60 ? [] : c.think(view, tick).filter((o) => view.unit.get(o.target)?.vehicle !== undefined);
    },
    ...(c.saveState ? { saveState: c.saveState } : {}),
    ...(c.loadState ? { loadState: c.loadState } : {}),
  };
}

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
