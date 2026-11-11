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
    const t0 = Math.min(...[...firstSeen.values()]);
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
    expect(Math.max(...errs)).toBeLessThan(35);
    expect(ev.some((e) => e.kind === "radio" && e.key === "radio.contactHeard")).toBe(true);
  });

  it("contacts are called out on the radio, not more than once every 8 s per unit; old contacts are forgotten after 2 minutes", () => {
    const sim = createSim(setup());
    const ev = run(sim, 30);
    const calls = ev.filter((e) => e.kind === "radio" && e.key.startsWith("radio.contact") && e.side === "blue");
    expect(calls.length).toBeGreaterThan(0);
    for (let k = 1; k < calls.length; k++) expect(calls[k]!.tick - calls[k - 1]!.tick).toBeGreaterThanOrEqual(secondsToTicks(8));
    // Red disappears (moved far away instantly): blue keeps the old contact, then forgets it.
    for (const m of unitOf(sim, "red")[1].members) { const t = sim.state.transform.req(m); t.x = 199; t.y = 199; sim.state.soldier.req(m).posture = "prone"; }
    const [, blue] = unitOf(sim, "blue");
    run(sim, 30);
    expect(blue.members.some((m) => sim.state.soldier.req(m).contacts.length > 0)).toBe(true);
    run(sim, 130);
    for (const m of blue.members) for (const c of sim.state.soldier.req(m).contacts) expect(sim.state.tick - c.tick).toBeLessThanOrEqual(secondsToTicks(121));
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
    // He walks 40 m north; the fire point follows.
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
});
