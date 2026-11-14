/** M8.2a: the call-for-fire chain — phases, first-round error by location method, planned targets. */
import { describe, expect, it } from "vitest";
import { demoBattle } from "@tcs/scenario";
import { createSim, firstRoundErrorM, missionPhases, secondsToEffect, step, submitOrder, type BattleInput, type Sim, type SimEvent } from "@tcs/sim";
import { loadData } from "../src/scenarios";

const data = loadData();
function battle(seed = 3, prep?: (i: BattleInput) => void): BattleInput {
  const input = demoBattle(data, { seed, factions: ["de", "ru"], mapWidthM: 1200, mapHeightM: 400, frontM: 300, timeLimitSeconds: 900 });
  input.rules.support = [{ side: "blue", he: 12, smoke: 4 }, { side: "red", he: 12, smoke: 4 }];
  prep?.(input);
  return input;
}
const top = (sim: Sim, side: string) => [...sim.state.unit.entries()].find(([, u]) => u.side === side && u.parent === null)![0];
function run(sim: Sim, seconds: number): SimEvent[] {
  const out: SimEvent[] = [];
  for (let k = 0; k < seconds * 60; k++) out.push(...step(sim));
  return out;
}

describe("call-for-fire chain (M8.2a)", () => {
  it("time to effect is the sum of the phases: comms, request, processing, flight, then ranging", () => {
    const input = battle();
    const sim = createSim(input);
    const fs = input.catalog.factions["de"]!.fireSupport!;
    const ph = missionPhases(fs);
    expect(ph.requestS).toBeGreaterThan(0); expect(ph.processingS).toBeGreaterThan(0); expect(ph.flightS).toBeGreaterThan(0);
    expect(ph.requestS + ph.processingS + ph.flightS).toBeCloseTo(fs.delaySeconds, 6);
    submitOrder(sim, { tick: 0, issuer: "blue", target: top(sim, "blue"), kind: "callFire", x: 900, y: 200, ammo: "he", rounds: 4 });
    const ev = run(sim, secondsToEffect(fs) + 40);
    const call = ev.find((e) => e.kind === "support.call")!;
    const shots = ev.filter((e) => e.kind === "support.shot");
    const splashes = ev.filter((e) => e.kind === "support.splash");
    const bursts = ev.filter((e): e is Extract<SimEvent, { kind: "explosion" }> => e.kind === "explosion" && e.ammo === fs.heAmmo);
    // Call -> shot (request + processing) -> splash (5 s before) -> the first ranging round lands (flight).
    expect((shots[0]!.tick - call.tick) / 60).toBeCloseTo(ph.requestS + ph.processingS, 1);
    expect((bursts[0]!.tick - shots[0]!.tick) / 60).toBeCloseTo(ph.flightS, 1);
    expect((bursts[0]!.tick - splashes[0]!.tick) / 60).toBeCloseTo(fs.splashSeconds ?? 5, 1);
    // One "shot" per ranging round and one for the first volley; the first volley for effect after the ranging.
    expect(shots).toHaveLength(fs.rangingRounds + 1);
    const effect = bursts[fs.rangingRounds]!;
    expect((effect.tick - call.tick) / 60).toBeCloseTo(secondsToEffect(fs), 1);
    // Issue to effect: the order's comms delay plus all of that.
    expect(call.tick).toBeGreaterThan(0);
    expect(effect.tick / 60).toBeCloseTo(call.tick / 60 + secondsToEffect(fs), 1);
    for (const k of ["radio.fireCall", "radio.fireShot", "radio.fireSplash"]) expect(ev.some((e) => e.kind === "radio" && e.key === k)).toBe(true);
  });

  it("at 500 m a map or eye estimate misses about 3x as far as a laser rangefinder", () => {
    for (const f of ["de", "ru"]) {
      const fs = battle().catalog.factions[f]!.fireSupport!;
      const r = firstRoundErrorM(fs, "estimate", 500) / firstRoundErrorM(fs, "laser", 500);
      expect(r).toBeGreaterThan(2.4); expect(r).toBeLessThan(3.8);
    }
    // In the sim: the leader 500 m from the point, with and without a laser binocular, 30 seeds each.
    const miss = (laser: boolean) => {
      let sum = 0, n = 0;
      const methods = new Set<string>();
      for (let seed = 1; seed <= 30; seed++) {
        const input = battle(seed, (i) => { if (laser) i.catalog.items["test-lrf"] = { id: "test-lrf", nameKey: "item.test-lrf", massKg: 1, volumeL: 1, rangefinder: true } as never; });
        const sim = createSim(input);
        const u = sim.state.unit.get(top(sim, "blue"))!;
        const leader = u.leader!;
        if (laser) sim.state.container.get(leader)!.stacks.push({ type: "test-lrf", count: 1 } as never);
        const t = sim.state.transform.get(leader)!;
        submitOrder(sim, { tick: 0, issuer: "blue", target: top(sim, "blue"), kind: "callFire", x: Math.min(t.x + 500, 1190), y: t.y, ammo: "he", rounds: 1 });
        const ev = run(sim, 20);
        const c = ev.find((e): e is Extract<SimEvent, { kind: "support.call" }> => e.kind === "support.call");
        const m = sim.state.fireMissions[0];
        if (!c || !m) continue;
        methods.add(c.method);
        sum += Math.hypot(m.ex ?? 0, m.ey ?? 0); n++;
      }
      return { mean: sum / n, methods: [...methods] };
    };
    const est = miss(false), lrf = miss(true);
    expect(est.methods).toEqual(["estimate"]);
    expect(lrf.methods).toEqual(["laser"]);
    expect(est.mean / lrf.mean).toBeGreaterThan(2.2);
    expect(est.mean / lrf.mean).toBeLessThan(4.2);
  });

  it("a planned target set in deployment is fired on at once, without ranging", () => {
    const input = battle(3, (i) => { i.rules.support![0]!.planned = [{ x: 900, y: 200 }]; });
    const sim = createSim(input);
    const fs = input.catalog.factions["de"]!.fireSupport!;
    expect(sim.state.support[0]!.registered?.[0]?.planned).toBe(true);
    submitOrder(sim, { tick: 0, issuer: "blue", target: top(sim, "blue"), kind: "callFire", x: 920, y: 210, ammo: "he", rounds: 2 });
    const ev = run(sim, fs.delaySeconds + 20);
    expect(ev.find((e) => e.kind === "support.call")).toMatchObject({ method: "registered" });
    expect(ev.filter((e) => e.kind === "support.ranging")).toHaveLength(0);
    expect(ev.filter((e) => e.kind === "explosion" && e.ammo === fs.heAmmo)).toHaveLength(2);
  });
});
