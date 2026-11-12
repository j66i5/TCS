/** M6.2: the generated platoon battle (scenario format and generator). */
import { describe, expect, it } from "vitest";
import { buildScenario, type ScenarioDef } from "@tcs/scenario";
import { buildingAt, cellIndex, cellMoveCost, createSim, hashState, runBattle } from "@tcs/sim";
import { loadData } from "../src/scenarios";

const data = loadData();
const def = (seed: number, over: Partial<ScenarioDef> = {}): ScenarioDef => ({ kind: "platoon-attack", seed, mapKind: "village", factions: ["de", "ru"], attacker: "blue", ...over });

describe("platoon battle generator (M6.2)", () => {
  it("platoon against platoon: three squads and the platoon's own men a side; the same definition gives the same battle", () => {
    const a = buildScenario(data, def(4)), b = buildScenario(data, def(4));
    expect(hashState(createSim(a).state)).toBe(hashState(createSim(b).state));
    for (const f of a.forces) {
      expect(f.units).toHaveLength(1);
      expect(f.units[0]!.subunits).toHaveLength(3);
      expect(f.placements.length).toBeGreaterThanOrEqual(19);
    }
    // A scenario definition is plain data.
    expect(JSON.parse(JSON.stringify(def(4)))).toEqual(def(4));
  });

  it("everyone stands on open, passable ground; the defenders hold both objectives at the start, the attackers start far off", () => {
    for (const [seed, kind, attacker] of [[1, "village", "blue"], [2, "farmland", "red"], [3, "woodland", "blue"], [5, "industrial", "red"]] as const) {
      const input = buildScenario(data, def(seed, { mapKind: kind, attacker }));
      const defender = attacker === "blue" ? "red" : "blue";
      for (const f of input.forces) for (const p of f.placements) {
        const c = cellIndex(input.map, p.x, p.y);
        expect(cellMoveCost(input.map, input.catalog.terrain, c, "foot"), `${kind} ${p.personId}`).not.toBeNull();
        expect(buildingAt(input.map, p.x, p.y)).toBeNull();
      }
      expect(input.rules.objectives.map((o) => o.holder)).toEqual([defender, defender]);
      const obj = input.rules.objectives[0]!;
      const atk = input.forces.find((f) => f.side === attacker)!;
      for (const p of atk.placements) expect(Math.hypot(p.x - obj.x, p.y - obj.y)).toBeGreaterThan(400);
      const dfn = input.forces.find((f) => f.side === defender)!;
      expect(dfn.placements.filter((p) => Math.hypot(p.x - obj.x, p.y - obj.y) < 80).length).toBeGreaterThan(8);
    }
  });

  it("with nobody giving orders the defender wins at the time limit (it holds the objectives)", () => {
    const input = buildScenario(data, def(6, { timeLimitSeconds: 30 }));
    const r = runBattle(input);
    expect(r.winner).toBe("red");
    expect(r.scores.find((s) => s.side === "red")!.objectivePoints).toBe(150);
  });
});
