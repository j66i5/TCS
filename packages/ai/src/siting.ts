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
  atan2, bestCoverNear, cos, exposureAt, eyeHeightM, heightAt, hypot2, indoorAt, navCostAt, navFor, PI, pointInPolygon, roomAt, sight, sin,
  standZ, windowPlaces, type MovementClass, type SimContext,
} from "@tcs/sim";

/** Game values (low confidence): see the module comment. */
export const SITING = {
  searchM: 40, gridM: 5, ringMarginM: 0, ringsM: [75, 125, 175, 225, 275, 325], arcDeg: 60, arcStepDeg: 12,
  seenVisibility: 0.3, gainW: 0.5, coverW: 0.1, openPenalty: 0.3, spacingM: 5, hardSpacingM: 3, spacingPenalty: 0.02,
  distW: 0.03, stayM: 2,
  /** Mirrors the sim's laid-out move: a man sent with a facing takes the best cover within this of his end point. */
  coverSnapM: 4,
  // Houses (M7.5e "defend", plan m7.5e D2; game values, low confidence): see `siteDefence`.
  insideShare: 0.6, outsideMin: 2, roomMax: 2, houseMax: 4, upperMax: 2, upperGain: 1, wallClearM: 8, windowCoverW: 0.4, windowRingSlackM: 10,
  backM: 15, backBehindW: 0.05,
} as const;

export interface SitingGroup {
  /** The men to place (ascending ID), with where each stands now. */
  men: { id: number; x: number; y: number }[];
  /** The group's start place: candidates are searched around it. */
  cx: number; cy: number;
  /** The ring it must stay inside (the objective it holds), if any. */
  ring?: { x: number; y: number; r: number };
}

export interface SitingPlace {
  id: number; x: number; y: number; facing: number; move: boolean;
  /** M7.5e: a window place: the building's id and the window's index in its `windowPlaces` (an `occupy` order). */
  building?: number; windowIndex?: number;
  /** How many of the points it sees (absent: a man left where he is, not worked out). */
  seen?: number;
}

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

/** Distance from (x, y) to the outline of polygon `fp` (flat [x0, y0, x1, y1, ...]). */
function distToOutline(fp: readonly number[], x: number, y: number): number {
  const n = fp.length / 2;
  let best = Infinity;
  for (let i = 0; i < n; i++) {
    const ax = fp[i * 2]!, ay = fp[i * 2 + 1]!, bx = fp[((i + 1) % n) * 2]!, by = fp[((i + 1) % n) * 2 + 1]!;
    const ex = bx - ax, ey = by - ay, l2 = ex * ex + ey * ey;
    const t = l2 > 0 ? Math.min(1, Math.max(0, ((x - ax) * ex + (y - ay) * ey) / l2)) : 0;
    best = Math.min(best, hypot2(ax + ex * t - x, ay + ey * t - y));
  }
  return best;
}

/** Options of `siteDefence`. */
export interface SitingOptions {
  /** Window places of the houses near each group are candidates too (M7.5e; default true). */
  windows?: boolean;
  /**
   * Sight realism step 5 (re-siting toward a lost enemy): each man may only take a place within `r` of his own anchor
   * (where he was sited), and the candidates are searched only within those discs (not `searchM` around the group).
   */
  anchors?: ReadonlyMap<number, { x: number; y: number; r: number }>;
  /** Places other men already hold or are going to (building index, -1 outdoors; height): kept clear like the group's own. */
  taken?: readonly { x: number; y: number; bi: number; z: number }[];
  /** The eye a candidate is judged from outdoors (default prone) and the share of visibility that counts as seen
   *  (default `SITING.seenVisibility`). */
  eyePosture?: "prone" | "crouching";
  seenVisibility?: number;
}

interface Cand {
  x: number; y: number; seen: Uint8Array; n: number; exp: number; ax: number; ay: number;
  /** M7.5e window places: the building's index (-1 outdoors), the window's index, floor, room, height, heading, wall. */
  bi: number; win: number; floor: number; room: number; z: number; heading: number; wall: number;
}

