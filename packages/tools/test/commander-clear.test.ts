/**
 * M7.5e step "clear" (D8, D9): during the assault the attacking commander sends its assaulting squads to clear the
 * houses on their way in (an assault order with a building), and a squad that took a house in the main ring holds it.
 */
import { describe, expect, it } from "vitest";
import { COMMANDER, commanderController } from "@tcs/ai";
import { buildScenario } from "@tcs/scenario";
import { clearable, createSim, hypot2, runBattle, windowPlaces, type Order, type SimView } from "@tcs/sim";
import { loadData } from "../src/scenarios";

const data = loadData();

interface Mem { clearing?: Record<string, [number, number]>; taken?: number[]; held?: Record<string, number>; phase: string }

function battle() {
  const input = buildScenario(data, { kind: "platoon-attack", seed: 1, mapKind: "village", factions: ["de", "ru"], attacker: "blue", timeLimitSeconds: 1200 });
  const atk = commanderController("blue", input), def = commanderController("red", input);
  const mems: { tick: number; mem: Mem }[] = [];
  const watched = { ...atk, think: (v: Parameters<typeof atk.think>[0], t: number) => {
    const o = atk.think(v, t);
    if (o.length > 0 || t % 600 === 0) mems.push({ tick: t, mem: JSON.parse(JSON.stringify(atk.saveState!())) as Mem });
    return o;
  } };
  const r = runBattle(input, { controllers: [watched, def] });
  return { input, r, mems };
}

describe("commander: clearing houses on the way in (M7.5e)", () => {
  const { input, r, mems } = battle();
  const clears = r.orders.filter((o): o is Order & { kind: "assault"; building: number } => o.issuer === "blue" && o.kind === "assault" && o.building !== undefined);

  it("sends assaulting squads to clear houses, each a building with an interior near the objective or on the way in", () => {
    expect(clears.length).toBeGreaterThan(0);
    const objs = input.rules.objectives;
    for (const o of clears) {
      const b = input.map.buildings.find((x) => x.id === o.building)!;
      expect(b.interior).toBeDefined();
      const n = b.footprint.length / 2;
      let x = 0, y = 0;
      for (let k = 0; k < n; k++) { x += b.footprint[k * 2]! / n; y += b.footprint[k * 2 + 1]! / n; }
      // (The order's point is the house's middle.)
      expect(hypot2(o.x - x, o.y - y)).toBeLessThan(1);
      // (Near an objective, or on the way to it: never far off.)
      expect(Math.min(...objs.map((ob) => hypot2(ob.x - x, ob.y - y) - ob.radiusM))).toBeLessThan(250);
    }
    // (One squad per house at a time.)
    for (const m of mems) {
      const hs = Object.values(m.mem.clearing ?? {}).map((v) => v[0]);
      expect(new Set(hs).size).toBe(hs.length);
    }
  });

  it("a squad holding a house in the main ring is not sent on while another squad can assault", () => {
    const heldFrom = new Map<number, number>();
    for (const m of mems) for (const k of Object.keys(m.mem.held ?? {})) if (!heldFrom.has(Number(k))) heldFrom.set(Number(k), m.tick);
    for (const [sq, t] of heldFrom) {
      const later = r.orders.filter((o) => o.issuer === "blue" && o.target === sq && o.kind === "assault" && o.tick > t + COMMANDER.stepSeconds * 60);
      // (Only if it stopped holding: the only squad left, or it left the house.)
      for (const o of later) expect(mems.some((m) => m.tick < o.tick && m.tick > t && m.mem.held?.[String(sq)] === undefined)).toBe(true);
    }
  });

  it("its memory is plain data and the battle replays the same", () => {
    for (const m of mems) expect(JSON.parse(JSON.stringify(m.mem))).toEqual(m.mem);
    const again = battle();
    expect(again.r.orders.length).toBe(r.orders.length);
    expect(JSON.stringify(again.r.orders.slice(-50))).toBe(JSON.stringify(r.orders.slice(-50)));
  });
});

/**
 * Slice s0-clear (owner answer 2026-11-14): on its approach (advancing to the support line) a squad first clears a
 * house with a known, well-placed enemy on its way, not only in the assault.
 */
