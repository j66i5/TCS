/** M6.1: objectives and victory (owner decisions 2026-11-12). */
import { describe, expect, it } from "vitest";
import { battleScore, createSim, runBattle, saveSim, loadSim, hashState, secondsToTicks, step, submitOrder, type BattleInput, type Sim, type SimEvent } from "../src/index";
import { armedInput } from "./helpers";

const unitOf = (sim: Sim, side: string) => [...sim.state.unit.entries()].find(([, u]) => u.side === side)!;
function run(sim: Sim, seconds: number): SimEvent[] {
  const out: SimEvent[] = [];
  for (let i = 0; i < secondsToTicks(seconds); i++) out.push(...step(sim));
  return out;
}
function setup(prep?: (i: BattleInput) => void): BattleInput {
  const input = armedInput(1, 600);
  input.rules.objectives = [
    { id: "farm", nameKey: "objective.farm", x: 60, y: 15, radiusM: 15, points: 100, holder: "red" },
    { id: "hill", nameKey: "objective.hill", x: 190, y: 190, radiusM: 10, points: 50, holder: null },
  ];
  input.rules.victory = { casualtyPoints: 10, endOnDefeat: true };
  prep?.(input);
  return input;
}

describe("objectives and victory (M6.1)", () => {
  it("men walking into an objective nobody else holds take it; the score counts its points", () => {
    const sim = createSim(setup());
    expect(sim.state.objectives.map((o) => o.holder)).toEqual(["red", null]);
    submitOrder(sim, { tick: 0, issuer: "blue", target: unitOf(sim, "blue")[0], kind: "move", waypoints: [{ x: 60, y: 15, mode: "run" }] });
    const ev = run(sim, 40);
    const ch = ev.find((e) => e.kind === "objective.changed");
    expect(ch).toMatchObject({ objective: "farm", holder: "blue", from: "red" });
    const sc = battleScore(sim.ctx, sim.state);
    expect(sc.scores.find((s) => s.side === "blue")!.objectivePoints).toBe(100);
    expect(sc.winner).toBe("blue");
  });

  it("an objective with both sides inside is contested and stays with its holder", () => {
    const sim = createSim(setup((i) => { i.forces[1]!.placements = i.forces[1]!.placements.map((p) => ({ ...p, x: 62, y: 18 })); }));
    submitOrder(sim, { tick: 0, issuer: "blue", target: unitOf(sim, "blue")[0], kind: "move", waypoints: [{ x: 58, y: 15, mode: "run" }] });
    run(sim, 40);
    expect(sim.state.objectives[0]).toMatchObject({ holder: "red", contested: true });
  });

  it("men down cost points; a side with nobody left loses at once, and the result names the winner", () => {
    const input = setup();
    const sim = createSim(input);
    const red = unitOf(sim, "red")[1].members;
    for (const m of red) { const s = sim.state.soldier.req(m); s.physiology.alive = false; s.casualty = "killed"; s.mental.behaviour = "incapacitated"; }
    const ev = run(sim, 2);
    expect(ev.find((e) => e.kind === "battle.ended")).toMatchObject({ reason: "side-eliminated", loser: "red" });
    const sc = battleScore(sim.ctx, sim.state);
    expect(sc.scores.find((s) => s.side === "red")!.score).toBe(100 - 10 * red.length);
    expect(sc.winner).toBe("blue");
  });

  it("a battle run to its end reports the scores and the winner; objectives survive save and load", () => {
    const input = setup();
    input.rules.timeLimitSeconds = 20;
    const r = runBattle(input);
    expect(r.endReason).toBe("time-limit");
    expect(r.winner).toBe("red"); // red holds the farm (100) and nobody is down
    expect(r.scores.find((s) => s.side === "red")!.objectivePoints).toBe(100);
    const sim = createSim(input);
    submitOrder(sim, { tick: 0, issuer: "blue", target: unitOf(sim, "blue")[0], kind: "move", waypoints: [{ x: 60, y: 15, mode: "run" }] });
    run(sim, 15);
    const copy = loadSim({ ...input, orders: [] }, saveSim(sim));
    run(sim, 10); run(copy, 10);
    expect(hashState(copy.state)).toBe(hashState(sim.state));
  });
});
