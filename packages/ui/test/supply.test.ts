/** M11.3: caches on the map and the "Resupply" button, from the read-only view. */
import { describe, expect, it } from "vitest";
import { createSim } from "@tcs/sim";
import { getScenario, loadData } from "../../tools/src/scenarios";
import { cacheMarkers, supplyPointAt, supplySourceNear } from "../src/supply";
import { ordersFor, unitCapabilities, unitSoldierIds } from "../src/orders-for";

const data = loadData();

describe("supply points and caches in the interface (M11.3)", () => {
  const sim = createSim(getScenario("hold-resupply").build(data, 1, 600));
  const cat = sim.ctx.catalog;
  const [cid, cache] = [...sim.state.cache.entries()][0]!;
  const squad = [...sim.state.unit.entries()].find(([, u]) => u.side === cache.side && u.echelon === "squad")![0];

  it("the defender sees its supply point with its rounds and fill; the attacker sees it only once its men have", () => {
    const own = cacheMarkers(sim.state, cat, cache.side);
    expect(own).toHaveLength(1);
    expect(own[0]).toMatchObject({ cache: cid, own: true, point: true, empty: false, burning: false });
    expect(own[0]!.rounds).toBeGreaterThan(1000);
    expect(own[0]!.fill).toBeCloseTo(1, 5);
    const foe = cache.side === "blue" ? "red" : "blue";
    expect(cacheMarkers(sim.state, cat, foe)).toHaveLength(0);
    cache.known = [foe];
    const seen = cacheMarkers(sim.state, cat, foe);
    // (The enemy's cache: there, not how full.)
    expect(seen[0]).toMatchObject({ own: false, rounds: 0, fill: null });
    delete cache.known;
    const t = sim.state.transform.req(cid);
    expect(supplyPointAt(own, t.x + 3, t.y, 5)?.cache).toBe(cid);
  });

  it("a squad near its supply point is offered Resupply and the Supply point mode", () => {
    expect(supplySourceNear(sim.state, cat, cache.side, unitSoldierIds(sim.state, squad))).toBe(cid);
    const cap = unitCapabilities(sim.state, cat, squad);
    expect(cap.supplySource).toBe(cid);
    const o = ordersFor(cap, cat.movementModes);
    expect(o.resupply).toBe(true);
    expect(o.modes).toContain("supply");
    // An empty cache offers nothing.
    const stacks = sim.state.container.req(cid).stacks;
    sim.state.container.req(cid).stacks = [];
    expect(ordersFor(unitCapabilities(sim.state, cat, squad), cat.movementModes).resupply).toBeUndefined();
    sim.state.container.req(cid).stacks = stacks;
  });

  it("M11.4a: a squad is offered Fetch ammunition while its platoon's point has supplies; a waiting request shows on its card", () => {
    const cap = unitCapabilities(sim.state, cat, squad);
    expect(cap.bearers).toBe(true);
    expect(ordersFor(cap, cat.movementModes).fetchAmmo).toBe(true);
    expect(cap.supplyAsk).toBeUndefined();
    sim.state.unit.req(squad).supplyAsk = { tick: 0, pending: true };
    expect(unitCapabilities(sim.state, cat, squad).supplyAsk).toBe(true);
    delete sim.state.unit.req(squad).supplyAsk;
    // A crate in bearers' hands is no source for Resupply.
    cache.carried = true;
    expect(supplySourceNear(sim.state, cat, cache.side, unitSoldierIds(sim.state, squad))).toBeNull();
    delete cache.carried;
    // The point empty: nothing to fetch.
    const stacks = sim.state.container.req(cid).stacks;
    sim.state.container.req(cid).stacks = [];
    expect(unitCapabilities(sim.state, cat, squad).bearers).toBeUndefined();
    sim.state.container.req(cid).stacks = stacks;
  });
});