describe("commander: clearing a house on the approach (s0-clear)", () => {
  /** The advance just begun, with an enemy put at a window of a house on a squad's way and known to its men. */
  function setup(seed: number) {
    const input = buildScenario(data, { kind: "platoon-attack", seed, mapKind: "village", factions: ["de", "ru"], attacker: "blue", timeLimitSeconds: 1200 });
    const sim = createSim(input);
    const atk = commanderController("blue", input);
    atk.think(sim.state as unknown as SimView, 0);
    const mem = atk.saveState!() as { phase: string; places?: Record<string, [number, number]> };
    const tgt = input.rules.objectives[0]!;
    const squads = [...sim.state.unit.entries()].filter(([, u]) => u.side === "blue" && u.parent !== null && u.vehicle === undefined).map(([id]) => id);
    const enemy = [...sim.state.identity.entries()].find(([, i]) => i.side === "red")![0];
    const cases: { sq: number; bid: number; spot: { x: number; y: number } }[] = [];
    for (const sq of squads) {
      const ms = sim.state.unit.get(sq)!.members.map((m) => sim.state.transform.get(m)!);
      const c = { x: ms.reduce((a, b) => a + b.x, 0) / ms.length, y: ms.reduce((a, b) => a + b.y, 0) / ms.length };
      const p = mem.places?.[String(sq)];
      if (!p) continue;
      const dl = hypot2(p[0] - c.x, p[1] - c.y), vx = (p[0] - c.x) / dl, vy = (p[1] - c.y) / dl;
      input.map.buildings.forEach((b, bi) => {
        if (!b.interior || !clearable(sim.ctx, b.id)) return;
        const n = b.footprint.length / 2;
        let x = 0, y = 0;
        for (let k = 0; k < n; k++) { x += b.footprint[2 * k]! / n; y += b.footprint[2 * k + 1]! / n; }
        const along = (x - c.x) * vx + (y - c.y) * vy, across = Math.abs(-(x - c.x) * vy + (y - c.y) * vx);
        if (hypot2(x - c.x, y - c.y) > COMMANDER.clear.approachM - 10 || along < 0 || along > dl || across > COMMANDER.clear.approachCorridorM - 10) return;
        if (hypot2(x - tgt.x, y - tgt.y) <= tgt.radiusM + COMMANDER.clear.ringSlackM) return;
        // (A ground-floor window facing the squad.)
        const w = windowPlaces(sim.ctx, bi).find((q) => q.floor === 0 && q.normalX * (c.x - q.x) + q.normalY * (c.y - q.y) > 0);
        if (w) cases.push({ sq, bid: b.id, spot: { x: w.x, y: w.y } });
      });
    }
    return { input, sim, atk, mem, enemy, cases };
  }

  it("sends the squad to clear a house on its way with an enemy known at a window, and none without", () => {
    let found = 0;
    for (const seed of [1, 2, 3, 4, 5]) {
      const probe = setup(seed);
      for (const cs of probe.cases.slice(0, 15)) {
        if (found >= 2) break;
        for (const withEnemy of [true, false]) {
          const { sim, atk, mem, enemy } = setup(seed);
          expect(mem.phase).toBe("advance");
          const t = sim.state.transform.get(enemy)!;
          t.x = cs.spot.x; t.y = cs.spot.y; t.z = 0; // (ground floor: his height above the ground)
          const tick = COMMANDER.stepSeconds * 60;
          if (withEnemy) for (const m of sim.state.unit.get(cs.sq)!.members) {
            sim.state.soldier.get(m)!.contacts.push({ target: enemy, x: cs.spot.x, y: cs.spot.y, errM: 1, kind: "seen", tick, reportedTick: tick });
          }
          const out = atk.think(sim.state as unknown as SimView, tick);
          const clear = out.find((o) => o.kind === "assault" && o.building !== undefined);
          if (!withEnemy) { expect(clear).toBeUndefined(); continue; }
          if (!clear || clear.kind !== "assault") continue; // (no sight line from that window: not well placed)
          // (The squad it lies before, or another squad whose way it is on: what one man knows, all know.)
          expect(sim.state.unit.get(clear.target)?.side).toBe("blue");
          expect(clear.building).toBe(cs.bid);
          const after = atk.saveState!() as { clearing?: Record<string, [number, number]> };
          expect(after.clearing).toEqual({ [String(clear.target)]: [cs.bid, tick] });
          // (Not sent on toward its place in the same look: the clearing comes first; one such clearing at a time.)
          expect(out.some((o) => o.target === clear.target && o.kind === "move")).toBe(false);
          expect(out.filter((o) => o.kind === "assault").length).toBe(1);
          found++;
        }
      }
      if (found >= 2) break;
    }
    expect(found).toBeGreaterThanOrEqual(1);
  });
});
