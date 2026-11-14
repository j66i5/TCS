/** Fog of war (owner, 2026-11-14): which enemy men are drawn as figures — only those in sight now. */
import { describe, expect, it } from "vitest";
import { enemyMenInSight, inSightNow, IN_SIGHT_S } from "../src/fog";

describe("enemy men in sight", () => {
  it("draws only men seen within the last moments; heard, reported, older sightings and vehicles stay symbols", () => {
    const known = [
      { target: 5, kind: "seen" as const, ageS: 0 },
      { target: 6, kind: "seen" as const, ageS: IN_SIGHT_S - 0.1 },
      { target: 7, kind: "seen" as const, ageS: IN_SIGHT_S },
      { target: 8, kind: "heard" as const, ageS: 0 },
      { target: 9, kind: "reported" as const, ageS: 0 },
      { target: 10, kind: "seen" as const, ageS: 0, cls: "vehicle" as const },
      { target: 11, kind: "seen" as const, ageS: 30 },
    ];
    expect([...enemyMenInSight(known)].sort((a, b) => a - b)).toEqual([5, 6]);
    // The same test the solid diamond / solid hull uses.
    expect(known.filter(inSightNow).map((k) => k.target)).toEqual([5, 6, 10]);
  });

  it("knows nothing without knowledge (Debug / reveal: everyone is drawn anyway)", () => {
    expect(enemyMenInSight(null).size).toBe(0);
    expect(enemyMenInSight(undefined).size).toBe(0);
    expect(enemyMenInSight([]).size).toBe(0);
  });
});
