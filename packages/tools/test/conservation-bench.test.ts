/** M11.1 conservation guard over the benchmark scenarios (1 seed x 120 s); see conservation.test.ts. */
import { describe, expect, it } from "vitest";
import { conservationRun } from "../src/conservation";
import { loadData, SCENARIOS } from "../src/scenarios";

describe("conservation guard, benchmarks (M11.1)", () => {
  const data = loadData(), fixtures = loadData(true);
  for (const name of Object.keys(SCENARIOS).filter((n) => n.startsWith("bench"))) {
    it(`${name}: exact over 120 s`, () => {
      const r = conservationRun(SCENARIOS[name]!.fixtures ? fixtures : data, name, 1, 120);
      expect(r.leaks).toEqual({});
      expect(r.chargeLeaks).toEqual({});
    }, 300_000);
  }
});
