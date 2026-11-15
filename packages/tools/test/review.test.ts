/** M9.6: review rows for drones, enemies found, fire missions by location method, the light (sim/src/review.ts). */
import { describe, expect, it } from "vitest";
import { buildScenario } from "@tcs/scenario";
import { createSim, environmentAt, newReviewTally, step, submitOrder, tallyReview, type ReviewTally } from "@tcs/sim";
import { loadData } from "../src/scenarios";

const data = loadData();
const platoon = () => buildScenario(data, { kind: "platoon-attack", seed: 1, mapKind: "village", factions: ["de", "ru"], attacker: "blue", timeLimitSeconds: 900 });

describe("review tally (M9.6)", () => {
  it("a drone over the objective: flown, finds enemies first, and the fire mission it locates counts under drone", () => {
    const input = platoon();
    const sim = createSim(input);
    const top = [...sim.state.unit.entries()].find(([, u]) => u.side === "blue" && u.parent === null)![0];
    const obj = input.rules.objectives[0]!;
    const t = newReviewTally();
    let launchedItem: string | undefined;
    const tick = () => { const ev = step(sim); for (const e of ev) if (e.kind === "drone.launched") launchedItem = e.item; tallyReview(t, ev, sim.state); };
    submitOrder(sim, { tick: 0, issuer: "blue", target: top, kind: "drone", op: "fly", x: obj.x - 60, y: obj.y, altM: 100 });
    for (let k = 0; k < 400 * 60 && ![...sim.state.drone.values()].some((d) => d.mode === "hover"); k++) tick();
    submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: top, kind: "callFire", x: obj.x, y: obj.y, ammo: "he", rounds: 2 });
    for (let k = 0; k < 240 * 60; k++) tick();
    const blue = t.sides["blue"]!;
    expect(blue.drones.launched).toBeGreaterThanOrEqual(1);
    expect(blue.found.byDrone).toBeGreaterThan(0);
    expect(blue.found.total).toBeGreaterThanOrEqual(blue.found.byDrone);
    expect(blue.seen.length).toBe(blue.found.total);
    expect([...blue.seen].sort((a, b) => a - b)).toEqual(blue.seen);
    expect(blue.calls.drone).toBe(1);
    expect(blue.rounds.drone ?? 0).toBeGreaterThan(0);
    expect(t.light).toBeNull(); // no sky: no light rows
    // Plain JSON: it survives the app's save.
    expect(JSON.parse(JSON.stringify(t)) as ReviewTally).toEqual(t);
    expect(input.catalog.items[launchedItem ?? ""]?.drone).toBeDefined();
  });

  it("a drone shot down counts for its side and as an enemy drone downed for the shooter's side; light follows the sky", () => {
    const input = platoon();
    input.environment = environmentAt(input.catalog, 22 * 3600, 0.2);
    const sim = createSim(input);
    const redMan = [...sim.state.identity.entries()].find(([, i]) => i.side === "red")![0];
    const t = newReviewTally();
    tallyReview(t, [
      { kind: "drone.launched", tick: 0, drone: 9999, operator: 1, side: "blue", item: "x" },
      { kind: "drone.lost", tick: 1, drone: 9999, side: "blue", reason: "shot", by: redMan },
      { kind: "drone.lost", tick: 2, drone: 9998, side: "blue", reason: "battery" },
      { kind: "drone.lost", tick: 3, drone: 9997, side: "red", reason: "shot" },
    ], sim.state);
    expect(t.sides["blue"]!.drones).toEqual({ launched: 1, landed: 0, lostBattery: 1, lostNoOperator: 0, shotDown: 1, downedEnemy: 1 });
    expect(t.sides["red"]!.drones.downedEnemy).toBe(1);
    expect(t.sides["red"]!.drones.shotDown).toBe(1);
    expect(t.light).not.toBeNull();
    expect(t.light!.start).toBeLessThan(1);
    expect(t.light!.min).toBeLessThanOrEqual(t.light!.start);
  });
});
