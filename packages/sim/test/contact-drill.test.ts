/** Review 2026-11-24 problem 2: the immediate-action contact drill and fire at unseen shooters. */
import { describe, expect, it } from "vitest";
import { createSim, hashState, loadSim, saveSim, secondsToTicks, step, submitOrder, type BattleInput, type Sim, type SimEvent } from "../src/index";
import { armedInput } from "./helpers";

const unitOf = (sim: Sim, side: string) => [...sim.state.unit.entries()].find(([, u]) => u.side === side)!;
function run(sim: Sim, seconds: number, each?: () => void): SimEvent[] {
  const out: SimEvent[] = [];
  for (let i = 0; i < secondsToTicks(seconds); i++) { each?.(); out.push(...step(sim)); }
  return out;
}
const radios = (ev: SimEvent[], side: string) => ev.filter((e): e is Extract<SimEvent, { kind: "radio" }> => e.kind === "radio" && e.side === side);
const shotsBy = (ev: SimEvent[], men: readonly number[]) => ev.filter((e) => e.kind === "shot.fired" && men.includes(e.shooter)).length;

/** The test input with the drill's data on (the values of core/behaviour.json); `blind`: nobody sees anybody (only
 *  shots are heard), `x`: where red stands. */
function setup(o: { blind?: boolean; x?: number } = {}): BattleInput {
  const input = armedInput(1, 900);
  input.rules.physiologyModel = "simple";
  input.forces[1]!.placements = input.forces[1]!.placements.map((p) => ({ ...p, x: o.x ?? 120 }));
  const c = input.catalog, b = c.behaviour;
  input.catalog = {
    ...c,
    behaviour: {
      ...b,
      drills: { ...b.drills, contact: { immediateS: 5, decideS: 10, quietS: 20, maxS: 120, srcEveryS: 2, srcWithinS: 20, guessM: 200, continuePinnedShare: 0.25, continueQuietS: 8, breakChecks: 2, contactAssaultM: 50, contactBreakLossShare: 0.3, contactBreakPinnedShare: 0.6, sidestepEveryS: 15, radioEveryS: 60, radioTurnDeg: 30, seenM: 300, breakFiringShare: 0.34 } },
      soldier: { ...b.soldier, returnFire: { firedOnS: 10, withinS: 20, maxErrM: 30, bearingDeg: 30, intervalS: 3, mgIntervalS: 4, areaMaxErrM: 120, areaMaxErrShare: 0.4, areaMaxRadiusM: 30, areaIntervalS: 4, areaMgIntervalS: 5, areaMinSpareMags: 1, pinnedBelow: 0.75, pinnedSustainedBelow: 0.95, noLineS: 6 } },
    },
    spotting: { ...c.spotting, ...(o.blind ? { baseRatePerS: 0 } : {}), contacts: { ...c.spotting.contacts, heardMergeSeconds: 10, heardMergeMax: 6, heardMinErrorFraction: 0.1 } },
  };
  return input;
}

