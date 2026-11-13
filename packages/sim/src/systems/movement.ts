/**
 * Movement, M0 version: straight lines between waypoints at the movement mode's nominal speed.
 * M1 adds the heightfield, terrain costs, pathfinding, postures, formations and fatigue.
 */
import { footModeOrUndefined } from "../catalog";
import type { SimContext } from "../context";
import type { EventSink } from "../events";
import { DT } from "../ids";
import { atan2, clamp, cos, exp, hypot2, sin } from "../math";

/** Distance a follower may be ahead of or behind his formation slot before adjusting speed, m. */
const FORMATION_SLACK_M = 3;
/** The leader slows to half pace while any follower is more than this far behind his slot, m. */
const LEADER_WAIT_LAG_M = 15;
import { heightAt } from "../terrain";
import { loadKg, requestPosture } from "./body";
import type { SimState } from "../state";
import { radioFromTarget } from "./orders";
import type { EntityId } from "../ids";
import { navCostAt } from "../nav";
import { indoorAt } from "../interior-nav";
import { navFor } from "../navctx";
import { isAble } from "../impair";
import { isCowering } from "./morale";
import { pointInObb, PUSH, type Obb } from "../hulls";

/** Pace on stairs relative to the same pace on level ground (M7.5d; game values, not from data yet). */
const STAIRS_UP_FACTOR = 0.5;
const STAIRS_DOWN_FACTOR = 0.6;

