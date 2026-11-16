/** M11.6 stage 2: a unit whose radios are all flat is off the net (orders, reports, radio lines), until a swap. */
import { describe, expect, it } from "vitest";
import {
  chargeAt, createSim, newReviewTally, observersFor, secondsToTicks, simpleComms, step, submitOrder, tallyReview, TICK_HZ, type BattleInput,
  type Catalog, type EntityId, type Sim, type SimEvent, type SoldierRecord, type UnitInput,
} from "../src/index";
import { rec, team, testCatalog, testInput } from "./helpers";

const WH = 10;
const catalog: Catalog = {
  ...testCatalog,
  items: {
    ...testCatalog.items,
    radio: { id: "radio", massKg: 0.6, category: "kit", radio: true, power: { battery: "rbat", hours: 1, swapSeconds: 2 } },
    rbat: { id: "rbat", massKg: 0.3, category: "battery", chargeCapacity: WH, chargeMassKg: 0 },
  },
  // No swap in a lull (only a flat battery is changed); a fitted battery keeps its listed charge (installedMin 1).
  behaviour: { ...testCatalog.behaviour, soldier: { ...testCatalog.behaviour.soldier, power: { installedMin: 1, swapBelowShare: 0, lullSpareShare: 0.5 } } },
};
/** 0.01 Wh at 10 W: flat after 3.6 s. */
const ALMOST_FLAT: SoldierRecord["load"] = [{ type: "radio", count: 1 }, { type: "rbat", count: 1, charge: 0.01 }];

/**
 * Blue: a platoon "p" (its leader p.0 at (10, 10) carries the only radio) with a squad "s" of three men 100 m away
 * (no radio of its own: covered by the platoon's). Red: a team with no radio anywhere.
 */
function input(load: SoldierRecord["load"]): BattleInput {
  const base = testInput(1, 600);
  base.catalog = catalog;
  const squad = team("s", 3);
  const platoon: UnitInput = { key: "p", callsign: "p", echelon: "platoon", leaderIndex: 0, members: [rec("p.0", load), rec("p.1")], subunits: [squad] };
  base.forces[0]!.units = [platoon];
  base.forces[0]!.placements = [
    { personId: "p.0", x: 10, y: 10, heading: 0 }, { personId: "p.1", x: 10, y: 140, heading: 0 },
    ...squad.members.map((m, i) => ({ personId: m.personId, x: 110, y: 10 + i * 5, heading: 0 })),
  ];
  return base;
}
const unitByKey = (sim: Sim, cs: string): [EntityId, ReturnType<Sim["state"]["unit"]["req"]>] => [...sim.state.unit.entries()].find(([, u]) => u.callsign === cs)!;
const manOf = (sim: Sim, pid: string): EntityId => [...sim.state.identity.entries()].find(([, i]) => i.personId === pid)![0];
function run(sim: Sim, seconds: number): SimEvent[] {
  const out: SimEvent[] = [];
  for (let i = 0; i < secondsToTicks(seconds); i++) out.push(...step(sim));
  return out;
}

