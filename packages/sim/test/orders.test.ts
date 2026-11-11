import { describe, expect, it } from "vitest";
import {
  actionSystem, createSim, EventSink, secondsToTicks, startAction, step, submitOrder, countItems, type SimEvent, type Sim,
} from "../src/index";
import { testInput } from "./helpers";

function runTicks(sim: Sim, n: number): SimEvent[] {
  const all: SimEvent[] = [];
  for (let i = 0; i < n; i++) all.push(...step(sim));
  return all;
}
const blueUnit = (sim: Sim) => [...sim.state.unit.entries()].find(([, u]) => u.side === "blue")![0];

describe("orders", () => {
  it("are received, delayed by the comms model, delivered and acknowledged by radio", () => {
    const sim = createSim(testInput());
    const unit = blueUnit(sim);
    submitOrder(sim, { tick: 0, issuer: "blue", target: unit, kind: "move", waypoints: [{ x: 40, y: 10, mode: "walk" }] });
    const ev = runTicks(sim, secondsToTicks(1) + 1);
    const rec = ev.find((e) => e.kind === "order.received");
    const del = ev.find((e) => e.kind === "order.delivered");
    expect(rec).toMatchObject({ tick: 0, deliverTick: 60 });
    expect(del).toMatchObject({ tick: 60, orderKind: "move" });
    expect(ev.find((e) => e.kind === "radio")).toMatchObject({ key: "radio.ack.move", side: "blue" });
  });

  it("moves the unit, keeping each man's offset, and reports arrival", () => {
    const sim = createSim(testInput());
    const unit = blueUnit(sim);
    const men = sim.state.unit.req(unit).members;
    const before = men.map((m) => ({ ...sim.state.transform.req(m) }));
    submitOrder(sim, { tick: 0, issuer: "blue", target: unit, kind: "move", waypoints: [{ x: 40, y: 10, mode: "walk" }] });
    // 30 m at 1.5 m/s = 20 s, plus 1 s delay.
    const ev = runTicks(sim, secondsToTicks(22));
    const arrived = ev.find((e) => e.kind === "unit.arrived");
    expect(arrived).toBeDefined();
    expect(arrived!.tick).toBeGreaterThanOrEqual(secondsToTicks(21) - 1);
    expect(arrived!.tick).toBeLessThanOrEqual(secondsToTicks(21) + 1);
    men.forEach((m, i) => {
      const t = sim.state.transform.req(m);
      expect(t.x).toBeCloseTo(before[i]!.x + 30, 6);
      expect(t.y).toBeCloseTo(before[i]!.y, 6);
    });
  });

  it("rejects orders for the other side's units, late orders and off-map waypoints", () => {
    const sim = createSim(testInput());
    const unit = blueUnit(sim);
    runTicks(sim, 10);
    submitOrder(sim, { tick: 10, issuer: "red", target: unit, kind: "halt" });
    submitOrder(sim, { tick: 5, issuer: "blue", target: unit, kind: "halt" });
    submitOrder(sim, { tick: 10, issuer: "blue", target: unit, kind: "move", waypoints: [{ x: 9999, y: 0, mode: "walk" }] });
    submitOrder(sim, { tick: 10, issuer: "blue", target: unit, kind: "move", waypoints: [{ x: 50, y: 0, mode: "teleport" }] });
    submitOrder(sim, { tick: 10, issuer: "blue", target: 99999, kind: "halt" });
    const ev = runTicks(sim, 1).filter((e) => e.kind === "order.rejected");
    expect(ev.map((e) => (e.kind === "order.rejected" ? e.reason : ""))).toEqual([
      "not-your-unit", "late", "invalid-params", "invalid-params", "unknown-target",
    ]);
  });

  it("holds future orders in the inbox until their tick", () => {
    const sim = createSim(testInput());
    const unit = blueUnit(sim);
    submitOrder(sim, { tick: 30, issuer: "blue", target: unit, kind: "halt" });
    const ev = runTicks(sim, 31);
    expect(ev.find((e) => e.kind === "order.received")?.tick).toBe(30);
  });

  it("ends the battle at the time limit and then ignores further steps", () => {
    const sim = createSim(testInput(1, 2));
    const ev = runTicks(sim, 200);
    expect(ev.filter((e) => e.kind === "battle.ended")).toHaveLength(1);
    expect(sim.state.tick).toBe(120);
  });
});

describe("actions with duration", () => {
  it("transfers items on completion and can be interrupted", () => {
    const sim = createSim(testInput());
    const unit = sim.state.unit.req(blueUnit(sim));
    const [a, b] = unit.members as [number, number];
    // Place b next to a.
    sim.state.transform.req(b).x = sim.state.transform.req(a).x + 1;
    sim.state.transform.req(b).y = sim.state.transform.req(a).y;
    const events = new EventSink();
    startAction(sim.state, events, a, "transferItems", 120, { to: b, item: "mag", count: 2 });
    for (let i = 0; i < 121; i++) { actionSystem(sim.ctx, sim.state, events); sim.state.tick++; }
    expect(countItems(sim.state.container.req(a), "mag")).toBe(1);
    expect(countItems(sim.state.container.req(b), "mag")).toBe(5);
    expect(events.events.map((e) => e.kind)).toEqual(["action.started", "items.transferred", "action.completed"]);

    // Now interrupted: b walks away before the hand-over completes.
    const ev2 = new EventSink();
    startAction(sim.state, ev2, a, "transferItems", 120, { to: b, item: "mag", count: 1 });
    actionSystem(sim.ctx, sim.state, ev2);
    sim.state.transform.req(b).x += 10;
    actionSystem(sim.ctx, sim.state, ev2);
    expect(ev2.events.at(-1)).toMatchObject({ kind: "action.interrupted", reason: "out-of-reach" });
    expect(countItems(sim.state.container.req(a), "mag")).toBe(1);
  });
});
