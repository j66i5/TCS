/**
 * SURRENDER (M6.6, owner decisions 2026-11-12; values in core/behaviour.json `surrender`, the same for every side).
 *
 *   gives up   A conscious wounded man who can no longer fight ("downed") gives up when an enemy he knows of is
 *              within `downedEnemyM` and no fit comrade of his is within `comradeNearM`. A panicked or routed man
 *              gives up when an enemy he knows of is within `caughtEnemyM` (comrades or not). "An enemy he knows
 *              of" = one of his own contacts, seen or reported (not only heard), no older than
 *              `decisions.contactLostSeconds`, not himself known to have given up, and not himself down.
 *   effect     He stops fighting for good (`captive`; `isAble` is false from then on): no orders, no fire, no
 *              radio; the lead passes on. Enemies hold their fire once THEY have seen it (contacts.ts sets the
 *              flag on their own contact) — until then he can still be shot.
 *   walk over  (owner 2026-11-14) A surrendered man who can walk (conscious, `impair.canWalk`) walks over to give
 *              himself up: upright, hands up, at `walkSpeedFactor` of a walk, never hurried into a run, to a point
 *              `handOverM` short of the nearest fit enemy on foot within `walkToEnemyM` whom he knew of when he
 *              gave up (his own contacts, seen or reported: a prisoner sees nothing new) or who sees him now (a
 *              fresh "seen" contact on him: who sees him, he can see); a man who has seen him give up counts at
 *              `walkSeenFactor` of his distance. He walks to where he sees that man, else to where he last knew
 *              him. Else (no such man) toward the nearest enemy he knew of at all. That man moving `walkReplanM` or more, falling
 *              or getting into a vehicle: he plans afresh (another man if need be). Fire close to him
 *              (suppression from `decisions.seekCoverSuppression`): he lies down and waits until it fades.
 *              After `walkTimeoutSeconds`, or if he can no longer walk, the walk is over (`handOver.done`) and he
 *              waits where he is. His weapon stays behind in effect: a prisoner never fires (`isAble` false); no
 *              ground container exists to drop it into (logged in DECISIONS.md).
 *   capture    A fit enemy within `captureM` with a clear line to him takes him prisoner (checked every tick); he
 *              stops there, and the captor, if idle, turns to face him.
 *              When it is quiet and he is not walking over, ONE fit enemy within `fetchWithinM` who has seen the
 *              surrender walks over to take him and then returns to where he stood (`takePrisoner` intent; any order ends the errand).
 *   attackers  A man of the attacking side (SideState.posture) or of a unit in an assault does not give up when
 *              panicked or routed (he runs back), and when downed only with an enemy within `attackerDownedEnemyM`.
 *   cost       Like a casualty: `isOut` (objectives.ts score, commander losses). No stress to comrades (owner);
 *              a leader giving up still shakes his unit (the shared leader-loss path).
 * This file owns `captive`; target choice elsewhere reads only the chooser's own contact flag.
 * No random draws. Squared distances only.
 */
import { isMounted } from "../mount";
import type { SoldierState, SurrenderReason } from "../components";
import type { SimContext } from "../context";
import { routeBetween, routeWaypoints } from "../interior-nav";
import type { EventSink } from "../events";
import { secondsToTicks, type EntityId } from "../ids";
import { isAble, isConscious, isFit } from "../impair";
import { eyeHeightM, sight, TARGET_POINT_M } from "../los";

import { navFor } from "../navctx";
import type { SimState } from "../state";
import { standZ } from "../terrain";
import { takeOutOfFight } from "./wounds";
import { requestPosture } from "./body";
import { atan2, hypot2 } from "../math";

/** The owner's "can no longer fight": a conscious wounded man who cannot fight (whether or not he can walk). */
export function isDowned(s: SoldierState): boolean {
  return s.wounds.length > 0 && !s.impair.canFight;
}

function topOf(state: SimState, unit: EntityId): EntityId {
  let u = unit;
  for (let p = state.unit.get(u)?.parent ?? null; p !== null; p = state.unit.get(u)?.parent ?? null) u = p;
  return u;
}

