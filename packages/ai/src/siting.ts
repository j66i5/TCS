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
  standZ, windowPlaces, type SimContext,
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
export function siteDefence(ctx: SimContext, groups: readonly SitingGroup[], pts: readonly { x: number; y: number }[], searchM: number = SITING.searchM, opts: SitingOptions = {}): SitingPlace[] {
  const S = SITING, map = ctx.map, foot = navFor(ctx, "foot").grid;
  const N = pts.length;
  const eye = eyeHeightM(ctx, "prone"), tz = ctx.catalog.body.postures.crouching.heightM * 0.8;
  const ptz = pts.map((p) => heightAt(map, p.x, p.y) + tz); // ground: ok (the approach's open ground)
  const seenFrom = (x: number, y: number, z0: number): { seen: Uint8Array; n: number; ax: number; ay: number } => {
    const seen = new Uint8Array(N);
    let n = 0, ax = 0, ay = 0;
    for (let i = 0; i < N; i++) {
      const p = pts[i]!;
      if (sight(ctx, x, y, z0, p.x, p.y, ptz[i]!).visibility >= S.seenVisibility) {
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
  const lists = groups.map((g) => {
    const out: Cand[] = [];
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
    if (useWindows) map.buildings.forEach((b, bi) => {
      if (!b.interior || distToOutline(b.footprint, g.cx, g.cy) > searchM && !pointInPolygon(b.footprint, g.cx, g.cy)) return;
      for (const c of windowsOf(bi)) if (!g.ring || hypot2(c.x - g.ring.x, c.y - g.ring.y) <= g.ring.r + S.windowRingSlackM) out.push(c);
    });
    return out;
  });
  // The way the attack comes, as these points show it (for the back watchers).
  let fx = 0, fy = 0;
  for (const p of pts) { fx += p.x / Math.max(1, N); fy += p.y / Math.max(1, N); }
  const union = new Uint8Array(N);
  /** Places taken: where, on which level (building index and height; -1 / 0 outdoors). */
  const taken: { x: number; y: number; bi: number; z: number }[] = [];
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
    const p: SitingPlace = { id, x: c.x, y: c.y, facing, move };
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
      const due = backDue[gi]!.shift();
      if (due !== undefined) {
        const c = backSpot(due, m);
        if (c) {
          const [hx, hy] = centreOf(due);
          place(gi, m.id, c, atan2(hy - fy, hx - fx), hypot2(c.x - m.x, c.y - m.y) > S.stayM);
          return;
        }
      }
      let best: Cand | null = null, bestScore = -Infinity;
      for (const c of lists[gi]!) {
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