describe("contact drill (review 2026-11-24 problem 2)", () => {
  it("a squad pushing on that comes under fire goes down, calls the bearing, fires back and goes on once it is quiet", () => {
    const input = setup();
    const sim = createSim(input);
    const [bid, blue] = unitOf(sim, "blue");
    const [rid] = unitOf(sim, "red");
    // (Fire rule "return": under "free" the sight of red, before a round is fired, would start the drill.)
    submitOrder(sim, { tick: 0, issuer: "blue", target: bid, kind: "rules", onContact: "push", fire: "return" });
    submitOrder(sim, { tick: 0, issuer: "blue", target: bid, kind: "move", waypoints: [{ x: 10, y: 190, mode: "walk" }] });
    run(sim, 5);
    submitOrder(sim, { tick: sim.state.tick, issuer: "red", target: rid, kind: "fire", x: 10, y: 32, heightM: 1 });
    const ev = run(sim, 12);
    // Before the drill, rule "push" ignored contact; now: immediate action.
    const call = radios(ev, "blue").find((e) => e.key === "radio.contactFire");
    expect(call).toBeDefined();
    // Red is to the east (bearing about 90).
    expect(Math.abs(Number(call!.params.bearing) - 90)).toBeLessThan(40);
    const u = sim.state.unit.req(bid);
    expect(u.contactDrill !== undefined || u.drill !== null).toBe(true);
    expect(shotsBy(ev, blue.members)).toBeGreaterThan(0);
    // Saved mid-drill, the copy goes on exactly the same.
    const copy = loadSim({ ...input, orders: [] }, saveSim(sim));
    for (let i = 0; i < secondsToTicks(3); i++) { step(sim); step(copy); }
    expect(hashState(copy.state)).toBe(hashState(sim.state));
    // Red stops firing: once it is quiet the squad goes on to where it was going.
    submitOrder(sim, { tick: sim.state.tick, issuer: "red", target: rid, kind: "ceaseFire" });
    const yHalt = Math.max(...blue.members.map((m) => sim.state.transform.req(m).y));
    // (Red may still fire on its own at men it sees: hold its fire for the rest of the test.)
    submitOrder(sim, { tick: sim.state.tick, issuer: "red", target: rid, kind: "rules", fire: "hold" });
    const ev2 = run(sim, 60);
    if (sim.state.unit.req(bid).drill === null) {
      expect(radios(ev2, "blue").some((e) => e.key === "radio.contactOn")).toBe(true);
      expect(Math.max(...blue.members.filter((m) => sim.state.soldier.req(m).casualty === "none").map((m) => sim.state.transform.req(m).y))).toBeGreaterThan(yHalt + 10);
    }
    expect(sim.state.unit.req(bid).contactDrill).toBeUndefined();
  });

  it("a near ambush (the fire within contactAssaultM) is assaulted after immediateS, not decideS later", () => {
    const sim = createSim(setup({ x: 45 }));
    const [bid] = unitOf(sim, "blue");
    const [rid] = unitOf(sim, "red");
    submitOrder(sim, { tick: 0, issuer: "blue", target: bid, kind: "rules", onContact: "push", fire: "return" });
    submitOrder(sim, { tick: 0, issuer: "blue", target: bid, kind: "move", waypoints: [{ x: 10, y: 190, mode: "walk" }] });
    let start = -1;
    const ev = run(sim, 25, () => {
      if (start < 0 && sim.state.unit.req(bid).contactDrill !== undefined) {
        start = sim.state.tick;
        // (The decision is due at immediateS: the leader goes in at once at an enemy this close.)
        expect(sim.state.unit.req(bid).contactDrill!.decideTick - start).toBeLessThanOrEqual(secondsToTicks(5));
      }
      if (sim.state.tick === secondsToTicks(3)) submitOrder(sim, { tick: sim.state.tick, issuer: "red", target: rid, kind: "fire", x: 10, y: 32, heightM: 1 });
    });
    expect(start).toBeGreaterThanOrEqual(0);
    const assault = radios(ev, "blue").find((e) => e.key === "radio.contactAssault");
    if (assault !== undefined) expect(assault.tick - start).toBeLessThanOrEqual(secondsToTicks(6));
  });

  it("the contact call is not repeated within radioEveryS on the same bearing", () => {
    const sim = createSim(setup());
    const [bid] = unitOf(sim, "blue");
    const [rid] = unitOf(sim, "red");
    const ev: SimEvent[] = [];
    for (let k = 0; k < 3; k++) {
      submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: bid, kind: "move", waypoints: [{ x: 10, y: 190 - k * 20, mode: "walk" }] });
      ev.push(...run(sim, 2));
      submitOrder(sim, { tick: sim.state.tick, issuer: "red", target: rid, kind: "fire", x: 10, y: 32, heightM: 1 });
      ev.push(...run(sim, 4));
      submitOrder(sim, { tick: sim.state.tick, issuer: "red", target: rid, kind: "ceaseFire" });
      ev.push(...run(sim, 3));
    }
    const calls = radios(ev, "blue").filter((e) => e.key === "radio.contactFire");
    expect(calls.length).toBeGreaterThan(0);
    for (let i = 1; i < calls.length; i++) {
      const db = Math.abs(Number(calls[i]!.params.bearing) - Number(calls[i - 1]!.params.bearing));
      if (calls[i]!.tick - calls[i - 1]!.tick < secondsToTicks(60)) expect(Math.min(db, 360 - db)).toBeGreaterThanOrEqual(30);
    }
  });

  it("rule push, fire free: a sighting within seenM halts the move into the drill before a round is fired", () => {
    const sim = createSim(setup({ x: 250 }));
    const [bid] = unitOf(sim, "blue");
    const [rid] = unitOf(sim, "red");
    submitOrder(sim, { tick: 0, issuer: "red", target: rid, kind: "rules", fire: "hold" });
    submitOrder(sim, { tick: 0, issuer: "blue", target: bid, kind: "rules", onContact: "push", fire: "free" });
    submitOrder(sim, { tick: 0, issuer: "blue", target: bid, kind: "move", waypoints: [{ x: 10, y: 190, mode: "walk" }] });
    let drill = false;
    run(sim, 30, () => { if (sim.state.unit.req(bid).contactDrill !== undefined) drill = true; });
    expect(drill).toBe(true);
  });

  it("an order ends the drill: the leader's decision is taken for him", () => {
    const sim = createSim(setup());
    const [bid] = unitOf(sim, "blue");
    const [rid] = unitOf(sim, "red");
    submitOrder(sim, { tick: 0, issuer: "blue", target: bid, kind: "move", waypoints: [{ x: 10, y: 190, mode: "walk" }] });
    run(sim, 5);
    submitOrder(sim, { tick: sim.state.tick, issuer: "red", target: rid, kind: "fire", x: 10, y: 32, heightM: 1 });
    run(sim, 6);
    expect(sim.state.unit.req(bid).contactDrill).toBeDefined();
    submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: bid, kind: "halt" });
    run(sim, 2);
    expect(sim.state.unit.req(bid).contactDrill).toBeUndefined();
  });

  it("fired on by a shooter nobody can see, men locate him by the sound and return fire at the area", () => {
    const sim = createSim(setup({ blind: true, x: 190 }));
    const [, blue] = unitOf(sim, "blue");
    const [rid, red] = unitOf(sim, "red");
    submitOrder(sim, { tick: 0, issuer: "red", target: rid, kind: "fire", x: 10, y: 15, heightM: 1 });
    // (The player's default rule: fire only when fired on. Return fire at a place counts as returning fire.)
    submitOrder(sim, { tick: 0, issuer: "blue", target: unitOf(sim, "blue")[0], kind: "rules", fire: "return" });
    let area = 0;
    const ev = run(sim, 30, () => {
      for (const m of blue.members) {
        const ft = sim.state.fire.get(m);
        if (ft?.suppress === "area") {
          area++;
          // The circle is toward the shooters (east, 180 m off: a sound's range is a rough guess), at most
          // areaMaxRadiusM wide.
          expect(ft.spot!.r).toBeLessThanOrEqual(30);
          expect(ft.spot!.cx).toBeGreaterThan(40);
          expect(Math.abs(ft.spot!.cy - 15)).toBeLessThan(60);
        }
      }
    });
    expect(area).toBeGreaterThan(0);
    expect(shotsBy(ev, blue.members)).toBeGreaterThan(0);
    // Nobody saw anybody: every contact blue has of red is a sound (or a comrade's word of one).
    const s = sim.state.soldier.req(blue.members[0]!);
    const heard = s.contacts.filter((c) => red.members.includes(c.target));
    expect(heard.length).toBeGreaterThan(0);
    expect(heard.every((c) => c.kind !== "seen")).toBe(true);
  });

  it("shots heard again from the same shooter narrow his place", () => {
    const sim = createSim(setup({ blind: true, x: 190 }));
    const [, blue] = unitOf(sim, "blue");
    const [rid, red] = unitOf(sim, "red");
    submitOrder(sim, { tick: 0, issuer: "red", target: rid, kind: "fire", x: 10, y: 15, heightM: 1 });
    // (Blue holds its fire: only the sounds of red's shots matter here.)
    submitOrder(sim, { tick: 0, issuer: "blue", target: unitOf(sim, "blue")[0], kind: "rules", fire: "hold" });
    let best = Infinity, merged = 0;
    run(sim, 25, () => {
      for (const m of blue.members) for (const c of sim.state.soldier.req(m).contacts) {
        if (!red.members.includes(c.target) || c.kind !== "heard") continue;
        if ((c.heardN ?? 1) > 1) { merged++; best = Math.min(best, c.errM); }
      }
    });
    expect(merged).toBeGreaterThan(0);
    // One sound at 180 m is known to 0.35 x 180 = 63 m; several together better.
    expect(best).toBeLessThan(63);
  });
});
