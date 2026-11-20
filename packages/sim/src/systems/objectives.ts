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
import { isAble, isOut } from "../impair";
import { isAssetUnit } from "../offmap";
import { settleBattle } from "./aftercare";
import { settleVehicles } from "./recovery";
import { latePending } from "../setup";
import { exitedOf } from "./exits";
import type { SimState, SimView } from "../state";

export interface SideScore {
  side: SideId; objectivePoints: number; menDown: number; score: number;
  /** M12.0b (only with exit zones in the rules): men and hulls out by the side's exits (saved), and their points. */
  saved?: number; vehiclesSaved?: number; savedPoints?: number;
  /** Vehicles (M7.4a, Q9; only with vehicle points in the rules): own vehicles lost (destroyed or abandoned) and immobilised. */
  vehiclesLost?: number; vehiclesImmobilised?: number;
}
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
    // (M12.0b: a time that scores: from `untilS` on the holder stays.)
    if (o.untilS !== undefined && state.tick >= o.untilS * TICK_HZ) { st.contested = false; continue; }
    const present = new Set<SideId>();
    // mounted: ok men aboard hold and contest objectives too (owner, Q10)
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
  const defeated: { side: SideId; reason: "side-eliminated" | "side-broken" }[] = [];
  // M12.0b: a side with an exit zone that has nobody left on the map, some of them out by the exit: it withdrew (no
  // loser by that; the scores decide).
  const exits = ctx.rules.exits ?? [];
  const withdrew: SideId[] = [];
  for (const sd of state.sides) {
    // (M10.6a: an off-map asset's crew is not of the force: it neither breaks nor keeps a side in the field.)
    const tops = [...state.unit.entries()].filter(([, u]) => u.side === sd.id && u.parent === null && u.asset === undefined);
    // Nobody standing: all down, or the last of them running (they have left the field).
    // mounted: ok a side with men only aboard vehicles is not wiped out
    const anyStanding = [...state.identity.entries()].some(([id, i]) => i.side === sd.id && !isAssetUnit(state, i.unit) && standing(state, id));
    const allBroken = tops.length > 0 && tops.every(([, u]) => u.broken);
    // (M11.1: a side with a wave still to come is not beaten yet.)
    if (!anyStanding && exits.some((z) => z.side === sd.id) && !latePending(ctx, state, sd.id) && exitedOf(state, sd.id).men > 0) { withdrew.push(sd.id); continue; }
    if ((!anyStanding || allBroken) && !latePending(ctx, state, sd.id)) defeated.push({ side: sd.id, reason: !anyStanding ? "side-eliminated" : "side-broken" });
  }
  if (defeated.length === 0 && withdrew.length > 0) {
    state.ended = { tick: state.tick, reason: "side-withdrew" };
    events.emit({ kind: "battle.ended", tick: state.tick, reason: "side-withdrew" });
    state.endLoser = null;
    settleBattle(ctx, state, events);
    settleVehicles(ctx, state, events);
    return;
  }
  if (defeated.length === 0) return;
  // Both at once: nobody wins by default (the scores decide; a tie is a draw).
  const one = defeated.length === 1 ? defeated[0]! : null;
  const reason = one ? one.reason : defeated.every((d) => d.reason === "side-broken") ? "side-broken" : "side-eliminated";
  state.ended = { tick: state.tick, reason };
  events.emit(one ? { kind: "battle.ended", tick: state.tick, reason, loser: one.side } : { kind: "battle.ended", tick: state.tick, reason });
  state.endLoser = one ? one.side : null;
  // The wounded still on the field are settled (M10.6b, owner Q-1e / Q-10).
  settleBattle(ctx, state, events);
  // The hulls left on the field (M11.7b).
  settleVehicles(ctx, state, events);
}

/** The score as it stands (or at the end), and the winner: the side that did not lose early, else the higher score (null = a draw). */
export function battleScore(ctx: SimContext, state: SimView): BattleScore {
  const V = ctx.rules.victory;
  const scores: SideScore[] = state.sides.map((sd) => {
    let pts = 0;
    ctx.rules.objectives.forEach((o, i) => { if (state.objectives[i]?.holder === sd.id) pts += o.points; });
    let down = 0;
    // Men lost: killed, incapacitated, surrendered or captured (M6.6), each counted once.
    // mounted: ok losses count every man
    for (const [id, ident] of state.identity.entries()) if (ident.side === sd.id && !isAssetUnit(state, ident.unit) && isOut(state.soldier.req(id))) down++;
    // (M12.0b: a man out by his side's exit zone is saved, not down.)
    const exits = (ctx.rules.exits ?? []).filter((z) => z.side === sd.id);
    let saved: { men: number; vehicles: number } | null = null;
    if (exits.length > 0) { saved = exitedOf(state, sd.id); down -= saved.men; }
    const out: SideScore = { side: sd.id, objectivePoints: pts, menDown: down, score: pts - (V?.casualtyPoints ?? 0) * down };
    if (saved) {
      const z = exits[0]!, sp = (z.pointsPerMan ?? 0) * saved.men + (z.pointsPerVehicle ?? 0) * saved.vehicles;
      out.saved = saved.men; out.vehiclesSaved = saved.vehicles; out.savedPoints = sp; out.score += sp;
    }
    if (V?.vehiclePoints) {
      let lost = 0, immob = 0;
      for (const [, v] of state.vehicle.entries()) {
        // (Off-map assets, M10.6a, are not of the force: an ambulance costs no points.)
        if (v.side !== sd.id || v.offMap !== undefined) continue;
        if (v.status === "destroyed" || v.status === "abandoned") lost++;
        else if (v.status === "immobilised") immob++;
      }
      out.vehiclesLost = lost; out.vehiclesImmobilised = immob;
      out.score -= V.vehiclePoints.lost * lost + V.vehiclePoints.immobilised * immob;
    }
    return out;
  });
  let winner: SideId | null = null;
  if (state.endLoser !== null) winner = state.sides.find((s) => s.id !== state.endLoser)?.id ?? null;
  else {
    const sorted = [...scores].sort((a, b) => b.score - a.score);
    if (sorted.length > 1 && sorted[0]!.score > sorted[1]!.score) winner = sorted[0]!.side;
  }
  return { scores, winner };
}