/** Squared distance from him to the nearest enemy he knows of (Infinity if none). */
function nearestKnownEnemy2(ctx: SimContext, state: SimState, id: EntityId, s: SoldierState): number {
  const me = state.transform.req(id);
  const lost = secondsToTicks(ctx.catalog.behaviour.decisions.contactLostSeconds);
  let best = Infinity;
  for (const c of s.contacts) {
    if (c.kind === "heard" || c.surrendered === true || c.down === true || state.tick - c.tick > lost) continue;
    const es = state.soldier.get(c.target);
    if (!es || es.casualty !== "none") continue;
    const d2 = (c.x - me.x) * (c.x - me.x) + (c.y - me.y) * (c.y - me.y);
    if (d2 < best) best = d2;
  }
  return best;
}

/** Is he an attacker: his side attacks in this battle, or his unit (or one above it) is in an assault? */
function attacking(state: SimState, id: EntityId): boolean {
  const ident = state.identity.req(id);
  if (state.sides.find((x) => x.id === ident.side)?.posture === "attack") return true;
  for (let u: EntityId | null = ident.unit; u !== null; u = state.unit.get(u)?.parent ?? null) {
    { const k = state.unit.get(u)?.drill?.kind; if (k === "assault" || k === "clear") return true; }
  }
  return false;
}

function givesUp(ctx: SimContext, state: SimState, id: EntityId, s: SoldierState): SurrenderReason | null {
  const R = ctx.catalog.behaviour.surrender;
  const scared = s.mental.behaviour === "panicked" || s.mental.behaviour === "routed";
  const downed = isDowned(s);
  if (!scared && !downed) return null;
  // Attackers (the attacking side, or any unit in an assault) are less likely to give up (owner).
  const att = attacking(state, id);
  if (att && !downed && !R.attackerPanicGivesUp) return null;
  const d2 = nearestKnownEnemy2(ctx, state, id, s);
  const downedM = att ? R.attackerDownedEnemyM : R.downedEnemyM;
  if (downed && downedM > 0 && d2 <= downedM * downedM) {
    const me = state.transform.req(id), side = state.identity.req(id).side, r2 = R.comradeNearM * R.comradeNearM;
    let comrade = false;
    // mounted: ok a comrade aboard a vehicle close by still counts as help at hand
    for (const [m, ms] of state.soldier.entries()) {
      if (m === id || state.identity.get(m)?.side !== side || !isFit(ms)) continue;
      const t = state.transform.req(m);
      if ((t.x - me.x) * (t.x - me.x) + (t.y - me.y) * (t.y - me.y) <= r2) { comrade = true; break; }
    }
    if (!comrade) return "wounded";
  }
  if (scared && (!att || R.attackerPanicGivesUp) && R.caughtEnemyM > 0 && d2 <= R.caughtEnemyM * R.caughtEnemyM) return s.mental.behaviour === "panicked" ? "panicked" : "routed";
  return null;
}

/** He gives up now (also for tests). */
export function surrender(ctx: SimContext, state: SimState, events: EventSink, id: EntityId, reason: SurrenderReason): void {
  const s = state.soldier.req(id);
  if (s.captive !== null) return;
  s.captive = { state: "surrendered", tick: state.tick };
  const from = s.mental.behaviour;
  s.mental.behaviour = "surrendered";
  s.intent = null;
  s.evade = null;
  events.emit({ kind: "behaviour.changed", tick: state.tick, soldier: id, from, to: "surrendered" });
  events.emit({ kind: "surrendered", tick: state.tick, soldier: id, side: state.identity.req(id).side, reason });
  takeOutOfFight(ctx, state, events, id, "surrendered", null);
}

/** A fit enemy within reach and a clear line: the prisoner's captor (first in ID order), or null. */
function captor(ctx: SimContext, state: SimState, id: EntityId): EntityId | null {
  const R = ctx.catalog.behaviour.surrender;
  const p = state.transform.req(id), ps = state.soldier.req(id), side = state.identity.req(id).side, r2 = R.captureM * R.captureM;
  for (const [m, ms] of state.soldier.entries()) {
    // A man aboard a vehicle takes nobody prisoner (M7.2).
    if (state.identity.get(m)?.side === side || !isFit(ms) || isMounted(ms)) continue;
    const t = state.transform.req(m);
    if ((t.x - p.x) * (t.x - p.x) + (t.y - p.y) * (t.y - p.y) > r2) continue;
    const ez = standZ(ctx.map, t) + eyeHeightM(ctx, ms.posture);
    const pz = standZ(ctx.map, p) + TARGET_POINT_M[ps.posture];
    if (sight(ctx, t.x, t.y, ez, p.x, p.y, pz).blockedBy === null) return m;
  }
  return null;
}

