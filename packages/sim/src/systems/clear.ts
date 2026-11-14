/**
 * CLEARING A HOUSE (M7.5e step "clear", owner 2026-11-14: "suppress the windows, get close, throw a grenade through
 * a window or door, then enter room by room"). An `assault` order with a `building` starts the drill "clear":
 *
 *   close    The two halves bound up as in any assault (drills.ts), onto the point outside the chosen door; the
 *            covering half fires at the enemy it knows in the house, else at the windows facing it.
 *   stack    Within the last rush the men stack up beside the door, `clearStackOffM` off the wall, from
 *            `clearStackAsideM` beside the opening on both sides (not in front of it).
 *   throw    A man with a hand grenade goes to a place from which it gets into the room behind (beside the door,
 *            else beside a window of that room, else in front of the door; inside: beside, else in, the doorway of a
 *            room already cleared on the same floor) and throws it into the room's far part, the men near where it
 *            will burst getting away first. No man and no place with a throw (the stairs): in without one.
 *   wait     Until the burst and `clearAfterBurstS` after it.
 *   enter    `clearEntryMen` (the nearest) run in, firing as they go, to places in that room; the others follow to
 *            the rooms already cleared. Then the next room: rooms nearest the door first (breadth first over the
 *            interior graph), the ground floor before the stairs, a room with an enemy known in it first among
 *            equals, then by index.
 * Done when every room was entered ("house clear"), or after `clearTimeoutS`, or below `clearMinMen` able men.
 * The men stay where they are; the AI commander decides what holds the house (D9).
 */
import type { ClearStage, Drill, Unit } from "../components";
import type { SimContext } from "../context";
import type { EventSink } from "../events";
import { secondsToTicks, type EntityId } from "../ids";
import { isAble } from "../impair";
import { exteriorDoors, roomAt, wallPoint } from "../interior";
import { floorAtZ, indoorAt, indoorSpots, interiorGraph, routeBetween, routeWaypoints } from "../interior-nav";
import { atan2, hypot2 } from "../math";
import { navCostAt } from "../nav";
import { lineBlocked } from "../ballistics";
import { heightAt, standZ } from "../terrain";
import { navFor } from "../navctx";
import type { Posture, Waypoint } from "../orders";
import type { SimState } from "../state";
import { startAction } from "../actions";
import { throwArcExists } from "./grenades";
import { buildingIndex, windowPlaces } from "./occupy";
import { isCowering } from "./morale";

/** Can building `id` be cleared: an interior with a way in? */
export function clearable(ctx: SimContext, id: number): boolean {
  const bi = buildingIndex(ctx, id);
  if (bi < 0) return false;
  const g = interiorGraph(ctx, bi);
  return g !== null && g.nodes.some((n) => n.exit);
}

const able = (state: SimState, m: EntityId) => { const s = state.soldier.get(m); return isAble(s) && s!.mental.behaviour !== "routed"; };

function centreOf(poly: readonly number[]): { x: number; y: number } {
  let x = 0, y = 0;
  const n = poly.length / 2;
  for (let i = 0; i < n; i++) { x += poly[i * 2]!; y += poly[i * 2 + 1]!; }
  return { x: x / n, y: y / n };
}

/** The middle of building `bi` (its footprint's corners). */
export function houseCentre(ctx: SimContext, bi: number): { x: number; y: number } {
  return centreOf(ctx.map.buildings[bi]!.footprint);
}

/** The middle of room `r` of building `bi` and its height above the ground. */
function roomCentre(ctx: SimContext, bi: number, r: number): { x: number; y: number; z: number; floor: number } {
  const b = ctx.map.buildings[bi]!, rm = b.interior!.rooms[r]!;
  const c = centreOf(rm.poly);
  return { ...c, z: rm.floor * b.storeyHeightM, floor: rm.floor };
}

/** The enemies these men know inside building `bi` (seen or reported within `withinS`), by room. */
function knownRooms(ctx: SimContext, state: SimState, men: readonly EntityId[], bi: number, withinS: number): Set<number> {
  const out = new Set<number>();
  const b = ctx.map.buildings[bi]!, recent = secondsToTicks(withinS);
  for (const m of men) {
    const s = state.soldier.get(m);
    if (!s) continue;
    for (const c of s.contacts) {
      if (c.down === true || c.surrendered === true || c.cls === "vehicle" || state.tick - c.tick > recent) continue;
      if (indoorAt(ctx, c.x, c.y) !== bi) continue;
      const r = roomAt(b, floorAtZ(b, c.z ?? 0), c.x, c.y);
      if (r >= 0) out.add(r);
    }
  }
  return out;
}

