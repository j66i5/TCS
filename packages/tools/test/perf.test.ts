/**
 * PERFORMANCE FLOOR (SPEC 4.4). Headless must run the benchmark scenario at >= the floor multiple of
 * real time. The floor is deliberately conservative for shared CI machines; it rises as systems land.
 * Current floor and its history: docs/DECISIONS.md.
 */
import { describe, expect, it } from "vitest";
import { runBattle } from "@tcs/sim";
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
});