/** Walk a man to (x, y) at height `gz` above the ground (his floor: a prisoner upstairs, M7.5 review fix). */
function walkTo(ctx: SimContext, state: SimState, id: EntityId, x: number, y: number, endProne: boolean, gz = 0): boolean {
  const t = state.transform.req(id), m = state.mover.get(id);
  if (!m) return false;
  const leg = routeBetween(ctx, navFor(ctx, "foot").search, t.x, t.y, x, y, { maxExpansions: 6000, snapCells: 3 }, { sz: t.z, gz });
  if (!leg) return false;
  m.waypoints = routeWaypoints(leg, { x: 0, y: 0, mode: "walk" });
  m.formation = null; m.endPosture = endProne ? "prone" : null; m.endHeading = null;
  return true;
}

function halt(state: SimState, id: EntityId): void {
  const m = state.mover.get(id);
  if (m) { m.waypoints = []; m.speedMps = 0; m.endPosture = null; m.endHeading = null; }
}

/** Is his unit (its top) quiet: not fired upon for `fetchQuietSeconds`, no drill, not broken? */
function quiet(ctx: SimContext, state: SimState, id: EntityId): boolean {
  const R = ctx.catalog.behaviour.surrender;
  const u = state.identity.req(id).unit;
  const top = state.unit.get(topOf(state, u)), own = state.unit.get(u);
  if (!top || !own || own.drill || top.drill || top.broken || own.broken) return false;
  // (Not right after an order to his unit either: orders win.)
  const q = secondsToTicks(R.fetchQuietSeconds);
  return state.tick - top.underFireTick >= q && state.tick - own.orderTick >= q;
}

/**
 * Whom he walks to: the nearest fit enemy on foot within `walkToEnemyM` whom he knew of when he gave up (his own
 * contact, seen or reported) or who sees him now (that man's own contact: who sees him, he can see), a man who has
 * seen him give up counting at `walkSeenFactor` of his distance; where he sees him, else where he last knew him.
 * Else the nearest enemy he knew of at all (heard, or a man now down): toward him, `to` null. null: nobody.
 */
function handOverTarget(ctx: SimContext, state: SimState, id: EntityId, s: SoldierState): { to: EntityId | null; x: number; y: number; z: number } | null {
  const R = ctx.catalog.behaviour.surrender, lost = secondsToTicks(ctx.catalog.behaviour.decisions.contactLostSeconds);
  const me = state.transform.req(id), side = state.identity.req(id).side, since = s.captive!.tick - lost;
  const r2 = R.walkToEnemyM * R.walkToEnemyM, f2 = R.walkSeenFactor * R.walkSeenFactor;
  let best: EntityId | null = null, bestS = Infinity, bx = 0, by = 0, bz = 0, bSees = false;
  // mounted: ok men aboard are skipped (nobody aboard takes a prisoner)
  for (const [m, ms] of state.soldier.entries()) {
    if (state.identity.get(m)?.side === side || !isFit(ms) || isMounted(ms)) continue;
    const mine = s.contacts.find((c) => c.target === m);
    const knew = mine !== undefined && mine.kind !== "heard" && mine.surrendered !== true && mine.down !== true && mine.tick >= since;
    const theirs = ms.contacts.find((k) => k.target === id);
    const sees = theirs !== undefined && theirs.kind === "seen" && state.tick - theirs.tick <= lost;
    if (!knew && !sees) continue;
    const t = state.transform.req(m);
    const x = sees ? t.x : mine!.x, y = sees ? t.y : mine!.y;
    const d2 = (x - me.x) * (x - me.x) + (y - me.y) * (y - me.y);
    if (d2 > r2) continue;
    const sc = theirs?.surrendered === true ? d2 * f2 : d2;
    if (sc < bestS) { bestS = sc; best = m; bx = x; by = y; bz = sees ? t.z : mine!.z ?? 0; bSees = sees; }
  }
  if (best !== null) {
    if (!bSees) {
      // Where he sees him now, else where he last knew him.
      const t = state.transform.req(best), es = state.soldier.req(best);
      const ez = standZ(ctx.map, me) + eyeHeightM(ctx, s.posture), tz = standZ(ctx.map, t) + TARGET_POINT_M[es.posture];
      if (sight(ctx, me.x, me.y, ez, t.x, t.y, tz).blockedBy === null) { bx = t.x; by = t.y; bz = t.z; }
    }
    return { to: best, x: bx, y: by, z: bz };
  }
  let fall: { to: null; x: number; y: number; z: number } | null = null, fallD = r2;
  for (const c of s.contacts) {
    if (c.surrendered === true || c.cls === "vehicle" || c.tick < since) continue;
    const d2 = (c.x - me.x) * (c.x - me.x) + (c.y - me.y) * (c.y - me.y);
    if (d2 <= fallD) { fallD = d2; fall = { to: null, x: c.x, y: c.y, z: c.z ?? 0 }; }
  }
  return fall;
}

