import { describe, expect, it } from "vitest";
import {
  aimErrorMrad, createSim, EventSink, hashState, interruptAction, loadSim, saveSim, secondsToTicks, step, submitOrder,
  type Sim, type SimEvent,
} from "../src/index";
import { armedInput } from "./helpers";

const blue = (sim: Sim) => [...sim.state.unit.entries()].find(([, u]) => u.side === "blue")!;
const kinds = (ev: SimEvent[], k: SimEvent["kind"]) => ev.filter((e) => e.kind === k);
function run(sim: Sim, seconds: number): SimEvent[] {
  const out: SimEvent[] = [];
  for (let i = 0; i < secondsToTicks(seconds); i++) out.push(...step(sim));
  return out;
}
/** Rounds a man has: in the weapon plus in his magazines. */
function rounds(sim: Sim, id: number): number {
  const w = sim.state.weapon.req(id);
  return (w.magazine?.rounds ?? 0) + sim.state.container.req(id).stacks.filter((s) => s.type === "mag").reduce((n, s) => n + s.count * (s.charge ?? 0), 0);
}
const fireAt = (sim: Sim, target: number, x: number, y: number) =>
  submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target, kind: "fire", x, y });

describe("fire order", () => {
  it("men open fire, every round comes out of a magazine (no free ammunition), and they acknowledge", () => {
    const sim = createSim(armedInput());
    const [uid, unit] = blue(sim);
    fireAt(sim, uid, 150, 15);
    const ev = run(sim, 20);
    const shots = kinds(ev, "shot.fired");
    expect(shots.length).toBeGreaterThan(15); // 3 men, aimed fire at 140 m: one shot per man every ~2.5 s
    expect(shots.length).toBeLessThan(30);
    expect(ev.find((e) => e.kind === "radio" && !e.key.startsWith("radio.contact"))).toMatchObject({ key: "radio.ack.fire" });
    const left = unit.members.reduce((n, m) => n + rounds(sim, m), 0);
    expect(left).toBe(unit.members.length * 90 - shots.length);
    expect(sim.state.projectiles.count + kinds(ev, "impact").length).toBeGreaterThan(0);
  });

  it("rate of fire depends on range: bursts up close, rapid single shots to 100 m, aimed shots beyond", () => {
    const perManPerSecond = (x: number) => {
      const sim = createSim(armedInput());
      const [uid, unit] = blue(sim);
      fireAt(sim, uid, x, 15);
      return kinds(run(sim, 12), "shot.fired").length / unit.members.length / 10; // ~10 s of firing after the delay
    };
    const close = perManPerSecond(30), mid = perManPerSecond(90), far = perManPerSecond(180);
    expect(close).toBeGreaterThan(mid * 1.5);
    expect(mid).toBeGreaterThan(far * 1.8);
    expect(far).toBeGreaterThan(0.3);
    expect(far).toBeLessThan(0.55);
  });

  it("an empty magazine is changed (a timed action) and kept; the last magazine is not fired off", () => {
    const sim = createSim(armedInput());
    const [uid, unit] = blue(sim);
    const ev: SimEvent[] = [];
    // Close range, renewed order: bursts empty magazines quickly.
    for (let k = 0; k < 6; k++) { fireAt(sim, uid, 30, 15); ev.push(...run(sim, 20)); }
    expect(kinds(ev, "weapon.reloaded").length).toBe(unit.members.length * 2); // two spare magazines each
    for (const m of unit.members) {
      const w = sim.state.weapon.req(m);
      expect(w.magazine!.rounds).toBe(30); // the last magazine stays in the weapon, full
      const mags = sim.state.container.req(m).stacks.filter((s) => s.type === "mag");
      expect(mags).toEqual([{ type: "mag", count: 2, charge: 0 }]); // empties are kept
    }
    expect(ev.filter((e) => e.kind === "radio" && e.key === "radio.lowAmmo")).toHaveLength(1); // one report per unit
    expect(kinds(ev, "fire.ceased").at(-1)).toMatchObject({ reason: "ammunition" });
    expect(sim.state.fire.size).toBe(0);
  });
});

