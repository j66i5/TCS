/** M9.3b: dismounted missile teams — set-up and packing, the range band, counted rounds, losing the missile, the
 *  danger zone behind, saves in flight, the fixture's beam-riding team, determinism of the bench scenario. */
import { describe, expect, it } from "vitest";
import {
  createSim, hashState, launcherOf, loadSim, runBattle, saveSim, step, submitOrder, teamRounds, TICK_HZ,
  type BattleInput, type EntityId, type Sim, type SimEvent,
} from "@tcs/sim";
import { getScenario, loadData } from "../src/scenarios";
import { teamSetup, teamTrial } from "../src/labs/missile-team";

const data = loadData();
const fixtures = loadData(true);

function holdAll(sim: Sim): void {
  for (const [uid, u] of sim.state.unit.entries()) if (u.parent === null) submitOrder(sim, { tick: sim.state.tick, issuer: u.side, target: uid, kind: "rules", fire: "hold" });
  step(sim);
}
function run(sim: Sim, seconds: number): SimEvent[] {
  const out: SimEvent[] = [];
  for (let k = 0; k < seconds * TICK_HZ; k++) out.push(...step(sim));
  return out;
}
const teamOf = (sim: Sim): EntityId => [...sim.state.unit.entries()].find(([, u]) => u.missileTeam !== undefined)![0];
const pumaOf = (sim: Sim): EntityId => [...sim.state.vehicle.entries()].find(([, v]) => v.side === "blue")![0];

/** A ready team (deployed and set up) and the Puma `rangeM` east of it. */
function readyTeam(rangeM: number, seed = 1, prep?: Parameters<typeof teamSetup>[3]): { sim: Sim; team: EntityId; puma: EntityId; input: BattleInput } {
  const { input } = teamSetup(data, rangeM, seed, prep);
  const sim = createSim(input);
  holdAll(sim);
  const team = teamOf(sim);
  submitOrder(sim, { tick: sim.state.tick, issuer: "red", target: team, kind: "deploy" });
  run(sim, 20);
  expect(sim.state.unit.req(team).missileTeam!.state).toBe("ready");
  return { sim, team, puma: pumaOf(sim), input };
}
function fireAt(sim: Sim, team: EntityId, puma: EntityId): void {
  const t = sim.state.transform.req(puma);
  submitOrder(sim, { tick: sim.state.tick, issuer: "red", target: team, kind: "fire", x: t.x, y: t.y, contact: puma, nature: "at" });
}

