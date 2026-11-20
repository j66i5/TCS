/**
 * Hull-down posts (M7.6b, moved here from ai/siting.ts in balance pass 5 so that the mounted assault drill
 * (systems/assault-mounted.ts) and the AI's tank sections and carriers share one siting function). Pure function of
 * its inputs: deterministic.
 */
import type { SimContext } from "./context";
import { indoorAt } from "./interior-nav";
import { sight } from "./los";
import { atan2, cos, hypot2, PI, sin } from "./math";
import type { MovementClass } from "./catalog";
import { exposureAt, navCostAt } from "./nav";
import { navFor } from "./navctx";
import { heightAt } from "./terrain";

/**
 * HULL-DOWN POST of a tank section (M7.6b; game values, low confidence). Candidates on rings `ringsM` around the
 * anchor (`stepM` apart along each ring; at most `maxCands`, taken evenly) on ground the tank's class can drive (the
 * vehicles' grid, with their clearance; in the region of `from` when given), outdoors, at least `standoffM` from
 * every threat point (cover the enemy's anti-tank men may hold, known enemy men), and, with `behind`, at least
 * `behind.minM` along (ux, uy) from (x, y) (the defence stays on its own side). Each is scored against the target
 * points (at most `maxTargets`, taken evenly) within `rangeM` of it:
 *   seenTurret = share of the targets seen (visibility >= `seenVisibility`) from `turretZ` (its highest sight) to a
 *                hull's middle (1.5 m) there;
 *   hullHidden = share of those seen from which the hull point (`hullZ`) is not seen from an enemy sight 2.5 m up;
 *   score = seenTurret + hullDownW x seenTurret x hullHidden + coverW x (1 - exposure) - distW per 100 m from the
 *           anchor.
 * Returns the best post and up to two alternates `altM` from it and from each other, each facing the targets'
 * middle. If no candidate keeps the standoff, the one farthest from the nearest threat, flagged `exposed`. At most
 * maxCands x maxTargets x 2 sight lines. Pure function of its inputs: deterministic.
 */
export const HULL_DOWN = {
  ringsM: [0, 40, 80, 120, 180, 250], stepM: 40, maxCands: 120, maxTargets: 16, seenVisibility: 0.3, targetHullZ: 1.5, enemyEyeZ: 2.5,
  hullDownW: 0.5, coverW: 0.1, distW: 0.05, altM: [30, 150],
} as const;

export interface HullDownOpts {
  cls: MovementClass; turretZ: number; hullZ: number; rangeM: readonly [number, number];
  threats: readonly { x: number; y: number }[]; standoffM: number;
  behind?: { x: number; y: number; ux: number; uy: number; minM: number };
  /** Where the tank stands: candidates must be reachable from it (its grid region). */
  from?: { x: number; y: number };
  /** No post in vegetation at least this tall (a tank does not stand in a wood or a treeline). */
  vegMaxM?: number;
  /** Rings searched instead of `ringsM` (e.g. a short pull back). */
  ringsM?: readonly number[];
  /** Posts other hulls already hold or go to: no candidate within `altM[0]` of one (balance pass 2 review). */
  avoid?: readonly { x: number; y: number }[];
  /** Balance pass 4: score this one spot only (where a hull stands), instead of the rings round the anchor (the
   *  distance term still from the anchor). */
  at?: { x: number; y: number };
}

export interface HullDownPost { x: number; y: number; facing: number; exposed?: true; score: number;
  /** Mounted assault (balance pass 5): the share of the target points its turret sees (0 for an exposed fallback). */
  seen: number }

