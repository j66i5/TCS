/** M6.6: surrender (owner decisions 2026-11-12) — who gives up, what it changes, who knows it, prisoners. */
import { describe, expect, it } from "vitest";
import {
  battleScore, createSim, hashState, isAble, canReport, loadSim, rosterStatus, runBattle, saveSim, secondsToTicks, sideKnowledge, step, submitOrder,
  surrender, surrenderSystem, type BattleInput, type Sim, type SimEvent,
} from "../src/index";
import { EventSink } from "../src/events";
import { refreshStatus } from "../src/systems/wounds";
import { soldierRecordFromState } from "../src/setup";
import { armedInput } from "./helpers";

const unitOf = (sim: Sim, side: string) => [...sim.state.unit.entries()].find(([, u]) => u.side === side)!;
function run(sim: Sim, seconds: number, each?: () => void): SimEvent[] {
  const out: SimEvent[] = [];
  for (let i = 0; i < secondsToTicks(seconds); i++) { each?.(); out.push(...step(sim)); }
  return out;
}
/** Blue at x = 10 (y 10, 15, 20, facing east); red at x = redX (y 10, 15, facing west). Both hold fire. */
function setup(redX = 50, prep?: (i: BattleInput) => void): BattleInput {
  const input = armedInput(1, 900);
  input.forces[1]!.placements = input.forces[1]!.placements.map((p) => ({ ...p, x: redX, heading: Math.PI }));
  prep?.(input);
  return input;
}
/** Wound a man so he cannot fight (abdomen 0.7, pain 0.7) — he can still walk. */
function downed(sim: Sim, id: number, legs = false): void {
  const s = sim.state.soldier.req(id);
  s.wounds.push({ id: s.nextWoundId++, zone: legs ? "legL" : "abdomen", mechanism: "bullet", severity: 0.7, bleedingLps: 0, compressible: true, airway: false, breathing: false, consciousness: false, tickInflicted: 0, treatments: [] });
  s.physiology.pain = 0.7;
  refreshStatus(sim.ctx, sim.state, new EventSink(), id);
}
/** Move a man (test set-up only). */
function place(sim: Sim, id: number, x: number, y: number): void { const t = sim.state.transform.req(id); t.x = x; t.y = y; }
const gaveUp = (ev: SimEvent[], id: number) => ev.find((e) => e.kind === "surrendered" && e.soldier === id);

