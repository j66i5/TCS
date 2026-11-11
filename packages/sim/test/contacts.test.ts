/** M3.3: contacts — seen, heard, reported — and sharing through the comms model (SPEC 6.5). */
import { describe, expect, it } from "vitest";
import { createSim, hashState, loadSim, saveSim, secondsToTicks, step, submitOrder, type BattleInput, type Sim, type SimEvent } from "../src/index";
import { armedInput } from "./helpers";

const unitOf = (sim: Sim, side: string) => [...sim.state.unit.entries()].find(([, u]) => u.side === side)!;
function run(sim: Sim, seconds: number): SimEvent[] {
  const out: SimEvent[] = [];
  for (let i = 0; i < secondsToTicks(seconds); i++) out.push(...step(sim));
  return out;
}
/** Blue at x = 10 (y 10, 15, 20); red 110 m east. `prep` may change the input. */
function setup(prep?: (i: BattleInput) => void): BattleInput {
  const input = armedInput();
  input.rules.physiologyModel = "simple";
  input.forces[1]!.placements = input.forces[1]!.placements.map((p) => ({ ...p, x: 120 }));
  prep?.(input);
  return input;
}

describe("contacts (M3.3)", () => {
  it("a man who sees an enemy knows where he is; his comrades learn it by voice a second later, the man far off by radio later", () => {
    const sim = createSim(setup((i) => {
      // The third blue man stands 300 m away from the others, out of voice range, behind a wall (cannot see red).
      i.forces[0]!.placements[2] = { personId: i.forces[0]!.placements[2]!.personId, x: 20, y: 190, heading: 0 };
      i.map.obstacles.push({ id: 1, kind: "wall", points: [25, 170, 25, 199], heightM: 2, thicknessM: 0.25, material: "brick" });
    }));
    const [, blue] = unitOf(sim, "blue");
    const [a, b, far] = blue.members as [number, number, number];
    const red = unitOf(sim, "red")[1].members;
    const firstSeen = new Map<number, number>(), firstKnown = new Map<number, number>();
    for (let k = 0; k < secondsToTicks(40); k++) {
      for (const e of step(sim)) if (e.kind === "spotted" && !firstSeen.has(e.observer)) firstSeen.set(e.observer, e.tick);
      for (const m of [a, b, far]) if (!firstKnown.has(m) && sim.state.soldier.req(m).contacts.length > 0) firstKnown.set(m, sim.state.tick);
    }
    const blueSeen = [...firstSeen.entries()].filter(([o]) => [a, b, far].includes(o));
    const t0 = Math.min(...blueSeen.map(([, t]) => t));
    const firstSeer = blueSeen.find(([, t]) => t === t0)![0];
    const near = firstSeer === a ? b : a;
    // The comrade 5 m away knows by voice within about a second (unless he saw them himself first).
    expect(firstKnown.get(near)! - t0).toBeLessThanOrEqual(secondsToTicks(1) + 1);
    expect(firstKnown.get(far)).toBeDefined();
    // The far man never saw anyone himself, and learnt of them by radio: 1 s to say it + 5 s radio delay.
    expect(firstSeen.has(far)).toBe(false);
    expect(firstKnown.get(far)! - t0).toBeGreaterThanOrEqual(secondsToTicks(6));
    expect(firstKnown.get(far)! - t0).toBeLessThan(secondsToTicks(8));
    const c = sim.state.soldier.req(far).contacts[0]!;
    expect(c.kind).toBe("reported");
    expect(red).toContain(c.target);
    // A man who sees him has his position to within a couple of metres.
    const seer = [a, b].find((m) => sim.state.soldier.req(m).contacts.some((x) => x.kind === "seen"))!;
    const sc = sim.state.soldier.req(seer).contacts.find((x) => x.kind === "seen")!;
    const t = sim.state.transform.req(sc.target);
    expect(Math.hypot(sc.x - t.x, sc.y - t.y)).toBeLessThan(0.01);
    expect(sc.errM).toBeLessThan(3);
  });

  it("an enemy firing from behind a wall is heard: the direction is right within degrees, the distance only roughly, and he is not 'seen'", () => {
    const sim = createSim(setup((i) => {
      // A 3 m wall in front of the red men: blue cannot see them; they fire high, over it.
      i.map.obstacles.push({ id: 1, kind: "wall", points: [115, 0, 115, 200], heightM: 3, thicknessM: 0.25, material: "brick" });
      i.forces[1]!.placements = i.forces[1]!.placements.map((p) => ({ ...p, x: 130 }));
    }));
    const [rid] = unitOf(sim, "red");
    submitOrder(sim, { tick: 0, issuer: "red", target: rid, kind: "fire", x: 10, y: 15, heightM: 30 });
    const ev = run(sim, 20);
    expect(ev.some((e) => e.kind === "shot.fired")).toBe(true);
    expect(ev.some((e) => e.kind === "spotted" && e.side === "blue")).toBe(false);
    const [, blue] = unitOf(sim, "blue");
    const errs: number[] = [], rangeErr: number[] = [];
    for (const m of blue.members) for (const c of sim.state.soldier.req(m).contacts) {
      expect(["heard", "reported"]).toContain(c.kind);
      const me = sim.state.transform.req(m), t = sim.state.transform.req(c.target);
      const trueA = Math.atan2(t.y - me.y, t.x - me.x), estA = Math.atan2(c.y - me.y, c.x - me.x);
      errs.push(Math.abs(((estA - trueA + Math.PI * 3) % (Math.PI * 2)) - Math.PI) * 180 / Math.PI);
      rangeErr.push(Math.abs(Math.hypot(c.x - me.x, c.y - me.y) / Math.hypot(t.x - me.x, t.y - me.y) - 1));
    }
    expect(errs.length).toBeGreaterThan(0);
    expect(Math.max(...errs)).toBeLessThan(25); // 8 degrees one standard deviation (data)
    // The distance is a rough guess (35 % one standard deviation): wrong on average by more than a few percent.
    const meanRangeErr = rangeErr.reduce((x, y) => x + y, 0) / rangeErr.length;
    expect(meanRangeErr).toBeGreaterThan(0.03);
    expect(meanRangeErr).toBeLessThan(0.8);
    expect(ev.some((e) => e.kind === "radio" && e.key === "radio.contactHeard")).toBe(true);
  });

  it("contacts are called out on the radio, not more than once every 8 s per unit; old contacts are forgotten after 2 minutes", () => {
    const sim = createSim(setup());
    const ev = run(sim, 30);
    const calls = ev.filter((e) => e.kind === "radio" && e.key.startsWith("radio.contact") && e.side === "blue");
    expect(calls.length).toBeGreaterThan(0);
    for (let k = 1; k < calls.length; k++) expect(calls[k]!.tick - calls[k - 1]!.tick).toBeGreaterThanOrEqual(secondsToTicks(8));
    // Fog comes down: nobody sees anyone any more. Blue keeps the old contacts for two minutes, then forgets them.
    sim.state.environment.visibilityM = 1;
    const [, blue] = unitOf(sim, "blue");
    run(sim, 60);
    expect(blue.members.some((m) => sim.state.soldier.req(m).contacts.length > 0)).toBe(true);
    // Nothing has been confirmed since the fog: every contact is at least 55 s old.
    for (const m of blue.members) for (const c of sim.state.soldier.req(m).contacts) expect(sim.state.tick - c.tick).toBeGreaterThan(secondsToTicks(55));
    run(sim, 65);
    for (const m of blue.members) expect(sim.state.soldier.req(m).contacts).toHaveLength(0);
  });

  it("fire at a contact: each man aims where he believes the enemy is, and follows him as he moves", () => {
    const sim = createSim(setup());
    run(sim, 20); // they see each other
    const [bid, blue] = unitOf(sim, "blue");
    const target = unitOf(sim, "red")[1].members[0]!;
    expect(blue.members.some((m) => sim.state.soldier.req(m).contacts.some((c) => c.target === target))).toBe(true);
    submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: bid, kind: "fire", x: 0, y: 0, contact: target });
    run(sim, 2);
    const shooter = blue.members.find((m) => sim.state.fire.get(m)?.contact === target)!;
    const t0 = sim.state.transform.req(target);
    expect(Math.hypot(sim.state.fire.req(shooter).x - t0.x, sim.state.fire.req(shooter).y - t0.y)).toBeLessThan(3);
    // He walks 40 m south (y grows south on the map); the fire point follows.
    submitOrder(sim, { tick: sim.state.tick, issuer: "red", target, kind: "move", waypoints: [{ x: 120, y: 60, mode: "walk" }] });
    run(sim, 30);
    if (sim.state.soldier.req(target).physiology.alive && sim.state.fire.has(shooter)) {
      const t1 = sim.state.transform.req(target);
      expect(Math.hypot(sim.state.fire.req(shooter).x - t1.x, sim.state.fire.req(shooter).y - t1.y)).toBeLessThan(6);
    }
    // A contact order naming a friend is rejected.
    submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: bid, kind: "fire", x: 0, y: 0, contact: blue.members[0]! });
    expect(run(sim, 1).some((e) => e.kind === "order.rejected")).toBe(true);
  });

  it("reports on their way and every man's contacts are saved: the battle continues identically after loading", () => {
    const sim = createSim(setup());
    let saved: ReturnType<typeof saveSim> | null = null;
    for (let k = 0; k < secondsToTicks(30) && saved === null; k++) { step(sim); if (sim.state.contactReports.length > 0) saved = JSON.parse(JSON.stringify(saveSim(sim))); }
    expect(saved).not.toBeNull();
    const copy = loadSim(setup(), saved!);
    expect(copy.state.contactReports.length).toBeGreaterThan(0);
    for (let k = 0; k < secondsToTicks(20); k++) { step(sim); step(copy); }
    expect(hashState(copy.state)).toBe(hashState(sim.state));
  });

  it("review fix: a man who has only heard a shooter learns his exact position from the comrade beside him who sees him", () => {
    const sim = createSim(setup((i) => {
      // Blue men 5 m apart; a wall hides red from the 2nd and 3rd man but not the 1st.
      i.forces[0]!.placements = i.forces[0]!.placements.map((p, k) => ({ ...p, x: 10, y: 100 + k * 5 }));
      i.forces[1]!.placements = i.forces[1]!.placements.map((p, k) => ({ ...p, x: 120, y: 100 + k * 3 }));
      i.map.obstacles.push({ id: 1, kind: "wall", points: [14, 103, 14, 125], heightM: 2.5, thicknessM: 0.25, material: "brick" });
    }));
    const [, blue] = unitOf(sim, "blue");
    const [rid, red] = unitOf(sim, "red");
    const [seer, hider] = blue.members as [number, number, number];
    submitOrder(sim, { tick: 0, issuer: "red", target: rid, kind: "fire", x: 10, y: 60, heightM: 20 });
    run(sim, 40);
    const target = red.members[0]!;
    const seen = sim.state.soldier.req(seer).contacts.find((c) => c.target === target);
    const told = sim.state.soldier.req(hider).contacts.find((c) => c.target === target);
    expect(seen?.kind).toBe("seen");
    expect(told).toBeDefined();
    expect(told!.kind).toBe("reported");
    const t = sim.state.transform.req(target);
    expect(Math.hypot(told!.x - t.x, told!.y - t.y)).toBeLessThan(5);
  });

  it("review fix: a man who cannot speak (airway wound) passes nothing on", () => {
    const sim = createSim(setup((i) => {
      i.forces[0]!.placements[1] = { ...i.forces[0]!.placements[1]!, x: 20, y: 190 };
      i.forces[0]!.placements[2] = { ...i.forces[0]!.placements[2]!, x: 20, y: 195 };
      i.map.obstacles.push({ id: 1, kind: "wall", points: [25, 170, 25, 199], heightM: 2, thicknessM: 0.25, material: "brick" });
    }));
    const [, blue] = unitOf(sim, "blue");
    const [mute, x, y] = blue.members as [number, number, number];
    const s = sim.state.soldier.req(mute);
    s.wounds.push({ id: 0, zone: "neck", mechanism: "bullet", severity: 0.55, bleedingLps: 0, compressible: true, airway: true, breathing: false, consciousness: false, tickInflicted: 0, treatments: [] });
    s.impair.canSpeak = false;
    sim.state.environment.visibilityM = 10000;
    run(sim, 30);
    expect(s.contacts.some((c) => c.kind === "seen")).toBe(true);
    expect(sim.state.soldier.req(x).contacts).toHaveLength(0);
    expect(sim.state.soldier.req(y).contacts).toHaveLength(0);
  });
});
