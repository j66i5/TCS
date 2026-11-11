/**
 * Cover and flight lab (SPEC 5.4). The model must reproduce the public figures in docs/research/ballistics.md
 * AT THE RANGES THE SOURCES STATE, and the asserted results must hold when the muzzle velocity is 3 % lower or
 * higher (no result may hinge on a few m/s).
 */
import { describe, expect, it } from "vitest";
import { buildCatalog } from "@tcs/data";
import { coverLab, coverLabMarkdown, shotPasses } from "../src/labs/cover";
import { loadData } from "../src/scenarios";

const data = loadData();
const catalog = buildCatalog(data, ["de", "ru"]);
const r = coverLab(data);
const v = (ammo: string, range: number) => r.flight.find((f) => f.ammo === ammo && f.rangeM === range)!;
const DM11 = "de-556-dm11", N10 = "ru-545-7n10";
/** Result must be the same at -3 %, nominal and +3 % muzzle velocity. */
const robust = (ammo: string, material: string, thicknessM: number, rangeM: number): boolean | "marginal" => {
  const res = [0.97, 1, 1.03].map((s) => shotPasses(catalog, ammo, material, thicknessM, rangeM, s));
  return res.every((x) => x === res[0]) ? res[0]! : "marginal";
};

describe("flight", () => {
  it("prints the lab tables", () => { console.log(coverLabMarkdown(r)); });

  it("5.56 mm downrange speeds match the published table within 3 % (818 / 719 / 626 / 538 / 451 m/s from 914)", () => {
    [818, 719, 626, 538, 451].forEach((p, i) => {
      const scaled = v(DM11, (i + 1) * 100).speedMps * (914 / 920); // the published barrel is slightly slower at the muzzle
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
});

describe("published penetration figures, at the ranges the sources give", () => {
  it("5.56 mm: 3.5 mm of mild steel at 570 m and at 640 m (NATO requirement); not at 800 m", () => {
    expect(shotPasses(catalog, DM11, "steel", 0.0035, 570)).toBe(true);
    expect(shotPasses(catalog, DM11, "steel", 0.0035, 640)).toBe(true);
    expect(shotPasses(catalog, DM11, "steel", 0.0035, 800)).toBe(false);
  });

  it("5.56 mm: a 9.5 mm (3/8 in) mild steel door with one round at 25 m and at 100 m (US FM 3-06.11)", () => {
    expect(robust(DM11, "steel", 0.0095, 25)).toBe(true);
    expect(robust(DM11, "steel", 0.0095, 100)).toBe(true);
  });

  it("5.45 mm 7N10: 16 mm of steel at 100 m; not at 200 m", () => {
    expect(robust(N10, "steel", 0.016, 100)).toBe(true);
    expect(robust(N10, "steel", 0.016, 200)).toBe(false);
  });

  it("5.56 mm at under 50 m is stopped by 5 cm of concrete, one thickness of sandbags and brick veneer (US FM 3-06.11)", () => {
    for (const range of [10, 25, 50]) {
      expect(robust(DM11, "concrete", 0.05, range), `concrete at ${range} m`).toBe(false);
      expect(robust(DM11, "soil", 0.25, range), `sandbags at ${range} m`).toBe(false);
      expect(robust(DM11, "brick", 0.11, range), `brick at ${range} m`).toBe(false);
    }
  });

  it("5.56 mm goes through a 41 cm (16 in) log wall at 25-100 m (US FM 3-06.11: 1-3 rounds)", () => {
    for (const range of [25, 50, 100]) expect(robust(DM11, "wood", 0.41, range)).toBe(true);
  });

  it("5.45 mm steel-core goes through 11 cm of brickwork at 100 m (Russian norm for the weaker 7N6: 10-12 cm), not at 300 m", () => {
    expect(robust(N10, "brick", 0.11, 100)).toBe(true);
    expect(robust(N10, "brick", 0.11, 300)).toBe(false);
  });

  it("45 cm sandbag walls, double brick, reinforced concrete and stone walls stop both rifles at any range", () => {
    for (const a of [DM11, N10]) for (const range of [10, 50, 300]) {
      expect(robust(a, "soil", 0.45, range)).toBe(false);
      expect(robust(a, "brick", 0.24, range)).toBe(false);
      expect(robust(a, "reinforced-concrete", 0.2, range)).toBe(false);
      expect(robust(a, "stone", 0.5, range)).toBe(false);
    }
  });

  it("hedges, wooden fences and car doors stop neither", () => {
    for (const a of [DM11, N10]) for (const range of [50, 300]) {
      expect(robust(a, "hedge", 1.5, range)).toBe(true);
      expect(robust(a, "wood", 0.04, range)).toBe(true);
      expect(robust(a, "sheet-metal", 0.002, range)).toBe(true);
    }
  });
});
