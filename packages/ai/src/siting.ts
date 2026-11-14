/**
 * DEFENCE SITING (overnight AI pick "defence-siting", 2026-11-14).
 *
 * Before, a defending platoon lay where the scenario put it: squads at fixed offsets around the objectives, men
 * 6 m apart in a straight line, many in the open and most seeing little of the ground the attack must cross.
 * Now the commander picks each man's fire position once, at its first look: around each group's start place
 * (within `searchM`, and inside the ring of the objective the group holds) it tries points on a `gridM` grid,
 * each where the man's own cover search would leave him, and scores each by
 *   - the share of the approach (points `ringsM` out from the main objective, `arcDeg` either side of the way the
 *     attack comes) a man lying there sees (visibility >= `seenVisibility` to a crouching man);
 *   - what it adds to the whole defence's view (`gainW`), so that the men's fields of fire cover the approach
 *     between them instead of all looking down the same lane;
 *   - its cover (`coverW` x (1 - exposure)), less `openPenalty` in the open (exposure >= 0.9);
 *   - spacing: never within `hardSpacingM` of another man's place, and `spacingPenalty` per metre short of
 *     `spacingM`; a little (`distW`) for the way to get there.
 * Men are placed in turn (one per group per round, so no group takes every good spot), each sent to his place at a
 * walk, to lie down there facing the middle of what he sees.
 *
 * The ground model is the commander's own view of the ground (sight lines as the sim draws them); it uses no
 * knowledge of the enemy: the way the attack comes is the one the commander already assumes (from the middle of
 * the map through the objective). Pure function of its inputs: deterministic.
 */
import {
  atan2, bestCoverNear, cos, exposureAt, eyeHeightM, heightAt, hypot2, indoorAt, navCostAt, navFor, PI, sight, sin,
  type SimContext,
} from "@tcs/sim";

/** Game values (low confidence): see the module comment. */
export const SITING = {
  searchM: 40, gridM: 5, ringMarginM: 0, ringsM: [75, 125, 175, 225, 275, 325], arcDeg: 60, arcStepDeg: 12,
  seenVisibility: 0.3, gainW: 0.5, coverW: 0.1, openPenalty: 0.3, spacingM: 5, hardSpacingM: 3, spacingPenalty: 0.02,
  distW: 0.03, stayM: 2,
  /** Mirrors the sim's laid-out move: a man sent with a facing takes the best cover within this of his end point. */
  coverSnapM: 4,
} as const;

export interface SitingGroup {
  /** The men to place (ascending ID), with where each stands now. */
  men: { id: number; x: number; y: number }[];
  /** The group's start place: candidates are searched around it. */
  cx: number; cy: number;
  /** The ring it must stay inside (the objective it holds), if any. */
  ring?: { x: number; y: number; r: number };
}

export interface SitingPlace { id: number; x: number; y: number; facing: number; move: boolean }

/** The approach the defence must see: points on rings out from (ox, oy), `arcDeg` either side of `front` (rad). */
export function approachPoints(ctx: SimContext, ox: number, oy: number, front: number): { x: number; y: number }[] {
  const W = ctx.map.widthM, H = ctx.map.heightM, out: { x: number; y: number }[] = [];
  for (const r of SITING.ringsM) for (let a = -SITING.arcDeg; a <= SITING.arcDeg + 1e-9; a += SITING.arcStepDeg) {
    const b = front + (a * PI) / 180, x = ox + cos(b) * r, y = oy + sin(b) * r;
    if (x < 5 || y < 5 || x > W - 5 || y > H - 5 || indoorAt(ctx, x, y) >= 0) continue;
    out.push({ x, y });
  }
  return out;
}

