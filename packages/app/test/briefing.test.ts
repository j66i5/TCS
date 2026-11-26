/**
 * Review step 5: the battle briefing's model (ui/briefing.ts), built from the battle input the app builds for a URL:
 * the task by role, your men and hulls as the input has them (without the off-map assets), the enemy rounded, the
 * objectives, how the battle ends with the data's battle-end numbers, the fire rule your units start with; every key
 * it shows exists; the fixture faction; a battle without battle-end rules leaves those lines out.
 */
import { describe, expect, it } from "vitest";
import { Strings } from "@tcs/data";
import { buildScenario, startRulesFor } from "@tcs/scenario";
import { briefingKeys, briefingModel, roughly, type BriefingModel } from "@tcs/ui";
import type { ForceInput, UnitInput } from "@tcs/sim";
import { loadData } from "../../tools/src/scenarios";
import { launchSearch, defaultChoices } from "../src/menu-model";
import { battleSetup } from "../src/setup";

const data = loadData(true);
const strings = new Strings(data, "en");
const hullNameKey = (type: string): string => { for (const f of Object.keys(data.factions).sort()) { const v = data.factions[f]?.vehicles[type]; if (v) return v.nameKey; } return type; };
const model = (query: string): { m: BriefingModel; b: ReturnType<typeof battleSetup> } => {
  const b = battleSetup(data, new URLSearchParams(query));
  return { m: briefingModel(b.input, b.playerSide, b.start, { mapKey: `map.${b.mapKind ?? "flat"}`, hullNameKey }), b };
};
const menOf = (u: UnitInput): number => u.members.length + u.subunits.reduce((n, c) => n + menOf(c), 0);
const fightingMen = (f: ForceInput) => { const off = new Set((f.offMap ?? []).map((a) => a.vehicleId)); return f.units.filter((u) => u.vehicleId === undefined || !off.has(u.vehicleId)).reduce((n, u) => n + menOf(u), 0); };
const fightingHulls = (f: ForceInput) => { const off = new Set((f.offMap ?? []).map((a) => a.vehicleId)); return (f.vehicles ?? []).filter((v) => !off.has(v.vehicleId)).length; };
/** The model as the card words it (every text through the string table, `...Key` parameters in words). */
const words = (m: BriefingModel): string[] => {
  const tx = (x: { key: string; params?: Record<string, string | number> }) => {
    const p: Record<string, string | number> = { ...(x.params ?? {}) };
    for (const [k, v] of Object.entries(x.params ?? {})) if (k.endsWith("Key") && typeof v === "string") p[k.slice(0, -3)] = strings.t(v);
    return strings.t(x.key, p);
  };
  return [tx(m.task), ...m.situation.map((r) => `${strings.t(r.label)}: ${tx(r.value)}`), ...m.own.support.map(tx), ...m.own.late.map(tx), ...m.objectives.map(tx), ...m.ends.map(tx), ...m.fire.map(tx)];
};

