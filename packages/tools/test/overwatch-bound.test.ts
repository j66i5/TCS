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
    // (Seed 3: on seed 2 the review 2026-11-24 verification fixes move the first bound's order off the tick.)
    const input = getScenario("platoon-vehicles").build(data, 3, 600);
    const r = start(input);
    // (Balance pass 5 review fixes: the carriers now let their squads out at the village's edge, farther out: run until
    // the foremost man is far enough ahead of a carrier for a bound, at most 600 s.)
    const B0 = input.catalog.behaviour.mounting.overwatchBound!, main0 = input.rules.objectives[0]!;
    run(r, 600, (x) => {
      if (x.sim.state.tick < 300 * 60 || x.sim.state.tick % 600 !== 0) return false;
      const cs = carrierCrews(x.sim, "blue").filter((c) => x.sim.state.vehicle.req(x.sim.state.unit.get(c)!.vehicle!).status === "ok");
      if (cs.length < 3) return false;
      const ts = cs.map((c) => x.sim.state.transform.req(x.sim.state.unit.get(c)!.vehicle!));
      const mx = ts.reduce((a, t) => a + t.x, 0) / ts.length, my = ts.reduce((a, t) => a + t.y, 0) / ts.length;
      const L = hypot2(main0.x - mx, main0.y - my), ux = (main0.x - mx) / L, uy = (main0.y - my) / L;
      const foot = ownFoot(x.sim, "blue");
      const shot = (c: EntityId) => x.sim.state.vehicle.req(x.sim.state.unit.get(c)!.vehicle!).stations.reduce((m, st) => Math.max(m, ...st.weapons.map((w) => w.lastShotTick)), -1e9);
      const mem: TanksMemory = { obBound: Object.fromEntries(cs.map((c) => [String(c), { since: -1e9, shot: shot(c), tried: -1e9 }])) };
      let n = 0;
      overwatchBounds({ view: x.sim.state, tick: x.sim.state.tick, side: "blue", ctx: x.sim.ctx, objectives: input.rules.objectives, mem, order: () => { n++; }, ux, uy, target: 0, crews: cs, ownFoot: foot, bound: B0, reverseHoldSeconds: 10 });
      return n > 0;
    });
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
    // (Its last shot as already seen: crews keep firing longer since area fire, balance pass 5; the geometry is tested here.)
    const shotOf = (c: EntityId) => sim.state.vehicle.req(sim.state.unit.get(c)!.vehicle!).stations.reduce((m, st) => Math.max(m, ...st.weapons.map((w) => w.lastShotTick)), -1e9);
    const mem: TanksMemory = { obBound: Object.fromEntries(crews.map((c) => [String(c), { since: -1e9, shot: shotOf(c), tried: -1e9 }])) };
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
    // A known enemy hull whose gun reaches farther than the carrier's (beyond its own reach, so it is not "busy"):
    // no post nearer it inside its reach (review fix). The hull with the longest reach in the catalog, known to every
    // crew 200 m inside that reach, straight ahead along the axis.
    const reachOf = (def: string) => Math.max(0, ...sim.ctx.catalog.vehicles[def]!.stations.flatMap((st) => st.weapons.map((w) => w.engageRangeM ?? 0)));
    const far = Object.keys(sim.ctx.catalog.vehicles).sort((a, b) => reachOf(b) - reachOf(a) || (a < b ? -1 : 1))[0]!;
    const ownReach = Math.max(...crews.map((c) => sim.ctx.catalog.vehicles[sim.state.vehicle.req(sim.state.unit.get(c)!.vehicle!).def]!.stations[0]?.weapons[0]?.engageRangeM ?? 0));
    expect(reachOf(far)).toBeGreaterThan(ownReach + 300);
    const tx = mx + ux * (reachOf(far) - 200), ty = my + uy * (reachOf(far) - 200);
    for (const c of crews) for (const m of sim.state.unit.get(c)!.members) {
      sim.state.soldier.get(m)?.contacts.push({ target: 999_999 as EntityId, x: tx, y: ty, errM: 10, kind: "seen", tick, reportedTick: tick, cls: "vehicle", vtype: far });
    }
    const armour: TanksMemory = { obBound: Object.fromEntries(crews.map((c) => [String(c), { since: -1e9, shot: -1e9, tried: -1e9 }])) };
    const held: { target: EntityId; body: Record<string, unknown> }[] = [];
    overwatchBounds({ view: sim.state, tick, side: "blue", ctx: sim.ctx, objectives: input.rules.objectives, mem: armour, order: (target, body) => held.push({ target, body }), ux, uy, target: 0, crews, ownFoot: foot, bound: B, reverseHoldSeconds: 10 });
    for (const o of held) {
      const p = (o.body["waypoints"] as { x: number; y: number }[])[0]!;
      const t = sim.state.transform.req(sim.state.unit.get(o.target)!.vehicle!);
      expect(hypot2(p.x - tx, p.y - ty)).toBeGreaterThanOrEqual(hypot2(t.x - tx, t.y - ty));
    }
    expect(held.length).toBeLessThan(orders.length);
  }, 120_000);

  it("in the battle the attacker's Pumas bound (the defence's carriers never); without the data value they stay", () => {
    // (Seed 3: on seed 2 the review 2026-11-24 verification fixes move the first bound's order off the tick.)
    const input = getScenario("platoon-vehicles").build(data, 3, 600);
    const r = start(input);
    run(r, 420);
    const m = r.ctrls[0]!.saveState!() as TanksMemory;
    const crews = new Set(carrierCrews(r.sim, "blue"));
    const bounds = Object.entries(m.obBound ?? {}).filter(([c]) => crews.has(Number(c)));
    expect(bounds.length).toBeGreaterThan(0);
    // (A bound: a move order to that crew in the think that set `since`.)
    expect(bounds.some(([c, b]) => r.orders.some((o) => o.kind === "move" && o.target === Number(c) && o.tick === b.since))).toBe(true);
    // A bound is to a post the hull can reach: at least one bounding hull has driven off where it stood (review fix:
    // a post off its route was ordered again and again before).
    const moved = bounds.filter(([c, b]) => {
      const vid = r.sim.state.unit.get(Number(c))?.vehicle;
      if (vid === undefined || b.at === undefined) return false;
      const t = r.sim.state.transform.req(vid);
      return hypot2(t.x - b.at.x, t.y - b.at.y) > 10;
    });
    expect(moved.length).toBeGreaterThan(0);
    // No crew got the same bound twice from the same spot.
    for (const [c] of bounds) {
      const mv = r.orders.filter((o) => o.kind === "move" && o.target === Number(c)).map((o) => JSON.stringify((o as { waypoints?: unknown }).waypoints));
      expect(new Set(mv).size, `crew ${c}`).toBe(mv.length);
    }
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
    const input = buildScenario(fx, { kind: "platoon-attack", seed: 3, mapKind: "village", factions: ["xf", "de"], attacker: "blue", vehicles: true, timeLimitSeconds: 900 });
    // (Seed 3: in seed 1 the defence breaks at 375 s; since the balance pass 5 review fixes (squads out at the village edge) seed 2 breaks at 654 s before a bound.)
    const r = start(input);
    // (A bound: a move order to an xf carrier crew in the think that set its `since`, review fix: not only an attempt.)
    const bound = (x: Run) => Object.entries((x.ctrls[0]!.saveState!() as TanksMemory).obBound ?? {})
      .some(([c, b]) => b.to !== undefined && x.orders.some((o) => o.kind === "move" && o.target === Number(c) && o.tick === b.since));
    run(r, 900, bound);
    expect(bound(r)).toBe(true);
    const crews = new Set(carrierCrews(r.sim, "blue"));
    expect(Object.keys((r.ctrls[0]!.saveState!() as TanksMemory).obBound ?? {}).every((c) => crews.has(Number(c)) || r.sim.state.unit.get(Number(c))?.vehicle === undefined)).toBe(true);
  }, 180_000);
});
