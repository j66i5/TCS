/**
 * Balance pass 4 (owner 2026-11-19, decision E): the defence's hulls (its tank section, its carriers whose squads are
 * out) start the mounted battle on the hull-down posts its commander sites (ai `defenceStartPosts`, the scenario's
 * `ScenarioHooks`), flagged `onPost`; the commander keeps them there; the attacker's dead-ground start is looked for
 * from those posts. Deterministic; the fixture faction works.
 */
import { describe, expect, it } from "vitest";
import { commanderController, defenceStartPosts } from "@tcs/ai";
import { buildScenario, mountedTanks, type ScenarioDef } from "@tcs/scenario";
import { createSim, hypot2, isOffMap, step, submitOrder, type BattleInput } from "@tcs/sim";
import { loadData } from "../src/scenarios";

const data = loadData();
const def = (seed: number, over: Partial<ScenarioDef> = {}): ScenarioDef => ({ kind: "platoon-attack", seed, mapKind: "village", factions: ["de", "ru"], attacker: "blue", timeLimitSeconds: 600, vehicles: true, missileTeams: true, ...mountedTanks(data, ["de", "ru"], "blue"), ...over });
const hulls = (input: BattleInput, side: string) => input.forces.find((f) => f.side === side)!.vehiclePlacements ?? [];

describe("the defence's hulls start on their posts (balance pass 4)", () => {
  it("the tanks and the empty carriers are moved to posts and flagged; the attack's start is sought from there; deterministic", () => {
    for (const seed of [1, 2]) {
      const plain = buildScenario(data, def(seed));
      const posted = buildScenario(data, def(seed), { defenceStartPosts });
      const before = hulls(plain, "red"), after = hulls(posted, "red");
      expect(after.length).toBe(before.length);
      // Every defending hull on the map (two T-90M, three BMP-2 whose squads start on foot) is on a post.
      expect(after.filter((p) => p.onPost === true).length).toBe(5);
      expect(after.some((p, i) => hypot2(p.x - before[i]!.x, p.y - before[i]!.y) > 30)).toBe(true);
      expect(before.some((p) => p.onPost === true)).toBe(false);
      // The attacker's hulls are placed after (dead ground from the posts): their places may differ, never the defence's men.
      expect(posted.forces.find((f) => f.side === "red")!.placements).toEqual(plain.forces.find((f) => f.side === "red")!.placements);
      expect(JSON.stringify(buildScenario(data, def(seed), { defenceStartPosts }))).toBe(JSON.stringify(posted));
      // Off: the flag on the scenario.
      expect(JSON.stringify(buildScenario(data, def(seed, { defenceOnPosts: false }), { defenceStartPosts }))).toBe(JSON.stringify(plain));
    }
  });

  it("in the battle the commander keeps them there: no defending hull drives off its post in the first 45 s", () => {
    const input = buildScenario(data, def(1), { defenceStartPosts });
    const sim = createSim(input);
    const ctrls = [commanderController("blue", input), commanderController("red", input)];
    const start = new Map<number, { x: number; y: number }>();
    for (const [vid, v] of sim.state.vehicle.entries()) if (v.side === "red" && !isOffMap(v)) start.set(vid, { ...sim.state.transform.req(vid) });
    let most = 0;
    for (let i = 0; i < 45 * 60; i++) {
      for (const c of ctrls) for (const o of c.think(sim.state, sim.state.tick)) submitOrder(sim, o);
      step(sim);
      for (const [vid, p] of start) { const t = sim.state.transform.req(vid); most = Math.max(most, hypot2(t.x - p.x, t.y - p.y)); }
    }
    expect(most).toBeLessThan(5);
  });

  it("the fixture faction's hulls are sited too (rule 8: no faction in code)", () => {
    const fx = loadData(true);
    const input = buildScenario(fx, { kind: "platoon-attack", seed: 1, mapKind: "village", factions: ["de", "xf"], attacker: "blue", vehicles: true, tanks: true, timeLimitSeconds: 300 }, { defenceStartPosts });
    expect(hulls(input, "red").some((p) => p.onPost === true)).toBe(true);
  });
});
