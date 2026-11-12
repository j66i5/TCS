/** M4.2: soldier decisions — fire rules, own fire, cover from a known threat, handing over ammunition. */
import { describe, expect, it } from "vitest";
import { createSim, hashState, loadSim, saveSim, secondsToTicks, step, submitOrder, type BattleInput, type Sim, type SimEvent } from "../src/index";
import { armedInput } from "./helpers";

const unitOf = (sim: Sim, side: string) => [...sim.state.unit.entries()].find(([, u]) => u.side === side)!;
function run(sim: Sim, seconds: number): SimEvent[] {
  const out: SimEvent[] = [];
  for (let i = 0; i < secondsToTicks(seconds); i++) out.push(...step(sim));
  return out;
}
/** Blue at x = 10 (y 10, 15, 20); red 110 m east. */
function setup(prep?: (i: BattleInput) => void): BattleInput {
  const input = armedInput(1, 600);
  input.rules.physiologyModel = "simple";
  input.forces[1]!.placements = input.forces[1]!.placements.map((p) => ({ ...p, x: 120 }));
  prep?.(input);
  return input;
}
const shotsBy = (sim: Sim, ev: SimEvent[], side: string) => ev.filter((e) => e.kind === "shot.fired" && sim.state.identity.get(e.shooter)?.side === side).length;
const rules = (sim: Sim, side: string, fire: "free" | "return" | "hold") => submitOrder(sim, { tick: sim.state.tick, issuer: side, target: unitOf(sim, side)[0], kind: "rules", fire });

describe("fire rules and own fire (M4.2)", () => {
  it("'free': men open fire on an enemy they see without an order; 'hold': they do not", () => {
    for (const rule of ["free", "hold"] as const) {
      const sim = createSim(setup());
      rules(sim, "blue", rule);
      const ev = run(sim, 30);
      if (rule === "free") {
        expect(shotsBy(sim, ev, "blue")).toBeGreaterThan(5);
        const id = unitOf(sim, "blue")[1].members.find((m) => sim.state.fire.get(m)?.self)!;
        expect(sim.state.soldier.req(id).intent?.kind).toBe("engage");
        expect(sim.state.identity.req(sim.state.fire.get(id)!.contact!).side).toBe("red");
      } else expect(shotsBy(sim, ev, "blue")).toBe(0);
      expect(shotsBy(sim, ev, "red")).toBe(0); // red holds (the test catalog's default)
    }
  });

  it("'return': men fire back only once their unit has been fired upon", () => {
    const sim = createSim(setup());
    rules(sim, "blue", "return");
    expect(shotsBy(sim, run(sim, 20), "blue")).toBe(0); // they see red, but nobody has fired at them
    submitOrder(sim, { tick: sim.state.tick, issuer: "red", target: unitOf(sim, "red")[0], kind: "fire", x: 10, y: 15, heightM: 1 });
    expect(shotsBy(sim, run(sim, 30), "blue")).toBeGreaterThan(3);
  });

  it("a cease-fire order holds until they are fired upon again", () => {
    const sim = createSim(setup());
    rules(sim, "blue", "free");
    run(sim, 20);
    submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: unitOf(sim, "blue")[0], kind: "ceaseFire" });
    run(sim, 2);
    expect(shotsBy(sim, run(sim, 20), "blue")).toBe(0);
    submitOrder(sim, { tick: sim.state.tick, issuer: "red", target: unitOf(sim, "red")[0], kind: "fire", x: 10, y: 15, heightM: 1 });
    expect(shotsBy(sim, run(sim, 30), "blue")).toBeGreaterThan(3);
  });

  it("an ordered fire task is never replaced by his own choice", () => {
    const sim = createSim(setup());
    rules(sim, "blue", "free");
    submitOrder(sim, { tick: 0, issuer: "blue", target: unitOf(sim, "blue")[0], kind: "fire", x: 120, y: 150, heightM: 1 });
    run(sim, 15);
    for (const m of unitOf(sim, "blue")[1].members) {
      const t = sim.state.fire.get(m);
      if (t) { expect(t.self).toBeUndefined(); expect(t.y).toBe(150); }
    }
  });
});

describe("cover and ammunition (M4.2)", () => {
  it("under fire in the open, a man runs to the nearest spot covered from the enemy he knows and lies down", () => {
    const sim = createSim(setup((i) => {
      // A 1.2 m wall running north-south 4 m east of the blue line, ending at y = 30; the third man is at y = 40.
      i.map.obstacles.push({ id: 1, kind: "wall", points: [14, 0, 14, 30], heightM: 1.2, thicknessM: 0.3, material: "brick" });
      i.forces[0]!.placements[2] = { ...i.forces[0]!.placements[2]!, y: 40 };
    }));
    const man = unitOf(sim, "blue")[1].members[2]!;
    submitOrder(sim, { tick: 0, issuer: "red", target: unitOf(sim, "red")[0], kind: "fire", x: 10, y: 40, heightM: 1 });
    let went = false;
    for (let k = 0; k < secondsToTicks(30); k++) { step(sim); if (sim.state.soldier.req(man).intent?.kind === "cover") went = true; }
    expect(went).toBe(true);
    const t = sim.state.transform.req(man);
    expect(t.y).toBeLessThan(30);
    expect(t.x).toBeLessThan(14);
    expect(sim.state.soldier.req(man).posture).toBe("prone");
  });

  it("a man out of spare magazines gets one from a comrade nearby, and keeps firing", () => {
    const sim = createSim(setup());
    const [bid, blue] = unitOf(sim, "blue");
    const [a, b] = blue.members as [number, number];
    sim.state.container.req(a).stacks = [];
    sim.state.container.req(b).stacks = [{ type: "mag", count: 6, charge: 30 }];
    submitOrder(sim, { tick: 0, issuer: "blue", target: a, kind: "fire", x: 120, y: 100, heightM: 1 });
    const ev: SimEvent[] = [];
    for (let k = 0; k < 4 && !ev.some((e) => e.kind === "items.transferred"); k++) {
      ev.push(...run(sim, 15));
      submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: a, kind: "fire", x: 120, y: 100, heightM: 1 });
    }
    const tr = ev.find((e) => e.kind === "items.transferred")!;
    expect(tr).toBeDefined();
    expect(tr).toMatchObject({ from: b, to: a, count: 1 });
    // (He had stopped firing to keep his last magazine; with a spare one again, the next order is carried out.)
    submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: a, kind: "fire", x: 120, y: 100, heightM: 1 });
    const after = run(sim, 15);
    expect(after.some((e) => e.kind === "shot.fired" && e.shooter === a)).toBe(true);
    void bid;
  });

  it("decisions are deterministic across save and load", () => {
    const input = setup();
    const sim = createSim(input);
    rules(sim, "blue", "free");
    submitOrder(sim, { tick: 0, issuer: "red", target: unitOf(sim, "red")[0], kind: "fire", x: 10, y: 15, heightM: 1 });
    run(sim, 12);
    const copy = loadSim({ ...input, orders: [] }, saveSim(sim));
    run(sim, 20); run(copy, 20);
    expect(hashState(copy.state)).toBe(hashState(sim.state));
  });
});
