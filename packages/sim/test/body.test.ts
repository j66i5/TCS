import { describe, expect, it } from "vitest";
import { createSim, requestPosture, secondsToTicks, step, submitOrder, type Sim } from "../src/index";
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

  it("an exhausted runner slows down and recovers in bursts instead of staying spent (review finding)", () => {
    const input = testInput(1, 1200);
    input.map = { ...input.map };
    const sim = createSim(input);
    const id = first(sim);
    sim.state.soldier.req(id).physical.fatigue = 0.95;
    const y = sim.state.transform.req(id).y;
    submitOrder(sim, { tick: 0, issuer: "blue", target: id, kind: "move", waypoints: [{ x: 195, y, mode: "run" }, { x: 5, y, mode: "run" }, { x: 195, y, mode: "run" }] });
    let minF = 1;
    // keep him running back and forth for 6 minutes
    for (let i = 0; i < secondsToTicks(360); i++) {
      step(sim);
      minF = Math.min(minF, sim.state.soldier.req(id).physical.fatigue);
      if (sim.state.mover.req(id).waypoints.length === 0) submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: id, kind: "move", waypoints: [{ x: sim.state.transform.req(id).x > 100 ? 5 : 195, y, mode: "run" }] });
    }
    expect(minF).toBeLessThan(0.65); // recovered down to the run-again level, then runs again
  });

  it("cancelling a posture change before it completes reports nothing and keeps the posture", () => {
    const sim = createSim(testInput());
    const id = first(sim);
    requestPosture(sim.ctx, sim.state, id, "prone");
    for (let i = 0; i < 20; i++) step(sim); // part-way down
    requestPosture(sim.ctx, sim.state, id, "standing"); // changes his mind
    const ev = [];
    for (let i = 0; i < 200; i++) ev.push(...step(sim));
    expect(ev.filter((e) => e.kind === "posture.changed")).toEqual([]);
    expect(sim.state.soldier.req(id).posture).toBe("standing");
  });

  it("a posture order ends a move without an 'in position' call", () => {
    const sim = createSim(testInput());
    const id = first(sim);
    const unit = sim.state.identity.req(id).unit;
    submitOrder(sim, { tick: 0, issuer: "blue", target: unit, kind: "move", waypoints: [{ x: 150, y: 10, mode: "walk" }] });
    const ev = [];
    for (let i = 0; i < 120; i++) ev.push(...step(sim)); // moving
    submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: unit, kind: "posture", posture: "prone" });
    for (let i = 0; i < 400; i++) ev.push(...step(sim));
    expect(ev.some((e) => e.kind === "unit.arrived")).toBe(false);
    expect(sim.state.soldier.req(id).posture).toBe("prone");
  });

  it("rejects an order with an unknown waypoint posture", () => {
    const sim = createSim(testInput());
    const id = first(sim);
    submitOrder(sim, { tick: 0, issuer: "blue", target: id, kind: "move", waypoints: [{ x: 60, y: 10, mode: "walk", posture: "kneeling" as "prone" }] });
    expect(step(sim).find((e) => e.kind === "order.rejected")).toMatchObject({ reason: "invalid-params" });
  });
});
