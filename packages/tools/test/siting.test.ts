/** Defence siting (overnight AI pick "defence-siting", 2026-11-14): the defenders pick their own fire positions. */
import { describe, expect, it } from "vitest";
import { approachPoints, commanderController, SITING, siteDefence, type SitingGroup, type SitingPlace } from "@tcs/ai";
import { buildScenario } from "@tcs/scenario";
import { buildingIndex, createContext, createSim, exposureAt, eyeHeightM, heightAt, hypot2, indoorAt, isAble, navFor, pointInPolygon, roomAt, runBattle, sight, standZ, stripInteriors, windowPlaces, type BattleInput, type SimContext } from "@tcs/sim";
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
  const win = (p: SitingPlace) => windowPlaces(ctx, buildingIndex(ctx, p.building!))[p.windowIndex!]!;
  const windowZ = (p: SitingPlace) => win(p).z;
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
    // (Men outdoors apart from each other; window places, M7.5e, apart from others on their floor of that house.)
    const lvl = (p: SitingPlace) => (p.building === undefined ? "out" : `${p.building}:${windowZ(p)}`);
    for (const p of places) for (const q of places) if (p !== q && lvl(p) === lvl(q)) expect(hypot2(p.x - q.x, p.y - q.y)).toBeGreaterThanOrEqual(SITING.hardSpacingM - 1e-9);
    for (const g of groups) if (g.ring) for (const m of g.men) {
      const p = places.find((q) => q.id === m.id)!;
      expect(hypot2(p.x - g.ring.x, p.y - g.ring.y)).toBeLessThanOrEqual(g.ring.r + (p.building === undefined ? 0 : SITING.windowRingSlackM) + 1e-9);
    }
  });

  it("sees more of the approach from better cover than the scenario's start places", () => {
    const before = start.reduce((a, p) => a + share(ctx, pts, p.x, p.y), 0) / start.length;
    const outdoors = places.filter((p) => p.building === undefined);
    const after = outdoors.reduce((a, p) => a + share(ctx, pts, p.x, p.y), 0) / outdoors.length;
    expect(after).toBeGreaterThan(before * 1.3);
    const foot = navFor(ctx, "foot").grid;
    const open = (xs: { x: number; y: number }[]) => xs.filter((p) => exposureAt(foot, p.x, p.y) >= 0.9).length;
    expect(open(outdoors)).toBeLessThanOrEqual(Math.min(2, open(start)));
  });

  it("is a pure function of the ground and the men", () => {
    expect(siteDefence(createContext(input), groups, pts)).toEqual(places);
  });

  it("in a battle, the defending commander sends its men there at once; they lie down apart", () => {
    const r = runBattle(input, { controllers: [commanderController("blue", input), commanderController("red", input)], onTick: (sim) => {
      if (sim.state.tick !== 60 * 59) return;
      const men = [...sim.state.soldier.entries()].filter(([id, s]) => sim.state.identity.get(id)?.side === def && isAble(s)).map(([id, s]) => ({ s, t: sim.state.transform.req(id) }));
      // (Men outdoors lie down; men at windows, M7.5e, kneel or stand by the sill.)
      const out = men.filter((m) => indoorAt(sim.ctx, m.t.x, m.t.y) < 0);
      expect(out.filter((m) => m.s.posture === "prone").length).toBeGreaterThanOrEqual(out.length - 2);
      for (const a of men) for (const b of men) if (a !== b && a.t.z === b.t.z) expect(hypot2(a.t.x - b.t.x, a.t.y - b.t.y)).toBeGreaterThan(2);
    } });
    const moves = r.orders.filter((o) => o.issuer === def && o.tick === 0 && (o.kind === "move" || o.kind === "occupy"));
    expect(moves.length).toBeGreaterThan(start.length / 2);
    expect(moves.every((o) => o.kind === "occupy" ? o.windowIndex !== undefined && o.mode === "walk" : o.kind === "move" && o.facing !== undefined && o.waypoints.length === 1)).toBe(true);
    expect(moves.some((o) => o.kind === "occupy")).toBe(true);
  });
});

/** Distance from (x, y) to a polygon's outline. */
function toOutline(fp: readonly number[], x: number, y: number): number {
  const n = fp.length / 2;
  let best = Infinity;
  for (let i = 0; i < n; i++) {
    const ax = fp[i * 2]!, ay = fp[i * 2 + 1]!, bx = fp[((i + 1) % n) * 2]!, by = fp[((i + 1) % n) * 2 + 1]!;
    const ex = bx - ax, ey = by - ay, l2 = ex * ex + ey * ey, t = l2 > 0 ? Math.min(1, Math.max(0, ((x - ax) * ex + (y - ay) * ey) / l2)) : 0;
    best = Math.min(best, Math.hypot(ax + ex * t - x, ay + ey * t - y));
  }
  return best;
}

