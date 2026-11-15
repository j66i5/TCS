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
  // M7.6a: main battle tanks (Leopard 2A7V vs T-90M both ways, T-72B3M vs the Leopard).
  const TANKS: { v: string; cycle: [number, number]; other: "loader" | "gunner"; otherCycle: [number, number] }[] = [
    { v: "de-leopard2a7v", cycle: [5.5, 7], other: "loader", otherCycle: [13, 17] },
    { v: "ru-t90m", cycle: [6.5, 8], other: "gunner", otherCycle: [6.5, 8.5] },
    { v: "ru-t72b3m", cycle: [7, 8.5], other: "gunner", otherCycle: [7, 9] },
  ];
  const data = loadData();
  for (const { v, cycle, other, otherCycle } of TANKS) {
    it(`${v}: armour-piercing hits a halted hull side-on out to 3 km and on the move; the turret lays in seconds`, () => {
      expect(val(v, "AP at a halted hull side-on, 1000 m")).toBeGreaterThan(0.8);
      expect(val(v, "AP at a halted hull side-on, 2000 m")).toBeGreaterThan(0.7);
      expect(val(v, "AP at a halted hull side-on, 3000 m")).toBeGreaterThan(v === "ru-t72b3m" ? 0.4 : 0.5);
      expect(val(v, "AP on the move")).toBeGreaterThan(0.3);
      const lay = val(v, "order to first round");
      expect(lay).toBeGreaterThan(1.5);
      expect(lay).toBeLessThan(8); // a round is in the breech at the start (startLoaded)
    });
    it(`${v}: one round at a time at its loading cycle; with the ${other} killed the commander takes over`, () => {
      const c = val(v, "seconds between AP rounds at the full rate");
      expect(c).toBeGreaterThanOrEqual(cycle[0]);
      expect(c).toBeLessThanOrEqual(cycle[1]);
      const k = val(v, `same, the ${other} killed`);
      expect(k).toBeGreaterThanOrEqual(otherCycle[0]);
      expect(k).toBeLessThanOrEqual(otherCycle[1]);
    });
    it(`${v}: an ordered fire slows to the trickle after its 30 s at the full rate (review fix: the load no longer overrides it)`, () => {
      const t = val(v, "seconds between AP rounds after the full rate");
      expect(t).toBeGreaterThanOrEqual(8.5); // shooting.json fire.trickleIntervalS 10 s, +-15 %
      expect(t).toBeLessThanOrEqual(11.5);
      const n = val(v, "AP rounds in the first 60 s");
      expect(n).toBeGreaterThanOrEqual(6); // about 30 / cycle + 1 at the full rate, then two or three at the trickle
      expect(n).toBeLessThanOrEqual(10);
    });
    it(`${v}: high explosive hurts men in the open; every round is counted; the ready rack is refilled in its refill time`, () => {
      expect(val(v, "HE at six men")).toBeGreaterThan(0);
      expect(val(v, "rounds fired - (ready + stowed")).toBe(0);
      const refill = data.factions[v.startsWith("de-") ? "de" : "ru"]!.vehicles[v]!.stations[0]!.refillSeconds!;
      expect(val(v, "refilling a ready belt")).toBeCloseTo(refill, 0);
    });
  }
  it("the T-90M's crew chooses armour-piercing at a Leopard side-on at 1500 m and its missile at 3000 m", () => {
    expect(val("ru-t90m", "own choice at a tank side-on 1500 m")).toBe(0);
    expect(val("ru-t90m", "own choice at a tank side-on 3000 m")).toBe(1);
    expect(rows.find((r) => r.vehicle === "ru-t90m" && r.case.startsWith("own choice at a tank side-on 3000 m"))!.case).toContain("why.nature.missileFar");
  });
  it("the Puma (laser rangefinder, faster turret) beats the BMP-2 at range and on the move", () => {
    expect(val("de-puma", "AP at a halted hull side-on, 1500 m")).toBeGreaterThan(val("ru-bmp2", "AP at a halted hull side-on, 1500 m"));
    expect(val("de-puma", "AP on the move")).toBeGreaterThan(val("ru-bmp2", "AP on the move"));
    expect(val("de-puma", "order to first round")).toBeLessThan(val("ru-bmp2", "order to first round"));
  });
});
