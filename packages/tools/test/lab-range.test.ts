/** Firing range lab (SPEC 5.4). Owner's benchmark 2026-11-11: regular, prone, rested: about 50 % at 300 m. */
import { describe, expect, it } from "vitest";
import { rangeLab, rangeLabMarkdown, SKILLS } from "../src/labs/range";
import { loadData } from "../src/scenarios";

const r = rangeLab(loadData());
const WEAPONS = ["de-g36", "ru-ak74m"];
const at = (rows: typeof r.byRange, w: string, f: (x: (typeof r.byRange)[number]) => boolean) => rows.find((x) => x.weapon === w && f(x))!.hitRate;

describe("firing range lab", () => {
  it("prints its tables", () => { console.log(rangeLabMarkdown(r)); });

  it("a regular soldier, prone and rested, hits a man-sized target about half the time at 300 m (owner's benchmark)", () => {
    const rates = WEAPONS.map((w) => at(r.byRange, w, (x) => x.rangeM === 300));
    for (const rate of rates) { expect(rate).toBeGreaterThan(0.38); expect(rate).toBeLessThan(0.68); }
    const mean = rates.reduce((a, b) => a + b, 0) / rates.length;
    expect(mean).toBeGreaterThan(0.45);
    expect(mean).toBeLessThan(0.62);
  });

  it("hit rate falls with range: nearly certain at 50 m, a quarter to a third at 500 m", () => {
    for (const w of WEAPONS) {
      const by = (rg: number) => at(r.byRange, w, (x) => x.rangeM === rg);
      expect(by(50)).toBeGreaterThan(0.95);
      expect(by(50)).toBeLessThanOrEqual(1);
      expect(by(200)).toBeGreaterThan(by(300));
      expect(by(300)).toBeGreaterThan(by(400));
      expect(by(400)).toBeGreaterThan(by(500) - 0.03);
      expect(by(500)).toBeGreaterThan(0.12);
      expect(by(500)).toBeLessThan(0.45);
    }
  });

  it("rate of fire depends on range (owner): bursts inside 30 m, about one shot a second to 100 m, 2-3 s beyond", () => {
    for (const w of WEAPONS) {
      const sec = (rg: number) => r.byRange.find((x) => x.weapon === w && x.rangeM === rg)!.secondsPerShot;
      expect(sec(25)).toBeLessThan(0.7);
      expect(sec(100)).toBeGreaterThan(0.8);
      expect(sec(100)).toBeLessThan(1.3);
      expect(sec(300)).toBeGreaterThan(2);
      expect(sec(300)).toBeLessThan(3);
    }
  });

  it("training level matters (owner): veteran clearly better than regular, conscript clearly worse", () => {
    for (const w of WEAPONS) {
      const by = (s: number) => at(r.bySkill, w, (x) => x.skill === s && x.rangeM === 300);
      expect(by(SKILLS.veteran)).toBeGreaterThan(by(SKILLS.regular) + 0.05);
      expect(by(SKILLS.regular)).toBeGreaterThan(by(SKILLS.conscript) + 0.05);
    }
  });

  it("posture matters: prone better than crouching better than standing", () => {
    for (const w of WEAPONS) for (const rg of [100, 200, 300]) {
      const by = (p: string) => at(r.byPosture, w, (x) => x.posture === p && x.rangeM === rg);
      expect(by("prone")).toBeGreaterThan(by("crouching") + 0.05);
      expect(by("crouching")).toBeGreaterThan(by("standing") + 0.03);
    }
  });

  it("an exhausted man shoots clearly worse", () => {
    for (const w of WEAPONS) {
      const by = (f: number) => at(r.byFatigue, w, (x) => x.fatigue === f);
      expect(by(0)).toBeGreaterThan(by(0.5) + 0.08);
      expect(by(0.5)).toBeGreaterThan(by(0.9));
    }
  });
});
