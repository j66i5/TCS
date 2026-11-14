/** Drive lab (M7.1b): the bands of docs/plans/m7-vehicles.md §4, driven by orders to the crew unit only. */
import { describe, expect, it } from "vitest";
import { driveLab, driveLabMarkdown, SURFACES, WHEELED } from "../src/labs/drive";
import { loadData } from "../src/scenarios";

const rows = driveLab(loadData(true));
const val = (v: string, c: string) => {
  const r = rows.find((x) => x.vehicle === v && x.case === c);
  if (!r) throw new Error(`no row ${v} / ${c}`);
  return r.value;
};

describe("drive lab", () => {
  it("prints its table", () => {
    console.log(driveLabMarkdown(rows));
  });
  it("0-50 km/h on asphalt: Puma 8-14 s, BMP-2 7-12 s", () => {
    expect(val("de-puma", "0-50 km/h on asphalt")).toBeGreaterThanOrEqual(8);
    expect(val("de-puma", "0-50 km/h on asphalt")).toBeLessThanOrEqual(14);
    expect(val("ru-bmp2", "0-50 km/h on asphalt")).toBeGreaterThanOrEqual(7);
    expect(val("ru-bmp2", "0-50 km/h on asphalt")).toBeLessThanOrEqual(12);
  });
  it("top speed and reverse top speed within 5 % of the data", () => {
    expect(Math.abs(val("de-puma", "top speed") / 70 - 1)).toBeLessThanOrEqual(0.05);
    expect(Math.abs(val("ru-bmp2", "top speed") / 65 - 1)).toBeLessThanOrEqual(0.05);
    expect(Math.abs(val("de-puma", "reverse top speed") / 30 - 1)).toBeLessThanOrEqual(0.05);
    expect(Math.abs(val("ru-bmp2", "reverse top speed") / 12 - 1)).toBeLessThanOrEqual(0.05);
  });
  it("braking from 50 km/h 12-25 m, from 70 km/h 28-45 m", () => {
    for (const v of ["de-puma", "ru-bmp2"]) {
      expect(val(v, "braking from 50 km/h")).toBeGreaterThanOrEqual(12);
      expect(val(v, "braking from 50 km/h")).toBeLessThanOrEqual(25);
    }
    expect(val("de-puma", "braking from 70 km/h")).toBeGreaterThanOrEqual(28);
    expect(val("de-puma", "braking from 70 km/h")).toBeLessThanOrEqual(45);
  });
  it("pivot 90 degrees in 2-4 s", () => {
    for (const v of ["de-puma", "ru-bmp2"]) {
      expect(val(v, "pivot 90 deg")).toBeGreaterThanOrEqual(2);
      expect(val(v, "pivot 90 deg")).toBeLessThanOrEqual(4);
    }
  });
  it("asphalt faster than grass, than ploughed, than mud; rain slower than dry on each (rain lowers traction)", () => {
    for (const v of ["de-puma", "ru-bmp2"]) {
      for (let i = 1; i < SURFACES.length; i++) expect(val(v, `300 m on ${SURFACES[i]}, dry`)).toBeGreaterThan(val(v, `300 m on ${SURFACES[i - 1]}, dry`));
      for (const s of SURFACES) expect(val(v, `300 m on ${s}, rain`)).toBeGreaterThan(val(v, `300 m on ${s}, dry`));
      for (const s of SURFACES) expect(Number.isFinite(val(v, `300 m on ${s}, rain`))).toBe(true);
    }
  });
  it("climbs a 20 % slope, burns fuel, and does not move without a driver", () => {
    for (const v of ["de-puma", "ru-bmp2"]) {
      expect(val(v, "top speed up a 20 % slope")).toBeGreaterThan(1);
      expect(val(v, "fuel for 1000 m at full pace")).toBeGreaterThan(0.2);
      expect(val(v, "fuel for 1000 m at full pace")).toBeLessThan(5);
      expect(val(v, "moved in 30 s with the driver dead")).toBe(0);
    }
  });
  it("wheeled ambulances (M10.6-data): Boxer 0-50 in 8-16 s, BMM 10-18 s; top and reverse speed within 5 %; braking 12-25 m", () => {
    expect(val("de-boxer-san", "0-50 km/h on asphalt")).toBeGreaterThanOrEqual(8);
    expect(val("de-boxer-san", "0-50 km/h on asphalt")).toBeLessThanOrEqual(16);
    expect(val("ru-bmm", "0-50 km/h on asphalt")).toBeGreaterThanOrEqual(10);
    expect(val("ru-bmm", "0-50 km/h on asphalt")).toBeLessThanOrEqual(18);
    expect(Math.abs(val("de-boxer-san", "top speed") / 100 - 1)).toBeLessThanOrEqual(0.05);
    expect(Math.abs(val("ru-bmm", "top speed") / 80 - 1)).toBeLessThanOrEqual(0.05);
    expect(Math.abs(val("de-boxer-san", "reverse top speed") / 20 - 1)).toBeLessThanOrEqual(0.05);
    expect(Math.abs(val("ru-bmm", "reverse top speed") / 15 - 1)).toBeLessThanOrEqual(0.05);
    for (const v of WHEELED) {
      expect(val(v, "braking from 50 km/h")).toBeGreaterThanOrEqual(12);
      expect(val(v, "braking from 50 km/h")).toBeLessThanOrEqual(25);
    }
  });
  it("wheeled ambulances: no pivot (90 degrees from a standstill in 3-10 s), turning circle 20-30 m, ground order, slope, fuel, no driver", () => {
    for (const v of WHEELED) {
      expect(val(v, "turn 90 deg from a standstill")).toBeGreaterThanOrEqual(3);
      expect(val(v, "turn 90 deg from a standstill")).toBeLessThanOrEqual(10);
      expect(val(v, "turning circle (diameter)")).toBeGreaterThanOrEqual(20);
      expect(val(v, "turning circle (diameter)")).toBeLessThanOrEqual(30);
      for (let i = 1; i < SURFACES.length; i++) expect(val(v, `300 m on ${SURFACES[i]}, dry`)).toBeGreaterThan(val(v, `300 m on ${SURFACES[i - 1]}, dry`));
      for (const s of SURFACES) expect(val(v, `300 m on ${s}, rain`)).toBeGreaterThan(val(v, `300 m on ${s}, dry`));
      expect(val(v, "top speed up a 20 % slope")).toBeGreaterThan(1);
      expect(val(v, "fuel for 1000 m at full pace")).toBeGreaterThan(0.2);
      expect(val(v, "fuel for 1000 m at full pace")).toBeLessThan(5);
      expect(val(v, "moved in 30 s with the driver dead")).toBe(0);
    }
  });
});
