/** Ammunition expenditure for the after-action review and the batch report (M7.3, plan C4). */
import { describe, expect, it } from "vitest";
import { createSim, step, submitOrder, tallyExpenditure, TICK_HZ, type Expenditure } from "@tcs/sim";
import { duel } from "../src/labs/gunnery";
import { loadData } from "../src/scenarios";

describe("expenditure tally", () => {
  it("cannon rounds are credited to the vehicle, not the gunner; smoke salvos too", () => {
    const data = loadData();
    const sim = createSim(duel(data, ["de", "ru"], { blue: { x: 400, y: 600, heading: 0 }, red: { x: 1200, y: 600, heading: Math.PI / 2 } }));
    const [vid, v] = [...sim.state.vehicle.entries()].find(([, x]) => x.side === "blue")!;
    for (const [uid, u] of sim.state.unit.entries()) if (u.parent === null) submitOrder(sim, { tick: 0, issuer: u.side, target: uid, kind: "rules", fire: "hold" });
    submitOrder(sim, { tick: 0, issuer: "blue", target: v.unit!, kind: "fire", x: 1200, y: 600, heightM: 1.2, nature: "ap" });
    submitOrder(sim, { tick: 0, issuer: "blue", target: v.unit!, kind: "discharge" });
    const exp: Expenditure = {};
    let fired = 0;
    for (let i = 0; i < 20 * TICK_HZ; i++) {
      const ev = step(sim);
      fired += ev.filter((e) => e.kind === "shot.fired" && e.vehicle === vid).length;
      tallyExpenditure(exp, ev, sim.state, sim.ctx.catalog);
    }
    expect(fired).toBeGreaterThan(0);
    const blue = exp["blue"]!;
    expect(blue.smallArms).toBe(0);
    const mine = blue.vehicles[v.vehicleId]!;
    expect(Object.values(mine.cannon).reduce((a, b) => a + b, 0)).toBe(fired);
    expect(Object.keys(mine.cannon)).toEqual(["de-30x173-pmc287"]);
    expect(mine.coax).toBe(0);
    expect(mine.smoke).toBe(1);
  });
});
