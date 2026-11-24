/**
 * Review 2026-11-24, problem 1 (friendly fire): on platoon seed 1 a prone rifleman put 59 of the battle's 149 hits
 * into his own side — a comrade handing him a magazine who came to lie on his very spot, that comrade's corpse, and
 * later a casualty he had carried on his back and set down on his own spot. Every one was a body lying over his
 * muzzle, which the fire-safety check skipped (dead, or "on the same spot"). Now a body a round would strike blocks.
 */
import { describe, expect, it } from "vitest";
import { bodyInLine, createSim, friendInLine, hypot2, secondsToTicks, step, submitOrder, type Sim, type SimEvent } from "../src/index";
import { stepBringAmmo } from "../src/systems/decisions";
import { EventSink } from "../src/events";
import { armedInput } from "./helpers";

const PI = Math.PI;

const idOf = (sim: Sim, personId: string) => [...sim.state.identity.entries()].find(([, i]) => i.personId === personId)![0];
function run(sim: Sim, seconds: number): SimEvent[] {
  const out: SimEvent[] = [];
  for (let i = 0; i < secondsToTicks(seconds); i++) out.push(...step(sim));
  return out;
}
const sideOf = (sim: Sim, id: number) => sim.state.identity.get(id)?.side;
const ownHits = (sim: Sim, ev: SimEvent[]) => ev.filter((e) => e.kind === "hit" && sideOf(sim, e.owner) === sideOf(sim, e.target));

function kill(sim: Sim, id: number): void {
  const s = sim.state.soldier.req(id);
  s.physiology.alive = false; s.casualty = "killed"; s.posture = "prone"; s.postureTo = null;
}

describe("a body a round would strike blocks (review 2026-11-24, problem 1)", () => {
  it("a comrade lying on a prone man's spot blocks; standing or kneeling on it (one window place) he does not", () => {
    const sim = createSim(armedInput());
    const s = sim.state;
    const shooter = idOf(sim, "a.0"), mate = idOf(sim, "a.1");
    const me = s.transform.req(shooter), t = s.transform.req(mate), ms = s.soldier.req(mate);
    s.soldier.req(shooter).posture = "prone";
    t.x = me.x; t.y = me.y; t.z = me.z; t.heading = PI; // crawled up from in front, lying head to his feet
    ms.posture = "prone";
    expect(friendInLine(sim.ctx, s, shooter, me.x + 150, me.y)).toBe(true);
    // (Kneeling, his muzzle 0.95 m up clears a body lying 0.3 m high.)
    expect(friendInLine(sim.ctx, s, shooter, me.x + 150, me.y, 0, undefined, undefined, { posture: "crouching" })).toBe(false);
    // Balance pass 4, G: two men upright on one place do not hold each other's fire.
    s.soldier.req(shooter).posture = "crouching";
    for (const p of ["crouching", "standing"] as const) { ms.posture = p; expect(friendInLine(sim.ctx, s, shooter, me.x + 150, me.y)).toBe(false); }
    // Lying 1.5 m behind him (where a man bringing a magazine makes for): not in his line.
    s.soldier.req(shooter).posture = "prone"; ms.posture = "prone"; t.x = me.x - 1.5; t.heading = 0;
    expect(friendInLine(sim.ctx, s, shooter, me.x + 150, me.y)).toBe(false);
  });

  it("a dead comrade blocks where a round would strike his body: over the muzzle, or lying low in the line; not off it", () => {
    const sim = createSim(armedInput());
    const s = sim.state;
    const shooter = idOf(sim, "a.0"), mate = idOf(sim, "a.1");
    const me = s.transform.req(shooter), t = s.transform.req(mate);
    kill(sim, mate);
    s.soldier.req(shooter).posture = "prone";
    // Lying on his spot (platoon s1: 0.02 m off, heading west, he fired west-north-west).
    t.x = me.x + 0.02; t.y = me.y; t.heading = PI;
    expect(friendInLine(sim.ctx, s, shooter, me.x - 150, me.y - 50)).toBe(true);
    expect(bodyInLine(sim.ctx, s, shooter, me.x - 150, me.y - 50, { posture: "crouching" })).toBe(false);
    // 8 m in front of a prone man: struck; a standing man fires over him.
    t.x = me.x + 8; t.y = me.y; t.heading = PI / 2;
    expect(friendInLine(sim.ctx, s, shooter, me.x + 150, me.y)).toBe(true);
    expect(friendInLine(sim.ctx, s, shooter, me.x + 150, me.y, 0, undefined, undefined, { posture: "standing" })).toBe(false);
    // Beside the line, behind him, or past the point: no.
    for (const [x, y] of [[8, 4], [-3, 0], [190, 0], [0.3, 0.8]] as const) {
      t.x = me.x + x; t.y = me.y + y; t.heading = 0;
      expect(friendInLine(sim.ctx, s, shooter, me.x + 150, me.y, 30)).toBe(false);
    }
  });

  it("a prone rifleman with a comrade's corpse over his muzzle kneels to fire and never strikes it", () => {
    const input = armedInput(1, 120);
    const sim = createSim(input);
    const s = sim.state;
    const [uid] = [...s.unit.entries()].find(([, u]) => u.side === "blue")!;
    const shooter = idOf(sim, "a.0"), dead = idOf(sim, "a.1");
    submitOrder(sim, { tick: s.tick, issuer: "blue", target: uid, kind: "posture", posture: "prone" });
    run(sim, 4);
    const me = s.transform.req(shooter), t = s.transform.req(dead);
    kill(sim, dead);
    t.x = me.x + 0.02; t.y = me.y; t.z = me.z; t.heading = PI;
    const ev = run(sim, 0);
    submitOrder(sim, { tick: s.tick, issuer: "blue", target: uid, kind: "fire", x: 190, y: me.y });
    ev.push(...run(sim, 20));
    const shots = ev.filter((e) => e.kind === "shot.fired" && e.shooter === shooter).length;
    expect(shots).toBeGreaterThan(2);
    expect(ownHits(sim, ev)).toHaveLength(0);
  });

  it("a man bringing a magazine hands it over from where he is: he does not walk on onto the receiver's spot", () => {
    const input = armedInput(1, 120);
    // (The receiver has nothing spare: only the magazine in his rifle.)
    const a0 = input.forces[0]!.units[0]!.members[0]!;
    a0.load = a0.load.map((l) => (l.type === "mag" ? { ...l, count: 1 } : l));
    const sim = createSim(input);
    const s = sim.state;
    const recv = idOf(sim, "a.0"), giver = idOf(sim, "a.1");
    const b = s.transform.req(recv), a = s.transform.req(giver);
    a.x = b.x - 2.2; a.y = b.y + 0.5;
    // His route ends on the receiver's own spot (the spot behind him snapped to that cell, platoon s1).
    const m = s.mover.req(giver);
    m.waypoints = [{ x: b.x, y: b.y, mode: "run" }];
    m.endPosture = "prone";
    s.soldier.req(giver).intent = { kind: "bringAmmo", tick: s.tick, target: recv };
    stepBringAmmo(sim.ctx, s, new EventSink(), giver);
    expect(s.action.get(giver)?.kind).toBe("transferItems");
    expect(m.waypoints).toHaveLength(0);
    run(sim, 4);
    expect(hypot2(a.x - b.x, a.y - b.y)).toBeGreaterThan(1.5);
  });
});
