/**
 * M11.9b the military police off the map (plan docs/plans/m11-mp-pow.md slice 54): the MP hulls parked and skipped from
 * tick 0 (created after every other entity), the run end to end (called when the point holds its first prisoner, the
 * guard taken over, officers first, places never exceeded, evacuated off the map, a second run for the rest), the
 * player's call and its refusals, a stranded hull, the roster round trip (`heldBy`, `powEvacuated`), the result
 * (`BattleResult.prisoners`, `SideResult` counts), the end settlement of a man never taken (plan Q7), a hit on the hull
 * with prisoners aboard, and save/load on the way, while loading and away.
 */
import { describe, expect, it } from "vitest";
import {
  createSim, hashState, isOffMap, isOffMapMan, loadSim, noteHit, prisonersAtEnd, runBattle, saveSim, settleBattle, soldierRecordFromState, step, submitOrder,
  EventSink, type EntityId, type SerializedState, type SimEvent, type Sim,
} from "@tcs/sim";
import { buildScenario, withoutMp } from "@tcs/scenario";
import { loadData } from "../src/scenarios";
import { prisonersBattle } from "../src/labs/prisoners";

const data = loadData();
const TPL: Record<string, string> = { de: "pzgren-zug", ru: "motor-rifle-platoon" };
type MpEv = Extract<SimEvent, { kind: "pow.mp" }>;
const of = <K extends SimEvent["kind"]>(ev: SimEvent[], k: K) => ev.filter((e): e is Extract<SimEvent, { kind: K }> => e.kind === k);

function battle(faction: "de" | "ru", seed = 1, walkers = 6) {
  const b = prisonersBattle(data, faction, TPL[faction]!, seed, { walkers, mp: true, limitS: 7200 });
  const sim = createSim(b.input);
  for (const [uid] of sim.state.unit.entries()) sim.state.unit.req(uid).fireRule = "hold";
  const [vid] = [...sim.state.vehicle.entries()].find(([, v]) => v.offMap?.kind === "mp")!;
  const events: SimEvent[] = [];
  const run = (s: Sim, seconds: number, until?: () => boolean) => {
    for (let t = 0; t < seconds * 60; t++) {
      const out = step(s);
      if (s === sim) events.push(...out);
      if (until && t % 60 === 0 && until()) return true;
    }
    return false;
  };
  /** The call comes on the map at once (the delay is the lab's to measure). */
  const hurry = () => { const o = sim.state.vehicle.req(vid).offMap!; if (o.phase === "called") o.enterTick = sim.state.tick + 1; };
  const phase = () => sim.state.vehicle.req(vid).offMap?.phase;
  return { ...b, sim, vid, events, run, hurry, phase };
}

