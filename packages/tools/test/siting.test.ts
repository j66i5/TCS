/** Defence siting (overnight AI pick "defence-siting", 2026-11-14): the defenders pick their own fire positions. */
import { describe, expect, it } from "vitest";
import { approachPoints, commanderController, SITING, siteDefence, type SitingGroup } from "@tcs/ai";
import { buildScenario } from "@tcs/scenario";
import { createContext, createSim, exposureAt, eyeHeightM, heightAt, hypot2, isAble, navFor, runBattle, sight, type BattleInput, type SimContext } from "@tcs/sim";
import { loadData } from "../src/scenarios";

const data = loadData();
const scenario = (seed: number, seconds: number): BattleInput => buildScenario(data, { kind: "platoon-attack", seed, mapKind: "village", factions: ["de", "ru"], attacker: "blue", timeLimitSeconds: seconds });

/** Share of the approach a man lying at (x, y) sees, as the siting counts it. */
function share(ctx: SimContext, pts: { x: number; y: number }[], x: number, y: number): number {
  const z0 = heightAt(ctx.map, x, y) + eyeHeightM(ctx, "prone"), tz = ctx.catalog.body.postures.crouching.heightM * 0.8;
  return pts.filter((p) => sight(ctx, x, y, z0, p.x, p.y, heightAt(ctx.map, p.x, p.y) + tz).visibility >= SITING.seenVisibility).length / pts.length;
}

describe("defence siting", () => {
  const input = scenario(1, 60);
  const sim = createSim(input), ctx = sim.ctx, st = sim.state;
  const main = input.rules.objectives[0]!, def = main.holder!;
  // The defenders' groups as the scenario places them (each unit's own men), each with its objective's ring.
  const groups: SitingGroup[] = [...st.unit.entries()].filter(([, u]) => u.side === def && u.members.length > 0).map(([, u]) => {
    const men = [...u.members].sort((a, b) => a - b).map((id) => { const t = st.transform.req(id); return { id, x: t.x, y: t.y }; });
    const cx = men.reduce((a, m) => a + m.x, 0) / men.length, cy = men.reduce((a, m) => a + m.y, 0) / men.length;
    const o = input.rules.objectives.find((ob) => hypot2(ob.x - cx, ob.y - cy) <= ob.radiusM + 15);
    return { men, cx, cy, ...(o ? { ring: { x: o.x, y: o.y, r: o.radiusM } } : {}) };
  });
  const start = groups.flatMap((g) => g.men);
  const pts = approachPoints(ctx, main.x, main.y, Math.atan2(input.map.heightM / 2 - main.y, (input.map.widthM - main.x > main.x ? input.map.widthM : 0) - main.x));
  const places = siteDefence(ctx, groups, pts);

  it("gives every man a place, keeps them apart and inside their objective's ring", () => {
    expect(places.length).toBe(start.length);
    for (const p of places) for (const q of places) if (p !== q) expect(hypot2(p.x - q.x, p.y - q.y)).toBeGreaterThanOrEqual(SITING.hardSpacingM - 1e-9);
    for (const g of groups) if (g.ring) for (const m of g.men) {
      const p = places.find((q) => q.id === m.id)!;
      expect(hypot2(p.x - g.ring.x, p.y - g.ring.y)).toBeLessThanOrEqual(g.ring.r + 1e-9);
    }
  });

  it("sees more of the approach from better cover than the scenario's start places", () => {
    const before = start.reduce((a, p) => a + share(ctx, pts, p.x, p.y), 0) / start.length;
    const after = places.reduce((a, p) => a + share(ctx, pts, p.x, p.y), 0) / places.length;
    expect(after).toBeGreaterThan(before * 1.3);
    const foot = navFor(ctx, "foot").grid;
    const open = (xs: { x: number; y: number }[]) => xs.filter((p) => exposureAt(foot, p.x, p.y) >= 0.9).length;
    expect(open(places)).toBeLessThanOrEqual(Math.min(2, open(start)));
  });

  it("is a pure function of the ground and the men", () => {
    expect(siteDefence(createContext(input), groups, pts)).toEqual(places);
  });

  it("in a battle, the defending commander sends its men there at once; they lie down apart", () => {
    const r = runBattle(input, { controllers: [commanderController("blue", input), commanderController("red", input)], onTick: (sim) => {
      if (sim.state.tick !== 60 * 59) return;
      const men = [...sim.state.soldier.entries()].filter(([id, s]) => sim.state.identity.get(id)?.side === def && isAble(s)).map(([id, s]) => ({ s, t: sim.state.transform.req(id) }));
      expect(men.filter((m) => m.s.posture === "prone").length).toBeGreaterThanOrEqual(men.length - 2);
      for (const a of men) for (const b of men) if (a !== b) expect(hypot2(a.t.x - b.t.x, a.t.y - b.t.y)).toBeGreaterThan(2);
    } });
    const moves = r.orders.filter((o) => o.issuer === def && o.tick === 0 && o.kind === "move");
    expect(moves.length).toBeGreaterThan(start.length / 2);
    expect(moves.every((o) => o.kind === "move" && o.facing !== undefined && o.waypoints.length === 1)).toBe(true);
  });
});
