/**
 * Armour lab (M7.4a, plan C43): the plate test at the published boundaries (can >= need), the Puma and BMP-2
 * plates against the published protection claims, the owner's Q21 answer (the Puma's front stops a PG-7VL),
 * and ricochets only at grazing angles.
 */
import { describe, expect, it } from "vitest";
import { buildCatalog } from "@tcs/data";
import { plateNeed, type PlateRT } from "@tcs/sim";
import { ARMOUR_LAB_VEHICLES, armourLab, plateThrough, referenceRounds } from "../src/labs/armour";
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

  it("the lab table covers every vehicle asked for, every part and face", () => {
    const two = armourLab(data, ["de-puma", "ru-bmp2"]);
    expect(new Set(two.map((r) => `${r.vehicle}/${r.part}/${r.face}`)).size).toBe(16);
    expect(two.every((r) => r.era === "none")).toBe(true);
    const all = armourLab(data);
    expect(new Set(all.map((r) => `${r.vehicle}/${r.part}/${r.face}`)).size).toBe(8 * ARMOUR_LAB_VEHICLES.length);
    // The Puma and BMP-2 rows are what they were before the tanks (the same plates, no tiles).
    const key = (r: (typeof all)[number]) => `${r.vehicle}/${r.part}/${r.face}/${r.round}`;
    const before = new Map(two.map((r) => [key(r), r]));
    for (const r of all.filter((x) => x.vehicle === "de-puma" || x.vehicle === "ru-bmp2")) expect(r).toEqual(before.get(key(r)));
  });
});

