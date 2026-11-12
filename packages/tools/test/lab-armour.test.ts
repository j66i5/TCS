/**
 * Armour lab (M7.4a, plan C43): the plate test at the published boundaries (can >= need), the Puma and BMP-2
 * plates against the published protection claims, the owner's Q21 answer (the Puma's front stops a PG-7VL),
 * and ricochets only at grazing angles.
 */
import { describe, expect, it } from "vitest";
import { buildCatalog } from "@tcs/data";
import { plateNeed, type PlateRT } from "@tcs/sim";
import { armourLab, plateThrough, referenceRounds } from "../src/labs/armour";
import { loadData } from "../src/scenarios";

const data = loadData();
const cat = buildCatalog(data, ["de", "ru"]);
const can = (id: string) => referenceRounds(data).find((r) => r.id === id)!.mildMm;
const steel = cat.terrain.materials["armour-steel"]!;
/** A plate of armour steel `t` mm thick leaning back `slopeDeg`. */
function plate(t: number, slopeDeg: number): PlateRT {
  const s = (slopeDeg * Math.PI) / 180;
  return { thicknessMm: t, kPerMm: steel.resistance, sPerMm: steel.resistance, cosS: Math.cos(s), sinS: Math.sin(s), sinCrit: Math.sin((steel.ricochetAngleDeg * Math.PI) / 180), material: "armour-steel" };
}
const headOn = (p: PlateRT) => plateNeed(p, 0, 1, -1, 0, 0, cat.ballistics.armour.losFloorCos);

describe("armour lab (M7.4a)", () => {
  it("armour steel is RHA: its resistance equals rhaToMildSteel", () => {
    expect(steel.resistance).toBe(cat.ballistics.rhaToMildSteel);
  });

  it("PMC287 at its 1000 m speed defeats 53 mm armour steel at 60 degrees and is stopped by 1.03 x 53 mm", () => {
    expect(can("de-30x173-pmc287") >= headOn(plate(53, 60)).needK).toBe(true);
    expect(can("de-30x173-pmc287") >= headOn(plate(53 * 1.03, 60)).needK).toBe(false);
  });

  it("3UBR8 at its 1500 m speed defeats 25 mm at 60 degrees and is stopped by 1.03 x 25 mm", () => {
    expect(can("ru-30x165-3ubr8") >= headOn(plate(25, 60)).needK).toBe(true);
    expect(can("ru-30x165-3ubr8") >= headOn(plate(25 * 1.03, 60)).needK).toBe(false);
  });

  it("the Puma's front stops PMC287 at 1000 m even 3 % faster; its sides stop 14.5 mm", () => {
    const pmc = can("de-30x173-pmc287") * Math.pow(1.03, cat.ballistics.penetrationVelocityExponent);
    for (const part of ["hull", "turret"] as const) {
      expect(plateThrough(data, "de-puma", part, 0, pmc, false).through).toBe(false);
      expect(plateThrough(data, "de-puma", part, 1, can("lab-14_5mm-b32"), false).through).toBe(false);
    }
    // ... and a 30 mm round goes through the sides.
    expect(plateThrough(data, "de-puma", "hull", 1, can("ru-30x165-3ubr8"), false).through).toBe(true);
  });

  it("the BMP-2's front stops 23 mm AP at 500 m; its sides stop 7.62 mm AP at 75 m but not 12.7 mm", () => {
    for (const part of ["hull", "turret"] as const) {
      expect(plateThrough(data, "ru-bmp2", part, 0, can("lab-23mm-ap"), false).through).toBe(false);
      expect(plateThrough(data, "ru-bmp2", part, 1, can("lab-762-b32"), false).through).toBe(false);
      expect(plateThrough(data, "ru-bmp2", part, 1, can("lab-12_7mm-b32"), false).through).toBe(true);
    }
  });

  it("owner Q21 (b): a PG-7VL is stopped by the Puma's front, goes through its sides, rear and roof; the Panzerfaust goes through a BMP-2 anywhere", () => {
    for (const part of ["hull", "turret"] as const) {
      expect(plateThrough(data, "de-puma", part, 0, can("ru-pg7vl"), true).through).toBe(false);
      for (const f of [1, 2, 3]) expect(plateThrough(data, "de-puma", part, f, can("ru-pg7vl"), true).through).toBe(true);
      for (const f of [0, 1, 2, 3]) expect(plateThrough(data, "ru-bmp2", part, f, can("de-pzf3-dm12"), true).through).toBe(true);
    }
    // A rocket coming down 5 degrees onto the glacis is still stopped.
    const e = (5 * Math.PI) / 180;
    expect(plateThrough(data, "de-puma", "hull", 0, can("ru-pg7vl"), true, [-Math.cos(e), 0, -Math.sin(e)]).through).toBe(false);
  });

  it("a kinetic round can ricochet only at a grazing angle", () => {
    const p = plate(20, 0);
    const graze = (deg: number) => { const a = (deg * Math.PI) / 180; return plateNeed(p, 0, 1, -Math.cos(a), Math.sin(a), 0, 0.05); };
    const rf = cat.ammo["de-30x173-pmc287"]!.ricochetFactor ?? 1;
    expect(graze(85).cosInc < graze(85).sinCrit * rf).toBe(true);
    expect(graze(60).cosInc < graze(60).sinCrit * rf).toBe(false);
    expect(graze(0).cosInc).toBeCloseTo(1, 6);
  });

  it("the lab table covers both vehicles, every part and face", () => {
    const rows = armourLab(data);
    expect(new Set(rows.map((r) => `${r.vehicle}/${r.part}/${r.face}`)).size).toBe(16);
  });
});
