import { describe, expect, it } from "vitest";
import { createSim, secondsToTicks, step, submitOrder, type Sim } from "../src/index";
import { testInput } from "./helpers";

const first = (sim: Sim) => [...sim.state.unit.entries()].find(([, u]) => u.side === "blue")![1].members[0]!;

describe("body: posture and physiology", () => {
  it("a posture order stops the man and completes after the posture-change time (load counts)", () => {
    const sim = createSim(testInput()); // each man carries 3 magazines (~1.4 kg): below the free load
    const id = first(sim);
    submitOrder(sim, { tick: 0, issuer: "blue", target: id, kind: "posture", posture: "prone" });
    const ev = [];
    for (let i = 0; i < secondsToTicks(1) + secondsToTicks(1.0) + 5; i++) ev.push(...step(sim));
    const changed = ev.find((e) => e.kind === "posture.changed");
    expect(changed).toMatchObject({ soldier: id, posture: "prone" });
    // delivered at tick 60 (1 s comms delay), then 1.0 s to go prone
    expect(changed!.tick).toBe(60 + 60);
    expect(sim.state.soldier.req(id).posture).toBe("prone");
  });

  it("moving in a crawl mode first goes prone, and does not move while changing posture", () => {
    const sim = createSim(testInput());
    const id = first(sim);
    const x0 = sim.state.transform.req(id).x;
    submitOrder(sim, { tick: 0, issuer: "blue", target: id, kind: "move", waypoints: [{ x: x0 + 20, y: sim.state.transform.req(id).y, mode: "crawl" }] });
    for (let i = 0; i < 60 + 30; i++) step(sim); // delivered at 60, half-way through going prone
    expect(sim.state.transform.req(id).x).toBe(x0);
    for (let i = 0; i < 60; i++) step(sim);
    expect(sim.state.soldier.req(id).posture).toBe("prone");
    expect(sim.state.transform.req(id).x).toBeGreaterThan(x0);
  });

  it("heat makes running more tiring (environment is read by the fatigue model)", () => {
    const fatigueAfterRun = (tempC: number) => {
      const input = testInput(1, 600);
      input.environment = { timeOfDaySeconds: 43200, light: 1, windX: 0, windY: 0, rain: 0, visibilityM: 10000, temperatureC: tempC };
      const sim = createSim(input);
      const id = first(sim);
      submitOrder(sim, { tick: 0, issuer: "blue", target: id, kind: "move", waypoints: [{ x: 199, y: 10, mode: "run" }] });
      for (let i = 0; i < secondsToTicks(50); i++) step(sim);
      return sim.state.soldier.req(id).physical.fatigue;
    };
    expect(fatigueAfterRun(35)).toBeGreaterThan(fatigueAfterRun(15) * 1.2);
  });
});
