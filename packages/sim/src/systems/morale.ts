/**
 * Suppression, stress and behaviour states (M4.1, SPEC 6.4 / 8).
 *
 * SUPPRESSION is gathered by the projectile system (an enemy round cracking past a man or striking near him)
 * and by bursts (`suppressByBurst`); here it fades. STRESS grows with suppression, with comrades falling
 * nearby, with the loss of his leader and with his own wounds; experience and a leader close by damp it, and
 * it fades slowly under light fire. The BEHAVIOUR state follows from both:
 *   pinned    suppression above the pin level (until it falls well below it): prone, does not move, fires less
 *   panicked  stress above the panic level: prone, does not move, does not fire
 *   shaken    fires less;  cautious  (no effect yet: M4.2 decisions use it);  steady
 * Values are data (core/behaviour.json). Runs every `stepSeconds`, staggered by soldier ID; the event part
 * (casualties, wounds) runs every tick.
 */
import type { Behaviour, SoldierState } from "../components";
import type { SimContext } from "../context";
import type { EventSink, SimEvent } from "../events";
import { secondsToTicks, type EntityId } from "../ids";
import { isAble } from "../impair";
import type { SimState } from "../state";
import { sqrt } from "../math";
import { requestPosture } from "./body";
import { unitSoldiers } from "./orders";

/** How much of a stress increase reaches this man: experience and a leader close by damp it. */
function damping(ctx: SimContext, state: SimState, id: EntityId, s: SoldierState): number {
  const ST = ctx.catalog.behaviour.stress;
  let k = 1 - ST.experienceDamp * (s.skills["experience"] ?? 0.5);
  const unit = state.unit.get(state.identity.get(id)?.unit ?? -1);
  const leader = unit?.leader ?? null;
  if (leader !== null && leader !== id && isAble(state.soldier.get(leader))) {
    const a = state.transform.get(id), b = state.transform.get(leader);
    if (a && b) { const dx = a.x - b.x, dy = a.y - b.y; if (dx * dx + dy * dy <= ST.leaderNearbyM * ST.leaderNearbyM) k *= 1 - ST.leaderNearbyDamp; }
  }
  return k < 0 ? 0 : k;
}

function addStress(ctx: SimContext, state: SimState, id: EntityId, amount: number): void {
  const s = state.soldier.get(id);
  if (!s || !isAble(s)) return;
  s.mental.stress = Math.min(1, s.mental.stress + amount * damping(ctx, state, id, s));
}

/** Add suppression to a man (clamped to the maximum). */
export function addSuppression(ctx: SimContext, s: SoldierState, amount: number): void {
  if (!isAble(s) || amount <= 0) return;
  const max = ctx.catalog.behaviour.suppression.max;
  s.mental.suppression = Math.min(max, s.mental.suppression + amount);
}

/** A burst suppresses everyone within `blastRadiusScale` x its stun radius (more the closer). */
export function suppressByBurst(ctx: SimContext, state: SimState, x: number, y: number, stunR: number, ownerSide?: string): void {
  const SUP = ctx.catalog.behaviour.suppression;
  const R = stunR * SUP.blastRadiusScale;
  if (!(R > 0)) return;
  for (const [id, s] of state.soldier.entries()) {
    const t = state.transform.get(id);
    if (!t || s.mount !== undefined) continue; // men aboard are behind armour (M7)
    // Like their rounds, men's own side's bursts do not suppress them (they know they are coming; the blast
    // itself still stuns and wounds).
    if (ownerSide !== undefined && state.identity.get(id)?.side === ownerSide) continue;
    const dx = t.x - x, dy = t.y - y, d2 = dx * dx + dy * dy;
    if (d2 > R * R) continue;
    addSuppression(ctx, s, SUP.blastFactor * (1 - sqrt(d2) / R));
  }
}

