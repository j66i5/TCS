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
  // Sight realism step 2 (behaviour gates): close in front of him, he fires without waiting to be fired on.
  it("rule return, not fired on: an enemy standing in the open at 60 m draws fire within 10 s; at 150 m (beyond returnCloseM) none", () => {
    for (const seed of [1, 2, 3]) {
      const t = engageRun(cat, "rule return", 60, "standing", seed, 20);
      expect(t).toBeGreaterThanOrEqual(0);
      expect(t).toBeLessThanOrEqual(10);
      expect(engageRun(cat, "rule return", 150, "standing", seed, 20)).toBe(-1);
    }
  });
  it("walking toward him: the man goes to ground on sight and fires within 10 s at 60 m", () => {
    for (const seed of [1, 2, 3]) {
      const t = engageRun(cat, "walking toward (free)", 60, "standing", seed, 20);
      expect(t).toBeGreaterThanOrEqual(0);
      expect(t).toBeLessThanOrEqual(10);
    }
  });
  it("pinned: fires back at an enemy at 30 m within 15 s, not at one at 100 m (beyond pinnedSelfDefenceM)", () => {
    for (const seed of [1, 2]) {
      const t = engageRun(cat, "pinned (free)", 30, "standing", seed, 20);
      expect(t).toBeGreaterThanOrEqual(0);
      expect(t).toBeLessThanOrEqual(15);
      expect(engageRun(cat, "pinned (free)", 100, "standing", seed, 20)).toBeLessThan(0);
    }
  });
});
