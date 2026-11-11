/** Movement & fatigue lab (SPEC 5.4): plausible bands. Owner decisions 2026-11-11 set fatigue and posture. */
import { describe, expect, it } from "vitest";
import { movementLab, movementLabMarkdown } from "../src/labs/movement";
import { loadData } from "../src/scenarios";

const r = movementLab(loadData());
const mv = (c: string, mode: string, kg: number) => r.moves.find((m) => m.case === c && m.mode === mode && m.loadKg === kg)!;

describe("movement lab", () => {
  it("prints its table", () => {
    console.log(movementLabMarkdown(r));
  });
  it("walking pace ~1.4 m/s unloaded, slower with load", () => {
    expect(mv("flat", "walk", 0).speedMps).toBeGreaterThan(1.3);
    expect(mv("flat", "walk", 0).speedMps).toBeLessThan(1.5);
    expect(mv("flat", "walk", 24).speedMps).toBeLessThan(mv("flat", "walk", 0).speedMps);
    expect(mv("flat", "walk", 48).speedMps).toBeLessThan(mv("flat", "walk", 24).speedMps);
    expect(mv("flat", "walk", 48).speedMps).toBeGreaterThan(0.9);
  });
  it("running ~3 m/s, sneaking and crawling much slower", () => {
    expect(mv("flat", "run", 0).speedMps).toBeGreaterThan(3.0);
    expect(mv("flat", "run", 24).speedMps).toBeGreaterThan(2.6);
    expect(mv("flat", "sneak", 24).speedMps).toBeLessThan(0.8);
    expect(mv("flat", "crawl", 24).speedMps).toBeLessThan(0.35);
  });
  it("slopes: uphill slower (Tobler), 10 % downhill about as fast as flat; woods slower", () => {
    const flat = mv("flat", "walk", 24).speedMps;
    expect(mv("uphill 10 %", "walk", 24).speedMps / flat).toBeGreaterThan(0.6);
    expect(mv("uphill 10 %", "walk", 24).speedMps / flat).toBeLessThan(0.8);
    expect(mv("uphill 20 %", "walk", 24).speedMps).toBeLessThan(mv("uphill 10 %", "walk", 24).speedMps);
    expect(mv("downhill 10 %", "walk", 24).speedMps / flat).toBeGreaterThan(0.95);
    expect(mv("woodland", "walk", 24).speedMps / flat).toBeGreaterThan(0.7);
    expect(mv("woodland", "walk", 24).speedMps / flat).toBeLessThan(0.9);
  });
  it("loaded running: clearly winded after 2-3 min, recovered after ~5 min rest; walking is sustainable", () => {
    const f = (c: string, kg: number) => r.fatigue.find((x) => x.case === c && x.loadKg === kg)!;
    expect(f("running 150 s", 24).fatigue).toBeGreaterThan(0.55);
    expect(f("running 150 s", 24).fatigue).toBeLessThan(0.85);
    expect(f("running 150 s", 0).fatigue).toBeLessThan(f("running 150 s", 24).fatigue);
    expect(f("running 150 s", 24).hr).toBeGreaterThan(170);
    expect(f("running 60 s", 24).fatigue).toBeLessThan(0.4); // not yet winded after one minute
    expect(f("resting 60 s", 24).fatigue).toBeGreaterThan(0.3); // one minute's rest is not enough
    expect(f("resting 300 s", 24).fatigue).toBeLessThan(0.15);
    expect(f("resting 300 s", 24).hr).toBeLessThan(90);
    expect(mv("flat", "walk", 24).fatigueEnd).toBeLessThan(0.05);
  });
  it("posture changes are brisk when light and slower with load (owner decision)", () => {
    const p = (from: string, to: string, kg: number) => r.postures.find((x) => x.from === from && x.to === to && x.loadKg === kg)!.seconds;
    expect(p("standing", "prone", 0)).toBeCloseTo(1.0);
    expect(p("prone", "standing", 0)).toBeCloseTo(1.5);
    expect(p("standing", "prone", 24)).toBeGreaterThan(1.0);
    expect(p("standing", "prone", 48)).toBeGreaterThan(p("standing", "prone", 24));
  });
});
