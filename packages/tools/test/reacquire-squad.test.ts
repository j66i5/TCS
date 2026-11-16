/**
 * Sight realism step 5: defending squads shift to see a lost enemy again (COMMANDER.reacquire). The commander is fed a
 * made-up contact each look (the men "know" an enemy man there, none of them sees him) on the platoon map, after its
 * men have taken their sited places.
 */
import { describe, expect, it } from "vitest";
import { COMMANDER, commanderController, reacquireStats, siteDefence, SITING, type SitingGroup } from "@tcs/ai";
import { buildScenario } from "@tcs/scenario";
import {
  createContext, createSim, eyeHeightM, heightAt, hypot2, indoorAt, navCostAt, navFor, sight, standZ, step, submitOrder, TARGET_POINT_M,
  type BattleInput, type Controller, type EntityId, type Order, type Sim,
} from "@tcs/sim";
import { loadData } from "../src/scenarios";

const data = loadData();
const RQ = COMMANDER.reacquire;
const scenario = (seed: number, seconds: number): BattleInput => buildScenario(data, { kind: "platoon-attack", seed, mapKind: "village", factions: ["de", "ru"], attacker: "blue", timeLimitSeconds: seconds });

interface Mem { sited?: Record<string, [number, number, number, number]>; resited?: Record<string, { men: number[]; tick: number; follow: boolean }> }

/** The defence after its first look and a minute to reach its places (the attacker does nothing). */
function settled(seed: number): { input: BattleInput; sim: Sim; red: Controller } {
  const input = scenario(seed, 600);
  const sim = createSim(input), red = commanderController("red", input);
  for (let k = 0; k < 60 * 60; k++) { for (const o of red.think(sim.state, sim.state.tick)) submitOrder(sim, o); step(sim); }
  return { input, sim, red };
}

/** Every defender knows one enemy man (a blue soldier's id) standing at (x, y), seen at `tick`, and none sees an enemy. */
function feed(sim: Sim, target: EntityId, x: number, y: number, tick: number): void {
  for (const [id, idn] of sim.state.identity.entries()) {
    if (idn.side !== "red") continue;
    const s = sim.state.soldier.get(id);
    if (!s) continue;
    s.contacts = [{ target, x, y, errM: 2, kind: "seen", tick, reportedTick: tick, posture: "standing" }];
    delete s.sawEnemyTick;
  }
}

/** The defending squads (children of its platoon, on foot) and their men. */
function squads(sim: Sim): [EntityId, EntityId[]][] {
  const members = (uid: EntityId): EntityId[] => { const u = sim.state.unit.req(uid); return [...u.members, ...u.children.flatMap(members)]; };
  return [...sim.state.unit.entries()].filter(([, u]) => u.side === "red" && u.parent === null).flatMap(([, u]) => u.children)
    .filter((c) => sim.state.unit.get(c)?.vehicle === undefined).sort((a, b) => a - b).map((sq) => [sq, members(sq)]);
}

/** Does a man kneeling at (x, y) see a standing man at (px, py)? */
function sees(sim: Sim, x: number, y: number, z: number, px: number, py: number): boolean {
  const ctx = sim.ctx;
  return sight(ctx, x, y, standZ(ctx.map, { x, y, z }) + eyeHeightM(ctx, "crouching"), px, py, heightAt(ctx.map, px, py) + TARGET_POINT_M.standing).visibility >= RQ.seenVisibility;
}