/** Each man's fire position (see the module comment); `searchM`: how far from the group's place (default `SITING.searchM`). */
export function siteDefence(ctx: SimContext, groups: readonly SitingGroup[], pts: readonly { x: number; y: number }[], searchM: number = SITING.searchM): SitingPlace[] {
  const S = SITING, map = ctx.map, foot = navFor(ctx, "foot").grid;
  const N = pts.length;
  const eye = eyeHeightM(ctx, "prone"), tz = ctx.catalog.body.postures.crouching.heightM * 0.8;
  const ptz = pts.map((p) => heightAt(map, p.x, p.y) + tz); // ground: ok (the approach's open ground)
  // Candidate places, shared between groups: where a man sent to each grid point would lie, what he sees from there.
  const cands = new Map<number, { x: number; y: number; seen: Uint8Array; n: number; exp: number; ax: number; ay: number }>();
  const candOf = (x: number, y: number) => {
    const q = bestCoverNear(foot, x, y, S.coverSnapM);
    if (!q || navCostAt(foot, q.x, q.y) <= 0 || indoorAt(ctx, q.x, q.y) >= 0) return null;
    const key = Math.round(q.y * 2) * 1e5 + Math.round(q.x * 2);
    let c = cands.get(key);
    if (!c) {
      const seen = new Uint8Array(N);
      const z0 = heightAt(map, q.x, q.y) + eye; // ground: ok (a man lying on open ground)
      let n = 0, ax = 0, ay = 0;
      for (let i = 0; i < N; i++) {
        const p = pts[i]!;
        if (sight(ctx, q.x, q.y, z0, p.x, p.y, ptz[i]!).visibility >= S.seenVisibility) {
          seen[i] = 1; n++;
          const d = hypot2(p.x - q.x, p.y - q.y) || 1;
          ax += (p.x - q.x) / d; ay += (p.y - q.y) / d;
        }
      }
      c = { x: q.x, y: q.y, seen, n, exp: exposureAt(foot, q.x, q.y), ax, ay };
      cands.set(key, c);
    }
    return c;
  };
  const lists = groups.map((g) => {
    const out: NonNullable<ReturnType<typeof candOf>>[] = [];
    const k = Math.floor(searchM / S.gridM);
    for (let dy = -k; dy <= k; dy++) for (let dx = -k; dx <= k; dx++) {
      if (dx * dx + dy * dy > k * k) continue;
      const x = g.cx + dx * S.gridM, y = g.cy + dy * S.gridM;
      if (x < 1 || y < 1 || x > map.widthM - 1 || y > map.heightM - 1) continue;
      const c = candOf(x, y);
      if (!c) continue;
      if (g.ring && hypot2(c.x - g.ring.x, c.y - g.ring.y) > g.ring.r - S.ringMarginM) continue;
      if (!out.includes(c)) out.push(c);
    }
    // The men's own places count too (a man already well placed stays).
    for (const m of g.men) {
      const c = candOf(m.x, m.y);
      if (c && !out.includes(c) && (!g.ring || hypot2(c.x - g.ring.x, c.y - g.ring.y) <= g.ring.r)) out.push(c);
    }
    return out;
  });
  const union = new Uint8Array(N);
  const taken: { x: number; y: number }[] = [];
  const result: SitingPlace[] = [];
  const next = groups.map(() => 0);
  for (let more = true; more;) {
    more = false;
    groups.forEach((g, gi) => {
      const m = g.men[next[gi]!];
      if (!m) return;
      next[gi]!++; more = true;
      let best: (typeof lists)[number][number] | null = null, bestScore = -Infinity;
      for (const c of lists[gi]!) {
        let near = Infinity;
        for (const t of taken) near = Math.min(near, hypot2(t.x - c.x, t.y - c.y));
        if (near < S.hardSpacingM) continue;
        let gain = 0;
        for (let i = 0; i < N; i++) if (c.seen[i] === 1 && union[i] === 0) gain++;
        const score = (c.n + S.gainW * gain) / Math.max(1, N) + S.coverW * (1 - c.exp) - (c.exp >= 0.9 ? S.openPenalty : 0)
          - (near < S.spacingM ? (S.spacingM - near) * S.spacingPenalty : 0) - (S.distW * hypot2(c.x - m.x, c.y - m.y)) / searchM;
        if (score > bestScore) { bestScore = score; best = c; }
      }
      if (!best) { taken.push({ x: m.x, y: m.y }); result.push({ id: m.id, x: m.x, y: m.y, facing: NaN, move: false }); return; }
      taken.push({ x: best.x, y: best.y });
      for (let i = 0; i < N; i++) if (best.seen[i] === 1) union[i] = 1;
      result.push({ id: m.id, x: best.x, y: best.y, facing: best.n > 0 ? atan2(best.ay, best.ax) : NaN, move: hypot2(best.x - m.x, best.y - m.y) > S.stayM });
    });
  }
  return result.sort((a, b) => a.id - b.id);
}

/** The share of `pts` a man lying at (x, y) sees (visibility >= `seenVisibility` to a crouching man). */
export function seenShare(ctx: SimContext, x: number, y: number, pts: readonly { x: number; y: number }[]): number {
  if (pts.length === 0) return 0;
  const map = ctx.map, tz = ctx.catalog.body.postures.crouching.heightM * 0.8;
  const z0 = heightAt(map, x, y) + eyeHeightM(ctx, "prone"); // ground: ok (a man lying on open ground)
  let n = 0;
  for (const p of pts) if (sight(ctx, x, y, z0, p.x, p.y, heightAt(map, p.x, p.y) + tz).visibility >= SITING.seenVisibility) n++; // ground: ok (open ground)
  return n / pts.length;
}
