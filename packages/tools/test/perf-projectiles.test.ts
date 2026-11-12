/**
 * PERFORMANCE WITH 20,000 LIVE PROJECTILES (SPEC 4.4, M2 acceptance). The benchmark battle (304 soldiers moving on
 * a 2 x 2 km farmland map) runs while a test harness keeps 20,000 bullets in the air (fired from random points
 * 1.5 m above ground at shallow angles, so they fly low over fields, hedges and woods and strike the ground).
 * Floor and history: docs/DECISIONS.md.
 */
import { describe, expect, it } from "vitest";
import { buildNavGrid, createRng, createSim, detonate, EventSink, heightAt, launchProjectile, nearestPassable, nextRange, step, submitOrder } from "@tcs/sim";
import { getScenario, loadData } from "../src/scenarios";

/** Minimum headless speed with 20,000 live projectiles, multiples of real time. */
export const PROJECTILE_FLOOR_X_REALTIME = 3;
const LIVE = 20000;
/** The round mix of the bullet benchmark, pinned (the non-tracer, non-explosive rounds of the data before M7). */
const BULLET_MIX = ["de-120-smoke", "de-556-dm11", "de-762-dm111", "ru-545-7n10", "ru-762r-lps", "ru-82-smoke"];
/** The grenade of the fragment volley, pinned (the one with the most fragments before M7). */
const VOLLEY_GRENADE = "de-dm51";

/** The bench battle with `parked` uncrewed hulls standing about the map (M7.1c: rounds stop at them). */
function benchInput(parked: number): ReturnType<ReturnType<typeof getScenario>["build"]> {
  const input = getScenario("bench").build(loadData(), 1, 600);
  if (parked === 0) return input;
  const grid = buildNavGrid(input.map, input.catalog.terrain, "tracked", 2, 0, [], { clearanceCells: 3 });
  for (let k = 0; k < parked; k++) {
    const f = input.forces[k % 2]!, type = Object.keys(input.catalog.vehicles).sort()[k % 2]!;
    const def = input.catalog.vehicles[type]!;
    const x = 200 + (k % 6) * 300, y = 250 + Math.floor(k / 6) * 350;
    const cell = nearestPassable(grid, x, y, 80);
    const vx = cell < 0 ? x : ((cell % grid.cols) + 0.5) * grid.cellM, vy = cell < 0 ? y : (Math.floor(cell / grid.cols) + 0.5) * grid.cellM;
    (f.vehicles ??= []).push({ vehicleId: `parked-${k}`, type, load: [{ type: def.fuel.item, count: 1, charge: 100 }] });
    (f.vehiclePlacements ??= []).push({ vehicleId: `parked-${k}`, x: vx, y: vy, heading: (k * 0.7) % 6.28 });
  }
  return input;
}

