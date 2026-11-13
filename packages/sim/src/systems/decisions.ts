/**
 * SOLDIER DECISIONS (M4.2, SPEC 8): what a man does on his own, between his orders.
 *
 *   engage     He fires at an enemy he can see, within the range his weapon is used at, if his unit's fire rule
 *              allows: "free" any time, "return" once his unit has been fired upon (in the last 30 s), "hold"
 *              never. A cease-fire order holds until the unit is fired upon again. He picks the enemy who
 *              matters most: near, firing, standing. He stops when he has lost sight of him for a while.
 *              An order always comes first: he never replaces a fire task he was ordered to carry out.
 *   cover      Halted and under fire, and the enemy he knows of can see him where he lies: he runs to the
 *              nearest spot within 15 m where that enemy cannot, preferring one he can fire from on his knees.
 *   bringAmmo  A comrade has run out of spare magazines or belts: the nearest man within 30 m who has spare
 *              (more than he keeps for himself) or carries them for him runs over and hands one over.
 *
 * He never fires on his own at, nor takes cover from, an enemy he KNOWS has given up (the `surrendered` flag on
 * his own contact, M6.6) — the enemy's real state is not read for that.
 *
 * Every man decides once per `decisions.stepSeconds`, staggered by ID; values are data (core/behaviour.json).
 * Casualty care (dragging, first aid) comes with the medical system.
 */
import { startAction } from "../actions";
import type { Contact, Intent, SoldierState, Unit } from "../components";
import type { Posture } from "../orders";
import { countItems, type Container } from "../items";
import type { SimContext } from "../context";
import { indoorAt, indoorSpots, routeBetween, routeWaypoints } from "../interior-nav";
import type { EventSink } from "../events";
import { secondsToTicks, TICK_HZ, type EntityId } from "../ids";
import { isAble } from "../impair";
import { sight } from "../los";
import { atan2, cos, hypot2, PI, sin } from "../math";
import { bestCoverNear, exposureAt, type findPath } from "../nav";
import { navFor } from "../navctx";
import type { SimState } from "../state";
import { standZ } from "../terrain";
import { aimHeightAt, assignFireTask, reserveTargetOk } from "./fire";
import { isCowering } from "./morale";
import { footSoldiers } from "../mount";
import { stepFetchAmmo, vehicleSource } from "./boarding";
import { launcherDecision } from "./launcher";

function topUnit(state: SimState, unitId: EntityId): Unit | undefined {
  let u = state.unit.get(unitId);
  while (u && u.parent !== null) { const p = state.unit.get(u.parent); if (!p) break; u = p; }
  return u;
}

function spareCount(c: Container | undefined, type: string): number {
  let n = 0;
  if (c) for (const s of c.stacks) if (s.type === type && (s.charge ?? 0) > 0) n += s.count;
  return n;
}

/** May he open fire on his own now? */
function fireAllowed(state: SimState, ctx: SimContext, unit: Unit, top: Unit): boolean {
  if (unit.fireRule === "hold") return false;
  const D = ctx.catalog.behaviour.decisions;
  const firedOnSinceCease = top.underFireTick > top.ceaseFireTick;
  if (top.ceaseFireTick > -1e9 && !firedOnSinceCease) return false;
  if (unit.fireRule === "free") return true;
  return firedOnSinceCease && state.tick - top.underFireTick <= secondsToTicks(D.underFireMemorySeconds);
}

/** The range out to which he engages on his own, by his weapon. */
function engageRange(ctx: SimContext, state: SimState, id: EntityId): number {
  const R = ctx.catalog.behaviour.decisions.engageRangeM;
  const w = state.weapon.get(id), wd = w ? ctx.catalog.weapons[w.weapon] : undefined;
  if (!wd) return 0;
  if (wd.sustained) return R.sustained;
  return wd.sights.some((s) => s.magnification >= 4) ? R.magnified : R.rifle;
}

/**
 * The enemy that matters most to him among those he sees now: near, firing, standing up (the posture he sees
 * him in: his contact, package A). `reserve`: down to his last magazine, only an enemy he may fire it at.
 */
