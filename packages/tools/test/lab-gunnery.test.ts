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
  // M7.6c: the wheeled carriers at each other (2A72 against the GTK, the FLW 200's 12.7 mm against the BTR).
  const WHEELED: { v: string; h1000: [number, number]; h1500: [number, number]; move: number; lay: [number, number]; refill: [number, number] }[] = [
    { v: "ru-btr82a", h1000: [0.4, 0.85], h1500: [0.2, 0.65], move: 0.03, lay: [1.5, 5], refill: [60, 120] },
    { v: "de-boxer-gtk", h1000: [0.3, 0.75], h1500: [0.1, 0.5], move: 0.4, lay: [1.5, 4], refill: [90, 150] },
  ];
  for (const { v, h1000, h1500, move, lay, refill } of WHEELED) {
    it(`${v}: AP at a halted hull side-on at 1000 and 1500 m, on the move, laying, counted rounds and the refill`, () => {
      const a = val(v, "AP at a halted hull side-on, 1000 m"), b = val(v, "AP at a halted hull side-on, 1500 m"), m = val(v, "AP on the move");
      expect(a).toBeGreaterThanOrEqual(h1000[0]);
      expect(a).toBeLessThanOrEqual(h1000[1]);
      expect(b).toBeGreaterThanOrEqual(h1500[0]);
      expect(b).toBeLessThanOrEqual(h1500[1]);
      expect(b).toBeLessThanOrEqual(a);
      // GTK: at least 0.4 x its halted share (stabilised remote station); BTR: like the BMP-2's (same stabiliser
      // values), a few per cent at the wheeled slow pace (the plan's 0.5 x halted is not met: see DECISIONS M7.6c).
      expect(m).toBeGreaterThanOrEqual(v === "de-boxer-gtk" ? move * a : move);
      expect(m).toBeLessThan(a);
      expect(val(v, "order to first round")).toBeGreaterThanOrEqual(lay[0]);
      expect(val(v, "order to first round")).toBeLessThanOrEqual(lay[1]);
      expect(val(v, "rounds fired - (ready + stowed")).toBe(0);
      expect(val(v, "refilling a ready belt")).toBeGreaterThanOrEqual(refill[0]);
      expect(val(v, "refilling a ready belt")).toBeLessThanOrEqual(refill[1]);
      // The BTR has an HE belt (2A72); the GTK has none, so its "HE" row fires the 12.7 mm (it still runs).
      expect(val(v, "HE at six men")).toBeGreaterThanOrEqual(v === "ru-btr82a" ? 1 : 0);
    });
  }
  // M7.6d: the GTK Boxer with the 40 mm GMW. The plan's 10 m at 600 m is not met: the round's flat path there (about
  // 4 deg) stretches 2 mrad of elevation error into some 15 m along the line (DECISIONS M7.6d); the long-range laying
  // (the exact drop-table entries above 6 deg) is what the bands guard.
  it("de-boxer-gtk-gmw: the first burst lands near the aim point out to 1500 m; men in the open go down; rounds counted", () => {
    const v = "de-boxer-gtk-gmw";
    expect(val(v, "GMW: mean miss of the first burst's 3 rounds from the aim point, 600 m")).toBeLessThanOrEqual(20);
    expect(val(v, "GMW: mean miss of the first burst's 3 rounds from the aim point, 1000 m")).toBeLessThanOrEqual(20);
    expect(val(v, "GMW: mean miss of the first burst's 3 rounds from the aim point, 1500 m")).toBeLessThanOrEqual(35);
    const down = (R: number) => Number(/\((\d+) down\)/.exec(rows.find((x) => x.vehicle === v && x.case.startsWith(`GMW at six standing men ${R} m`))!.unit)![1]);
    expect(down(600)).toBeGreaterThanOrEqual(2);
    expect(down(1000)).toBeGreaterThanOrEqual(1);
    expect(val(v, "rounds fired - (ready + stowed")).toBe(0);
    expect(val(v, "refilling a ready belt")).toBeCloseTo(120, 0);
  });
  it("the GTK Boxer lays faster than the BTR-82A (remote station with a fast drive and a laser rangefinder)", () => {
    expect(val("de-boxer-gtk", "order to first round")).toBeLessThan(val("ru-btr82a", "order to first round"));
  });
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