/** Walk him (a surrendered man) over to give himself up; called every `stepSeconds` (header "walk over"). */
function walkOver(ctx: SimContext, state: SimState, events: EventSink, id: EntityId, s: SoldierState): void {
  const R = ctx.catalog.behaviour.surrender, D = ctx.catalog.behaviour.decisions;
  const h = s.handOver;
  if (h?.done) return;
  const m = state.mover.get(id);
  if (!m) return;
  // He can no longer walk, or has walked long enough: he waits where he is.
  if (!isConscious(s) || !s.impair.canWalk || (h && state.tick - h.tick > secondsToTicks(R.walkTimeoutSeconds))) {
    if (h) { h.done = true; halt(state, id); }
    return;
  }
  // Fire close to him: down, and wait for it to pass (he does not set off under fire either).
  if (s.mental.suppression >= D.seekCoverSuppression) {
    if (h) { h.down = true; halt(state, id); requestPosture(ctx, state, id, "prone"); }
    return;
  }
  const goal = handOverTarget(ctx, state, id, s);
  if (goal === null) {
    if (h) { h.done = true; halt(state, id); }
    return;
  }
  const t = state.transform.req(id);
  const dx = t.x - goal.x, dy = t.y - goal.y, d2 = dx * dx + dy * dy, near = R.handOverM + 0.5;
  // There: he stands and waits to be taken.
  if (d2 <= near * near) {
    if (h) { delete h.down; h.x = t.x; h.y = t.y; h.z = t.z; }
    halt(state, id);
    if (s.posture !== "standing") requestPosture(ctx, state, id, "standing");
    return;
  }
  // `handOverM` short of him, on the line from him.
  const L = Math.max(1e-6, hypot2(dx, dy));
  const gx = goal.x + (dx / L) * R.handOverM, gy = goal.y + (dy / L) * R.handOverM;
  const moving = m.waypoints.length > 0;
  if (h && !h.down && moving && h.to === goal.to && (h.x - gx) * (h.x - gx) + (h.y - gy) * (h.y - gy) < R.walkReplanM * R.walkReplanM) return;
  const leg = routeBetween(ctx, navFor(ctx, "foot").search, t.x, t.y, gx, gy, { maxExpansions: 6000, snapCells: 3 }, { sz: t.z, gz: goal.z });
  if (!leg) { if (h && !moving) h.done = true; return; }
  m.waypoints = routeWaypoints(leg, { x: 0, y: 0, mode: "walk", posture: "standing" as const });
  m.formation = null; m.endPosture = "standing"; m.endHeading = null;
  if (h) { h.to = goal.to; h.x = gx; h.y = gy; h.z = goal.z; delete h.down; }
  else {
    s.handOver = { to: goal.to, x: gx, y: gy, z: goal.z, tick: state.tick };
    events.emit({ kind: "surrender.walk", tick: state.tick, soldier: id, side: state.identity.req(id).side, to: goal.to });
  }
}

