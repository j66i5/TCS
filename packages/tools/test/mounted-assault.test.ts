/**
 * The mounted assault with real data (balance pass 5, owner 2026-11-20): the player's Assault to a mounted platoon
 * in the platoon battle, the AI commander's carriers backing to support posts after the dismount, and the night reach
 * of a support post (the BMP-2's image intensifier against the Puma's thermal sight).
 */
import { describe, expect, it } from "vitest";
import { commanderController } from "@tcs/ai";
import { createContext, createSim, step, submitOrder, supportReachM, type EntityId, type Order } from "@tcs/sim";
import { mountedAssaultBattle } from "../src/labs/mounted-assault";
import { getScenario, loadData } from "../src/scenarios";

const data = loadData();

describe("mounted assault with real data (balance pass 5)", () => {
  it("platoon-vehicles seed 1, the player's Assault: carriers get out no nearer than the doctrine distance, posts no nearer than minObjectiveM, the hulls fire, no hits on own men", () => {
    const r = mountedAssaultBattle(data, "platoon-vehicles", "player", 1, 300);
    const MA = data.catalog.behaviour.mounting.mountedAssault!;
    expect(r.carriers).toBeGreaterThanOrEqual(4);
    expect(r.dismountM.length).toBe(r.carriers);
    for (const d of r.dismountM) expect(d).toBeGreaterThanOrEqual(r.doctrineM - MA.arriveM - 10);
    expect(r.posts).toBeGreaterThan(0);
    for (const p of r.postM) expect(p).toBeGreaterThanOrEqual(MA.minObjectiveM);
    expect(r.rounds).toBeGreaterThan(0);
    expect(r.ownHits).toBe(0);
  }, 300_000);

  it("platoon-vehicles seed 1, AI against AI: once a squad is out its carrier gets a move to a support post (reversing back)", () => {
    const input = getScenario("platoon-vehicles").build(data, 1, 300);
    const sim = createSim(input);
    const ctrls = [commanderController("blue", input), commanderController("red", input)];
    const orders: Order[] = [];
    let firstOut = -1;
    while (sim.state.tick < 300 * 60) {
      for (const c of ctrls) for (const o of c.think(sim.state, sim.state.tick)) { orders.push(o); submitOrder(sim, o); }
      for (const e of step(sim)) if (e.kind === "unit.dismounted" && firstOut < 0 && sim.state.unit.get(e.unit)?.side === "blue") firstOut = e.tick;
    }
    expect(firstOut).toBeGreaterThan(0);
    const crews = new Set<EntityId>([...sim.state.unit.entries()].filter(([, u]) => u.side === "blue" && u.vehicle !== undefined).map(([id]) => id));
    const back = orders.filter((o) => o.issuer === "blue" && crews.has(o.target) && o.tick >= firstOut && o.kind === "move" && o.waypoints.some((w) => w.reverse === true));
    expect(back.length).toBeGreaterThan(0);
  }, 300_000);

  it("night: a support post must lie within the hull's night sight (BMP-2 image intensifier ~850 m; Puma thermal: its guns' reach)", () => {
    const input = getScenario("platoon-vehicles").build(data, 1, 60);
    const ctx = createContext(input);
    const bmp = data.catalog.vehicles["ru-bmp2"]!, puma = data.catalog.vehicles["de-puma"]!;
    const day = supportReachM(ctx, bmp, 1), night = supportReachM(ctx, bmp, 0);
    expect(night).toBeLessThanOrEqual(900);
    expect(night).toBeLessThan(day);
    expect(supportReachM(ctx, puma, 0)).toBe(supportReachM(ctx, puma, 1));
  });
});
