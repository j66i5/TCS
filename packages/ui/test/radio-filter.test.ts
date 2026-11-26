/** Review 2026-11-24 step 5, item 6: "enemy drone overhead" once per unit and sighting in the radio log. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DRONE_QUIET_S, DRONE_SIDE_GAP_S, RadioFilter } from "../src/radio-filter";

const KEY = "radio.droneOverhead";
const s = (x: number) => Math.round(x * 60);

describe("the radio log's drone filter", () => {
  it("a unit that keeps reporting every 8 s is shown once; after a quiet minute it is a new sighting", () => {
    const f = new RadioFilter();
    const shown: number[] = [];
    for (let t = 0; t <= 200; t += 8) if (f.accept(KEY, 7, s(t))) shown.push(t);
    expect(shown).toEqual([0]);
    // quiet for longer than DRONE_QUIET_S after the last report (t = 200)
    expect(f.accept(KEY, 7, s(200 + DRONE_QUIET_S + 1))).toBe(true);
    expect(f.accept(KEY, 7, s(200 + DRONE_QUIET_S + 9))).toBe(false);
  });
  it("a gap just under the quiet time keeps the sighting open", () => {
    const f = new RadioFilter();
    expect(f.accept(KEY, 7, 0)).toBe(true);
    expect(f.accept(KEY, 7, s(DRONE_QUIET_S))).toBe(false);
    expect(f.accept(KEY, 7, s(2 * DRONE_QUIET_S))).toBe(false);
  });
  it("several units under the same drone: one line per side gap, each unit once", () => {
    const f = new RadioFilter();
    const shown: [number, number][] = [];
    for (let t = 0; t <= 120; t += 4) for (const u of [1, 2, 3]) if (f.accept(KEY, u, s(t) + u)) shown.push([t, u]);
    expect(shown.map((x) => x[1]).sort()).toEqual([1, 2, 3]);
    for (let k = 1; k < shown.length; k++) expect(shown[k]![0] - shown[k - 1]![0]).toBeGreaterThanOrEqual(DRONE_SIDE_GAP_S - 1);
  });
  it("every other radio line passes, however often", () => {
    const f = new RadioFilter();
    for (let t = 0; t < 50; t++) expect(f.accept("radio.contact", 1, t)).toBe(true);
    for (let t = 0; t < 50; t++) expect(f.accept("radio.wilco", 1, t)).toBe(true);
  });
  it("the drone bench battle's 10 minutes: a handful of lines instead of hundreds", () => {
    const fix = JSON.parse(readFileSync(new URL("./fixtures/drone-calls.json", import.meta.url), "utf8")) as { calls: Record<string, [number, number][]> };
    let all = 0;
    for (const [side, calls] of Object.entries(fix.calls)) {
      const f = new RadioFilter();
      const shown = calls.filter(([tick, unit]) => f.accept(KEY, unit, tick));
      all += calls.length;
      const units = new Set(calls.map((c) => c[1])).size;
      expect(calls.length, side).toBeGreaterThan(500);
      expect(shown.length, side).toBeGreaterThanOrEqual(units > 0 ? 1 : 0);
      // (At most a few sightings per top unit over the ten minutes.)
      expect(shown.length, side).toBeLessThanOrEqual(units * 4);
      expect(shown.length, side).toBeLessThanOrEqual(30);
    }
    expect(all).toBe(1592);
  });
});
