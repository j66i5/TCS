/**
 * LEAVING A HOUSE (M7.5e step "leave", owner 2026-11-14): men leave a house when it becomes a trap, when the enemy
 * gets inside, or when it is cut off from behind. Soldier behaviour, the same for every side and for the player's
 * squads (an Occupy is not a promise to die in a burning house); `soldier.houseLeave` false switches it off.
 *
 *   trap      Enemy bursts in or on his house (inside its walls, or just outside them) add up to `houseTrapBursts`
 *             with no more than `houseTrapSeconds` between one and the next; a heavy round (a mortar bomb, a rocket)
 *             counts more. `detonate` marks it on the men inside (`markHouseDanger`): the sim never reads its own
 *             events.
 *   enemy     An enemy he or a man of his unit has seen inside his house in the last `houseEnemySeconds`.
 *             One in his own room within `houseFightM` he fights (his own fire), not flees from.
 *   flank     An enemy known lately within `houseFlankM` of the house, more than `houseFlankDeg` off another enemy his
 *             unit remembers (at any distance): enemies on two sides of the house.
 * (Only contacts located well enough count: within `houseContactErrM`, or a quarter of their distance.)
 *
 * Then every man of his unit in that house, or on his way into it, runs out (pinning does not hold him: a `bolt`
 * leg) to a covered spot outdoors `houseLeaveM` from the house, within `houseLeaveDeg` of straight away from the
 * threat, and lies down facing it. `Unit.leftHouse` keeps the unit's own rules out of that house for
 * `houseReenterSeconds`; a man of the unit still inside then (he was fighting in his room) follows when he can. An
 * order to the unit after it left makes the rule look at the house afresh (a trap then needs a burst since the
 * order). A unit that could send nobody out (`Unit.leaveTry`) reports nothing and looks again after `houseLeaveRetryS`.
 */
import type { Contact, HouseLeaveReason, SoldierState, Unit } from "../components";
import type { SimContext } from "../context";
import type { EventSink } from "../events";
import { secondsToTicks, type EntityId } from "../ids";
import { isAble } from "../impair";
import { floorAtZ, indoorAt, mapHasInteriors, routeBetween, routeWaypoints } from "../interior-nav";
import { roomAt } from "../interior";
import { atan2, cos, hypot2, PI, sin } from "../math";
import { bestCoverNear, exposureAt, navCostAt } from "../nav";
import { navFor } from "../navctx";
import type { Waypoint } from "../orders";
import type { SimState } from "../state";
import { contactErrorM } from "./contacts";
import { placeFree, placesTaken } from "./decisions";
import { windowPlaces } from "./occupy";

/** Centre of a footprint polygon (mean of its corners). */
function centreOf(fp: readonly number[]): [number, number] {
  let x = 0, y = 0;
  const n = fp.length / 2;
  for (let i = 0; i < n; i++) { x += fp[i * 2]!; y += fp[i * 2 + 1]!; }
  return [x / n, y / n];
}

/**
 * The building with an interior a burst at (x, y) is in or on: inside its walls (under its roof), else the nearest
 * within `nearM` outside them. -1: none.
 */
export function burstBuilding(ctx: SimContext, x: number, y: number, nearM: number): number {
  const bi = indoorAt(ctx, x, y);
  if (bi >= 0 || nearM <= 0 || !mapHasInteriors(ctx)) return bi;
  const bs = ctx.map.buildings;
  let best = -1, bestD = nearM;
  for (let i = 0; i < bs.length; i++) {
    const b = bs[i]!;
    if (!b.interior) continue;
    const fp = b.footprint, n = fp.length / 2;
    for (let k = 0; k < n; k++) {
      const ax = fp[k * 2]!, ay = fp[k * 2 + 1]!, j = ((k + 1) % n) * 2;
      const ex = fp[j]! - ax, ey = fp[j + 1]! - ay, l2 = ex * ex + ey * ey || 1;
      let u = ((x - ax) * ex + (y - ay) * ey) / l2;
      u = u < 0 ? 0 : u > 1 ? 1 : u;
      const dx = ax + u * ex - x, dy = ay + u * ey - y;
      if (dx > bestD || dx < -bestD || dy > bestD || dy < -bestD) continue;
      const d = hypot2(dx, dy);
      if (d <= bestD) { bestD = d; best = i; }
    }
  }
  return best;
}

