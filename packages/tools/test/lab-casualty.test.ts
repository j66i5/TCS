/**
 * Casualty lab (SPEC 5.4, 6.4). Owner decisions 2026-11-11: helmet + plates; the helmet stops fragments, not rifle
 * rounds; a plate hit knocks down and bruises; realistic lethality mix; realistic bleeding clock.
 * The bands are wide on purpose: the table itself goes to the owner for review.
 */
import { describe, expect, it } from "vitest";
import { casualtyLab, casualtyLabMarkdown } from "../src/labs/casualty";
import { loadData } from "../src/scenarios";

const rows = casualtyLab(loadData());
const row = (part: string) => rows.find((r) => r.name.includes(part))!;
const share = (a: number, b: number) => a / Math.max(1, b);

describe("casualty lab", () => {
  it("prints its tables", () => { console.log(casualtyLabMarkdown(rows)); });

  it("every case strikes its men and the outcome counts add up", () => {
    for (const r of rows) {
      expect(r.struck).toBeGreaterThan(250);
      expect(r.savedByArmour + r.wounded).toBe(r.struck);
      expect(r.killedOutright + r.incapacitated + r.woundedAble).toBe(r.wounded);
      expect(Object.values(r.zones).reduce((a, b) => a + b, 0)).toBe(r.struck);
      expect(r.dead60min).toBeGreaterThanOrEqual(r.dead10min);
      expect(r.dead10min).toBeGreaterThanOrEqual(r.killedOutright);
    }
  });

  it("plates: a third to two thirds of men struck from the front are saved; plates are never pierced by these rifles", () => {
    for (const name of ["G36 at 100 m, standing, facing, helmet", "AK-74M at 100 m, standing, facing"]) {
      const r = row(name);
      expect(share(r.savedByArmour, r.struck)).toBeGreaterThan(0.33);
      expect(share(r.savedByArmour, r.struck)).toBeLessThan(0.67);
      expect(share(r.torsoStopped, r.torsoStopped + r.torsoThrough + r.torsoUncovered)).toBeGreaterThan(0.5);
    }
    expect(row("NO armour").savedByArmour).toBe(0);
    // Side-on the plate hardly helps.
    expect(share(row("side-on").savedByArmour, row("side-on").struck)).toBeLessThan(0.15);
  });

  it("the helmet does not stop rifle rounds at these ranges (owner decision)", () => {
    const stopped = rows.reduce((n, r) => n + r.headStopped, 0), all = rows.reduce((n, r) => n + r.headStopped + r.headThrough, 0);
    expect(all).toBeGreaterThan(50);
    expect(share(stopped, all)).toBeLessThan(0.15);
  });

  it("lethality mix: without armour about a quarter to a third die at once; armour more than halves deaths per man struck", () => {
    const bare = row("NO armour"), plated = row("G36 at 100 m, standing, facing, helmet");
    expect(share(bare.killedOutright, bare.wounded)).toBeGreaterThan(0.18);
    expect(share(bare.killedOutright, bare.wounded)).toBeLessThan(0.4);
    expect(share(plated.killedOutright, plated.struck)).toBeLessThan(0.5 * share(bare.killedOutright, bare.struck));
    // Across the standing, armoured cases most wounded men are alive and conscious right after the hit.
    for (const r of rows.filter((x) => x.name.includes("standing") && x.name.includes("plates"))) {
      expect(share(r.killedOutright, r.wounded)).toBeLessThan(0.3);
      expect(share(r.woundedAble, r.wounded)).toBeGreaterThan(0.6);
    }
  });

  it("the clock: with no care at all more die within the hour than at once, but most wounded are still alive after 10 minutes", () => {
    for (const r of rows.filter((x) => x.name.includes("standing"))) {
      expect(r.dead60min).toBeGreaterThan(r.killedOutright);
      expect(share(r.dead10min, r.wounded)).toBeLessThan(0.6);
      expect(share(r.dead60min, r.wounded)).toBeLessThan(0.7);
      expect(r.medianMinutesToCollapse).not.toBeNull();
      expect(r.medianMinutesToCollapse!).toBeGreaterThan(2);
      expect(r.medianMinutesToCollapse!).toBeLessThan(20);
    }
  });

  it("where rounds strike follows the posture: chest first standing; head and shoulders prone", () => {
    const st = row("G36 at 100 m, standing, facing, helmet"), pr = row("prone");
    expect(share(st.zones["chest"] ?? 0, st.struck)).toBeGreaterThan(0.4);
    expect(share((pr.zones["head"] ?? 0) + (pr.zones["chest"] ?? 0) + (pr.zones["arm"] ?? 0) + (pr.zones["neck"] ?? 0), pr.struck)).toBeGreaterThan(0.95);
    expect(share(pr.zones["head"] ?? 0, pr.struck)).toBeGreaterThan(0.3);
    // At 300 m the rounds scatter over the whole body.
    const far = row("G36 at 300 m");
    expect(share((far.zones["leg"] ?? 0) + (far.zones["pelvis"] ?? 0), far.struck)).toBeGreaterThan(0.1);
  });
});
