/**
 * WHAT A SIDE KNOWS (SPEC 6.5, M3.4): the union of its soldiers' contacts — for each enemy, the most certain
 * picture any of its living men holds now. This is all the player is shown of the enemy (fog of war), and what
 * an AI commander will plan on (M6). Pure query on the state.
 */
import type { Contact } from "./components";
import type { SimContext } from "./context";
import type { EntityId } from "./ids";
import type { SimView } from "./state";
import { contactErrorM } from "./systems/contacts";

export interface KnownEnemy {
  target: EntityId;
  x: number;
  y: number;
  /** Uncertainty now, m (grows with age). */
  errM: number;
  kind: Contact["kind"];
  /** Seconds since the information was true. */
  ageS: number;
}

/** The side's picture of the enemy, ascending target ID. */
export function sideKnowledge(ctx: SimContext, state: SimView, side: string): KnownEnemy[] {
  const best = new Map<EntityId, { c: Contact; err: number }>();
  for (const [id, s] of state.soldier.entries()) {
    // Only men who are alive and conscious (what they know can still be passed on).
    if (!s.physiology.alive || s.physiology.consciousness < 0.5 || state.identity.get(id)?.side !== side) continue;
    for (const c of s.contacts) {
      const err = contactErrorM(ctx, c, state.tick);
      const b = best.get(c.target);
      if (!b || err < b.err) best.set(c.target, { c, err });
    }
  }
  return [...best.entries()].sort((a, b) => a[0] - b[0]).map(([target, { c, err }]) => ({
    target, x: c.x, y: c.y, errM: err, kind: c.kind, ageS: (state.tick - c.tick) / 60,
  }));
}
