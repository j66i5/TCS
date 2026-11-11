/** Named scenarios for the headless tools, tests and benchmarks. */
import { type DataSet, formatErrors, loadDataSet } from "@tcs/data";
import { demoBattle } from "@tcs/scenario";
import { wanderController } from "@tcs/ai";
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
    description: "One German team vs one Russian team on a flat 400 x 300 m map; both wander (no combat yet).",
    build: (data, seed, seconds) => demoBattle(data, { seed, factions: ["de", "ru"], timeLimitSeconds: seconds }),
    controllers: wanderBoth,
  },
  "demo-fixture": {
    description: "Made-up fixture faction (xf) vs Germany: proves factions are pure data.",
    fixtures: true,
    build: (data, seed, seconds) =>
      demoBattle(data, { seed, factions: ["xf", "de"], templates: ["porter-band", "demo-team"], timeLimitSeconds: seconds }),
    controllers: wanderBoth,
  },
  bench: {
    description: "Benchmark: 38 teams per side (304 soldiers) on a 2 x 2 km map, all moving.",
    build: (data, seed, seconds) =>
      demoBattle(data, { seed, factions: ["de", "ru"], unitsPerSide: 38, mapWidthM: 2000, mapHeightM: 2000, timeLimitSeconds: seconds }),
    controllers: (input) => [
      wanderController("blue", input.seed * 2 + 1, input.map, 20),
      wanderController("red", input.seed * 2 + 2, input.map, 20),
    ],
  },
};

export function getScenario(name: string): NamedScenario {
  const s = SCENARIOS[name];
  if (!s) throw new Error(`unknown scenario '${name}'. Known: ${Object.keys(SCENARIOS).join(", ")}`);
  return s;
}
