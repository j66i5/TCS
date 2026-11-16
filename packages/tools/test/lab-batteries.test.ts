/** M11.6 stage 5: the batteries and water lab (compressed night) and the review's supply tally (sim/src/review.ts). */
import { describe, expect, it } from "vitest";
import { createSim, newReviewTally, step, tallyReview, TICK_HZ, type ReviewTally } from "@tcs/sim";
import { batteriesBattle, batteriesLab } from "../src/labs/batteries";
import { loadData } from "../src/scenarios";

const data = loadData();

describe("batteries and water lab (M11.6)", () => {
  // The 3 h night compressed 12x (battery hours / 12, drone draw and water loss x 12): the same swaps and sips in
  // 15 min of game time. The CLI lab runs the full 3 h.
  const r = batteriesLab(data, { seed: 1, speedup: 12 });

  it("both platoons change batteries (radios, sights), relaunch their drones and drink", () => {
    expect(r.rows.map((x) => x.faction)).toEqual(["de", "ru"]);
    for (const x of r.rows) {
      expect(x.devices.radio).toBeGreaterThan(0);
      expect(x.devices.sight).toBeGreaterThan(0);
      expect(x.swaps.radio + x.swaps.sight).toBeGreaterThan(0);
      expect(x.swaps.drone).toBeGreaterThan(0);
      expect(x.water.drunk).toBeGreaterThan(0);
      expect(x.drinkers).toBeGreaterThan(0);
    }
  });

  it("conservation: every Wh and every ml is left or used, every battery still counted", () => {
    for (const x of r.rows) {
      expect(Math.abs(x.wh.error)).toBeLessThan(1e-6);
      expect(x.wh.devices).toBeGreaterThan(0);
      expect(x.wh.drones).toBeGreaterThan(0);
      expect(x.batteries.end + x.batteries.lost).toBe(x.batteries.start);
      expect(x.water.error).toBe(0);
      expect(x.water.left + x.water.drunk).toBe(x.water.start);
    }
  });

  it("no spare radio batteries: the radios go flat, the units go off the net, and the review counts it", () => {
    const input = batteriesBattle(data, 1, 2000, 12);
    // One radio battery per radio (the one fitted, partly used): no spares.
    const radioBattery = new Set(Object.values(input.catalog.items).filter((d) => d.radio === true && d.power).map((d) => d.power!.battery));
    for (const f of input.forces) for (const u of walk(f.units)) for (const m of u.members) {
      m.load = m.load.map((s) => (radioBattery.has(s.type) ? { ...s, count: 1 } : s));
    }
    const sim = createSim(input);
    const t: ReviewTally = newReviewTally();
    const end = 2000 * TICK_HZ;
    while (sim.state.tick < end) tallyReview(t, step(sim), sim.state, input.catalog);
    for (const side of ["blue", "red"]) {
      const s = t.sides[side]?.supply;
      expect(s).toBeDefined();
      expect(s!.flat.radio).toBeGreaterThan(0);
      expect(s!.swaps.radio).toBe(0);
      expect(s!.offNetS).toBeGreaterThan(0);
    }
    expect(JSON.parse(JSON.stringify(t)) as ReviewTally).toEqual(t);
  });
});

describe("review supply tally (M11.6)", () => {
  it("counts swaps and flats by kind of device, drone relaunches and water drunk", () => {
    const input = batteriesBattle(data, 1, 60, 1);
    const sim = createSim(input);
    const ids = [...sim.state.identity.entries()];
    const blue = ids.find(([, i]) => i.side === "blue")![0], red = ids.find(([, i]) => i.side === "red")![0];
    const radio = Object.keys(input.catalog.items).find((k) => input.catalog.items[k]!.radio === true && input.catalog.items[k]!.power)!;
    const sight = Object.keys(input.catalog.items).find((k) => input.catalog.items[k]!.sensor !== undefined && input.catalog.items[k]!.power)!;
    const t = newReviewTally();
    tallyReview(t, [
      { kind: "power.swapped", tick: 1, soldier: blue, device: radio, battery: "b", whOut: 1, whIn: 30 },
      { kind: "power.swapped", tick: 1, soldier: blue, device: sight, battery: "b", whOut: 0, whIn: 4 },
      { kind: "power.flat", tick: 1, soldier: red, device: sight, side: "red" },
      { kind: "water.drunk", tick: 1, soldier: red, side: "red", item: "w", ml: 250 },
      { kind: "water.drunk", tick: 2, soldier: red, side: "red", item: "w", ml: 50 },
      { kind: "drone.launched", tick: 3, drone: 900, operator: blue, side: "blue", item: "x" },
      { kind: "drone.landed", tick: 4, drone: 900, side: "blue", by: blue },
      { kind: "drone.launched", tick: 5, drone: 901, operator: blue, side: "blue", item: "x" },
    ], sim.state, input.catalog);
    expect(t.sides["blue"]!.supply!.swaps).toEqual({ radio: 1, sight: 1, other: 0, drone: 1 });
    expect(t.sides["red"]!.supply!.flat).toEqual({ radio: 0, sight: 1, other: 0 });
    expect(t.sides["red"]!.supply!.waterMl).toBe(300);
    expect(t.sides["blue"]!.supply!.offNetS).toBe(0);
  });
});

function* walk<T extends { subunits: T[] }>(units: T[]): Generator<T> {
  for (const u of units) { yield u; yield* walk(u.subunits); }
}
