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
 *   capture    A fit enemy within `captureM` with a clear line to him takes him prisoner (checked every tick).
 *              When it is quiet, ONE fit enemy within `fetchWithinM` who has seen the surrender walks over to
 *              take him and then returns to where he stood (`takePrisoner` intent; any order ends the errand).
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
import { isAble, isFit } from "../impair";
import { eyeHeightM, sight, TARGET_POINT_M } from "../los";

import { navFor } from "../navctx";
import type { SimState } from "../state";
import { standZ } from "../terrain";
import { takeOutOfFight } from "./wounds";

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
    if (state.unit.get(u)?.drill?.kind === "assault") return true;
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
          events.emit({ kind: "captured", tick: state.tick, soldier: id, side: state.identity.req(id).side, by });
          continue;
        }
        // Nobody close yet: when quiet, one fit enemy who has seen it walks over.
        if (R.fetchWithinM > 0 && step(id) && !walkers.has(id)) {
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
