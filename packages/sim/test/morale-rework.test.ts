/** Morale rework (2026-11-15): morale = resolve x (1 - shock) x (1 - strain); drivers, recovery, graded states, rally. */
import { describe, expect, it } from "vitest";
import {
  buildInitialState, createSim, hashState, loadSim, saveSim, secondsToTicks, soldierRecordFromState, step,
  type BattleInput, type Sim, type SimEvent, type Wound,
} from "../src/index";
import { moraleKicks, moraleOf, resolveOf } from "../src/systems/morale";
import { EventSink } from "../src/events";
import { refreshStatus } from "../src/systems/wounds";
import { armedInput, team } from "./helpers";

const blueUnit = (sim: Sim) => [...sim.state.unit.entries()].find(([, u]) => u.side === "blue")!;
function run(sim: Sim, seconds: number, each?: () => void): SimEvent[] {
  const out: SimEvent[] = [];
  for (let i = 0; i < secondsToTicks(seconds); i++) { each?.(); out.push(...step(sim)); }
  return out;
}
/** A squad of six (blue, x = 60, y 10..35) facing red 130 m away at x = 190. */
function squadInput(prep?: (i: BattleInput) => void): BattleInput {
  const input = armedInput();
  const a = team("a", 6);
  for (const m of a.members) m.weapon = "rifle";
  input.forces[0]!.units = [a];
  input.forces[0]!.placements = a.members.map((m, i) => ({ personId: m.personId, x: 60, y: 10 + i * 5, heading: 0 }));
  input.forces[1]!.placements = input.forces[1]!.placements.map((p) => ({ ...p, x: 190 }));
  prep?.(input);
  return input;
}
const M = (sim: Sim, id: number) => sim.state.soldier.req(id).mental;
const place = (sim: Sim, id: number, x: number, y: number) => { const t = sim.state.transform.req(id); t.x = x; t.y = y; };

describe("morale value (rework)", () => {
  it("is resolve x (1 - shock) x (1 - strain), below 1 for a fresh regular, and stays within 0..1 under any blows", () => {
    const sim = createSim(squadInput());
    run(sim, 1);
    const [, u] = blueUnit(sim);
    const id = u.members[1]!, s = sim.state.soldier.req(id);
    expect(s.mental.morale).toBeGreaterThan(0.8);
    expect(s.mental.morale).toBeLessThan(1); // regular resolve 0.93 (+/- his nerve)
    s.mental.stress = 0.4; s.mental.strain = 0.2;
    expect(moraleOf(sim.ctx, sim.state, id, s)).toBeCloseTo(resolveOf(sim.ctx, sim.state, id, s) * 0.6 * 0.8, 6);
    for (let k = 0; k < 30; k++) moraleKicks(sim.ctx, sim.state, [{ kind: "wound", tick: 0, soldier: id, woundId: k, zone: "torso", mechanism: "penetrating", severity: 0.5 } as unknown as SimEvent]);
    expect(s.mental.stress).toBeLessThanOrEqual(1);
    expect(s.mental.strain).toBeLessThanOrEqual(1);
    expect(moraleOf(sim.ctx, sim.state, id, s)).toBeGreaterThanOrEqual(0);
  });

  it("nerve comes from the named stream 'morale' and differs between men; it is the same for every side", () => {
    const sim = createSim(squadInput());
    const nerves = [...sim.state.soldier.entries()].map(([, s]) => s.mental.nerve);
    expect(new Set(nerves.map((n) => n.toFixed(4))).size).toBeGreaterThan(4);
    for (const n of nerves) { expect(n).toBeGreaterThanOrEqual(0); expect(n).toBeLessThanOrEqual(1); }
    expect(sim.state.rng.streams["morale"]).toBeDefined();
  });

  it("fatigue lowers his resolve", () => {
    const sim = createSim(squadInput());
    const id = blueUnit(sim)[1].members[2]!, s = sim.state.soldier.req(id);
    const fresh = resolveOf(sim.ctx, sim.state, id, s);
    s.physical.fatigue = 0.9;
    expect(resolveOf(sim.ctx, sim.state, id, s)).toBeLessThan(fresh - 0.1);
  });
});