/**
 * The order the rooms are cleared in (D6): breadth first over the interior graph from the entry door's room; the
 * ground floor before the floors above, nearer rooms first, a room with an enemy known in it first among equals,
 * then by index. Rooms the graph does not reach are left out.
 */
export function roomOrder(ctx: SimContext, bi: number, entryRoom: number, enemyRooms: ReadonlySet<number>): number[] {
  const b = ctx.map.buildings[bi]!, g = interiorGraph(ctx, bi)!, it = b.interior!;
  const nr = it.rooms.length;
  const adj: number[][] = it.rooms.map(() => []);
  for (let k = 0; k + 1 < g.through.length; k += 2) {
    const ra = g.nodes[g.through[k]!]!.room, rc = g.nodes[g.through[k + 1]!]!.room;
    if (ra === rc) continue;
    if (!adj[ra]!.includes(rc)) adj[ra]!.push(rc);
    if (!adj[rc]!.includes(ra)) adj[rc]!.push(ra);
  }
  const depth = new Array<number>(nr).fill(-1);
  depth[entryRoom] = 0;
  const queue = [entryRoom];
  for (let q = 0; q < queue.length; q++) {
    const r = queue[q]!;
    for (const v of [...adj[r]!].sort((a, c) => a - c)) if (depth[v]! < 0) { depth[v] = depth[r]! + 1; queue.push(v); }
  }
  const rooms: number[] = [];
  for (let r = 0; r < nr; r++) if (depth[r]! >= 0) rooms.push(r);
  rooms.sort((a, c) => it.rooms[a]!.floor - it.rooms[c]!.floor || depth[a]! - depth[c]! || (enemyRooms.has(a) ? 0 : 1) - (enemyRooms.has(c) ? 0 : 1) || a - c);
  // The entry room always first.
  return [entryRoom, ...rooms.filter((r) => r !== entryRoom)];
}

/** The outward frame of an exit node: the door's centre on the wall, the outward normal, along the wall, half its width. */
function exitFrame(ctx: SimContext, bi: number, node: number): { wx: number; wy: number; nx: number; ny: number; ux: number; uy: number; half: number } {
  const b = ctx.map.buildings[bi]!, n = interiorGraph(ctx, bi)!.nodes[node]!;
  let nx = n.ox - n.x, ny = n.oy - n.y;
  const l = hypot2(nx, ny) || 1;
  nx /= l; ny /= l;
  // (The door it belongs to, for its width; a hole blown in the wall: about a metre.)
  let half = 0.5, bd = 0.3;
  for (const d of exteriorDoors(b)) { const dd = hypot2(d.ix - n.x, d.iy - n.y); if (dd < bd) { bd = dd; half = d.widthM / 2; } }
  return { wx: n.x + nx * 0.45, wy: n.y + ny * 0.45, nx, ny, ux: -ny, uy: nx, half };
}

/**
 * The drill for an assault on building `id` (an order with `building`): the entry door is the one whose outside is
 * in front of the fewest of the house's windows on other walls (seen least from inside), then the nearest to the
 * unit; the drill's point (x, y) is just outside it.
 */
export function startClear(ctx: SimContext, state: SimState, uid: EntityId, id: number, groups: EntityId[][]): Drill {
  const bi = buildingIndex(ctx, id), g = interiorGraph(ctx, bi)!;
  const men = groups.flat();
  let cx = 0, cy = 0;
  for (const m of men) { const t = state.transform.req(m); cx += t.x / men.length; cy += t.y / men.length; }
  const wins = windowPlaces(ctx, bi);
  let entry = -1, best = Infinity;
  g.nodes.forEach((n, i) => {
    if (!n.exit) return;
    let seen = 0;
    for (const w of wins) if ((n.ox - w.x) * w.normalX + (n.oy - w.y) * w.normalY > 1.5 && hypot2(n.ox - w.x, n.oy - w.y) < 40) seen++;
    const score = hypot2(n.ox - cx, n.oy - cy) + 15 * seen;
    if (score < best) { best = score; entry = i; }
  });
  const e = g.nodes[entry]!;
  const rooms = roomOrder(ctx, bi, e.room, knownRooms(ctx, state, men, bi, 60));
  void uid;
  return { kind: "clear", x: e.ox, y: e.oy, groups, mover: 0, phaseTick: -1, final: false, building: id, entry, rooms, room: 0 };
}

