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
import { isAble } from "./impair";

export interface KnownEnemy {
  target: EntityId;
  x: number;
  y: number;
  /** Uncertainty now, m (grows with age). */
  errM: number;
  kind: Contact["kind"];
  /** Seconds since the information was true. */
  ageS: number;
  /** Some able man of the side knows he has given up (M6.6). */
  surrendered: boolean;
}

/** The side's picture of the enemy, ascending target ID. */
export function sideKnowledge(ctx: SimContext, state: SimView, side: string): KnownEnemy[] {
  const best = new Map<EntityId, { c: Contact; err: number }>();
  const flagged = new Set<EntityId>();
  // mounted: ok what men aboard know is passed on too; a man aboard is never listed (below)
  for (const [id, s] of state.soldier.entries()) {
    // Only men who are alive, conscious and still in the fight (what they know can still be passed on).
    if (!isAble(s) || state.identity.get(id)?.side !== side) continue;
    for (const c of s.contacts) {
      if (c.surrendered) flagged.add(c.target);
      const err = contactErrorM(ctx, c, state.tick);
      const b = best.get(c.target);
      if (!b || err < b.err) best.set(c.target, { c, err });
    }
  }
  return [...best.entries()].filter(([target]) => state.soldier.get(target)?.mount === undefined).sort((a, b) => a[0] - b[0]).map(([target, { c, err }]) => ({
    target, x: c.x, y: c.y, errM: err, kind: c.kind, ageS: (state.tick - c.tick) / 60, surrendered: flagged.has(target),
  }));
}