describe("ammunition management (owner decision)", () => {
  it("with nothing coming back, the unit slows to a trickle after 30 s, then ceases fire and reports", () => {
    const sim = createSim(armedInput());
    const [uid] = blue(sim);
    fireAt(sim, uid, 180, 15);
    const perSecond = (ev: SimEvent[], s: number) => kinds(ev, "shot.fired").length / s;
    const full = perSecond(run(sim, 30), 30);
    run(sim, 5);
    const trickle = perSecond(run(sim, 50), 50);
    expect(trickle).toBeLessThan(full * 0.45);
    expect(trickle).toBeGreaterThan(0);
    const rest = run(sim, 20);
    expect(kinds(rest, "fire.ceased")[0]).toMatchObject({ unit: uid, reason: "no-target" });
    expect(rest.find((e) => e.kind === "radio" && !e.key.startsWith("radio.contact"))).toMatchObject({ key: "radio.noTarget" });
    expect(kinds(run(sim, 20), "shot.fired")).toHaveLength(0);
  });

  it("two teams firing at each other both keep up the full rate (rounds cracking past count as incoming fire)", () => {
    const sim = createSim(armedInput(3));
    const [bid, bunit] = blue(sim);
    const [rid, runit] = [...sim.state.unit.entries()].find(([, u]) => u.side === "red")!;
    // plenty of ammunition for a long exchange
    for (const m of [...bunit.members, ...runit.members]) sim.state.container.req(m).stacks = [{ type: "mag", count: 12, charge: 30 }];
    submitOrder(sim, { tick: 0, issuer: "blue", target: bid, kind: "fire", x: 190, y: 12 });
    submitOrder(sim, { tick: 0, issuer: "red", target: rid, kind: "fire", x: 10, y: 15 });
    run(sim, 100);
    const late = kinds(run(sim, 40), "shot.fired").length;
    // Nobody has ceased fire except men who were hit meanwhile (from M2.3 the rounds find their mark).
    const unhurt = [...bunit.members, ...runit.members].filter((m) => sim.state.soldier.req(m).wounds.length === 0);
    for (const m of unhurt) expect(sim.state.fire.has(m)).toBe(true);
    expect(sim.state.fire.size).toBeGreaterThan(0);
    expect(late / 40 / sim.state.fire.size).toBeGreaterThan(0.3); // still the full aimed rate (one shot per 2.5 s)
  });

  it("a unit on the slow rate answers at once when rounds come its way", () => {
    const sim = createSim(armedInput(4));
    const [bid, bunit] = blue(sim);
    const [rid] = [...sim.state.unit.entries()].find(([, u]) => u.side === "red")!;
    fireAt(sim, bid, 190, 12);
    run(sim, 45); // blue is now on the trickle
    const quiet = kinds(run(sim, 10), "shot.fired").filter((e) => e.kind === "shot.fired" && bunit.members.includes(e.shooter)).length;
    submitOrder(sim, { tick: sim.state.tick, issuer: "red", target: rid, kind: "fire", x: 10, y: 15 });
    run(sim, 4); // red's order arrives and its first rounds are on the way
    const answer = kinds(run(sim, 6), "shot.fired").filter((e) => e.kind === "shot.fired" && bunit.members.includes(e.shooter)).length;
    expect(quiet).toBeLessThanOrEqual(bunit.members.length * 2);
    expect(answer).toBeGreaterThanOrEqual(bunit.members.length * 2); // back to a shot every ~2.5 s each
  });

  it("no magazine swapping while the unit is still firing slowly", () => {
    const sim = createSim(armedInput());
    const [uid] = blue(sim);
    fireAt(sim, uid, 180, 15);
    run(sim, 32);
    expect(kinds(run(sim, 55), "weapon.reloaded")).toHaveLength(0);
  });

  it("cease fire and a move order both end the firing", () => {
    for (const next of ["ceaseFire", "move"] as const) {
      const sim = createSim(armedInput());
      const [uid] = blue(sim);
      fireAt(sim, uid, 180, 15);
      run(sim, 10);
      submitOrder(sim, next === "ceaseFire"
        ? { tick: sim.state.tick, issuer: "blue", target: uid, kind: "ceaseFire" }
        : { tick: sim.state.tick, issuer: "blue", target: uid, kind: "move", waypoints: [{ x: 40, y: 40, mode: "walk" }] });
      const ev = run(sim, 4);
      expect(kinds(ev, "fire.ceased")[0]).toMatchObject({ reason: next === "ceaseFire" ? "ordered" : "moved" });
      expect(kinds(run(sim, 10), "shot.fired")).toHaveLength(0);
    }
  });

  it("in a lull a man swaps his partly used magazine for a full one and keeps the partly used one", () => {
    const sim = createSim(armedInput());
    const [uid, unit] = blue(sim);
    fireAt(sim, uid, 30, 15); // close range: bursts, so the magazines are soon well below full
    run(sim, 7);
    submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: uid, kind: "ceaseFire" });
    run(sim, 2.5); // the order takes a second or two to arrive
    const m = unit.members[0]!;
    expect(sim.state.fire.size).toBe(0);
    expect(sim.state.weapon.req(m).magazine!.rounds).toBeLessThan(21);
    const before = rounds(sim, m);
    const ev = run(sim, 15);
    expect(kinds(ev, "weapon.reloaded").length).toBeGreaterThanOrEqual(unit.members.length);
    expect(sim.state.weapon.req(m).magazine!.rounds).toBe(30);
    expect(rounds(sim, m)).toBe(before);
    expect(sim.state.container.req(m).stacks.some((s) => s.type === "mag" && (s.charge ?? 0) > 0 && (s.charge ?? 0) < 30)).toBe(true);
    expect(kinds(run(sim, 15), "weapon.reloaded")).toHaveLength(0); // no endless swapping
  });
});