/** Send a man to (x, y) at height gz (his floor there) at `mode`; he ends in `posture` facing `heading`. */
function goTo(ctx: SimContext, state: SimState, m: EntityId, x: number, y: number, gz: number, heading: number | null, posture: Posture, mode = "run"): boolean {
  const t = state.transform.req(m), mv = state.mover.get(m);
  if (!mv) return false;
  const leg = routeBetween(ctx, navFor(ctx, "foot").search, t.x, t.y, x, y, { maxExpansions: 8000, snapCells: 3 }, { sz: t.z, gz });
  if (!leg) return false;
  mv.waypoints = routeWaypoints<Waypoint>(leg, { x: 0, y: 0, mode });
  // (Outdoors by a wall the route grid stops a cell short: the last steps to the spot are walked, unless a wall or
  // the house is in the way.)
  const gx = leg.goalX, gy = leg.goalY;
  if (gz === 0 && indoorAt(ctx, x, y) < 0 && (gx !== x || gy !== y) && hypot2(gx - x, gy - y) <= 3) {
    let clear = true;
    for (let k = 1; k <= 4 && clear; k++) if (indoorAt(ctx, gx + ((x - gx) * k) / 4, gy + ((y - gy) * k) / 4) >= 0) clear = false;
    if (clear && !lineBlocked(ctx.ballistics, ctx.map, ctx.mapIndex, gx, gy, heightAt(ctx.map, gx, gy) + 0.5, x, y, heightAt(ctx.map, x, y) + 0.5, 0)) mv.waypoints.push({ x, y, mode }); // ground: ok (a knee-high line over the last steps)
  }
  mv.formation = null;
  mv.endPosture = posture;
  mv.endHeading = heading;
  state.soldier.req(m).homePosture = posture;
  return true;
}

function setStage(state: SimState, d: Drill, stage: ClearStage): void {
  d.stage = stage;
  d.stageTick = state.tick;
}

/** The last rush (drills.ts calls this instead of the assault's): the men stack up beside the entry door. */
export function beginStack(ctx: SimContext, state: SimState, d: Drill, all: readonly EntityId[], radio: (key: string) => void): void {
  const D = ctx.catalog.behaviour.drills;
  const bi = buildingIndex(ctx, d.building!);
  d.final = true;
  setStage(state, d, "stack");
  d.startTick = state.tick;
  const f = exitFrame(ctx, bi, d.entry!);
  const face = atan2(-f.ny, -f.nx); // (toward the wall: the door beside him)
  let k = 0;
  for (const m of all) {
    // (Both sides of the door in turn, one man behind another along the wall; a spot he cannot stand on is skipped.)
    for (let tries = 0; tries < 12; tries++) {
      const side = k % 2 === 0 ? 1 : -1, rank = Math.floor(k / 2);
      k++;
      const a = f.half + D.clearStackAsideM + rank * 1.2;
      const x = f.wx + f.nx * D.clearStackOffM + f.ux * side * a, y = f.wy + f.ny * D.clearStackOffM + f.uy * side * a;
      if (!standable(ctx, x, y, f.nx, f.ny)) continue;
      state.fire.delete(m);
      goTo(ctx, state, m, x, y, 0, face + (side > 0 ? 0.6 : -0.6), "crouching");
      break;
    }
  }
  radio("radio.clearing");
}

/** A thrown hand grenade he carries (its id and how many), or null. */
function handGrenade(ctx: SimContext, state: SimState, m: EntityId): { ammo: string; n: number } | null {
  const c = state.container.get(m);
  if (!c) return null;
  const st = [...c.stacks].sort((a, b) => (a.type < b.type ? -1 : a.type > b.type ? 1 : 0)).find((x) => x.count > 0 && ctx.catalog.ammo[x.type]?.delivery?.method === "thrown" && ctx.catalog.ammo[x.type]?.explosive);
  return st ? { ammo: st.type, n: st.count } : null;
}

function countOf(state: SimState, m: EntityId, ammo: string): number {
  return state.container.get(m)?.stacks.filter((x) => x.type === ammo).reduce((a, x) => a + x.count, 0) ?? 0;
}