function pickTarget(ctx: SimContext, state: SimState, id: EntityId, s: SoldierState, rangeM: number, reserve: boolean): { target: EntityId; x: number; y: number; z?: number; posture?: Posture; score: number } | null {
  const D = ctx.catalog.behaviour.decisions;
  const me = state.transform.req(id);
  let best: { target: EntityId; x: number; y: number; z?: number; posture?: Posture; score: number } | null = null, bestScore = Infinity;
  for (const c of s.contacts) {
    if (c.kind !== "seen" || state.tick - c.tick > secondsToTicks(D.seenWithinSeconds)) continue;
    const score = targetScore(ctx, state, c, me, rangeM);
    if (score === null || (reserve && !reserveTargetOk(ctx, state, c, me))) continue;
    if (score < bestScore) { bestScore = score; best = { target: c.target, x: c.x, y: c.y, ...(c.z !== undefined ? { z: c.z } : {}), ...(c.posture !== undefined ? { posture: c.posture } : {}), score }; }
  }
  return best;
}

/** How much an enemy he knows matters (lower = more): null if out of range, given up or down. */
function targetScore(ctx: SimContext, state: SimState, c: Contact, me: { x: number; y: number }, rangeM: number): number | null {
  if (c.surrendered || c.down) return null; // he knows this man has given up (M6.6), or is down (package A)
  const d = hypot2(c.x - me.x, c.y - me.y);
  if (d > rangeM) return null;
  const ew = state.weapon.get(c.target), es = state.soldier.get(c.target);
  if (!es || !es.physiology.alive || es.casualty !== "none") return null;
  let score = d;
  if (ew && state.tick - ew.lastShotTick <= 3 * TICK_HZ) score *= ctx.catalog.weapons[ew.weapon]?.sustained ? 0.35 : 0.6;
  if (c.posture === "prone") score *= 1.3;
  return score;
}

/**
 * Is a man lying at (x, y) (`z` above the ground: his floor, M7.5d) out of sight of an enemy at (tx, ty) (`tz`
 * above the ground)?
 */
function coveredFrom(ctx: SimContext, x: number, y: number, tx: number, ty: number, heightM: number, z = 0, tz = 0): boolean {
  const D = ctx.catalog.behaviour.decisions;
  const r = sight(ctx, tx, ty, standZ(ctx.map, { x: tx, y: ty, z: tz }) + D.threatEyeHeightM, x, y, standZ(ctx.map, { x, y, z }) + heightM);
  return r.blockedBy !== null || r.visibility < 0.1;
}

/** The threat he takes cover from: the nearest enemy he knows to be firing, else the nearest he knows. */
function threatOf(state: SimState, id: EntityId, s: SoldierState): { x: number; y: number; z: number } | null {
  const me = state.transform.req(id);
  let best: { x: number; y: number; z: number } | null = null, bestD = Infinity;
  for (const c of s.contacts) {
    if (c.surrendered || c.down) continue; // a man he knows has given up (or is down) is no threat to take cover from
    const ew = state.weapon.get(c.target);
    const firing = ew !== undefined && state.tick - ew.lastShotTick <= 5 * TICK_HZ && c.kind !== "reported";
    const d = hypot2(c.x - me.x, c.y - me.y) * (firing ? 0.5 : 1);
    // (His floor, M7.5d: the height he was last seen at, M7.5 review fix.)
    if (d < bestD) { bestD = d; best = { x: c.x, y: c.y, z: c.z ?? 0 }; }
  }
  return best;
}

/**
 * Where the other men of his side on foot are, or are going (the end of their way), on his level (package B: men
 * keep `soldier.minSpacingM` from each other's places). Indoors (another floor) does not count.
 */
export function placesTaken(state: SimState, id: EntityId): { x: number; y: number }[] {
  const side = state.identity.get(id)?.side, me = state.transform.req(id);
  const out: { x: number; y: number }[] = [];
  // mounted: ok men aboard are skipped (they take no place on the ground)
  for (const [o, os] of state.soldier.entries()) {
    if (o === id || os.mount !== undefined || !isAble(os) || state.identity.get(o)?.side !== side) continue;
    const t = state.transform.req(o);
    if (Math.abs(t.z - me.z) > 1.5) continue;
    const w = state.mover.get(o)?.waypoints;
    const last = w && w.length > 0 ? w[w.length - 1]! : null;
    out.push(last ? { x: last.x, y: last.y } : { x: t.x, y: t.y });
  }
  return out;
}