/**
 * A burst of `fillingKg` at (x, y), fired by `owner`'s side: the able men on foot of the other sides inside the
 * building it is in or on remember the danger (`SoldierState.houseDanger`).
 */
export function markHouseDanger(ctx: SimContext, state: SimState, x: number, y: number, fillingKg: number, owner: EntityId): void {
  const S = ctx.catalog.behaviour.soldier;
  // (Not `ctx.hasInteriors` directly: it is set lazily, and a loaded game may not have it yet.)
  if (!S.houseLeave || !mapHasInteriors(ctx)) return;
  const bi = burstBuilding(ctx, x, y, S.houseBurstNearM);
  if (bi < 0) return;
  const bid = ctx.map.buildings[bi]!.id, side = state.identity.get(owner)?.side;
  const w = fillingKg >= S.houseHeavyKg ? S.houseHeavyCount : 1, keep = secondsToTicks(S.houseTrapSeconds), tick = state.tick;
  // mounted: ok men aboard are skipped (they are not in the house)
  for (const [id, s] of state.soldier.entries()) {
    if (s.mount !== undefined || !isAble(s) || (side !== undefined && state.identity.get(id)?.side === side)) continue;
    const t = state.transform.get(id);
    if (!t || indoorAt(ctx, t.x, t.y) !== bi) continue;
    const hd = s.houseDanger;
    if (hd && hd.building === bid && tick - hd.tick <= keep) { hd.n += w; hd.tick = tick; }
    else s.houseDanger = { building: bid, n: w, tick };
  }
}

/** Is an enemy he knows of (contact `c`) in his own room, within `fightM` (he fights him there)? */
function inHisRoom(ctx: SimContext, bi: number, me: { x: number; y: number; z: number }, c: Contact, fightM: number): boolean {
  if (hypot2(c.x - me.x, c.y - me.y) > fightM) return false;
  const b = ctx.map.buildings[bi]!;
  const r = roomAt(b, floorAtZ(b, me.z), me.x, me.y);
  return r >= 0 && r === roomAt(b, floorAtZ(b, c.z ?? 0), c.x, c.y);
}

/** Can a contact be thought of as an enemy to flee from (not down, not given up, not a wreck)? */
function live(c: Contact): boolean {
  return c.down !== true && c.surrendered !== true && c.wreck !== true;
}

/**
 * Is a contact located well enough to act on from a house at (cx, cy): its position error now within
 * `houseContactErrM`, or a quarter of its distance (a far enemy's bearing is still known)? A sound gives a vague place.
 */
function located(ctx: SimContext, c: Contact, tick: number, cx: number, cy: number): boolean {
  const e = contactErrorM(ctx, c, tick);
  return e <= ctx.catalog.behaviour.soldier.houseContactErrM || e <= 0.25 * hypot2(c.x - cx, c.y - cy);
}

/** The men of the unit in building `bi` (able, on foot), or on their way into it; ascending id. */
function menIn(ctx: SimContext, state: SimState, unit: Unit, bi: number): EntityId[] {
  const out: EntityId[] = [];
  for (const o of unit.members) {
    const os = state.soldier.get(o), t = state.transform.get(o);
    if (!os || !t || os.mount !== undefined || !isAble(os)) continue;
    if (indoorAt(ctx, t.x, t.y) === bi) { out.push(o); continue; }
    const w = state.mover.get(o)?.waypoints;
    const last = w && w.length > 0 ? w[w.length - 1]! : null;
    if (last && last.bolt !== true && indoorAt(ctx, last.x, last.y) === bi) out.push(o);
  }
  return out.sort((a, b) => a - b);
}

/**
 * The way his unit faces in house `bi`: the mean outward normal of the window nearest each of its men there (on his
 * floor), as a unit vector; null when its men face every way (the mean is short) or there are no windows.
 */