describe("losses and wounds (rework)", () => {
  it("a comrade killed shakes the men near him more than those farther off (full to 10 m, none at 60 m); killed hits harder than incapacitated", () => {
    const blow = (status: "killed" | "incapacitated") => {
      const sim = createSim(squadInput());
      const m = blueUnit(sim)[1].members;
      place(sim, m[0]!, 50, 50); place(sim, m[1]!, 55, 50); place(sim, m[2]!, 85, 50); place(sim, m[3]!, 115, 50);
      sim.state.soldier.req(m[0]!).physiology.alive = false;
      moraleKicks(sim.ctx, sim.state, [{ kind: "casualty", tick: 0, soldier: m[0]!, status }]);
      return [M(sim, m[1]!).stress, M(sim, m[2]!).stress, M(sim, m[3]!).stress, M(sim, m[1]!).strain] as const;
    };
    const k = blow("killed"), i = blow("incapacitated");
    expect(k[0]).toBeGreaterThan(0.15);
    expect(k[1]).toBeGreaterThan(0.03);
    expect(k[1]).toBeLessThan(k[0] * 0.7);
    expect(k[2]).toBe(0);
    expect(k[3]).toBeGreaterThan(0); // strain reaches the whole squad
    expect(i[0]).toBeLessThan(k[0]);
  });

  it("his squad's losses set a strain floor that an hour of quiet does not lift", () => {
    const sim = createSim(squadInput());
    const [, u] = blueUnit(sim);
    u.morale.lost = 3; // of 6
    run(sim, 60);
    const id = u.members[1]!;
    expect(M(sim, id).strain).toBeGreaterThanOrEqual(0.6 * 0.5 - 1e-9);
    for (let k = 0; k < 6; k++) run(sim, 600);
    expect(M(sim, id).strain).toBeGreaterThanOrEqual(0.3 - 1e-9);
    expect(M(sim, id).morale).toBeLessThan(0.7);
  });

  it("an untreated wound keeps wearing at him; a treated one does not", () => {
    const wear = (treated: boolean) => {
      const sim = createSim(squadInput());
      const id = blueUnit(sim)[1].members[2]!, s = sim.state.soldier.req(id);
      const w: Wound = { id: 0, zone: "leg", mechanism: "bullet", severity: 0.1, bleedingLps: 0, treatments: treated ? ["bandage"] : [] } as unknown as Wound;
      s.wounds.push(w);
      run(sim, 60);
      return s.mental.stress;
    };
    expect(wear(false)).toBeGreaterThan(0.03);
    expect(wear(true)).toBeLessThan(0.01);
  });

  it("losing the leader shakes and strains his men, and his successor leads", () => {
    const sim = createSim(squadInput());
    run(sim, 1);
    const [uid, u] = blueUnit(sim);
    const lead = u.leader!, y = u.members[3]!;
    sim.state.soldier.req(lead).physiology.alive = false;
    const sink = new EventSink();
    refreshStatus(sim.ctx, sim.state, sink, lead);
    moraleKicks(sim.ctx, sim.state, sink.events);
    expect(sim.state.unit.req(uid).leader).not.toBe(lead);
    expect(M(sim, y).stress).toBeGreaterThan(0.15);
    expect(M(sim, y).strain).toBeGreaterThan(0.05);
    expect(M(sim, y).why[7]).toBeGreaterThan(0); // reason: leader lost
  });
});

describe("recovery (rework)", () => {
  const recovered = (sup: number, leaderAway = false) => {
    const sim = createSim(squadInput());
    const [, u] = blueUnit(sim);
    const id = u.members[2]!;
    if (leaderAway) place(sim, u.leader!, 150, 150);
    run(sim, 60, () => { const m = M(sim, id); if (sim.state.tick === 0) { m.stress = 0.5; } m.suppression = sup; });
    return M(sim, id).stress;
  };
  it("shock fades fast when quiet, slowly under light fire, not at all under heavier fire; faster with the leader near", () => {
    const quiet = recovered(0), light = recovered(0.2), heavy = recovered(0.5), alone = recovered(0, true);
    expect(quiet).toBeLessThan(0.3);
    expect(light).toBeGreaterThan(quiet);
    expect(heavy).toBeGreaterThanOrEqual(0.5);
    expect(alone).toBeGreaterThan(quiet);
  });
});