export function siteHullDown(ctx: SimContext, anchor: { x: number; y: number }, targets: readonly { x: number; y: number }[], o: HullDownOpts): HullDownPost[] {
  const D = HULL_DOWN, map = ctx.map, W = map.widthM, H = map.heightM;
  const { grid } = navFor(ctx, o.cls);
  const foot = navFor(ctx, "foot").grid;
  const regionAt = (x: number, y: number): number => {
    const c = Math.floor(x / grid.cellM), r = Math.floor(y / grid.cellM);
    return c < 0 || r < 0 || c >= grid.cols || r >= grid.rows ? -1 : grid.region[r * grid.cols + c]!;
  };
  const region = o.from ? regionAt(o.from.x, o.from.y) : 0;
  // Target points, at most maxTargets, taken evenly; a hull's middle there and an enemy sight above it.
  const tStride = Math.max(1, Math.ceil(targets.length / D.maxTargets));
  const tg: { x: number; y: number; z: number; ez: number }[] = [];
  for (let i = 0; i < targets.length; i += tStride) {
    const t = targets[i]!, g = heightAt(map, t.x, t.y); // ground: ok (a hull on open ground)
    tg.push({ x: t.x, y: t.y, z: g + D.targetHullZ, ez: g + D.enemyEyeZ });
  }
  let mx = 0, my = 0;
  for (const t of tg) { mx += t.x; my += t.y; }
  if (tg.length > 0) { mx /= tg.length; my /= tg.length; } else { mx = anchor.x; my = anchor.y; }
  const cands: { x: number; y: number }[] = o.at ? [{ x: o.at.x, y: o.at.y }] : [];
  for (const r of o.at ? [] : o.ringsM ?? D.ringsM) {
    const n = r === 0 ? 1 : Math.max(8, Math.round((2 * PI * r) / D.stepM));
    for (let k = 0; k < n; k++) {
      const b = (2 * PI * k) / n, x = anchor.x + cos(b) * r, y = anchor.y + sin(b) * r;
      if (x < 10 || y < 10 || x > W - 10 || y > H - 10) continue;
      cands.push({ x, y });
    }
  }
  const stride = Math.max(1, Math.ceil(cands.length / D.maxCands));
  const s2 = o.standoffM * o.standoffM;
  const scored: { x: number; y: number; score: number; seen: number }[] = [];
  const fallback: { x: number; y: number; score: number; seen: number }[] = [];
  const vegH = (x: number, y: number): number => {
    const c = Math.min(Math.floor(x / map.cellSizeM), map.cols - 1), r = Math.min(Math.floor(y / map.cellSizeM), map.rows - 1);
    const vi = map.vegetation[r * map.cols + c] ?? 0;
    return vi > 0 ? ctx.catalog.terrain.vegetation[map.vegetationPalette[vi - 1] ?? ""]?.heightM ?? 0 : 0;
  };
  for (let i = 0; i < cands.length; i += stride) {
    const c = cands[i]!;
    if (navCostAt(grid, c.x, c.y) <= 0 || indoorAt(ctx, c.x, c.y) >= 0) continue;
    if (o.vegMaxM !== undefined && vegH(c.x, c.y) >= o.vegMaxM) continue;
    if (o.avoid !== undefined && o.avoid.some((p) => hypot2(p.x - c.x, p.y - c.y) < D.altM[0])) continue;
    if (region > 0 && regionAt(c.x, c.y) !== region) continue;
    if (o.behind && (c.x - o.behind.x) * o.behind.ux + (c.y - o.behind.y) * o.behind.uy < o.behind.minM) continue;
    let minD2 = Infinity;
    for (const t of o.threats) { const d2 = (t.x - c.x) * (t.x - c.x) + (t.y - c.y) * (t.y - c.y); if (d2 < minD2) minD2 = d2; }
    if (minD2 < s2) { fallback.push({ x: c.x, y: c.y, score: minD2, seen: 0 }); continue; }
    const g = heightAt(map, c.x, c.y); // ground: ok (a hull on open ground)
    const tz = g + o.turretZ, hz = g + o.hullZ;
    let seen = 0, hidden = 0;
    for (const t of tg) {
      const d = hypot2(t.x - c.x, t.y - c.y);
      if (d < o.rangeM[0] || d > o.rangeM[1]) continue;
      if (sight(ctx, c.x, c.y, tz, t.x, t.y, t.z).visibility < D.seenVisibility) continue;
      seen++;
      const back = sight(ctx, t.x, t.y, t.ez, c.x, c.y, hz);
      if (back.blockedBy !== null || back.visibility < D.seenVisibility) hidden++;
    }
    const seenTurret = tg.length > 0 ? seen / tg.length : 0, hullHidden = seen > 0 ? hidden / seen : 0;
    const score = seenTurret + D.hullDownW * seenTurret * hullHidden + D.coverW * (1 - exposureAt(foot, c.x, c.y)) - (D.distW * hypot2(c.x - anchor.x, c.y - anchor.y)) / 100;
    scored.push({ x: c.x, y: c.y, score, seen: seenTurret });
  }
  const face = (p: { x: number; y: number }) => atan2(my - p.y, mx - p.x);
  // (None keeps the standoff: those farthest from the nearest threat, flagged exposed.)
  const exposed = scored.length === 0;
  const list = exposed ? fallback : scored;
  if (list.length === 0) return [];
  list.sort((a, b) => b.score - a.score || a.x - b.x || a.y - b.y);
  const best = list[0]!;
  const post = (p: { x: number; y: number; score: number; seen: number }): HullDownPost => ({ x: p.x, y: p.y, facing: face(p), score: exposed ? 0 : p.score, seen: p.seen, ...(exposed ? { exposed: true as const } : {}) });
  const out: HullDownPost[] = [post(best)];
  for (const s of list) {
    if (out.length >= 3) break;
    const d0 = hypot2(s.x - best.x, s.y - best.y);
    if (d0 < HULL_DOWN.altM[0] || d0 > HULL_DOWN.altM[1] || out.some((p) => hypot2(p.x - s.x, p.y - s.y) < HULL_DOWN.altM[0])) continue;
    out.push(post(s));
  }
  return out;
}
