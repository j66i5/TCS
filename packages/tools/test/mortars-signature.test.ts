/** M8.3b: on-map mortars — the enemy hears and sees the tubes; a hit or suppressed crew fires slower or stops. */
import { describe, expect, it } from "vitest";
import { allMembers, buildForce, demoBattle } from "@tcs/scenario";
import { createSim, crewRate, isMortarUnit, step, submitOrder, tubeOf, type BattleInput, type EntityId, type Sim, type SimEvent } from "@tcs/sim";
import { loadData } from "../src/scenarios";

const data = loadData();

/** Blue's demo squad at x 300 on a flat 3200 x 400 m map; a red 2B14 section at x `mx`; red's squad near blue's. */
function battle(mx: number): BattleInput {
  const input = demoBattle(data, { seed: 6, factions: ["de", "ru"], mapWidthM: 3200, mapHeightM: 400, frontM: 600, timeLimitSeconds: 1200 });
  input.rules.support = [];
  const sec = buildForce(data, { faction: "ru", template: "minomyotny-vzvod-82", seed: 9, keyPrefix: "red-m", number: 1 });
  const f = input.forces.find((x) => x.side === "red")!;
  f.units.push(sec);
  allMembers(sec).forEach((m, i) => f.placements.push({ personId: m.personId, x: mx + (i % 4) * 3, y: 190 + Math.floor(i / 4) * 20, heading: Math.PI }));
  return input;
}
const top = (sim: Sim, side: string) => [...sim.state.unit.entries()].find(([id, u]) => u.side === side && u.parent === null && !isMortarUnit(sim.state, id))![0];
const teams = (sim: Sim) => [...sim.state.unit.entries()].filter(([, u]) => u.side === "red" && u.mortar !== undefined).map(([id]) => id);
function run(sim: Sim, seconds: number, each?: () => void): SimEvent[] {
  const out: SimEvent[] = [];
  for (let k = 0; k < seconds * 60; k++) { each?.(); out.push(...step(sim)); }
  return out;
}

describe("on-map mortars: signature (M8.3b)", () => {
  it("the enemy hears the tubes beyond rifle range (contacts): a heard contact near the tubes, called out", () => {
    // The tubes 2,600 m from blue: past the 1,500 m a rifle shot is heard, inside the 2B14's 3,000 m.
    const sim = createSim(battle(2900));
    for (const side of ["blue", "red"] as const) submitOrder(sim, { tick: 0, issuer: side, target: top(sim, side), kind: "rules", fire: "hold" });
    run(sim, 70);
    const tube = tubeOf(sim.ctx, sim.state, teams(sim)[0]!)!;
    submitOrder(sim, { tick: sim.state.tick, issuer: "red", target: top(sim, "red"), kind: "callFire", x: 1000, y: 200, ammo: "he", rounds: 4 });
    const ev = run(sim, 90);
    const shots = ev.filter((e): e is Extract<SimEvent, { kind: "shot.fired" }> => e.kind === "shot.fired" && e.indirect === true);
    expect(shots.length).toBeGreaterThan(0);
    expect(shots[0]!.loudM).toBe(tube.def.hearingRangeM);
    const heard: { x: number; y: number }[] = [];
    for (const [id, s] of sim.state.soldier.entries()) {
      if (sim.state.identity.get(id)?.side !== "blue") continue;
      for (const c of s.contacts) if (c.kind === "heard" && Math.abs(c.x - 2900) < 1500) heard.push(c);
    }
    expect(heard.length).toBeGreaterThan(0);
    // The direction is right (the guess is east of blue, near the tubes' line).
    for (const c of heard) { expect(c.x).toBeGreaterThan(1200); expect(Math.abs(c.y - 200)).toBeLessThan(600); }
    expect(ev.some((e) => e.kind === "radio" && e.side === "blue" && e.key === "radio.contactHeard")).toBe(true);
    // A mortar shot is no flat line of fire: nobody counts it as a round passing him.
    expect(ev.filter((e) => e.kind === "shot.fired" && e.indirect).every((e) => e.kind === "shot.fired" && e.dirX === 0 && e.dirY === 0)).toBe(true);
  });

  it("the gunner counts as firing just after a round (the flash): his weapon's last shot is the round's tick", () => {
    const sim = createSim(battle(2900));
    run(sim, 70);
    submitOrder(sim, { tick: sim.state.tick, issuer: "red", target: top(sim, "red"), kind: "callFire", x: 1000, y: 200, ammo: "he", rounds: 2 });
    const ev = run(sim, 60);
    const f = ev.find((e): e is Extract<SimEvent, { kind: "mortar.fired" }> => e.kind === "mortar.fired")!;
    expect(sim.state.weapon.get(f.gunner)!.lastShotTick).toBeGreaterThanOrEqual(f.tick);
  });
});

