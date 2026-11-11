/**
 * Movement, M0 version: straight lines between waypoints at the movement mode's nominal speed.
 * M1 adds the heightfield, terrain costs, pathfinding, postures, formations and fatigue.
 */
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
import { radioFromTarget, unitSoldiers } from "./orders";
import type { EntityId } from "../ids";
import { navCostAt } from "../nav";
import { navFor } from "../navctx";
import { isAble } from "../impair";

export function movementSystem(ctx: SimContext, state: SimState, events: EventSink): void {
  const B = ctx.catalog.body;
  // Leaders wait for followers who fell far behind their slots (last tick's lag; deterministic order).
  const worstLag = new Map<EntityId, number>();
  for (const [, m] of state.mover.entries()) {
    if (m.formation && m.waypoints.length > 0) worstLag.set(m.formation.leader, Math.max(worstLag.get(m.formation.leader) ?? 0, m.slotLagM));
  }
  for (const [id, m] of state.mover.entries()) {
    // Getting away from a grenade comes first (grenades.ts moves him and records his speed); he resumes his
    // way afterwards.
    const ev = state.soldier.get(id)?.evade;
    if (ev && state.tick >= ev.startTick) continue;
    const wp = m.waypoints[0];
    if (!wp) {
      m.speedMps = 0;
      m.mode = null;
      continue;
    }
    const t = state.transform.req(id);
    const mode = ctx.catalog.movementModes[wp.mode];
    const s = state.soldier.get(id);
    m.mode = wp.mode;
    if (!mode) { m.speedMps = 0; continue; }
    // Knocked down (a round stopped by his armour): he lies where he fell until it passes.
    if (s && state.tick < s.stunnedUntilTick) { m.speedMps = 0; continue; }
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
    if (dist > 1e-9) {
      const look = Math.min(dist, B.movement.slopeLookAheadM);
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
      m.speedMps = speed;
    }
  }

  // Unit arrival: a moving unit whose men have all finished their waypoints.
  for (const [uid, u] of state.unit.entries()) {
    if (!u.moving) continue;
    const men = unitSoldiers(state, uid).filter((s) => isAble(state.soldier.get(s)));
    if (men.length === 0) { u.moving = false; continue; } // nobody left to arrive
    if (men.every((s) => (state.mover.get(s)?.waypoints.length ?? 0) === 0)) {
      u.moving = false;
      events.emit({ kind: "unit.arrived", tick: state.tick, unit: uid });
      radioFromTarget(state, uid, "radio.arrived", events);
    }
  }
}
