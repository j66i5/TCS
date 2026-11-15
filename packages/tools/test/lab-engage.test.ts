/** Engage lab (sight realism, 2026-11-15): a rifleman and one enemy still in the open in front of him. */
import { describe, expect, it } from "vitest";
import { buildCatalog } from "@tcs/data";
import { engageRun } from "../src/labs/engage";
import { loadData } from "../src/scenarios";

const cat = buildCatalog(loadData(), ["de", "ru"]);

describe("engage lab", () => {
  it("rule hold: he never fires, though he sees the enemy", () => {
    for (const seed of [1, 2, 3]) expect(engageRun(cat, "rule hold", 30, "standing", seed, 20)).toBe(-1);
  });
  it("rule free, halted: an enemy standing in the open at 30 m draws fire within 10 s", () => {
    for (const seed of [1, 2, 3]) {
      const t = engageRun(cat, "rule free", 30, "standing", seed, 20);
      expect(t).toBeGreaterThanOrEqual(0);
      expect(t).toBeLessThanOrEqual(10);
    }
  });
});