describe("missile teams (M9.3b)", () => {
  it("sets up on a deploy order in its set-up time, longer with fewer men (3 / 2 / 1); a move packs it", () => {
    const secs = [3, 2, 1].map((crew) => teamTrial(data, 1000, 1, { crew: crew as 1 | 2 | 3 }).setupS);
    // Set-up 15 s with the full crew of 3, x crew / men at the post (the state is looked at every half second).
    for (const [i, want] of [[0, 15], [1, 22.5], [2, 45]] as const) { expect(secs[i]!).toBeGreaterThanOrEqual(want); expect(secs[i]!).toBeLessThan(want + 1); }
    const { sim, team } = readyTeam(1000);
    submitOrder(sim, { tick: sim.state.tick, issuer: "red", target: team, kind: "move", waypoints: [{ x: 200, y: 500, mode: "walk" }] });
    const ev = run(sim, 3);
    expect(ev.some((e) => e.kind === "missileTeam.packed" && e.unit === team)).toBe(true);
    expect(sim.state.unit.req(team).missileTeam!.state).toBe("packed");
  });

  it("fires once on order: one round leaves the team's loads; the missile strikes a halted Puma at 1500 m", () => {
    const { sim, team, puma } = readyTeam(1500, 2);
    const l = launcherOf(sim.ctx, sim.state, team)!;
    const before = teamRounds(sim.state, team, l.def.round);
    fireAt(sim, team, puma);
    const ev = run(sim, 15);
    const shots = ev.filter((e) => e.kind === "shot.fired" && e.vehicle === undefined && sim.ctx.catalog.ammo[e.ammo]?.guided !== undefined);
    expect(shots).toHaveLength(1);
    expect(teamRounds(sim.state, team, l.def.round)).toBe(before - 1);
    const end = ev.find((e): e is Extract<SimEvent, { kind: "missile.ended" }> => e.kind === "missile.ended");
    expect(end?.team).toBe(team);
    expect(end?.result).toBe("hit");
    expect(sim.state.unit.req(team).missileTeam!.shots).toBe(1);
  });

  it("refuses a target outside its range band (80 - 2000 m): no launch, no round used", () => {
    for (const r of [2150, 60]) {
      const { sim, team, puma } = readyTeam(r, 3);
      const l = launcherOf(sim.ctx, sim.state, team)!;
      const before = teamRounds(sim.state, team, l.def.round);
      fireAt(sim, team, puma);
      const ev = run(sim, 5);
      expect(ev.some((e) => e.kind === "radio" && e.key === "radio.missileTeamNoShot")).toBe(true);
      expect(ev.some((e) => e.kind === "shot.fired" && e.vehicle === undefined && sim.ctx.catalog.ammo[e.ammo]?.guided !== undefined)).toBe(false);
      expect(teamRounds(sim.state, team, l.def.round)).toBe(before);
    }
  });

  it("the gunner loses the missile when he is knocked down, when he leaves the post, or when the team packs; moves wait for the flight", () => {
    const cases: [string, (sim: Sim, team: EntityId, gunner: EntityId) => void][] = [
      ["missile.lost.gunner", (sim, _t, g) => { sim.state.soldier.req(g).stunnedUntilTick = sim.state.tick + 120; }],
      ["missile.lost.moved", (sim, _t, g) => { sim.state.transform.req(g).x += 2; }],
      ["missile.lost.moved", (sim, t) => { sim.state.unit.req(t).missileTeam!.state = "packed"; }],
    ];
    for (const [reason, upset] of cases) {
      const { sim, team, puma } = readyTeam(1800, 4);
      fireAt(sim, team, puma);
      let gunner = -1;
      for (let k = 0; k < 10 * TICK_HZ && gunner < 0; k++) { step(sim); const g = sim.state.unit.req(team).missileTeam!.guide; if (g && sim.state.tick - g.launchTick > 60) gunner = g.gunner; }
      expect(gunner).toBeGreaterThan(0);
      upset(sim, team, gunner);
      const ev = run(sim, 1);
      const end = ev.find((e): e is Extract<SimEvent, { kind: "missile.ended" }> => e.kind === "missile.ended");
      expect(end?.result).toBe("lost");
      expect(end?.reason).toBe(reason);
    }
    // A move ordered while the missile flies waits until its flight is over.
    const { sim, team, puma } = readyTeam(1800, 5);
    fireAt(sim, team, puma);
    for (let k = 0; k < 10 * TICK_HZ && !sim.state.unit.req(team).missileTeam!.guide; k++) step(sim);
    const g = sim.state.unit.req(team).missileTeam!.guide!;
    const x0 = sim.state.transform.req(g.gunner).x;
    submitOrder(sim, { tick: sim.state.tick, issuer: "red", target: team, kind: "move", waypoints: [{ x: 150, y: 600, mode: "run" }] });
    let endTick = -1;
    for (let k = 0; k < 15 * TICK_HZ && endTick < 0; k++) {
      for (const e of step(sim)) if (e.kind === "missile.ended") endTick = e.tick;
      if (endTick < 0) expect(Math.abs(sim.state.transform.req(g.gunner).x - x0)).toBeLessThan(1);
    }
    expect(endTick).toBeGreaterThan(0);
  });

  it("does not fire with a comrade in the danger zone behind the post", () => {
    const { input } = teamSetup(data, 1000, 6);
    // The team's other men 8 m behind the gunner (west of him; he faces east).
    const red = input.forces[1]!;
    const teamIds = new Set(red.units[red.units.length - 1]!.members.map((m) => m.personId));
    let k = 0;
    for (const p of red.placements) if (teamIds.has(p.personId) && !(p.x === 200 && p.y === 600)) { p.x = 192; p.y = 600 + (k++ === 0 ? 0 : 1); }
    const sim = createSim(input);
    holdAll(sim);
    const team = teamOf(sim);
    submitOrder(sim, { tick: sim.state.tick, issuer: "red", target: team, kind: "deploy" });
    run(sim, 20);
    fireAt(sim, team, pumaOf(sim));
    const ev = run(sim, 5);
    expect(ev.some((e) => e.kind === "shot.fired" && e.vehicle === undefined && sim.ctx.catalog.ammo[e.ammo]?.guided !== undefined)).toBe(false);
    expect(ev.some((e) => e.kind === "radio" && e.key === "radio.missileTeamNoShot")).toBe(true);
  });

  it("a team fires on its own at an enemy vehicle its men see (anti-tank rule), not under fire rule hold", () => {
    const { input } = teamSetup(data, 1200, 7);
    const sim = createSim(input);
    // Blue holds; red's platoon holds; the team keeps its own rules.
    for (const [uid, u] of sim.state.unit.entries()) if (u.parent === null && u.missileTeam === undefined) submitOrder(sim, { tick: 0, issuer: u.side, target: uid, kind: "rules", fire: "hold" });
    const ev = run(sim, 40);
    expect(ev.some((e) => e.kind === "missile.ended" && e.team !== undefined)).toBe(true);
    const sim2 = createSim(teamSetup(data, 1200, 7).input);
    holdAll(sim2);
    expect(run(sim2, 40).some((e) => e.kind === "shot.fired" && e.vehicle === undefined && sim2.ctx.catalog.ammo[e.ammo]?.guided !== undefined)).toBe(false);
  });

  it("a save made while the missile flies continues identically", () => {
    const { sim, team, puma, input } = readyTeam(1800, 8);
    fireAt(sim, team, puma);
    let saved: ReturnType<typeof saveSim> | null = null;
    const ends: string[] = [];
    for (let i = 0; i < 20 * TICK_HZ; i++) {
      for (const e of step(sim)) if (e.kind === "missile.ended") ends.push(`${e.tick}:${e.result}`);
      const g = sim.state.unit.req(team).missileTeam!.guide;
      if (saved === null && g && sim.state.tick - g.launchTick > 3 * TICK_HZ) saved = JSON.parse(JSON.stringify(saveSim(sim))) as ReturnType<typeof saveSim>;
    }
    expect(saved).not.toBeNull();
    expect(ends).toHaveLength(1);
    const copy = loadSim(input, saved!);
    const ends2: string[] = [];
    while (copy.state.tick < sim.state.tick) for (const e of step(copy)) if (e.kind === "missile.ended") ends2.push(`${e.tick}:${e.result}`);
    expect(ends2).toEqual(ends);
    expect(hashState(copy.state)).toBe(hashState(sim.state));
  });

  it("the fixture faction's tripod team (beam riding) fires from data alone (rule 8)", () => {
    const r = teamTrial(fixtures, 1200, 9, { faction: "xf" });
    expect(r.fired).toBe(true);
    expect(r.setupS).toBeGreaterThan(5);
  });

  it("bench-missile-team: two runs give the same hash; the teams fire", () => {
    const sc = getScenario("bench-missile-team");
    const go = () => { const input = sc.build(data, 1, 60); let fired = 0; const r = runBattle(input, { controllers: sc.controllers!(input), onEvents: (ev) => { for (const e of ev) if (e.kind === "shot.fired" && e.vehicle === undefined && input.catalog.ammo[e.ammo]?.guided) fired++; } }); return { h: r.finalStateHash, fired }; };
    const a = go(), b = go();
    expect(b.h).toBe(a.h);
    expect(a.fired).toBeGreaterThan(0);
  });
});