export function surrenderSystem(ctx: SimContext, state: SimState, events: EventSink): void {
  const R = ctx.catalog.behaviour.surrender, D = ctx.catalog.behaviour.decisions;
  const every = Math.max(1, secondsToTicks(R.stepSeconds));
  const step = (id: EntityId) => (id + state.tick) % every === 0;

  // ---- the walk-over errands (one walker per prisoner)
  const walkers = new Map<EntityId, EntityId>(); // prisoner -> walker (lookups only)
  // mounted: ok a man aboard has no errand (decisions clear his intent)
  for (const [id, s] of state.soldier.entries()) {
    const it = s.intent;
    if (it?.kind !== "takePrisoner" || it.target === undefined) continue;
    const ps = state.soldier.get(it.target);
    const done = ps?.captive?.state === "captured";
    if (done) {
      const me = state.transform.req(id);
      s.intent = null; walkTo(ctx, state, id, it.x ?? me.x, it.y ?? me.y, true, it.x !== undefined ? it.z ?? 0 : me.z); continue;
    }
    if (!isFit(s) || s.mental.suppression >= D.seekCoverSuppression || !ps || !ps.physiology.alive || ps.captive?.state !== "surrendered"
      || state.tick - it.tick > secondsToTicks(R.fetchTimeoutSeconds)) {
      s.intent = null; halt(state, id); continue;
    }
    walkers.set(it.target, id);
  }

  for (const [id, s] of state.soldier.entries()) {
    // A man aboard a vehicle does not give up (M7.2, plan §6); a prisoner is never aboard.
    if (isMounted(s)) continue;
    if (s.captive !== null) {
      // A surrendered man is taken prisoner by a fit enemy who reaches him (every tick).
      if (s.captive.state === "surrendered" && s.physiology.alive && R.captureM > 0) {
        const by = captor(ctx, state, id);
        if (by !== null) {
          s.captive.state = "captured";
          // He stops where he is; his captor, if idle, turns to cover him.
          if (s.handOver) { delete s.handOver; halt(state, id); }
          const bm = state.mover.get(by);
          if ((bm?.waypoints.length ?? 0) === 0 && !state.fire.has(by)) {
            const bt = state.transform.req(by), p = state.transform.req(id);
            bt.heading = atan2(p.y - bt.y, p.x - bt.x);
          }
          events.emit({ kind: "captured", tick: state.tick, soldier: id, side: state.identity.req(id).side, by });
          continue;
        }
        // Nobody close yet: if he can, he walks over to give himself up (owner 2026-11-14).
        if (R.walkToEnemyM > 0 && step(id)) walkOver(ctx, state, events, id, s);
        // When quiet, one fit enemy who has seen it walks over (to a man who is not on his way).
        const walking = s.handOver !== undefined && s.handOver.done !== true;
        if (R.fetchWithinM > 0 && step(id) && !walkers.has(id) && !walking) {
          const p = state.transform.req(id), side = state.identity.req(id).side, r2 = R.fetchWithinM * R.fetchWithinM;
          const seen = secondsToTicks(D.seenWithinSeconds);
          let best: EntityId | null = null, bestD = Infinity;
          for (const [m, ms] of state.soldier.entries()) {
            if (state.identity.get(m)?.side === side || !isFit(ms) || isMounted(ms) || ms.intent !== null || ms.evade !== null) continue;
            if (ms.mental.suppression >= D.underFireSuppression || state.fire.has(m) || state.action.has(m)) continue;
            if ((state.mover.get(m)?.waypoints.length ?? 0) > 0) continue;
            const c = ms.contacts.find((k) => k.target === id);
            if (!c || c.surrendered !== true || c.kind !== "seen" || state.tick - c.tick > seen) continue;
            const t = state.transform.req(m);
            const d2 = (t.x - p.x) * (t.x - p.x) + (t.y - p.y) * (t.y - p.y);
            if (d2 > r2 || d2 >= bestD || !quiet(ctx, state, m)) continue;
            bestD = d2; best = m;
          }
          if (best !== null) {
            const t = state.transform.req(best);
            const dx = t.x - p.x, dy = t.y - p.y, L = Math.max(1e-6, Math.abs(dx) + Math.abs(dy));
            // To his side, a step short of him.
            if (walkTo(ctx, state, best, p.x + (dx / L) * 1.5, p.y + (dy / L) * 1.5, false, p.z)) {
              state.soldier.req(best).intent = { kind: "takePrisoner", tick: state.tick, target: id, x: t.x, y: t.y, ...(t.z > 0 ? { z: t.z } : {}) };
              walkers.set(id, best);
            }
          }
        }
      }
      continue;
    }
    if (!step(id) || !isAble(s)) continue;
    const reason = givesUp(ctx, state, id, s);
    if (reason !== null) surrender(ctx, state, events, id, reason);
  }
}
