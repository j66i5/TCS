/** Re-acquire lab (sight realism, 2026-11-15): its options and the consistency of what it counts. */
import { describe, expect, it } from "vitest";
import { NOT_ENGAGED_CAUSES, notEngagedS, reacquireBattle, reacquireOptions } from "../src/labs/reacquire";

describe("re-acquire lab", () => {
  it("reads its options", () => {
    expect(reacquireOptions([])).toEqual({ scenarios: ["platoon", "platoon-ru", "village-occupy"], seeds: [1, 2, 3] });
    expect(reacquireOptions(["2"]).seeds).toEqual([1, 2]);
    expect(reacquireOptions(["--seeds", "2-4", "--scenarios", "platoon", "--seconds", "300"])).toEqual({ scenarios: ["platoon"], seeds: [2, 3, 4], seconds: 300 });
    expect(reacquireOptions(["--seeds", "1,5"]).seeds).toEqual([1, 5]);
  });

  it("counts consistently over a short battle", () => {
    const b = reacquireBattle("village-occupy", 1, 150);
    for (const s of [b.attack, b.defence]) {
      expect(s.manS).toBeGreaterThan(0);
      expect(s.blindIdleS).toBeLessThanOrEqual(s.blindS);
      expect(s.blindS + s.sightedS).toBeLessThanOrEqual(s.manS);
      expect(s.blindIdleIndoor).toBeLessThanOrEqual(s.blindIdleS);
      expect(s.indoorOtherWindow).toBeLessThanOrEqual(s.blindIdleIndoor);
      expect(Object.values(s.peek).reduce((a, v) => a + v, 0)).toBe(s.blindIdleS);
      expect(notEngagedS(s)).toBeLessThanOrEqual(s.exposureS);
      expect(Object.keys(s.notEngaged).sort()).toEqual([...NOT_ENGAGED_CAUSES].sort());
      expect(s.squadBlindS).toBeLessThanOrEqual(s.squadS);
    }
  });
});
