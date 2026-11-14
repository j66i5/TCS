/**
 * Defence fall-back (overnight AI pick "defence-fallback", 2026-11-14): a defending squad below half strength falls
 * back only under a close threat, to a covered rally point of its own behind its own position, then holds there.
 */
import { describe, expect, it } from "vitest";
import { COMMANDER, commanderController, seenShare } from "@tcs/ai";
import { buildScenario } from "@tcs/scenario";
import { createSim, exposureAt, hypot2, indoorAt, navFor, type BattleInput, type EntityId, type Order, type SimState } from "@tcs/sim";
import { loadData } from "../src/scenarios";

const data = loadData();
const scenario = (seed: number): BattleInput => buildScenario(data, { kind: "platoon-attack", seed, mapKind: "village", factions: ["de", "ru"], attacker: "blue", timeLimitSeconds: 600 });

/** All the men of a unit and its sub-units. */
function menOf(st: SimState, uid: EntityId): EntityId[] {
  const u = st.unit.req(uid);
  return [...u.members, ...u.children.flatMap((c) => menOf(st, c))];
}

describe("defence fall-back", () => {
  const input = scenario(1);
  const sim = createSim(input), st = sim.state, ctx = sim.ctx;
  const main = input.rules.objectives[0]!, def = main.holder!;
  const ctrl = commanderController(def, input);
  const step = COMMANDER.stepSeconds * 60;
  ctrl.think(st, 0);
  // The defending squad nearest the main objective, four of its six men out.
  const top = [...st.unit.entries()].find(([, u]) => u.side === def && u.parent === null)![1];
  const centre = (ms: EntityId[]) => ({ x: ms.reduce((a, m) => a + st.transform.req(m).x, 0) / ms.length, y: ms.reduce((a, m) => a + st.transform.req(m).y, 0) / ms.length });
  const sq = [...top.children].sort((a, b) => { const ca = centre(menOf(st, a)), cb = centre(menOf(st, b)); return hypot2(ca.x - main.x, ca.y - main.y) - hypot2(cb.x - main.x, cb.y - main.y) || a - b; })[0]!;
  const men = menOf(st, sq).sort((a, b) => a - b);
  for (const m of men.slice(0, Math.ceil(men.length / 2) + 1)) st.soldier.req(m).casualty = "incapacitated";
  const alive = men.filter((m) => st.soldier.req(m).casualty === "none");
  const c = centre(alive);
  const enemy = [...st.identity.entries()].find(([, idn]) => idn.side !== def)![0];
  // The enemy is expected from the middle of the far map edge.
  const ex = main.x < input.map.widthM / 2 ? input.map.widthM : 0;
  const away = Math.atan2(c.y - input.map.heightM / 2, c.x - ex);
  const seeAt = (d: number, tick: number) => {
    const s = st.soldier.req(alive[0]!);
    s.contacts = [{ target: enemy, x: c.x - Math.cos(away) * d, y: c.y - Math.sin(away) * d, errM: 5, kind: "seen", tick, reportedTick: tick }];
  };
  const withdrawOf = (os: Order[]) => os.find((o) => o.kind === "withdraw" && o.target === sq);

  it("holds while the nearest enemy it knows is far off", () => {
    seeAt(300, step);
    expect(withdrawOf(ctrl.think(st, step))).toBeUndefined();
  });

  let rally: { x: number; y: number } | null = null;
  it("falls back once an enemy is known close: to covered ground behind it, away from the enemy, seeing its objective", () => {
    seeAt(120, 2 * step);
    const o = withdrawOf(ctrl.think(st, 2 * step));
    expect(o).toBeDefined();
    if (o?.kind !== "withdraw") return;
    rally = { x: o.x, y: o.y };
    const d = hypot2(o.x - c.x, o.y - c.y);
    expect(d).toBeGreaterThanOrEqual(COMMANDER.fallback.rallyMinM);
    expect(d).toBeLessThanOrEqual(Math.max(...COMMANDER.fallback.rallyM) + COMMANDER.fallback.rallyCoverM);
    let off = Math.abs(Math.atan2(o.y - c.y, o.x - c.x) - away);
    if (off > Math.PI) off = 2 * Math.PI - off;
    expect((off * 180) / Math.PI).toBeLessThanOrEqual(COMMANDER.fallback.rallyMaxDeg + 1e-6);
    expect(indoorAt(ctx, o.x, o.y)).toBe(-1);
    expect(exposureAt(navFor(ctx, "foot").grid, o.x, o.y)).toBeLessThan(COMMANDER.fallback.openExposure);
    expect(seenShare(ctx, o.x, o.y, [{ x: main.x, y: main.y }])).toBeGreaterThanOrEqual(0);
    // Only once.
    expect(withdrawOf(ctrl.think(st, 3 * step))).toBeUndefined();
  });

  it("at the rally point, each man takes a fire position of his own nearby, facing the enemy's way", () => {
    expect(rally).not.toBeNull();
    // (The drill never ran here: the commander counts it done after `drillStartSeconds`; the men are put at the
    // rally point as the drill's last leg would leave them.)
    alive.forEach((m, i) => { const tr = st.transform.req(m); tr.x = rally!.x + 4 * Math.cos(i * 2); tr.y = rally!.y + 4 * Math.sin(i * 2); });
    const t = 2 * step + Math.ceil((COMMANDER.fallback.drillStartSeconds * 60) / step) * step + step;
    const os = ctrl.think(st, t).filter((o) => alive.includes(o.target as EntityId));
    expect(os.length).toBe(alive.length);
    for (const o of os) {
      if (o.kind !== "move") { expect(o.kind).toBe("posture"); continue; }
      const p = o.waypoints[0]!;
      expect(hypot2(p.x - rally!.x, p.y - rally!.y)).toBeLessThanOrEqual(COMMANDER.fallback.rallySiteM + 5);
      expect(o.facing).toBeDefined();
    }
  });

  it("keeps its memory as plain data", () => {
    const mem = ctrl.saveState!() as { rally?: Record<string, number[]>; rallied?: number[] };
    expect(JSON.parse(JSON.stringify(mem))).toEqual(mem);
    expect(mem.rallied).toContain(sq);
  });
});
