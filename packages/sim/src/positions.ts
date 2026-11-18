/**
 * FIGHTING POSITIONS (M11 hold battle; owner 2026-11-16 "a stronger defence: dig the defenders in").
 *
 * A dug fighting position is a hole `fightingPosition.halfWidthM` round a point on the ground (terrain state,
 * `state.terrain.positions`: it saves and replays, and anyone of either side standing in it is in it). A side whose
 * positions were prepared before the battle (`rules.prepared`) gets one wherever one of its men halts on the ground
 * outdoors between `fromS` and `untilS` (where the commander sited him: the siting is the plan the positions were
 * dug to), at least `spacingM` from any other; none are dug after that.
 *
 * Protection is geometric: the hole's rim stands `exposedM` (by posture: his head and weapon) below the top of the man
 * (at most `depthM` up; a position dug in a hasty window, `rules.prepared[].depthM`, at most that deep): a round or fragment that would strike him lower and came in over the rim's far side lower than the rim
 * is stopped by the earth (ballistics.ts); a burst whose line to his middle passes under the rim does not reach him
 * with its blast (explosions.ts). A round from above (a burst over or in the hole, a steep fall) still strikes him,
 * and so does anything that hits him above the rim: his head and weapon stay out when he fires.
 */
import type { SimContext } from "./context";
import type { EventSink } from "./events";
import type { EntityId } from "./ids";
import { TICK_HZ } from "./ids";
import { indoorAt } from "./interior-nav";
import { isAble } from "./impair";
import { sqrt } from "./math";
import { isOffMapMan } from "./offmap";
import type { SimState } from "./state";

/** The position (index in `state.terrain.positions`) a man at (x, y) on the ground stands in, or -1. */
export function positionAt(ctx: SimContext, state: { readonly terrain: { readonly positions?: readonly { readonly x: number; readonly y: number }[] } }, x: number, y: number): number {
  const ps = state.terrain.positions, fp = ctx.catalog.ballistics.fightingPosition;
  if (!ps || !fp) return -1;
  const r2 = fp.halfWidthM * fp.halfWidthM;
  for (let i = 0; i < ps.length; i++) { const p = ps[i]!, dx = p.x - x, dy = p.y - y; if (dx * dx + dy * dy <= r2) return i; }
  return -1;
}

/**
 * Height of the rim above a man's feet (0: he is in no position, is aboard, or stands on a floor or a roof): his
 * height in his posture less `exposedM` for it, at most `depthM`.
 */
export function rimHeight(ctx: SimContext, state: SimState, id: EntityId): number {
  const ps = state.terrain.positions, fp = ctx.catalog.ballistics.fightingPosition;
  if (!ps || ps.length === 0 || !fp) return 0;
  const s = state.soldier.get(id), t = state.transform.get(id);
  if (!s || !t || s.mount !== undefined || t.z !== 0) return 0;
  const k = positionAt(ctx, state, t.x, t.y);
  if (k < 0) return 0;
  const pd = ps[k]!.depthM, depth = pd !== undefined && pd < fp.depthM ? pd : fp.depthM;
  const rim = ctx.catalog.body.postures[s.posture].heightM - fp.exposedM[s.posture];
  return rim < 0 ? 0 : rim > depth ? depth : rim;
}

/**
 * Is a path from (fx, fy, fz) to a man at (mx, my) on ground height `gz`, striking him at height `hz` (absolute),
 * stopped by the rim of the hole he is in (`rim` above `gz`)? It came over the rim's far side `halfWidthM` from his
 * middle lower than the rim. A path that starts inside the hole (a burst in it) is never stopped.
 */