describe("who gives up (M6.6)", () => {
  it("a wounded man who can no longer fight, with no fit comrade near, gives up to an enemy he has seen 40 m off; then he takes no orders, fires nothing and cannot report", () => {
    const sim = createSim(setup());
    const [bid, blue] = unitOf(sim, "blue");
    const [a, b, c] = blue.members as [number, number, number];
    place(sim, b, 10, 150); place(sim, c, 10, 180); // his comrades far off
    downed(sim, a);
    expect(sim.state.soldier.req(a).impair.canFight).toBe(false);
    expect(sim.state.soldier.req(a).impair.canWalk).toBe(true); // can still walk: he gives up all the same (owner)
    const ev = run(sim, 5);
    expect(gaveUp(ev, a)).toMatchObject({ reason: "wounded" });
    expect(ev.some((e) => e.kind === "behaviour.changed" && e.soldier === a && e.to === "surrendered")).toBe(true);
    const s = sim.state.soldier.req(a);
    expect(s.captive?.state).toBe("surrendered");
    expect(isAble(s)).toBe(false);
    expect(canReport(s)).toBe(false);
    expect(sim.state.fire.has(a)).toBe(false);
    const at = { ...sim.state.transform.req(a) };
    submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: bid, kind: "move", waypoints: [{ x: 10, y: 100, mode: "run" }] });
    run(sim, 10);
    expect(Math.hypot(sim.state.transform.req(a).x - at.x, sim.state.transform.req(a).y - at.y)).toBeLessThan(0.01);
  });

  it("he does not give up with a fit comrade within 30 m, nor with the nearest enemy 80 m away", () => {
    for (const [redX, alone] of [[50, false], [90, true]] as const) {
      const sim = createSim(setup(redX));
      const [, blue] = unitOf(sim, "blue");
      const [a, b, c] = blue.members as [number, number, number];
      if (alone) { place(sim, b, 10, 150); place(sim, c, 10, 180); }
      downed(sim, a);
      expect(gaveUp(run(sim, 10), a)).toBeUndefined();
    }
  });

  it("a comrade who is himself wounded out of the fight, or panicked, is no fit comrade", () => {
    const sim = createSim(setup());
    const [, blue] = unitOf(sim, "blue");
    const [a, b, c] = blue.members as [number, number, number];
    place(sim, c, 10, 180);
    downed(sim, b, true); // b can no longer walk
    downed(sim, a);
    const ev = run(sim, 5);
    expect(gaveUp(ev, a)).toBeDefined();
  });

  it("an enemy only heard does not count; the same enemy reported by a comrade does", () => {
    const sim = createSim(setup(45, (i) => { i.forces[1]!.placements = i.forces[1]!.placements.map((p) => ({ ...p, x: 190, y: 190 })); }));
    const [, blue] = unitOf(sim, "blue");
    const [a, b, c] = blue.members as [number, number, number];
    place(sim, b, 10, 150); place(sim, c, 10, 180);
    downed(sim, a);
    const red = unitOf(sim, "red")[1].members[0]!;
    place(sim, red, 40, 10); // 30 m away, but out of his sight cone? he faces east: he would see him — so set contacts directly
    const s = sim.state.soldier.req(a);
    const step0 = () => { const every = 60; while ((a + sim.state.tick) % every !== 0) step(sim); };
    // Heard only: no surrender.
    sim.state.transform.req(red).x = 190; // out of sight range of his eyes this tick
    step0();
    s.contacts = [{ target: red, x: 40, y: 10, errM: 10, kind: "heard", tick: sim.state.tick, reportedTick: -1e9 }];
    const ev1 = new EventSink();
    surrenderSystem(sim.ctx, sim.state, ev1);
    expect(gaveUp(ev1.events, a)).toBeUndefined();
    s.contacts = [{ target: red, x: 40, y: 10, errM: 5, kind: "reported", tick: sim.state.tick, reportedTick: -1e9 }];
    const ev2 = new EventSink();
    surrenderSystem(sim.ctx, sim.state, ev2);
    expect(gaveUp(ev2.events, a)).toMatchObject({ reason: "wounded" });
  });

  it("an unconscious man never gives up; a wounded man who cannot walk but can still fight does not either", () => {
    for (const kind of ["unconscious", "legsOnly"] as const) {
      const sim = createSim(setup());
      const [, blue] = unitOf(sim, "blue");
      const [a, b, c] = blue.members as [number, number, number];
      place(sim, b, 10, 150); place(sim, c, 10, 180);
      const s = sim.state.soldier.req(a);
      if (kind === "unconscious") { downed(sim, a); s.physiology.consciousness = 0; refreshStatus(sim.ctx, sim.state, new EventSink(), a); }
      else {
        s.wounds.push({ id: s.nextWoundId++, zone: "legL", mechanism: "bullet", severity: 0.5, bleedingLps: 0, compressible: true, airway: false, breathing: false, consciousness: false, tickInflicted: 0, treatments: [] });
        refreshStatus(sim.ctx, sim.state, new EventSink(), a);
        expect(s.impair.canWalk).toBe(false);
        expect(s.impair.canFight).toBe(true);
      }
      expect(gaveUp(run(sim, 8), a)).toBeUndefined();
    }
  });

  it("a panicked man gives up with a known enemy within 30 m even beside his comrades, and not at 45 m", () => {
    for (const [redX, expectIt] of [[35, true], [55, false]] as const) {
      const sim = createSim(setup(redX));
      const a = unitOf(sim, "blue")[1].members[0]!;
      const ev = run(sim, 6, () => { sim.state.soldier.req(a).mental.stress = 1; });
      if (expectIt) expect(gaveUp(ev, a)).toMatchObject({ reason: "panicked" });
      else expect(gaveUp(ev, a)).toBeUndefined();
    }
  });

  it("the same rule holds for both sides", () => {
    const sim = createSim(setup());
    const [, red] = unitOf(sim, "red");
    const [r1, r2] = red.members as [number, number];
    place(sim, r2, 190, 190);
    downed(sim, r1);
    expect(gaveUp(run(sim, 5), r1)).toMatchObject({ reason: "wounded", side: "red" });
  });

  it("a leader who gives up hands the lead to the next able man", () => {
    const sim = createSim(setup());
    const [bid, blue] = unitOf(sim, "blue");
    const lead = blue.leader!;
    const others = blue.members.filter((m) => m !== lead);
    for (const [k, m] of others.entries()) place(sim, m, 10, 150 + 30 * k);
    downed(sim, lead);
    expect(gaveUp(run(sim, 5), lead)).toBeDefined();
    const now = sim.state.unit.req(bid).leader;
    expect(now).not.toBe(lead);
    expect(isAble(sim.state.soldier.req(now!))).toBe(true);
  });

  it("value 0 switches the rules off", () => {
    const sim = createSim(setup(35, (i) => {
      const b = i.catalog.behaviour;
      i.catalog = { ...i.catalog, behaviour: { ...b, surrender: { ...b.surrender, downedEnemyM: 0, caughtEnemyM: 0 } } };
    }));
    const [, blue] = unitOf(sim, "blue");
    const [a, b, c] = blue.members as [number, number, number];
    place(sim, b, 10, 150); place(sim, c, 10, 180);
    downed(sim, a);
    expect(run(sim, 6, () => { sim.state.soldier.req(b).mental.stress = 1; }).some((e) => e.kind === "surrendered")).toBe(false);
  });
});

