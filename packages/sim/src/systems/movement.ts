/**
 * Movement, M0 version: straight lines between waypoints at the movement mode's nominal speed.
 * M1 adds the heightfield, terrain costs, pathfinding, postures, formations and fatigue.
 */
import type { SimContext } from "../context";
import type { EventSink } from "../events";
import { DT } from "../ids";
import { atan2, hypot2 } from "../math";
import type { SimState } from "../state";
import { radioFromTarget, unitSoldiers } from "./orders";
import { navCostAt } from "../nav";
import { navFor } from "../navctx";

export function movementSystem(ctx: SimContext, state: SimState, events: EventSink): void {
  for (const [id, m] of state.mover.entries()) {
    const wp = m.waypoints[0];
    if (!wp) {
      m.speedMps = 0;
      continue;
    }
    const t = state.transform.req(id);
    const mode = ctx.catalog.movementModes[wp.mode];
    // Terrain slows movement: nominal speed divided by the cost of the ground underfoot (woods, ploughed
    // fields, climbing a wall). Slope, load and fatigue come in M1.3.
    const k = mode ? navCostAt(navFor(ctx, mode.class).grid, t.x, t.y) : 0;
    const speed = mode ? mode.speedMps / (k > 0 ? k : 1) : 0;
    const step = speed * DT;
    const dx = wp.x - t.x;
    const dy = wp.y - t.y;
    const dist = hypot2(dx, dy);
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