describe("handling and safety", () => {
  it("a stoppage is cleared in a few seconds and firing goes on", () => {
    const input = armedInput();
    input.catalog = { ...input.catalog, weapons: { rifle: { ...input.catalog.weapons["rifle"]!, jamProbability: 0.2 } } };
    const sim = createSim(input);
    const [uid] = blue(sim);
    fireAt(sim, uid, 180, 15);
    const ev = run(sim, 29);
    expect(kinds(ev, "weapon.jammed").length).toBeGreaterThan(1);
    expect(ev.filter((e) => e.kind === "action.completed" && e.action === "clearStoppage").length).toBeGreaterThan(0);
    const lastJam = kinds(ev, "weapon.jammed").at(-1)!.tick;
    expect(kinds(ev, "shot.fired").some((e) => e.tick > lastJam) || lastJam > secondsToTicks(25)).toBe(true);
  });

  it("nobody fires with a comrade in front of his muzzle", () => {
    const sim = createSim(armedInput());
    const [uid, unit] = blue(sim);
    const [a, b, c] = unit.members as [number, number, number];
    // b stands 10 m in front of a, on a's line to the target; c is clear.
    Object.assign(sim.state.transform.req(a), { x: 10, y: 10 });
    Object.assign(sim.state.transform.req(b), { x: 20, y: 10 });
    Object.assign(sim.state.transform.req(c), { x: 10, y: 30 });
    fireAt(sim, uid, 150, 10);
    const shooters = new Set(kinds(run(sim, 15), "shot.fired").map((e) => (e.kind === "shot.fired" ? e.shooter : 0)));
    expect(shooters.has(a)).toBe(false);
    expect(shooters.has(b)).toBe(true);
    expect(shooters.has(c)).toBe(true);
  });

  it("aiming error grows with poorer skill, higher posture, fatigue, pulse and rapid fire", () => {
    const sim = createSim(armedInput());
    const id = blue(sim)[1].members[0]!;
    const s = sim.state.soldier.req(id), w = sim.state.weapon.req(id);
    s.posture = "prone";
    const base = aimErrorMrad(sim.ctx, sim.state, id, w, true);
    expect(base).toBeCloseTo(1.13, 2); // test soldiers have marksmanship 0.5
    const with_ = (f: () => void, aimed = true) => { const copy = JSON.parse(JSON.stringify(s)); f(); const v = aimErrorMrad(sim.ctx, sim.state, id, w, aimed); Object.assign(s, copy); return v; };
    expect(with_(() => { s.skills["marksmanship"] = 0.35; })).toBeGreaterThan(base * 1.2);
    expect(with_(() => { s.skills["marksmanship"] = 0.65; })).toBeLessThan(base * 0.8);
    expect(with_(() => { s.posture = "standing"; })).toBeGreaterThan(with_(() => { s.posture = "crouching"; }));
    expect(with_(() => { s.physical.fatigue = 0.8; })).toBeGreaterThan(base * 1.5);
    expect(with_(() => { s.physical.heartRateBpm = 180; })).toBeGreaterThan(base * 1.3);
    expect(with_(() => { s.mental.suppression = 0.5; })).toBeGreaterThan(base * 2);
    expect(with_(() => {}, false)).toBeGreaterThan(base * 1.5);
  });

  it("a save in the middle of a firefight continues identically", () => {
    const a = createSim(armedInput(7));
    fireAt(a, blue(a)[0], 60, 15);
    run(a, 8);
    const b = loadSim(armedInput(7), JSON.parse(JSON.stringify(saveSim(a))));
    expect(hashState(b.state)).toBe(hashState(a.state));
    run(a, 30); run(b, 30);
    expect(hashState(b.state)).toBe(hashState(a.state));
  });

  it("aims correctly at a point far above him (steep angles)", () => {
    const sim = createSim(armedInput());
    const id = blue(sim)[1].members[0]!;
    sim.state.soldier.req(id).skills["marksmanship"] = 1;
    submitOrder(sim, { tick: 0, issuer: "blue", target: id, kind: "fire", x: 70, y: 10, heightM: 30 });
    const P = sim.state.projectiles;
    const miss: number[] = [];
    for (let t = 0; t < secondsToTicks(12); t++) {
      const before = new Map<number, [number, number]>();
      for (let i = 0; i < P.count; i++) before.set(P.bornTick[i]!, [P.x[i]!, P.z[i]!]);
      step(sim);
      for (let i = 0; i < P.count; i++) {
        const b = before.get(P.bornTick[i]!);
        if (b && b[0] < 70 && P.x[i]! >= 70) miss.push(b[1] + ((70 - b[0]) / (P.x[i]! - b[0])) * (P.z[i]! - b[1]) - 30);
      }
    }
    expect(miss.length).toBeGreaterThan(3);
    for (const m of miss) expect(Math.abs(m)).toBeLessThan(0.6); // was 2.5 m high before the fix
  });

  it("an interrupted reload changes nothing: no round or magazine is lost", () => {
    const sim = createSim(armedInput());
    const [uid, unit] = blue(sim);
    fireAt(sim, uid, 30, 15);
    let who = -1;
    for (let t = 0; t < secondsToTicks(40) && who < 0; t++) {
      step(sim);
      for (const m of unit.members) if (sim.state.action.get(m)?.kind === "reload") who = m;
    }
    expect(who).toBeGreaterThan(0);
    const before = { rounds: rounds(sim, who), mags: JSON.stringify(sim.state.container.req(who).stacks), loaded: JSON.stringify(sim.state.weapon.req(who).magazine) };
    const sink = new EventSink();
    interruptAction(sim.state, sink, who, "test");
    expect(sink.events[0]).toMatchObject({ kind: "action.interrupted", action: "reload" });
    expect(rounds(sim, who)).toBe(before.rounds);
    expect(JSON.stringify(sim.state.container.req(who).stacks)).toBe(before.mags);
    expect(JSON.stringify(sim.state.weapon.req(who).magazine)).toBe(before.loaded);
  });

  it("a unit without usable weapons answers 'unable' to a fire order", () => {
    const input = armedInput();
    for (const f of input.forces) for (const u of f.units) for (const m of u.members) delete m.weapon;
    const sim = createSim(input);
    const [uid, unit] = blue(sim);
    fireAt(sim, uid, 150, 15);
    const ev = run(sim, 5);
    expect(ev.find((e) => e.kind === "radio" && !e.key.startsWith("radio.contact"))).toMatchObject({ key: "radio.unable" });
    expect(unit.firing).toBe(false);
    expect(kinds(ev, "shot.fired")).toHaveLength(0);
  });
});