export function placeFree(taken: readonly { x: number; y: number }[], x: number, y: number, sepM: number): boolean {
  for (const p of taken) if (hypot2(p.x - x, p.y - y) < sepM) return false;
  return true;
}

/**
 * Pinned or panicked where the enemy he knows can see him (package B): he low-crawls to the nearest spot within
 * `soldier.crawlSearchM` where that enemy cannot, never toward him, keeping clear of his comrades' places.
 */
function crawlToCover(ctx: SimContext, state: SimState, id: EntityId, s: SoldierState, threat: { x: number; y: number; z: number }): boolean {
  const S = ctx.catalog.behaviour.soldier, body = ctx.catalog.body.postures;
  const me = state.transform.req(id);
  const lie = body.prone.heightM * 0.6;
  if (indoorAt(ctx, me.x, me.y) >= 0 || !ctx.catalog.movementModes[S.crawlMode]) return false;
  if (coveredFrom(ctx, me.x, me.y, threat.x, threat.y, lie, me.z, threat.z)) return false;
  const tl = hypot2(threat.x - me.x, threat.y - me.y) || 1, tx = (threat.x - me.x) / tl, ty = (threat.y - me.y) / tl;
  const { grid, search } = navFor(ctx, "foot");
  const taken = placesTaken(state, id);
  const cands: { x: number; y: number; score: number }[] = [];
  for (let ring = 1; ring <= 4; ring++) {
    const r = (S.crawlSearchM * ring) / 4;
    for (let k = 0; k < 12; k++) {
      const a = (k * PI) / 6 + (ring % 2) * (PI / 12);
      const ux = cos(a), uy = sin(a);
      if (ux * tx + uy * ty > 0.3) continue; // not toward the enemy
      const x = me.x + ux * r, y = me.y + uy * r;
      if (x < 1 || y < 1 || x > ctx.map.widthM - 1 || y > ctx.map.heightM - 1) continue;
      const i = Math.floor(y / grid.cellM) * grid.cols + Math.floor(x / grid.cellM);
      if (grid.cost[i]! <= 0 || grid.wall[i] === 1) continue;
      if (!coveredFrom(ctx, x, y, threat.x, threat.y, lie, 0, threat.z)) continue;
      cands.push({ x, y, score: r + (placeFree(taken, x, y, S.minSpacingM) ? 0 : 6) });
    }
  }
  cands.sort((p, q) => p.score - q.score || p.x - q.x || p.y - q.y);
  for (const cnd of cands.slice(0, 4)) {
    const leg = routeBetween(ctx, search, me.x, me.y, cnd.x, cnd.y, { maxExpansions: 1500, snapCells: 1 }); // (outdoors only: he is not indoors)
    if (!leg || leg.cost > S.crawlSearchM * 2) continue;
    const m = state.mover.get(id);
    if (!m) return false;
    m.waypoints = routeWaypoints(leg, { x: 0, y: 0, mode: S.crawlMode });
    m.formation = null; m.endPosture = "prone"; m.endHeading = atan2(threat.y - cnd.y, threat.x - cnd.x);
    s.intent = { kind: "cover", tick: state.tick, x: cnd.x, y: cnd.y };
    return true;
  }
  return false;
}

/**
 * Out of a beaten zone (package B): halted in the open within `soldier.beatenRadiusM` of where an enemy mortar
 * mission he remembers is falling, he goes into a house close by, else `beatenMoveM` out of it, not toward the
 * enemy he knows; then he takes cover there.
 */
