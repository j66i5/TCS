/**
 * M7.5e step "clear" (D8, D9): during the assault the attacking commander sends its assaulting squads to clear the
 * houses on their way in (an assault order with a building), and a squad that took a house in the main ring holds it.
 */
import { describe, expect, it } from "vitest";
import { COMMANDER, commanderController } from "@tcs/ai";
import { buildScenario } from "@tcs/scenario";
import { hypot2, runBattle, type Order } from "@tcs/sim";
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