describe("belt-fed sustained fire (M2.5; faction-neutral test catalog)", () => {
  const gunInput = () => {
    const input = armedInput();
    const g = input.forces[0]!.units[0]!.members[0]!;
    g.weapon = "gun"; g.load = [{ type: "belt", count: 2, charge: 50 }];
    return input;
  };

  it("fires whole bursts at long range with a tracer every fifth round, changes belt, and fires the LAST belt too (it is no reserve)", () => {
    const sim = createSim(gunInput());
    const [, unit] = blue(sim);
    const gunner = unit.members[0]!;
    fireAt(sim, gunner, 190, 12);
    const shots: Extract<SimEvent, { kind: "shot.fired" }>[] = [];
    let reloads = 0, lowAmmo = 0;
    const ceased: string[] = [];
    for (let i = 0; i < secondsToTicks(80); i++) {
      if (i % secondsToTicks(20) === 0 && i > 0 && sim.state.fire.has(gunner)) fireAt(sim, gunner, 190, 12); // keep the full rate
      for (const e of step(sim)) {
        if (e.kind === "shot.fired" && e.shooter === gunner) shots.push(e);
        else if (e.kind === "weapon.reloaded" && e.soldier === gunner) reloads++;
        else if (e.kind === "radio" && e.key === "radio.lowAmmo") lowAmmo++;
        else if (e.kind === "fire.ceased") ceased.push(e.reason);
      }
    }
    expect(shots.length).toBe(100); // both belts, to the last round
    expect(reloads).toBe(1);
    expect(lowAmmo).toBe(1); // reported when he loaded the last belt
    expect(ceased).toContain("ammunition");
    expect(shots.filter((e) => e.ammo === "tball").length).toBe(20);
    const gaps = shots.slice(1).map((e, i) => e.tick - shots[i]!.tick);
    expect(gaps.filter((g) => g <= 6).length).toBe(80); // 20 bursts of five at the cyclic rate
    expect(sim.state.weapon.req(gunner).magazine?.rounds ?? 0).toBe(0);
  });

  it("a belt is not swapped in a lull; the telescopic sight and the bipod show in the aiming error", () => {
    const sim = createSim(gunInput());
    const [, unit] = blue(sim);
    const gunner = unit.members[0]!, rifleman = unit.members[1]!;
    fireAt(sim, gunner, 190, 12);
    run(sim, 12);
    submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: gunner, kind: "ceaseFire" });
    const ev = run(sim, 30);
    expect(ev.some((e) => e.kind === "weapon.reloaded" && e.soldier === gunner)).toBe(false);
    const wg = sim.state.weapon.req(gunner), wr = sim.state.weapon.req(rifleman);
    // Same skill and posture, both rested: the gun's telescopic sight helps, and in a burst it climbs far less.
    // (Both lying down: the gun's bipod is only down when he lies or rests it on something.)
    for (const m of [gunner, rifleman]) { const s = sim.state.soldier.req(m); s.physical.fatigue = 0; s.physical.heartRateBpm = 70; s.posture = "prone"; }
    wg.burstIndex = 0; wr.burstIndex = 0;
    expect(aimErrorMrad(sim.ctx, sim.state, gunner, wg, true)).toBeLessThan(aimErrorMrad(sim.ctx, sim.state, rifleman, wr, true));
    wg.burstIndex = 4; wr.burstIndex = 4;
    expect(aimErrorMrad(sim.ctx, sim.state, gunner, wg, false)).toBeLessThan(aimErrorMrad(sim.ctx, sim.state, rifleman, wr, false) * 0.5);
  });
});

