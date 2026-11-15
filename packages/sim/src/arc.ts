/** Defend arc (D4b, `defendArc` order): is a point within the arc a man's unit defends? */
import type { EntityId } from "./ids";
import { atan2, wrapAngle } from "./math";
import type { SimState } from "./state";

/** Is (x, y) within the arc his unit defends (D4b, `defendArc`)? Always, without one. */
export function inArc(state: SimState, id: EntityId, me: { x: number; y: number }, x: number, y: number): boolean {
  const u = state.identity.get(id)?.unit;
  const arc = u !== undefined ? state.unit.get(u)?.arc : undefined;
  return arc === undefined || Math.abs(wrapAngle(atan2(y - me.y, x - me.x) - arc.facing)) <= arc.halfRad + 1e-9;
}
