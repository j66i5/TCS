/** Smoke volume v2 (M8.1): the smoke lab's acceptance checks, and the cloud model's own properties. */
import { describe, expect, it } from "vitest";
import { demoBattle } from "@tcs/scenario";
import { addSmoke, createSim, hashState, loadSim, saveSim, smokePhysics, smokeShapes, smokeTransmission, step, submitOrder, type Sim } from "@tcs/sim";
import { smokeLab, smokeLabMarkdown } from "../src/labs/smoke";
import { loadData } from "../src/scenarios";

const data = loadData();
const lab = smokeLab(data, 4);

describe("smoke lab (M8.1)", () => {
  it("prints its tables", () => { console.log(smokeLabMarkdown(lab)); });

  it("a man sees over a cloud only when his line clears its top", () => {
    for (const r of lab.height) {
      if (r.clearsTop) expect(r.view).toBe(1);
      else expect(r.view).toBeLessThan(0.1);
    }
    expect(lab.height.some((r) => r.clearsTop)).toBe(true);
    expect(lab.height.some((r) => !r.clearsTop && r.eyeZ > 4)).toBe(true); // upstairs behind a cloud taller than his line
  });

  it("a cloud drifts 100 m or more in 30 s at 4 m/s and never upwind", () => {
    for (const r of lab.drift) {
      expect(r.upwindM).toBeLessThan(1e-6);
      if (r.windMps >= 4) expect(r.headM).toBeGreaterThanOrEqual(100);
    }
  });

  it("a 6-round screen across 150 m blocks 90 % or more of spotting checks across it", () => {
    for (const r of lab.screen) expect(1 - r.meanView).toBeGreaterThanOrEqual(0.9);
  });
});

describe("smoke clouds (M8.1)", () => {
  const sim0 = (): Sim => createSim(demoBattle(data, { seed: 2, factions: ["de", "ru"], mapWidthM: 800, mapHeightM: 400, frontM: 300, timeLimitSeconds: 900 }));

  it("builds up, fades over its last seconds and is gone at its end", () => {
    const sim = sim0();
    const P = smokePhysics(sim.ctx.catalog);
    addSmoke(sim.ctx, sim.state, 400, 200, 20, 60, 15, 0);
    const across = () => smokeTransmission(sim.state, P, 300, 200, 2, 500, 200, 2);
    const r0 = smokeShapes(sim.state, P)[0]!.r;
    for (let k = 0; k < 600; k++) step(sim);
    expect(smokeShapes(sim.state, P)[0]!.r).toBeGreaterThan(r0);
    const full = across();
    for (let k = 0; k < 60 * 45; k++) step(sim); // 55 s: within the last 20 s
    expect(smokeShapes(sim.state, P)[0]!.density).toBeLessThan(0.5);
    expect(across()).toBeGreaterThan(full);
    for (let k = 0; k < 60 * 6; k++) step(sim);
    expect(sim.state.smoke).toHaveLength(0);
    expect(across()).toBe(1);
  });

  it("a burning round's plume stretches downwind from the round; a puff drifts whole", () => {
    const sim = sim0();
    sim.state.environment.windX = 4;
    const P = smokePhysics(sim.ctx.catalog);
    addSmoke(sim.ctx, sim.state, 200, 200, 20, 300, 15, 60);
    addSmoke(sim.ctx, sim.state, 200, 300, 10, 300, 8, 0);
    for (let k = 0; k < 60 * 20; k++) step(sim);
    const [plume, puff] = smokeShapes(sim.state, P);
    expect(plume!.ax).toBeCloseTo(200, 6);
    expect(plume!.bx).toBeCloseTo(280, 6);
    expect(puff!.ax).toBeCloseTo(280, 6);
    expect(puff!.bx).toBeCloseTo(280, 6);
    // A line across the plume's middle is blocked; one 20 m upwind of the round is not.
    expect(smokeTransmission(sim.state, P, 240, 100, 1.6, 240, 290, 1.6)).toBeLessThan(0.01);
    expect(smokeTransmission(sim.state, P, 160, 100, 1.6, 160, 290, 1.6)).toBe(1);
  });

  it("a screen mission lays its rounds along the line; drifting clouds survive save and load", () => {
    const input = demoBattle(data, { seed: 3, factions: ["de", "ru"], mapWidthM: 800, mapHeightM: 400, frontM: 300, timeLimitSeconds: 900 });
    input.rules.support = [{ side: "blue", he: 0, smoke: 12 }, { side: "red", he: 0, smoke: 0 }];
    const sim = createSim(input);
    sim.state.environment.windY = 2;
    const top = [...sim.state.unit.entries()].find(([, u]) => u.side === "blue" && u.parent === null)![0];
    submitOrder(sim, { tick: 0, issuer: "blue", target: top, kind: "callFire", x: 450, y: 100, x2: 450, y2: 300, ammo: "smoke", rounds: 6 });
    const falls: { x: number; y: number }[] = [];
    for (let k = 0; k < 60 * 200; k++) for (const e of step(sim)) if (e.kind === "support.smoke") falls.push({ x: e.x, y: e.y });
    const effect = falls.slice(-6);
    expect(effect).toHaveLength(6);
    // Spread along the line (ends about 200 m apart, scattered by the battery's dispersion).
    const ys = effect.map((p) => p.y);
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(100);
    const copy = loadSim({ ...input, orders: [] }, saveSim(sim));
    for (let k = 0; k < 600; k++) { step(sim); step(copy); }
    expect(hashState(copy.state)).toBe(hashState(sim.state));
  });

  it("a screen line is smoke only and needs both ends", () => {
    const sim = sim0();
    const top = [...sim.state.unit.entries()].find(([, u]) => u.side === "blue" && u.parent === null)![0];
    submitOrder(sim, { tick: 0, issuer: "blue", target: top, kind: "callFire", x: 450, y: 100, x2: 450, y2: 300, ammo: "he", rounds: 6 });
    submitOrder(sim, { tick: 0, issuer: "blue", target: top, kind: "callFire", x: 450, y: 100, x2: 450, ammo: "smoke", rounds: 6 });
    const ev = []; for (let k = 0; k < 120; k++) ev.push(...step(sim));
    expect(ev.filter((e) => e.kind === "order.rejected")).toHaveLength(2);
  });
});
