/** M4.1: suppression, stress and behaviour states (core/behaviour.json). */
import { describe, expect, it } from "vitest";
import { createSim, secondsToTicks, step, submitOrder, type BattleInput, type Sim, type SimEvent } from "../src/index";
import { EventSink } from "../src/events";
import { moraleSystem } from "../src/systems/morale";
import { refreshStatus } from "../src/systems/wounds";
import { armedInput } from "./helpers";

const unitOf = (sim: Sim, side: string) => [...sim.state.unit.entries()].find(([, u]) => u.side === side)!;
function run(sim: Sim, seconds: number, each?: () => void): SimEvent[] {
  const out: SimEvent[] = [];
  for (let i = 0; i < secondsToTicks(seconds); i++) { each?.(); out.push(...step(sim)); }
  return out;
}
/** Blue at x = 10 (y 10, 15, 20); red 110 m east at x = 120 (y 10, 15). */
function setup(prep?: (i: BattleInput) => void): BattleInput {
  const input = armedInput();
  input.forces[1]!.placements = input.forces[1]!.placements.map((p) => ({ ...p, x: 120 }));
  prep?.(input);
  return input;
}
const sup = (sim: Sim, id: number) => sim.state.soldier.req(id).mental.suppression;

describe("suppression (M4.1)", () => {
  it("enemy rounds cracking past a man suppress him; the same fire 60 m away does not; the firers are not suppressed by their own rounds", () => {
    const near = createSim(setup());
    const far = createSim(setup());
    for (const [sim, y] of [[near, 12.5], [far, 75]] as const) {
      submitOrder(sim, { tick: 0, issuer: "red", target: unitOf(sim, "red")[0], kind: "fire", x: 10, y, heightM: 1 });
    }
    const peakNear = new Map<number, number>(), peakFar = new Map<number, number>();
    const blue = unitOf(near, "blue")[1].members;
    for (let k = 0; k < secondsToTicks(15); k++) {
      step(near); step(far);
      for (const m of blue) { peakNear.set(m, Math.max(peakNear.get(m) ?? 0, sup(near, m))); peakFar.set(m, Math.max(peakFar.get(m) ?? 0, sup(far, m))); }
    }
    expect(Math.max(...peakNear.values())).toBeGreaterThan(0.05);
    expect(Math.max(...peakFar.values())).toBe(0);
    for (const m of unitOf(near, "red")[1].members) expect(sup(near, m)).toBe(0);
  });

  it("a pinned man drops flat and stops; when the fire stops he recovers and goes on", () => {
    // (The unit's reaction to contact, M4.3, would halt the whole move: off for this test of one man.)
    const sim = createSim(setup((i) => {
      const b = i.catalog.behaviour;
      i.catalog = { ...i.catalog, behaviour: { ...b, drills: { ...b.drills, reactToContact: false } } };
    }));
    const [bid, blue] = unitOf(sim, "blue");
    const a = blue.members[0]!;
    submitOrder(sim, { tick: 0, issuer: "blue", target: bid, kind: "move", waypoints: [{ x: 10, y: 150, mode: "walk" }] });
    run(sim, 4);
    sim.state.soldier.req(a).mental.suppression = 0.9;
    const ev = run(sim, 2);
    expect(ev.some((e) => e.kind === "behaviour.changed" && e.soldier === a && e.to === "pinned")).toBe(true);
    const at = { ...sim.state.transform.req(a) };
    run(sim, 2);
    expect(sim.state.soldier.req(a).posture).toBe("prone");
    expect(sim.state.soldier.req(a).mental.behaviour).toBe("pinned");
    expect(Math.hypot(sim.state.transform.req(a).x - at.x, sim.state.transform.req(a).y - at.y)).toBeLessThan(0.01);
    // It fades: below the release level after a few seconds; then he moves again.
    run(sim, 8);
    expect(sim.state.soldier.req(a).mental.behaviour).not.toBe("pinned");
    run(sim, 6);
    expect(sim.state.transform.req(a).y - at.y).toBeGreaterThan(3);
  });

  it("a pinned man fires at about a third of the rate; a panicked man does not fire", () => {
    const shots = (state: "steady" | "pinned" | "panicked") => {
      const sim = createSim(setup());
      const [rid, red] = unitOf(sim, "red");
      submitOrder(sim, { tick: 0, issuer: "red", target: rid, kind: "fire", x: 10, y: 60, heightM: 1 });
      const ev = run(sim, 30, () => {
        for (const m of red.members) {
          const s = sim.state.soldier.req(m);
          if (state === "pinned") s.mental.suppression = 0.9;
          if (state === "panicked") s.mental.stress = 1;
        }
      });
      return ev.filter((e) => e.kind === "shot.fired").length;
    };
    const steady = shots("steady"), pinned = shots("pinned"), panicked = shots("panicked");
    expect(steady).toBeGreaterThan(20);
    expect(pinned).toBeLessThan(steady * 0.6);
    expect(pinned).toBeGreaterThan(0);
    expect(panicked).toBe(0);
  });
});

describe("stress (M4.1)", () => {
  it("under the same fire an experienced man's stress grows more slowly", () => {
    const sim = createSim(setup());
    const [a, b] = unitOf(sim, "blue")[1].members as [number, number];
    sim.state.soldier.req(a).skills["experience"] = 0.1;
    sim.state.soldier.req(b).skills["experience"] = 0.9;
    run(sim, 20, () => { sim.state.soldier.req(a).mental.suppression = 0.8; sim.state.soldier.req(b).mental.suppression = 0.8; });
    const sa = sim.state.soldier.req(a).mental.stress, sb = sim.state.soldier.req(b).mental.stress;
    expect(sa).toBeGreaterThan(0.1);
    expect(sb).toBeLessThan(sa * 0.7);
  });

  it("a comrade falling nearby stresses his own side, not the enemy; losing the leader stresses his whole unit", () => {
    const sim = createSim(setup());
    const [, blue] = unitOf(sim, "blue");
    const [lead, x, y] = blue.members as [number, number, number];
    moraleSystem(sim.ctx, sim.state, new EventSink(), [{ kind: "casualty", tick: 0, soldier: x, status: "killed" }]);
    expect(sim.state.soldier.req(y).mental.stress).toBeGreaterThan(0.05);
    for (const m of unitOf(sim, "red")[1].members) expect(sim.state.soldier.req(m).mental.stress).toBe(0);
    const before = sim.state.soldier.req(y).mental.stress;
    const s = sim.state.soldier.req(lead);
    s.physiology.alive = false;
    refreshStatus(sim.ctx, sim.state, new EventSink(), lead);
    expect(sim.state.unit.req(unitOf(sim, "blue")[0]).leader).not.toBe(lead);
    expect(sim.state.soldier.req(y).mental.stress).toBeGreaterThan(before + 0.05);
  });
});