describe("armour lab: main battle tanks (M7.6a)", () => {
  const thru = (v: string, part: "hull" | "turret", f: number, id: string, era: "none" | "full" | "spent" = "none") => {
    const rd = referenceRounds(data).find((r) => r.id === id)!;
    return plateThrough(data, v, part, f, rd.mildMm, rd.kind, undefined, era).through;
  };
  const LEO = "de-leopard2a7v", T90 = "ru-t90m", T72 = "ru-t72b3m";

  it("DM63A1 at 2 km: the T-90M's fronts stop it with Relikt there and not without; Kontakt-5 does not save the T-72B3M's turret", () => {
    for (const part of ["hull", "turret"] as const) {
      expect(thru(T90, part, 0, "de-120-dm63a1", "full")).toBe(false);
      expect(thru(T90, part, 0, "de-120-dm63a1", "spent")).toBe(true);
    }
    expect(thru(T72, "turret", 0, "de-120-dm63a1", "full")).toBe(true);
  });

  it("3BM60: the Leopard's turret front stops it; its hull front at 2 km but not at 1 km", () => {
    expect(thru(LEO, "turret", 0, "ru-125-3bm60")).toBe(false);
    expect(thru(LEO, "hull", 0, "ru-125-3bm60")).toBe(false);
    expect(thru(LEO, "hull", 0, "ru-125-3bm60-1000")).toBe(true);
  });

  it("3BM42: every Leopard front stops it; its sides do not", () => {
    for (const part of ["hull", "turret"] as const) {
      expect(thru(LEO, part, 0, "ru-125-3bm42")).toBe(false);
      expect(thru(LEO, part, 1, "ru-125-3bm42")).toBe(true);
    }
  });

  it("PG-7VL: through the Leopard's hull side, not its fronts; the T-90M's hull front even without tiles; its hull side only without", () => {
    expect(thru(LEO, "hull", 1, "ru-pg7vl")).toBe(true);
    for (const part of ["hull", "turret"] as const) expect(thru(LEO, part, 0, "ru-pg7vl")).toBe(false);
    expect(thru(T90, "hull", 0, "ru-pg7vl", "spent")).toBe(false);
    expect(thru(T90, "hull", 1, "ru-pg7vl", "full")).toBe(false);
    expect(thru(T90, "hull", 1, "ru-pg7vl", "spent")).toBe(true);
  });

  it("Panzerfaust 3: the T-90M's hull front stops it with Relikt, not without; its hull side does not even with", () => {
    expect(thru(T90, "hull", 0, "de-pzf3-dm12", "full")).toBe(false);
    expect(thru(T90, "hull", 0, "de-pzf3-dm12", "spent")).toBe(true);
    expect(thru(T90, "hull", 1, "de-pzf3-dm12", "full")).toBe(true);
  });

  it("Konkurs-M: the T-90M's hull front stops it with Relikt only; the Leopard's hull front stops it, its side does not", () => {
    expect(thru(T90, "hull", 0, "ru-9m113m", "full")).toBe(false);
    expect(thru(T90, "hull", 0, "ru-9m113m", "spent")).toBe(true);
    expect(thru(LEO, "hull", 0, "ru-9m113m")).toBe(false);
    expect(thru(LEO, "hull", 1, "ru-9m113m")).toBe(true);
  });

  it("Kornet: through the T-90M's hull front with Relikt and the Leopard's hull front; the Leopard's turret front stops it", () => {
    expect(thru(T90, "hull", 0, "lab-9m133", "full")).toBe(true);
    expect(thru(LEO, "hull", 0, "lab-9m133")).toBe(true);
    expect(thru(LEO, "turret", 0, "lab-9m133")).toBe(false);
  });

  it("Spike LR from above goes through both turret roofs", () => {
    expect(thru(T90, "turret", 3, "de-spike-lr")).toBe(true);
    expect(thru(LEO, "turret", 3, "de-spike-lr")).toBe(true);
  });

  it("30 mm PMC287: through the T-90M's hull side (below the tile's trigger), stopped by the Leopard's", () => {
    expect(thru(T90, "hull", 1, "de-30x173-pmc287", "full")).toBe(true);
    expect(thru(LEO, "hull", 1, "de-30x173-pmc287")).toBe(false);
  });

  // M7.6c: the wheeled carriers. Reference rounds: 7.62 mm B-32 AP at 75 m, 12.7 mm B-32 at 500 m, 3UBR8 at 1500 m
  // (more at 1000 m), PMC287 at 1000 m.
  const thruW = (v: string, part: "hull" | "turret", face: number, id: string) => plateThrough(data, v, part, face, can(id), referenceRounds(data).find((r) => r.id === id)!.kind).through;
  it("BTR-82A: the front stops 12.7 mm at 500 m, the sides and rear do not; 7.62 mm AP stopped by the hull's front, sides and rear; every 30 mm AP round goes through every face", () => {
    expect(thruW("ru-btr82a", "hull", 0, "lab-12_7mm-b32")).toBe(false);
    expect(thruW("ru-btr82a", "hull", 1, "lab-12_7mm-b32")).toBe(true);
    expect(thruW("ru-btr82a", "hull", 2, "lab-12_7mm-b32")).toBe(true);
    for (const f of [0, 1, 2]) expect(thruW("ru-btr82a", "hull", f, "lab-762-b32")).toBe(false);
    expect(thruW("ru-btr82a", "turret", 0, "lab-762-b32")).toBe(false);
    for (const part of ["hull", "turret"] as const) for (let f = 0; f < 4; f++) {
      expect(thruW("ru-btr82a", part, f, "ru-30x165-3ubr8")).toBe(true);
      expect(thruW("ru-btr82a", part, f, "de-30x173-pmc287")).toBe(true);
    }
  });
  it("GTK Boxer: 12.7 mm at 500 m and 7.62 mm AP stopped by every hull face (about STANAG level 4); 30 mm AP through its sides; the FLW 200 is thin", () => {
    for (let f = 0; f < 3; f++) {
      expect(thruW("de-boxer-gtk", "hull", f, "lab-12_7mm-b32")).toBe(false);
      expect(thruW("de-boxer-gtk", "hull", f, "lab-762-b32")).toBe(false);
    }
    expect(thruW("de-boxer-gtk", "hull", 1, "ru-30x165-3ubr8")).toBe(true);
    expect(thruW("de-boxer-gtk", "hull", 1, "de-30x173-pmc287")).toBe(true);
    expect(thruW("de-boxer-gtk", "turret", 0, "lab-762-b32")).toBe(true);
  });
});
