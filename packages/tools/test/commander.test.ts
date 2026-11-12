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
});
