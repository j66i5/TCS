/**
 * Balance pass 3 (owner 2026-11-18, "idle overwatch Pumas move up"): an attacking side's carriers in overwatch after
 * the dismount that have fired nothing for `mounting.overwatchBound.idleS` bound forward to a hull-down post, staying
 * `behindM` behind the side's foremost man on foot and off known anti-tank threats (ai/tanks.ts `overwatchBounds`).
 */
import { describe, expect, it } from "vitest";
import { commanderController, knownEnemyMen, overwatchBounds, TANKS, type TanksMemory } from "@tcs/ai";
import { buildScenario } from "@tcs/scenario";
import { createSim, hypot2, step, submitOrder, type BattleInput, type Controller, type EntityId, type Order, type Sim } from "@tcs/sim";
import { getScenario, loadData } from "../src/scenarios";

const data = loadData();

interface Run { sim: Sim; ctrls: Controller[]; orders: Order[] }
function start(input: BattleInput): Run {
  return { sim: createSim(input), ctrls: [commanderController("blue", input), commanderController("red", input)], orders: [] };
}
function run(r: Run, seconds: number, until: (r: Run) => boolean = () => false): void {
  const end = r.sim.state.tick + seconds * 60;
  while (r.sim.state.tick < end && !r.sim.state.ended) {
    for (const c of r.ctrls) for (const o of c.think(r.sim.state, r.sim.state.tick)) { r.orders.push(o); submitOrder(r.sim, o); }
    step(r.sim);
    if (until(r)) return;
  }
}
/** The side's carrier crews (crews of hulls with passenger seats, on the map). */
function carrierCrews(sim: Sim, side: string): EntityId[] {
  return [...sim.state.unit.entries()].filter(([, u]) => {
    if (u.side !== side || u.vehicle === undefined) return false;
    const v = sim.state.vehicle.get(u.vehicle);
    return v !== undefined && v.offMap === undefined && sim.ctx.catalog.vehicles[v.def]!.seats.some((s) => s.station === "passenger");
  }).map(([id]) => id).sort((a, b) => a - b);
}
/** Own able men on foot. */
function ownFoot(sim: Sim, side: string): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  for (const [id, i] of sim.state.identity.entries()) {
    if (i.side !== side) continue;
    const s = sim.state.soldier.get(id);
    if (!s || s.mount !== undefined || !s.physiology.alive || !s.impair.canWalk) continue;
    out.push(sim.state.transform.req(id));
  }
  return out;
}