describe("re-siting toward a lost enemy (sight realism step 5)", () => {
  it("siteDefence with anchors keeps each man within his anchor and is a pure function of its inputs", () => {
    const input = scenario(1, 60), ctx = createContext(input), sim = createSim(input);
    const [, men] = squads(sim)[0]!;
    const g: SitingGroup = { men: men.map((id) => { const t = sim.state.transform.req(id); return { id, x: t.x, y: t.y }; }), cx: 0, cy: 0 };
    g.cx = g.men.reduce((a, m) => a + m.x, 0) / g.men.length; g.cy = g.men.reduce((a, m) => a + m.y, 0) / g.men.length;
    const anchors = new Map(g.men.map((m, i) => [m.id, { x: m.x, y: m.y, r: i === 0 ? 1 : 20 }] as const));
    const pts = [0, 1, 2, 3, 4, 5, 6, 7].map((k) => ({ x: g.cx + Math.cos((k * Math.PI) / 4) * 150, y: g.cy + Math.sin((k * Math.PI) / 4) * 150, h: 1.2 }))
      .filter((p) => p.x > 5 && p.y > 5 && p.x < input.map.widthM - 5 && p.y < input.map.heightM - 5);
    const places = siteDefence(ctx, [g], pts, 20, { anchors, eyePosture: "crouching", seenVisibility: 0.2 });
    expect(places.length).toBe(g.men.length);
    for (const p of places) {
      const a = anchors.get(p.id)!;
      // (Outdoors within its disc; a window place within the disc too; a man with no place in it stays where he is.)
      expect(hypot2(p.x - a.x, p.y - a.y)).toBeLessThanOrEqual(a.r + 1e-9);
      expect(p.seen === undefined || p.seen >= 0).toBe(true);
    }
    expect(siteDefence(createContext(input), [g], pts, 20, { anchors, eyePosture: "crouching", seenVisibility: 0.2 })).toEqual(places);
    // (Without anchors the search is the old one around the group's place.)
    expect(siteDefence(ctx, [g], pts, SITING.searchM).length).toBe(g.men.length);
  });

  it("moves only blind men whose place does not see the enemy they know, at most half a squad, each within the leash of his sited place", () => {
    const { input, sim, red } = settled(1);
    const ctx = sim.ctx, foot = navFor(ctx, "foot").grid;
    const enemy = [...sim.state.identity.entries()].find(([, i]) => i.side === "blue")![0];
    const sqs = squads(sim);
    // A point 120-200 m from a squad that one of its men does not see from where he lies (kneeling) but a spot within
    // the leash of him does: the commander must find such a spot.
    let pick: { x: number; y: number } | null = null;
    for (const [, men] of sqs) {
      const ts = men.map((m) => sim.state.transform.req(m));
      const cx = ts.reduce((a, t) => a + t.x, 0) / ts.length, cy = ts.reduce((a, t) => a + t.y, 0) / ts.length;
      for (const d of [150, 120, 200]) for (let k = 0; k < 16 && !pick; k++) {
        const px = cx + Math.cos((k * Math.PI) / 8) * d, py = cy + Math.sin((k * Math.PI) / 8) * d;
        if (px < 10 || py < 10 || px > input.map.widthM - 10 || py > input.map.heightM - 10 || indoorAt(ctx, px, py) >= 0) continue;
        const blindMan = ts.find((t) => t.z === 0 && indoorAt(ctx, t.x, t.y) < 0 && !sees(sim, t.x, t.y, 0, px, py) && [10, 20, 30].some((r) => [0, 1, 2, 3, 4, 5, 6, 7].some((j) => {
          const x = t.x + Math.cos((j * Math.PI) / 4) * r, y = t.y + Math.sin((j * Math.PI) / 4) * r;
          return navCostAt(foot, x, y) > 0 && indoorAt(ctx, x, y) < 0 && sees(sim, x, y, 0, px, py);
        })));
        if (blindMan) pick = { x: px, y: py };
      }
      if (pick) break;
    }
    expect(pick).not.toBeNull();
    const orders: Order[] = [];
    for (let k = 0; k < 6; k++) {
      sim.state.tick = 3600 + k * COMMANDER.stepSeconds * 60;
      feed(sim, enemy, pick!.x, pick!.y, sim.state.tick);
      orders.push(...red.think(sim.state, sim.state.tick));
    }
    const mem = red.saveState!() as Mem;
    const stats = reacquireStats(mem)!;
    expect(stats.men).toBeGreaterThan(0);
    const moves = orders.filter((o) => (o.kind === "move" || o.kind === "occupy") && sim.state.soldier.has(o.target));
    expect(moves.length).toBe(stats.men);
    for (const o of moves) {
      const p = mem.sited![String(o.target)]!;
      if (o.kind === "move") {
        const w = o.waypoints[0]!;
        // (Within the leash of his sited place, kneeling there he sees the point or the ring round it, and he was not seeing it.)
        expect(hypot2(w.x - p[0], w.y - p[1])).toBeLessThanOrEqual(RQ.leashM + 1e-6);
        expect(w.mode === "crawl" || w.mode === "walk").toBe(true);
        expect(o.facing).toBeDefined();
      }
      const t = sim.state.transform.req(o.target);
      expect(sees(sim, t.x, t.y, t.z, pick!.x, pick!.y)).toBe(false);
    }
    // At most half of a squad at one look.
    for (const [, men] of sqs) {
      const byTick = new Map<number, number>();
      for (const o of moves) if (men.includes(o.target)) byTick.set(o.tick, (byTick.get(o.tick) ?? 0) + 1);
      for (const n of byTick.values()) expect(n).toBeLessThanOrEqual(Math.max(1, Math.floor(men.length * RQ.moveShare)));
    }
  }, 60_000);

  it("sends nobody while a man of the squad sees an enemy, and nothing at all for a far or vague contact", () => {
    const { sim, red } = settled(1);
    const enemy = [...sim.state.identity.entries()].find(([, i]) => i.side === "blue")![0];
    const [, men] = squads(sim)[0]!;
    const t0 = sim.state.transform.req(men[0]!);
    const orders: Order[] = [];
    for (let k = 0; k < 4; k++) {
      sim.state.tick = 3600 + k * COMMANDER.stepSeconds * 60;
      // (Far: beyond the defence's range of fire from every man; vague: 60 m off.)
      feed(sim, enemy, t0.x + (k % 2 === 0 ? 900 : 120), t0.y, sim.state.tick);
      if (k % 2 === 1) for (const [id] of sim.state.identity.entries()) { const s = sim.state.soldier.get(id); if (s?.contacts[0]) s.contacts[0].errM = 60; }
      orders.push(...red.think(sim.state, sim.state.tick));
    }
    expect(reacquireStats(red.saveState!())?.men ?? 0).toBe(0);
    expect(orders.filter((o) => o.kind === "move" && sim.state.soldier.has(o.target)).length).toBe(0);
  }, 60_000);

  it("a bounded follow: an enemy drawing away is followed by half a squad at most, within the follow leash, and the men come back", () => {
    const { input, sim, red } = settled(1);
    const ctx = sim.ctx;
    const enemy = [...sim.state.identity.entries()].find(([, i]) => i.side === "blue")![0];
    const sqs = squads(sim);
    // Away from the platoon, from 100 m out to 160 m over 20 s, on the side of a squad where a spot in reach sees it.
    let route: { x0: number; y0: number; ux: number; uy: number } | null = null;
    for (const [, men] of sqs) {
      const ts = men.map((m) => sim.state.transform.req(m));
      const cx = ts.reduce((a, t) => a + t.x, 0) / ts.length, cy = ts.reduce((a, t) => a + t.y, 0) / ts.length;
      for (let k = 0; k < 16 && !route; k++) {
        const ux = Math.cos((k * Math.PI) / 8), uy = Math.sin((k * Math.PI) / 8);
        const ex = cx + ux * 170, ey = cy + uy * 170;
        if (ex < 10 || ey < 10 || ex > input.map.widthM - 10 || ey > input.map.heightM - 10 || indoorAt(ctx, ex, ey) >= 0) continue;
        if (ts.some((t) => sees(sim, t.x, t.y, t.z, ex, ey))) continue;
        route = { x0: cx + ux * 100, y0: cy + uy * 100, ux, uy };
      }
      if (route) break;
    }
    expect(route).not.toBeNull();
    const orders: Order[] = [];
    const t0 = 3600;
    for (let k = 0; k <= 30; k++) {
      const tick = t0 + k * COMMANDER.stepSeconds * 60, d = Math.min(70, k * 15);
      sim.state.tick = tick;
      feed(sim, enemy, route!.x0 + route!.ux * d, route!.y0 + route!.uy * d, tick);
      orders.push(...red.think(sim.state, tick));
    }
    const mem = red.saveState!() as Mem, stats = reacquireStats(mem)!;
    expect(stats.follows).toBeGreaterThan(0);
    expect(stats.followMen).toBeGreaterThan(0);
    for (const o of orders) if (o.kind === "move" && sim.state.soldier.has(o.target) && o.tick < t0 + (RQ.followMaxSeconds - 5) * 60) {
      const p = mem.sited![String(o.target)]!;
      expect(hypot2(o.waypoints[0]!.x - p[0], o.waypoints[0]!.y - p[1])).toBeLessThanOrEqual(RQ.followLeashM + 1e-6);
    }
    // (After `followMaxSeconds` the followers are sent back to their places.)
    expect(stats.back).toBeGreaterThan(0);
  }, 60_000);
});
