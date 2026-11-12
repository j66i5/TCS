/**
 * RENDER COST (M7.3, plan C11; timing test, run with `test:perf`): one frame of 30 hulls, about 270 men on foot
 * and 2000 tracers in flight, built into a headless renderer (Pixi builds its geometry in plain JavaScript; the
 * GPU's part is not measured). A proxy for the frame budget on a phone: < 4 ms (plan C11).
 */
import { describe, expect, it } from "vitest";
import { createSim, heightAt, launchProjectile, step } from "@tcs/sim";
import { BattleRenderer } from "../src/renderer";
import { getScenario, loadData } from "../../tools/src/scenarios";

describe("render cost", () => {
  it("30 hulls + about 270 men + 2000 tracers: one frame in under the budget", () => {
    const sc = getScenario("bench-vehicles");
    const input = sc.build(loadData(), 1, 600);
    const sim = createSim(input);
    for (let i = 0; i < 30; i++) step(sim);
    const tracer = input.catalog.ammoIds.find((id) => input.catalog.ammo[id]!.tracer && !input.catalog.ammo[id]!.explosive)!;
    for (let k = 0; k < 2000; k++) {
      const x = 100 + (k * 37) % 1800, y = 100 + (k * 53) % 1800, a = k * 0.7;
      launchProjectile(sim.ctx, sim.state, tracer, x, y, heightAt(input.map, x, y) + 1.5, 800 * Math.cos(a), 800 * Math.sin(a), 5, 0);
    }
    const r = BattleRenderer.headless(390, 844); // a phone held upright
    r.setCatalog(input.catalog);
    r.camera = { x: 0, y: 0, scale: 390 / 2000 * 2.5 }; // about 800 m across: men drawn one by one, not as symbols
    const overlay = { playerSide: "blue", selectedUnit: null, debug: true };
    for (let i = 0; i < 5; i++) r.draw(sim.state, input.map, 0.5, overlay); // warm-up
    let best = Infinity;
    for (let w = 0; w < 3; w++) {
      const t0 = performance.now();
      for (let i = 0; i < 10; i++) r.draw(sim.state, input.map, 0.5, overlay);
      best = Math.min(best, (performance.now() - t0) / 10);
    }
    console.log(`render: 30 hulls + ${sim.state.identity.size} men + ${sim.state.projectiles.count} projectiles: ${best.toFixed(2)} ms per frame (fastest of three 10-frame windows; plan target 4 ms)`);
    expect(best).toBeLessThan(4);
  });

  it("M7.5a: the same at the middle distance (every leader and hull labelled, decluttered) and in the overview", () => {
    const sc = getScenario("bench-vehicles");
    const input = sc.build(loadData(), 1, 600);
    const sim = createSim(input);
    for (let i = 0; i < 30; i++) step(sim);
    const r = BattleRenderer.headless(390, 844);
    r.setCatalog(input.catalog);
    r.setHudInsets({ top: 100, right: 0, bottom: 54, left: 64 });
    const overlay = { playerSide: "blue", selectedUnit: null, debug: true };
    const time = (scale: number) => {
      r.camera = { x: 0, y: 0, scale };
      for (let i = 0; i < 5; i++) r.draw(sim.state, input.map, 0.5, overlay);
      let best = Infinity;
      for (let w = 0; w < 3; w++) {
        const t0 = performance.now();
        for (let i = 0; i < 10; i++) r.draw(sim.state, input.map, 0.5, overlay);
        best = Math.min(best, (performance.now() - t0) / 10);
      }
      return best;
    };
    const mid = time(0.6), far = time(0.15);
    console.log(`render (M7.5a): middle distance with labels ${mid.toFixed(2)} ms, overview ${far.toFixed(2)} ms per frame (target 4 ms)`);
    expect(mid).toBeLessThan(4);
    expect(far).toBeLessThan(4);
  });
});
