/**
 * Automatic grenade launcher teams on foot (M7.6d): the crew-served life of an "agl" post (set up, pack), its own
 * fire at men in range (none beyond `engageRangeM`), every round out of a counted box (rule 9), save and load in the
 * middle of the set-up and of a burst, an ordered series, and the AI commander's post for it.
 */
import { describe, expect, it } from "vitest";
import { aglRoundsLeft, createSim, crewServedKind, deserializeState, hashState, serializeState, step, submitOrder, tallyExpenditure, type EntityId, type Expenditure, type Sim, type SimEvent } from "@tcs/sim";
import { aglSetup } from "../src/labs/agl";
import { getScenario, loadData } from "../src/scenarios";

const data = loadData();

function run(sim: Sim, ticks: number, on: (e: SimEvent) => void = () => undefined): void {
  for (let i = 0; i < ticks; i++) for (const e of step(sim)) on(e);
}
function team(sim: Sim): EntityId {
  return [...sim.state.unit.entries()].find(([, u]) => u.missileTeam?.kind === "agl")![0];
}
/** Everyone but the team holds fire; the team's targets stand. */
function holdOthers(sim: Sim, tid: EntityId): void {
  for (const [uid, u] of sim.state.unit.entries()) if (u.parent === null && uid !== tid) submitOrder(sim, { tick: sim.state.tick, issuer: u.side, target: uid, kind: "rules", fire: "hold" });
  step(sim);
}

describe("automatic grenade launcher teams (M7.6d)", () => {
  it("an AGS-30 team is an 'agl' crew-served team: sets up in its set-up time, packs on a move", () => {
    const sim = createSim(aglSetup(data, "ru", 800, 1));
    const tid = team(sim);
    expect(crewServedKind(sim.state, tid)).toBe("agl");
    holdOthers(sim, tid);
    const ev: SimEvent[] = [];
    submitOrder(sim, { tick: sim.state.tick, issuer: "red", target: tid, kind: "deploy" });
    run(sim, 60 * 50, (e) => ev.push(e));
    const set = ev.find((e) => e.kind === "missileTeam.setup")!, ready = ev.find((e) => e.kind === "missileTeam.ready")!;
    expect((ready.tick - set.tick) / 60).toBeCloseTo(40, 0);
    submitOrder(sim, { tick: sim.state.tick, issuer: "red", target: tid, kind: "move", waypoints: [{ x: 150, y: 650, mode: "walk" }] });
    run(sim, 60 * 3, (e) => ev.push(e));
    expect(ev.some((e) => e.kind === "missileTeam.packed")).toBe(true);
    expect(sim.state.unit.req(tid).missileTeam!.state).toBe("packed");
  });

  it("fires on its own at men in range; every round fired leaves the box (rule 9); counted as grenadeMg on foot", () => {
    const sim = createSim(aglSetup(data, "ru", 800, 2));
    const tid = team(sim);
    holdOthers(sim, tid);
    const before = aglRoundsLeft(sim.ctx, sim.state, tid);
    let shots = 0;
    const out: Expenditure = {};
    run(sim, 60 * 120, (e) => { if (e.kind === "shot.fired" && sim.ctx.catalog.weapons[e.weapon]?.type === "grenade-machine-gun") { shots++; expect(e.vehicle).toBeUndefined(); } tallyExpenditure(out, [e], sim.state, sim.ctx.catalog); });
    expect(shots).toBeGreaterThan(10);
    expect(before - aglRoundsLeft(sim.ctx, sim.state, tid)).toBe(shots);
    expect(out["red"]!.grenadeMg!["ru-vog30"]).toBe(shots);
    expect(out["red"]!.smallArms).toBe(0);
  });

  it("does not fire on its own beyond its engage range (1200 m)", () => {
    const sim = createSim(aglSetup(data, "ru", 1450, 3));
    const tid = team(sim);
    holdOthers(sim, tid);
    let shots = 0;
    run(sim, 60 * 90, (e) => { if (e.kind === "shot.fired" && e.shooter >= 0 && sim.ctx.catalog.weapons[e.weapon]?.type === "grenade-machine-gun") shots++; });
    expect(sim.state.unit.req(tid).missileTeam!.state).toBe("ready");
    expect(shots).toBe(0);
  });

  it("an ordered fire: a packed team sets up, then fires its series at the point", () => {
    const sim = createSim(aglSetup(data, "ru", 1450, 4));
    const tid = team(sim);
    holdOthers(sim, tid);
    submitOrder(sim, { tick: sim.state.tick, issuer: "red", target: tid, kind: "rules", fire: "hold" });
    submitOrder(sim, { tick: sim.state.tick, issuer: "red", target: tid, kind: "fire", x: 1000, y: 600 });
    let shots = 0;
    run(sim, 60 * 90, (e) => { if (e.kind === "shot.fired" && sim.ctx.catalog.weapons[e.weapon]?.type === "grenade-machine-gun") shots++; });
    const wd = sim.ctx.catalog.weapons["ru-ags30"]!;
    expect(shots).toBe(6 * wd.sustained!.burstRounds);
  });

  it("save and load in the middle of the set-up and in the middle of a burst: the same hash after", () => {
    for (const at of [60 * 20, -1]) {
      const a = createSim(aglSetup(data, "ru", 800, 5));
      const tid = team(a);
      holdOthers(a, tid);
      if (at > 0) run(a, at);
      else { let n = 0; while (!a.state.unit.req(tid).missileTeam!.burst?.index && n++ < 60 * 200) run(a, 1); expect(a.state.unit.req(tid).missileTeam!.burst).toBeDefined(); }
      const b = createSim(aglSetup(data, "ru", 800, 5));
      b.state = deserializeState(serializeState(a.state));
      expect(hashState(b.state)).toBe(hashState(a.state));
      run(a, 60 * 30); run(b, 60 * 30);
      expect(hashState(b.state)).toBe(hashState(a.state));
    }
  });

  it("the AI commander walks the assault group's AGS team to a post and leaves it there (moves, rules, fire at enemy men its side sees); it sets up and fires", () => {
    const sc = getScenario("assault-group");
    const input = sc.build(data, 1, 600);
    const sim = createSim(input);
    const ctls = sc.controllers!(input);
    const tid = team(sim);
    const orders: string[] = [];
    let ready = false, shots = 0;
    for (let i = 0; i < 60 * 600; i++) {
      for (const c of ctls) for (const o of c.think(sim.state, sim.state.tick)) { if (o.target === tid) orders.push(o.kind); submitOrder(sim, o); }
      for (const e of step(sim)) {
        if (e.kind === "missileTeam.ready" && e.unit === tid) ready = true;
        if (e.kind === "shot.fired" && sim.ctx.catalog.weapons[e.weapon]?.type === "grenade-machine-gun") shots++;
      }
    }
    expect(orders).toContain("move");
    expect(orders.every((k) => k === "move" || k === "rules" || k === "fire")).toBe(true);
    expect(ready).toBe(true);
    expect(shots).toBeGreaterThan(0);
  });
});