describe("graded states (rework)", () => {
  it("shaken below 0.60 and steady only again at 0.70: no flapping in between", () => {
    const sim = createSim(squadInput());
    const id = blueUnit(sim)[1].members[2]!, s = sim.state.soldier.req(id);
    const setMorale = (x: number) => { s.mental.stress = 1 - x / resolveOf(sim.ctx, sim.state, id, s); };
    // Hold the shock at a fixed value each tick (the step would otherwise let it recover).
    const hold = (x: number, sec: number) => run(sim, sec, () => setMorale(x));
    hold(0.55, 2); expect(s.mental.behaviour).toBe("shaken");
    hold(0.64, 2); expect(s.mental.behaviour).toBe("shaken");
    hold(0.58, 2); expect(s.mental.behaviour).toBe("shaken");
    hold(0.66, 2); expect(s.mental.behaviour).toBe("shaken");
    hold(0.75, 2); expect(s.mental.behaviour).toBe("steady");
    hold(0.64, 2); expect(s.mental.behaviour).toBe("steady");
  });

  it("suppression alone pins a steady man; panic is held at least 20 s once he is calmer", () => {
    const sim = createSim(squadInput());
    const id = blueUnit(sim)[1].members[2]!, s = sim.state.soldier.req(id);
    run(sim, 2, () => { s.mental.suppression = 0.7; });
    expect(s.mental.behaviour).toBe("pinned");
    run(sim, 10, () => { s.mental.suppression = 0; });
    s.mental.stress = 0.95;
    place(sim, blueUnit(sim)[1].leader!, 160, 150); // (no rally: that would end the hold)
    run(sim, 1);
    expect(s.mental.behaviour).toBe("panicked");
    s.mental.stress = 0;
    run(sim, 10);
    expect(s.mental.behaviour).toBe("panicked");
    run(sim, 15);
    expect(s.mental.behaviour).not.toBe("panicked");
  });

  it("a panicked man not under heavy fire runs back from the enemy he knows, on a way the pinning does not stop, then lies down", () => {
    const sim = createSim(squadInput());
    const id = blueUnit(sim)[1].members[2]!, s = sim.state.soldier.req(id);
    const red = [...sim.state.identity.entries()].find(([, i]) => i.side === "red")![0];
    s.contacts.push({ target: red, x: 190, y: 20, errM: 5, kind: "seen", tick: 0, reportedTick: 0 });
    const x0 = sim.state.transform.req(id).x;
    s.mental.stress = 0.95;
    run(sim, 1, () => { s.mental.stress = Math.max(s.mental.stress, 0.95); });
    expect(s.mental.behaviour).toBe("panicked");
    expect(s.mental.flee).not.toBeNull();
    expect(s.mental.flee!.x).toBeLessThan(x0); // away from the enemy at x = 190
    const wp = sim.state.mover.req(id).waypoints;
    expect(wp.length).toBeGreaterThan(0);
    expect(wp[wp.length - 1]!.bolt).toBe(true);
    run(sim, 8, () => { s.mental.stress = Math.max(s.mental.stress, 0.95); });
    expect(sim.state.transform.req(id).x).toBeLessThan(x0 - 5);
  });

  it("the leader rallies a panicked man near him: the action, the event, his shock eased", () => {
    const sim = createSim(squadInput());
    run(sim, 1);
    const [, u] = blueUnit(sim);
    const id = u.members[2]!, s = sim.state.soldier.req(id);
    s.mental.stress = 0.9;
    let rally: SimEvent | undefined, started = false;
    for (let k = 0; k < secondsToTicks(12) && !rally; k++) for (const e of step(sim)) {
      if (e.kind === "action.started" && e.action === "rally" && e.actor === u.leader) started = true;
      if (e.kind === "morale.rally" && e.soldier === id) rally = e;
    }
    expect(started).toBe(true);
    expect(rally).toBeDefined();
    expect(s.mental.stress).toBeLessThan(0.8);
  });

  it("a unit whose men panic breaks (not in its first two minutes under fire) and rallies shaken, not steady", () => {
    const sim = createSim(squadInput());
    run(sim, 2);
    const [uid, u] = blueUnit(sim);
    for (const m of u.members.slice(0, 4)) M(sim, m).stress = 1;
    run(sim, 2);
    expect(u.broken).toBe(false); // no contact yet: the guard holds
    u.morale.firstContact = -1e6;
    u.morale.lost = 2; // (a top unit breaks only after losses: topBreakLossShare)
    for (const m of u.members.slice(0, 4)) M(sim, m).stress = 1;
    const ev = run(sim, 2);
    expect(ev.some((e) => e.kind === "radio" && e.key === "radio.broken")).toBe(true);
    expect(sim.state.unit.req(uid).morale.state).toBe("broken");
    const later = run(sim, 120);
    expect(later.some((e) => e.kind === "behaviour.changed" && e.from === "routed" && e.to === "shaken")).toBe(true);
  });
});