describe("aiming time and bracing (M2 completion)", () => {
  it("the first shots at a new point are hurried: the error starts about 60 % larger and settles within seconds", () => {
    const sim = createSim(armedInput());
    const [uid, unit] = blue(sim);
    const man = unit.members[0]!;
    fireAt(sim, uid, 150, 15);
    run(sim, 1.1); // the order arrives after 1 s
    const w = sim.state.weapon.req(man);
    const early = aimErrorMrad(sim.ctx, sim.state, man, w, true);
    sim.state.fire.req(man).startTick = sim.state.tick - secondsToTicks(10);
    const settled = aimErrorMrad(sim.ctx, sim.state, man, w, true);
    expect(early / settled).toBeGreaterThan(1.4);
    expect(early / settled).toBeLessThan(1.65);
    // A new fire order at another point starts the settling again.
    fireAt(sim, uid, 150, 80);
    run(sim, 1.1);
    expect(sim.state.tick - sim.state.fire.req(man).startTick).toBeLessThan(10);
  });

  it("kneeling or standing next to a wall a man rests his weapon on it; prone or in the open it makes no difference", () => {
    const input = armedInput();
    input.map.obstacles.push({ id: 1, kind: "wall", points: [11.5, 0, 11.5, 12], heightM: 1, thicknessM: 0.25, material: "brick" });
    const sim = createSim(input);
    const [, unit] = blue(sim);
    const [atWall, , inOpen] = unit.members as [number, number, number]; // y = 10 (wall ends at 12) and y = 20
    const err = (id: number, posture: "standing" | "crouching" | "prone") => { sim.state.soldier.req(id).posture = posture; return aimErrorMrad(sim.ctx, sim.state, id, sim.state.weapon.req(id), true); };
    expect(err(atWall, "crouching") / err(inOpen, "crouching")).toBeCloseTo(0.8, 2);
    expect(err(atWall, "standing") / err(inOpen, "standing")).toBeCloseTo(0.8, 2);
    expect(err(atWall, "prone")).toBeCloseTo(err(inOpen, "prone"), 6);
  });
});

