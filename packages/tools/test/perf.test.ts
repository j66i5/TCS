/**
 * PERFORMANCE FLOOR (SPEC 4.4). Headless must run the benchmark scenario at >= the floor multiple of
 * real time. The floor is deliberately conservative for shared CI machines; it rises as systems land.
 * Current floor and its history: docs/DECISIONS.md.
 */
import { describe, expect, it } from "vitest";
import { addSmoke, createSim, runBattle, step, submitOrder } from "@tcs/sim";
import { demoBattle } from "@tcs/scenario";
import { getScenario, loadData } from "../src/scenarios";

/** Minimum headless speed, multiples of real time. SPEC target: >= 8x on a laptop. */
export const PERF_FLOOR_X_REALTIME = 8;

describe("performance floor", () => {
  it(`benchmark scenario runs at >= ${PERF_FLOOR_X_REALTIME}x real time headless`, () => {
    const sc = getScenario("bench");
    const data = loadData();
    const seconds = 60;
    const input = sc.build(data, 1, seconds);
    // Warm-up run (JIT), then measured run.
    runBattle(sc.build(data, 2, 10), { controllers: sc.controllers!(input) });
    const t0 = performance.now();
    const r = runBattle(input, { controllers: sc.controllers!(input) });
    const wall = (performance.now() - t0) / 1000;
    const speed = seconds / wall;
    const soldiers = r.sides.reduce((n, s) => n + s.soldiersStart, 0);
    console.log(`bench: ${soldiers} soldiers, ${seconds} s game time in ${wall.toFixed(3)} s wall = ${speed.toFixed(0)}x real time`);
    expect(soldiers).toBeGreaterThanOrEqual(300);
    expect(speed).toBeGreaterThanOrEqual(PERF_FLOOR_X_REALTIME);
  });

  it("304 men in plain view of each other, all firing (spotting at full load), runs at >= 8x real time", () => {
    const input = demoBattle(loadData(), { seed: 1, factions: ["de", "ru"], templates: ["demo-team", "demo-team"], unitsPerSide: 38, mapWidthM: 2000, mapHeightM: 2000, frontM: 300, timeLimitSeconds: 600 });
    const sim = createSim(input);
    // Every unit fires at the middle of the enemy line (firing makes a man far easier to spot: the hardest case).
    for (const [uid, u] of sim.state.unit.entries()) {
      if (u.parent !== null) continue;
      submitOrder(sim, { tick: 0, issuer: u.side, target: uid, kind: "fire", x: u.side === "blue" ? 1150 : 850, y: 1000 });
    }
    for (let i = 0; i < 600; i++) step(sim); // first sightings
    const t0 = performance.now();
    for (let i = 0; i < 1800; i++) step(sim);
    const s = (performance.now() - t0) / 1000;
    let tracked = 0;
    for (const [, x] of sim.state.soldier.entries()) tracked += x.seen.length;
    console.log(`spotting bench: 304 men 300 m apart in the open, all firing: ${(30 / s).toFixed(1)}x real time; ${tracked} enemies tracked`);
    expect(tracked).toBeGreaterThan(1000);
    expect(30 / s).toBeGreaterThanOrEqual(8);
  });

  it("the same spotting bench with 30 smoke clouds on the field (M8.1: drifting plumes, heights) runs at >= 8x real time", () => {
    const input = demoBattle(loadData(), { seed: 1, factions: ["de", "ru"], templates: ["demo-team", "demo-team"], unitsPerSide: 38, mapWidthM: 2000, mapHeightM: 2000, frontM: 300, timeLimitSeconds: 600 });
    const sim = createSim(input);
    for (const [uid, u] of sim.state.unit.entries()) {
      if (u.parent !== null) continue;
      submitOrder(sim, { tick: 0, issuer: u.side, target: uid, kind: "fire", x: u.side === "blue" ? 1150 : 850, y: 1000 });
    }
    sim.state.environment.windX = 1; sim.state.environment.windY = 3;
    // 30 clouds: a broken screen between the lines (gaps let some men see), the rest over the field.
    for (let k = 0; k < 30; k++) {
      const between = k < 12;
      addSmoke(sim.ctx, sim.state, between ? 1000 + (k % 2) * 30 : 600 + ((k * 137) % 800), between ? 700 + k * 55 : 400 + ((k * 211) % 1200), 15, 1000, k % 3 === 0 ? 8 : 15, k % 2 === 0 ? 120 : 0);
    }
    for (let i = 0; i < 600; i++) step(sim);
    const t0 = performance.now();
    for (let i = 0; i < 1800; i++) step(sim);
    const s = (performance.now() - t0) / 1000;
    console.log(`spotting bench with 30 smoke clouds: ${(30 / s).toFixed(1)}x real time`);
    expect(sim.state.smoke.length).toBe(30);
    expect(30 / s).toBeGreaterThanOrEqual(8);
  });

  it(`bench-vehicles (30 IFVs + their squads, all moving) runs at >= ${PERF_FLOOR_X_REALTIME}x real time`, () => {
    const sc = getScenario("bench-vehicles");
    const data = loadData();
    const seconds = 60;
    const input = sc.build(data, 1, seconds);
    runBattle(sc.build(data, 2, 10), { controllers: sc.controllers!(input) });
    const t0 = performance.now();
    const r = runBattle(input, { controllers: sc.controllers!(input) });
    const wall = (performance.now() - t0) / 1000;
    const speed = seconds / wall;
    const soldiers = r.sides.reduce((n, s) => n + s.soldiersStart, 0);
    console.log(`bench-vehicles: 30 vehicles + ${soldiers} soldiers, ${seconds} s game time in ${wall.toFixed(3)} s wall = ${speed.toFixed(1)}x real time`);
    expect(input.forces.reduce((n, f) => n + (f.vehicles?.length ?? 0), 0)).toBe(30);
    expect(soldiers).toBeGreaterThanOrEqual(250);
    expect(speed).toBeGreaterThanOrEqual(PERF_FLOOR_X_REALTIME);
  });
});