export function movementSystem(ctx: SimContext, state: SimState, events: EventSink): void {
  const B = ctx.catalog.body;
  // Leaders wait for followers who fell far behind their slots (last tick's lag; deterministic order).
  const worstLag = new Map<EntityId, number>();
  // mounted: ok a man aboard has no waypoints
  for (const [, m] of state.mover.entries()) {
    if (m.formation && m.waypoints.length > 0) worstLag.set(m.formation.leader, Math.max(worstLag.get(m.formation.leader) ?? 0, m.slotLagM));
  }
  // mounted: ok men aboard are skipped below (they ride in their seats)
  for (const [id, m] of state.mover.entries()) {
    // Getting away from a grenade comes first (grenades.ts moves him and records his speed); he resumes his
    // way afterwards.
    const ev = state.soldier.get(id)?.evade;
    if (ev && state.tick >= ev.startTick) continue;
    // A man aboard a vehicle rides in his seat (M7; drive.ts moves him).
    if (state.soldier.get(id)?.mount !== undefined) { m.speedMps = 0; m.mode = null; continue; }
    const wp = m.waypoints[0];
    if (!wp) {
      m.speedMps = 0;
      m.mode = null;
      continue;
    }
    const t = state.transform.req(id);
    const mode = footModeOrUndefined(ctx.catalog, wp.mode);
    const s = state.soldier.get(id);
    m.mode = wp.mode;
    if (!mode) { m.speedMps = 0; continue; }
    // Knocked down (a round stopped by his armour): he lies where he fell until it passes.
    if (s && state.tick < s.stunnedUntilTick) { m.speedMps = 0; continue; }
    // Pinned or panicked (M4.1): he lies flat where he is; his way is kept for when he gets up again.
    if (s && isCowering(s) && s.evade === null) {
      m.speedMps = 0;
      if (s.posture !== "prone" && s.postureTo === null) requestPosture(ctx, state, id, "prone");
      continue;
    }
    // Take the leg's posture first (the waypoint's, else the mode's); no movement while changing.
    // A man whose leg will not carry him crawls.
    const posture = s && !s.impair.canWalk ? "prone" : (wp.posture ?? mode.posture);
    if (s && (s.posture !== posture || s.postureTo !== null)) {
      requestPosture(ctx, state, id, posture);
      m.speedMps = 0;
      continue;
    }
    const dx = wp.x - t.x;
    const dy = wp.y - t.y;
    const dist = hypot2(dx, dy);
    // Speed = mode speed x posture x slope x load x fatigue / ground cost (all factors from data).
    const k = navCostAt(navFor(ctx, mode.class).grid, t.x, t.y);
    let speed = mode.speedMps / (k > 0 ? k : 1);
    speed *= B.postures[posture].speedFactor / B.postures[mode.posture].speedFactor;
    // Height (M7.5d): a leg with a height climbs or descends evenly (stairs); a leg without one keeps his height
    // indoors and brings him to the ground outdoors (a route planned without heights from a floor above).
    let zTo = wp.z;
    if (zTo === undefined && t.z !== 0) zTo = indoorAt(ctx, wp.x, wp.y) >= 0 ? t.z : 0;
    const climb = zTo !== undefined && zTo !== t.z && dist > 1e-9;
    if (climb) {
      const g = (zTo! - t.z) / dist;
      m.grade = g;
      speed *= g > 0 ? STAIRS_UP_FACTOR : STAIRS_DOWN_FACTOR;
    } else if (dist > 1e-9) {
      const look = Math.min(dist, B.movement.slopeLookAheadM);
      // ground: ok (the slope of the ground)
      const g = (heightAt(ctx.map, t.x + (dx / dist) * look, t.y + (dy / dist) * look) - heightAt(ctx.map, t.x, t.y)) / look;
      m.grade = g;
      // Tobler's hiking function, normalised to 1 on level ground.
      speed *= exp(-B.movement.slopeK * Math.abs(g + B.movement.slopeOffset)) / exp(-B.movement.slopeK * Math.abs(B.movement.slopeOffset));
    }
    if (s) {
      const load = loadKg(ctx, state, id);
      speed *= clamp(1 - B.movement.loadSpeedPerKg * Math.max(0, load - B.movement.loadFreeKg), B.movement.minLoadSpeedFactor, 1);
      speed *= 1 - B.movement.fatigueSpeedPenalty * s.physical.fatigue;
      // Exhausted men cannot keep up hard paces (running): they slow down and recover (body.ts).
      if (mode.exertion > B.movement.hardPaceExertion && s.physical.winded) speed *= B.movement.exhaustedSpeedFactor;
      speed *= s.impair.move; // wounds: a leg wound, blood loss
    }
    // Formation keeping: a follower ahead of his slot eases off; one behind it hurries, but never beyond his
    // own unimpaired pace (tired or loaded men cannot buy their penalties back). The leader slows for laggards.
    m.slotLagM = 0;
    if (m.formation) {
      const lm = state.mover.get(m.formation.leader);
      const lt = state.transform.get(m.formation.leader);
      if (lm && lt && lm.waypoints.length > 0) {
        const fx = cos(lt.heading), fy = sin(lt.heading);
        const sx = lt.x - fy * m.formation.rightM - fx * m.formation.backM, sy = lt.y + fx * m.formation.rightM - fy * m.formation.backM;
        const ahead = (t.x - sx) * fx + (t.y - sy) * fy;
        m.slotLagM = Math.max(0, -ahead);
        if (ahead > FORMATION_SLACK_M) speed *= 0.7;
        else if (ahead < -FORMATION_SLACK_M) speed = Math.min(speed * 1.2, mode.speedMps * B.postures[posture].speedFactor / B.postures[mode.posture].speedFactor);
      }
    }
    const lag = worstLag.get(id) ?? 0;
    if (lag > LEADER_WAIT_LAG_M) speed *= 0.5;
    const step = speed * DT;
    if (dist > 1e-9) t.heading = atan2(dy, dx);
    if (dist <= step) {
      t.x = wp.x;
      t.y = wp.y;
      if (zTo !== undefined) t.z = zTo;
      m.waypoints.shift();
      m.speedMps = m.waypoints.length > 0 ? speed : 0;
      if (m.waypoints.length === 0) {
        // Halt drill: face the given way and take the given posture.
        if (m.endHeading !== null) t.heading = m.endHeading;
        if (m.endPosture !== null) requestPosture(ctx, state, id, m.endPosture);
        m.endHeading = null;
        m.endPosture = null;
        m.formation = null;
      }
    } else {
      t.x += (dx / dist) * step;
      t.y += (dy / dist) * step;
      if (climb) t.z += (zTo! - t.z) * (step / dist);
      m.speedMps = speed;
    }
  }

  // Men against hulls (M7.1c): a man inside a hull or a wreck (grown by 0.4 m) is moved out to its nearest side.
  if (ctx.ballistics.vehicles.n > 0) slideOffHulls(ctx, state);

  // Unit arrival: a moving unit whose men have all finished their waypoints (and whose vehicles have arrived).
  for (const [uid, u] of state.unit.entries()) {
    if (!u.moving) continue;
    if (u.vehicle !== undefined) continue; // a vehicle crew arrives with its vehicle (drive.ts)
    const a = unitArrived(state, uid);
    if (a === null) { u.moving = false; continue; } // nobody left to arrive
    if (a) {
      u.moving = false;
      events.emit({ kind: "unit.arrived", tick: state.tick, unit: uid });
      radioFromTarget(state, uid, "radio.arrived", events);
    }
  }
}