describe("who knows, who holds fire (M6.6)", () => {
  it("until an enemy has seen it he can still be chosen as a target; once seen, those men hold their fire", () => {
    const sim = createSim(setup(120));
    const [, blue] = unitOf(sim, "blue");
    const [a, b, c] = blue.members as [number, number, number];
    place(sim, b, 10, 150); place(sim, c, 10, 180);
    sim.state.soldier.req(a).posture = "prone"; // a smaller target: he must live through the test
    submitOrder(sim, { tick: 0, issuer: "red", target: unitOf(sim, "red")[0], kind: "rules", fire: "free" });
    const red = unitOf(sim, "red")[1].members;
    // Red opens fire on him.
    for (let k = 0; k < secondsToTicks(20) && !red.some((m) => sim.state.fire.get(m)?.contact === a); k++) step(sim);
    expect(red.some((m) => sim.state.fire.get(m)?.contact === a)).toBe(true);
    // He gives up now: nobody has seen it yet, so the fire tasks on him still stand.
    surrender(sim.ctx, sim.state, new EventSink(), a, "wounded");
    expect(red.some((m) => sim.state.fire.get(m)?.contact === a)).toBe(true);
    for (const m of red) expect(sim.state.soldier.req(m).contacts.find((k) => k.target === a)?.surrendered).toBeUndefined();
    // Within a few seconds those who see him know, and hold their fire.
    run(sim, 3);
    expect(sim.state.soldier.req(a).physiology.alive).toBe(true);
    const knowers = red.filter((m) => sim.state.soldier.req(m).contacts.find((x) => x.target === a)?.surrendered === true);
    expect(knowers.length).toBeGreaterThan(0);
    for (const m of red) {
      const k = sim.state.soldier.req(m).contacts.find((x) => x.target === a);
      if (k) expect(k.surrendered).toBe(true);
      expect(sim.state.fire.get(m)?.contact).not.toBe(a);
    }
    run(sim, 10);
    for (const m of red) expect(sim.state.fire.get(m)?.contact).not.toBe(a);
  });

  it("a fire order naming a man the unit knows has given up gives no fire task; fire at the point beside him is still carried out", () => {
    const sim = createSim(setup());
    const a = unitOf(sim, "blue")[1].members[0]!;
    const [rid, ru] = unitOf(sim, "red");
    const red = ru.members;
    run(sim, 4);
    surrender(sim.ctx, sim.state, new EventSink(), a, "wounded");
    run(sim, 3);
    submitOrder(sim, { tick: sim.state.tick, issuer: "red", target: rid, kind: "fire", x: 10, y: 10, contact: a });
    const ev = run(sim, 3);
    for (const m of red) expect(sim.state.fire.has(m)).toBe(false);
    expect(ev.some((e) => e.kind === "radio" && e.side === "red" && e.key === "radio.unable")).toBe(true);
    submitOrder(sim, { tick: sim.state.tick, issuer: "red", target: rid, kind: "fire", x: 12, y: 10 });
    run(sim, 5);
    expect(red.some((m) => sim.state.fire.has(m))).toBe(true);
  });

  it("the side's picture marks him surrendered; what its own prisoners know is left out", () => {
    const sim = createSim(setup());
    const a = unitOf(sim, "blue")[1].members[0]!;
    run(sim, 4);
    surrender(sim.ctx, sim.state, new EventSink(), a, "wounded");
    run(sim, 3);
    const k = sideKnowledge(sim.ctx, sim.state, "red").find((x) => x.target === a);
    expect(k?.surrendered).toBe(true);
    // Blue's picture: a's own contacts are no longer part of it (he is out of the fight).
    const [, blue] = unitOf(sim, "blue");
    for (const m of blue.members) if (m !== a) sim.state.soldier.req(m).contacts = [];
    expect(sideKnowledge(sim.ctx, sim.state, "blue")).toHaveLength(0);
  });
});

