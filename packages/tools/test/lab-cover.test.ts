/** Cover and flight lab (SPEC 5.4): the model must reproduce the public figures in docs/research/ballistics.md. */
import { describe, expect, it } from "vitest";
import { coverLab, coverLabMarkdown } from "../src/labs/cover";
import { loadData } from "../src/scenarios";

const r = coverLab(loadData());
const v = (ammo: string, range: number) => r.flight.find((f) => f.ammo === ammo && f.rangeM === range)!;
const passes = (panel: string, ammo: string, range: number) => r.cover.find((c) => c.panel.startsWith(panel) && c.ammo === ammo && c.rangeM === range)!.penetrated > 0.5;
const DM11 = "de-556-dm11", N10 = "ru-545-7n10";

describe("cover and flight lab", () => {
  it("prints its tables", () => { console.log(coverLabMarkdown(r)); });

  it("5.56 mm downrange speeds match the published table within 3 % (818 / 719 / 626 / 538 / 451 m/s from 914)", () => {
    const published = [818, 719, 626, 538, 451];
    published.forEach((p, i) => {
      const scaled = v(DM11, (i + 1) * 100).speedMps * (914 / 920); // published barrel is slightly slower at the muzzle
      expect(Math.abs(scaled - p) / p, `at ${(i + 1) * 100} m: ${scaled.toFixed(0)} vs ${p}`).toBeLessThan(0.03);
    });
  });

  it("5.45 mm downrange speeds are close to the AK-74 manual (801 / 709 / 623 / 543 m/s), a little better for the heavier 7N10", () => {
    [801, 709, 623, 543].forEach((p, i) => {
      const s = v(N10, (i + 1) * 100).speedMps;
      expect(s).toBeGreaterThan(p * 0.97);
      expect(s).toBeLessThan(p * 1.05);
    });
  });

  it("drop and time of flight at 300 m are plausible (0.6-0.9 m, 0.37-0.45 s)", () => {
    for (const a of [DM11, N10]) {
      expect(v(a, 300).dropM).toBeGreaterThan(0.6);
      expect(v(a, 300).dropM).toBeLessThan(0.9);
      expect(v(a, 300).timeS).toBeGreaterThan(0.37);
      expect(v(a, 300).timeS).toBeLessThan(0.45);
    }
  });

  it("light cover does not stop rifle bullets: hedge, wooden fence, car door, log wall", () => {
    for (const a of [DM11, N10]) for (const p of ["hedge", "wooden fence", "car door", "pine log wall"]) {
      expect(passes(p, a, 50), `${p} vs ${a}`).toBe(true);
    }
  });

  it("solid cover stops them: double brick, sandbag wall, reinforced concrete, stone wall, 20 mm steel", () => {
    for (const a of [DM11, N10]) for (const rg of [50, 300]) for (const p of ["double brick", "sandbag wall", "reinforced concrete", "stone wall", "mild steel plate, 20"]) {
      expect(passes(p, a, rg), `${p} vs ${a} at ${rg} m`).toBe(false);
    }
  });

  it("published single-round results: 5.56 mm passes a 9.5 mm steel door up close but not 5 cm of concrete or sandbags", () => {
    expect(passes("mild steel plate, 9.5", DM11, 50)).toBe(true);
    expect(passes("concrete wall, 5 cm", DM11, 50)).toBe(false);
    expect(passes("sandbags, 25 cm", DM11, 50)).toBe(false);
    expect(passes("single brick", DM11, 50)).toBe(false); // brick veneer stops 5.56 mm
  });

  it("the steel-core 7N10 penetrates more than 5.56 mm ball, and everything penetrates less at 300 m", () => {
    expect(passes("single brick", N10, 50)).toBe(true);
    expect(passes("single brick", N10, 300)).toBe(false);
    expect(passes("mild steel plate, 9.5", DM11, 300)).toBe(false);
    const log = (a: string, rg: number) => r.cover.find((c) => c.panel.startsWith("pine log") && c.ammo === a && c.rangeM === rg)!;
    expect(log(DM11, 300).speedOutMps).toBeLessThan(log(DM11, 50).speedOutMps);
  });
});