/**
 * Each man's fire position (see the module comment); `searchM`: how far from the group's place (default
 * `SITING.searchM`).
 *
 * M7.5e "defend" (plan m7.5e §4 step 1, D2): the window places of the houses near a group (within `searchM`, inside
 * its ring or within `windowRingSlackM` of it: a house on the ring's edge is part of the position) are candidates
 * beside the outdoor spots, each seen from its own height (floor + the eye of the posture that clears the sill), its
 * cover the walls (`windowCoverW`). The squad is mixed: at most `insideShare` of a group inside and at least
 * `outsideMin` men outside, `roomMax` men per room and `houseMax` per house; an upper window only if it sees
 * `upperGain` x the best ground window of its wall (at most half the group's men inside upstairs, `upperMax` per
 * house); no man outside within `wallClearM` of the walls of an occupied house (one shell on the house); the
 * group's next man after one takes a house watches its back (`wallClearM`..`wallClearM + backM` from its walls on
 * the far side from the approach, facing away from it). `opts.windows` false: outdoor spots only (as before).
 */
export function siteDefence(ctx: SimContext, groups: readonly SitingGroup[], pts: readonly { x: number; y: number; h?: number }[], searchM: number = SITING.searchM, opts: SitingOptions = {}): SitingPlace[] {
  const S = SITING, map = ctx.map, foot = navFor(ctx, "foot").grid;
  const N = pts.length;
  const eye = eyeHeightM(ctx, opts.eyePosture ?? "prone"), tz = ctx.catalog.body.postures.crouching.heightM * 0.8, seenVis = opts.seenVisibility ?? S.seenVisibility;
  // (A point may carry its own target height above the ground: a known enemy's posture, step 5.)
  const ptz = pts.map((p) => heightAt(map, p.x, p.y) + (p.h ?? tz)); // ground: ok (the approach's open ground)
  const seenFrom = (x: number, y: number, z0: number): { seen: Uint8Array; n: number; ax: number; ay: number } => {
    const seen = new Uint8Array(N);
    let n = 0, ax = 0, ay = 0;
    for (let i = 0; i < N; i++) {
      const p = pts[i]!;
      if (sight(ctx, x, y, z0, p.x, p.y, ptz[i]!).visibility >= seenVis) {
        seen[i] = 1; n++;
        const d = hypot2(p.x - x, p.y - y) || 1;
        ax += (p.x - x) / d; ay += (p.y - y) / d;
      }
    }
    return { seen, n, ax, ay };
  };
  // Candidate places, shared between groups: where a man sent to each grid point would lie, what he sees from there.
  const cands = new Map<number, Cand>();
  const candOf = (x: number, y: number): Cand | null => {
    const q = bestCoverNear(foot, x, y, S.coverSnapM);
    if (!q || navCostAt(foot, q.x, q.y) <= 0 || indoorAt(ctx, q.x, q.y) >= 0) return null;
    const key = Math.round(q.y * 2) * 1e5 + Math.round(q.x * 2);
    let c = cands.get(key);
    if (!c) {
      c = { x: q.x, y: q.y, ...seenFrom(q.x, q.y, heightAt(map, q.x, q.y) + eye), exp: exposureAt(foot, q.x, q.y), bi: -1, win: -1, floor: 0, room: -1, z: 0, heading: NaN, wall: -1 }; // ground: ok (a man lying on open ground)
      cands.set(key, c);
    }
    return c;
  };
  // Back watchers' spots (M7.5e): what they see of the approach does not count, so it is not worked out.
  const backs = new Map<number, Cand>(), none = new Uint8Array(N);
  const backOf = (x: number, y: number): Cand | null => {
    const q = bestCoverNear(foot, x, y, S.coverSnapM);
    if (!q || navCostAt(foot, q.x, q.y) <= 0 || indoorAt(ctx, q.x, q.y) >= 0) return null;
    const key = Math.round(q.y * 2) * 1e5 + Math.round(q.x * 2);
    let c = backs.get(key);
    if (!c) backs.set(key, c = { x: q.x, y: q.y, seen: none, n: 0, ax: 0, ay: 0, exp: exposureAt(foot, q.x, q.y), bi: -1, win: -1, floor: 0, room: -1, z: 0, heading: NaN, wall: -1 });
    return c;
  };
  // Window places (M7.5e), per house: every window, and the best a ground window of each wall sees.
  const useWindows = opts.windows !== false;
  const houses = new Map<number, Cand[]>();
  const windowsOf = (bi: number): Cand[] => {
    let l = houses.get(bi);
    if (l) return l;
    const b = map.buildings[bi]!;
    l = windowPlaces(ctx, bi).map((w, wi) => {
      const z0 = standZ(map, w) + eyeHeightM(ctx, w.posture === "standing" ? "standing" : "crouching");
      return { x: w.x, y: w.y, ...seenFrom(w.x, w.y, z0), exp: 0, bi, win: wi, floor: w.floor, room: roomAt(b, w.floor, w.x, w.y), z: w.z, heading: w.heading, wall: Math.round((w.heading * 4) / PI) };
    });
    const groundBest = new Map<number, number>();
    for (const c of l) if (c.floor === 0) groundBest.set(c.wall, Math.max(groundBest.get(c.wall) ?? 0, c.n));
    // An upper window only if it sees `upperGain` x the best ground window of its wall.
    l = l.filter((c) => c.floor === 0 || c.n >= S.upperGain * (groundBest.get(c.wall) ?? 0));
    houses.set(bi, l);
    return l;
  };
  const anchors = opts.anchors;
  const lists = groups.map((g) => {
    const out: Cand[] = [];
    // (Step 5: with anchors, the discs around its men's anchors, on one grid so that overlapping discs share points.)
    const discs = anchors ? g.men.map((m) => anchors.get(m.id)).filter((a) => a !== undefined) : [];
    const grid = new Set<number>();
    const tryPoint = (x: number, y: number) => {
      if (x < 1 || y < 1 || x > map.widthM - 1 || y > map.heightM - 1) return;
      const c = candOf(x, y);
      if (!c) return;
      if (g.ring && hypot2(c.x - g.ring.x, c.y - g.ring.y) > g.ring.r - S.ringMarginM) return;
      if (!out.includes(c)) out.push(c);
    };
    if (discs.length > 0) {
      for (const a of discs) {
        const k = Math.ceil(a.r / S.gridM), ix = Math.round(a.x / S.gridM), iy = Math.round(a.y / S.gridM);
        for (let dy = -k; dy <= k; dy++) for (let dx = -k; dx <= k; dx++) {
          const x = (ix + dx) * S.gridM, y = (iy + dy) * S.gridM;
          if (hypot2(x - a.x, y - a.y) > a.r) continue;
          const key = (iy + dy) * 100000 + (ix + dx);
          if (grid.has(key)) continue;
          grid.add(key);
          tryPoint(x, y);
        }
      }
    } else {
      const k = Math.floor(searchM / S.gridM);
      for (let dy = -k; dy <= k; dy++) for (let dx = -k; dx <= k; dx++) {
        if (dx * dx + dy * dy > k * k) continue;
        tryPoint(g.cx + dx * S.gridM, g.cy + dy * S.gridM);
      }
    }
    // The men's own places count too (a man already well placed stays).
    for (const m of g.men) {
      const c = candOf(m.x, m.y);
      if (c && !out.includes(c) && (!g.ring || hypot2(c.x - g.ring.x, c.y - g.ring.y) <= g.ring.r)) out.push(c);
    }
    const nearHouse = (fp: readonly number[]) => discs.length > 0
      ? discs.some((a) => distToOutline(fp, a.x, a.y) <= a.r || pointInPolygon(fp, a.x, a.y))
      : distToOutline(fp, g.cx, g.cy) <= searchM || pointInPolygon(fp, g.cx, g.cy);
    if (useWindows) map.buildings.forEach((b, bi) => {
      if (!b.interior || !nearHouse(b.footprint)) return;
      for (const c of windowsOf(bi)) if (!g.ring || hypot2(c.x - g.ring.x, c.y - g.ring.y) <= g.ring.r + S.windowRingSlackM) out.push(c);
    });
    return out;
  });
  // The way the attack comes, as these points show it (for the back watchers).
  let fx = 0, fy = 0;
  for (const p of pts) { fx += p.x / Math.max(1, N); fy += p.y / Math.max(1, N); }
  const union = new Uint8Array(N);
  /** Places taken: where, on which level (building index and height; -1 / 0 outdoors). */
  const taken: { x: number; y: number; bi: number; z: number }[] = [...(opts.taken ?? [])];
  const inHouse = new Map<number, number>(), upHouse = new Map<number, number>(), inRoom = new Map<string, number>();
  const result: SitingPlace[] = [];
  const next = groups.map(() => 0);
  const inside = groups.map(() => 0), upstairs = groups.map(() => 0);
  const backDue = groups.map((): number[] => []);
  const maxIn = groups.map((g) => Math.max(0, Math.min(Math.floor(S.insideShare * g.men.length), g.men.length - S.outsideMin)));
  const centreOf = (bi: number): [number, number] => {
    const fp = map.buildings[bi]!.footprint, n = fp.length / 2;
    let x = 0, y = 0;
    for (let i = 0; i < n; i++) { x += fp[i * 2]! / n; y += fp[i * 2 + 1]! / n; }
    return [x, y];
  };
  /** An outdoor spot is fine if it is clear of the walls of every occupied house. */
  const clearOfHouses = (x: number, y: number): boolean => {
    for (const bi of inHouse.keys()) if (distToOutline(map.buildings[bi]!.footprint, x, y) < S.wallClearM) return false;
    return true;
  };
  const nearest = (c: { x: number; y: number; bi: number; z: number }): number => {
    let near = Infinity;
    for (const t of taken) if (t.bi === c.bi && t.z === c.z || t.bi < 0 && c.bi < 0) near = Math.min(near, hypot2(t.x - c.x, t.y - c.y));
    return near;
  };
  const place = (gi: number, id: number, c: Cand, facing: number, move: boolean) => {
    taken.push({ x: c.x, y: c.y, bi: c.bi, z: c.z });
    for (let i = 0; i < N; i++) if (c.seen[i] === 1) union[i] = 1;
    const p: SitingPlace = { id, x: c.x, y: c.y, facing, move, seen: c.n };
    if (c.bi >= 0) {
      p.building = map.buildings[c.bi]!.id; p.windowIndex = c.win;
      inside[gi]!++;
      if (!inHouse.has(c.bi)) backDue[gi]!.push(c.bi);
      inHouse.set(c.bi, (inHouse.get(c.bi) ?? 0) + 1);
      if (c.floor > 0) { upstairs[gi]!++; upHouse.set(c.bi, (upHouse.get(c.bi) ?? 0) + 1); }
      const rk = `${c.bi}:${c.floor}:${c.room}`;
      inRoom.set(rk, (inRoom.get(rk) ?? 0) + 1);
    }
    result.push(p);
  };
  /** The back of house `bi`: the best covered outdoor spot `wallClearM`..`wallClearM + backM` from its walls, on its
   *  far side from the approach. */
  const backSpot = (bi: number, m: { x: number; y: number }): Cand | null => {
    const [hx, hy] = centreOf(bi);
    const dl = hypot2(fx - hx, fy - hy) || 1, ux = (fx - hx) / dl, uy = (fy - hy) / dl;
    let best: Cand | null = null, bestScore = -Infinity;
    const k = Math.ceil((S.wallClearM + S.backM + 10) / S.gridM);
    for (let dy = -k; dy <= k; dy++) for (let dx = -k; dx <= k; dx++) {
      const x = hx + dx * S.gridM, y = hy + dy * S.gridM;
      if (x < 1 || y < 1 || x > map.widthM - 1 || y > map.heightM - 1) continue;
      const c = backOf(x, y);
      if (!c) continue;
      const along = (c.x - hx) * ux + (c.y - hy) * uy, dw = distToOutline(map.buildings[bi]!.footprint, c.x, c.y);
      if (along >= 0 || dw < S.wallClearM || dw > S.wallClearM + S.backM || !clearOfHouses(c.x, c.y)) continue;
      const near = nearest(c);
      if (near < S.hardSpacingM) continue;
      const score = S.coverW * (1 - c.exp) - (c.exp >= 0.9 ? S.openPenalty : 0) - (near < S.spacingM ? (S.spacingM - near) * S.spacingPenalty : 0)
        + S.backBehindW * (-along / (hypot2(c.x - hx, c.y - hy) || 1)) - (S.distW * hypot2(c.x - m.x, c.y - m.y)) / searchM;
      if (score > bestScore) { bestScore = score; best = c; }
    }
    return best;
  };
  for (let more = true; more;) {
    more = false;
    groups.forEach((g, gi) => {
      const m = g.men[next[gi]!];
      if (!m) return;
      next[gi]!++; more = true;
      // The group's man after one takes a house: its back watcher (M7.5e).
      // (Not when re-siting around anchors, step 5: the house's back was seen to when it was first sited.)
      const due = anchors ? undefined : backDue[gi]!.shift();
      if (due !== undefined) {
        const c = backSpot(due, m);
        if (c) {
          const [hx, hy] = centreOf(due);
          place(gi, m.id, c, atan2(hy - fy, hx - fx), hypot2(c.x - m.x, c.y - m.y) > S.stayM);
          return;
        }
      }
      let best: Cand | null = null, bestScore = -Infinity;
      const anchor = anchors?.get(m.id);
      for (const c of lists[gi]!) {
        if (anchor !== undefined && hypot2(c.x - anchor.x, c.y - anchor.y) > anchor.r) continue;
        if (c.bi >= 0) {
          if (inside[gi]! >= maxIn[gi]! || (inHouse.get(c.bi) ?? 0) >= S.houseMax || (inRoom.get(`${c.bi}:${c.floor}:${c.room}`) ?? 0) >= S.roomMax) continue;
          if (c.floor > 0 && ((upHouse.get(c.bi) ?? 0) >= S.upperMax || upstairs[gi]! >= Math.ceil(maxIn[gi]! / 2))) continue;
          if (!inHouse.has(c.bi) && taken.some((t) => t.bi < 0 && distToOutline(map.buildings[c.bi]!.footprint, t.x, t.y) < S.wallClearM)) continue;
        } else if (!clearOfHouses(c.x, c.y)) continue;
        const near = nearest(c);
        if (near < S.hardSpacingM) continue;
        let gain = 0;
        for (let i = 0; i < N; i++) if (c.seen[i] === 1 && union[i] === 0) gain++;
        const cover = c.bi >= 0 ? S.windowCoverW : S.coverW * (1 - c.exp) - (c.exp >= 0.9 ? S.openPenalty : 0);
        const score = (c.n + S.gainW * gain) / Math.max(1, N) + cover
          - (near < S.spacingM ? (S.spacingM - near) * S.spacingPenalty : 0) - (S.distW * hypot2(c.x - m.x, c.y - m.y)) / searchM;
        if (score > bestScore) { bestScore = score; best = c; }
      }
      if (!best) { taken.push({ x: m.x, y: m.y, bi: -1, z: 0 }); result.push({ id: m.id, x: m.x, y: m.y, facing: NaN, move: false }); return; }
      if (best.bi >= 0) place(gi, m.id, best, best.heading, true);
      else place(gi, m.id, best, best.n > 0 ? atan2(best.ay, best.ax) : NaN, hypot2(best.x - m.x, best.y - m.y) > S.stayM);
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

/**
 * OVERWATCH POST of a dismounted missile team (M9.3b; game values, low confidence). Candidates on rings `ringsM`
 * around the team's anchor (`stepM` apart along each ring; at most `maxCands`, taken evenly), outdoors, passable,
 * with no house within the danger zone behind (toward the anchor side away from the enemy); each scored by the
 * share of target points (rings `targetRingsM` from the enemy's area, `targetArcDeg` either side of the way to the
 * anchor) between `targetRangeM` of it that its sight (`sightZ` above the ground) sees a hull's middle
 * (visibility >= `seenVisibility`), plus `coverW` x its cover; never within `nearM` of an enemy place (an objective
 * the enemy holds; for the defence, the enemy's expected area); review fix: the anchor itself and short rings are
 * candidates too, and each loses `perMinuteW` per minute of walk to it (at `walkMps`; the defence, whose enemy
 * takes minutes to come, `perMinuteDefenceW`). Returns the best post and up to two alternates
 * `altM` from it and from each other (the next posts it moves to after a launch), each facing the enemy's area.
 * Pure function of its inputs: deterministic.
 */
export const OVERWATCH = {
  ringsM: [0, 50, 100, 150, 200, 300, 400, 500, 600, 700, 800], stepM: 50, maxCands: 200, walkMps: 0.9, perMinuteW: 0.1, perMinuteDefenceW: 0.02,
  targetRingsM: [0, 200, 400], targetArcDeg: 45, targetArcStepDeg: 15, targetRangeM: [600, 1900], hullZ: 1.5, seenVisibility: 0.3,
  coverW: 0.2, nearM: 450, altM: [60, 150],
} as const;

export interface OverwatchPost { x: number; y: number; facing: number }

export function siteOverwatch(
  ctx: SimContext, anchor: { x: number; y: number }, enemy: { x: number; y: number }, sightZ: number,
  near: readonly { x: number; y: number }[], backM: number, defending = false,
  /** M7.6d: an automatic grenade launcher's post: its own range band and men's height for the target points. */
  o: { rangeM?: readonly [number, number]; targetZ?: number; targetRingsM?: readonly number[] } = {},
): OverwatchPost[] {
  const O = OVERWATCH, map = ctx.map, W = map.widthM, H = map.heightM;
  const band = o.rangeM ?? O.targetRangeM, tz = o.targetZ ?? O.hullZ;
  const { grid } = navFor(ctx, "foot");
  // Target points: around the enemy's area, on the side facing the anchor.
  const toAnchor = atan2(anchor.y - enemy.y, anchor.x - enemy.x);
  const targets: { x: number; y: number; z: number }[] = [];
  for (const r of o.targetRingsM ?? O.targetRingsM) for (let a = -O.targetArcDeg; a <= O.targetArcDeg + 1e-9; a += O.targetArcStepDeg) {
    const b = toAnchor + (a * PI) / 180, x = enemy.x + cos(b) * r, y = enemy.y + sin(b) * r;
    if (x < 5 || y < 5 || x > W - 5 || y > H - 5 || indoorAt(ctx, x, y) >= 0) continue;
    targets.push({ x, y, z: heightAt(map, x, y) + tz }); // ground: ok (a hull on open ground)
    if (r === 0) break;
  }
  const cands: { x: number; y: number }[] = [];
  for (const r of O.ringsM) {
    const n = r === 0 ? 1 : Math.max(8, Math.round((2 * PI * r) / O.stepM));
    for (let k = 0; k < n; k++) {
      const b = (2 * PI * k) / n, x = anchor.x + cos(b) * r, y = anchor.y + sin(b) * r;
      if (x < 10 || y < 10 || x > W - 10 || y > H - 10) continue;
      cands.push({ x, y });
    }
  }
  const stride = Math.max(1, Math.ceil(cands.length / O.maxCands));
  const scored: { x: number; y: number; score: number }[] = [];
  for (let i = 0; i < cands.length; i += stride) {
    const c = cands[i]!;
    if (navCostAt(grid, c.x, c.y) <= 0 || indoorAt(ctx, c.x, c.y) >= 0) continue;
    // The danger zone behind (away from the enemy) clear of houses.
    const away = atan2(c.y - enemy.y, c.x - enemy.x);
    if (indoorAt(ctx, c.x + cos(away) * backM * 0.5, c.y + sin(away) * backM * 0.5) >= 0 || indoorAt(ctx, c.x + cos(away) * backM, c.y + sin(away) * backM) >= 0) continue;
    const z0 = heightAt(map, c.x, c.y) + sightZ; // ground: ok (a post on open ground)
    let n = 0, m = 0;
    for (const t of targets) {
      const d = hypot2(t.x - c.x, t.y - c.y);
      if (d < band[0] || d > band[1]) continue;
      m++;
      if (sight(ctx, c.x, c.y, z0, t.x, t.y, t.z).visibility >= O.seenVisibility) n++;
    }
    if (m === 0) continue;
    if (near.some((p) => hypot2(p.x - c.x, p.y - c.y) < O.nearM)) continue;
    const walkMin = hypot2(c.x - anchor.x, c.y - anchor.y) / O.walkMps / 60;
    scored.push({ x: c.x, y: c.y, score: n / targets.length + O.coverW * (1 - exposureAt(grid, c.x, c.y)) - (defending ? O.perMinuteDefenceW : O.perMinuteW) * walkMin });
  }
  scored.sort((a, b) => b.score - a.score || a.x - b.x || a.y - b.y);
  const out: OverwatchPost[] = [];
  const face = (p: { x: number; y: number }) => atan2(enemy.y - p.y, enemy.x - p.x);
  const best = scored[0];
  if (!best) return out;
  out.push({ x: best.x, y: best.y, facing: face(best) });
  for (const s of scored) {
    if (out.length >= 3) break;
    const d0 = hypot2(s.x - best.x, s.y - best.y);
    if (d0 < O.altM[0] || d0 > O.altM[1] || out.some((p) => hypot2(p.x - s.x, p.y - s.y) < O.altM[0])) continue;
    out.push({ x: s.x, y: s.y, facing: face(s) });
  }
  return out;
}

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
}

export interface HullDownPost extends OverwatchPost { exposed?: true; score: number }

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
  const cands: { x: number; y: number }[] = [];
  for (const r of o.ringsM ?? D.ringsM) {
    const n = r === 0 ? 1 : Math.max(8, Math.round((2 * PI * r) / D.stepM));
    for (let k = 0; k < n; k++) {
      const b = (2 * PI * k) / n, x = anchor.x + cos(b) * r, y = anchor.y + sin(b) * r;
      if (x < 10 || y < 10 || x > W - 10 || y > H - 10) continue;
      cands.push({ x, y });
    }
  }
  const stride = Math.max(1, Math.ceil(cands.length / D.maxCands));
  const s2 = o.standoffM * o.standoffM;
  const scored: { x: number; y: number; score: number }[] = [];
  const fallback: { x: number; y: number; score: number }[] = [];
  const vegH = (x: number, y: number): number => {
    const c = Math.min(Math.floor(x / map.cellSizeM), map.cols - 1), r = Math.min(Math.floor(y / map.cellSizeM), map.rows - 1);
    const vi = map.vegetation[r * map.cols + c] ?? 0;
    return vi > 0 ? ctx.catalog.terrain.vegetation[map.vegetationPalette[vi - 1] ?? ""]?.heightM ?? 0 : 0;
  };
  for (let i = 0; i < cands.length; i += stride) {
    const c = cands[i]!;
    if (navCostAt(grid, c.x, c.y) <= 0 || indoorAt(ctx, c.x, c.y) >= 0) continue;
    if (o.vegMaxM !== undefined && vegH(c.x, c.y) >= o.vegMaxM) continue;
    if (region > 0 && regionAt(c.x, c.y) !== region) continue;
    if (o.behind && (c.x - o.behind.x) * o.behind.ux + (c.y - o.behind.y) * o.behind.uy < o.behind.minM) continue;
    let minD2 = Infinity;
    for (const t of o.threats) { const d2 = (t.x - c.x) * (t.x - c.x) + (t.y - c.y) * (t.y - c.y); if (d2 < minD2) minD2 = d2; }
    if (minD2 < s2) { fallback.push({ x: c.x, y: c.y, score: minD2 }); continue; }
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
    scored.push({ x: c.x, y: c.y, score });
  }
  const face = (p: { x: number; y: number }) => atan2(my - p.y, mx - p.x);
  // (None keeps the standoff: those farthest from the nearest threat, flagged exposed.)
  const exposed = scored.length === 0;
  const list = exposed ? fallback : scored;
  if (list.length === 0) return [];
  list.sort((a, b) => b.score - a.score || a.x - b.x || a.y - b.y);
  const best = list[0]!;
  const post = (p: { x: number; y: number; score: number }): HullDownPost => ({ x: p.x, y: p.y, facing: face(p), score: exposed ? 0 : p.score, ...(exposed ? { exposed: true as const } : {}) });
  const out: HullDownPost[] = [post(best)];
  for (const s of list) {
    if (out.length >= 3) break;
    const d0 = hypot2(s.x - best.x, s.y - best.y);
    if (d0 < HULL_DOWN.altM[0] || d0 > HULL_DOWN.altM[1] || out.some((p) => hypot2(p.x - s.x, p.y - s.y) < HULL_DOWN.altM[0])) continue;
    out.push(post(s));
  }
  return out;
}
