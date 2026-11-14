/**
 * Covering fire (overnight pick "covering-fire", 2026-11-14): ordered and drill fire may go into the cover just short
 * of the point, at the sustained rate; covering men take an enemy they can fire at; runners wait for covering fire
 * and keep out of its lines.
 */
import { describe, expect, it } from "vitest";
import { createSim, hashState, lineOfFireTo, loadSim, saveSim, secondsToTicks, step, submitOrder, type BattleInput, type Sim, type SimEvent } from "../src/index";
import { armedInput } from "./helpers";

const unitOf = (sim: Sim, side: string) => [...sim.state.unit.entries()].find(([, u]) => u.side === side)!;
function run(sim: Sim, seconds: number, each?: (ev: SimEvent[]) => void): SimEvent[] {
  const out: SimEvent[] = [];
  for (let i = 0; i < secondsToTicks(seconds); i++) { const ev = step(sim); each?.(ev); out.push(...ev); }
  return out;
}
/** A hedge-like wall across the line of fire, `shortM` before x = 150 (2 m high: nobody fires over it). */
function walled(shortM: number): BattleInput {
  const input = armedInput();
  input.map.obstacles.push({ id: 1, kind: "wall", points: [150 - shortM, 0, 150 - shortM, 40], heightM: 2, thicknessM: 0.25, material: "brick" });
  return input;
}