/** A place a grenade may be thrown from, the posture, and (in line with the opening) where he steps aside after. */
interface ThrowPlace { x: number; y: number; z: number; pose: Posture; aside?: [number, number, number] }

/**
 * The places a grenade into room `r` may be thrown from, in order of preference. From outside (the first room):
 * beside the door, beside each ground-floor window of the room, in front of the door (then aside). Inside: from the
 * doorway of a room already cleared on the same floor (then aside, out of the line through it: blast and fragments
 * come out through the opening). Up or down the stairs no throw: a grenade lobbed up a stairwell comes down again.
 */
function throwPlaces(ctx: SimContext, bi: number, d: Drill, r: number): ThrowPlace[] {
  const D = ctx.catalog.behaviour.drills, b = ctx.map.buildings[bi]!, g = interiorGraph(ctx, bi)!;
  const out: ThrowPlace[] = [];
  const done = new Set(d.rooms!.slice(0, d.room!));
  if (done.size === 0) {
    const f = exitFrame(ctx, bi, d.entry!);
    const beside = (side: number): [number, number, number] => [f.wx + f.nx * D.clearStackOffM + f.ux * side * (f.half + 0.6), f.wy + f.ny * D.clearStackOffM + f.uy * side * (f.half + 0.6), 0];
    for (const side of [1, -1]) { const [x, y] = beside(side); if (standable(ctx, x, y, f.nx, f.ny)) out.push({ x, y, z: 0, pose: "crouching" }); }
    const fp = b.footprint;
    for (const o of b.openings) {
      if (o.kind !== "window" || (o.floor ?? 0) !== 0) continue;
      const w = wallPoint(fp, o.wall, o.offsetM, o.widthM, 0.5, D.clearStackOffM);
      if (roomAt(b, 0, w.ix, w.iy) !== r) continue;
      const nx = w.ox - w.x, ny = w.oy - w.y, l = hypot2(nx, ny) || 1, ux = -ny / l, uy = nx / l;
      for (const side of [1, -1]) {
        const a = o.widthM / 2 + 0.6, x = w.ox + ux * side * a, y = w.oy + uy * side * a;
        if (standable(ctx, x, y, nx / l, ny / l)) out.push({ x, y, z: 0, pose: "standing" });
      }
    }
    const fx = f.wx + f.nx * 2.5, fy = f.wy + f.ny * 2.5;
    if (standable(ctx, fx, fy, f.nx, f.ny)) out.push({ x: fx, y: fy, z: 0, pose: "crouching", aside: beside(1) });
  } else {
    const it = b.interior!;
    for (let k = 0; k + 1 < g.through.length; k += 2) for (const [p, q] of [[g.through[k]!, g.through[k + 1]!], [g.through[k + 1]!, g.through[k]!]] as const) {
      const np = g.nodes[p]!, nq = g.nodes[q]!;
      if (nq.room !== r || !done.has(np.room) || np.floor !== nq.floor) continue;
      const cx = (np.x + nq.x) / 2, cy = (np.y + nq.y) / 2;
      let nx = np.x - nq.x, ny = np.y - nq.y;
      const l = hypot2(nx, ny) || 1;
      nx /= l; ny /= l;
      // (The doorway's width, from its wall.)
      let half = 0.45;
      for (const w of it.walls) {
        if (w.floor !== np.floor) continue;
        const wl = hypot2(w.bx - w.ax, w.by - w.ay) || 1;
        for (const dr of w.doors) {
          const dx = w.ax + ((w.bx - w.ax) * dr.offsetM) / wl, dy = w.ay + ((w.by - w.ay) * dr.offsetM) / wl;
          if (hypot2(dx - cx, dy - cy) < 0.3) half = dr.widthM / 2;
        }
      }
      let aside: [number, number, number] | undefined;
      for (const side of [1, -1]) {
        const x = cx + nx * 0.6 - ny * side * (half + 0.5), y = cy + ny * 0.6 + nx * side * (half + 0.5);
        if (!aside && roomAt(b, np.floor, x, y) === np.room) aside = [x, y, np.z];
      }
      out.push({ x: np.x, y: np.y, z: np.z, pose: "crouching", ...(aside ? { aside } : {}) });
    }
  }
  return out;
}

/**
 * Can a man stand at (x, y) outdoors by a wall whose outward normal is (nx, ny): in the map, not indoors, and the
 * ground open there or 2 m further out (the route grid's cells along a wall count as blocked; the last steps to
 * the wall are walked).
 */
