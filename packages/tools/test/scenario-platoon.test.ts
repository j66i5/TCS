/** M6.2: the generated platoon battle (scenario format and generator). */
import { describe, expect, it } from "vitest";
import { buildScenario, SCENARIO_HASTY_DEPTH_M, SCENARIO_PREPARED_S, type ScenarioDef } from "@tcs/scenario";
import { commanderController } from "@tcs/ai";
import { buildingAt, cellIndex, cellMoveCost, createSim, hashState, rimHeight, runBattle, secondsToTicks, step, submitOrder } from "@tcs/sim";
import { loadData } from "../src/scenarios";

const data = loadData();
const def = (seed: number, over: Partial<ScenarioDef> = {}): ScenarioDef => ({ kind: "platoon-attack", seed, mapKind: "village", factions: ["de", "ru"], attacker: "blue", ...over });

describe("platoon battle generator (M6.2)", () => {
  it("balance pass after M11: a prepared defence: the defender digs in where its commander sites it (prepared: false: none); balance pass 2: hasty holes, SCENARIO_HASTY_DEPTH_M deep", () => {
    for (const attacker of ["blue", "red"] as const) {
      const defender = attacker === "blue" ? "red" : "blue";
      expect(buildScenario(data, def(2, { attacker })).rules.prepared).toEqual([{ side: defender, fromS: SCENARIO_PREPARED_S[0], untilS: SCENARIO_PREPARED_S[1], depthM: SCENARIO_HASTY_DEPTH_M }]);
      expect(buildScenario(data, def(2, { attacker, prepared: false })).rules.prepared).toBeUndefined();
    }
    const input = buildScenario(data, def(1, { timeLimitSeconds: 120 }));
    const sim = createSim(input);
    const ctls = [commanderController("red", input), commanderController("blue", input)];
    for (let i = 0; i < secondsToTicks(SCENARIO_PREPARED_S[1] + 1); i++) { for (const c of ctls) for (const o of c.think(sim.state, sim.state.tick)) submitOrder(sim, o); step(sim); }
    const ps = sim.state.terrain.positions ?? [];
    expect(ps.length).toBeGreaterThanOrEqual(6);
    expect(ps.every((p) => p.side === "red" && p.depthM === SCENARIO_HASTY_DEPTH_M)).toBe(true);
    const rims = [...sim.state.soldier.keys()].map((m) => rimHeight(sim.ctx, sim.state, m)).filter((r) => r > 0);
    expect(rims.length).toBeGreaterThanOrEqual(6);
    expect(Math.max(...rims)).toBeLessThanOrEqual(SCENARIO_HASTY_DEPTH_M);
  }, 120_000);

  it("two platoons attack one: three squads and the platoon's own men each; the same definition gives the same battle", () => {
    const a = buildScenario(data, def(4)), b = buildScenario(data, def(4));
    expect(hashState(createSim(a).state)).toBe(hashState(createSim(b).state));
    // The attacker (blue here) has two platoons, the defender one (owner, M6 review); each of three squads.
    for (const f of a.forces) {
      // (M10.6a: besides the platoons, the crews of the ambulances waiting off the map.)
      const amb = new Set((f.offMap ?? []).map((x) => x.vehicleId));
      const plats = f.units.filter((u) => u.vehicleId === undefined || !amb.has(u.vehicleId));
      expect(plats).toHaveLength(f.side === "blue" ? 2 : 1);
      expect(f.units.length - plats.length).toBe(amb.size);
      for (const u of plats) expect(u.subunits).toHaveLength(3);
      expect(f.placements.length).toBeGreaterThanOrEqual(19 * plats.length);
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