describe("line of fire (M3.1)", () => {
  it("a prone man behind a bank does not fire into it: he rises to a kneel and fires over it", () => {
    const input = armedInput();
    // A 0.8 m bank 3 m in front of the blue team.
    const m = input.map;
    for (let r = 0; r <= m.rows; r++) for (let c = 0; c <= m.cols; c++) { const x = c * m.cellSizeM; if (x >= 12 && x <= 16) m.heights[r * (m.cols + 1) + c] = 0.8; }
    const sim = createSim(input);
    const [uid, unit] = blue(sim);
    submitOrder(sim, { tick: 0, issuer: "blue", target: uid, kind: "posture", posture: "prone" });
    run(sim, 5);
    for (const id of unit.members) expect(sim.state.soldier.req(id).posture).toBe("prone");
    fireAt(sim, uid, 150, 15);
    const ev = run(sim, 12);
    const shots = kinds(ev, "shot.fired");
    expect(shots.length).toBeGreaterThan(3);
    for (const id of unit.members) expect(sim.state.soldier.req(id).posture).toBe("crouching");
    // No round struck the bank.
    expect(ev.filter((e) => e.kind === "impact" && e.x < 20).length).toBe(0);
  });

  it("behind a wall too high to fire over he holds his fire, and the unit reports it once", () => {
    const input = armedInput();
    input.map.obstacles.push({ id: 1, kind: "wall", points: [13, 0, 13, 40], heightM: 2, thicknessM: 0.25, material: "brick" });
    const sim = createSim(input);
    const [uid] = blue(sim);
    fireAt(sim, uid, 150, 15);
    const ev = run(sim, 15);
    expect(kinds(ev, "shot.fired")).toHaveLength(0);
    expect(ev.filter((e) => e.kind === "radio" && e.key === "radio.noLineOfFire")).toHaveLength(1);
  });
});

describe("line of fire review fixes (M3.1)", () => {
  const bank = () => {
    const input = armedInput();
    const m = input.map;
    for (let r = 0; r <= m.rows; r++) for (let c = 0; c <= m.cols; c++) { const x = c * m.cellSizeM; if (x >= 12 && x <= 16) m.heights[r * (m.cols + 1) + c] = 0.8; }
    return input;
  };

  it("a prone order while he is rising to fire over a bank does not make him fire into it", () => {
    const sim = createSim(bank());
    const [uid] = blue(sim);
    submitOrder(sim, { tick: 0, issuer: "blue", target: uid, kind: "posture", posture: "prone" });
    run(sim, 5);
    fireAt(sim, uid, 150, 15);
    const ev: SimEvent[] = [];
    for (let k = 0; k < 6; k++) { ev.push(...run(sim, 2)); submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: uid, kind: "posture", posture: "prone" }); }
    ev.push(...run(sim, 8));
    expect(ev.filter((e) => e.kind === "impact" && e.x < 20).length).toBe(0);
  });

  it("a man who rose to fire over a bank goes back down when he is told to fire where lying down is enough", () => {
    const sim = createSim(bank());
    const [uid, unit] = blue(sim);
    submitOrder(sim, { tick: 0, issuer: "blue", target: uid, kind: "posture", posture: "prone" });
    run(sim, 5);
    fireAt(sim, uid, 150, 15);
    run(sim, 8);
    for (const id of unit.members) expect(sim.state.soldier.req(id).posture).toBe("crouching");
    // A new point to the south, along the open ground clear of the bank: lying down is enough again.
    submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: uid, kind: "fire", x: 1, y: 150 });
    run(sim, 8);
    for (const id of unit.members) expect(sim.state.soldier.req(id).posture).toBe("prone");
  });

  it("at long range a crest 50 m short of the point blocks the line of fire (it is not 'what he fires at')", () => {
    const input = armedInput();
    const m = input.map;
    for (let r = 0; r <= m.rows; r++) for (let c = 0; c <= m.cols; c++) { const x = c * m.cellSizeM; if (x >= 136 && x <= 144) m.heights[r * (m.cols + 1) + c] = 4; }
    input.forces[1]!.placements = input.forces[1]!.placements.map((p) => ({ ...p, x: 195 }));
    const sim = createSim(input);
    const [uid] = blue(sim);
    fireAt(sim, uid, 190, 15); // point 50 m beyond the crest, in dead ground
    const ev = run(sim, 10);
    expect(kinds(ev, "shot.fired")).toHaveLength(0);
    expect(ev.some((e) => e.kind === "radio" && e.key === "radio.noLineOfFire")).toBe(true);
  });
});