function leaveBeatenZone(ctx: SimContext, state: SimState, id: EntityId, s: SoldierState): boolean {
  const S = ctx.catalog.behaviour.soldier, b = s.beaten;
  if (!b) return false;
  if (state.tick - b.tick > secondsToTicks(S.beatenMemorySeconds)) {
    // The fire has lifted: he forgets it, and goes back to the place he left if he is still where he went (the
    // position he held matters; a man moved on by an order meanwhile stays where the order put him).
    delete s.beaten;
    const me = state.transform.req(id), m = state.mover.get(id);
    if (b.ox === undefined || b.oy === undefined || b.gx === undefined || b.gy === undefined || !m || hypot2(me.x - b.gx, me.y - b.gy) > 5) return false;
    const leg = routeBetween(ctx, navFor(ctx, "foot").search, me.x, me.y, b.ox, b.oy, { maxExpansions: 6000, snapCells: 2 }, { sz: me.z, gz: 0 });
    if (!leg) return false;
    m.waypoints = routeWaypoints(leg, { x: 0, y: 0, mode: "run" });
    m.formation = null; m.endPosture = "prone"; m.endHeading = null;
    return true;
  }
  if (b.left) return false;
  const me = state.transform.req(id);
  if (hypot2(me.x - b.x, me.y - b.y) > S.beatenRadiusM) return false;
  b.left = true;
  if (indoorAt(ctx, me.x, me.y) >= 0) return false; // in a house already: its walls and floors are his cover
  // Only a man in the open: next to a wall, a hedge, a building or in woods he stays down where he is (and a man
  // in a position, e.g. on a support line, keeps it).
  if (exposureAt(navFor(ctx, "foot").grid, me.x, me.y) < S.beatenOpenExposure) return false;
  const m = state.mover.get(id);
  if (!m) return false;
  const { search } = navFor(ctx, "foot");
  const taken = placesTaken(state, id);
  // A house close by, not in the zone's middle: a place inside away from its windows (the last ones offered).
  const bs = ctx.map.buildings;
  let bestB = -1, bestD = S.beatenHouseM;
  for (let bi = 0; bi < bs.length; bi++) {
    const bl = bs[bi]!;
    if (!bl.interior) continue;
    const fp = bl.footprint;
    let cx = 0, cy = 0;
    for (let k = 0; k < fp.length; k += 2) { cx += fp[k]!; cy += fp[k + 1]!; }
    cx /= fp.length / 2; cy /= fp.length / 2;
    const d = hypot2(cx - me.x, cy - me.y);
    if (d < bestD) { bestD = d; bestB = bi; }
  }
  if (bestB >= 0) {
    const spots = indoorSpots(ctx, bestB, me.x, me.y, 8, 0);
    for (let k = spots.length - 1; k >= 0; k--) {
      const sp = spots[k]!;
      if (!placeFree(taken, sp.x, sp.y, 1.2)) continue;
      const leg = routeBetween(ctx, search, me.x, me.y, sp.x, sp.y, { maxExpansions: 6000, snapCells: 2 }, { sz: me.z, gz: sp.z });
      if (!leg || leg.cost > S.beatenHouseM * 2.5) break;
      m.waypoints = routeWaypoints(leg, { x: 0, y: 0, mode: "run" });
      m.formation = null; m.endPosture = "crouching"; m.endHeading = sp.heading;
      s.intent = { kind: "cover", tick: state.tick, x: sp.x, y: sp.y };
      b.ox = me.x; b.oy = me.y; b.gx = sp.x; b.gy = sp.y;
      return true;
    }
  }
  // Out of it: away from its middle and from the enemy he knows, among the ways that leave the zone.
  const threat = threatOf(state, id, s);
  const ox = me.x - b.x, oy = me.y - b.y, ol = hypot2(ox, oy) || 1;
  const cands: { x: number; y: number; score: number }[] = [];
  for (let k = 0; k < 12; k++) {
    const a = (k * PI) / 6, ux = cos(a), uy = sin(a);
    const x = me.x + ux * S.beatenMoveM, y = me.y + uy * S.beatenMoveM;
    if (x < 2 || y < 2 || x > ctx.map.widthM - 2 || y > ctx.map.heightM - 2) continue;
    if (hypot2(x - b.x, y - b.y) < S.beatenRadiusM) continue;
    const away = (ux * ox + uy * oy) / ol;
    if (away < 0) continue; // never across the zone's middle
    let score = -2 * away;
    if (threat) { const tl = hypot2(threat.x - me.x, threat.y - me.y) || 1; score += ((threat.x - me.x) * ux + (threat.y - me.y) * uy) / tl; }
    cands.push({ x, y, score });
  }
  cands.sort((p, q) => p.score - q.score || p.x - q.x || p.y - q.y);
  const { grid } = navFor(ctx, "foot");
  for (const c of cands.slice(0, 4)) {
    // (The best cover close to that point, clear of his comrades' places.)
    const spot = bestCoverNear(grid, c.x, c.y, 8, taken, S.minSpacingM) ?? c;
    const leg = routeBetween(ctx, search, me.x, me.y, spot.x, spot.y, { maxExpansions: 6000, snapCells: 2 }, { sz: me.z, gz: 0 });
    if (!leg || leg.cost > S.beatenMoveM * 2) continue;
    m.waypoints = routeWaypoints(leg, { x: 0, y: 0, mode: "run" });
    m.formation = null; m.endPosture = "prone"; m.endHeading = threat ? atan2(threat.y - spot.y, threat.x - spot.x) : null;
    s.intent = { kind: "cover", tick: state.tick, x: spot.x, y: spot.y };
    b.ox = me.x; b.oy = me.y; b.gx = spot.x; b.gy = spot.y;
    return true;
  }
  return false;
}

