/**
 * M10.8 (roadmap-detail slice 17): the medical statistics the review's Medical tab and the batch's medical block show
 * come from the battle record alone (`medicalSummary`), are deterministic per seed, and classify deaths of wounds by
 * the missing step of the chain of care.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { finishRecord, KILLED_OUTRIGHT_S, medianOf, medicalSummary, MISSING_STEPS, newBattleRecord, recordEvents, runBattle, TICK_HZ, type BattleRecord, type CareTrack } from "@tcs/sim";
import { getScenario, loadData } from "../src/scenarios";

const data = loadData();

function battle(name: string, seed: number, seconds: number): { rec: BattleRecord; wounded: Record<string, number>; killed: Record<string, number> } {
  const sc = getScenario(name);
  const input = sc.build(data, seed, seconds);
  const rec = newBattleRecord([...new Set(input.forces.map((f) => f.side))]);
  let pending: Parameters<typeof recordEvents>[1] = [];
  const wounded: Record<string, number> = {}, killed: Record<string, number> = {};
  const r = runBattle(input, {
    controllers: sc.controllers?.(input) ?? [],
    onEvents: (ev) => { pending = ev; },
    onTick: (sim) => {
      recordEvents(rec, pending, sim.state, input.catalog); pending = [];
      if (sim.state.ended || sim.state.tick >= seconds * TICK_HZ) {
        // (From the state, for the cross-check only: men with a wound that is not a bruise, and the dead.)
        for (const k of Object.keys(wounded)) delete wounded[k];
        for (const k of Object.keys(killed)) delete killed[k];
        for (const [id, i] of sim.state.identity.entries()) {
          const so = sim.state.soldier.get(id);
          if (!so) continue;
          if (so.wounds.some((w) => w.mechanism !== "blunt")) wounded[i.side] = (wounded[i.side] ?? 0) + 1;
          if (!so.physiology.alive) killed[i.side] = (killed[i.side] ?? 0) + 1;
        }
      }
    },
  });
  return { rec: finishRecord(rec, r), wounded, killed };
}

const track = (o: Partial<CareTrack>): CareTrack => ({ side: "blue", name: "X", callsign: "A1", w0: 600, wl: 600, down: 620, dead: null, role1: null, ...o });

describe("medical statistics (M10.8)", () => {
  it("classifies deaths of wounds by the first missing step; killed outright is not a death of wounds", () => {
    const rec = newBattleRecord(["blue", "red"]);
    const T = TICK_HZ;
    rec.track = {
      "1": track({ dead: 600 + 10 * T }), // killed within 30 s
      "2": track({ dead: 600 + 300 * T }), // untreated, died 5 min later: first aid
      "3": track({ dead: 600 + 900 * T }), // treated, never at the nest: collection
      "4": track({ dead: 600 + 1500 * T }), // at the nest, not taken off the map: evacuation
      "5": track({ role1: { inTime: false, dow: 600 + 20 * 3600 * T } }), // reached Role 1 late, died after the battle
      "6": track({ role1: { inTime: true, dow: 600 + 30 * 3600 * T } }), // in time, died anyway: no missing step
      "7": track({ role1: { inTime: true, dow: null } }), // survived
      "8": track({ side: "red", wl: 600 + 400 * T, dead: 600 + 410 * T }), // killed by a later wound, within 30 s of it
    };
    rec.firstTreated = { "3": 600 + 60 * T, "4": 600 + 30 * T, "5": 600 + 90 * T, "6": 600 + 45 * T, "7": 600 + 120 * T };
    rec.atNest = { "4": 600 + 400 * T, "5": 600 + 500 * T, "6": 600 + 300 * T, "7": 600 + 350 * T };
    rec.evacuated = { "5": 600 + 3000 * T, "6": 600 + 1200 * T, "7": 600 + 1300 * T };
    const m = medicalSummary(rec);
    const b = m["blue"]!, r = m["red"]!;
    expect(b.wounded).toBe(7);
    expect(b.killedOutright).toBe(1);
    expect(r.wounded).toBe(1);
    expect(r.killedOutright).toBe(1);
    expect(b.steps).toEqual({ firstAid: 1, collection: 1, evacuation: 1, role1Late: 1 });
    expect(b.deaths.map((d) => [d.id, d.step, d.after])).toEqual([[2, "firstAid", false], [3, "collection", false], [4, "evacuation", false], [5, "role1Late", true], [6, null, true]]);
    expect(b.deaths[0]!.afterS).toBe(300);
    expect(b.deaths[0]!.woundS).toBe(10);
    expect(b.firstCareS).toEqual([30, 45, 60, 90, 120]);
    expect(medianOf(b.firstCareS)).toBe(60);
    expect(b.nestS).toEqual([300, 350, 400, 500]);
    expect(medianOf(b.nestS)).toBe(375);
    expect(b.evacS).toEqual([1200, 1300, 3000]);
    expect(KILLED_OUTRIGHT_S).toBe(30);
  });

  it("from a real battle: matches the state's wounded and dead, deterministic per seed, survives JSON", () => {
    const one = battle("shootout", 2, 300), two = battle("shootout", 2, 300);
    const a = medicalSummary(one.rec), b = medicalSummary(two.rec);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(medicalSummary(JSON.parse(JSON.stringify(one.rec)) as BattleRecord)).toEqual(a);
    let any = 0;
    for (const side of ["blue", "red"]) {
      const m = a[side]!;
      any += m.wounded;
      expect(m.wounded).toBe(one.wounded[side] ?? 0);
      // Every man dead in the battle with a wound is killed outright or a death of wounds in the battle.
      const inBattle = m.deaths.filter((d) => !d.after).length;
      expect(m.killedOutright + inBattle).toBeLessThanOrEqual(one.killed[side] ?? 0);
      for (const d of m.deaths) expect(d.afterS).toBeGreaterThan(0);
    }
    expect(any).toBeGreaterThan(0);
  }, 120_000);

  it("every key the Medical and Conduct tabs build is in the string table", () => {
    const t = JSON.parse(readFileSync(new URL("../../data/core/strings.en.json", import.meta.url), "utf8")) as Record<string, string>;
    const keys = [
      ...MISSING_STEPS.map((k) => `aar.medical.step.${k}`), "aar.medical.step.none", "aar.medical.summary", "aar.medical.times", "aar.medical.preventable",
      "aar.medical.noPreventable", "aar.medical.death", "aar.medical.deathAfter", "aar.medical.none", "aar.medical.empty",
      ...["medical", "carrying", "point", "surrendered", "wounded", "prisoner"].map((k) => `aar.conduct.prot.${k}`),
      "aar.conduct.cause.misidentified", "aar.conduct.cause.deliberate", "aar.conduct.summary", "aar.conduct.hits", "aar.conduct.breach", "aar.conduct.more", "aar.conduct.empty",
    ];
    expect(keys.filter((k) => typeof t[k] !== "string")).toEqual([]);
  });
});