/** His unit has lost its leader: every man of it takes the blow. */
export function leaderLost(ctx: SimContext, state: SimState, unitId: EntityId): void {
  // mounted: ok losing the leader shakes every man, aboard or not
  for (const m of unitSoldiers(state, unitId)) addStress(ctx, state, m, ctx.catalog.behaviour.stress.fromLeaderLoss);
}

function nextBehaviour(ctx: SimContext, s: SoldierState): Behaviour {
  const S = ctx.catalog.behaviour.states, m = s.mental;
  if (m.stress >= S.panickedStress || (m.behaviour === "panicked" && m.stress >= S.calmBelowStress)) return "panicked";
  if (m.suppression >= S.pinnedSuppression || (m.behaviour === "pinned" && m.suppression >= S.unpinnedBelow)) return "pinned";
  if (m.stress >= S.shakenStress) return "shaken";
  if (m.stress >= S.cautiousStress) return "cautious";
  return "steady";
}

/** Pinned or panicked: he lies flat and stays where he is. */
export function isCowering(s: SoldierState): boolean {
  return s.mental.behaviour === "pinned" || s.mental.behaviour === "panicked";
}

/** Factor on his rate of fire from his state (1 = unaffected, 0 = does not fire). */
export function fireRateFactor(ctx: SimContext, s: SoldierState): number {
  const E = ctx.catalog.behaviour.effects;
  switch (s.mental.behaviour) {
    case "panicked": case "routed": case "surrendered": return 0;
    case "pinned": return E.pinnedFireRateFactor;
    case "shaken": return E.shakenFireRateFactor;
    default: return 1;
  }
}

export function moraleSystem(ctx: SimContext, state: SimState, events: EventSink, tickEvents: readonly SimEvent[]): void {
  const B = ctx.catalog.behaviour;
  // ---- this tick's blows: comrades falling nearby, his own wounds
  for (const e of tickEvents) {
    if (e.kind === "wound") addStress(ctx, state, e.soldier, B.stress.fromWound * e.severity);
    else if (e.kind === "casualty") {
      const side = state.identity.get(e.soldier)?.side;
      const at = state.transform.get(e.soldier);
      if (side === undefined || !at) continue;
      const r2 = B.stress.casualtyNearbyM * B.stress.casualtyNearbyM;
      // mounted: ok a comrade falling nearby shakes men aboard too
      for (const [id] of state.soldier.entries()) {
        if (id === e.soldier || state.identity.get(id)?.side !== side) continue;
        const t = state.transform.get(id);
        if (!t) continue;
        const dx = t.x - at.x, dy = t.y - at.y;
        if (dx * dx + dy * dy <= r2) addStress(ctx, state, id, B.stress.fromCasualty);
      }
    }
  }
  // ---- fading and state changes, each man every stepSeconds (staggered)
  const every = Math.max(1, secondsToTicks(B.stepSeconds)), dt = every / 60;
  // mounted: ok stress and suppression fade for every man
  for (const [id, s] of state.soldier.entries()) {
    if ((id + state.tick) % every !== 0) continue;
    const m = s.mental;
    const quiet = m.suppression < B.stress.quietBelowSuppression;
    if (isAble(s)) m.stress = Math.min(1, m.stress + B.stress.fromSuppressionPerS * m.suppression * dt * damping(ctx, state, id, s));
    if (quiet) m.stress = Math.max(0, m.stress - B.stress.decayPerS * dt);
    m.suppression = Math.max(0, m.suppression - B.suppression.decayPerS * dt);
    if (!isAble(s) || m.behaviour === "routed") continue; // a routed man stays so until his unit rallies (drills)
    const next = nextBehaviour(ctx, s);
    if (next === m.behaviour) continue;
    const from = m.behaviour;
    m.behaviour = next;
    events.emit({ kind: "behaviour.changed", tick: state.tick, soldier: id, from, to: next });
    if (isCowering(s) && s.posture !== "prone" && s.evade === null) requestPosture(ctx, state, id, "prone");
  }
}