/**
 * Has a moving unit arrived (plan §5)? Every able man on foot of it and its sub-units has finished his way, and
 * every vehicle under it has arrived (or has no route). Men aboard vehicles are not counted. null: nobody left.
 */
export function unitArrived(state: SimState, uid: EntityId): boolean | null {
  let men = 0, done = true;
  const walk = (u: EntityId) => {
    const x = state.unit.get(u);
    if (!x) return;
    // Still getting out before carrying an order out (Q12): not there yet.
    if (x.boarding?.then) done = false;
    if (x.vehicle !== undefined && u !== uid) {
      const v = state.vehicle.get(x.vehicle);
      if (v) { men++; if (!v.drive.arrived && v.drive.routeIdx < v.drive.route.length) done = false; }
      return;
    }
    for (const m of x.members) {
      const s = state.soldier.get(m);
      if (!isAble(s) || s!.mount !== undefined) continue;
      men++;
      if ((state.mover.get(m)?.waypoints.length ?? 0) !== 0) done = false;
    }
    for (const c of x.children) walk(c);
  };
  walk(uid);
  return men === 0 ? null : done;
}

const HULL: Obb = { x: 0, y: 0, c: 1, s: 0, hl: 0, hw: 0 };
/** A man is never inside a hull: push him out to its nearest side (he walks round it from there). */
function slideOffHulls(ctx: SimContext, state: SimState): void {
  const G = ctx.ballistics.vehicles;
  for (const [id, s] of state.soldier.entries()) {
    // (A man down is left where he lies: a hull passes over him, it does not shove him along.)
    if (s.mount !== undefined || !isAble(s)) continue;
    const t = state.transform.get(id);
    if (!t) continue;
    for (let j = 0; j < G.n; j++) {
      if (t.x < G.minX[j]! - 1 || t.x > G.maxX[j]! + 1 || t.y < G.minY[j]! - 1 || t.y > G.maxY[j]! + 1) continue;
      const c = G.ch[j]!, sn = G.sh[j]!;
      const fc = (G.f0[j]! + G.f1[j]!) / 2, rc = (G.r0[j]! + G.r1[j]!) / 2;
      HULL.x = G.x[j]! + c * fc - sn * rc; HULL.y = G.y[j]! + sn * fc + c * rc; HULL.c = c; HULL.s = sn;
      HULL.hl = (G.f1[j]! - G.f0[j]!) / 2; HULL.hw = (G.r1[j]! - G.r0[j]!) / 2;
      if (pointInObb(HULL, t.x, t.y, 0.4)) {
        t.x += PUSH.x; t.y += PUSH.y;
        // A point of his way under the hull: he is there as near as he can get.
        const m = state.mover.get(id), wp = m?.waypoints[0];
        if (m && wp && pointInObb(HULL, wp.x, wp.y, 0.6)) { m.waypoints.shift(); if (m.waypoints.length === 0) m.formation = null; }
      }
    }
  }
}