describe("on-map mortars: degradation (M8.3b)", () => {
  /** Seconds between one tube's rounds for effect (it fires 6 for effect alone: the other team is sent away). */
  const interval = (prep: (sim: Sim, team: EntityId) => void, each?: (sim: Sim, team: EntityId) => void) => {
    const sim = createSim(battle(2900));
    for (const side of ["blue", "red"] as const) submitOrder(sim, { tick: 0, issuer: side, target: top(sim, side), kind: "rules", fire: "hold" });
    const [t1, t2] = teams(sim);
    run(sim, 70);
    // Only the first tube takes the mission: the second packs up and walks off.
    submitOrder(sim, { tick: sim.state.tick, issuer: "red", target: t2!, kind: "move", waypoints: [{ x: 3100, y: 350, mode: "walk" }] });
    run(sim, 2);
    prep(sim, t1!);
    submitOrder(sim, { tick: sim.state.tick, issuer: "red", target: top(sim, "red"), kind: "callFire", x: 1000, y: 200, ammo: "he", rounds: 6 });
    const ev = run(sim, 160, each ? () => each(sim, t1!) : undefined);
    const fired = ev.filter((e): e is Extract<SimEvent, { kind: "mortar.fired" }> => e.kind === "mortar.fired" && e.unit === t1);
    const fs = sim.ctx.catalog.factions["ru"]!.fireSupport!;
    const effect = fired.slice(fs.rangingRounds);
    if (effect.length < 2) return { n: effect.length, s: Infinity, rate: crewRate(sim.ctx, sim.state, tubeOf(sim.ctx, sim.state, t1!)!) };
    return { n: effect.length, s: (effect.at(-1)!.tick - effect[0]!.tick) / 60 / (effect.length - 1), rate: crewRate(sim.ctx, sim.state, tubeOf(sim.ctx, sim.state, t1!)!) };
  };
  const kill = (sim: Sim, team: EntityId, n: number) => {
    const u = sim.state.unit.get(team)!;
    const tube = tubeOf(sim.ctx, sim.state, team)!;
    for (const m of u.members.filter((x) => x !== tube.carrier).slice(0, n)) { const s = sim.state.soldier.get(m)!; s.physiology.consciousness = 0; }
  };

  it("a full steady crew fires at its sustained rate; under suppression (pinned) the rate falls to about a third", () => {
    const calm = interval(() => {});
    const def = data.factions["ru"]!.items["ru-2b14-mortar"]!.mortar!;
    expect(calm.n).toBe(6);
    expect(calm.s).toBeGreaterThan(def.roundSeconds * 0.9);
    expect(calm.s).toBeLessThan(def.roundSeconds * 1.3);
    const pinned = interval(() => {}, (sim, team) => { for (const m of sim.state.unit.get(team)!.members) { const s = sim.state.soldier.get(m)!; s.mental.suppression = 1; s.mental.stress = 0; } });
    expect(pinned.n).toBeGreaterThan(1);
    expect(pinned.s).toBeGreaterThan(calm.s * 2);
  });

  it("a hit crew slows down (two of four men: half the rate) and stops below its minimum crew", () => {
    const calm = interval(() => {});
    const half = interval((sim, team) => kill(sim, team, 2));
    expect(half.rate).toBeCloseTo(0.5, 1);
    expect(half.s).toBeGreaterThan(calm.s * 1.7);
    const stopped = interval((sim, team) => kill(sim, team, 3));
    expect(stopped.rate).toBe(0);
    expect(stopped.n).toBe(0);
  });
});
