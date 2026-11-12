/**
 * OBJECTIVES AND VICTORY (M6, owner decisions 2026-11-12).
 *
 * An objective is held by the side that last had able men inside it with no able enemy there; while both are
 * inside it is contested and stays with its holder. At the end each side scores the points of the objectives
 * it holds minus `casualtyPoints` for each of its men down (killed or incapacitated). A side whose units have
 * all broken, or that has nobody able left, loses at once (`endOnDefeat`). Checked once a second.
 */
import type { SoldierState } from "../components";
import type { SimContext } from "../context";
import type { EventSink } from "../events";
import { TICK_HZ, type EntityId, type SideId } from "../ids";
import { isAble } from "../impair";
import type { SimState, SimView } from "../state";

export interface SideScore { side: SideId; objectivePoints: number; menDown: number; score: number }
export interface BattleScore { scores: SideScore[]; winner: SideId | null }

/** Set up the holders at the start of a battle. */
export function initObjectives(ctx: SimContext, state: SimState): void {
  state.objectives = ctx.rules.objectives.map((o) => ({ id: o.id, holder: o.holder, contested: false }));
}

const standing = (state: SimView, id: EntityId) => { const s = state.soldier.get(id) as SoldierState | undefined; return isAble(s) && s!.mental.behaviour !== "routed"; };

export function objectiveSystem(ctx: SimContext, state: SimState, events: EventSink): void {
  if (state.tick % TICK_HZ !== 0) return;
  const defs = ctx.rules.objectives;
  for (let i = 0; i < defs.length; i++) {
    const o = defs[i]!, st = state.objectives[i];
    if (!st) continue;
    const present = new Set<SideId>();
    for (const [id, ident] of state.identity.entries()) {
      if (!standing(state, id)) continue;
      const t = state.transform.get(id);
      const dx = t ? t.x - o.x : 0, dy = t ? t.y - o.y : 0;
      if (t && dx * dx + dy * dy <= o.radiusM * o.radiusM) present.add(ident.side);
    }
    st.contested = present.size > 1;
    if (present.size === 1) {
      const side = [...present][0]!;
      if (side !== st.holder) {
        events.emit({ kind: "objective.changed", tick: state.tick, objective: o.id, holder: side, from: st.holder });
        st.holder = side;
      }
    }
  }
  // ---- defeat: a side broken (all its top units) or with nobody able left
  const V = ctx.rules.victory;
  if (!V?.endOnDefeat || state.ended) return;
  for (const sd of state.sides) {
    const tops = [...state.unit.entries()].filter(([, u]) => u.side === sd.id && u.parent === null);
    const anyStanding = [...state.identity.entries()].some(([id, i]) => i.side === sd.id && standing(state, id));
    const allBroken = tops.length > 0 && tops.every(([, u]) => u.broken);
    if (!anyStanding || allBroken) {
      const reason = !anyStanding ? "side-eliminated" : "side-broken";
      state.ended = { tick: state.tick, reason };
      events.emit({ kind: "battle.ended", tick: state.tick, reason, loser: sd.id });
      state.endLoser = sd.id;
      return;
    }
  }
}

/** The score as it stands (or at the end), and the winner: the side that did not lose early, else the higher score (null = a draw). */
export function battleScore(ctx: SimContext, state: SimView): BattleScore {
  const V = ctx.rules.victory;
  const scores: SideScore[] = state.sides.map((sd) => {
    let pts = 0;
    ctx.rules.objectives.forEach((o, i) => { if (state.objectives[i]?.holder === sd.id) pts += o.points; });
    let down = 0;
    for (const [id, ident] of state.identity.entries()) if (ident.side === sd.id && state.soldier.req(id).casualty !== "none") down++;
    return { side: sd.id, objectivePoints: pts, menDown: down, score: pts - (V?.casualtyPoints ?? 0) * down };
  });
  let winner: SideId | null = null;
  if (state.endLoser !== null) winner = state.sides.find((s) => s.id !== state.endLoser)?.id ?? null;
  else {
    const sorted = [...scores].sort((a, b) => b.score - a.score);
    if (sorted.length > 1 && sorted[0]!.score > sorted[1]!.score) winner = sorted[0]!.side;
  }
  return { scores, winner };
}