describe("defence siting in houses (M7.5e defend)", () => {
  for (const seed of [1, 2, 3]) it(`village seed ${seed}: a mix of window places and men outside, within the caps`, () => {
    const input = scenario(seed, 60);
    const sim = createSim(input), ctx = sim.ctx, st = sim.state;
    const main = input.rules.objectives[0]!, def = main.holder!;
    const groups: SitingGroup[] = [...st.unit.entries()].filter(([, u]) => u.side === def && u.members.length > 0).map(([, u]) => {
      const men = [...u.members].sort((a, b) => a - b).map((id) => { const t = st.transform.req(id); return { id, x: t.x, y: t.y }; });
      const cx = men.reduce((a, m) => a + m.x, 0) / men.length, cy = men.reduce((a, m) => a + m.y, 0) / men.length;
      const o = input.rules.objectives.find((ob) => hypot2(ob.x - cx, ob.y - cy) <= ob.radiusM + 15);
      return { men, cx, cy, ...(o ? { ring: { x: o.x, y: o.y, r: o.radiusM } } : {}) };
    });
    const front = Math.atan2(input.map.heightM / 2 - main.y, (input.map.widthM - main.x > main.x ? input.map.widthM : 0) - main.x);
    const pts = approachPoints(ctx, main.x, main.y, front);
    const places = siteDefence(ctx, groups, pts);
    const wins = places.filter((p) => p.building !== undefined);
    expect(wins.length).toBeGreaterThan(0);
    const houses = new Map<number, SitingPlace[]>(), rooms = new Map<string, number>();
    for (const p of wins) {
      const bi = buildingIndex(ctx, p.building!), w = windowPlaces(ctx, bi)[p.windowIndex!]!;
      // He stands at that window place.
      expect([p.x, p.y]).toEqual([w.x, w.y]);
      houses.set(bi, [...(houses.get(bi) ?? []), p]);
      const k = `${bi}:${w.floor}:${roomAt(ctx.map.buildings[bi]!, w.floor, w.x, w.y)}`;
      rooms.set(k, (rooms.get(k) ?? 0) + 1);
    }
    for (const n of rooms.values()) expect(n).toBeLessThanOrEqual(SITING.roomMax);
    for (const [bi, ps] of houses) {
      expect(ps.length).toBeLessThanOrEqual(SITING.houseMax);
      expect(ps.filter((p) => windowPlaces(ctx, bi)[p.windowIndex!]!.floor > 0).length).toBeLessThanOrEqual(SITING.upperMax);
      // No man outside near its walls; one outside on its far side from the approach (the back).
      const fp = ctx.map.buildings[bi]!.footprint;
      const out = places.filter((p) => p.building === undefined);
      for (const p of out) expect(toOutline(fp, p.x, p.y) >= SITING.wallClearM - 1e-9 || pointInPolygon(fp, p.x, p.y)).toBe(true);
      let hx = 0, hy = 0, fx = 0, fy = 0;
      for (let i = 0; i < fp.length / 2; i++) { hx += fp[i * 2]! / (fp.length / 2); hy += fp[i * 2 + 1]! / (fp.length / 2); }
      for (const q of pts) { fx += q.x / pts.length; fy += q.y / pts.length; }
      const back = out.filter((p) => (p.x - hx) * (fx - hx) + (p.y - hy) * (fy - hy) < 0 && toOutline(fp, p.x, p.y) <= SITING.wallClearM + SITING.backM + 1e-9);
      expect(back.length).toBeGreaterThan(0);
    }
    // An upper window only where it sees at least `upperGain` x the best ground window of its wall.
    const tz = ctx.catalog.body.postures.crouching.heightM * 0.8;
    const seenN = (w: ReturnType<typeof windowPlaces>[number]) => {
      const z0 = standZ(ctx.map, w) + eyeHeightM(ctx, w.posture === "standing" ? "standing" : "crouching");
      return pts.filter((q) => sight(ctx, w.x, w.y, z0, q.x, q.y, heightAt(ctx.map, q.x, q.y) + tz).visibility >= SITING.seenVisibility).length;
    };
    for (const p of wins) {
      const all = windowPlaces(ctx, buildingIndex(ctx, p.building!)), w = all[p.windowIndex!]!;
      if (w.floor === 0) continue;
      const wall = Math.round((w.heading * 4) / Math.PI);
      const ground = all.filter((o) => o.floor === 0 && Math.round((o.heading * 4) / Math.PI) === wall).map(seenN);
      expect(seenN(w)).toBeGreaterThanOrEqual(SITING.upperGain * Math.max(0, ...ground));
    }
    for (const g of groups) {
      const mine = places.filter((p) => g.men.some((m) => m.id === p.id));
      const inside = mine.filter((p) => p.building !== undefined);
      expect(inside.length).toBeLessThanOrEqual(Math.floor(SITING.insideShare * g.men.length));
      if (inside.length > 0) expect(mine.length - inside.length).toBeGreaterThanOrEqual(SITING.outsideMin);
      const up = inside.filter((p) => windowPlaces(ctx, buildingIndex(ctx, p.building!))[p.windowIndex!]!.floor > 0).length;
      expect(up).toBeLessThanOrEqual(Math.ceil(inside.length / 2) + 1);
    }
    // Deterministic.
    expect(siteDefence(createContext(input), groups, pts)).toEqual(places);
  });

  it("interiors off: no window places, and the same places as with windows switched off", () => {
    const input = scenario(1, 60);
    input.map = stripInteriors(input.map);
    const sim = createSim(input), ctx = sim.ctx, st = sim.state;
    const main = input.rules.objectives[0]!, def = main.holder!;
    const groups: SitingGroup[] = [...st.unit.entries()].filter(([, u]) => u.side === def && u.members.length > 0).map(([, u]) => {
      const men = [...u.members].sort((a, b) => a - b).map((id) => { const t = st.transform.req(id); return { id, x: t.x, y: t.y }; });
      return { men, cx: men.reduce((a, m) => a + m.x, 0) / men.length, cy: men.reduce((a, m) => a + m.y, 0) / men.length };
    });
    const pts = approachPoints(ctx, main.x, main.y, 0);
    const a = siteDefence(ctx, groups, pts);
    expect(a.some((p) => p.building !== undefined)).toBe(false);
    expect(siteDefence(ctx, groups, pts, undefined, { windows: false })).toEqual(a);
  });
});
