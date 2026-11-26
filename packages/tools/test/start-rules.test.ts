/**
 * Review step 5: `scenarioPlatoons` (what the start menu and the briefing say each side gets) equals what
 * `buildScenario` builds for every kind and size, and `startRulesFor` gives the player's start rules by his role
 * (owner Q4: At will attacking, Return defending; the ambusher a laid ambush), with the real data and the fixture
 * faction. A built battle's off-map assets keep the catalog's default fire rule.
 */
import { describe, expect, it } from "vitest";
import { buildScenario, demoBattle, forceRole, holdBattle, SCENARIO_KIND, SCENARIO_KINDS, scenarioPlatoons, startRulesFor, vehicleBattle, type ScenarioDef } from "@tcs/scenario";
import { createSim, type ForcePlan } from "@tcs/sim";
import { loadData } from "../src/scenarios";

const data = loadData(true);

describe("scenarioPlatoons: the counts the menu shows are the counts the scenario builds", () => {
  const cases: [string, Partial<ScenarioDef>][] = [];
  for (const kind of ["platoon-attack", ...SCENARIO_KINDS] as const) for (const size of ["platoon", "company"] as const) for (const attacker of ["blue", "red"] as const) cases.push([`${kind} ${size} ${attacker} attacking`, { kind, size, attacker }]);
  cases.push(["attack, three attacking platoons", { kind: "attack", attackerPlatoons: 3 }], ["counter-attack, a reserve of two", { kind: "defence-counterattack", reservePlatoons: 2 }],
    ["platoons set per side", { kind: "meeting", platoons: [2, 3], attacker: "red" }], ["reinforcements", { kind: "attack", reinforcements: [[300, 600], [400]], attacker: "red" }]);
  it.each(cases)("%s", (_name, part) => {
    // (The fixture faction on both sides, on foot: the counts do not depend on the faction or the carriers.)
    const def: ScenarioDef = { kind: "attack", seed: 2, mapKind: "farmland", factions: ["xf", "xf"], attacker: "blue", timeLimitSeconds: 1200, ...part };
    const p = scenarioPlatoons(def);
    const input = buildScenario(data, def);
    const defender = def.attacker === "blue" ? "red" : "blue";
    // (A side's platoons are its top units keyed "<side>-<n>"; its teams, sections and assets have other keys.)
    const count = (side: string, late: boolean) => input.forces.find((f) => f.side === side)!.units.filter((u) => new RegExp(`^${side}-\\d+$`).test(u.key) && ((u.arriveS ?? 0) > 0) === late).length;
    expect(count(def.attacker, false)).toBe(p.attacker);
    expect(count(defender, false)).toBe(p.defender);
    expect(count(def.attacker, true)).toBe(p.attackerLate);
    expect(count(defender, true)).toBe(p.defenderLate);
    expect(p.reserve).toBe(def.kind === "defence-counterattack" ? Math.max(1, def.reservePlatoons ?? 1) : 0);
  });
  it("the plain attack is two platoons against one (owner, M6 review), a meeting one each, a company three each", () => {
    expect(scenarioPlatoons({ kind: "platoon-attack", attacker: "blue" })).toMatchObject({ attacker: 2, defender: 1, attackerLate: 0, defenderLate: 0 });
    expect(scenarioPlatoons({ kind: "meeting", attacker: "blue" })).toMatchObject({ attacker: 1, defender: 1 });
    expect(scenarioPlatoons({ kind: "attack", attacker: "red", size: "company" })).toMatchObject({ attacker: 3, defender: 3 });
    expect(scenarioPlatoons({ kind: "defence-counterattack", attacker: "red", size: "company" })).toMatchObject({ attacker: 3, defender: 2, defenderLate: 1 });
  });
});

describe("startRulesFor: the player's start rules by role", () => {
  const plan = (posture: ForcePlan["posture"], more: Partial<ForcePlan> = {}) => ({ plan: { posture, ...more } });
  it("the seven postures and none", () => {
    expect(startRulesFor(plan("attack"))).toEqual({ fire: "free" });
    expect(startRulesFor(plan("meeting"))).toEqual({ fire: "free" });
    expect(startRulesFor(plan("follow"))).toEqual({ fire: "free" });
    expect(startRulesFor(plan("transit"))).toEqual({ fire: "free" });
    expect(startRulesFor(plan("defend"))).toEqual({ fire: "return" });
    expect(startRulesFor(plan("withdraw"))).toEqual({ fire: "return" });
    expect(startRulesFor(plan("ambush", { ambushRangeM: 180 }))).toEqual({ ambushM: 180 });
    expect(startRulesFor(plan("ambush"))).toEqual({ ambushM: SCENARIO_KIND.ambushRangeM });
    expect(startRulesFor({})).toBeUndefined();
  });
  it("no plan: the stated posture; the plan wins over it", () => {
    expect(startRulesFor({ posture: "attack" })).toEqual({ fire: "free" });
    expect(startRulesFor({ posture: "defend" })).toEqual({ fire: "return" });
    expect(startRulesFor({ posture: "defend", plan: { posture: "withdraw" } })).toEqual({ fire: "return" });
    expect(startRulesFor({ posture: "attack", plan: { posture: "transit" } })).toEqual({ fire: "free" });
    expect(forceRole({ posture: "defend", plan: { posture: "ambush" } })).toBe("ambush");
  });
  it("every scenario kind's two sides have a role with a rule; the sandboxes have none", () => {
    for (const kind of SCENARIO_KINDS) {
      const input = buildScenario(data, { kind, seed: 1, mapKind: "farmland", factions: ["xf", "xf"], attacker: "blue", timeLimitSeconds: 600 });
      for (const f of input.forces) expect(startRulesFor(f), `${kind} ${f.side}`).toBeDefined();
    }
    const hold = holdBattle(data, { seed: 1, factions: ["de", "ru"], defender: "blue" });
    expect(startRulesFor(hold.forces.find((f) => f.side === "blue")!)).toEqual({ fire: "return" });
    expect(startRulesFor(hold.forces.find((f) => f.side === "red")!)).toEqual({ fire: "free" });
    for (const input of [demoBattle(data, { seed: 1, factions: ["de", "ru"], timeLimitSeconds: 60 }), vehicleBattle(data, { seed: 1, factions: ["de", "ru"], mapKind: "farmland", timeLimitSeconds: 60 })]) {
      for (const f of input.forces) expect(startRulesFor(f)).toBeUndefined();
    }
  });
  it("laid on a built force: its fighting units start with it, its off-map assets and the other side keep the default", () => {
    const input = buildScenario(data, { kind: "ambush", seed: 1, mapKind: "farmland", factions: ["de", "ru"], attacker: "red", timeLimitSeconds: 600 });
    const blue = input.forces.find((f) => f.side === "blue")!;
    blue.start = startRulesFor(blue)!;
    const sim = createSim(input);
    const def = input.catalog.behaviour.decisions.defaultFireRule;
    let own = 0, assets = 0;
    for (const u of sim.state.unit.values()) {
      if (u.side !== "blue") { expect(u.fireRule).toBe(def); expect(u.ambush).toBeUndefined(); continue; }
      if (u.asset !== undefined) { assets++; expect(u.fireRule).toBe(def); expect(u.ambush).toBeUndefined(); continue; }
      own++; expect(u.ambush?.rangeM).toBe(SCENARIO_KIND.ambushRangeM); expect(u.fireRule).toBe("free");
    }
    expect(own).toBeGreaterThan(3);
    expect(assets).toBeGreaterThan(0);
  });
});
