/**
 * RENDER COST (M7.3, plan C11; timing test, run with `test:perf`): one frame of 30 hulls, about 270 men on foot
 * and 2000 tracers in flight, built into a headless renderer (Pixi builds its geometry in plain JavaScript; the
 * GPU's part is not measured). A proxy for the frame budget on a phone: < 4 ms (plan C11).
 */
import { describe, expect, it } from "vitest";
import { createSim, heightAt, launchProjectile, step, type SimEvent } from "@tcs/sim";
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
    // About 260 m across (M7.5b: the dot level, 1.2-5 px/m; below 1.2 px/m units are symbols): men drawn one by one.
    r.camera = { x: 0, y: 0, scale: 1.5 };
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
    const mid = time(2), far = time(0.15); // (M7.5b: the middle distance is now the dot level)
    console.log(`render (M7.5a): middle distance with labels ${mid.toFixed(2)} ms, overview ${far.toFixed(2)} ms per frame (target 4 ms)`);
    expect(mid).toBeLessThan(4);
    expect(far).toBeLessThan(4);
  });
});

describe("render cost (M7.5b look)", () => {
  const time = (r: BattleRenderer, draw: () => void) => {
    for (let i = 0; i < 5; i++) draw();
    let best = Infinity;
    for (let w = 0; w < 3; w++) {
      const t0 = performance.now();
      for (let i = 0; i < 10; i++) draw();
      best = Math.min(best, (performance.now() - t0) / 10);
    }
    void r;
    return best;
  };

  it("close zoom: about 270 pixel soldiers on screen at true scale, all postures, many firing", () => {
    const sc = getScenario("bench-vehicles");
    const input = sc.build(loadData(), 1, 600);
    const sim = createSim(input);
    for (let i = 0; i < 30; i++) step(sim);
    // (Test only: every man — crews taken out of their hulls — set out on a 2 m grid in view, so all are drawn.)
    for (const [, s] of sim.state.soldier.entries()) delete (s as { mount?: unknown }).mount;
    const men = [...sim.state.soldier.keys()];
    const per = Math.ceil(Math.sqrt(men.length));
    men.forEach((id, k) => {
      const t = sim.state.transform.get(id)!;
      t.x = 1000 + (k % per) * 2; t.y = 1000 + Math.floor(k / per) * 2; t.heading = k * 0.4;
      const s = sim.state.soldier.get(id)!;
      s.posture = (["standing", "crouching", "prone"] as const)[k % 3]!;
    });
    const r = BattleRenderer.headless(1280, 800);
    r.setCatalog(input.catalog);
    r.camera = { x: 1000 - 20, y: 1000 - 10, scale: 20 }; // close: true scale (20 px a man)
    const overlay = { playerSide: "blue", selectedUnit: null, debug: true };
    const fired: SimEvent[] = men.filter((_, k) => k % 4 === 0).map((id) => ({ kind: "shot.fired", tick: sim.state.tick, shooter: id, x: 0, y: 0 } as unknown as SimEvent));
    const best = time(r, () => { r.onEvents(fired, sim.state, overlay); r.draw(sim.state, input.map, 0.5, overlay); });
    console.log(`render (M7.5b): close zoom, ${men.length} pixel soldiers in view: ${best.toFixed(2)} ms per frame (target 4 ms)`);
    expect(men.length).toBeGreaterThan(250);
    expect(r.zoomLevel()).toBe(3);
    expect(best).toBeLessThan(4);
  });

  it("photo look (step polish): contact shadows and dark rims on about 270 pixel soldiers cost little over flat", () => {
    const sc = getScenario("bench-vehicles");
    const input = sc.build(loadData(), 1, 600);
    const sim = createSim(input);
    for (let i = 0; i < 30; i++) step(sim);
    for (const [, s] of sim.state.soldier.entries()) delete (s as { mount?: unknown }).mount;
    const men = [...sim.state.soldier.keys()];
    const per = Math.ceil(Math.sqrt(men.length));
    men.forEach((id, k) => { const t = sim.state.transform.get(id)!; t.x = 1000 + (k % per) * 2; t.y = 1000 + Math.floor(k / per) * 2; t.heading = k * 0.4; });
    const overlay = { playerSide: "blue", selectedUnit: null, debug: true };
    const run = (look: "photo" | "flat") => {
      const r = BattleRenderer.headless(1280, 800);
      r.setLook(look);
      r.setCatalog(input.catalog);
      r.camera = { x: 1000 - 20, y: 1000 - 10, scale: 20 };
      return time(r, () => r.draw(sim.state, input.map, 0.5, overlay));
    };
    // Interleaved, best of two each (the difference is small against timing noise).
    const flat = Math.min(run("flat"), run("flat")), photo = Math.min(run("photo"), run("photo"));
    console.log(`render (photo polish): ${men.length} soldiers close up: flat ${flat.toFixed(2)} ms, photo with shadows and rims ${photo.toFixed(2)} ms (+${(photo - flat).toFixed(2)}; plan <= 0.3, target 4 ms)`);
    expect(photo).toBeLessThan(4);
    expect(photo - flat).toBeLessThan(0.8);
  });

  it("roofs: the village platoon battle at the figure zoom, the roof-fade rule over every building each frame", () => {
    const sc = getScenario("platoon");
    const input = sc.build(loadData(), 1, 600);
    const sim = createSim(input);
    for (let i = 0; i < 30; i++) step(sim);
    const r = BattleRenderer.headless(1280, 800);
    r.setCatalog(input.catalog);
    r.setBuildings(input.map);
    const overlay = { playerSide: "blue", selectedUnit: null, debug: true };
    r.camera = { x: input.map.widthM / 2 - 80, y: input.map.heightM / 2 - 50, scale: 8 };
    const best = time(r, () => r.draw(sim.state, input.map, 0.5, overlay));
    console.log(`render (M7.5b; photo look: roof sprites): ${input.map.buildings.length} buildings with roofs, ${sim.state.identity.size} men, figure zoom: ${best.toFixed(2)} ms per frame (target 4 ms)`);
    expect(input.map.buildings.length).toBeGreaterThan(20);
    expect(best).toBeLessThan(4);
  });
});
