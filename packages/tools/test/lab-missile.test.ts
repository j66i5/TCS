/**
 * The BMP-2's guided missile (owner 2026-11-13, "Yes, add the ATGM"): hits and gets through a Puma at range,
 * misses when the gunner loses sight (smoke), counted missiles and the reload, the crew's choice of the missile
 * over the cannon, a missile in flight surviving a save; and men aboard feeling only their own vehicle (owner
 * 2026-11-13, "Only own vehicle").
 */
import { describe, expect, it } from "vitest";
import { createSim, hashState, loadSim, saveSim, step, submitOrder, TICK_HZ, type Sim, type SimEvent } from "@tcs/sim";
import { EventSink } from "../../sim/src/events";
import { moraleSystem } from "../../sim/src/systems/morale";
import { missileSetup, missileTrial } from "../src/labs/missile";
import { getScenario, loadData } from "../src/scenarios";

const data = loadData();
function run(sim: Sim, seconds: number, on: (e: SimEvent) => void = () => undefined): void {
  for (let i = 0; i < seconds * TICK_HZ; i++) for (const e of step(sim)) on(e);
}
const count = (sim: Sim, holder: number, item: string) => sim.state.container.req(holder).stacks.filter((s) => s.type === item).reduce((n, s) => n + s.count, 0);

describe("guided missile (owner 2026-11-13)", () => {
  it("a BMP-2 hits a Puma head-on at 1000 m and side-on at 2000 m with its 9M113M, and gets through", () => {
    const a = missileTrial(data, 1000, "front", 2000);
    const b = missileTrial(data, 2000, "side", 2001);
    for (const r of [a, b]) { expect(r.fired).toBe(true); expect(r.hit).toBe(true); expect(r.penetrated).toBe(true); expect(r.lost).toBe(false); }
    expect(a.flightS).toBeGreaterThan(4);
    expect(a.flightS).toBeLessThan(7);
  });

  it("losing sight of the target makes it miss: the Puma's smoke screen at 3000 m", () => {
    const r = missileTrial(data, 3000, "front", 2000, true);
    expect(r.fired).toBe(true);
    expect(r.lost).toBe(true);
    expect(r.hit).toBe(false);
  });

  it("missiles are counted items: one on the launcher, three stowed; the next is put on from stowage, halted", () => {
    const { input, shooter, target } = missileSetup(data, 1000, "side", 3);
    const sim = createSim(input);
    const v = sim.state.vehicle.req(shooter);
    const launcher = () => v.stations[0]!.weapons[2]!.feeds[0]!.rounds;
    expect(launcher()).toBe(1);
    expect(count(sim, shooter, "ru-9m113m-round")).toBe(3);
    const t = sim.state.transform.req(target);
    submitOrder(sim, { tick: 0, issuer: "red", target: v.unit!, kind: "fire", x: t.x, y: t.y, contact: target, nature: "at" });
    let fired = 0, ended = 0, moved = 0;
    run(sim, 10, (e) => {
      if (e.kind === "shot.fired" && e.vehicle === shooter && e.ammo === "ru-9m113m") fired++;
      if (e.kind === "missile.ended") ended++;
    });
    expect(fired).toBe(1);
    expect(ended).toBe(1);
    expect(launcher()).toBe(0);
    expect(count(sim, shooter, "ru-9m113m-round")).toBe(3);
    // Reload: 40 s (weapon data), halted.
    run(sim, 42, (e) => { if (e.kind === "items.transferred" && e.from === shooter && e.item === "ru-9m113m-round") moved++; });
    expect(moved).toBe(1);
    expect(launcher()).toBe(1);
    expect(count(sim, shooter, "ru-9m113m-round")).toBe(2);
  });

  it("a crew on its own takes the missile at a Puma's front (the 30 mm cannot get through), the cannon at its side within 1000 m", () => {
    const choose = (aspect: "front" | "side") => {
      const { input, shooter } = missileSetup(data, 800, aspect, 11);
      const sim = createSim(input);
      for (const [uid, u] of sim.state.unit.entries()) if (u.parent === null) submitOrder(sim, { tick: 0, issuer: u.side, target: uid, kind: "rules", fire: u.side === "red" ? "free" : "hold" });
      let missile = 0, cannon = 0;
      run(sim, 40, (e) => { if (e.kind === "shot.fired" && e.vehicle === shooter) { if (e.ammo === "ru-9m113m") missile++; else if (e.weapon === "ru-2a42") cannon++; } });
      return { missile, cannon };
    };
    const front = choose("front"), side = choose("side");
    expect(front.missile).toBeGreaterThanOrEqual(1);
    expect(side.missile).toBe(0);
    expect(side.cannon).toBeGreaterThan(0);
  });

  it("a save made while the missile flies continues identically", () => {
    const { input, shooter, target } = missileSetup(data, 2000, "front", 5);
    const sim = createSim(input);
    const t = sim.state.transform.req(target);
    submitOrder(sim, { tick: 0, issuer: "red", target: sim.state.vehicle.req(shooter).unit!, kind: "fire", x: t.x, y: t.y, contact: target, nature: "at" });
    let saved: ReturnType<typeof saveSim> | null = null;
    const ends: string[] = [];
    for (let i = 0; i < 30 * TICK_HZ; i++) {
      for (const e of step(sim)) if (e.kind === "missile.ended") ends.push(`${e.tick}:${e.result}`);
      if (saved === null && sim.state.vehicle.req(shooter).stations[0]!.guide && sim.state.tick % 60 === 0 && sim.state.projectiles.count > 0) {
        const g = sim.state.vehicle.req(shooter).stations[0]!.guide!;
        if (sim.state.tick - g.launchTick > 3 * TICK_HZ) saved = JSON.parse(JSON.stringify(saveSim(sim))) as ReturnType<typeof saveSim>;
      }
    }
    expect(saved).not.toBeNull();
    expect(ends).toHaveLength(1);
    const copy = loadSim(input, saved!);
    const ends2: string[] = [];
    while (copy.state.tick < sim.state.tick) for (const e of step(copy)) if (e.kind === "missile.ended") ends2.push(`${e.tick}:${e.result}`);
    expect(ends2).toEqual(ends);
    expect(hashState(copy.state)).toBe(hashState(sim.state));
  });
});

