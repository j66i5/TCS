/** M6.3: the AI commander — both postures, deterministic, saved and loaded with the game. */
import { describe, expect, it } from "vitest";
import { commanderController } from "@tcs/ai";
import { buildScenario } from "@tcs/scenario";
import { continueBattle, createSim, loadGame, runBattle, saveGame, step, submitOrder, type BattleInput } from "@tcs/sim";
import { loadData } from "../src/scenarios";

const data = loadData();
const scenario = (seed: number, seconds: number): BattleInput => buildScenario(data, { kind: "platoon-attack", seed, mapKind: "village", factions: ["de", "ru"], attacker: "blue", timeLimitSeconds: seconds });
const ctrls = (input: BattleInput) => [commanderController("blue", input), commanderController("red", input)];

describe("AI commander (M6.3)", () => {
  const input = scenario(1, 900);
  const r = runBattle(input, { controllers: ctrls(input) });

  it("the attacker moves up, fires on the objective and assaults it; the defender goes down and fires at will", () => {
    const by = (side: string, kind: string) => r.orders.filter((o) => o.issuer === side && o.kind === kind).length;
    expect(by("blue", "move")).toBeGreaterThan(0);
    expect(by("blue", "fire")).toBeGreaterThan(0);
    expect(by("blue", "assault")).toBeGreaterThan(0);
    expect(r.orders.some((o) => o.issuer === "red" && o.kind === "rules" && o.fire === "free")).toBe(true);
    expect(by("red", "posture")).toBeGreaterThan(0);
    // A real fight: both sides fire and both lose men.
    expect(r.eventCounts["shot.fired"] ?? 0).toBeGreaterThan(200);
    expect(r.sides.every((s) => s.soldiersStart - s.soldiersFit > 0)).toBe(true);
    expect(r.winner === "blue" || r.winner === "red").toBe(true);
  });

  it("the same battle twice is the same battle", () => {
    const again = runBattle(input, { controllers: ctrls(input) });
    expect(again.finalStateHash).toBe(r.finalStateHash);
  });

  it("saved halfway with the commanders' memory and loaded, it ends exactly as the battle played through", () => {
    const sim = createSim(input);
    const cs = ctrls(input);
    for (let k = 0; k < 400 * 60; k++) { for (const c of cs) for (const o of c.think(sim.state, sim.state.tick)) submitOrder(sim, o); step(sim); }
    const save = JSON.parse(JSON.stringify(saveGame(sim, cs))) as ReturnType<typeof saveGame>;
    const cs2 = ctrls(input);
    const loaded = loadGame(input, save, cs2);
    const end = continueBattle(loaded, input, { controllers: cs2 });
    expect(end.finalStateHash).toBe(r.finalStateHash);
  });

  it("with the defence gone (one man left, far off, holding fire) the attacker takes the main objective, and the second, and holds them", () => {
    // (Its whole sequence of phases, not the balance: against a real defence the AI attack fails, see DECISIONS.md.)
    const weak = scenario(2, 1500);
    const sim = createSim(weak);
    const reds = [...sim.state.identity.entries()].filter(([, i]) => i.side === "red").map(([id]) => id);
    reds.slice(1).forEach((m) => { const s = sim.state.soldier.req(m); s.physiology.alive = false; s.casualty = "killed"; s.mental.behaviour = "incapacitated"; });
    const last = sim.state.transform.req(reds[0]!); last.x = weak.map.widthM - 10; last.y = 10;
    for (const [uid, u] of sim.state.unit.entries()) if (u.side === "red") sim.state.unit.req(uid).fireRule = "hold";
    const cs = ctrls(weak);
    const taken: string[] = [];
    let assaultsOnSecond = 0;
    const second = weak.rules.objectives[1]!;
    for (let k = 0; k < 1500 * 60 && !sim.state.ended; k++) {
      for (const c of cs) for (const o of c.think(sim.state, sim.state.tick)) {
        if (o.issuer === "blue" && o.kind === "assault" && Math.hypot(o.x - second.x, o.y - second.y) < 40) assaultsOnSecond++;
        submitOrder(sim, o);
      }
      for (const e of step(sim)) if (e.kind === "objective.changed" && e.holder === "blue") taken.push(e.objective);
    }
    // Both end up taken (the second on the way or by its own assault), and the attacker holds them at the end.
    expect(taken).toContain("main");
    expect(taken).toContain("second");
    expect(taken.includes("second") || assaultsOnSecond > 0).toBe(true);
    expect(sim.state.objectives.every((o) => o.holder === "blue")).toBe(true);
  });
});
