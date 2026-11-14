/** Overnight pick 2026-11-14 "movement-under-fire": only the squad fired on goes to ground; nobody walks on into fire. */
import { describe, expect, it } from "vitest";
import { createSim, hashState, loadSim, saveSim, secondsToTicks, step, submitOrder, type BattleInput, type EntityId, type Sim, type SimEvent } from "../src/index";
import { rec, testInput } from "./helpers";

/** A blue platoon (one HQ man) of two squads of three, the second `apartM` east of the first; red far away. */
function platoon(apartM: number): BattleInput {
  const input = testInput(1, 300);
  const sq = (key: string) => ({ key, callsign: key, echelon: "team", leaderIndex: 0, members: [rec(`${key}.0`), rec(`${key}.1`), rec(`${key}.2`)], subunits: [] });
  const p = { key: "p", callsign: "P", echelon: "team", leaderIndex: 0, members: [rec("p.0")], subunits: [sq("s1"), sq("s2")] };
  input.forces[0]!.units = [p];
  input.forces[0]!.placements = [
    { personId: "p.0", x: 10, y: 5, heading: 0 },
    ...[0, 1, 2].map((i) => ({ personId: `s1.${i}`, x: 10 + i * 4, y: 10, heading: 0 })),
    ...[0, 1, 2].map((i) => ({ personId: `s2.${i}`, x: 10 + apartM + i * 4, y: 10, heading: 0 })),
  ];
  input.forces[1]!.placements = input.forces[1]!.placements.map((pl) => ({ ...pl, x: 190, y: 190 }));
  return input;
}
const unitBy = (sim: Sim, callsign: string): EntityId => [...sim.state.unit.entries()].find(([, u]) => u.callsign === callsign)![0];
const menOf = (sim: Sim, uid: EntityId) => sim.state.unit.req(uid).members;
function run(sim: Sim, seconds: number, each?: () => void): SimEvent[] {
  const out: SimEvent[] = [];
  for (let i = 0; i < secondsToTicks(seconds); i++) { each?.(); out.push(...step(sim)); }
  return out;
}
const reacted = (ev: SimEvent[], callsign: string) => ev.some((e) => e.kind === "radio" && e.key === "radio.contactReact" && e.params.callsign === callsign);
function moveBoth(sim: Sim, s1: EntityId, s2: EntityId): void {
  submitOrder(sim, { tick: 0, issuer: "blue", target: s1, kind: "move", waypoints: [{ x: 14, y: 180, mode: "walk" }] });
  submitOrder(sim, { tick: 0, issuer: "blue", target: s2, kind: "move", waypoints: [{ x: sim.state.transform.req(menOf(sim, s2)[0]!).x + 4, y: 180, mode: "walk" }] });
  run(sim, 4);
}

