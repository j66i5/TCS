/** Named scenarios for the headless tools, tests and benchmarks. */
import { type DataSet, formatErrors, loadDataSet } from "@tcs/data";
import { buildScenario, demoBattle } from "@tcs/scenario";
import { shootoutController, wanderController } from "@tcs/ai";
import type { BattleInput, Controller } from "@tcs/sim";
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

const wanderBoth = (input: BattleInput): Controller[] => [
  wanderController("blue", input.seed * 2 + 1, input.map),
  wanderController("red", input.seed * 2 + 2, input.map),
];

export const SCENARIOS: Record<string, NamedScenario> = {
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
    description: "M6 first playable: a generated platoon attack against a platoon holding two objectives (village; blue = Germany attacks from the west, red = Russia defends). No commanders yet: both sides only hold.",
    build: (data, seed, seconds) => buildScenario(data, { kind: "platoon-attack", seed, mapKind: "village", factions: ["de", "ru"], attacker: "blue", timeLimitSeconds: seconds }),
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

export function getScenario(name: string): NamedScenario {
  const s = SCENARIOS[name];
  if (!s) throw new Error(`unknown scenario '${name}'. Known: ${Object.keys(SCENARIOS).join(", ")}`);
  return s;
}