describe("stress aboard (owner 2026-11-13: only own vehicle)", () => {
  it("men in a closed hull feel a comrade falling inside it and hits on it, not comrades falling outside or other hulls", () => {
    const sc = getScenario("platoon-ru-vehicles");
    const input = sc.build(data, 1, 60);
    const sim = createSim(input);
    const s = sim.state;
    // Two red carriers with men aboard.
    const hulls = [...s.vehicle.entries()].filter(([, v]) => v.side === "red" && v.seats.filter((o) => o !== null).length >= 4).slice(0, 2);
    expect(hulls.length).toBe(2);
    const aboard = (vid: number) => s.vehicle.req(vid).seats.filter((o): o is number => o !== null);
    const [a, b] = [hulls[0]![0], hulls[1]![0]];
    const stress = (id: number) => s.soldier.req(id).mental.stress;
    const before = new Map([...aboard(a), ...aboard(b)].map((id) => [id, stress(id)]));
    // A man of hull A falls: the others in A take stress, the men in B (20 m away) do not.
    const victim = aboard(a)[aboard(a).length - 1]!;
    moraleSystem(sim.ctx, s, new EventSink(), [{ kind: "casualty", tick: s.tick, soldier: victim, status: "killed" }]);
    for (const id of aboard(a)) if (id !== victim) expect(stress(id)).toBeGreaterThan(before.get(id)!);
    for (const id of aboard(b)) expect(stress(id)).toBe(before.get(id)!);
    // Hull B is penetrated: its men take stress.
    const mid = new Map(aboard(b).map((id) => [id, stress(id)]));
    moraleSystem(sim.ctx, s, new EventSink(), [{ kind: "vehicle.hit", tick: s.tick, vehicle: b, x: 0, y: 0, z: 0, face: "side", zone: "hull", result: "penetrated", ammo: "de-30x173-pmc287", owner: 0, rounds: 1, components: [] }]);
    for (const id of aboard(b)) expect(stress(id)).toBeGreaterThan(mid.get(id)!);
  });
});