function standable(ctx: SimContext, x: number, y: number, nx: number, ny: number): boolean {
  if (x < 1 || y < 1 || x > ctx.map.widthM - 1 || y > ctx.map.heightM - 1 || indoorAt(ctx, x, y) >= 0) return false;
  const grid = navFor(ctx, "foot").grid;
  return navCostAt(grid, x, y) > 0 || navCostAt(grid, x + nx * 2, y + ny * 2) > 0;
}

/**
 * Where in room `r` a grenade thrown from `p` is aimed: its corners drawn `AIM_IN_M` in toward its middle, the
 * farthest from him first, then the middle.
 */
function aimPoints(ctx: SimContext, bi: number, r: number, p: { x: number; y: number }): { x: number; y: number }[] {
  const rm = ctx.map.buildings[bi]!.interior!.rooms[r]!, c = centreOf(rm.poly), n = rm.poly.length / 2;
  const out: { x: number; y: number }[] = [];
  for (let k = 0; k < n; k++) {
    const vx = rm.poly[k * 2]!, vy = rm.poly[k * 2 + 1]!, l = hypot2(c.x - vx, c.y - vy);
    if (l <= AIM_IN_M * 1.5) continue;
    out.push({ x: vx + ((c.x - vx) * AIM_IN_M) / l, y: vy + ((c.y - vy) * AIM_IN_M) / l });
  }
  out.sort((a, b) => hypot2(b.x - p.x, b.y - p.y) - hypot2(a.x - p.x, a.y - p.y) || a.x - b.x || a.y - b.y);
  return [...out.slice(0, 2), c];
}

/** How far in from a room's corner a grenade is aimed, m. */
const AIM_IN_M = 0.9;

/**
 * The next room: a man with a hand grenade who has a throw into it from one of its throw places (the nearest man
 * to each place in turn, starting at `d.tried`), sent there; none: straight in.
 */
function prepareThrow(ctx: SimContext, state: SimState, d: Drill, all: readonly EntityId[]): void {
  const bi = buildingIndex(ctx, d.building!), r = d.rooms![d.room!]!;
  const places = throwPlaces(ctx, bi, d, r);
  const holders = all.filter((m) => !isCowering(state.soldier.req(m)) && state.soldier.req(m).impair.canUseArms && handGrenade(ctx, state, m) !== null);
  delete d.thrower; delete d.throwAt; delete d.ammo; delete d.burstTick; delete d.aimAt; delete d.aside;
  for (let i = d.tried ?? 0; i < places.length; i++) {
    const p = places[i]!;
    let man = -1, md = Infinity;
    for (const m of holders) { const t = state.transform.req(m); const dd = hypot2(t.x - p.x, t.y - p.y) + Math.abs(t.z - p.z) * 3; if (dd < md) { md = dd; man = m; } }
    if (man < 0) break;
    const g = handGrenade(ctx, state, man)!;
    // (Into the far part of the room first: the farther from him the burst, the less of it reaches him.)
    const at = aimPoints(ctx, bi, r, p).find((q) => throwArcExists(ctx, state, man, g.ammo, q.x, q.y, p, p.pose));
    if (!at) continue;
    d.tried = i + 1;
    d.thrower = man; d.throwAt = [p.x, p.y, p.z]; d.ammo = g.ammo; d.had = -1; d.aimAt = [at.x, at.y];
    if (p.aside) d.aside = p.aside; else delete d.aside;
    state.fire.delete(man);
    goTo(ctx, state, man, p.x, p.y, p.z, atan2(at.y - p.y, at.x - p.x), p.pose);
    setStage(state, d, "throw");
    return;
  }
  // (No throw into it: the men go in under their own fire.)
  d.burstTick = state.tick;
  setStage(state, d, "wait");
}

/**
 * Before a grenade goes into a room: the other men of the unit within `CLEAR_OF_M` of where it is aimed, with nothing
 * solid between, move to the nearest place in the rooms already cleared that far from it, or behind a wall.
 */
