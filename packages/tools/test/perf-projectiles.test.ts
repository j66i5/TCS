/**
 * PERFORMANCE WITH 20,000 LIVE PROJECTILES (SPEC 4.4, M2 acceptance). The benchmark battle (304 soldiers moving on
 * a 2 x 2 km farmland map) runs while a test harness keeps 20,000 bullets in the air (fired from random points
 * 1.5 m above ground at shallow angles, so they fly low over fields, hedges and woods and strike the ground).
 * Floor and history: docs/DECISIONS.md.
 */
import { describe, expect, it } from "vitest";
import { createRng, createSim, detonate, EventSink, heightAt, launchProjectile, nextRange, step, submitOrder } from "@tcs/sim";
import { getScenario, loadData } from "../src/scenarios";

/** Minimum headless speed with 20,000 live projectiles, multiples of real time. */
export const PROJECTILE_FLOOR_X_REALTIME = 3;
const LIVE = 20000;
/** The round mix of the bullet benchmark, pinned (the non-tracer, non-explosive rounds of the data before M7). */
const BULLET_MIX = ["de-120-smoke", "de-556-dm11", "de-762-dm111", "ru-545-7n10", "ru-762r-lps", "ru-82-smoke"];
/** The grenade of the fragment volley, pinned (the one with the most fragments before M7). */
const VOLLEY_GRENADE = "de-dm51";

describe("performance with 20,000 live projectiles", () => {
  it(`benchmark battle plus ${LIVE} live projectiles runs at >= ${PROJECTILE_FLOOR_X_REALTIME}x real time`, () => {
    const sc = getScenario("bench");
    const data = loadData();
    const input = sc.build(data, 1, 600);
    const sim = createSim(input);
    const ctrls = sc.controllers!(input);
    const rng = createRng(99);
    // Bullets only: grenades and their fragments have their own benchmark below.
    // Pinned (M7.1a): new ammunition in the data must not change the benchmark's mix.
    const ammo = BULLET_MIX;
    for (const id of ammo) expect(input.catalog.ammo[id], id).toBeDefined();
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
    // Three windows of 100 ticks; the fastest counts. Other test files run at the same time on the same cores
    // (and CI machines are shared), which can only make a window slower, never faster.
    const ticks = 100;
    let events = 0, wall = Infinity;
    for (let w = 0; w < 3; w++) {
      const t0 = performance.now();
      for (let i = 0; i < ticks; i++) events += tickOnce();
      wall = Math.min(wall, (performance.now() - t0) / 1000);
    }
    const speed = ticks / 60 / wall;
    console.log(`projectile bench: ${sim.state.projectiles.count} live projectiles + ${sim.state.identity.size} soldiers: ${(wall / ticks * 1000).toFixed(2)} ms per tick = ${speed.toFixed(1)}x real time (fastest of three 100-tick windows); ${(events / 300).toFixed(0)} events per tick`);
    expect(sim.state.projectiles.count).toBeGreaterThanOrEqual(LIVE * 0.95);
    expect(speed).toBeGreaterThanOrEqual(PROJECTILE_FLOOR_X_REALTIME);
  });
});

/**
 * FRAGMENTS (M2.4 acceptance), in the same file so the benchmarks never run at the same time.
 *
 * Fragments are light: they are too slow to wound after three or four ticks and are then removed.
 * A VOLLEY: nine sleeve grenades burst in the same tick (about 20,000 fragments in the air at once), once
 *     a second, during the benchmark battle. Floor: 3x real time, like the bullet benchmark. The longest single
 *     tick is printed (it is the stutter a player would see).
 * Not a test: with bursts EVERY tick so that 20,000 fragments are in the air all the time (about 450 grenades
 * a second, far beyond any battle in scope) the measured speed was about 2x real time (docs/DECISIONS.md).
 */
const LIVE_FRAGMENTS = 20000;

describe("performance with fragments", () => {
  const setup = () => {
    const sc = getScenario("bench");
    const input = sc.build(loadData(), 1, 600);
    const sim = createSim(input);
    const ctrls = sc.controllers!(input);
    const think = () => { for (const c of ctrls) for (const o of c.think(sim.state, sim.state.tick)) submitOrder(sim, o); };
    const burstAt = (rng: ReturnType<typeof createRng>, ammo: number, sink: EventSink) => {
      const x = nextRange(rng, "b", 50, input.map.widthM - 50), y = nextRange(rng, "b", 50, input.map.heightM - 50);
      detonate(sim.ctx, sim.state, sink, x, y, heightAt(input.map, x, y) + 0.05, ammo, 0);
    };
    return { input, sim, think, burstAt };
  };

  it(`a volley of nine grenades at once (about ${LIVE_FRAGMENTS} fragments), every second, runs at >= ${PROJECTILE_FLOOR_X_REALTIME}x real time`, () => {
    const { input, sim, think, burstAt } = setup();
    const rng = createRng(77);
    const sleeve = input.catalog.ammoIds.indexOf(VOLLEY_GRENADE);
    expect(sleeve).toBeGreaterThanOrEqual(0);
    let peak = 0, worst = 0, heavyMs = 0, heavyTicks = 0;
    const second = (measure: boolean) => {
      for (let i = 0; i < 60; i++) {
        think();
        const t0 = performance.now();
        if (i === 0) { const sink = new EventSink(); for (let k = 0; k < 9; k++) burstAt(rng, sleeve, sink); if (sim.state.projectiles.count > peak) peak = sim.state.projectiles.count; }
        const live = sim.state.projectiles.count;
        step(sim);
        const ms = performance.now() - t0;
        if (measure && ms > worst) worst = ms;
        if (measure && (i === 0 || live >= 5000)) { heavyMs += ms; heavyTicks++; } // the ticks that carry the fragments
      }
    };
    second(false); second(false); // warm-up
    const t0 = performance.now();
    for (let s = 0; s < 5; s++) second(true);
    const wall = (performance.now() - t0) / 1000;
    const speed = 5 / wall;
    const heavy = heavyMs / Math.max(1, heavyTicks);
    console.log(`fragment volley bench: 9 bursts at once (${peak} fragments) every second + ${sim.state.identity.size} soldiers: ${speed.toFixed(1)}x real time on average; the ${heavyTicks} ticks carrying the fragments take ${heavy.toFixed(1)} ms each (${(1000 / 60 / heavy).toFixed(1)}x real time), longest ${worst.toFixed(1)} ms`);
    // HONEST LIMIT (docs/DECISIONS.md): the 3x floor holds on average, NOT for the few ticks in which 20,000
    // fragments are actually in the air. Those must at least keep up with real time, and no tick may stall.
    expect(heavy).toBeLessThanOrEqual(1000 / 60);
    expect(worst).toBeLessThanOrEqual(120);
    expect(peak).toBeGreaterThanOrEqual(LIVE_FRAGMENTS * 0.9);
    expect(speed).toBeGreaterThanOrEqual(PROJECTILE_FLOOR_X_REALTIME);
  });
});