function unitFront(ctx: SimContext, state: SimState, men: readonly EntityId[], bi: number): { x: number; y: number } | null {
  const wins = windowPlaces(ctx, bi);
  if (wins.length === 0) return null;
  let fx = 0, fy = 0, n = 0;
  for (const o of men) {
    const t = state.transform.req(o);
    let best = -1, bd = Infinity;
    for (let i = 0; i < wins.length; i++) {
      const w = wins[i]!;
      const d = hypot2(w.x - t.x, w.y - t.y) + (Math.abs(w.z - t.z) > 1 ? 50 : 0);
      if (d < bd) { bd = d; best = i; }
    }
    if (best < 0) continue;
    fx += wins[best]!.normalX; fy += wins[best]!.normalY; n++;
  }
  if (n === 0) return null;
  const l = hypot2(fx, fy) / n;
  if (l < ctx.catalog.behaviour.soldier.houseFrontMin) return null;
  return { x: fx / (l * n), y: fy / (l * n) };
}

/** Scratch: the enemies a unit knows of lately (one contact per enemy, the freshest), reused. */
const KNOWN: Contact[] = [];
/** Scratch: every enemy the unit remembers, at the place it was last known (one contact per enemy), reused. */
const LATEST: Contact[] = [];

/** Keep in `list` the freshest of `c` and the contact already there for its target (a sighting before a report). */
function keepFreshest(list: Contact[], c: Contact): void {
  let k = 0;
  while (k < list.length && list[k]!.target !== c.target) k++;
  if (k === list.length) list.push(c);
  else if (c.tick > list[k]!.tick || (c.kind === "seen" && list[k]!.kind !== "seen" && c.tick === list[k]!.tick)) list[k] = c;
}

/**
 * Should his unit leave the house he is in (exported for tests), and why, with the bearings (rad, from the house) of what it flees from:
 * every enemy the unit knows near, or (a trap with none known near) the way its men's windows face.
 * `fight`: the men who stay to fight an enemy in their own room.
 */
export function houseThreat(ctx: SimContext, state: SimState, s: SoldierState, unit: Unit, bi: number, men: readonly EntityId[], trapSince = -Infinity): { reason: HouseLeaveReason; bearings: number[]; fight: EntityId[] } | null {
  const S = ctx.catalog.behaviour.soldier, tick = state.tick;
  const b = ctx.map.buildings[bi]!;
  const [cx, cy] = centreOf(b.footprint);
  const flankTicks = secondsToTicks(S.houseFlankSeconds), enemyTicks = secondsToTicks(S.houseEnemySeconds);
  // The enemies the unit knows lately (one contact each: the freshest; unit members in id order).
  KNOWN.length = 0; LATEST.length = 0;
  for (const o of unit.members) {
    const os = state.soldier.get(o);
    if (!os || !isAble(os)) continue;
    for (const c of os.contacts) {
      keepFreshest(LATEST, c);
      if (!live(c) || tick - c.tick > flankTicks || !located(ctx, c, tick, cx, cy)) continue;
      keepFreshest(KNOWN, c);
    }
  }
  const bearings: number[] = [], near: EntityId[] = [];
  let inside: Contact | null = null;
  for (const c of KNOWN) {
    const dx = c.x - cx, dy = c.y - cy, d = hypot2(dx, dy);
    if (d > S.houseFlankM) continue;
    if (d > 0.5) { bearings.push(atan2(dy, dx)); near.push(c.target); }
    if (!inside && c.kind === "seen" && c.cls !== "vehicle" && tick - c.tick <= enemyTicks && indoorAt(ctx, c.x, c.y) === bi) inside = c;
  }
  if (inside) {
    const fight: EntityId[] = [];
    for (const o of men) { const t = state.transform.req(o); if (indoorAt(ctx, t.x, t.y) === bi && inHisRoom(ctx, bi, t, inside, S.houseFightM)) fight.push(o); }
    return { reason: "enemy", bearings, fight };
  }
  const hd = s.houseDanger;
  // (`trapSince`: after an order put the unit back in a house it left, only a burst since counts it a trap again.)
  const trap = hd !== undefined && hd.building === b.id && hd.tick > trapSince && tick - hd.tick <= secondsToTicks(S.houseTrapSeconds) && hd.n >= S.houseTrapBursts;
  if (!trap && bearings.length === 0) return null;
  if (trap) {
    // (No enemy known close: the bursts come from where the house faces.)
    if (bearings.length === 0) { const front = unitFront(ctx, state, men, bi); if (front) bearings.push(atan2(front.y, front.x)); }
    return { reason: "trap", bearings, fight: [] };
  }
  // Cut off: an enemy near (known lately) more than houseFlankDeg off another enemy the unit remembers, at any
  // distance: enemies on two sides of the house — two enemies, each where the unit last knew it (one man seen at two
  // places, or an old place of a man known elsewhere now, is not).
  const cosFlank = cos((S.houseFlankDeg * PI) / 180);
  for (let i = 0; i < bearings.length; i++) {
    const e = bearings[i]!, et = near[i]!;
    for (const c of LATEST) {
      if (c.target === et || !live(c) || hypot2(c.x - cx, c.y - cy) <= 0.5 || !located(ctx, c, tick, cx, cy)) continue;
      if (cos(atan2(c.y - cy, c.x - cx) - e) < cosFlank) return { reason: "flank", bearings, fight: [] };
    }
  }
  return null;
}

