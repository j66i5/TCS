/** Gunnery lab (M7.3, SPEC 6.7 "turret, sights, ammo racks"): bands are game values (stations in vehicles.json). */
import { describe, expect, it } from "vitest";
import { gunneryLab, gunneryLabMarkdown } from "../src/labs/gunnery";
import { loadData } from "../src/scenarios";

const rows = gunneryLab(loadData());
const val = (v: string, c: string) => {
  const r = rows.find((x) => x.vehicle === v && x.case.startsWith(c));
  if (!r) throw new Error(`no row ${v} / ${c}`);
  return r.value;
};

describe("gunnery lab", () => {
  it("prints its table", () => {
    console.log(gunneryLabMarkdown(rows));
  });
  for (const v of ["de-puma", "ru-bmp2"]) {
    it(`${v}: hits on a halted hull fall with range and on the move; the turret lays in seconds`, () => {
      const h1000 = val(v, "AP at a halted hull side-on, 1000 m"), h1500 = val(v, "AP at a halted hull side-on, 1500 m"), move = val(v, "AP on the move");
      expect(h1000).toBeGreaterThan(0.6);
      expect(h1500).toBeLessThanOrEqual(h1000);
      expect(h1500).toBeGreaterThan(0.3);
      expect(move).toBeLessThan(h1000);
      expect(move).toBeGreaterThan(0.05);
      const lay = val(v, "order to first round");
      expect(lay).toBeGreaterThan(1.5); // the order's radio delay, the turret's slew and its tolerance
      expect(lay).toBeLessThan(8);
    });
    it(`${v}: high explosive hurts men in the open; every round is counted; a ready belt is refilled in about 90 s (Q17)`, () => {
      expect(val(v, "HE at six men")).toBeGreaterThan(0);
      expect(val(v, "rounds fired in 400 s")).toBeGreaterThan(100);
      expect(val(v, "rounds fired - (ready + stowed")).toBe(0);
      expect(val(v, "refilling a ready belt")).toBeCloseTo(90, 0);
    });
  }
  it("the Puma (laser rangefinder, faster turret) beats the BMP-2 at range and on the move", () => {
    expect(val("de-puma", "AP at a halted hull side-on, 1500 m")).toBeGreaterThan(val("ru-bmp2", "AP at a halted hull side-on, 1500 m"));
    expect(val("de-puma", "AP on the move")).toBeGreaterThan(val("ru-bmp2", "AP on the move"));
    expect(val("de-puma", "order to first round")).toBeLessThan(val("ru-bmp2", "order to first round"));
  });
});
