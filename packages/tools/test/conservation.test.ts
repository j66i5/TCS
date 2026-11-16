/**
 * M11.1 conservation guard: in every headless scenario (1 seed x 120 s), for every ammunition id, what the battle
 * started with minus what it ended with equals what the events say was fired, thrown, destroyed and delivered.
 * The benchmarks are in conservation-bench.test.ts (split for file parallelism); `npm run lab -- consumption
 * --conservation` runs 6 seeds x 300 s and hold-resupply 2 x 1200 s.
 */
import { describe, expect, it } from "vitest";
import { conservationRun } from "../src/conservation";
import { loadData, SCENARIOS } from "../src/scenarios";

const BENCH = (n: string) => n.startsWith("bench");

describe("conservation guard (M11.1)", () => {
  const data = loadData(), fixtures = loadData(true);
  for (const name of Object.keys(SCENARIOS).filter((n) => !BENCH(n))) {
    it(`${name}: exact over 120 s`, () => {
      const r = conservationRun(SCENARIOS[name]!.fixtures ? fixtures : data, name, 1, 120);
      expect(r.leaks).toEqual({});
    }, 120_000);
  }
});