/** A way out candidate. */
interface Out { x: number; y: number; score: number; r: number }

/**
 * The way out of a house with threats on `bearings` (rad, from the house): the bearing farthest from all of them
 * (of 24, the least worst cosine to any; ties by the lower index), or null with none.
 */
function wayOut(bearings: readonly number[]): number | null {
  if (bearings.length === 0) return null;
  let best = 0, bestV = Infinity;
  for (let k = 0; k < 24; k++) {
    const a = (k * PI) / 12;
    let worst = -Infinity;
    for (const e of bearings) { const v = cos(a - e); if (v > worst) worst = v; }
    if (worst < bestV - 1e-9) { bestV = worst; best = k; }
  }
  return (best * PI) / 12;
}

/**
 * Send `men` (in building `bi`, ascending id) out of it, away from threats on `bearings` (rad, from the house; empty:
 * any way): each to a covered spot outdoors, apart from each other, lying down facing the nearest threat bearing.
 * Returns how many go.
 */
export function leaveHouse(ctx: SimContext, state: SimState, men: readonly EntityId[], bi: number, bearings: readonly number[]): number {
  const S = ctx.catalog.behaviour.soldier;
  if (men.length === 0) return 0;
  const b = ctx.map.buildings[bi]!;
  const [cx, cy] = centreOf(b.footprint);
  const { grid, search } = navFor(ctx, "foot");
  const away = wayOut(bearings);
  const maxOff = (S.houseLeaveDeg * PI) / 180;
  const r0 = S.houseLeaveM[0], r1 = Math.max(S.houseLeaveM[1], r0);
  const cands: Out[] = [];
  const steps = away === null ? 12 : Math.max(1, Math.round(maxOff / (PI / 12)));
  for (const r of [r0, (r0 + r1) / 2, r1]) {
    for (let k = away === null ? 0 : -steps; k < steps || (away !== null && k === steps); k++) {
      const a = away === null ? (k * PI) / 6 : away + (k * maxOff) / steps;
      const x = Math.min(Math.max(cx + cos(a) * r, 2), ctx.map.widthM - 2), y = Math.min(Math.max(cy + sin(a) * r, 2), ctx.map.heightM - 2);
      const spot = bestCoverNear(grid, x, y, S.houseLeaveCoverM) ?? { x, y };
      if (navCostAt(grid, spot.x, spot.y) <= 0 || indoorAt(ctx, spot.x, spot.y) >= 0) continue;
      const sa = atan2(spot.y - cy, spot.x - cx);
      // Still within houseLeaveDeg (and a little) of the way out after the snap to cover.
      const off = away === null ? 0 : Math.abs(atan2(sin(sa - away), cos(sa - away)));
      if (off > maxOff + PI / 24) continue;
      let toward = -1;
      for (const e of bearings) toward = Math.max(toward, cos(sa - e));
      const exp = exposureAt(grid, spot.x, spot.y);
      cands.push({ x: spot.x, y: spot.y, r, score: 2 * exp + (exp >= 0.9 ? 3 : 0) + (maxOff > 0 ? off / maxOff : 0) + toward + (0.2 * r) / r1 });
    }
  }
  cands.sort((p, q) => p.score - q.score || p.x - q.x || p.y - q.y);
  const tick = state.tick;
  let sent = 0;
  for (const id of men) {
    const t = state.transform.get(id), m = state.mover.get(id), s = state.soldier.get(id);
    if (!t || !m || !s) continue;
    const taken = placesTaken(state, id);
    let tries = 0;
    for (const c of cands) {
      if (!placeFree(taken, c.x, c.y, S.minSpacingM)) continue;
      if (++tries > S.houseLeaveTries) break;
      const leg = routeBetween(ctx, search, t.x, t.y, c.x, c.y, { maxExpansions: 8000, snapCells: 2 }, { sz: t.z, gz: 0 });
      if (!leg || leg.cost > c.r * S.houseLeaveCost[0] + S.houseLeaveCost[1]) continue;
      m.waypoints = routeWaypoints<Waypoint>(leg, { x: 0, y: 0, mode: S.houseLeaveMode, bolt: true });
      m.formation = null; m.slotLagM = 0;
      m.endPosture = "prone";
      // Facing the nearest threat bearing (from the house) at his spot.
      let face: number | null = null, fv = -Infinity;
      const sa = atan2(c.y - cy, c.x - cx);
      for (const e of bearings) { const v = cos(sa - e); if (v > fv) { fv = v; face = e; } }
      m.endHeading = face;
      // Outdoors his fire position is lying down (package C), not the window's posture.
      s.homePosture = "prone";
      s.intent = { kind: "cover", tick, x: c.x, y: c.y };
      sent++;
      break;
    }
  }
  return sent;
}

