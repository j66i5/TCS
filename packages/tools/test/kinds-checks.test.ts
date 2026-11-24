/**
 * Review 2026-11-24 problem 2 (part 2): the kinds lab's fail flags and the pursuit in the withdrawal battle.
 * - `kindFlags` (pure): a side under fire (enemy direct rounds, or a man hit) that fired back too little; a quiet
 *   stretch with both sides on the map. Off-map and mortar rounds never count as fighting (`runKind`).
 * - The withdrawal on foot, AI against AI: the follower closes and both sides fire (the delaying side holds until it
 *   has fought; the follower takes up the pursuit at once).
 * The full matrix is `npm run lab -- kinds 2 --seconds 900 [--strict]` (DECISIONS "Review 2026-11-24 problem 2").
 */
import { describe, expect, it } from "vitest";
import { KIND_CHECKS, kindFails, kindFlags, kindScenario, runKind } from "../src/labs/kinds";
import { loadData } from "../src/scenarios";

const data = loadData(true);

describe("kinds lab fail flags", () => {
  const row = (direct: [number, number], hit: [number, number], quietS: number) => ({ direct, firstInS: [-1, -1] as [number, number], hit, quietS });

  it("a side under fire that fires back too little is flagged, by rounds in or by men hit", () => {
    // Red fired 941 rounds, blue none: blue never fired back.
    expect(kindFlags(row([0, 941], [17, 0], 100)).noReturn).toEqual([true, false]);
    // Enough fired back: no flag.
    expect(kindFlags(row([57, 981], [13, 6], 100)).noReturn).toEqual([false, false]);
    // Below the incoming threshold and nobody hit: not under fire.
    expect(kindFlags(row([0, KIND_CHECKS.minIncoming - 1], [0, 0], 100)).noReturn).toEqual([false, false]);
    // A man hit by indirect fire (no direct rounds in) puts the side under fire too.
    expect(kindFlags(row([0, 0], [1, 0], 100)).noReturn).toEqual([true, false]);
    // The thresholds are options.
    expect(kindFlags(row([5, 30], [0, 0], 100), { ...KIND_CHECKS, minReturn: 5 }).noReturn).toEqual([false, false]);
  });

  it("a quiet stretch of the option's length fails the battle; the words name every flag", () => {
    expect(kindFlags(row([500, 500], [3, 3], KIND_CHECKS.quietS)).quiet).toBe(true);
    expect(kindFlags(row([500, 500], [3, 3], KIND_CHECKS.quietS - 1)).quiet).toBe(false);
    expect(kindFlags(row([500, 500], [3, 3], 200), { ...KIND_CHECKS, quietS: 120 }).quiet).toBe(true);
    expect(kindFails({ noReturn: [true, false], quiet: true })).toEqual(["blue no return fire", "quiet"]);
    expect(kindFails({ noReturn: [false, false], quiet: false })).toEqual([]);
  });
});

describe("withdrawal on foot: the pursuit makes contact", () => {
  it("on every map kind the sides close and fire at each other (at least 3 of 4)", () => {
    let ok = 0;
    for (const map of ["village", "farmland", "woodland", "industrial"] as const) {
      const { row } = runKind(data, kindScenario("withdrawal", map, 1, 900), false);
      if (row.closestM >= 0 && row.closestM < 300 && row.direct[0] > 0 && row.direct[1] > 0) ok++;
    }
    expect(ok).toBeGreaterThanOrEqual(3);
  }, 600_000);
});