describe("movement under fire (overnight pick 2026-11-14)", () => {
  it("only the squad fired on goes to ground; a squad 100 m away walks on", () => {
    const sim = createSim(platoon(100));
    const s1 = unitBy(sim, "s1"), s2 = unitBy(sim, "s2");
    moveBoth(sim, s1, s2);
    const man = menOf(sim, s1)[1]!;
    const ev = run(sim, 2, () => { sim.state.soldier.req(man).mental.suppression = 0.2; });
    expect(reacted(ev, "s1")).toBe(true);
    expect(sim.state.unit.req(s1).moving).toBe(false);
    expect(reacted(ev, "s2")).toBe(false);
    expect(sim.state.unit.req(s2).moving).toBe(true);
    // The platoon still knows it is under fire (the return-fire rule reads the top unit).
    const top = sim.state.unit.req(sim.state.unit.req(s1).parent!);
    expect(sim.state.tick - top.underFireTick).toBeLessThan(secondsToTicks(1));
  });

  it("a squad within reactNeighbourM of the squad fired on goes down with it", () => {
    const sim = createSim(platoon(20));
    const s1 = unitBy(sim, "s1"), s2 = unitBy(sim, "s2");
    moveBoth(sim, s1, s2);
    const man = menOf(sim, s1)[1]!;
    const ev = run(sim, 2, () => { sim.state.soldier.req(man).mental.suppression = 0.2; });
    expect(reacted(ev, "s1")).toBe(true);
    expect(reacted(ev, "s2")).toBe(true);
    expect(sim.state.unit.req(s2).moving).toBe(false);
  });

  it("a move of the whole platoon still halts it all when any of its men is fired on", () => {
    const sim = createSim(platoon(100));
    const p = unitBy(sim, "P"), s2 = unitBy(sim, "s2");
    submitOrder(sim, { tick: 0, issuer: "blue", target: p, kind: "move", waypoints: [{ x: 60, y: 180, mode: "walk" }] });
    run(sim, 4);
    const man = menOf(sim, s2)[1]!;
    const ev = run(sim, 2, () => { sim.state.soldier.req(man).mental.suppression = 0.2; });
    expect(reacted(ev, "P")).toBe(true);
    for (const m of [...menOf(sim, p), ...menOf(sim, unitBy(sim, "s1")), ...menOf(sim, s2)]) expect(sim.state.mover.req(m).waypoints.length).toBe(0);
  });

  it("a man on a walk leg runs while under fire, walks again after a quiet spell, and the override goes with his way", () => {
    const input = platoon(100), sim = createSim(input);
    const s1 = unitBy(sim, "s1"), s2 = unitBy(sim, "s2");
    submitOrder(sim, { tick: 0, issuer: "blue", target: s1, kind: "rules", onContact: "push" });
    moveBoth(sim, s1, s2);
    const man = menOf(sim, s1)[1]!, other = menOf(sim, s1)[2]!, far = menOf(sim, s2)[1]!;
    expect(sim.state.mover.req(man).mode).toBe("walk");
    run(sim, 3, () => { sim.state.soldier.req(man).mental.suppression = 0.2; });
    // He runs; his comrade, not under fire himself, walks on (hurryFiredOnSeconds 0), as does the other squad.
    expect(sim.state.mover.req(man).mode).toBe("run");
    expect(sim.state.mover.req(other).mode).toBe("walk");
    expect(sim.state.mover.req(far).mode).toBe("walk");
    expect(sim.state.unit.req(s1).moving).toBe(true); // ("push": no halt)
    // A save in the middle of it comes back the same.
    const copy = loadSim(input, saveSim(sim));
    expect(hashState(copy.state)).toBe(hashState(sim.state));
    // Once the fire stops and his suppression has faded, he walks again after a quiet spell.
    let quietFrom = -1;
    run(sim, 30, () => { if (quietFrom < 0 && sim.state.soldier.req(man).mental.suppression < 0.1) quietFrom = sim.state.tick; });
    expect(quietFrom).toBeGreaterThan(0);
    expect(sim.state.mover.req(man).mode).toBe("walk");
    run(sim, 120);
    expect(sim.state.mover.req(man).waypoints.length).toBe(0);
    expect(sim.state.mover.req(man).hurryUntilTick).toBeUndefined();
  });

  it("with hurryFiredOnSeconds set, his whole squad runs when one of them is fired on", () => {
    const input = platoon(100);
    const b = input.catalog.behaviour;
    input.catalog = { ...input.catalog, behaviour: { ...b, soldier: { ...b.soldier, hurryFiredOnSeconds: 3 } } };
    const sim = createSim(input);
    const s1 = unitBy(sim, "s1"), s2 = unitBy(sim, "s2");
    submitOrder(sim, { tick: 0, issuer: "blue", target: s1, kind: "rules", onContact: "push" });
    moveBoth(sim, s1, s2);
    const man = menOf(sim, s1)[1]!, other = menOf(sim, s1)[2]!, far = menOf(sim, s2)[1]!;
    run(sim, 3, () => { sim.state.soldier.req(man).mental.suppression = 0.2; });
    expect(sim.state.mover.req(other).mode).toBe("run");
    expect(sim.state.mover.req(far).mode).toBe("walk");
  });
});
