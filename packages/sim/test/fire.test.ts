import { describe, expect, it } from "vitest";
import {
  aimErrorMrad, createSim, hashState, launchProjectile, loadSim, saveSim, secondsToTicks, step, submitOrder,
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
    expect(ev.find((e) => e.kind === "radio")).toMatchObject({ key: "radio.ack.fire" });
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
    expect(ev.filter((e) => e.kind === "radio" && e.key === "radio.lowAmmo")).toHaveLength(unit.members.length);
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
    expect(rest.find((e) => e.kind === "radio")).toMatchObject({ key: "radio.noTarget" });
    expect(kinds(run(sim, 20), "shot.fired")).toHaveLength(0);
  });

  it("incoming fire near the unit keeps it firing at the full rate", () => {
    const sim = createSim(armedInput());
    const [uid, unit] = blue(sim);
    const red = [...sim.state.identity.entries()].find(([, i]) => i.side === "red")![0];
    fireAt(sim, uid, 180, 15);
    let late = 0;
    for (let t = 0; t < secondsToTicks(100); t++) {
      // every 5 s an enemy round strikes the ground among the blue men
      if (t % 300 === 0) launchProjectile(sim.ctx, sim.state, "ball", 12, 15, 2, 0, 0, -100, red);
      for (const e of step(sim)) if (e.kind === "shot.fired" && t > secondsToTicks(60)) late++;
    }
    expect(sim.state.fire.size).toBe(unit.members.length); // still at it after 100 s
    expect(late / 40 / unit.members.length).toBeGreaterThan(0.3); // still the full aimed rate
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
    fireAt(sim, uid, 180, 15);
    run(sim, 12);
    submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: uid, kind: "ceaseFire" });
    const m = unit.members[0]!;
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
});
