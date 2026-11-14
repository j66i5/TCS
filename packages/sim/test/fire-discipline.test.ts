/**
 * Fire discipline (overnight pick 2026-11-14): a comrade at the shooter's elbow or in a burst's beaten zone holds his
 * fire; two halted men of a side on top of each other move apart; a man raised above his fire position's posture
 * goes back down between shots and rises again in time for the next one.
 */
import { describe, expect, it } from "vitest";
import { createSim, friendInLine, hypot2, secondsToTicks, step, submitOrder, type Sim, type SimEvent } from "../src/index";
import { armedInput } from "./helpers";

const idOf = (sim: Sim, personId: string) => [...sim.state.identity.entries()].find(([, i]) => i.personId === personId)![0];
function run(sim: Sim, seconds: number): SimEvent[] {
  const out: SimEvent[] = [];
  for (let i = 0; i < secondsToTicks(seconds); i++) out.push(...step(sim));
  return out;
}

describe("friend in the line of fire: at his elbow and past the point", () => {
  it("a comrade beside the muzzle counts (the muzzle is 0.4 m out); one well to the side does not", () => {
    const sim = createSim(armedInput());
    const s = sim.state;
    const shooter = idOf(sim, "a.0"), mate = idOf(sim, "a.1");
    const me = s.transform.req(shooter), t = s.transform.req(mate);
    t.x = me.x + 0.2; t.y = me.y + 0.3;
    expect(friendInLine(sim.ctx, s, shooter, me.x + 150, me.y)).toBe(true);
    t.x = me.x - 0.2; t.y = me.y + 0.3; // just behind his shoulder, lying at his elbow
    s.soldier.req(mate).posture = "prone";
    expect(friendInLine(sim.ctx, s, shooter, me.x + 150, me.y)).toBe(true);
    t.x = me.x - 2; t.y = me.y; // well behind him
    expect(friendInLine(sim.ctx, s, shooter, me.x + 150, me.y)).toBe(false);
    t.x = me.x + 1; t.y = me.y + 3; // beside him, out of the cone
    expect(friendInLine(sim.ctx, s, shooter, me.x + 150, me.y)).toBe(false);
  });

  it("past the point he fires at, a comrade counts only within the margin given (a burst's beaten zone)", () => {
    const sim = createSim(armedInput());
    const s = sim.state;
    const shooter = idOf(sim, "a.0"), mate = idOf(sim, "a.1");
    const me = s.transform.req(shooter), t = s.transform.req(mate);
    t.x = me.x + 120; t.y = me.y;
    expect(friendInLine(sim.ctx, s, shooter, me.x + 100, me.y)).toBe(false);
    expect(friendInLine(sim.ctx, s, shooter, me.x + 100, me.y, 40)).toBe(true);
    t.x = me.x + 160;
    expect(friendInLine(sim.ctx, s, shooter, me.x + 100, me.y, 40)).toBe(false);
  });
});

describe("not on top of a comrade", () => {
  it("of two halted men of a side within overlapM, the higher id steps 2-3 m aside; the other stays", () => {
    const input = armedInput();
    const pl = input.forces[0]!.placements;
    pl[0] = { ...pl[0]!, x: 40, y: 100 };
    pl[1] = { ...pl[1]!, x: 40.3, y: 100.1 };
    const sim = createSim(input);
    const a = idOf(sim, "a.0"), b = idOf(sim, "a.1");
    run(sim, 6);
    const ta = sim.state.transform.req(a), tb = sim.state.transform.req(b);
    expect(hypot2(ta.x - 40, ta.y - 100)).toBeLessThan(0.1);
    expect(hypot2(ta.x - tb.x, ta.y - tb.y)).toBeGreaterThan(1.5);
    expect(hypot2(ta.x - tb.x, ta.y - tb.y)).toBeLessThan(4);
  });
});

describe("duck between shots", () => {
  it("a man risen to a kneel to fire over a bank lies down between slow shots and kneels again for each one", () => {
    const input = armedInput();
    const m = input.map;
    // A bank 0.5 m high 6 to 10 m in front of the blue men (x = 10): too high to fire over lying down.
    for (let r = 0; r <= m.rows; r++) for (let c = 0; c <= m.cols; c++) { const x = c * m.cellSizeM; if (x >= 16 && x <= 20) m.heights[r * (m.cols + 1) + c] = 0.5; }
    const sim = createSim(input);
    const [uid, unit] = [...sim.state.unit.entries()].find(([, u]) => u.side === "blue")!;
    unit.ammoRule = "conserve"; // aimed shots ~4.5 s apart
    submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: uid, kind: "posture", posture: "prone" }); // his fire position: lying
    run(sim, 4);
    submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: uid, kind: "fire", x: 150, y: 15 });
    const ev = run(sim, 40);
    const shooter = unit.members[0]!;
    const shots = ev.filter((e): e is Extract<SimEvent, { kind: "shot.fired" }> => e.kind === "shot.fired" && e.shooter === shooter);
    const downs = ev.filter((e) => e.kind === "posture.changed" && e.soldier === shooter && e.posture === "prone");
    expect(shots.length).toBeGreaterThanOrEqual(5);
    expect(downs.length).toBeGreaterThanOrEqual(shots.length - 2);
    // Every shot from a kneel (over the bank): he rose in time, and the bank is not fired into.
    for (const e of shots) expect(e.z - sim.state.transform.req(shooter).z).toBeGreaterThan(0.6);
  });
});
