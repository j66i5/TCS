/** M5 review: the formation marker shows where the simulation will actually put the men (a wedge from the data). */
import { describe, expect, it } from "vitest";
import { demoBattle } from "@tcs/scenario";
import { createSim, step, submitOrder } from "@tcs/sim";
import { loadData } from "../../tools/src/scenarios";
import { addPoint, markerGeometry, newPlan, planToOrder, slotSpan } from "../src/planner";

describe("marker and simulation agree", () => {
  it("a wedge turned north, 40 m wide: each man ends within a few metres of his ring", () => {
    const data = loadData();
    const input = demoBattle(data, { seed: 3, factions: ["de", "ru"], mapWidthM: 600, mapHeightM: 400, timeLimitSeconds: 600 });
    input.forces[1]!.placements = input.forces[1]!.placements.map((p) => ({ ...p, x: 590, y: 390 }));
    const sim = createSim(input);
    const [uid, unit] = [...sim.state.unit.entries()].find(([, u]) => u.side === "blue" && u.parent === null)!;
    const men = [...sim.state.identity.entries()].filter(([, i]) => i.side === "blue").map(([id]) => id).sort((a, b) => a - b);
    const cx = men.reduce((a, m) => a + sim.state.transform.req(m).x, 0) / men.length, cy = men.reduce((a, m) => a + sim.state.transform.req(m).y, 0) / men.length;
    const formation = input.catalog.factions["de"]!.defaultFormation;
    const slots = input.catalog.formations[formation]!.slots;
    expect(slotSpan(slots, men.length)).toBeGreaterThan(0);
    let plan = newPlan("move", { x: cx, y: cy }, formation, 40);
    plan = addPoint(plan, cx + 150, cy - 20, "walk");
    plan = { ...plan, facing: -Math.PI / 2 };
    const g = markerGeometry(plan, slots, men.length, 10)!;
    submitOrder(sim, planToOrder(plan, "blue", uid, 0)!);
    for (let k = 0; k < 260 * 60; k++) step(sim); // (the last man of the wedge walks farthest)
    // Slot 0 is the leader, then the others in ID order (as systems/orders.ts assigns them).
    const leader = unit.leader!;
    const order = [leader, ...men.filter((m) => m !== leader)];
    order.forEach((m, i) => {
      const p = sim.state.transform.req(m), r = g.men[i]!;
      expect(Math.hypot(p.x - r.x, p.y - r.y), `man ${i}`).toBeLessThan(5); // cover is sought within 4 m
      expect(Math.abs(p.heading + Math.PI / 2)).toBeLessThan(0.3);
    });
  });
});