function clearOfBurst(ctx: SimContext, state: SimState, all: readonly EntityId[], thrower: EntityId, bi: number, ax: number, ay: number, az: number, done: readonly number[]): void {
  const B = ctx.ballistics, map = ctx.map, shield = ctx.catalog.ballistics.blast.shieldSteelMm;
  const g0 = heightAt(map, ax, ay) + az + 0.2; // ground: ok (the burst's height on its floor)
  const exposed = (x: number, y: number, z: number) => hypot2(x - ax, y - ay) < CLEAR_OF_M && !lineBlocked(B, map, ctx.mapIndex, ax, ay, g0, x, y, standZ(map, { x, y, z }) + 0.6, shield);
  const b = ctx.map.buildings[bi]!;
  const c = centreOf(b.footprint);
  let spots: { x: number; y: number; z: number; heading: number }[] | null = null;
  const taken: { x: number; y: number; z: number }[] = [];
  for (const m of all) {
    if (m === thrower) continue;
    const t = state.transform.req(m);
    if (!exposed(t.x, t.y, t.z) || state.action.has(m)) continue;
    spots ??= indoorSpots(ctx, bi, c.x, c.y, 40, floorAtZ(b, t.z)).filter((p) => done.includes(roomAt(b, floorAtZ(b, p.z), p.x, p.y)) && !exposed(p.x, p.y, p.z));
    let best = -1, bd = Infinity;
    spots.forEach((p, i) => {
      if (taken.some((q) => hypot2(q.x - p.x, q.y - p.y) < 1 && Math.abs(q.z - p.z) < 1)) return;
      const dd = hypot2(p.x - t.x, p.y - t.y) + Math.abs(p.z - t.z) * 3;
      if (dd < bd) { bd = dd; best = i; }
    });
    if (best < 0 || bd > 12) continue;
    const p = spots[best]!;
    taken.push(p);
    goTo(ctx, state, m, p.x, p.y, p.z, p.heading, "crouching");
  }
}

/** Men nearer than this to where a grenade is aimed, with nothing solid between, get away first, m. */
const CLEAR_OF_M = 5;

/** The men going in: `clearEntryMen` nearest the room, to places in it, firing as they go; the others follow. */
function enterRoom(ctx: SimContext, state: SimState, d: Drill, all: readonly EntityId[], fire: (m: EntityId, at: { x: number; y: number }) => void): void {
  const D = ctx.catalog.behaviour.drills, bi = buildingIndex(ctx, d.building!), r = d.rooms![d.room!]!;
  const aim = roomCentre(ctx, bi, r);
  const ready = all.filter((m) => !isCowering(state.soldier.req(m)) && state.soldier.req(m).impair.canWalk);
  const dist = (m: EntityId) => { const t = state.transform.req(m); return hypot2(t.x - aim.x, t.y - aim.y) + Math.abs(t.z - aim.z) * 3; };
  const team = [...ready].sort((a, c) => dist(a) - dist(c) || a - c).slice(0, D.clearEntryMen);
  d.entryMen = team;
  const spots = indoorSpots(ctx, bi, aim.x, aim.y, team.length, aim.floor);
  team.forEach((m, i) => {
    const p = spots[i % Math.max(1, spots.length)];
    if (!p) return;
    goTo(ctx, state, m, p.x, p.y, p.z, p.heading, "crouching");
    fire(m, aim);
  });
  // The others to the rooms already cleared (not before the first room is entered: they wait at the door).
  const done = d.rooms!.slice(0, d.room!);
  if (done.length === 0) return;
  const from = roomCentre(ctx, bi, done[done.length - 1]!);
  const rest = all.filter((m) => !team.includes(m) && state.soldier.req(m).impair.canWalk);
  const b = ctx.map.buildings[bi]!;
  const inDone = (m: EntityId) => { const t = state.transform.req(m); if (indoorAt(ctx, t.x, t.y) !== bi) return false; const rr = roomAt(b, floorAtZ(b, t.z), t.x, t.y); return done.includes(rr); };
  const go = rest.filter((m) => !inDone(m) && (state.mover.get(m)?.waypoints.length ?? 0) === 0);
  if (go.length === 0) return;
  const places = indoorSpots(ctx, bi, from.x, from.y, go.length + team.length + 4, from.floor)
    .filter((p) => { const rr = roomAt(b, floorAtZ(b, p.z), p.x, p.y); return done.includes(rr); });
  // (Places not already taken by a man of the unit.)
  const taken = all.filter((m) => inDone(m)).map((m) => state.transform.req(m));
  const free = places.filter((p) => !taken.some((t) => hypot2(t.x - p.x, t.y - p.y) < 1 && Math.abs(t.z - p.z) < 1));
  go.forEach((m, i) => {
    const p = free[i];
    if (!p) return;
    goTo(ctx, state, m, p.x, p.y, p.z, p.heading, "crouching");
  });
}

