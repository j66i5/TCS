/** M6.5c: mortar fire and smoke (pulled forward from M8 by the owner). */
import { describe, expect, it } from "vitest";
import { demoBattle } from "@tcs/scenario";
import { createSim, hashState, loadSim, saveSim, secondsToEffect, step, submitOrder, supportLeft, type BattleInput, type Sim, type SimEvent } from "@tcs/sim";
import { loadData } from "../src/scenarios";

const data = loadData();
function battle(prep?: (i: BattleInput) => void): BattleInput {
  const input = demoBattle(data, { seed: 3, factions: ["de", "ru"], mapWidthM: 800, mapHeightM: 400, frontM: 300, timeLimitSeconds: 900 });
  input.rules.support = [{ side: "blue", he: 6, smoke: 4 }, { side: "red", he: 6, smoke: 4 }];
  prep?.(input);
  return input;
}
const top = (sim: Sim, side: string) => [...sim.state.unit.entries()].find(([, u]) => u.side === side && u.parent === null)![0];
function run(sim: Sim, seconds: number): SimEvent[] {
  const out: SimEvent[] = [];
  for (let k = 0; k < seconds * 60; k++) out.push(...step(sim));
  return out;
}

describe("fire support (M6.5c)", () => {
  it("ranging rounds first, then the battery's volleys; the ranging rounds come out of the stock too (rule 9)", () => {
    const input = battle((i) => { i.rules.support = [{ side: "blue", he: 10, smoke: 4 }, { side: "red", he: 6, smoke: 4 }]; });
    const sim = createSim(input);
    const fs = input.catalog.factions["de"]!.fireSupport!;
    const tx = 600, ty = 300;
    submitOrder(sim, { tick: 0, issuer: "blue", target: top(sim, "blue"), kind: "callFire", x: tx, y: ty, ammo: "he", rounds: 4 });
    const ev = run(sim, secondsToEffect(fs) + 2 * fs.intervalSeconds + 15);
    const bursts = ev.filter((e): e is Extract<SimEvent, { kind: "explosion" }> => e.kind === "explosion" && e.ammo === fs.heAmmo);
    const ranging = ev.filter((e): e is Extract<SimEvent, { kind: "support.ranging" }> => e.kind === "support.ranging");
    // Two ranging rounds one at a time, then the four for effect as one volley of the battery's tubes.
    expect(ranging).toHaveLength(fs.rangingRounds);
    expect(bursts).toHaveLength(4 + fs.rangingRounds);
    expect(bursts[0]!.tick / 60).toBeGreaterThanOrEqual(fs.delaySeconds);
    expect((bursts[1]!.tick - bursts[0]!.tick) / 60).toBeCloseTo(fs.rangingSeconds, 1);
    const effect = bursts.slice(fs.rangingRounds);
    expect((effect[effect.length - 1]!.tick - effect[0]!.tick) / 60).toBeLessThan(fs.tubes * fs.volleySpreadSeconds + 0.1);
    expect(ev.some((e) => e.kind === "radio" && e.key === "radio.fireForEffect")).toBe(true);
    expect(ev.some((e) => e.kind === "radio" && (e.key === "radio.fireAdjust" || e.key === "radio.fireUnobserved"))).toBe(true);
    for (const b of effect) expect(Math.hypot(b.x - tx, b.y - ty)).toBeLessThan(4 * fs.dispersionM + 4 * fs.rangingErrorM);
    // 10 HE - 4 asked - 2 ranging.
    expect(supportLeft(sim.state, "blue", "he")).toBe(4);
    const sec = sim.state.support.find((s) => s.side === "blue")!;
    const c = sim.state.container.req(sec.battery);
    expect(c.stacks.find((s) => s.type === fs.heAmmo)?.count).toBe(4);
    expect(c.stacks.find((s) => s.type === fs.smokeAmmo)?.count).toBe(4);
    // The point is ranged on now: a second mission near it fires for effect at once (no ranging rounds).
    expect(sec.registered).toHaveLength(1);
    submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: top(sim, "blue"), kind: "callFire", x: tx + 40, y: ty, ammo: "he", rounds: 2 });
    const ev2 = run(sim, fs.delaySeconds + 15);
    expect(ev2.filter((e) => e.kind === "support.ranging")).toHaveLength(0);
    expect(ev2.filter((e) => e.kind === "explosion" && e.ammo === fs.heAmmo)).toHaveLength(2);
    expect(supportLeft(sim.state, "blue", "he")).toBe(2);
    // Asking for more than is left gets what is left; nothing left: unable.
    submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: top(sim, "blue"), kind: "callFire", x: tx, y: ty, ammo: "he", rounds: 10 });
    run(sim, 3);
    expect(supportLeft(sim.state, "blue", "he")).toBe(0);
    submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: top(sim, "blue"), kind: "callFire", x: tx, y: ty, ammo: "he", rounds: 1 });
    expect(run(sim, 3).some((e) => e.kind === "radio" && e.key === "radio.unable")).toBe(true);
  });

  it("short of rounds, the mission gives up ranging rounds first and keeps one for effect", () => {
    const input = battle((i) => { i.rules.support = [{ side: "blue", he: 2, smoke: 0 }, { side: "red", he: 0, smoke: 0 }]; });
    const sim = createSim(input);
    const fs = input.catalog.factions["de"]!.fireSupport!;
    submitOrder(sim, { tick: 0, issuer: "blue", target: top(sim, "blue"), kind: "callFire", x: 600, y: 300, ammo: "he", rounds: 4 });
    const ev = run(sim, secondsToEffect(fs) + 15);
    expect(ev.filter((e) => e.kind === "support.ranging")).toHaveLength(1);
    expect(ev.filter((e) => e.kind === "explosion" && e.ammo === fs.heAmmo)).toHaveLength(2);
  });

  it("a ranging round the caller sees brings the next rounds closer; one he cannot see does not", () => {
    const fs = battle().catalog.factions["de"]!.fireSupport!;
    const errors = (seeIt: boolean) => {
      const sim = createSim(battle());
      const caller = sim.state.unit.get(top(sim, "blue"))!.leader!;
      submitOrder(sim, { tick: 0, issuer: "blue", target: top(sim, "blue"), kind: "callFire", x: 600, y: 300, ammo: "he", rounds: 2 });
      run(sim, 3);
      const m = sim.state.fireMissions[0]!;
      const e0 = Math.hypot(m.ex ?? 0, m.ey ?? 0);
      // Blind him (a thick smoke cloud on him) or not, through the ranging.
      if (!seeIt) { const t = sim.state.transform.get(caller)!; sim.state.smoke.push({ x: t.x, y: t.y, radiusM: 60, startTick: -100000, untilTick: 1e9 }); }
      const ev = run(sim, fs.delaySeconds + fs.rangingSeconds);
      return { e0, e1: Math.hypot(m.ex ?? 0, m.ey ?? 0), seen: ev.filter((e): e is Extract<SimEvent, { kind: "support.ranging" }> => e.kind === "support.ranging").map((e) => e.seen) };
    };
    const blind = errors(false);
    expect(blind.seen.every((x) => !x)).toBe(true);
    expect(blind.e1).toBeCloseTo(blind.e0, 6);
    const open = errors(true);
    // (Same seed, same first error: he sees at least one of them on the open demo ground.)
    expect(open.seen.some((x) => x)).toBe(true);
    // (M8.2b: the observer's skill scales the correction, his reading of the fall adds a few metres.)
    expect(open.e1).toBeLessThan(open.e0 * fs.rangingCorrection * (fs.adjust?.skillWorst ?? 1) + 4 * (fs.adjust ? fs.adjust.readBaseM + fs.adjust.readPerM * 600 : 0) + 1e-6);
    expect(open.e1).toBeLessThan(open.e0);
  });

  it("smoke between them hides men from each other; without it they are seen", () => {
    const seen = (smoke: boolean) => {
      const sim = createSim(battle());
      if (smoke) {
        // A screen laid in the middle, long enough across the line of sight.
        for (const y of [140, 170, 200, 230, 260]) sim.state.smoke.push({ x: 400, y, radiusM: 30, startTick: -10000, untilTick: 100000 });
      }
      return run(sim, 40).filter((e) => e.kind === "spotted").length;
    };
    expect(seen(false)).toBeGreaterThan(0);
    expect(seen(true)).toBe(0);
  });

  it("a smoke mission lays clouds that clear after their time; missions survive save and load", () => {
    const input = battle();
    const sim = createSim(input);
    const fs = input.catalog.factions["ru"]!.fireSupport!;
    submitOrder(sim, { tick: 0, issuer: "red", target: top(sim, "red"), kind: "callFire", x: 300, y: 200, ammo: "smoke", rounds: 2 });
    run(sim, fs.delaySeconds + 5);
    // (Mid-ranging: the first ranging round is down, the mission saved with its aiming error.)
    const copy = loadSim({ ...input, orders: [] }, saveSim(sim));
    const ev = run(sim, secondsToEffect(fs) - fs.delaySeconds + 10); run(copy, secondsToEffect(fs) - fs.delaySeconds + 10);
    expect(hashState(copy.state)).toBe(hashState(sim.state));
    // The second ranging round and the two for effect (smoke ranges with smoke).
    expect(ev.filter((e) => e.kind === "support.smoke")).toHaveLength(3);
    expect(sim.state.smoke).toHaveLength(4);
    run(sim, fs.smokeSeconds + 5);
    expect(sim.state.smoke).toHaveLength(0);
  });
});