describe("morale state is plain data (rework)", () => {
  it("save and load mid-panic with a running man and a rally gives the same hash and the same future", () => {
    const input = squadInput();
    const sim = createSim(input);
    run(sim, 2);
    const [, u] = blueUnit(sim);
    const red = [...sim.state.identity.entries()].find(([, i]) => i.side === "red")![0];
    for (const m of u.members.slice(1, 4)) { const s = sim.state.soldier.req(m); s.contacts.push({ target: red, x: 190, y: 20, errM: 5, kind: "seen", tick: sim.state.tick, reportedTick: 0 }); s.mental.stress = 0.95; }
    run(sim, 3);
    expect(u.members.some((m) => M(sim, m).flee !== null || M(sim, m).behaviour === "panicked")).toBe(true);
    const copy = loadSim({ ...input, orders: [] }, saveSim(sim));
    expect(hashState(copy.state)).toBe(hashState(sim.state));
    run(sim, 20); run(copy, 20);
    expect(hashState(copy.state)).toBe(hashState(sim.state));
  });

  it("the roster carries strain out and in (a missing value reads as 0)", () => {
    const sim = createSim(squadInput());
    const id = blueUnit(sim)[1].members[1]!;
    M(sim, id).strain = 0.25;
    const rec = soldierRecordFromState(sim.state, id);
    expect(rec.strain).toBeCloseTo(0.25, 6);
    const input = squadInput((i) => { i.forces[0]!.units[0]!.members[1]!.strain = 0.25; });
    const st = buildInitialState(input);
    const ids = [...st.soldier.entries()].filter(([i]) => st.identity.req(i).side === "blue").map(([i]) => i);
    expect(st.soldier.req(ids[1]!).mental.strain).toBeCloseTo(0.25, 6);
    expect(st.soldier.req(ids[2]!).mental.strain).toBe(0);
  });

  it("darkness makes men more susceptible only when the battle has a sky (goldens without one are unchanged)", () => {
    const blow = (sky: boolean) => {
      const sim = createSim(squadInput((i) => { if (sky) i.environment = { ...(i.environment ?? {}), timeOfDaySeconds: 0, sky: { moon: 0 } } as BattleInput["environment"]; }));
      const id = blueUnit(sim)[1].members[2]!;
      if (!sky) sim.state.environment.light = 0.05; // dark, but no sky: no effect
      moraleKicks(sim.ctx, sim.state, [{ kind: "wound", tick: 0, soldier: id, woundId: 0, zone: "legL", mechanism: "penetrating", severity: 0.1 } as unknown as SimEvent]);
      return M(sim, id).stress;
    };
    expect(blow(true)).toBeGreaterThan(blow(false));
  });
});
