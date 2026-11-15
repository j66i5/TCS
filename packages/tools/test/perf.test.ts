/**
 * PERFORMANCE FLOOR (SPEC 4.4). Headless must run the benchmark scenario at >= the floor multiple of
 * real time. The floor is deliberately conservative for shared CI machines; it rises as systems land.
 * Current floor and its history: docs/DECISIONS.md.
 */
import { describe, expect, it } from "vitest";
import { addSmoke, createSim, runBattle, step, submitOrder } from "@tcs/sim";
import { siteHullDown, TANKS } from "@tcs/ai";
import { buildScenario, demoBattle } from "@tcs/scenario";
import { getScenario, loadData } from "../src/scenarios";

/** Minimum headless speed, multiples of real time. SPEC target: >= 8x on a laptop. */
export const PERF_FLOOR_X_REALTIME = 8;
/** bench-medical (M10.4b): floor a software decision: the SPEC target (8x), about half its measured speed (17x). */
export const BENCH_MEDICAL_FLOOR_X = 8;
/** bench-tanks (M7.6b): 30 tanks and their squads: the SPEC target (DECISIONS.md). */
export const BENCH_TANKS_FLOOR_X = 8;

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

  it(`bench-drones (the bench battle with 16 quadcopters in the air, M9.4a) runs at >= ${PERF_FLOOR_X_REALTIME}x real time`, () => {
    const sc = getScenario("bench-drones");
    const input = sc.build(loadData(), 1, 600);
    const sim = createSim(input), cs = sc.controllers!(input);
    const tick = () => { for (const c of cs) for (const o of c.think(sim.state, sim.state.tick)) submitOrder(sim, o); step(sim); };
    // (Launched and out over the field first: launching takes up to a minute.)
    for (let i = 0; i < 90 * 60; i++) tick();
    const t0 = performance.now();
    for (let i = 0; i < 60 * 60; i++) tick();
    const speed = 60 / ((performance.now() - t0) / 1000);
    console.log(`bench-drones: ${sim.state.drone.size} drones up, ${speed.toFixed(1)}x real time`);
    expect(sim.state.drone.size).toBeGreaterThanOrEqual(12);
    expect(speed).toBeGreaterThanOrEqual(PERF_FLOOR_X_REALTIME);
  });

  // M7.6b: bench-vehicles with tank crews (Leopard 2A7V against T-90M): more sights per hull, a heavier gun.
  it(`bench-tanks (30 tanks + their squads walking, all moving) runs at >= ${BENCH_TANKS_FLOOR_X}x real time`, () => {
    const data = loadData();
    const seconds = 60;
    const time = (name: string): { speed: number; soldiers: number; vehicles: number } => {
      const sc = getScenario(name);
      const input = sc.build(data, 1, seconds);
      runBattle(sc.build(data, 2, 10), { controllers: sc.controllers!(input) });
      const t0 = performance.now();
      const r = runBattle(input, { controllers: sc.controllers!(input) });
      return { speed: seconds / ((performance.now() - t0) / 1000), soldiers: r.sides.reduce((n, s) => n + s.soldiersStart, 0), vehicles: input.forces.reduce((n, f) => n + (f.vehicles?.length ?? 0), 0) };
    };
    const tk = time("bench-tanks"), ifv = time("bench-vehicles");
    console.log(`bench-tanks: ${tk.vehicles} tanks + ${tk.soldiers} soldiers, ${tk.speed.toFixed(1)}x real time (${(1000 / 60 / tk.speed).toFixed(2)} ms per tick; bench-vehicles ${ifv.speed.toFixed(1)}x, ${(1000 / 60 / ifv.speed).toFixed(2)} ms per tick: tanks cost ${(ifv.speed / tk.speed).toFixed(2)}x)`);
    expect(tk.vehicles).toBe(30);
    expect(tk.speed).toBeGreaterThanOrEqual(BENCH_TANKS_FLOOR_X);
  });

  it("platoon-vehicles-tanks (the commander siting its tanks) runs at >= 0.85x the speed of platoon-vehicles over the first 600 s", () => {
    const data = loadData();
    const speed = (name: string): number => {
      const sc = getScenario(name), input = sc.build(data, 1, 600);
      const t0 = performance.now();
      runBattle(input, { controllers: sc.controllers!(input) });
      return 600 / ((performance.now() - t0) / 1000);
    };
    speed("platoon-vehicles"); // (warm-up)
    const base = speed("platoon-vehicles"), tanks = speed("platoon-vehicles-tanks");
    console.log(`platoon-vehicles-tanks: ${tanks.toFixed(1)}x real time, platoon-vehicles ${base.toFixed(1)}x (ratio ${(tanks / base).toFixed(2)})`);
    expect(tanks).toBeGreaterThanOrEqual(0.85 * base);
  });

  it("one siteHullDown call on the village map takes at most 60 ms (median of 5)", () => {
    const input = buildScenario(loadData(), { kind: "platoon-attack", seed: 1, mapKind: "village", factions: ["de", "ru"], attacker: "blue", vehicles: true, tanks: "attacker" });
    const sim = createSim(input);
    const main = input.rules.objectives[0]!;
    const targets: { x: number; y: number }[] = [];
    for (let k = 0; k < 24; k++) targets.push({ x: main.x + Math.cos((k * Math.PI) / 12) * 60, y: main.y + Math.sin((k * Math.PI) / 12) * 60 });
    const threats = Array.from({ length: 400 }, (_, k) => ({ x: main.x + ((k % 20) - 10) * 10, y: main.y + (Math.floor(k / 20) - 10) * 10 }));
    const opts = { cls: "tracked" as const, turretZ: 2.8, hullZ: 1.3, rangeM: TANKS.rangeM, threats, standoffM: TANKS.coverStandoffM };
    const anchor = { x: main.x - TANKS.sbfFarM, y: main.y };
    siteHullDown(sim.ctx, anchor, targets, opts); // (the nav grid built first)
    const ms: number[] = [];
    for (let i = 0; i < 5; i++) { const t0 = performance.now(); siteHullDown(sim.ctx, anchor, targets, opts); ms.push(performance.now() - t0); }
    ms.sort((a, b) => a - b);
    console.log(`siteHullDown on the village map: median ${ms[2]!.toFixed(1)} ms (${ms.map((x) => x.toFixed(1)).join(", ")})`);
    expect(ms[2]!).toBeLessThanOrEqual(60);
  });

  // M10.4b (roadmap-detail slice 9): the medical load on top of bench-vehicles: a third of the men down from the
  // start, carried to the vehicles and loaded. Floor BENCH_MEDICAL_FLOOR_X: a software decision (DECISIONS.md).
  it(`bench-medical (bench-vehicles with a third of the men down, carried in) runs at >= ${BENCH_MEDICAL_FLOOR_X}x real time`, () => {
    const sc = getScenario("bench-medical");
    const data = loadData();
    const seconds = 60;
    const input = sc.build(data, 1, seconds);
    runBattle(sc.build(data, 2, 10), { controllers: sc.controllers!(input) });
    const t0 = performance.now();
    const r = runBattle(input, { controllers: sc.controllers!(input) });
    const wall = (performance.now() - t0) / 1000;
    const speed = seconds / wall;
    const soldiers = r.sides.reduce((n, s) => n + s.soldiersStart, 0);
    console.log(`bench-medical: 30 vehicles + ${soldiers} soldiers (a third down), ${seconds} s game time in ${wall.toFixed(3)} s wall = ${speed.toFixed(1)}x real time`);
    expect(soldiers).toBeGreaterThanOrEqual(250);
    expect(speed).toBeGreaterThanOrEqual(BENCH_MEDICAL_FLOOR_X);
  });
});