/** Fastest of three 100-tick windows of the bench battle with 20,000 bullets in the air: ms per tick. */
function bulletBench(parked: number, scenario = "bench", hold = false, aimAtHulls = false): { msPerTick: number; live: number; soldiers: number; eventsPerTick: number; hullHits: number; vehicleShots: number } {
  const sc = getScenario(scenario);
  const input = scenario === "bench" ? benchInput(parked) : sc.build(loadData(), 1, 600);
  const sim = createSim(input);
  // hold: the same battle (moving the same way) with everyone holding fire: the load "out of the fire".
  const ctrls = hold ? getScenario("bench-vehicles").controllers!(input) : sc.controllers!(input);
  if (hold) for (const [id, u] of sim.state.unit.entries()) if (u.parent === null) submitOrder(sim, { tick: 0, issuer: u.side, target: id, kind: "rules", fire: "hold" });
  const rng = createRng(99);
  // Bullets only: grenades and their fragments have their own benchmark below.
  // Pinned (M7.1a): new ammunition in the data must not change the benchmark's mix.
  const ammo = BULLET_MIX;
  for (const id of ammo) expect(input.catalog.ammo[id], id).toBeDefined();
  // aimAtHulls (M7.4b, the plan's hull-hit variant): one round in 25 is a 30 mm APFSDS fired at a parked hull
  // from 200-600 m (it penetrates, goes through the inside and may fly on), the rest as usual.
  const hulls = [...sim.state.vehicle.keys()];
  let n = 0;
  const topUp = () => {
    const P = sim.state.projectiles;
    while (P.count < LIVE) {
      if (aimAtHulls && hulls.length > 0 && n++ % 25 === 0) {
        const t = sim.state.transform.req(hulls[n % hulls.length]!);
        const az = nextRange(rng, "b", 0, Math.PI * 2), d = nextRange(rng, "b", 200, 600);
        const x = Math.min(Math.max(t.x - Math.cos(az) * d, 5), input.map.widthM - 5), y = Math.min(Math.max(t.y - Math.sin(az) * d, 5), input.map.heightM - 5);
        const z = heightAt(input.map, x, y) + 2.5, tz = heightAt(input.map, t.x, t.y) + 1.4, dd = Math.hypot(t.x - x, t.y - y) || 1;
        const v = 1300;
        launchProjectile(sim.ctx, sim.state, "de-30x173-pmc287", x, y, z, (v * (t.x - x)) / dd, (v * (t.y - y)) / dd, (v * (tz - z)) / dd, 0);
        continue;
      }
      const x = nextRange(rng, "b", 50, input.map.widthM - 50), y = nextRange(rng, "b", 50, input.map.heightM - 50);
      const az = nextRange(rng, "b", 0, Math.PI * 2), el = nextRange(rng, "b", -0.005, 0.06), v = nextRange(rng, "b", 700, 920);
      launchProjectile(sim.ctx, sim.state, ammo[P.count % ammo.length]!, x, y, heightAt(input.map, x, y) + 1.5,
        v * Math.cos(az) * Math.cos(el), v * Math.sin(az) * Math.cos(el), v * Math.sin(el), 0);
    }
  };
  let hullHits = 0, vehicleShots = 0;
  const tickOnce = () => {
    for (const c of ctrls) for (const o of c.think(sim.state, sim.state.tick)) submitOrder(sim, o);
    topUp();
    const ev = step(sim);
    for (const e of ev) { if (e.kind === "vehicle.hit") hullHits += e.rounds; else if (e.kind === "shot.fired" && e.vehicle !== undefined) vehicleShots++; }
    return ev.length;
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
  return { msPerTick: (wall / ticks) * 1000, live: sim.state.projectiles.count, soldiers: sim.state.identity.size, eventsPerTick: events / 300, hullHits, vehicleShots };
}

describe("performance with 20,000 live projectiles", () => {
  it(`benchmark battle plus ${LIVE} live projectiles runs at >= ${PROJECTILE_FLOOR_X_REALTIME}x real time`, () => {
    const r = bulletBench(0);
    const speed = 1000 / 60 / r.msPerTick;
    console.log(`projectile bench: ${r.live} live projectiles + ${r.soldiers} soldiers: ${r.msPerTick.toFixed(2)} ms per tick = ${speed.toFixed(1)}x real time (fastest of three 100-tick windows); ${r.eventsPerTick.toFixed(0)} events per tick`);
    expect(r.live).toBeGreaterThanOrEqual(LIVE * 0.95);
    expect(speed).toBeGreaterThanOrEqual(PROJECTILE_FLOOR_X_REALTIME);
  });

  it("30 parked hulls on the map cost the bullet benchmark little (plan target 5 %; asserted within 20 %: run-to-run noise here is about 10 %)", () => {
    // Alternately, twice each, the fastest of each counting (the machine's speed drifts between runs).
    const runs = [bulletBench(0), bulletBench(30), bulletBench(0), bulletBench(30), bulletBench(0), bulletBench(30)];
    const best = (k: number) => [runs[k]!, runs[k + 2]!, runs[k + 4]!].reduce((a, b) => (a.msPerTick <= b.msPerTick ? a : b));
    const base = best(0), hulls = best(1);
    const ratio = hulls.msPerTick / base.msPerTick;
    console.log(`projectile bench with 30 parked hulls: ${hulls.msPerTick.toFixed(2)} vs ${base.msPerTick.toFixed(2)} ms per tick without (${((ratio - 1) * 100).toFixed(1)} %); ${hulls.hullHits} rounds stopped by hulls`);
    expect(hulls.hullHits).toBeGreaterThan(0);
    expect(ratio).toBeLessThan(1.2);
  });

  it("the hull-hit variant (M7.4b): 30 mm APFSDS rounds striking and going through 30 parked hulls cost little against the hulls alone (plan 5 %; asserted within 25 %: run-to-run noise here is about 10 %)", () => {
    const runs = [bulletBench(30), bulletBench(30, "bench", false, true), bulletBench(30), bulletBench(30, "bench", false, true), bulletBench(30), bulletBench(30, "bench", false, true)];
    const best = (k: number) => [runs[k]!, runs[k + 2]!, runs[k + 4]!].reduce((a, b) => (a.msPerTick <= b.msPerTick ? a : b));
    const parked = best(0), hits = best(1);
    const ratio = hits.msPerTick / parked.msPerTick;
    console.log(`projectile bench with hull hits: ${hits.msPerTick.toFixed(2)} vs ${parked.msPerTick.toFixed(2)} ms per tick with the hulls only (${((ratio - 1) * 100).toFixed(1)} %); ${hits.hullHits} hull hits`);
    expect(hits.hullHits).toBeGreaterThan(parked.hullHits);
    expect(ratio).toBeLessThan(1.25);
  });

  it(`bench-combined (about 300 men + 30 IFVs firing at will + ${LIVE} projectiles) runs at >= ${PROJECTILE_FLOOR_X_REALTIME}x real time, close to the same load parked out of the fire (C32)`, () => {
    // Alternately, twice each, the fastest of each counting (as above).
    const runs = [bulletBench(0, "bench-combined", true), bulletBench(0, "bench-combined"), bulletBench(0, "bench-combined", true), bulletBench(0, "bench-combined")];
    const parked = runs[0]!.msPerTick <= runs[2]!.msPerTick ? runs[0]! : runs[2]!;
    const live = runs[1]!.msPerTick <= runs[3]!.msPerTick ? runs[1]! : runs[3]!;
    const speed = 1000 / 60 / live.msPerTick, ratio = live.msPerTick / parked.msPerTick;
    console.log(`bench-combined: ${live.live} live projectiles + ${live.soldiers} soldiers + 30 vehicles: ${live.msPerTick.toFixed(2)} ms per tick = ${speed.toFixed(1)}x real time (SPEC target 8x); parked and holding fire ${parked.msPerTick.toFixed(2)} ms (${((ratio - 1) * 100).toFixed(1)} %); ${live.vehicleShots} vehicle rounds, ${live.hullHits} hull hits`);
    expect(live.live).toBeGreaterThanOrEqual(LIVE * 0.95);
    expect(speed).toBeGreaterThanOrEqual(PROJECTILE_FLOOR_X_REALTIME);
    // Plan target 5 %; asserted within 25 % (run-to-run noise here is about 10 %).
    expect(ratio).toBeLessThan(1.25);
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
