/** D4b: shaken men hesitate before obeying an order to move (SPEC 6.6, "obey, hesitate or refuse"). */
import { describe, expect, it } from "vitest";
import { createSim, hashState, loadSim, saveSim, secondsToTicks, step, submitOrder, type BattleInput, type Sim, type SimEvent } from "../src/index";
import { testInput } from "./helpers";

const HESITATION = { kinds: ["move", "assault", "occupy"], shakenShare: 0.5, baseSeconds: 3, perSuppressionSeconds: 8, maxSeconds: 10 };
const unitOf = (sim: Sim, side: string) => [...sim.state.unit.entries()].find(([, u]) => u.side === side)!;
function run(sim: Sim, seconds: number): SimEvent[] {
  const out: SimEvent[] = [];
  for (let i = 0; i < secondsToTicks(seconds); i++) out.push(...step(sim));
  return out;
}
function setup(): BattleInput {
  const input = testInput(1, 300);
  input.catalog = { ...input.catalog, behaviour: { ...input.catalog.behaviour, hesitation: HESITATION } };
  return input;
}
const radioKeys = (ev: SimEvent[], side: string) => ev.filter((e) => e.kind === "radio" && e.side === side).map((e) => (e.kind === "radio" ? e.key : ""));
/** Blue's men shaken (stress between shaken and panicked) and under some fire. */
function shake(sim: Sim): void {
  for (const m of unitOf(sim, "blue")[1].members) { const s = sim.state.soldier.req(m).mental; s.stress = 0.7; s.suppression = 0.3; }
  run(sim, 1);
  for (const m of unitOf(sim, "blue")[1].members) expect(sim.state.soldier.req(m).mental.behaviour).toBe("shaken");
}
const where = (sim: Sim) => new Map(unitOf(sim, "blue")[1].members.map((m) => [m, { ...sim.state.transform.req(m) }] as const));
const moved = (sim: Sim, from: Map<number, { x: number; y: number }>) =>
  [...from].some(([m, p]) => { const t = sim.state.transform.req(m); return Math.hypot(t.x - p.x, t.y - p.y) > 0.5; });
const move = (sim: Sim, x: number, y: number) =>
  submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: unitOf(sim, "blue")[0], kind: "move", waypoints: [{ x, y, mode: "walk" }] });

describe("order hesitation (D4b)", () => {
  it("shaken men answer 'in a moment', stay put, then obey", () => {
    const sim = createSim(setup());
    shake(sim);
    const at = where(sim);
    move(sim, 60, 150);
    const ev = run(sim, 2.5);
    expect(radioKeys(ev, "blue")).toContain("radio.hesitate");
    expect(radioKeys(ev, "blue")).not.toContain("radio.ack.move");
    const h = ev.find((e) => e.kind === "order.hesitating");
    expect(h?.kind === "order.hesitating" && h.deliverTick > sim.state.tick).toBe(true);
    expect(moved(sim, at)).toBe(false);
    const later = run(sim, 12);
    expect(radioKeys(later, "blue")).toContain("radio.ack.move");
    expect(radioKeys(later, "blue")).not.toContain("radio.hesitate"); // once per order
    expect(moved(sim, at)).toBe(true);
  });

  it("steady men obey at once", () => {
    const sim = createSim(setup());
    run(sim, 1);
    move(sim, 60, 150);
    const ev = run(sim, 2.5);
    expect(radioKeys(ev, "blue")).toContain("radio.ack.move");
    expect(radioKeys(ev, "blue")).not.toContain("radio.hesitate");
  });

  it("a withdrawal never waits; without the data nobody hesitates", () => {
    const sim = createSim(setup());
    shake(sim);
    submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: unitOf(sim, "blue")[0], kind: "withdraw", x: 10, y: 150 });
    const ev = run(sim, 2.5);
    expect(radioKeys(ev, "blue")).toContain("radio.ack.withdraw");
    expect(radioKeys(ev, "blue")).not.toContain("radio.hesitate");
    const off = createSim(testInput(1, 300));
    shake(off);
    move(off, 60, 150);
    expect(radioKeys(run(off, 2.5), "blue")).toContain("radio.ack.move");
  });

  it("a newer order replaces the one they hesitate over, at the same moment; a change of rules does not", () => {
    const sim = createSim(setup());
    shake(sim);
    const [bid] = unitOf(sim, "blue");
    const first = move(sim, 60, 150);
    const h = run(sim, 1.5).find((e) => e.kind === "order.hesitating");
    if (h?.kind !== "order.hesitating") throw new Error("no hesitation");
    submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: bid, kind: "rules", fire: "hold" });
    run(sim, 1.5);
    expect(sim.state.pendingOrders.some((p) => p.seq === first)).toBe(true);
    move(sim, 100, 20);
    const ev = run(sim, 1.5);
    expect(radioKeys(ev, "blue")).not.toContain("radio.hesitate"); // they are hesitating already
    const pending = sim.state.pendingOrders.filter((p) => p.order.kind === "move");
    expect(pending.length).toBe(1);
    expect(pending[0]!.seq).not.toBe(first);
    expect(pending[0]!.deliverTick).toBe(h.deliverTick);
    const later = run(sim, 12);
    expect(later.filter((e) => e.kind === "order.delivered" && e.orderKind === "move").length).toBe(1);
  });

  it("save and load in the middle of a hesitation stays deterministic", () => {
    const input = setup();
    const sim = createSim(input);
    shake(sim);
    move(sim, 60, 150);
    run(sim, 2.5);
    expect(sim.state.pendingOrders.some((p) => p.hesitated === true)).toBe(true);
    const copy = loadSim({ ...input, orders: [] }, saveSim(sim));
    run(sim, 15); run(copy, 15);
    expect(hashState(copy.state)).toBe(hashState(sim.state));
  });
});
