/** The floor switch's pure rules (M7.5d). */
import { describe, expect, it } from "vitest";
import { floorLabel, followFloor, unitFloor, type FloorFollow } from "../src/floors";

describe("floor switch", () => {
  it("labels the ground floor from the string table (Rule 12), upper floors by number", () => {
    expect([0, 1, 2].map((f) => floorLabel(f, "EG"))).toEqual(["EG", "1", "2"]);
  });

  it("a unit's floor is where most of its men indoors stand (ties: the lower); null when all are outdoors", () => {
    expect(unitFloor([-1, -1])).toBe(null);
    expect(unitFloor([1, 1, 0, -1])).toBe(1);
    expect(unitFloor([1, 0])).toBe(0);
  });

  it("follows the selected unit's floor; a pick holds until the unit changes floor", () => {
    let s: FloorFollow = { shown: 0, unit: null, unitFloor: null, manual: false };
    s = followFloor(s, 7, 1, null, 2);
    expect(s.shown).toBe(1);
    s = followFloor(s, 7, 1, 0, 2); // the player picks G
    expect(s.shown).toBe(0);
    s = followFloor(s, 7, 1, null, 2);
    expect(s.shown).toBe(0); // the pick holds
    s = followFloor(s, 7, 2, null, 2);
    expect(s.shown).toBe(2); // the unit climbed: follow it
    s = followFloor(s, 7, 2, null, 1);
    expect(s.shown).toBe(1); // clamped to the floors on offer
  });
});