export function rimStops(halfWidthM: number, rim: number, mx: number, my: number, gz: number, fx: number, fy: number, fz: number, hz: number): boolean {
  if (rim <= 0) return false;
  const ex = fx - mx, ey = fy - my, d2 = ex * ex + ey * ey;
  if (d2 <= halfWidthM * halfWidthM) return false;
  if (hz - gz >= rim) return false; // it strikes him above the rim
  // (Straight line from where it came to where it strikes: its height where it crosses the rim.)
  const d = sqrt(d2);
  const zRim = hz + ((fz - hz) * halfWidthM) / d;
  return zRim - gz < rim;
}

/** Digging (`rules.prepared`): once a second within the windows, a position under each halted man of the side. */
export function positionsSystem(ctx: SimContext, state: SimState, _events: EventSink): void {
  const prep = ctx.rules.prepared, fp = ctx.catalog.ballistics.fightingPosition;
  if (!prep || prep.length === 0 || !fp || state.tick % TICK_HZ !== 0) return;
  const s0 = state.tick / TICK_HZ;
  for (const pr of prep) {
    if (s0 < pr.fromS || s0 > pr.untilS) continue;
    for (const [id, s] of state.soldier.entries()) {
      if (!s.physiology.alive || !isAble(s) || s.mount !== undefined || isOffMapMan(state, s)) continue;
      if (state.identity.get(id)?.side !== pr.side) continue;
      const t = state.transform.get(id), mv = state.mover.get(id);
      if (!t || t.z !== 0 || (mv && mv.waypoints.length > 0) || indoorAt(ctx, t.x, t.y) >= 0) continue;
      const ps = (state.terrain.positions ??= []);
      const sp2 = fp.spacingM * fp.spacingM;
      if (ps.some((p) => (p.x - t.x) * (p.x - t.x) + (p.y - t.y) * (p.y - t.y) < sp2)) continue;
      ps.push({ x: t.x, y: t.y, side: pr.side, tick: state.tick, ...(pr.depthM !== undefined ? { depthM: pr.depthM } : {}) });
    }
  }
}

/** Is this man on foot in a fighting position (he keeps it: cover seeking and side steps leave him there)? */
export function inPosition(ctx: SimContext, state: SimState, id: EntityId): boolean {
  if ((state.terrain.positions?.length ?? 0) === 0) return false;
  const s = state.soldier.get(id), t = state.transform.get(id);
  return s !== undefined && t !== undefined && s.mount === undefined && t.z === 0 && positionAt(ctx, state, t.x, t.y) >= 0;
}

/**
 * The nearest fighting position of `side` within `radiusM` of (x, y) that no man on foot stands in (nor is walking
 * to: his last waypoint in it), ties by order dug; null: none. For men coming back to the line (bearers).
 */
export function freePositionNear(ctx: SimContext, state: SimState, side: string, x: number, y: number, radiusM: number, self?: EntityId): { x: number; y: number } | null {
  const ps = state.terrain.positions, fp = ctx.catalog.ballistics.fightingPosition;
  if (!ps || ps.length === 0 || !fp) return null;
  const r2 = fp.halfWidthM * fp.halfWidthM;
  let best = -1, bestD = radiusM * radiusM;
  for (let i = 0; i < ps.length; i++) {
    const p = ps[i]!;
    if (p.side !== side) continue;
    const d = (p.x - x) * (p.x - x) + (p.y - y) * (p.y - y);
    if (d > bestD) continue;
    let used = false;
    for (const [id, s] of state.soldier.entries()) {
      if (id === self || s.mount !== undefined || !s.physiology.alive) continue;
      const t = state.transform.get(id);
      if (!t) continue;
      const w = state.mover.get(id)?.waypoints, e = w && w.length > 0 ? w[w.length - 1]! : t;
      if ((t.x - p.x) * (t.x - p.x) + (t.y - p.y) * (t.y - p.y) <= r2 || (e.x - p.x) * (e.x - p.x) + (e.y - p.y) * (e.y - p.y) <= r2) { used = true; break; }
    }
    if (used) continue;
    best = i; bestD = d;
  }
  return best < 0 ? null : { x: ps[best]!.x, y: ps[best]!.y };
}
