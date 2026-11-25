/** D4a: the attacker's reserve and its base of fire bounding forward when its own assault masks it. */
import { describe, expect, it } from "vitest";
import { attackStats, commanderController } from "@tcs/ai";
import { buildScenario } from "@tcs/scenario";
import { createSim, step, submitOrder, type BattleInput, type Order, type Sim } from "@tcs/sim";
import { loadData } from "../src/scenarios";

const data = loadData();
const scenario = (seed: number, seconds: number, mapKind: "village" | "farmland" = "village"): BattleInput => buildScenario(data, { kind: "platoon-attack", seed, mapKind, factions: ["de", "ru"], attacker: "blue", timeLimitSeconds: seconds });

interface Mem { phase: string; reserve?: number; maskedRun?: Record<string, number> }

/** The defence gone (one man left, far off, holding fire), as in the commander test: the attack runs its phases. */
function weakDefence(seed: number, seconds: number, mapKind: "village" | "farmland" = "village"): { input: BattleInput; sim: Sim } {
  const input = scenario(seed, seconds, mapKind);
  // (The defence is spent from the start: without this the battle would end as "side-spent" after two minutes.)
  input.rules.victory!.decided = false;
  const sim = createSim(input);
  const reds = [...sim.state.identity.entries()].filter(([, i]) => i.side === "red").map(([id]) => id);
  reds.slice(1).forEach((m) => { const s = sim.state.soldier.req(m); s.physiology.alive = false; s.casualty = "killed"; s.mental.behaviour = "incapacitated"; });
  const last = sim.state.transform.req(reds[0]!); last.x = input.map.widthM - 10; last.y = 10;
  for (const [uid, u] of sim.state.unit.entries()) if (u.side === "red") sim.state.unit.req(uid).fireRule = "hold";
  return { input, sim };
}

/** The attacker's squads (children of its platoon, on foot), by id. */
const squadsOf = (sim: Sim) => [...sim.state.unit.entries()].filter(([, u]) => u.side === "blue" && u.parent === null).flatMap(([, u]) => u.children)
  .filter((c) => sim.state.unit.get(c)?.vehicle === undefined).sort((a, b) => a - b);
/** A unit's men, its sub-units' included. */
const members = (sim: Sim, uid: number): number[] => { const u = sim.state.unit.req(uid); return [...u.members, ...u.children.flatMap((c) => members(sim, c))]; };

/** Where a squad's living men are, on average. */
const centreOf = (sim: Sim, uid: number) => {
  const ts = members(sim, uid).filter((m) => sim.state.soldier.req(m).physiology.alive).map((m) => sim.state.transform.req(m));
  return { x: ts.reduce((a, t) => a + t.x, 0) / ts.length, y: ts.reduce((a, t) => a + t.y, 0) / ts.length };
};