describe("overwatch carriers bound forward (balance pass 3)", () => {
  it("platoon-vehicles seed 2: idle Pumas get posts ahead of where they stand, behind the foremost man by behindM, off known enemy men", () => {
    const input = getScenario("platoon-vehicles").build(data, 2, 600);
    const r = start(input);
    run(r, 300);
    const B = input.catalog.behaviour.mounting.overwatchBound!;
    expect(B).toBeDefined();
    const sim = r.sim, tick = sim.state.tick;
    const main = input.rules.objectives[0]!;
    // The axis: from the attacker's carriers' middle toward the main objective.
    const crews = carrierCrews(sim, "blue").filter((c) => sim.state.vehicle.req(sim.state.unit.get(c)!.vehicle!).status === "ok");
    expect(crews.length).toBeGreaterThan(2);
    const ts = crews.map((c) => sim.state.transform.req(sim.state.unit.get(c)!.vehicle!));
    const mx = ts.reduce((a, t) => a + t.x, 0) / ts.length, my = ts.reduce((a, t) => a + t.y, 0) / ts.length;
    const L = hypot2(main.x - mx, main.y - my), ux = (main.x - mx) / L, uy = (main.y - my) / L;
    const foot = ownFoot(sim, "blue");
    const front = foot.reduce((m, f) => Math.max(m, f.x * ux + f.y * uy), -Infinity);
    // Every crew idle since long ago.
    const mem: TanksMemory = { obBound: Object.fromEntries(crews.map((c) => [String(c), { since: -1e9, shot: -1e9, tried: -1e9 }])) };
    const orders: { target: EntityId; body: Record<string, unknown> }[] = [];
    overwatchBounds({ view: sim.state, tick, side: "blue", ctx: sim.ctx, objectives: input.rules.objectives, mem, order: (target, body) => orders.push({ target, body }), ux, uy, target: 0, crews, ownFoot: foot, bound: B, reverseHoldSeconds: 10 });
    expect(orders.length).toBeGreaterThan(0);
    const enemies = knownEnemyMen(sim.state, "blue").filter((e) => tick - e.tick <= TANKS.menSeenSeconds * 60);
    for (const o of orders) {
      expect(o.body["kind"]).toBe("move");
      const p = (o.body["waypoints"] as { x: number; y: number }[])[0]!;
      const t = sim.state.transform.req(sim.state.unit.get(o.target)!.vehicle!);
      const proj = p.x * ux + p.y * uy;
      expect(proj).toBeGreaterThanOrEqual(t.x * ux + t.y * uy + B.minGainM - 1e-6);
      expect(proj).toBeLessThanOrEqual(front - B.behindM + 1e-6);
      for (const e of enemies) expect(hypot2(e.x - p.x, e.y - p.y)).toBeGreaterThanOrEqual(TANKS.coverStandoffM);
      // The crew is not idle any more: it waits idleS again before the next bound.
      expect(mem.obBound![String(o.target)]!.since).toBe(tick);
    }
    // No two of them go to the same spot.
    const spots = orders.map((o) => (o.body["waypoints"] as { x: number; y: number }[])[0]!);
    for (let i = 0; i < spots.length; i++) for (let j = i + 1; j < spots.length; j++) expect(hypot2(spots[i]!.x - spots[j]!.x, spots[i]!.y - spots[j]!.y)).toBeGreaterThan(1);
    // A crew that fired lately is left where it is.
    const busy: TanksMemory = { obBound: Object.fromEntries(crews.map((c) => [String(c), { since: tick - (B.idleS - 5) * 60, shot: -1e9, tried: -1e9 }])) };
    const none: unknown[] = [];
    overwatchBounds({ view: sim.state, tick, side: "blue", ctx: sim.ctx, objectives: input.rules.objectives, mem: busy, order: (target, body) => none.push({ target, body }), ux, uy, target: 0, crews, ownFoot: foot, bound: B, reverseHoldSeconds: 10 });
    expect(none).toEqual([]);
  }, 120_000);

  it("in the battle the attacker's Pumas bound (the defence's carriers never); without the data value they stay", () => {
    const input = getScenario("platoon-vehicles").build(data, 2, 600);
    const r = start(input);
    run(r, 420);
    const m = r.ctrls[0]!.saveState!() as TanksMemory;
    const crews = new Set(carrierCrews(r.sim, "blue"));
    const bounds = Object.entries(m.obBound ?? {}).filter(([c]) => crews.has(Number(c)));
    expect(bounds.length).toBeGreaterThan(0);
    // (A bound: a move order to that crew in the think that set `since`.)
    expect(bounds.some(([c, b]) => r.orders.some((o) => o.kind === "move" && o.target === Number(c) && o.tick === b.since))).toBe(true);
    expect((r.ctrls[1]!.saveState!() as TanksMemory).obBound).toBeUndefined();
    // Without `mounting.overwatchBound`: no bound memory, the battle as before balance pass 3.
    const off = getScenario("platoon-vehicles").build(data, 2, 600);
    const { overwatchBound: _b, ...mounting } = off.catalog.behaviour.mounting;
    void _b;
    off.catalog = { ...off.catalog, behaviour: { ...off.catalog.behaviour, mounting } };
    const r2 = start(off);
    run(r2, 420);
    expect((r2.ctrls[0]!.saveState!() as TanksMemory).obBound).toBeUndefined();
  }, 120_000);

  it("the fixture faction (rule 8): its carriers in overwatch bound too, with no fixture ids in code", () => {
    const fx = loadData(true);
    const input = buildScenario(fx, { kind: "platoon-attack", seed: 1, mapKind: "village", factions: ["xf", "de"], attacker: "blue", vehicles: true, timeLimitSeconds: 600 });
    const r = start(input);
    run(r, 600, (x) => Object.values((x.ctrls[0]!.saveState!() as TanksMemory).obBound ?? {}).some((b) => b.tried > 0));
    const m = r.ctrls[0]!.saveState!() as TanksMemory;
    expect(Object.values(m.obBound ?? {}).some((b) => b.tried > 0)).toBe(true);
  }, 120_000);
});