function seekCover(ctx: SimContext, state: SimState, id: EntityId, s: SoldierState, threat: { x: number; y: number; z: number }): boolean {
  const D = ctx.catalog.behaviour.decisions, body = ctx.catalog.body.postures;
  const me = state.transform.req(id);
  const lie = body.prone.heightM * 0.6, kneel = body.crouching.muzzleHeightM;
  if (coveredFrom(ctx, me.x, me.y, threat.x, threat.y, lie, me.z, threat.z)) return false;
  // Indoors (M7.5c) he stays in the house: its walls are his cover (no running out into the open).
  if (indoorAt(ctx, me.x, me.y) >= 0) return false;
  const { grid, search } = navFor(ctx, "foot");
  const taken = placesTaken(state, id), sep = ctx.catalog.behaviour.soldier.minSpacingM;
  const cands: { x: number; y: number; score: number }[] = [];
  for (let ring = 1; ring <= 5; ring++) {
    const r = (D.coverSearchM * ring) / 5;
    for (let k = 0; k < 12; k++) {
      const a = (k * PI) / 6 + (ring % 2) * (PI / 12);
      const x = me.x + cos(a) * r, y = me.y + sin(a) * r;
      if (x < 1 || y < 1 || x > ctx.map.widthM - 1 || y > ctx.map.heightM - 1) continue;
      const c = Math.floor(x / grid.cellM), rr = Math.floor(y / grid.cellM), i = rr * grid.cols + c;
      if (grid.cost[i]! <= 0 || grid.wall[i] === 1) continue;
      if (!coveredFrom(ctx, x, y, threat.x, threat.y, lie, 0, threat.z)) continue;
      // Better: a spot he can fire from on his knees over the cover (a bank, a low wall).
      const firing = !coveredFrom(ctx, x, y, threat.x, threat.y, kneel, 0, threat.z);
      // (Not on top of a comrade, package B: a spot within minSpacingM of another man's place counts as worse.)
      cands.push({ x, y, score: r + (firing ? 0 : 8) + (placeFree(taken, x, y, sep) ? 0 : 10) });
    }
  }
  // The best first; one he cannot reach without a long detour is passed over for the next (at most 6 tried).
  cands.sort((p, q) => p.score - q.score || p.x - q.x || p.y - q.y);
  let best: { x: number; y: number } | null = null, leg = null as ReturnType<typeof findPath>;
  for (const cnd of cands.slice(0, 6)) {
    const l = routeBetween(ctx, search, me.x, me.y, cnd.x, cnd.y, { maxExpansions: 3000, snapCells: 1 }); // (outdoors only: seekCover returns indoors)
    if (l && l.cost <= D.coverSearchM * 2.5) { best = cnd; leg = l; break; }
  }
  if (!best || !leg) return false;
  const m = state.mover.get(id);
  if (!m) return false;
  m.waypoints = [];
  for (let i = 0; i < leg.points.length; i += 2) m.waypoints.push({ x: leg.points[i]!, y: leg.points[i + 1]!, mode: "run" });
  m.formation = null;
  m.endPosture = "prone";
  m.endHeading = atan2(threat.y - best.y, threat.x - best.x);
  const task = state.fire.get(id);
  if (task) task.basePosture = "prone";
  s.intent = { kind: "cover", tick: state.tick, x: best.x, y: best.y };
  return true;
}

