/** M5.1: standing rules (engagement range, stance on contact, ammunition discipline) and the laid-out formation. */
import { describe, expect, it } from "vitest";
import { createSim, secondsToTicks, step, submitOrder, type BattleInput, type Sim, type SimEvent } from "../src/index";
import { armedInput } from "./helpers";

const unitOf = (sim: Sim, side: string) => [...sim.state.unit.entries()].find(([, u]) => u.side === side)!;
function run(sim: Sim, seconds: number): SimEvent[] {
  const out: SimEvent[] = [];
  for (let i = 0; i < secondsToTicks(seconds); i++) out.push(...step(sim));
  return out;
}
function setup(prep?: (i: BattleInput) => void): BattleInput {
  const input = armedInput(1, 900);
  input.rules.physiologyModel = "simple";
  input.forces[1]!.placements = input.forces[1]!.placements.map((p) => ({ ...p, x: 120 }));
  prep?.(input);
  return input;
}
const blueShots = (sim: Sim, ev: SimEvent[]) => ev.filter((e) => e.kind === "shot.fired" && sim.state.identity.get(e.shooter)?.side === "blue").length;

describe("standing rules (M5.1)", () => {
  it("an engagement range limit holds their own fire until the enemy is closer", () => {
    for (const [limit, expectFire] of [[80, false], [0, true]] as const) {
      const sim = createSim(setup());
      submitOrder(sim, { tick: 0, issuer: "blue", target: unitOf(sim, "blue")[0], kind: "rules", fire: "free", maxEngageM: limit });
      const n = blueShots(sim, run(sim, 30));
      if (expectFire) expect(n).toBeGreaterThan(3); else expect(n).toBe(0);
    }
  });

  it("a range limit set while they are already firing on their own stops fire beyond it", () => {
    const sim = createSim(setup());
    const [bid, blue] = unitOf(sim, "blue");
    submitOrder(sim, { tick: 0, issuer: "blue", target: bid, kind: "rules", fire: "free" });
    run(sim, 20);
    expect(blue.members.some((m) => sim.state.fire.get(m)?.self)).toBe(true);
    submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: bid, kind: "rules", maxEngageM: 50 });
    run(sim, 5);
    expect(blue.members.some((m) => sim.state.fire.get(m)?.self)).toBe(false);
    expect(blueShots(sim, run(sim, 15))).toBe(0);
  });

  it("only the rules given change", () => {
    const sim = createSim(setup());
    const [bid] = unitOf(sim, "blue");
    submitOrder(sim, { tick: 0, issuer: "blue", target: bid, kind: "rules", fire: "free" });
    run(sim, 2);
    submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: bid, kind: "rules", ammo: "conserve" });
    run(sim, 2);
    const u = sim.state.unit.req(bid);
    expect(u.fireRule).toBe("free");
    expect(u.ammoRule).toBe("conserve");
    expect(u.onContact).toBe("ground");
  });

  it("ammunition discipline: conserve fires fewer rounds than normal, maximum more", () => {
    const shots = (ammo: "conserve" | "normal" | "max") => {
      const sim = createSim(setup());
      const [bid] = unitOf(sim, "blue");
      submitOrder(sim, { tick: 0, issuer: "blue", target: bid, kind: "rules", ammo });
      submitOrder(sim, { tick: 0, issuer: "blue", target: bid, kind: "fire", x: 120, y: 100, heightM: 1 });
      return blueShots(sim, run(sim, 25));
    };
    const c = shots("conserve"), n = shots("normal"), m = shots("max");
    expect(c).toBeLessThan(n);
    expect(m).toBeGreaterThan(n);
  });

  it("on contact: 'push' keeps moving; 'back' falls back away from the enemy", () => {
    const go = (onContact: "push" | "back") => {
      // Blue starts at x = 120, red at x = 190 (east).
      const sim = createSim(setup((i) => {
        i.forces[0]!.placements = i.forces[0]!.placements.map((p) => ({ ...p, x: 120 }));
        i.forces[1]!.placements = i.forces[1]!.placements.map((p) => ({ ...p, x: 190 }));
      }));
      const [bid, blue] = unitOf(sim, "blue");
      submitOrder(sim, { tick: 0, issuer: "blue", target: bid, kind: "rules", onContact });
      submitOrder(sim, { tick: 0, issuer: "blue", target: bid, kind: "move", waypoints: [{ x: 130, y: 190, mode: "walk" }] });
      run(sim, 5);
      submitOrder(sim, { tick: sim.state.tick, issuer: "red", target: unitOf(sim, "red")[0], kind: "fire", x: 122, y: 32, heightM: 1 });
      const ev = run(sim, 60);
      return { sim, bid, blue, ev };
    };
    const p = go("push");
    expect(p.ev.some((e) => e.kind === "radio" && e.key === "radio.contactReact")).toBe(false);
    const b = go("back");
    expect(b.ev.some((e) => e.kind === "radio" && e.key === "radio.contactReact")).toBe(true);
    // Falling back by bounds (still on the way, or there): the rally point lies west, away from the enemy.
    const d = b.sim.state.unit.req(b.bid).drill;
    expect(d?.kind === "withdraw" || b.ev.some((e) => e.kind === "radio" && e.key === "radio.withdrawn")).toBe(true);
    if (d) expect(d.x).toBeLessThan(60);
    const xs = b.blue.members.filter((m) => b.sim.state.soldier.req(m).casualty === "none").map((m) => b.sim.state.transform.req(m).x);
    expect(xs.reduce((a, x) => a + x, 0) / xs.length).toBeLessThan(112);
  });
});

describe("the formation laid out at the destination (M5.1)", () => {
  it("a line facing north, 20 m wide: the men end up across the line, 10 m apart, facing north", () => {
    const sim = createSim(setup());
    const [bid, blue] = unitOf(sim, "blue");
    submitOrder(sim, { tick: 0, issuer: "blue", target: bid, kind: "move", waypoints: [{ x: 60, y: 100, mode: "run" }], formation: "line", facing: -Math.PI / 2, frontageM: 20 });
    run(sim, 90);
    const pos = blue.members.map((m) => sim.state.transform.req(m));
    // Facing north = across the x axis: all near y = 100, spread over x 50..70.
    for (const p of pos) { expect(Math.abs(p.y - 100)).toBeLessThan(5); expect(Math.abs(p.heading + Math.PI / 2)).toBeLessThan(0.2); }
    const xs = pos.map((p) => p.x).sort((a, b) => a - b);
    expect(xs[2]! - xs[0]!).toBeGreaterThan(14);
    expect(xs[2]! - xs[0]!).toBeLessThan(26);
  });

  it("rejects a frontage out of range", () => {
    const sim = createSim(setup());
    submitOrder(sim, { tick: 0, issuer: "blue", target: unitOf(sim, "blue")[0], kind: "move", waypoints: [{ x: 60, y: 100, mode: "run" }], frontageM: 0.2 });
    expect(run(sim, 1).some((e) => e.kind === "order.rejected" && e.reason === "invalid-params")).toBe(true);
  });
});
