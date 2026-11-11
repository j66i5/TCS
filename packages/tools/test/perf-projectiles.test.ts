/**
 * PERFORMANCE WITH 20,000 LIVE PROJECTILES (SPEC 4.4, M2 acceptance). The benchmark battle (304 soldiers moving on
 * a 2 x 2 km farmland map) runs while a test harness keeps 20,000 bullets in the air (fired from random points
 * 1.5 m above ground at shallow angles, so they fly low over fields, hedges and woods and strike the ground).
 * Floor and history: docs/DECISIONS.md.
 */
import { describe, expect, it } from "vitest";
import { createRng, createSim, heightAt, launchProjectile, nextRange, step, submitOrder } from "@tcs/sim";
import { getScenario, loadData } from "../src/scenarios";

/** Minimum headless speed with 20,000 live projectiles, multiples of real time. */
export const PROJECTILE_FLOOR_X_REALTIME = 3;
const LIVE = 20000;

describe("performance with 20,000 live projectiles", () => {
  it(`benchmark battle plus ${LIVE} live projectiles runs at >= ${PROJECTILE_FLOOR_X_REALTIME}x real time`, () => {
    const sc = getScenario("bench");
    const data = loadData();
    const input = sc.build(data, 1, 600);
    const sim = createSim(input);
    const ctrls = sc.controllers!(input);
    const rng = createRng(99);
    const ammo = input.catalog.ammoIds.filter((id) => !input.catalog.ammo[id]!.tracer);
    const topUp = () => {
      const P = sim.state.projectiles;
      while (P.count < LIVE) {
        const x = nextRange(rng, "b", 50, input.map.widthM - 50), y = nextRange(rng, "b", 50, input.map.heightM - 50);
        const az = nextRange(rng, "b", 0, Math.PI * 2), el = nextRange(rng, "b", -0.005, 0.06), v = nextRange(rng, "b", 700, 920);
        launchProjectile(sim.ctx, sim.state, ammo[P.count % ammo.length]!, x, y, heightAt(input.map, x, y) + 1.5,
          v * Math.cos(az) * Math.cos(el), v * Math.sin(az) * Math.cos(el), v * Math.sin(el), 0);
      }
    };
    const tickOnce = () => {
      for (const c of ctrls) for (const o of c.think(sim.state, sim.state.tick)) submitOrder(sim, o);
      topUp();
      return step(sim).length;
    };
    for (let i = 0; i < 120; i++) tickOnce(); // warm-up: JIT, pool growth, first orders
    const ticks = 300;
    let events = 0;
    const t0 = performance.now();
    for (let i = 0; i < ticks; i++) events += tickOnce();
    const wall = (performance.now() - t0) / 1000;
    const speed = ticks / 60 / wall;
    console.log(`projectile bench: ${sim.state.projectiles.count} live projectiles + ${sim.state.identity.size} soldiers: ${(wall / ticks * 1000).toFixed(2)} ms per tick = ${speed.toFixed(1)}x real time; ${(events / ticks).toFixed(0)} events per tick`);
    expect(sim.state.projectiles.count).toBeGreaterThanOrEqual(LIVE * 0.95);
    expect(speed).toBeGreaterThanOrEqual(PROJECTILE_FLOOR_X_REALTIME);
  });
});