/** A comrade who has run out of spare: the nearest man able to bring him one goes. */
function shareAmmo(ctx: SimContext, state: SimState, events: EventSink, id: EntityId, top: EntityId): void {
  const D = ctx.catalog.behaviour.decisions;
  const w = state.weapon.get(id), wd = w ? ctx.catalog.weapons[w.weapon] : undefined;
  if (!w || !wd) return;
  const type = wd.feed.magazine;
  if (spareCount(state.container.get(id), type) > 0) return;
  // A halted own vehicle close by that carries them (M7.2): he goes and takes some himself.
  if (state.soldier.get(id)?.intent?.kind === "fetchAmmo" || state.action.get(id)?.kind === "takeFromVehicle") return;
  const src = vehicleSource(ctx, state, id, type);
  if (src !== null) {
    state.soldier.req(id).intent = { kind: "fetchAmmo", tick: state.tick, target: src };
    if (!stepFetchAmmo(ctx, state, events, id, src, type, state.tick)) state.soldier.req(id).intent = null;
    return;
  }
  // Already someone on his way?
  const men = footSoldiers(state, top);
  for (const g of men) {
    const it = state.soldier.get(g)?.intent, act = state.action.get(g);
    if (it?.kind === "bringAmmo" && it.target === id) return;
    if (act?.kind === "transferItems" && Number(act.params["to"]) === id) return; // being handed over now
  }
  const me = state.transform.req(id);
  let giver: EntityId | null = null, bestD = D.shareRangeM;
  for (const g of men) {
    if (g === id) continue;
    const gs = state.soldier.get(g);
    if (!gs || !isAble(gs) || isCowering(gs) || state.action.has(g) || gs.intent?.kind === "bringAmmo") continue;
    const n = spareCount(state.container.get(g), type);
    const gw = state.weapon.get(g), own = gw ? ctx.catalog.weapons[gw.weapon]?.feed.magazine === type : false;
    if (n <= (own ? D.keepSpare : 0)) continue;
    const t = state.transform.req(g);
    const d = hypot2(t.x - me.x, t.y - me.y);
    if (d < bestD) { bestD = d; giver = g; }
  }
  if (giver === null) return;
  state.soldier.req(giver).intent = { kind: "bringAmmo", tick: state.tick, target: id };
  stepBringAmmo(ctx, state, events, giver);
}

/** The giver: walk over, then hand the magazine or belt over. */
function stepBringAmmo(ctx: SimContext, state: SimState, events: EventSink, g: EntityId): void {
  const gs = state.soldier.req(g), it = gs.intent!;
  const to = it.target!;
  const rs = state.soldier.get(to), rw = state.weapon.get(to), wd = rw ? ctx.catalog.weapons[rw.weapon] : undefined;
  // What he brings: an anti-tank round (M7.4a: counted as items, he has none left), else the receiver's magazine.
  const item = it.item ?? wd?.feed.magazine;
  const has = (c: Container | undefined) => (it.item !== undefined ? (c ? countItems(c, it.item) : 0) : spareCount(c, item ?? ""));
  if (!rs || !isAble(rs) || item === undefined || state.tick - it.tick > 60 * TICK_HZ || has(state.container.get(to)) > 0 || (it.item !== undefined && has(state.container.get(g)) === 0)) { gs.intent = null; return; }
  if (state.action.has(g)) return;
  const a = state.transform.req(g), b = state.transform.req(to);
  const d = hypot2(a.x - b.x, a.y - b.y);
  if (d <= 2.4) {
    startAction(state, events, g, "transferItems", secondsToTicks(ctx.catalog.behaviour.decisions.passSeconds), { to, item, count: 1 });
    gs.intent = null;
    return;
  }
  const m = state.mover.get(g);
  if (!m) { gs.intent = null; return; }
  const last = m.waypoints[m.waypoints.length - 1];
  if (last && hypot2(last.x - b.x, last.y - b.y) < 2.5) return; // already on his way
  const { search } = navFor(ctx, "foot");
  // He comes up behind him (not into his line of fire).
  const bx = b.x - cos(b.heading) * 1.5, by = b.y - sin(b.heading) * 1.5;
  const leg = routeBetween(ctx, search, a.x, a.y, bx, by, { maxExpansions: 4000, snapCells: 2 }, { sz: a.z, gz: b.z });
  if (!leg) { gs.intent = null; return; }
  m.waypoints = routeWaypoints(leg, { x: 0, y: 0, mode: "run" });
  m.formation = null; m.endPosture = "prone"; m.endHeading = null;
}