describe("military police (M11.9b)", () => {
  it("each side's MP waits off the map from tick 0, created after every other entity, outside the side's strength", () => {
    const def = { kind: "platoon-attack" as const, seed: 3, mapKind: "farmland" as const, factions: ["de", "ru"] as [string, string], attacker: "blue" as const, timeLimitSeconds: 60 };
    const input = buildScenario(data, def);
    const sim = createSim(input);
    const mps = [...sim.state.vehicle.entries()].filter(([, v]) => v.offMap?.kind === "mp");
    expect(mps.map(([, v]) => v.side).sort()).toEqual(["blue", "red"]);
    let maxOther = -1;
    for (const [id] of sim.state.transform.entries()) {
      const mine = mps.some(([vid, v]) => vid === id || v.seats.includes(id) || sim.state.vehicle.req(vid).unit === id);
      if (!mine) maxOther = Math.max(maxOther, id);
    }
    for (const [vid, v] of mps) {
      expect(v.offMap).toEqual({ kind: "mp", phase: "ready" });
      expect(isOffMap(v)).toBe(true);
      expect(sim.state.unit.req(v.unit!).asset).toBe("mp");
      expect(vid).toBeGreaterThan(maxOther);
      for (const m of v.seats) if (m !== null) expect(isOffMapMan(sim.state, sim.state.soldier.get(m))).toBe(true);
    }
    // Without them every other entity keeps its id, and a battle without prisoners runs the same.
    const a = runBattle(buildScenario(data, def), { onEvents: () => undefined });
    const b = runBattle(withoutMp(buildScenario(data, def)));
    expect(a.sides.map((s) => s.soldiersStart)).toEqual(b.sides.map((s) => s.soldiersStart));
    expect(a.eventCounts).toEqual(b.eventCounts);
    for (const sd of a.sides) expect(sd.vehicles?.start ?? 0).toBe(b.sides.find((x) => x.side === sd.side)!.vehicles?.start ?? 0);
  });

  it("called when the point has its first prisoner taken (review fix: held there or on the way); takes over the guard, officers first, never over its places; off the map they are evacuated; a second run takes the rest", () => {
    const b = battle("de");
    const st = b.sim.state, v = st.vehicle.req(b.vid);
    const places = b.sim.ctx.catalog.vehicles[v.def]!.seats.filter((q) => q.station === "passenger").length;
    // (Review fix: called at the first prisoner taken; the hull is hurried on once a guard stands at the point.)
    expect(b.run(b.sim, 1200, () => [...st.soldier.values()].some((s) => s.guard?.phase === "guard"))).toBe(true);
    expect(b.phase()).toBe("called");
    const taken = [...st.soldier.values()].filter((s) => s.captive?.state === "captured" && s.captive.unit !== undefined && s.mount === undefined).length;
    expect(taken).toBeGreaterThan(0);
    let maxAboard = 0;
    const until = (ph: string) => () => { maxAboard = Math.max(maxAboard, v.seats.filter((m) => m !== null && st.soldier.get(m)?.captive?.vehicle !== undefined && st.soldier.get(m)?.captive?.evacTick === undefined).length); b.hurry(); return b.phase() === ph; };
    expect(b.run(b.sim, 3000, until("away"))).toBe(true);
    // A second run for the one left (6 walking prisoners, 5 places): ready again after backS, called again.
    expect((v.offMap!.backTick ?? 0) - (v.offMap!.leftTick ?? 0)).toBe(b.sim.ctx.catalog.prisoners!.mp!.backS * 60);
    v.offMap!.backTick = st.tick + 60;
    expect(b.run(b.sim, 30, () => b.phase() === "called")).toBe(true);
    expect(b.run(b.sim, 3000, until("away"))).toBe(true);
    const mp = of(b.events, "pow.mp").map((e: MpEv) => e.phase);
    expect(mp.slice(0, 6)).toEqual(["called", "entered", "arrived", "departed", "away", "ready"]);
    const arrived = of(b.events, "pow.mp").find((e) => e.phase === "arrived")!;
    // The squads' guards walk back at once.
    const rel = of(b.events, "pow.guard").filter((e) => e.phase === "released" && e.tick >= arrived.tick && e.tick <= arrived.tick + 60);
    expect(rel.length).toBeGreaterThan(0);
    expect(rel.every((e) => e.tick - arrived.tick <= 30 * 60)).toBe(true);
    const boarded = of(b.events, "pow.boarded");
    const firstRun = boarded.filter((e) => e.tick < of(b.events, "pow.mp").find((x) => x.phase === "departed")!.tick);
    expect(firstRun.length).toBe(places);
    expect(firstRun[0]!.group).toBe("officer");
    expect(firstRun[1]!.group).toBe("nco");
    expect(maxAboard).toBeLessThanOrEqual(places);
    const evac = new Set(of(b.events, "pow.evacuated").map((e) => e.soldier));
    expect(boarded.length).toBe(6);
    for (const e of boarded) { expect(evac.has(e.soldier)).toBe(true); expect(st.soldier.req(e.soldier).captive!.evacTick).toBeDefined(); expect(isOffMapMan(st, st.soldier.req(e.soldier))).toBe(true); }
    // The result: held by blue, taken away by its MP, documents from the officer's search.
    const res = prisonersAtEnd(b.sim.ctx, st, b.input);
    const mpOut = res.filter((p) => p.evacuated === "mp");
    expect(mpOut.length).toBe(6);
    expect(res.every((p) => p.holder === "blue" && p.side === "red")).toBe(true);
    expect(res.some((p) => p.group === "officer" && p.documents > 0)).toBe(true);
    // The roster: "captured", held by blue, evacuated at that tick; placed in a later battle he is a prisoner from tick 0.
    const pr = boarded[0]!.soldier;
    const rec = soldierRecordFromState(st, pr);
    expect(rec.status).toBe("captured");
    expect(rec.heldBy).toBe("blue");
    expect(rec.powEvacuated).toBe(st.soldier.req(pr).captive!.evacTick);
    const again = prisonersBattle(data, "de", TPL["de"]!, 1, { mp: true });
    const red = again.input.forces[1]!;
    red.units[0]!.members[0] = { ...rec, personId: red.units[0]!.members[0]!.personId };
    const s2 = createSim(again.input);
    const id2 = [...s2.state.identity.entries()].find(([, i]) => i.personId === red.units[0]!.members[0]!.personId)![0];
    expect(s2.state.soldier.req(id2).captive).toMatchObject({ state: "captured", by: "blue" });
  });

  it("the player's call and its refusals: no prisoners, already on its way, none left", () => {
    const b = battle("ru", 2);
    const st = b.sim.state;
    const top = [...st.unit.entries()].find(([, u]) => u.side === "blue" && u.parent === null && u.asset === undefined)![0];
    const radio = (from: number) => b.events.filter((e, i) => i >= from && e.kind === "radio" && e.key.startsWith("radio.mp")).map((e) => (e as Extract<SimEvent, { kind: "radio" }>).key);
    let n = b.events.length;
    submitOrder(b.sim, { tick: st.tick, issuer: "blue", target: top, kind: "callMp", player: true });
    b.run(b.sim, 3);
    expect(radio(n)).toContain("radio.mpNoPrisoners");
    expect(b.run(b.sim, 1200, () => b.phase() === "called")).toBe(true);
    n = b.events.length;
    submitOrder(b.sim, { tick: st.tick, issuer: "blue", target: top, kind: "callMp", player: true });
    b.run(b.sim, 3);
    expect(radio(n)).toContain("radio.mpComing");
    b.run(b.sim, 3000, () => { b.hurry(); return b.phase() === "away"; });
    // Away (ready again only after backS), and prisoners still to come: none left.
    const pid = [...st.rear.entries()].find(([, p]) => p.kind === "prisoners")![0];
    const extra = [...st.soldier.entries()].find(([, s]) => s.captive?.evacTick !== undefined)![0];
    const s = st.soldier.req(extra);
    // (One of the evacuated is put back at the point for the test: someone to take.)
    if (s.mount) delete s.mount;
    delete s.captive!.evacTick; delete s.captive!.vehicle; s.captive!.point = pid;
    const p = st.rear.req(pid), t = st.transform.req(extra); t.x = p.x; t.y = p.y; t.z = 0;
    n = b.events.length;
    submitOrder(b.sim, { tick: st.tick, issuer: "blue", target: top, kind: "callMp", player: true });
    b.run(b.sim, 3);
    expect(radio(n)).toContain("radio.mpNone");
  });

  it("a stranded hull is an ordinary hull: its prisoners get out and wait at the point again", () => {
    const b = battle("de", 3);
    const st = b.sim.state, v = st.vehicle.req(b.vid);
    b.run(b.sim, 1200, () => b.phase() === "called");
    expect(b.run(b.sim, 2400, () => { b.hurry(); return b.phase() === "loading" && of(b.events, "pow.boarded").length >= 2; })).toBe(true);
    const aboard = v.seats.filter((m): m is EntityId => m !== null && st.soldier.get(m)?.captive?.vehicle !== undefined);
    expect(aboard.length).toBeGreaterThanOrEqual(2);
    v.status = "immobilised";
    b.run(b.sim, 2);
    expect(b.phase()).toBe("lost");
    expect(isOffMap(v)).toBe(false);
    for (const m of aboard) { const s = st.soldier.req(m); expect(s.mount).toBeUndefined(); expect(s.captive!.vehicle).toBeUndefined(); expect(s.captive!.point).toBeDefined(); }
    // The squad guards them again.
    b.run(b.sim, 120);
    expect([...st.soldier.values()].some((s) => s.guard?.phase === "guard" || s.guard?.phase === "escort" || s.guard?.phase === "search")).toBe(true);
  });

  it("a hit on the MP hull with prisoners aboard is a hit on protected persons; empty it is not", () => {
    const b = battle("de", 1);
    const st = b.sim.state, v = st.vehicle.req(b.vid);
    b.run(b.sim, 1200, () => b.phase() === "called");
    b.run(b.sim, 2400, () => { b.hurry(); return of(b.events, "pow.boarded").length >= 1; });
    const shooter = [...st.identity.entries()].find(([, i]) => i.side === "red")![0];
    const ev = new EventSink();
    noteHit(b.sim.ctx, st, ev, b.vid, shooter, false);
    expect(ev.events.some((e) => e.kind === "law.hit" && e.protection === "prisoner")).toBe(true);
    // (Empty: an ordinary military vehicle.)
    for (let k = 0; k < v.seats.length; k++) { const m = v.seats[k]; if (m !== null && m !== undefined && st.soldier.get(m)?.captive) v.seats[k] = null; }
    const ev2 = new EventSink();
    noteHit(b.sim.ctx, st, ev2, b.vid, shooter, false);
    expect(ev2.events.some((e) => e.kind === "law.hit")).toBe(false);
  });

  it("at the end a man who gave up but was never taken goes to the side holding the ground (plan Q7)", () => {
    const b = prisonersBattle(data, "de", TPL["de"]!, 1, { mp: true });
    const sim = createSim(b.input);
    const st = sim.state;
    const red = [...st.identity.entries()].filter(([, i]) => i.side === "red").map(([id]) => id);
    // One stays next to blue's squad (blue holds the ground), one is far away near nobody but red's own.
    const near = red[0]!, far = red[1]!;
    const tf = st.transform.req(far); tf.x = 1900; tf.y = 300;
    const other = red[2]!; st.soldier.req(other).captive = null; const to = st.transform.req(other); to.x = 1905; to.y = 300;
    const ev = new EventSink();
    settleBattle(sim.ctx, st, ev);
    expect(st.soldier.req(near).captive).toMatchObject({ state: "captured", by: "blue" });
    expect(st.soldier.req(far).captive).toBeNull();
    expect(ev.events.filter((e) => e.kind === "pow.settled").map((e) => (e as Extract<SimEvent, { kind: "pow.settled" }>).outcome)).toContain("returned");
    expect(soldierRecordFromState(st, near).heldBy).toBe("blue");
    expect(prisonersAtEnd(sim.ctx, st, b.input).some((p) => p.evacuated === "held" && p.holder === "blue")).toBe(true);
  });

  it("save/load on the way, while loading and away: the run goes on the same", () => {
    for (const ph of ["inbound", "loading", "away"] as const) {
      const b = battle("de", 2);
      b.run(b.sim, 1200, () => b.phase() === "called");
      expect(b.run(b.sim, 3000, () => { b.hurry(); return b.phase() === ph && (ph !== "loading" || of(b.events, "pow.boarded").length >= 1); })).toBe(true);
      b.run(b.sim, 2);
      const saved = JSON.parse(JSON.stringify(saveSim(b.sim))) as SerializedState;
      const again = loadSim(b.input, saved);
      for (let t = 0; t < 120 * 60; t++) { step(b.sim); step(again); }
      expect(hashState(again.state)).toBe(hashState(b.sim.state));
    }
  });
});