describe("attack (D4a)", () => {
  it("keeps the last assault squad back as a reserve, never sends it in while held, and commits it when the lead squad is cut down", () => {
    const { input, sim } = weakDefence(2, 1500);
    const blue = commanderController("blue", input), red = commanderController("red", input);
    let heldAssaults = 0, reserve = -1, cut = false, committedAt = -1, reserveAssault = -1;
    for (let k = 0; k < 1500 * 60 && !sim.state.ended && reserveAssault < 0; k++) {
      const before = blue.saveState!() as Mem;
      const orders: Order[] = blue.think(sim.state, sim.state.tick);
      const mem = blue.saveState!() as Mem;
      if (mem.reserve !== undefined && mem.reserve >= 0) {
        reserve = mem.reserve;
        // Held: no assault order to it in the same look.
        heldAssaults += orders.filter((o) => o.kind === "assault" && o.target === reserve).length;
        // Once it is held, the lead squad (the other assault squad) loses most of its men.
        if (!cut) {
          cut = true;
          const lead = squadsOf(sim).filter((sq) => sq !== reserve).at(-1)!;
          const men = members(sim, lead);
          men.slice(0, Math.ceil(men.length * 0.6)).forEach((m) => { const s = sim.state.soldier.req(m); s.physiology.alive = false; s.casualty = "killed"; s.mental.behaviour = "incapacitated"; });
        }
      }
      if (before.reserve !== undefined && before.reserve >= 0 && mem.reserve === -1 && committedAt < 0) committedAt = sim.state.tick;
      if (committedAt >= 0 && orders.some((o) => o.kind === "assault" && o.target === reserve)) reserveAssault = sim.state.tick;
      for (const o of orders) submitOrder(sim, o);
      for (const o of red.think(sim.state, sim.state.tick)) submitOrder(sim, o);
      step(sim);
    }
    expect(reserve).toBeGreaterThanOrEqual(0);
    expect(heldAssaults).toBe(0);
    expect(committedAt).toBeGreaterThan(0);
    const st = attackStats(blue.saveState!())!;
    expect(st.reserveKept).toBe(1);
    expect(st.reserveCommitted).toBe(1);
    // Committed, it goes in (closing in first, then its assault drill).
    expect(reserveAssault).toBeGreaterThan(committedAt);
  });

  it("a base-of-fire squad masked by its own men two looks in a row bounds to a spot with clear lines", () => {
    // (Open ground: the base has a line of fire to the objective.)
    const { input, sim } = weakDefence(2, 1500, "farmland");
    const blue = commanderController("blue", input), red = commanderController("red", input);
    let base = -1, masked = false, bounded = -1, fireSameLook = -1;
    let startAt = { x: 0, y: 0 };
    const obj = input.rules.objectives[0]!;
    for (let k = 0; k < 1500 * 60 && !sim.state.ended && bounded < 0; k++) {
      const mem = blue.saveState!() as Mem;
      if (mem.phase === "assault" && base < 0) {
        base = squadsOf(sim)[0]!;
      }
      // While the attack is on: the other squads stand in the base's line to the objective, halfway.
      if (base >= 0 && sim.state.tick % 60 === 0) {
        const bm = members(sim, base).map((m) => sim.state.transform.req(m));
        const cx = bm.reduce((a, t) => a + t.x, 0) / bm.length, cy = bm.reduce((a, t) => a + t.y, 0) / bm.length;
        for (const uid of squadsOf(sim)) {
          if (uid === base) continue;
          const men = members(sim, uid);
          men.forEach((m, i) => {
            const t = sim.state.transform.req(m), f = 0.5 + (i - men.length / 2) * 0.03;
            t.x = cx + (obj.x - cx) * f; t.y = cy + (obj.y - cy) * f;
            const mv = sim.state.mover.get(m);
            if (mv) mv.waypoints = [];
          });
        }
      }
      const orders = blue.think(sim.state, sim.state.tick);
      if (base >= 0 && ((blue.saveState!() as Mem).maskedRun?.[String(base)] ?? 0) >= 1) masked = true;
      if (orders.some((o) => o.kind === "move" && o.target === base) && (blue.saveState!() as Mem).phase === "assault") {
        bounded = sim.state.tick;
        // (Review fix: no fire order to its men in the same look; it would stop them where they are.)
        const men = new Set(members(sim, base));
        fireSameLook = orders.filter((o) => o.kind === "fire" && men.has(o.target)).length;
        startAt = centreOf(sim, base);
      }
      for (const o of orders) submitOrder(sim, o);
      for (const o of red.think(sim.state, sim.state.tick)) submitOrder(sim, o);
      step(sim);
    }
    expect(base).toBeGreaterThanOrEqual(0);
    expect(masked).toBe(true);
    expect(bounded).toBeGreaterThan(0);
    expect(fireSameLook).toBe(0);
    // It really goes: 20 s on, its men are on their way (the squad's centre has moved, nearer the objective).
    for (let k = 0; k < 20 * 60; k++) { for (const o of red.think(sim.state, sim.state.tick)) submitOrder(sim, o); step(sim); }
    const now = centreOf(sim, base), o = input.rules.objectives[0]!;
    expect(Math.hypot(now.x - startAt.x, now.y - startAt.y)).toBeGreaterThan(10);
    expect(Math.hypot(now.x - o.x, now.y - o.y)).toBeLessThan(Math.hypot(startAt.x - o.x, startAt.y - o.y));
    expect(attackStats(blue.saveState!())!.baseBounds).toBeGreaterThanOrEqual(1);
  });
});
