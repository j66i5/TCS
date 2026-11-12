/** M4.3: squad drills — reaction to contact, assault by bounds, withdrawal, breaking and rallying. */
import { describe, expect, it } from "vitest";
import { createSim, hashState, loadSim, saveSim, secondsToTicks, step, submitOrder, type BattleInput, type Sim, type SimEvent } from "../src/index";
import { armedInput } from "./helpers";

const unitOf = (sim: Sim, side: string) => [...sim.state.unit.entries()].find(([, u]) => u.side === side)!;
function run(sim: Sim, seconds: number, each?: () => void): SimEvent[] {
  const out: SimEvent[] = [];
  for (let i = 0; i < secondsToTicks(seconds); i++) { each?.(); out.push(...step(sim)); }
  return out;
}
function setup(prep?: (i: BattleInput) => void): BattleInput {
  const input = armedInput(1, 900);
  input.rules.physiologyModel = "simple";
  input.forces[1]!.placements = input.forces[1]!.placements.map((p) => ({ ...p, x: 120 }));
  prep?.(input);
  return input;
}
const radioKeys = (ev: SimEvent[], side: string) => ev.filter((e) => e.kind === "radio" && e.side === side).map((e) => (e.kind === "radio" ? e.key : ""));

describe("squad drills (M4.3)", () => {
  it("a unit on the move that comes under fire halts, goes down and says so", () => {
    const sim = createSim(setup());
    const [bid, blue] = unitOf(sim, "blue");
    submitOrder(sim, { tick: 0, issuer: "blue", target: bid, kind: "move", waypoints: [{ x: 10, y: 190, mode: "walk" }] });
    run(sim, 5);
    submitOrder(sim, { tick: sim.state.tick, issuer: "red", target: unitOf(sim, "red")[0], kind: "fire", x: 10, y: 32, heightM: 1 });
    const ev = run(sim, 15);
    expect(radioKeys(ev, "blue")).toContain("radio.contactReact");
    expect(sim.state.unit.req(bid).moving).toBe(false);
    for (const m of blue.members) if (sim.state.soldier.req(m).casualty === "none") expect(sim.state.soldier.req(m).posture).toBe("prone");
    // They stopped well short of where they were going.
    for (const m of blue.members) expect(sim.state.transform.req(m).y).toBeLessThan(120);
  });

  it("an assault goes in by bounds: one half fires while the other runs; at the end all are on the objective", () => {
    const sim = createSim(setup());
    const [bid, blue] = unitOf(sim, "blue");
    submitOrder(sim, { tick: 0, issuer: "blue", target: bid, kind: "assault", x: 100, y: 15 });
    let overlap = 0;
    const ev: SimEvent[] = [];
    for (let k = 0; k < secondsToTicks(150) && !ev.some((e) => e.kind === "radio" && e.key === "radio.objectiveTaken"); k++) {
      const out = step(sim);
      ev.push(...out);
      // Covering fire while comrades are on the move.
      const movingNow = blue.members.filter((m) => (sim.state.mover.get(m)?.waypoints.length ?? 0) > 0);
      if (movingNow.length > 0 && out.some((e) => e.kind === "shot.fired" && blue.members.includes(e.shooter) && !movingNow.includes(e.shooter))) overlap++;
    }
    expect(radioKeys(ev, "blue")).toContain("radio.ack.assault");
    expect(radioKeys(ev, "blue")).toContain("radio.objectiveTaken");
    expect(overlap).toBeGreaterThan(3);
    for (const m of blue.members) {
      const t = sim.state.transform.req(m);
      expect(Math.hypot(t.x - 100, t.y - 15)).toBeLessThan(10);
    }
    expect(sim.state.unit.req(bid).drill).toBeNull();
  });

  it("a withdrawal bounds back to the rally point, the halt covering toward the enemy", () => {
    const sim = createSim(setup());
    const [bid, blue] = unitOf(sim, "blue");
    run(sim, 8); // they see the enemy
    submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: bid, kind: "withdraw", x: 10, y: 120 });
    const ev = run(sim, 120);
    expect(radioKeys(ev, "blue")).toContain("radio.withdrawn");
    expect(ev.some((e) => e.kind === "shot.fired" && blue.members.includes(e.shooter))).toBe(true);
    for (const m of blue.members) expect(sim.state.transform.req(m).y).toBeGreaterThan(105);
  });

  it("when half its men panic the unit breaks and runs back, deaf to orders; once it is quiet it rallies", () => {
    const sim = createSim(setup((i) => {
      i.forces[0]!.placements = i.forces[0]!.placements.map((p) => ({ ...p, x: 150 }));
      i.forces[1]!.placements = i.forces[1]!.placements.map((p) => ({ ...p, x: 190 }));
    }));
    const [bid, blue] = unitOf(sim, "blue");
    run(sim, 6);
    const [a, b] = blue.members as [number, number];
    sim.state.soldier.req(a).mental.stress = 1;
    sim.state.soldier.req(b).mental.stress = 1;
    const ev = run(sim, 3);
    expect(radioKeys(ev, "blue")).toContain("radio.broken");
    expect(sim.state.unit.req(bid).broken).toBe(true);
    for (const m of blue.members) expect(sim.state.soldier.req(m).mental.behaviour).toBe("routed");
    submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: bid, kind: "move", waypoints: [{ x: 150, y: 100, mode: "walk" }] });
    const later = run(sim, 120);
    expect(radioKeys(later, "blue")).toContain("radio.unable");
    expect(radioKeys(later, "blue")).toContain("radio.rallied");
    for (const m of blue.members) {
      expect(sim.state.transform.req(m).x).toBeLessThan(60); // well away from the enemy at x = 190
      expect(sim.state.soldier.req(m).mental.behaviour).not.toBe("routed");
    }
    expect(sim.state.unit.req(bid).broken).toBe(false);
  });

  it("drills are deterministic across save and load", () => {
    const input = setup();
    const sim = createSim(input);
    submitOrder(sim, { tick: 0, issuer: "blue", target: unitOf(sim, "blue")[0], kind: "assault", x: 100, y: 15 });
    run(sim, 20);
    const copy = loadSim({ ...input, orders: [] }, saveSim(sim));
    run(sim, 30); run(copy, 30);
    expect(hashState(copy.state)).toBe(hashState(sim.state));
  });
});
