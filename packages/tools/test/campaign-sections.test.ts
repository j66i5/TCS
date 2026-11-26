/**
 * Balance pass 6 (owner 2026-11-20: "Smaller forces vs strong side"): half platoons in the campaign. A platoon's two
 * halves are listed, validated and committed under the platoon's own key; the enemy commits one when the men it wants
 * are few; a side whose men are worth more is proposed fewer platoons; a battle fought by a half brings its men back
 * by unit key and leaves the men who stayed at home where they are.
 */
import { describe, expect, it } from "vitest";
import {
  autoResolve, battleInputs, briefingView, campaignRules, chooseForces, commitOf, commitProblems, confirmForces, enemyChoice, generateOperation,
  membersOf, menOf, newCampaign, phaseOf, proposeChoice, sectionsOf, selectables, setChoice, startFlow, unitsOf, validateCommit, valueRatio,
  type FlowEnv,
} from "@tcs/campaign";
import { aiRunner } from "../src/campaign";
import { loadData, ON_POSTS } from "../src/scenarios";

const data = loadData(true);
const ENV: FlowEnv = { runner: aiRunner, hooks: ON_POSTS };

describe("balance pass 6: half platoons", () => {
  const rec = newCampaign(data, { seed: 5, faction: "de", enemy: "ru" });
  const p = rec.sides.player, e = rec.sides.enemy;
  const sel = selectables(data, p);
  const plat = sel.find((s) => s.what === "platoon")!;
  const a = `${plat.key}/a`, b = `${plat.key}/b`;

  it("the data switches them on", () => {
    expect(campaignRules(data).battle.sections).toBe(true);
  });

  it("each platoon is followed by its two halves; their men and hulls add up to the platoon's", () => {
    const i = sel.findIndex((s) => s.key === plat.key);
    expect(sel[i + 1]).toMatchObject({ key: a, what: "section", platoon: plat.key, half: "a" });
    expect(sel[i + 2]).toMatchObject({ key: b, what: "section", platoon: plat.key, half: "b" });
    expect(sel[i + 1]!.men + sel[i + 2]!.men).toBe(plat.men);
    expect(sel[i + 1]!.men).toBeGreaterThan(0);
    expect(sel[i + 2]!.men).toBeGreaterThan(0);
    const hulls = (k: string) => (commitOf(data, p, [k]).vehicles ?? []).length;
    expect(hulls(a) + hulls(b)).toBe(hulls(plat.key));
    expect(hulls(a)).toBeGreaterThan(0);
    expect(hulls(b)).toBeGreaterThan(0);
    // The same for the other side's platoons (another organisation: the headquarters rides with a squad).
    for (const s of selectables(data, e).filter((x) => x.what === "platoon")) {
      const ha = selectables(data, e).find((x) => x.key === `${s.key}/a`)!, hb = selectables(data, e).find((x) => x.key === `${s.key}/b`)!;
      expect(ha.men + hb.men).toBe(s.men);
    }
  });

  it("half a keeps the platoon's own men (its headquarters); half b goes without them; both are valid alone", () => {
    const tree = unitsOf(p.battalion).find((u) => u.key === plat.key)!;
    const sec = sectionsOf(tree)!;
    expect(sec.a.members.length).toBe(tree.members.length);
    expect(sec.b.members.length).toBe(0);
    expect(sec.a.key).toBe(plat.key);
    expect(sec.b.key).toBe(plat.key);
    expect(validateCommit(data, p, [a])).toEqual([]);
    expect(validateCommit(data, p, [b])).toEqual([]);
    // Every squad committed has its carrier and every carrier its squad.
    for (const k of [a, b]) expect(commitProblems(data, p, [k]).filter((x) => x.key === "squadNoCarrier" || x.key === "carrierNoSquad")).toEqual([]);
  });

  it("both halves of a platoon are the platoon; a platoon with one of its halves is 'twice'; halves count toward the cap", () => {
    const whole = commitOf(data, p, [plat.key]), both = commitOf(data, p, [a, b]);
    expect(JSON.stringify(both)).toBe(JSON.stringify(whole));
    expect(validateCommit(data, p, [a, b])).toEqual([]);
    expect(validateCommit(data, p, [plat.key, a])).toContain(`twice: ${a}`);
    expect(validateCommit(data, p, [b, plat.key])).toContain(`twice: ${plat.key}`);
    const plats = sel.filter((s) => s.what === "platoon").map((s) => s.key);
    const cap = campaignRules(data).battle.platoons;
    expect(validateCommit(data, p, plats.slice(0, cap + 1).map((k) => `${k}/a`)).some((x) => x.startsWith(`platoons ${cap + 1}`))).toBe(true);
    expect(validateCommit(data, p, [sel.find((s) => s.what === "hq")!.key])).toContain("no able platoon");
  });

  it("the enemy commits one half platoon when the men it wants are well under a platoon, else platoons as before", () => {
    const es = new Map(selectables(data, e).map((s) => [s.key, s]));
    const fittest = Math.max(...[...es.values()].filter((s) => s.what === "platoon").map((s) => s.men));
    const few = enemyChoice(data, e, 30, 0.3, true);
    expect(few).toHaveLength(1);
    expect(es.get(few[0]!)!.what).toBe("section");
    expect(validateCommit(data, e, few)).toEqual([]);
    // The half nearest the number wanted.
    const halves = [...es.values()].filter((s) => s.what === "section" && s.platoon === es.get(few[0]!)!.platoon);
    expect(Math.abs(es.get(few[0]!)!.men - 9)).toBe(Math.min(...halves.map((h) => Math.abs(h.men - 9))));
    const more = enemyChoice(data, e, fittest, 0.8, false);
    expect(more.every((k) => es.get(k)!.what === "platoon")).toBe(true);
  });

  it("the same men never fight two battles of a node: a half committed keeps its platoon and its other half out of the other battle", () => {
    const main = enemyChoice(data, e, 30, 0.3, true);
    const pl = main[0]!.slice(0, -2);
    for (const want of [10, 30, 60, 200]) {
      const flank = enemyChoice(data, e, want, 1, true, main);
      expect(flank).not.toContain(pl);
      expect(flank).not.toContain(`${pl}/a`);
      expect(flank).not.toContain(`${pl}/b`);
      const ids = (keys: string[]) => commitOf(data, e, keys).units.flatMap(unitsOf).flatMap((u) => u.members.map((m) => m.personId));
      const inMain = new Set(ids(main));
      expect(ids(flank).filter((id) => inMain.has(id))).toEqual([]);
    }
    expect(validateCommit(data, e, [pl], main)).toContain(`committed elsewhere: ${pl}`);
    expect(validateCommit(data, p, [a], [plat.key])).toContain(`committed elsewhere: ${a}`);
    // The player's flank proposal leaves the company of a chosen half alone.
    expect(proposeChoice(data, p, [b]).some((k) => k === plat.key || k.startsWith(`${plat.key}/`) || k === sel.find((s) => s.key === plat.key)!.company)).toBe(false);
  });

  it("a side whose men are worth more is proposed fewer platoons, at three to one half a platoon, with headquarters and support; the equal side all three", () => {
    const B = campaignRules(data).battle, cap = B.platoons;
    const what = (keys: string[], w: string) => keys.filter((k) => sel.find((s) => s.key === k)?.what === w).length;
    expect(what(proposeChoice(data, p), "platoon")).toBe(cap);
    expect(what(proposeChoice(data, p), "section")).toBe(0);
    expect(what(proposeChoice(data, p, [], 1 / 3), "platoon")).toBe(cap);
    // Between 1 and `proposeSectionAtRatio`: the cap divided by the ratio.
    expect(B.proposeSectionAtRatio).toBe(3);
    expect(what(proposeChoice(data, p, [], 2), "platoon")).toBe(Math.max(1, Math.round(cap / 2)));
    expect(what(proposeChoice(data, p, [], 2), "section")).toBe(0);
    // At three to one: the half with the platoon's headquarters, the company headquarters and the support.
    const strong = proposeChoice(data, p, [], 3);
    expect(what(strong, "platoon")).toBe(0);
    expect(strong.filter((k) => k.endsWith("/a"))).toHaveLength(1);
    expect(what(strong, "hq")).toBe(1);
    expect(strong.length).toBeGreaterThan(2);
    expect(validateCommit(data, p, strong)).toEqual([]);
    // The flow and the briefing use the factions' values.
    const r = chooseForces(data, startFlow(data, rec));
    expect(r.flow!.choice).toEqual(proposeChoice(data, p, [], valueRatio(data, rec)));
    expect(briefingView(data, r).proposed).toEqual(r.flow!.choice);
  });

  it("the briefing lists the halves with the platoon's callsign and their hulls", () => {
    const v = briefingView(data, chooseForces(data, startFlow(data, rec)));
    const row = v.selectables.find((x) => x.key === b)!;
    expect(row.callsign).toBe(v.selectables.find((x) => x.key === plat.key)!.callsign);
    expect(row.hulls).toBe((commitOf(data, p, [b]).vehicles ?? []).length);
  });

  it("a battle fought by half b: built and run; its men come back by key, the men at home are untouched, the books balance", () => {
    let r = generateOperation(data, newCampaign(data, { seed: 5, faction: "de", enemy: "ru", battleSeconds: 60 }));
    r.flow = { phase: "choose", choice: [b] };
    expect(setChoice(data, r, [b]).problems).toEqual([]);
    r = confirmForces(data, r);
    const nb = battleInputs(data, r, ON_POSTS);
    expect(nb.main).not.toBeNull();
    const blue = nb.main!.input.forces.find((f) => f.units.some((u) => u.key === plat.key))!;
    // (The battle adds its own assets, ambulances and the like: only the battalion's units are counted.)
    expect(menOf(blue.units.filter((u) => u.key === plat.key))).toBe(sel.find((s) => s.key === b)!.men);
    expect(blue.units.filter((u) => unitsOf(r.sides.player.battalion).some((x) => x.key === u.key)).map((u) => u.key)).toEqual([plat.key]);
    const tree0 = unitsOf(r.sides.player.battalion).find((u) => u.key === plat.key)!;
    const home0 = tree0.members.map((m) => m.personId), leader0 = tree0.leaderIndex;
    const stayed0 = sectionsOf(tree0)!.a.subunits.map((u) => JSON.stringify(u));
    const n0 = membersOf(r.sides.player.battalion).length;
    const after = autoResolve(data, r, ENV);
    expect(phaseOf(after)).toBe("after-battle");
    const tree1 = unitsOf(after.sides.player.battalion).find((u) => u.key === plat.key)!;
    // The headquarters stayed at home: the same men, the same leader.
    expect(tree1.members.map((m) => m.personId)).toEqual(home0);
    expect(tree1.leaderIndex).toBe(leader0);
    // The other half's squads and crews were not in the battle: unchanged.
    for (const u of sectionsOf(tree1)!.a.subunits) expect(stayed0).toContain(JSON.stringify(u));
    // Nobody vanished: men now in the battalion plus those in the pools are the men before.
    const pools = after.sides.player.pools;
    const pooled = pools.recovering.length + pools.dead.length + pools.missing.length + pools.heldByEnemy.length;
    expect(membersOf(after.sides.player.battalion).length + pooled).toBe(n0);
  }, 120_000);
});
