/**
 * Seeing and hearing vehicles (M7.3, plan §10): sensors through smoke (owner Q7, C14), the area a hull shows
 * by aspect (C57), engine noise in rain and wind (C13, SPEC 9.7), and enemy vehicles in the side's picture.
 */
import { describe, expect, it } from "vitest";
import { createSim, sideKnowledge, step, TICK_HZ } from "@tcs/sim";
import { throughSmoke, vehicleSize } from "../../sim/src/systems/spotting";
import { engineRangeM } from "../../sim/src/systems/contacts";
import { duel } from "../src/labs/gunnery";
import { loadData } from "../src/scenarios";

const data = loadData();

describe("vehicle senses (M7.3)", () => {
  it("a thermal sight sees a hull through ordinary smoke at half strength; eyes and day sights do not; nothing through multispectral", () => {
    const sim = createSim(duel(data, ["de", "ru"], { blue: { x: 400, y: 600, heading: 0 }, red: { x: 1200, y: 600, heading: 0 } }));
    const S = sim.ctx.catalog.spotting.sensors;
    // Dense ordinary smoke on the line: nothing of the view gets through for eyes.
    expect(throughSmoke(S["eye"]!.smokeFactor ?? 0, 0, 1)).toBe(0);
    expect(throughSmoke(S["vehicle-day"]!.smokeFactor ?? 0, 0, 1)).toBe(0);
    expect(throughSmoke(S["vehicle-thermal"]!.smokeFactor ?? 0, 0, 1)).toBeCloseTo(0.5, 9);
    // No smoke: all see fully; multispectral: thermal blinded too.
    expect(throughSmoke(S["vehicle-thermal"]!.smokeFactor ?? 0, 1, 1)).toBe(1);
    expect(throughSmoke(S["vehicle-thermal"]!.smokeFactor ?? 0, 1, 0)).toBe(0);
  });

  it("a hull side-on shows far more than head-on (geometry, sizeFactor 1)", () => {
    const sim = createSim(duel(data, ["de", "ru"], { blue: { x: 400, y: 600, heading: 0 }, red: { x: 1200, y: 600, heading: 0 } }));
    const D = sim.ctx.catalog.spotting;
    const puma = sim.ctx.catalog.vehicles["de-puma"]!;
    const side = vehicleSize(D, puma, Math.PI / 2, Math.PI / 2).size, front = vehicleSize(D, puma, 0, 0).size;
    expect(side).toBeGreaterThan(20);
    expect(side).toBeLessThan(30);
    expect(front).toBeGreaterThan(10);
    expect(front).toBeLessThan(18);
  });

  it("rain shortens engine hearing; downwind carries further than upwind", () => {
    const sim = createSim(duel(data, ["de", "ru"], { blue: { x: 400, y: 600, heading: 0 }, red: { x: 1200, y: 600, heading: 0 } }));
    const [vid] = [...sim.state.vehicle.entries()].find(([, v]) => v.side === "red")!;
    const env = sim.state.environment;
    env.windX = 0; env.windY = 0; env.rain = 0;
    const dry = engineRangeM(sim.ctx, sim.state, vid, 400, 600);
    env.rain = 1;
    const wet = engineRangeM(sim.ctx, sim.state, vid, 400, 600);
    expect(dry).toBeGreaterThan(0);
    expect(wet).toBeLessThan(dry * 0.7);
    env.rain = 0; env.windX = -5; // blowing west, from the vehicle toward the listener
    const down = engineRangeM(sim.ctx, sim.state, vid, 400, 600);
    env.windX = 5;
    const up = engineRangeM(sim.ctx, sim.state, vid, 400, 600);
    expect(down).toBeGreaterThan(dry);
    expect(up).toBeLessThan(dry);
  });

  it("men on foot hear a moving vehicle's engine and their side knows it as a vehicle", () => {
    const sim = createSim(duel(data, ["de", "ru"], { blue: { x: 400, y: 600, heading: 0 }, red: { x: 1300, y: 600, heading: 0 } }));
    // A wood between them would hide it; on the flat field they may see it too: either way it is a vehicle contact.
    for (let i = 0; i < 20 * TICK_HZ; i++) step(sim);
    const k = sideKnowledge(sim.ctx, sim.state, "blue").find((e) => sim.state.vehicle.has(e.target));
    expect(k).toBeDefined();
    expect(k!.cls).toBe("vehicle");
  });
});
