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
    for (let t = 0; t <= 120; t += 4) {
      for (const u of f.due(s(t)) as number[]) shown.push([t, u]);
      for (const u of [1, 2, 3]) if (f.accept(KEY, u, s(t) + u, u)) shown.push([t, u]);
    }
    expect(shown.map((x) => x[1]).sort()).toEqual([1, 2, 3]);
    for (let k = 1; k < shown.length; k++) expect(shown[k]![0] - shown[k - 1]![0]).toBeGreaterThanOrEqual(DRONE_SIDE_GAP_S - 1);
  });
  it("a unit's only call inside the side's gap is not lost: it is shown when the gap has passed", () => {
    const f = new RadioFilter<string>();
    expect(f.accept(KEY, 1, 0, "one")).toBe(true);
    expect(f.accept(KEY, 2, s(5), "two")).toBe(false); // (the sim calls once per new sighting: unit 2 may never call again)
    expect(f.due(s(10))).toEqual([]);
    expect(f.due(s(DRONE_SIDE_GAP_S))).toEqual(["two"]);
    expect(f.due(s(DRONE_SIDE_GAP_S + 1))).toEqual([]);
    // ... and a waiting line whose sighting closed meanwhile is dropped: a later line of the side took the gap.
    const g = new RadioFilter<string>();
    expect(g.accept(KEY, 1, 0, "one")).toBe(true);
    expect(g.accept(KEY, 2, s(19), "two")).toBe(false);
    expect(g.accept(KEY, 3, s(19.5), "three")).toBe(false);
    expect(g.due(s(20))).toEqual(["two"]);
    expect(g.due(s(40))).toEqual(["three"]); // 20.5 s after its call: its sighting is still open
    const h = new RadioFilter<string>();
    h.accept(KEY, 1, 0, "one"); h.accept(KEY, 2, s(1), "two"); h.accept(KEY, 3, s(2), "three"); h.accept(KEY, 4, s(3), "four"); h.accept(KEY, 5, s(4), "five");
    expect(h.due(s(20))).toEqual(["two"]);
    expect(h.due(s(40))).toEqual(["three"]);
    expect(h.due(s(60))).toEqual(["four"]);
    expect(h.due(s(80))).toEqual([]); // unit 5 called 76 s ago and never again: its sighting is over
  });
  it("a drone that comes back after the quiet time is a new sighting", () => {
    const f = new RadioFilter();
    expect(f.accept(KEY, 7, 0)).toBe(true);
    expect(f.accept(KEY, 7, s(DRONE_QUIET_S + 1))).toBe(true);
    expect(f.accept(KEY, 7, s(2 * DRONE_QUIET_S + 2))).toBe(true);
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
      const shown: [number, number][] = [];
      for (const c of calls) { for (const d of f.due(c[0]) as [number, number][]) shown.push(d); if (f.accept(KEY, c[1], c[0], c)) shown.push(c); }
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