describe("flat radios (M11.6 stage 2)", () => {
  it("a unit whose only radio (its parent's) is flat rejects orders with 'no-comms'", () => {
    const sim = createSim(input(ALMOST_FLAT));
    const [sid, squad] = unitByKey(sim, "s");
    const [pid, platoon] = unitByKey(sim, "p");
    expect(squad.comms.link).toBe("radio");
    run(sim, 6);
    expect(platoon.comms.link).toBe("none");
    expect(squad.comms.link).toBe("none");
    submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: sid, kind: "posture", posture: "prone" });
    submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: pid, kind: "posture", posture: "prone" });
    const ev = run(sim, 1);
    expect(ev.filter((e) => e.kind === "order.rejected").map((e) => (e.kind === "order.rejected" ? e.reason : ""))).toEqual(["no-comms", "no-comms"]);
    // Silent: no radio line from blue while off the net.
    const later = run(sim, 30);
    expect(later.some((e) => e.kind === "radio" && e.side === "blue")).toBe(false);
  });

  it("no contact report beyond voice range; within 40 m by voice still", () => {
    const sim = createSim(input(ALMOST_FLAT));
    const lead = manOf(sim, "p.0"), far = manOf(sim, "s.0"), near = manOf(sim, "p.1");
    const P = sim.ctx.rules.comms;
    expect(simpleComms.contactShareDelayTicks(sim.state, P, far, lead)).not.toBeNull();
    run(sim, 6);
    expect(simpleComms.contactShareDelayTicks(sim.state, P, far, lead)).toBeNull();
    expect(simpleComms.contactShareDelayTicks(sim.state, P, lead, near)).toBeNull(); // 130 m apart
    // Two squad men 5 m apart: shouted.
    expect(simpleComms.contactShareDelayTicks(sim.state, P, far, manOf(sim, "s.1"))).toBe(0);
    // Move p.1 next to the squad: voice.
    const t = sim.state.transform.req(near);
    t.x = 110; t.y = 30;
    expect(simpleComms.contactShareDelayTicks(sim.state, P, far, near)).toBe(0);
  });

  it("the call for fire's observers: off the net, only men within voice range of the caller", () => {
    const sim = createSim(input(ALMOST_FLAT));
    const lead = manOf(sim, "p.0");
    const before = observersFor(sim.ctx, sim.state, lead).map((o) => o.who);
    expect(before).toHaveLength(5);
    run(sim, 6);
    expect(observersFor(sim.ctx, sim.state, lead).map((o) => o.who)).toEqual([lead]);
    const s0 = manOf(sim, "s.0");
    expect(observersFor(sim.ctx, sim.state, s0).map((o) => o.who).sort((a, b) => a - b)).toEqual([s0, manOf(sim, "s.1"), manOf(sim, "s.2")].sort((a, b) => a - b));
  });

  it("comes back on the net after a battery swap", () => {
    const sim = createSim(input(ALMOST_FLAT));
    // A full spare reaches him after setup (setup would fit the fullest battery).
    sim.state.container.req(manOf(sim, "p.0")).stacks.push({ type: "rbat", count: 1, charge: WH });
    const [sid, squad] = unitByKey(sim, "s");
    let off = false, swapped = false;
    for (let i = 0; i < secondsToTicks(12); i++) {
      for (const e of step(sim)) if (e.kind === "power.swapped") swapped = true;
      if (squad.comms.link === "none") off = true;
    }
    expect(off).toBe(true);
    expect(swapped).toBe(true);
    run(sim, 1);
    expect(squad.comms.link).toBe("radio");
    submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: sid, kind: "posture", posture: "prone" });
    const ev = run(sim, 3);
    expect(ev.some((e) => e.kind === "order.rejected")).toBe(false);
    expect(ev.some((e) => e.kind === "order.received" && e.target === sid)).toBe(true);
  });

  it("'radio.broken' is still sent while off the net (morale reads it)", () => {
    const sim = createSim(input(ALMOST_FLAT));
    run(sim, 6);
    const [sid, squad] = unitByKey(sim, "s");
    expect(squad.comms.link).toBe("none");
    // Break the squad (its morale state says so; held there until the drill step breaks it).
    const ev: SimEvent[] = [];
    for (let i = 0; i < secondsToTicks(5) && !squad.broken; i++) { squad.morale.state = "broken"; ev.push(...step(sim)); }
    ev.push(...run(sim, 5));
    expect(squad.broken).toBe(true);
    expect(ev.some((e) => e.kind === "radio" && e.key === "radio.broken" && e.side === "blue")).toBe(true);
    expect(ev.filter((e) => e.kind === "radio" && e.side === "blue" && e.key !== "radio.broken")).toEqual([]);
    void sid;
  });

  it("a unit with no radio anywhere in its chain stays on the net; without a flat radio nothing changes", () => {
    const sim = createSim(input(ALMOST_FLAT));
    const [, red] = unitByKey(sim, "b");
    run(sim, 6);
    expect(red.comms.link).toBe("radio");
    const plain = createSim(input([{ type: "radio", count: 1 }, { type: "rbat", count: 1, charge: WH }]));
    run(plain, 6);
    for (const [, u] of plain.state.unit.entries()) expect(u.comms.link).toBe("radio");
  });

  // Review fixes (2026-11-16).
  for (const how of ["dead", "captive"] as const) {
    it(`a ${how} man's radio is switched off, never reported flat, and covers nobody`, () => {
      const sim = createSim(input(ALMOST_FLAT));
      const lead = manOf(sim, "p.0"), s = sim.state.soldier.req(lead);
      if (how === "dead") { s.physiology.alive = false; s.casualty = "killed"; } else s.captive = { state: "captured", tick: 0 };
      const slot = s.power![0]!;
      const ev = run(sim, 10);
      expect(slot.on).toBe(false);
      const wh = chargeAt(slot, sim.state.tick);
      expect(wh).toBeGreaterThan(0); // switched off within a second, before the 3.6 s it had left
      run(sim, 5);
      expect(chargeAt(slot, sim.state.tick)).toBe(wh);
      expect(ev.some((e) => e.kind === "power.flat")).toBe(false);
      // No live radio carried by a living man in the chain: on the net as before M11.6 (not "off with a flat radio").
      for (const cs of ["p", "s"]) expect(unitByKey(sim, cs)[1].comms.link).toBe("radio");
    });
  }

  it("the review counts no off-net time for a unit with no living man", () => {
    const sim = createSim(input(ALMOST_FLAT));
    run(sim, 6);
    const [, squad] = unitByKey(sim, "s");
    expect(squad.comms.link).toBe("none");
    const tally = (): number => {
      const t = newReviewTally();
      for (let i = 0; i < 3 * TICK_HZ; i++) { const ev = step(sim); if (squad.comms.link === "none") tallyReview(t, ev, sim.state, sim.ctx.catalog); }
      return t.sides["blue"]?.supply?.offNetS ?? 0;
    };
    expect(tally()).toBeGreaterThan(0);
    // The squad wiped out (its men dead), still off the net by its parent's flat radio: no more off-net seconds for it.
    for (const m of squad.members) { const ms = sim.state.soldier.req(m); ms.physiology.alive = false; ms.casualty = "killed"; }
    const [, platoon] = unitByKey(sim, "p");
    const t = newReviewTally();
    for (let i = 0; i < 3 * TICK_HZ; i++) tallyReview(t, step(sim), sim.state, sim.ctx.catalog);
    expect(squad.comms.link).toBe("none");
    expect(platoon.comms.link).toBe("none");
    expect(t.sides["blue"]?.supply?.offNetS).toBe(3); // the platoon headquarters alone, 3 s
  });

  it("an order to the platoon is not carried out by its squad that is off the net; its other squad does", () => {
    // p.0 has a live radio; squad "s" has its own radio, flat (no spare); squad "t" has none (covered by p.0's).
    const base = input([{ type: "radio", count: 1 }, { type: "rbat", count: 1, charge: WH }]);
    const platoon = base.forces[0]!.units[0]!;
    const s = platoon.subunits[0]!;
    s.members[0] = rec("s.0", ALMOST_FLAT);
    const t = team("t", 2);
    platoon.subunits.push(t);
    base.forces[0]!.placements.push(...t.members.map((m, i) => ({ personId: m.personId, x: 60, y: 10 + i * 5, heading: 0 })));
    const sim = createSim(base);
    run(sim, 6);
    const [pid, pu] = unitByKey(sim, "p"), [, su] = unitByKey(sim, "s"), [, tu] = unitByKey(sim, "t");
    expect(pu.comms.link).toBe("radio");
    expect(su.comms.link).toBe("none");
    expect(tu.comms.link).toBe("radio");
    submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: pid, kind: "posture", posture: "prone" });
    const ev = run(sim, 8);
    expect(ev.some((e) => e.kind === "order.delivered" && e.target === pid)).toBe(true);
    const posture = (pidS: string) => sim.state.soldier.req(manOf(sim, pidS)).homePosture;
    for (const m of ["p.0", "p.1", "t.0", "t.1"]) expect(posture(m)).toBe("prone");
    for (const m of ["s.0", "s.1", "s.2"]) expect(posture(m)).not.toBe("prone");
  });

  it("recorded lines (objective taken, rallied) still go out while off the net", () => {
    const sim = createSim(input(ALMOST_FLAT));
    run(sim, 6);
    const [sid, squad] = unitByKey(sim, "s");
    expect(squad.comms.link).toBe("none");
    // An assault the squad's men are already at: taken at once (the drill's end), sent although the radio is flat.
    const t0 = sim.state.transform.req(squad.members[0]!);
    squad.drill = { kind: "assault", x: t0.x, y: t0.y, groups: [[...squad.members]], mover: 0, phaseTick: -1, final: true };
    const ev = run(sim, 30);
    const blue = ev.filter((e) => e.kind === "radio" && e.side === "blue").map((e) => (e.kind === "radio" ? e.key : ""));
    expect(blue).toContain("radio.objectiveTaken");
    expect(blue.every((k) => k === "radio.objectiveTaken" || k === "radio.rallied" || k === "radio.broken")).toBe(true);
    void sid;
  });
});