describe("prisoners and the score (M6.6)", () => {
  it("when it is quiet, one enemy who saw it walks over, takes him prisoner and goes back where he stood", () => {
    const sim = createSim(setup());
    const [, blue] = unitOf(sim, "blue");
    const [a, b, c] = blue.members as [number, number, number];
    place(sim, b, 10, 150); place(sim, c, 10, 180);
    const red = unitOf(sim, "red")[1].members;
    const starts = new Map(red.map((m) => [m, { ...sim.state.transform.req(m) }]));
    downed(sim, a);
    const ev = run(sim, 95);
    expect(gaveUp(ev, a)).toBeDefined();
    const cap = ev.find((e) => e.kind === "captured" && e.soldier === a);
    expect(cap).toBeDefined();
    expect(ev.filter((e) => e.kind === "captured").length).toBe(1);
    expect(sim.state.soldier.req(a).captive?.state).toBe("captured");
    const by = cap!.kind === "captured" ? cap!.by : -1;
    expect(red).toContain(by);
    // Only one went; he came back to where he stood.
    const moved = red.filter((m) => Math.hypot(sim.state.transform.req(m).x - starts.get(m)!.x, sim.state.transform.req(m).y - starts.get(m)!.y) > 2);
    expect(moved.length).toBe(0);
    expect(sim.state.soldier.req(by).intent).toBeNull();
  });

  it("nobody walks over while his unit is under fire, and none at all with fetchWithinM 0", () => {
    const sim = createSim(setup(50, (i) => {
      const b = i.catalog.behaviour;
      i.catalog = { ...i.catalog, behaviour: { ...b, surrender: { ...b.surrender, fetchWithinM: 0 } } };
    }));
    const [, blue] = unitOf(sim, "blue");
    const [a, b, c] = blue.members as [number, number, number];
    place(sim, b, 10, 150); place(sim, c, 10, 180);
    downed(sim, a);
    const ev = run(sim, 60);
    expect(gaveUp(ev, a)).toBeDefined();
    expect(ev.some((e) => e.kind === "captured")).toBe(false);
    // Under fire: no errand either.
    const sim2 = createSim(setup());
    const [, blue2] = unitOf(sim2, "blue");
    const [a2, b2, c2] = blue2.members as [number, number, number];
    place(sim2, b2, 10, 150); place(sim2, c2, 10, 180);
    downed(sim2, a2);
    const redTop = unitOf(sim2, "red")[0];
    const ev2 = run(sim2, 40, () => { sim2.state.unit.req(redTop).underFireTick = sim2.state.tick; });
    expect(gaveUp(ev2, a2)).toBeDefined();
    expect(ev2.some((e) => e.kind === "captured")).toBe(false);
  });

  it("an order to the walker's unit cancels the errand", () => {
    const sim = createSim(setup());
    const [, blue] = unitOf(sim, "blue");
    const [a, b, c] = blue.members as [number, number, number];
    place(sim, b, 10, 150); place(sim, c, 10, 180);
    downed(sim, a);
    const [rid, ru] = unitOf(sim, "red");
    const red = ru.members;
    let walker: number | undefined;
    for (let k = 0; k < secondsToTicks(40) && walker === undefined; k++) { step(sim); walker = red.find((m) => sim.state.soldier.req(m).intent?.kind === "takePrisoner"); }
    expect(walker).toBeDefined();
    submitOrder(sim, { tick: sim.state.tick, issuer: "red", target: rid, kind: "halt" });
    run(sim, 2);
    expect(sim.state.soldier.req(walker!).intent).toBeNull();
    // Nobody of the unit is sent again right after the order.
    const ev = run(sim, 8);
    for (const m of red) expect(sim.state.soldier.req(m).intent?.kind).not.toBe("takePrisoner");
    expect(ev.some((e) => e.kind === "captured")).toBe(false);
  });

  it("surrendered and captured men cost their side like casualties, once each; a prisoner who passes out and comes round is still a prisoner", () => {
    const sim = createSim(setup());
    const a = unitOf(sim, "blue")[1].members[0]!;
    sim.ctx.rules.victory = { casualtyPoints: 5, endOnDefeat: false };
    const down0 = battleScore(sim.ctx, sim.state).scores.find((s) => s.side === "blue")!.menDown;
    const ev = new EventSink();
    surrender(sim.ctx, sim.state, ev, a, "wounded");
    expect(battleScore(sim.ctx, sim.state).scores.find((s) => s.side === "blue")!.menDown).toBe(down0 + 1);
    const s = sim.state.soldier.req(a);
    s.physiology.consciousness = 0;
    refreshStatus(sim.ctx, sim.state, ev, a);
    expect(s.mental.behaviour).toBe("surrendered");
    expect(ev.events.some((e) => e.kind === "radio" && e.key === "radio.manDown")).toBe(false);
    expect(battleScore(sim.ctx, sim.state).scores.find((x) => x.side === "blue")!.menDown).toBe(down0 + 1);
    s.physiology.consciousness = 1;
    refreshStatus(sim.ctx, sim.state, ev, a);
    expect(s.casualty).toBe("none");
    expect(isAble(s)).toBe(false);
  });

  it("the roster shows him as surrendered; such a record placed in a new battle is out of the fight; the result counts him", () => {
    const input = setup();
    const sim = createSim(input);
    const a = unitOf(sim, "blue")[1].members[0]!;
    surrender(sim.ctx, sim.state, new EventSink(), a, "panicked");
    const rec = soldierRecordFromState(sim.state, a);
    expect(rec.status).toBe("surrendered");
    expect(rosterStatus(sim.state.soldier.req(a))).toBe("surrendered");
    const again = armedInput(1, 30);
    again.forces[0]!.units[0]!.members[0] = { ...again.forces[0]!.units[0]!.members[0]!, status: "captured" };
    const sim2 = createSim(again);
    const first = unitOf(sim2, "blue")[1].members[0]!;
    expect(sim2.state.soldier.req(first).captive?.state).toBe("captured");
    expect(isAble(sim2.state.soldier.req(first))).toBe(false);
    const r = runBattle(again);
    const blue = r.sides.find((x) => x.side === "blue")!;
    expect(blue.captured).toBe(1);
    expect(blue.soldiersStart).toBe(blue.soldiersFit + blue.wounded + blue.killed + blue.surrendered + blue.captured);
  });

  it("surrender and prisoners are deterministic across save and load", () => {
    const input = setup();
    const sim = createSim(input);
    const [, blue] = unitOf(sim, "blue");
    const [a, b, c] = blue.members as [number, number, number];
    place(sim, b, 10, 150); place(sim, c, 10, 180);
    downed(sim, a);
    run(sim, 20);
    const copy = loadSim({ ...input, orders: [] }, saveSim(sim));
    run(sim, 40); run(copy, 40);
    expect(hashState(copy.state)).toBe(hashState(sim.state));
  });
});