/** Is his unit, or one above it, carrying out an assault or a withdrawal (a drill moves him on its own)? */
function inDrill(state: SimState, unitId: EntityId): boolean {
  for (let u: EntityId | null = unitId; u !== null; u = state.unit.get(u)?.parent ?? null) {
    const d = state.unit.get(u)?.drill;
    if (d && d.kind !== "rout") return true;
  }
  return false;
}

export function decisionSystem(ctx: SimContext, state: SimState, events: EventSink): void {
  const D = ctx.catalog.behaviour.decisions, S = ctx.catalog.behaviour.soldier;
  const every = Math.max(1, secondsToTicks(D.stepSeconds));
  // ---- who is under fire: the unit remembers it (for the "return fire" rule)
  // mounted: ok a man aboard who is under fire still tells his unit it is under fire
  for (const [id, s] of state.soldier.entries()) {
    if (s.mental.suppression < D.underFireSuppression || !isAble(s)) continue;
    const u = state.identity.get(id)?.unit;
    const top = u !== undefined ? topUnit(state, u) : undefined;
    if (top) {
      // A new spell under fire (after a quiet spell): the drills react to it (M4.3).
      if (state.tick - top.underFireTick > secondsToTicks(D.underFireMemorySeconds)) top.contactTick = state.tick;
      top.underFireTick = state.tick;
    }
  }
  for (const [id, s] of state.soldier.entries()) {
    if ((id + state.tick) % every !== 0) continue;
    if (!isAble(s)) { s.intent = null; continue; }
    if (s.mount !== undefined) { s.intent = null; continue; } // aboard: no decisions of his own (M7)
    if (state.tick < s.stunnedUntilTick || s.evade !== null) continue;
    const ident = state.identity.get(id);
    const unit = ident ? state.unit.get(ident.unit) : undefined;
    if (!ident || !unit) continue;
    const top = topUnit(state, ident.unit)!;
    if (s.mental.behaviour === "routed") { s.intent = null; continue; } // running back: no decisions of his own
    const topId = (() => { let u = ident.unit; for (let p = state.unit.get(u)?.parent ?? null; p !== null; p = state.unit.get(u)?.parent ?? null) u = p; return u; })();
    if (s.intent?.kind === "bringAmmo") { stepBringAmmo(ctx, state, events, id); continue; }
    if (s.intent?.kind === "fetchAmmo") {
      const w = state.weapon.get(id), wd = w ? ctx.catalog.weapons[w.weapon] : undefined;
      if (!wd || s.intent.target === undefined || !stepFetchAmmo(ctx, state, events, id, s.intent.target, wd.feed.magazine, s.intent.tick)) s.intent = null;
      continue;
    }
    // On his way to take a prisoner (systems/surrender.ts runs that errand): nothing else of his own meanwhile.
    if (s.intent?.kind === "takePrisoner") continue;
    const m = state.mover.get(id);
    const halted = !m || m.waypoints.length === 0;
    const task = state.fire.get(id);

    // ---- his own fire: keep it up while he sees the enemy, stop when he has lost him
    if (task?.self) {
      const c = s.contacts.find((k) => k.target === task.contact);
      const es = task.contact !== undefined ? state.soldier.get(task.contact) : undefined;
      const me = state.transform.req(id);
      const beyond = c !== undefined && unit.maxEngageM > 0 && hypot2(c.x - me.x, c.y - me.y) > unit.maxEngageM;
      if (!c || c.surrendered === true || c.down === true || !es || es.casualty !== "none" || beyond || state.tick - c.tick > secondsToTicks(D.contactLostSeconds) || !fireAllowed(state, ctx, unit, top)) {
        state.fire.delete(id);
        if (s.intent?.kind === "engage") s.intent = null;
      } else if (c.kind === "seen" && state.tick - c.tick <= secondsToTicks(D.seenWithinSeconds)) {
        task.reasonTick = state.tick;
      }
    }
    // Stale intents (debug overlay): cover reached, or his own fire replaced by an order.
    if (s.intent?.kind === "cover" && halted) s.intent = null;
    if (s.intent?.kind === "engage" && state.fire.get(id)?.self !== true) s.intent = null;
    if (isCowering(s)) {
      // ---- pinned or panicked in the enemy's sight: a low crawl to the nearest fold (package B). Also a man pinned
      // on his way (it is held, not walked): the crawl replaces it; his unit's next order or bound sends him on.
      const crawling = !halted && m!.waypoints[m!.waypoints.length - 1]!.mode === S.crawlMode;
      if (!crawling && state.tick - s.coverTick >= secondsToTicks(S.crawlRetrySeconds)) {
        const threat = threatOf(state, id, s);
        s.coverTick = state.tick;
        if (threat && crawlToCover(ctx, state, id, s, threat)) continue;
      }
      // Nothing else while he is pinned or panicked: he fires back once he is no longer pinned (from the cover he
      // crawled to; a fire task he already had goes on at his pinned rate).
      continue;
    } else {
      // ---- out of the beaten zone of an enemy mortar mission (package B)
      // (Not while his unit is still on its way somewhere — a man who has got there first waits for the others — nor
      // within a minute of an order to it: he was put there on purpose.)
      if (halted && s.beaten !== undefined && !unit.moving && state.tick - Math.max(unit.orderTick, top.orderTick) > secondsToTicks(60)
        && !inDrill(state, ident.unit) && leaveBeatenZone(ctx, state, id, s)) continue;

      // ---- cover from the enemy he knows, when under fire
      if (halted && s.mental.suppression >= D.seekCoverSuppression && state.tick - s.coverTick >= secondsToTicks(D.coverRetrySeconds)) {
        const threat = threatOf(state, id, s);
        s.coverTick = state.tick;
        if (threat && seekCover(ctx, state, id, s, threat)) continue;
      }

      // ---- an anti-tank shot on his own (M7.4a, owner Q19): his unit's fire rule and anti-tank rule allow it
      if (halted && fireAllowed(state, ctx, unit, top) && launcherDecision(ctx, state, events, id, s, ident.unit)) continue;
    }

    // ---- open fire on his own
    const current = state.fire.get(id);
    if (halted && (!current || current.self) && fireAllowed(state, ctx, unit, top)) {
      // (A unit rule may hold fire to a shorter range, e.g. for an ambush.)
      const range = unit.maxEngageM > 0 ? Math.min(unit.maxEngageM, engageRange(ctx, state, id)) : engageRange(ctx, state, id);
      // Down to the magazine in his weapon (a rifleman): only at an enemy he keeps it for (package A).
      const w = state.weapon.get(id), wd = w ? ctx.catalog.weapons[w.weapon] : undefined;
      const reserve = wd !== undefined && !wd.sustained && spareCount(state.container.get(id), wd.feed.magazine) <= 0;
      const pick = pickTarget(ctx, state, id, s, range, reserve);
      // He keeps his target (package A) while it is up and in sight, unless another matters clearly more.
      let keep = false;
      if (pick && current && current.contact !== undefined && current.contact !== pick.target) {
        const cc = s.contacts.find((k) => k.target === current.contact);
        // (Out of sight for a moment — a man lying down flickers in and out of view — is not "hidden".)
        const cs = cc && cc.kind === "seen" && state.tick - cc.tick <= secondsToTicks(ctx.catalog.behaviour.soldier.keepTargetSeenSeconds) ? targetScore(ctx, state, cc, state.transform.req(id), range) : null;
        keep = cs !== null && pick.score >= ctx.catalog.behaviour.soldier.keepTargetFactor * cs;
      }
      if (pick && !keep && (!current || current.contact !== pick.target)) {
        if (assignFireTask(ctx, state, id, pick.x, pick.y, aimHeightAt(ctx, pick))) {
          const ft = state.fire.get(id)!;
          ft.contact = pick.target; ft.self = true; ft.aimAuto = true;
          s.intent = { kind: "engage", tick: state.tick, target: pick.target } satisfies Intent;
        }
      }
    }

    // ---- out of spare magazines or belts: a comrade brings one
    if (state.weapon.get(id)?.lowAmmoReported) shareAmmo(ctx, state, events, id, topId);
  }
}