describe("covering fire (overnight pick covering-fire)", () => {
  it("a line blocked only near the point counts for covering fire, a wall in the middle or before his face does not", () => {
    const sim = createSim(walled(10));
    const [, blue] = unitOf(sim, "blue");
    const m = blue.members[0]!, short = sim.ctx.catalog.behaviour.drills.suppressShortM;
    expect(lineOfFireTo(sim.ctx, sim.state, m, 150, 15, 0.9, "standing", short)).toBe(1);
    expect(lineOfFireTo(sim.ctx, sim.state, m, 150, 15, 0.9, "standing", 0)).toBe(0);
    const far = createSim(walled(40));
    expect(lineOfFireTo(far.ctx, far.state, m, 150, 15, 0.9, "standing", short)).toBe(0);
    // (A target close by, behind a wall at his own feet: not "near the point" however short the range.)
    const near = createSim(walled(139));
    expect(lineOfFireTo(near.ctx, near.state, m, 20, 15, 0.9, "standing", short)).toBe(0);
  });

  it("ordered fire goes into the cover just short of the point at the sustained rate; fire he opened himself does not", () => {
    const sim = createSim(walled(10));
    const [uid, blue] = unitOf(sim, "blue");
    submitOrder(sim, { tick: 0, issuer: "blue", target: uid, kind: "fire", x: 150, y: 15 });
    const ev = run(sim, 30);
    const shots = ev.filter((e) => e.kind === "shot.fired" && blue.members.includes(e.shooter));
    expect(shots.length).toBeGreaterThan(3);
    // Not faster than one round each drills.suppressIntervalS (+-15 %), after the first.
    const iv = sim.ctx.catalog.behaviour.drills.suppressIntervalS;
    expect(shots.length).toBeLessThanOrEqual(blue.members.length * (Math.floor(29 / (iv * 0.85)) + 1));
    expect(ev.some((e) => e.kind === "impact" && e.x > 135 && e.x < 145)).toBe(true);
    for (const m of blue.members) expect(sim.state.fire.get(m)?.intoCover).toBe(true);

    // The same point fired at on his own (no order, no drill): he holds his fire.
    const own = createSim(walled(10));
    const [oid, ob] = unitOf(own, "blue");
    submitOrder(own, { tick: 0, issuer: "blue", target: oid, kind: "fire", x: 150, y: 15 });
    run(own, 2);
    for (const m of ob.members) { const f = own.state.fire.get(m); if (f) { delete f.suppress; f.self = true; f.lineCheckTick = -1e6; } }
    const ev2 = run(own, 10);
    expect(ev2.filter((e) => e.kind === "shot.fired" && e.tick > secondsToTicks(4)).length).toBe(0);
  });

  it("the runners of a bound wait for covering fire, at most drills.coverWaitS", () => {
    const input = armedInput(1, 900);
    input.rules.physiologyModel = "simple";
    // Nobody to fire at (the enemy far off): the covering men have only the objective, out of their reach.
    input.forces[1]!.placements = input.forces[1]!.placements.map((p) => ({ ...p, x: 195, y: 195 }));
    input.map.obstacles.push({ id: 1, kind: "wall", points: [12, 0, 12, 40], heightM: 2.5, thicknessM: 0.25, material: "brick" });
    const sim = createSim(input);
    const [bid] = unitOf(sim, "blue");
    submitOrder(sim, { tick: 0, issuer: "blue", target: bid, kind: "assault", x: 100, y: 15 });
    for (let k = 0; k < secondsToTicks(5) && (sim.state.unit.req(bid).drill?.phaseTick ?? -1) < 0; k++) step(sim);
    const d = sim.state.unit.req(bid).drill!;
    expect(d.waitFire).toBe(true);
    // (Review fixes: a save while the drill waits for fire comes back the same, and goes on the same.)
    const copy = loadSim(input, JSON.parse(JSON.stringify(saveSim(sim))));
    expect(hashState(copy.state)).toBe(hashState(sim.state));
    const runners = d.groups[d.mover]!;
    const t0 = sim.state.tick, wait = secondsToTicks(sim.ctx.catalog.behaviour.drills.coverWaitS);
    let went = -1;
    for (let k = 0; k < wait + secondsToTicks(2) && went < 0; k++) { step(sim); if (runners.some((m) => (sim.state.mover.get(m)?.waypoints.length ?? 0) > 0)) went = sim.state.tick - t0; }
    expect(went).toBeGreaterThanOrEqual(wait - secondsToTicks(1));
    expect(sim.state.unit.req(bid).drill!.waitFire).toBeUndefined();
    while (copy.state.tick < sim.state.tick) step(copy);
    expect(hashState(copy.state)).toBe(hashState(sim.state));
  });

  /** Bounds (up to `bounds`) of an assault with the enemy in sight; how many runners' bound ends lie in a covering man's cone. */
  function lanes(laneShiftMaxM: number, bounds: number): { checked: number; inCone: number; firedFirst: number } {
    const input = armedInput(1, 900);
    input.rules.physiologyModel = "simple";
    input.forces[1]!.placements = input.forces[1]!.placements.map((p) => ({ ...p, x: 120 }));
    // (Close together: the runners start beside the covering man, in his line.)
    input.forces[0]!.placements = input.forces[0]!.placements.map((p, i) => ({ ...p, y: 13.5 + i * 1.5 }));
    const bh = input.catalog.behaviour;
    input.catalog = { ...input.catalog, behaviour: { ...bh, drills: { ...bh.drills, laneShiftMaxM } } };
    const sim = createSim(input);
    const [bid] = unitOf(sim, "blue");
    run(sim, 8); // they see each other
    submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: bid, kind: "assault", x: 100, y: 15 });
    let checked = 0, inCone = 0, firedFirst = 0, lastPhase = -1, copy: Sim | null = null;
    const sinCone = Math.sin((sim.ctx.catalog.shooting.fire.safetyConeDeg * Math.PI) / 180);
    for (let k = 0; k < secondsToTicks(120) && checked < bounds; k++) {
      step(sim);
      const d = sim.state.unit.req(bid).drill;
      if (!d || d.phaseTick < 0 || d.waitFire === true || d.final || d.phaseTick === lastPhase) continue;
      const runners = d.groups[d.mover]!.filter((m) => (sim.state.mover.get(m)?.waypoints.length ?? 0) > 0);
      if (runners.length === 0) continue;
      lastPhase = d.phaseTick;
      checked++;
      // (Review fixes: saved in the middle of a bound, with the covering men's fire tasks set, it goes on the same.)
      if (copy === null && laneShiftMaxM > 0) {
        expect(d.groups.flat().some((m) => sim.state.fire.get(m)?.suppress !== undefined)).toBe(true);
        copy = loadSim(input, JSON.parse(JSON.stringify(saveSim(sim))));
      }
      // They went after a covering man had fired.
      const cover = d.groups.filter((_, i) => i !== d.mover).flat();
      if (cover.some((m) => sim.state.tick - sim.state.weapon.req(m).lastShotTick <= secondsToTicks(sim.ctx.catalog.behaviour.drills.coverFiredS + 1))) firedFirst++;
      // Where each runner lies down at the end of his bound: inside a covering man's safety cone?
      for (const r of runners) {
        const w = sim.state.mover.req(r).waypoints, end = w[w.length - 1]!;
        for (const c of cover) {
          const f = sim.state.fire.get(c), t = sim.state.transform.req(c);
          if (!f) continue;
          const L = Math.hypot(f.x - t.x, f.y - t.y), ux = (f.x - t.x) / L, uy = (f.y - t.y) / L;
          const along = (end.x - t.x) * ux + (end.y - t.y) * uy, across = Math.abs(-(end.x - t.x) * uy + (end.y - t.y) * ux);
          if (along > 0 && along < L && across < 0.7 + along * sinCone) inCone++;
        }
      }
    }
    if (copy !== null) { while (copy.state.tick < sim.state.tick) step(copy); expect(hashState(copy.state)).toBe(hashState(sim.state)); }
    return { checked, inCone, firedFirst };
  }

  it("with the enemy in sight, the runners go once their covering men have fired, and lie down out of their lines", () => {
    const on = lanes(10, 3);
    expect(on.checked).toBe(3);
    expect(on.firedFirst).toBe(3);
    expect(on.inCone).toBe(0);
    // (Without the lanes the same bounds end in the covering men's lines: the test sees what it checks.)
    expect(lanes(0, 3).inCone).toBeGreaterThan(0);
  });
});
