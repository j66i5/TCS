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

  /** A shaken unit hesitating over a move (its seq and the hesitation event). */
  function hesitating(sim: Sim): { seq: number; until: number } {
    shake(sim);
    const seq = move(sim, 60, 150);
    const h = run(sim, 1.5).find((e) => e.kind === "order.hesitating");
    if (h?.kind !== "order.hesitating") throw new Error("no hesitation");
    return { seq, until: h.deliverTick };
  }

  it("orders that neither move nor stop them leave the hesitating move pending (review F5, F10, F15)", () => {
    for (const body of [{ kind: "posture", posture: "crouching" }, { kind: "ambush", rangeM: 100 }, { kind: "ceaseFire" }, { kind: "rules", fire: "hold" }] as const) {
      const sim = createSim(setup());
      const { seq } = hesitating(sim);
      submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: unitOf(sim, "blue")[0], ...body } as never);
      const ev = run(sim, 1.5);
      expect(ev.some((e) => e.kind === "order.rejected"), body.kind).toBe(false);
      expect(sim.state.pendingOrders.some((p) => p.seq === seq), body.kind).toBe(true);
      const later = run(sim, 12);
      expect(later.some((e) => e.kind === "order.delivered" && e.seq === seq), body.kind).toBe(true);
    }
  });

  it("a fire order replaces the move they hesitate over: it is not undone later, and the move is reported over (review F14, F16)", () => {
    const sim = createSim(setup());
    const at = where(sim);
    const { seq } = hesitating(sim);
    const fire = submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: unitOf(sim, "blue")[0], kind: "fire", x: 190, y: 15, heightM: 1 });
    const ev = run(sim, 1.5);
    const rej = ev.find((e) => e.kind === "order.rejected");
    expect(rej?.kind === "order.rejected" && rej.seq === seq && rej.reason === "superseded").toBe(true);
    expect(ev.some((e) => e.kind === "order.delivered" && e.seq === fire)).toBe(true);
    const later = run(sim, 12);
    expect(later.some((e) => e.kind === "order.delivered" && e.seq === seq)).toBe(false);
    expect(sim.state.pendingOrders.length).toBe(0);
    expect(moved(sim, at)).toBe(false);
  });

  it("an order to one of the men lets the unit's hesitating move go first, in the same tick (review F13)", () => {
    const sim = createSim(setup());
    const { seq } = hesitating(sim);
    const man = unitOf(sim, "blue")[1].members[1]!;
    const mine = submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: man, kind: "posture", posture: "prone" });
    // (A posture leaves it pending; a move to him lets it go first.)
    run(sim, 1.5);
    expect(sim.state.pendingOrders.some((p) => p.seq === seq)).toBe(true);
    const his = submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: man, kind: "move", waypoints: [{ x: 20, y: 40, mode: "walk" }] });
    const ev = run(sim, 1.5);
    expect(mine).toBeLessThan(his);
    const unitMove = ev.findIndex((e) => e.kind === "order.delivered" && e.seq === seq);
    const manMove = ev.findIndex((e) => (e.kind === "order.delivered" || e.kind === "order.hesitating") && e.seq === his);
    expect(unitMove).toBeGreaterThanOrEqual(0);
    expect(manMove).toBeGreaterThan(unitMove);
    expect(ev[unitMove]!.tick).toBe(ev[manMove]!.tick);
    expect(ev.some((e) => e.kind === "order.rejected")).toBe(false);
  });

  it("with `own`: an order to a sub-unit does not touch a headquarters-only move; one to its man lets it go first (review F13)", () => {
    const input = setup();
    const blue = input.forces[0]!.units[0]!;
    const sub = { ...blue, key: "c", callsign: "c", members: blue.members.splice(1), subunits: [] };
    blue.subunits = [sub];
    blue.echelon = "platoon";
    const sim = createSim(input);
    const [pid, platoon] = [...sim.state.unit.entries()].find(([, u]) => u.side === "blue" && u.parent === null)!;
    const [cid] = [...sim.state.unit.entries()].find(([, u]) => u.side === "blue" && u.parent === pid)!;
    shake(sim);
    const hq = submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: pid, own: true, kind: "move", waypoints: [{ x: 60, y: 150, mode: "walk" }] });
    expect(run(sim, 1.5).some((e) => e.kind === "order.hesitating" && e.seq === hq)).toBe(true);
    submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: cid, kind: "halt" });
    run(sim, 1.5);
    expect(sim.state.pendingOrders.some((p) => p.seq === hq)).toBe(true);
    submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: platoon.members[0]!, kind: "halt" });
    const ev = run(sim, 1.5);
    expect(ev.some((e) => e.kind === "order.delivered" && e.seq === hq)).toBe(true);
    expect(ev.some((e) => e.kind === "order.rejected")).toBe(false);
  });

  it("a newer move to the whole unit replaces the hesitating order and says so (review F16)", () => {
    const sim = createSim(setup());
    const { seq } = hesitating(sim);
    move(sim, 100, 20);
    const ev = run(sim, 1.5);
    expect(ev.filter((e) => e.kind === "order.rejected").map((e) => (e.kind === "order.rejected" ? [e.seq, e.reason, e.issuer] : []))).toEqual([[seq, "superseded", "blue"]]);
  });
});