/** Has his unit left building `bi` on its own lately (its own rules keep out of it)? */
export function leftLately(ctx: SimContext, state: SimState, unitId: EntityId, bi: number): boolean {
  const lh = state.unit.get(unitId)?.leftHouse;
  return lh !== undefined && lh.building === ctx.map.buildings[bi]?.id && state.tick - lh.tick < secondsToTicks(ctx.catalog.behaviour.soldier.houseReenterSeconds);
}

/**
 * The house rule for one man (decisions.ts, every decision step): true when he is now on his way out.
 */
export function houseLeaveDecision(ctx: SimContext, state: SimState, events: EventSink, id: EntityId, s: SoldierState, unitId: EntityId): boolean {
  const S = ctx.catalog.behaviour.soldier;
  if (!S.houseLeave) return false;
  const me = state.transform.req(id);
  const bi = indoorAt(ctx, me.x, me.y);
  if (bi < 0) return false;
  const unit = state.unit.get(unitId);
  if (!unit) return false;
  const m = state.mover.get(id);
  const w = m?.waypoints;
  if (w && w.length > 0 && w[w.length - 1]!.bolt === true) return false; // on his way out already
  const b = ctx.map.buildings[bi]!;
  const lh = unit.leftHouse, tick = state.tick;
  const retry = (): boolean => { const lt = unit.leaveTry; return lt !== undefined && lt.building === b.id && tick - lt.tick < secondsToTicks(S.houseLeaveRetryS); };
  let trapSince = -Infinity;
  if (lh && lh.building === b.id && tick - lh.tick < secondsToTicks(S.houseReenterSeconds)) {
    if (unit.orderTick <= lh.tick) {
      // His unit has left this house: he follows (he stayed to fight in his room).
      if (retry()) return false;
      const th = houseThreat(ctx, state, s, unit, bi, [id]);
      if (th && th.fight.includes(id)) return false;
      if (leaveHouse(ctx, state, [id], bi, th?.bearings ?? []) > 0) return true;
      unit.leaveTry = { building: b.id, tick };
      return false;
    }
    // An order since (it put the unit back, or any other): the house is looked at afresh; a trap needs a new burst.
    trapSince = unit.orderTick;
  }
  if (retry()) return false;
  const men = menIn(ctx, state, unit, bi);
  const th = houseThreat(ctx, state, s, unit, bi, men, trapSince);
  if (!th) return false;
  const go = men.filter((o) => !th.fight.includes(o));
  // (Nobody could be sent out — all fighting in their rooms, or no way out found: no leaving reported; look again later.)
  if (leaveHouse(ctx, state, go, bi, th.bearings) === 0) { unit.leaveTry = { building: b.id, tick }; return false; }
  unit.leftHouse = { building: b.id, tick, reason: th.reason };
  const key = th.reason === "trap" ? "radio.houseLeftTrap" : th.reason === "enemy" ? "radio.houseLeftEnemy" : "radio.houseLeftFlank";
  events.emit({ kind: "radio", tick, side: unit.side, from: id, key, params: { callsign: unit.callsign } });
  const w2 = state.mover.get(id)?.waypoints;
  return w2 !== undefined && w2.length > 0 && w2[w2.length - 1]!.bolt === true;
}
