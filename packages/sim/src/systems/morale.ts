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
import { secondsToTicks, staggerFirst, type EntityId } from "../ids";
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

/**
 * A mortar round of `side` has burst (soldier AI package B, called by the fire support system): every man on foot
 * of the other side within `soldier.beatenNoticeM` remembers where that mission is falling (one zone per man: a
 * burst far from the one he remembers, or after his memory has lapsed, starts a new one).
 */
export function noteBeatenZone(ctx: SimContext, state: SimState, x: number, y: number, side: string): void {
  const S = ctx.catalog.behaviour.soldier, r2 = S.beatenNoticeM * S.beatenNoticeM;
  const memory = secondsToTicks(S.beatenMemorySeconds);
  for (const [id, s] of state.soldier.entries()) {
    if (!isAble(s) || s.mount !== undefined || state.identity.get(id)?.side === side) continue;
    const t = state.transform.get(id);
    if (!t) continue;
    const dx = t.x - x, dy = t.y - y;
    if (dx * dx + dy * dy > r2) continue;
    const b = s.beaten;
    if (b && state.tick - b.tick <= memory && sqrt((b.x - x) * (b.x - x) + (b.y - y) * (b.y - y)) <= S.beatenNoticeM) {
      b.x = (b.x * b.n + x) / (b.n + 1); b.y = (b.y * b.n + y) / (b.n + 1); b.n++; b.tick = state.tick;
    } else s.beaten = { x, y, tick: state.tick, n: 1, left: false };
  }
}

/** His unit has lost its leader: every man of it takes the blow. */
export function leaderLost(ctx: SimContext, state: SimState, unitId: EntityId, leader?: EntityId): void {
  // mounted: ok losing the leader shakes every man; a man aboard a closed hull only when the leader fell inside it
  // (owner 2026-11-13, "only own vehicle")
  const inside = leader === undefined ? undefined : state.soldier.get(leader)?.mount?.vehicle;
  for (const m of unitSoldiers(state, unitId)) {
    const mv = state.soldier.get(m)?.mount?.vehicle;
    if (mv !== undefined && leader !== undefined && mv !== inside) continue;
    addStress(ctx, state, m, ctx.catalog.behaviour.stress.fromLeaderLoss);
  }
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
      const inside = state.soldier.get(e.soldier)?.mount?.vehicle;
      // mounted: ok men aboard a closed hull feel only a comrade falling inside it (owner 2026-11-13, "only own vehicle")
      for (const [id, s] of state.soldier.entries()) {
        if (id === e.soldier || state.identity.get(id)?.side !== side) continue;
        if (s.mount !== undefined) { if (s.mount.vehicle === inside) addStress(ctx, state, id, B.stress.fromCasualty); continue; }
        const t = state.transform.get(id);
        if (!t) continue;
        const dx = t.x - at.x, dy = t.y - at.y;
        if (dx * dx + dy * dy <= r2) addStress(ctx, state, id, B.stress.fromCasualty);
      }
    } else if (e.kind === "vehicle.hit") {
      // Men aboard take stress from hits on their own hull (owner 2026-11-13): a penetration, or a heavy round or
      // a burst that the armour stops (rifle-calibre strikes, aggregated, do not count).
      const pen = e.result === "penetrated";
      const am = ctx.catalog.ammo[e.ammo];
      const k = pen ? B.stress.fromOwnVehiclePenetrated ?? 0 : am !== undefined && (am.diameterM >= 0.0125 || am.explosive !== undefined) ? B.stress.fromOwnVehicleStruck ?? 0 : 0;
      const v = k > 0 ? state.vehicle.get(e.vehicle) : undefined;
      if (v) for (const id of v.seats) if (id !== null && id !== undefined) addStress(ctx, state, id, k);
    }
  }
  // ---- fading and state changes, each man every stepSeconds (staggered)
  const every = Math.max(1, secondsToTicks(B.stepSeconds)), dt = every / 60;
  // mounted: ok stress and suppression fade for every man
  for (let id = staggerFirst(state.tick, every); id < state.nextEntityId; id += every) {
    const s = state.soldier.get(id);
    if (s === undefined) continue;
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