/**
 * One step of a clearing after its bounds (drills.ts calls it while `d.stage` is set). `fire`: assault fire on the
 * move at a point; `radio`: a radio call of the unit.
 */
export function stepClear(ctx: SimContext, state: SimState, u: Unit, d: Drill, events: EventSink, fire: (m: EntityId, at: { x: number; y: number }) => void, radio: (key: string) => void): void {
  const D = ctx.catalog.behaviour.drills, tick = state.tick;
  const all = d.groups.flat().filter((m) => able(state, m)).sort((a, b) => a - b);
  const moving = (m: EntityId) => (state.mover.get(m)?.waypoints.length ?? 0) > 0;
  if (all.length < D.clearMinMen || tick - (d.startTick ?? tick) >= secondsToTicks(D.clearTimeoutS)) { u.drill = null; return; }
  const since = tick - (d.stageTick ?? tick);
  switch (d.stage) {
    case "stack":
      if (!all.some(moving) || since >= secondsToTicks(D.clearStackWaitS)) { d.tried = 0; prepareThrow(ctx, state, d, all); }
      return;
    case "throw": {
      const m = d.thrower;
      if (m === undefined || !able(state, m) || d.ammo === undefined) { prepareThrow(ctx, state, d, all); return; }
      const s = state.soldier.req(m), act = state.action.get(m);
      if (act?.kind === "grenade") return;
      if (d.had! >= 0) {
        // The throw is over: out of his hand (the burst after its fuse), or kept (no way to get it there).
        if (countOf(state, m, d.ammo) < d.had!) {
          const fuse = ctx.catalog.ammo[d.ammo]?.explosive?.fuseSeconds ?? 4;
          d.burstTick = tick + secondsToTicks(fuse);
          // (Thrown from in line with the opening: a step aside, out of the burst's way through it.)
          if (d.aside) { const t = state.transform.req(m); goTo(ctx, state, m, d.aside[0], d.aside[1], d.aside[2], t.heading, "crouching"); }
          setStage(state, d, "wait");
        } else prepareThrow(ctx, state, d, all);
        return;
      }
      if (since >= secondsToTicks(D.clearThrowWaitS)) { d.burstTick = tick; setStage(state, d, "wait"); return; }
      if (moving(m) || s.postureTo !== null || s.evade !== null || tick < s.stunnedUntilTick || isCowering(s)) return;
      const bi = buildingIndex(ctx, d.building!), rc = roomCentre(ctx, bi, d.rooms![d.room!]!);
      const aim = d.aimAt ? { x: d.aimAt[0], y: d.aimAt[1] } : rc;
      const pose = d.throwAt && d.throwAt[2] === 0 && indoorAt(ctx, d.throwAt[0], d.throwAt[1]) < 0 ? "standing" : "crouching";
      const t = state.transform.req(m);
      t.heading = atan2(aim.y - t.y, aim.x - t.x);
      d.had = countOf(state, m, d.ammo);
      state.fire.delete(m);
      clearOfBurst(ctx, state, all, m, bi, aim.x, aim.y, rc.z, d.rooms!.slice(0, d.room!));
      startAction(state, events, m, "grenade", secondsToTicks(ctx.catalog.shooting.grenades.throwSeconds), { ammo: d.ammo, x: aim.x, y: aim.y, pose, post: 1 });
      return;
    }
    case "wait":
      if (tick >= (d.burstTick ?? tick) + secondsToTicks(D.clearAfterBurstS)) { enterRoom(ctx, state, d, all, fire); setStage(state, d, "enter"); }
      return;
    case "enter": {
      const team = (d.entryMen ?? []).filter((m) => able(state, m));
      const there = team.length === 0 || !team.some(moving);
      // (In the room: an enemy seen in it a moment ago is fought before the next room.)
      const bi = buildingIndex(ctx, d.building!);
      const fight = there && knownRooms(ctx, state, team, bi, 2).has(d.rooms![d.room!]!);
      if ((there && !fight) || since >= secondsToTicks(D.clearRoomS)) {
        d.room = d.room! + 1;
        delete d.entryMen;
        if (d.room >= d.rooms!.length) { u.drill = null; radio("radio.houseCleared"); return; }
        d.tried = 0;
        prepareThrow(ctx, state, d, all);
      }
      return;
    }
    default:
      return;
  }
}
