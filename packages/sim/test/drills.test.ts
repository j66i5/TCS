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

describe("drills after the review (M4)", () => {
  it("when one half of an assault is down, the survivors split again and keep bounding (no single charge)", () => {
    const sim = createSim(setup((i) => { i.forces[0]!.units[0]!.members.push(...[3, 4].map((k) => ({ ...i.forces[0]!.units[0]!.members[0]!, personId: `a.${k}`, family: `a${k}` }))); i.forces[0]!.placements.push({ personId: "a.3", x: 10, y: 25, heading: 0 }, { personId: "a.4", x: 10, y: 30, heading: 0 }); }));
    const [bid] = unitOf(sim, "blue");
    submitOrder(sim, { tick: 0, issuer: "blue", target: bid, kind: "assault", x: 110, y: 15 });
    run(sim, 3);
    const d = sim.state.unit.req(bid).drill!;
    // Knock out the whole second half.
    for (const m of d.groups[1]!) { sim.state.soldier.req(m).physiology.alive = false; sim.state.soldier.req(m).casualty = "killed"; sim.state.soldier.req(m).mental.behaviour = "incapacitated"; }
    run(sim, 45);
    const dd = sim.state.unit.req(bid).drill;
    expect(dd).not.toBeNull();
    expect(dd!.final).toBe(false);
    expect(dd!.groups.filter((g) => g.some((m) => sim.state.soldier.req(m).casualty === "none")).length).toBe(2);
  });

  it("an assault order to a single man is rejected; an order to one man takes him out of his unit's drill", () => {
    const sim = createSim(setup());
    const [bid, blue] = unitOf(sim, "blue");
    const ev = run(sim, 0);
    submitOrder(sim, { tick: 0, issuer: "blue", target: blue.members[0]!, kind: "assault", x: 100, y: 15 });
    ev.push(...run(sim, 1));
    expect(ev.some((e) => e.kind === "order.rejected" && e.reason === "invalid-params")).toBe(true);
    submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: bid, kind: "assault", x: 100, y: 15 });
    run(sim, 3);
    const man = blue.members[1]!;
    submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: man, kind: "halt" });
    run(sim, 3);
    expect(sim.state.unit.req(bid).drill!.groups.flat()).not.toContain(man);
    const at = { ...sim.state.transform.req(man) };
    run(sim, 30);
    expect(Math.hypot(sim.state.transform.req(man).x - at.x, sim.state.transform.req(man).y - at.y)).toBeLessThan(0.5);
  });

  it("a bound never carries the runners past the start of the last rush", () => {
    const input = setup();
    const b = input.catalog.behaviour;
    input.catalog = { ...input.catalog, behaviour: { ...b, drills: { ...b.drills, boundM: 60, finalM: 10 } } };
    // (The test factions have no doctrine values for bounds: the general ones apply.)
    const sim = createSim(input);
    const [bid, blue] = unitOf(sim, "blue");
    submitOrder(sim, { tick: 0, issuer: "blue", target: bid, kind: "assault", x: 60, y: 15 });
    let maxX = 0;
    for (let k = 0; k < secondsToTicks(60) && sim.state.unit.req(bid).drill?.final !== true; k++) { step(sim); for (const m of blue.members) maxX = Math.max(maxX, sim.state.transform.req(m).x); }
    expect(maxX).toBeLessThan(60 - 10 + 3);
  });

  it("a runner pinned on the way does not hold the next rush (balance pass 2026-11-13)", () => {
    const sim = createSim(setup());
    const [bid] = unitOf(sim, "blue");
    submitOrder(sim, { tick: 0, issuer: "blue", target: bid, kind: "assault", x: 100, y: 15 });
    // Wait for the first bound to start, then pin one of its runners for good.
    for (let k = 0; k < secondsToTicks(10) && (sim.state.unit.req(bid).drill?.phaseTick ?? -1) < 0; k++) step(sim);
    const d = sim.state.unit.req(bid).drill!;
    const first = d.mover, pinned = d.groups[first]![0]!;
    let swapped = -1;
    for (let k = 0; k < secondsToTicks(40) && swapped < 0; k++) {
      const s = sim.state.soldier.req(pinned);
      s.mental.suppression = 1; s.mental.behaviour = "pinned";
      step(sim);
      if (sim.state.unit.req(bid).drill?.mover !== first) swapped = k;
    }
    expect(swapped).toBeGreaterThan(0);
    expect(swapped).toBeLessThan(secondsToTicks(sim.ctx.catalog.behaviour.drills.phaseTimeoutSeconds) / 2);
  });
});