describe("briefing: the model of every kind of battle the menu starts", () => {
  const cases: [string, string, BriefingModel["role"], string][] = [
    ["the mounted attack", "seed=3", "attack", "brief.fire.free"],
    ["the defence", "seed=3&attacker=red", "defend", "brief.fire.return"],
    ["a meeting, on foot", "seed=3&kind=meeting&vehicles=0", "meeting", "brief.fire.free"],
    ["laying an ambush", "seed=3&kind=ambush&attacker=red&vehicles=0", "ambush", "brief.fire.ambush"],
    ["moving through an ambush", "seed=3&kind=ambush&attacker=blue&vehicles=0", "transit", "brief.fire.free"],
    ["a withdrawal, delaying", "seed=3&kind=withdrawal&attacker=red&vehicles=0", "withdraw", "brief.fire.return"],
    ["a withdrawal, pursuing", "seed=3&kind=withdrawal&attacker=blue&vehicles=0", "follow", "brief.fire.free"],
    ["a counter-attack battle, defending as red", "seed=3&kind=defence-counterattack&side=red&attacker=blue&vehicles=0", "defend", "brief.fire.return"],
    ["a company attack", "seed=3&size=company&tanks=1&vehicles=0", "attack", "brief.fire.free"],
    ["hold the village", "scenario=hold&seed=3", "defend", "brief.fire.return"],
    ["hold the village at night", "scenario=hold&seed=3&time=23:00", "defend", "brief.fire.return"],
    ["the assault group", "scenario=platoon&assault=1&vehicles=0&side=red&seed=3", "attack", "brief.fire.free"],
    ["the vehicle sandbox (no role)", "scenario=vehicles&seed=3", null, "brief.fire.return"],
  ];
  it.each(cases)("%s (%s)", (_n, query, role, fireKey) => {
    const { m, b } = model(query);
    const own = b.input.forces.find((f) => f.side === b.playerSide)!, enemy = b.input.forces.find((f) => f.side === b.enemySide)!;
    expect(m.role).toBe(role);
    expect(m.task.key).toBe(`brief.task.${role ?? "none"}`);
    // What you have: the input's men and hulls, without the ambulances, recovery vehicles and police off the map.
    expect(m.own.men).toBe(fightingMen(own));
    expect(m.own.hulls.reduce((n, x) => n + x.count, 0)).toBe(fightingHulls(own));
    expect(m.own.units.length + m.own.late.length).toBeGreaterThan(0);
    for (const u of m.own.units) expect(own.units.some((x) => x.callsign === u && (x.arriveS ?? 0) <= 0)).toBe(true);
    expect(m.own.late.length).toBe(own.units.filter((u) => (u.arriveS ?? 0) > 0).length);
    // The enemy: rounded, never the exact count above ten.
    expect(m.enemy.men).toBe(roughly(fightingMen(enemy)));
    expect(m.enemy.hulls.reduce((n, x) => n + x.count, 0)).toBe(fightingHulls(enemy));
    // The fire rule your units start with: the one laid on your force.
    expect(m.fire[0]!.key).toBe(fireKey);
    expect(own.start ?? null).toEqual(b.start);
    if (role === "ambush") expect(m.fire[0]!.params).toEqual({ m: 220 });
    // The objectives of the input, or a line saying there are none.
    expect(m.objectives.length).toBe(Math.max(1, b.input.rules.objectives.length));
    // How it ends: the time limit always; the battle-end rules with the data's numbers where the battle has them.
    expect(m.ends[0]!.params).toEqual({ min: Math.round(b.input.rules.timeLimitSeconds / 60) });
    const be = b.input.catalog.behaviour.battleEnd!;
    const spent = m.ends.find((x) => x.key === "brief.ends.spent");
    if (b.input.rules.victory?.decided === true) {
      expect(spent?.params).toEqual({ share: Math.round(be.spentShare * 100), forS: be.spentForS, noticeS: be.noticeS });
      expect(m.ends.some((x) => x.key === "brief.ends.claim")).toBe(true);
      expect(m.ends.some((x) => x.key === "brief.ends.decided")).toBe(b.input.rules.objectives.length > 0);
    } else expect(spent).toBeUndefined();
    // Every key exists, every hull has a name, and no text is left with a raw key or an unfilled parameter.
    expect(briefingKeys(m).filter((k) => !strings.has(k))).toEqual([]);
    for (const [list, f] of [[m.own.hulls, m.own.faction], [m.enemy.hulls, m.enemy.faction]] as const) for (const x of list) expect(strings.has(x.nameKey, f), x.nameKey).toBe(true);
    for (const w of words(m)) { expect(w).not.toContain("[["); expect(w).not.toMatch(/\{\w+\}/); }
  });

  it("the task names the exit's map edge and the delay; the ends name the exits", () => {
    const amb = model("seed=3&kind=ambush&attacker=red&vehicles=0").m; // blue (west) lies in wait; red moves west to east... its exit is blue's edge
    expect(words(amb)[0]).toContain("western map edge");
    expect(amb.ends.some((x) => x.key === "brief.ends.exitEnemy")).toBe(true);
    const tr = model("seed=3&kind=ambush&attacker=blue&vehicles=0").m;
    expect(words(tr)[0]).toContain("eastern map edge");
    expect(tr.ends.some((x) => x.key === "brief.ends.exitOwn")).toBe(true);
    const wd = model("seed=3&kind=withdrawal&attacker=red&vehicles=0");
    const until = wd.b.input.forces.find((f) => f.side === "blue")!.plan!.untilS!;
    expect(words(wd.m)[0]).toContain(`for ${Math.round(until / 60)} min`);
    expect(words(wd.m)[0]).toContain("western map edge");
    expect(wd.m.objectives[0]!.key).toBe("brief.objective.until");
    const at = model("seed=3&kind=attack&vehicles=0").m;
    expect(at.ends.some((x) => x.key === "brief.ends.breakOff")).toBe(true);
  });

  it("support, late units and the clock are told", () => {
    const { m } = model("seed=3&vehicles=0&air=blue");
    expect(m.own.support.map((x) => x.key)).toEqual(["brief.support.mortar", "brief.support.drone"]);
    const ca = model("seed=3&kind=defence-counterattack&attacker=red&vehicles=0").m;
    expect(ca.own.late).toHaveLength(1);
    expect(ca.own.late[0]!.params!["min"]).toBe(16);
    const night = model("scenario=hold&seed=3&time=23:00").m;
    expect(night.situation.find((r) => r.label === "brief.time")!.value.params).toEqual({ time: "23:00", lightKey: "brief.light.night" });
    expect(model("seed=3").m.situation.find((r) => r.label === "brief.time")!.value.key).toBe("brief.timeDay");
  });

  it("the default menu battle's briefing: two platoons and their eight carriers against a believed platoon with tanks", () => {
    const base = defaultChoices({ mapKinds: ["village"], campaignFactions: [], seed: 3 });
    const { m } = model(launchSearch({ mode: "quick", c: base.quick, seed: 3, look: "photo" }));
    expect(m.own.units).toHaveLength(2);
    expect(m.own.hulls).toHaveLength(1);
    expect(m.own.hulls[0]!.count).toBe(8);
    expect(m.enemy.platoons).toBe(1);
    expect(m.enemy.hulls.length).toBe(2);
  });

  it("the fixture faction, and a battle without battle-end rules: those lines are left out", () => {
    const input = buildScenario(data, { kind: "ambush", seed: 1, mapKind: "farmland", factions: ["xf", "xf"], attacker: "red", timeLimitSeconds: 900 });
    const blue = input.forces.find((f) => f.side === "blue")!;
    blue.start = startRulesFor(blue)!;
    const m = briefingModel(input, "blue", blue.start, { mapKey: "map.farmland", hullNameKey });
    expect(m.role).toBe("ambush");
    expect(m.own.men).toBe(fightingMen(blue));
    expect(briefingKeys(m).filter((k) => !strings.has(k))).toEqual([]);
    delete input.rules.victory;
    const plain = briefingModel(input, "blue", null, { mapKey: "map.farmland", hullNameKey });
    expect(plain.ends.map((x) => x.key).filter((k) => k === "brief.ends.spent" || k === "brief.ends.claim" || k === "brief.ends.broken")).toEqual([]);
    expect(plain.ends[0]!.key).toBe("brief.ends.timePlain");
    expect(plain.fire[0]!.key).toBe(`brief.fire.${input.catalog.behaviour.decisions.defaultFireRule}`);
    expect(briefingKeys(plain).filter((k) => !strings.has(k))).toEqual([]);
  });
});
