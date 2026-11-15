/** Illumination flares give light (M9.6): the light at a ground point, spotting under a flare at night, save/load. */
import { describe, expect, it } from "vitest";
import { buildCatalog } from "@tcs/data";
import { demoBattle } from "@tcs/scenario";
import { createSim, environmentAt, flareLightAt, flareLitRadius, hashState, loadSim, saveSim, step, type Flare, type SimState } from "@tcs/sim";
import { spotCase } from "../src/labs/spotting";
import { loadData } from "../src/scenarios";

const data = loadData();
const cat = buildCatalog(data, ["de", "ru"]);
const N = cat.spotting.night;
const illum = cat.ammo[cat.factions["de"]!.fireSupport!.illumAmmo!]!.illum!;

function withFlares(tick: number, flares: Flare[]): SimState {
  return { tick, flares } as unknown as SimState;
}
const flare = (o: Partial<Flare> = {}): Flare => ({ x: 0, y: 0, z: 400, startTick: 0, untilTick: 600 * 60, descentMps: 0, candela: illum.candela, side: "blue", ...o });

describe("flareLightAt (M9.6)", () => {
  it("straight below, 500 m off, expired, and without flares", () => {
    const below = flareLightAt(withFlares(60, [flare()]), cat, 0, 0);
    expect(below).toBeCloseTo(Math.min(N.flareMaxLight, illum.candela / (400 * 400) / N.flareFullLux), 9);
    const far = flareLightAt(withFlares(60, [flare()]), cat, 500, 0);
    expect(far).toBeCloseTo(Math.min(N.flareMaxLight, illum.candela / (400 * 400 + 500 * 500) / N.flareFullLux), 9);
    expect(far).toBeLessThan(below);
    expect(flareLightAt(withFlares(700 * 60, [flare()]), cat, 0, 0)).toBe(0); // burnt out
    expect(flareLightAt(withFlares(60, []), cat, 0, 0)).toBe(0);
    expect(flareLightAt({ tick: 0 } as unknown as SimState, cat, 0, 0)).toBe(0);
    // A flare low enough is capped; it sinks while it burns (lower: brighter below it).
    expect(flareLightAt(withFlares(60, [flare({ z: 20 })]), cat, 0, 0)).toBe(N.flareMaxLight);
    expect(flareLightAt(withFlares(60 * 60, [flare({ descentMps: 3 })]), cat, 0, 0)).toBeGreaterThan(below);
    // The brightest of several counts; the ground height of the lit point counts.
    expect(flareLightAt(withFlares(60, [flare({ x: 2000 }), flare()]), cat, 0, 0)).toBe(below);
    expect(flareLightAt(withFlares(60, [flare()]), cat, 0, 0, 100)).toBeGreaterThan(below);
  });

  it("the lit radius matches the light at its edge", () => {
    const f = flare();
    const r = flareLitRadius(cat, f, 60, 0.1);
    expect(r).toBeGreaterThan(100);
    expect(flareLightAt(withFlares(60, [f]), cat, r, 0)).toBeCloseTo(0.1, 6);
    expect(flareLitRadius(cat, f, 700 * 60, 0.1)).toBe(0);
  });
});

describe("spotting under a flare (M9.6)", () => {
  it("a still man in the open at 300 m on a moonless night is spotted much more often under a flare", () => {
    const base = { name: "standing, still, open", rangeM: 300, posture: "standing" as const, action: "still" as const, timeOfDay: 23 * 3600, moon: 0, seeds: 12, maxSeconds: 30 };
    const dark = spotCase(cat, { ...base, seedBase: 9100 });
    const lit = spotCase(cat, { ...base, seedBase: 9100, flare: { candela: illum.candela, heightM: 400, beyondM: 100 } });
    expect(lit.within30).toBeGreaterThan(dark.within30 + 3);
    expect(lit.within30).toBeGreaterThanOrEqual(lit.runs * 0.5);
  });
});

describe("save and load with a flare burning (M9.6)", () => {
  it("continues bit-identically", () => {
    const input = demoBattle(data, { seed: 7, factions: ["de", "ru"], mapWidthM: 1200, mapHeightM: 400, frontM: 400, timeLimitSeconds: 1800 });
    input.environment = environmentAt(input.catalog, 23 * 3600, 0);
    const sim = createSim(input);
    sim.state.flares = [{ x: 600, y: 200, z: 450, startTick: 0, untilTick: 120 * 60, descentMps: 3, candela: illum.candela, side: "blue" }];
    for (let k = 0; k < 20 * 60; k++) step(sim);
    const copy = loadSim({ ...input, orders: [] }, saveSim(sim));
    expect(hashState(copy.state)).toBe(hashState(sim.state));
    for (let k = 0; k < 40 * 60; k++) { step(sim); step(copy); }
    expect(sim.state.flares!.length).toBe(1);
    expect(hashState(copy.state)).toBe(hashState(sim.state));
  });
});
