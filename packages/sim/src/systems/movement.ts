/**
 * Movement, M0 version: straight lines between waypoints at the movement mode's nominal speed.
 * M1 adds the heightfield, terrain costs, pathfinding, postures, formations and fatigue.
 */
import type { SimContext } from "../context";
import type { EventSink } from "../events";
import { DT } from "../ids";
import { atan2, clamp, exp, hypot2 } from "../math";
import { heightAt } from "../terrain";
import { loadKg, requestPosture } from "./body";
import type { SimState } from "../state";
import { radioFromTarget, unitSoldiers } from "./orders";
import { navCostAt } from "../nav";
import { navFor } from "../navctx";

export function movementSystem(ctx: SimContext, state: SimState, events: EventSink): void {
  const B = ctx.catalog.body;
  for (const [id, m] of state.mover.entries()) {
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
    // Take the leg's posture first (the waypoint's, else the mode's); no movement while changing.
    const posture = wp.posture ?? mode.posture;
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
      const look = Math.min(dist, 2);
      const g = (heightAt(ctx.map, t.x + (dx / dist) * look, t.y + (dy / dist) * look) - heightAt(ctx.map, t.x, t.y)) / look;
      m.grade = g;
      // Tobler's hiking function, normalised to 1 on level ground.
      speed *= exp(-B.movement.slopeK * Math.abs(g + B.movement.slopeOffset)) / exp(-B.movement.slopeK * Math.abs(B.movement.slopeOffset));
    }
    if (s) {
      const load = loadKg(ctx, state, id);
      speed *= clamp(1 - B.movement.loadSpeedPerKg * Math.max(0, load - B.movement.loadFreeKg), B.movement.minLoadSpeedFactor, 1);
      speed *= 1 - B.movement.fatigueSpeedPenalty * s.physical.fatigue;
      // Exhausted men cannot keep up hard paces (running): they drop to half speed.
      if (mode.exertion > 0.6 && s.physical.fatigue >= B.movement.noRunFatigue) speed *= 0.5;
    }
    const step = speed * DT;
    if (dist > 1e-9) t.heading = atan2(dy, dx);
    if (dist <= step) {
      t.x = wp.x;
      t.y = wp.y;
      m.waypoints.shift();
      m.speedMps = m.waypoints.length > 0 ? speed : 0;
    } else {
      t.x += (dx / dist) * step;
      t.y += (dy / dist) * step;
      m.speedMps = speed;
    }
  }

  // Unit arrival: a moving unit whose men have all finished their waypoints.
  for (const [uid, u] of state.unit.entries()) {
    if (!u.moving) continue;
    const men = unitSoldiers(state, uid);
    if (men.every((s) => (state.mover.get(s)?.waypoints.length ?? 0) === 0)) {
      u.moving = false;
      events.emit({ kind: "unit.arrived", tick: state.tick, unit: uid });
      radioFromTarget(state, uid, "radio.arrived", events);
    }
  }
}
