/**
 * THE END OF A DECIDED BATTLE (review 2026-11-24 problem 3, owner Q3 2026-11-25).
 *
 * Before this a battle ended early only when every top unit of a side had broken or nobody of it stood; one BMP crew or
 * one unbroken platoon kept a beaten side "in the field" to the time limit. Two more ends (with `rules.victory.decided`,
 * parameters in `behaviour.battleEnd`), checked once a second:
 *
 * - "side-spent": a side's standing men (able, not routed, not a prisoner, on the map) stay below `spentShare` of the
 *   men it has committed (on the map so far, late units that have come included, less the men saved by an exit) for
 *   `spentForS`, with no wave of it still to come. Then a notice (`battle.ending`, a radio line to each side) and, after
 *   `noticeS`, the end: the spent side loses (as "side-broken"). Called off if it climbs back to `spentCancelShare`
 *   (rallied men, arrivals; a margin over `spentShare` against flapping).
 * - "battle-decided": one side holds every objective, none contested, there has been contact and then none for
 *   `quietS`, and no enemy wave is still to come; a side that held them all from the start (the defender, in the lull
 *   before an attack) also needs the enemy below `defenderEnemyShare` of its committed men. Notice, then after `noticeS`
 *   the end with no loser: the scores decide, as at the time limit. Cancelled by renewed contact or an objective lost or
 *   contested. Not for objectives that score at a time (`untilS`, the withdrawal) nor battles without objectives (the
 *   ambush): the spent rule, the exits and the time limit end those.
 *
 * Contact is derived, never stored: the latest tick any top unit came under fire, any man on the map fired a direct
 * weapon (mortar tubes are not contact), any hull's station fired or the hull was hit.
 *
 * Claim victory (`claimVictory`, a player order): `claimStatus` says whether a side may claim now; the order is refused
 * ("not-decided") otherwise and ends the battle at reception when accepted ("victory-claimed", the other side losing).
 * The claimant must lead on points, so a claim never gives the battle to the side the scores would not.
 *
 * Every end goes through `endBattle` (the defeats, the withdrawal, the time limit too): it settles the wounded and the
 * hulls left on the field (`settleBattle`, `settleVehicles`) at every end.
 */
import type { SimContext } from "../context";
import type { BattleEndReason, EventSink } from "../events";
import { TICK_HZ, type EntityId, type SideId } from "../ids";
import { isAble } from "../impair";
import { hasExited } from "./exits";
import { isAssetUnit, isOffMap, isOffMapMan } from "../offmap";
import { latePending } from "../setup";
import { sendsRadio } from "../comms";
import type { SimState, SimView } from "../state";
import { settleBattle } from "./aftercare";
import { settleVehicles } from "./recovery";
import { isMortarUnit } from "./mortars";
import { battleScore } from "./objectives";

/** End the battle now: `loser` loses (null: the scores decide). Settles the wounded and the hulls left on the field. */
export function endBattle(ctx: SimContext, state: SimState, events: EventSink, reason: BattleEndReason, loser: SideId | null): void {
  state.ended = { tick: state.tick, reason };
  events.emit(loser !== null ? { kind: "battle.ended", tick: state.tick, reason, loser } : { kind: "battle.ended", tick: state.tick, reason });
  state.endLoser = loser;
  delete state.ending;
  // The wounded still on the field are settled (M10.6b, owner Q-1e / Q-10), and the hulls left there (M11.7b).
  settleBattle(ctx, state, events);
  settleVehicles(ctx, state, events);
}

/** The last tick of direct contact anywhere in the battle (-1: none yet). Derived from the state; nothing stored. */
export function lastContactTick(state: SimView): number {
  let t = -1;
  for (const [, u] of state.unit.entries()) if (u.parent === null && u.asset === undefined && u.underFireTick > t) t = u.underFireTick;
  // (A man's own weapon: a mortar tube's carrier is not in contact by firing it.)
  // mounted: ok (a man aboard fires his own weapon too: contact)
  for (const [id, w] of state.weapon.entries()) {
    if (w.lastShotTick <= t) continue;
    const ident = state.identity.get(id), s = state.soldier.get(id);
    if (!ident || !s || isAssetUnit(state, ident.unit) || isMortarUnit(state, ident.unit) || isOffMapMan(state, s)) continue;
    t = w.lastShotTick;
  }
  for (const [, v] of state.vehicle.entries()) {
    if (v.offMap !== undefined || isOffMap(v)) continue;
    if (v.lastHitTick > t) t = v.lastHitTick;
    for (const st of v.stations) for (const sw of st.weapons) if (sw.lastShotTick > t) t = sw.lastShotTick;
  }
  return t;
}

/** A side's men: `standing` (able, not routed, on the map) and `committed` (on the map so far, less those saved). */
export function sideStrength(state: SimView, side: SideId): { standing: number; committed: number } {
  let standing = 0, committed = 0;
  // mounted: ok (men aboard a hull on the map stand and count)
  for (const [id, ident] of state.identity.entries()) {
    if (ident.side !== side || isAssetUnit(state, ident.unit)) continue;
    const s = state.soldier.get(id);
    if (!s || hasExited(s)) continue;
    committed++;
    if (isAble(s) && s.mental.behaviour !== "routed" && !isOffMapMan(state, s)) standing++;
  }
  return { standing, committed };
}

const otherSide = (state: SimView, side: SideId): SideId | null => state.sides.find((s) => s.id !== side)?.id ?? null;

function isSpent(ctx: SimContext, state: SimView, side: SideId, share: number): boolean {
  if (latePending(ctx, state, side)) return false;
  const { standing, committed } = sideStrength(state, side);
  return committed > 0 && standing < share * committed;
}

/** The side holding every objective, none contested (null: none does, or the battle has no objectives). */
function fieldHolder(state: SimView): SideId | null {
  const os = state.objectives;
  if (os.length === 0) return null;
  const h = os[0]!.holder;
  if (h === null) return null;
  for (const o of os) if (o.holder !== h || o.contested) return null;
  return h;
}

/** The "battle-decided" condition for side `x` (without the quiet, which the caller checks). */
function fieldDecided(ctx: SimContext, state: SimView, x: SideId): boolean {
  const B = ctx.catalog.behaviour.battleEnd!;
  const defs = ctx.rules.objectives;
  if (defs.length === 0 || defs.some((o) => o.untilS !== undefined)) return false;
  if (fieldHolder(state) !== x) return false;
  const enemy = otherSide(state, x);
  if (enemy === null || latePending(ctx, state, enemy)) return false;
  // (The defender in the lull before the attack holds everything too: it also needs the enemy beaten down.)
  if (defs.every((o) => o.holder === x)) {
    const e = sideStrength(state, enemy);
    if (!(e.committed > 0 && e.standing < B.defenderEnemyShare * e.committed)) return false;
  }
  return true;
}

function radioAll(state: SimState, events: EventSink, key: string, params: Record<string, string | number>): void {
  for (const sd of state.sides) {
    // Its top leader speaks (the first able man of its first top unit with one, ascending id).
    for (const [uid, u] of state.unit.entries()) {
      if (u.side !== sd.id || u.parent !== null || u.asset !== undefined) continue;
      if (!sendsRadio(state, uid, key)) continue;
      const from = u.leader !== null && isAble(state.soldier.get(u.leader)) ? u.leader : u.members.find((m) => isAble(state.soldier.get(m)));
      if (from === undefined) continue;
      events.emit({ kind: "radio", tick: state.tick, side: sd.id, from, key, params: { callsign: u.callsign, ...params } });
      break;
    }
  }
}

function announce(state: SimState, events: EventSink, e: NonNullable<SimState["ending"]>, cancelled: boolean): void {
  const other = otherSide(state, e.side);
  const who = e.reason === "side-spent" ? { loser: e.side, ...(other !== null ? { winner: other } : {}) } : { winner: e.side };
  events.emit({ kind: "battle.ending", tick: state.tick, reason: e.reason, ...who, endTick: e.endTick, ...(cancelled ? { cancelled: true as const } : {}) });
  radioAll(state, events, cancelled ? "radio.battleEndingCancelled" : "radio.battleEnding", { s: Math.max(0, Math.round((e.endTick - state.tick) / TICK_HZ)) });
}

/** Once a second (after the objectives): start, announce, cancel or carry out a decided end. */
export function battleEndSystem(ctx: SimContext, state: SimState, events: EventSink): void {
  if (state.tick % TICK_HZ !== 0 || state.ended || ctx.rules.victory?.decided !== true) return;
  const B = ctx.catalog.behaviour.battleEnd;
  if (B === undefined) return;
  const now = state.tick, noticeT = Math.round(B.noticeS * TICK_HZ);
  const e = state.ending;
  if (e !== undefined) {
    // (A spent side's end is called off only once it is back to `spentCancelShare`: a margin, so that men rallying and
    // running again around the line do not flap the notice.)
    const holds = e.reason === "side-spent"
      ? isSpent(ctx, state, e.side, Math.max(B.spentShare, B.spentCancelShare))
      : fieldDecided(ctx, state, e.side) && lastContactTick(state) < (e.noticeTick ?? e.sinceTick);
    if (!holds) {
      if (e.noticeTick !== undefined) announce(state, events, e, true);
      delete state.ending;
      return;
    }
    if (e.noticeTick === undefined) {
      if (now - e.sinceTick < Math.round(B.spentForS * TICK_HZ)) return;
      e.noticeTick = now; e.endTick = now + noticeT;
      announce(state, events, e, false);
    }
    if (now >= e.endTick) endBattle(ctx, state, events, e.reason, e.reason === "side-spent" ? e.side : null);
    return;
  }
  // A side spent (only one: both at once is left to the defeats and the time limit).
  const spent = state.sides.filter((sd) => isSpent(ctx, state, sd.id, B.spentShare));
  if (spent.length === 1) {
    state.ending = { reason: "side-spent", side: spent[0]!.id, sinceTick: now, endTick: now + Math.round(B.spentForS * TICK_HZ) + noticeT };
    if (B.spentForS <= 0) { state.ending.noticeTick = now; state.ending.endTick = now + noticeT; announce(state, events, state.ending, false); }
    return;
  }
  // The field held and the fighting over.
  const x = fieldHolder(state);
  if (x === null || !fieldDecided(ctx, state, x)) return;
  const last = lastContactTick(state);
  if (last <= 0 || now - last < Math.round(B.quietS * TICK_HZ)) return;
  state.ending = { reason: "battle-decided", side: x, sinceTick: now, noticeTick: now, endTick: now + noticeT };
  announce(state, events, state.ending, false);
  if (noticeT <= 0) endBattle(ctx, state, events, "battle-decided", null);
}

export type ClaimRefusal = "ended" | "unavailable" | "no-contact-yet" | "exit-side" | "objectives" | "enemy-near" | "late-enemy" | "contact" | "score";
export type ClaimStatus = { ok: true } | { ok: false; reason: ClaimRefusal; secondsLeft?: number };

/**
 * May `side` claim victory now? The reasons, checked in this order: the battle is over; no victory rules or no
 * `battleEnd` data ("unavailable"); no contact yet; its goal is an exit that scores (its win is getting out; a
 * break-off exit, worth nothing, is no goal); it does not hold
 * every objective uncontested (a battle without objectives: the enemy is not spent nor gone from the map); an enemy
 * man stands within `claimClearM` of an objective; an enemy wave is still to come; contact within `claimQuietS`
 * (`secondsLeft`); it would not win on points now. Pure (the order's validation and the interface both use it).
 */
export function claimStatus(ctx: SimContext, state: SimView, side: SideId): ClaimStatus {
  if (state.ended) return { ok: false, reason: "ended" };
  const B = ctx.catalog.behaviour.battleEnd;
  const enemy = otherSide(state, side);
  if (B === undefined || ctx.rules.victory === undefined || enemy === null || !state.sides.some((s) => s.id === side)) return { ok: false, reason: "unavailable" };
  const last = lastContactTick(state);
  if (last <= 0) return { ok: false, reason: "no-contact-yet" };
  // (An exit that scores is the side's goal: the delay, the ambushed. A break-off exit, worth nothing, is not.)
  if ((ctx.rules.exits ?? []).some((z) => z.side === side && ((z.pointsPerMan ?? 0) > 0 || (z.pointsPerVehicle ?? 0) > 0))) return { ok: false, reason: "exit-side" };
  const defs = ctx.rules.objectives;
  if (defs.length > 0) {
    if (fieldHolder(state) !== side) return { ok: false, reason: "objectives" };
    const r2 = B.claimClearM * B.claimClearM;
    // mounted: ok (an enemy aboard a hull near the objective stands there too)
    for (const [id, ident] of state.identity.entries()) {
      if (ident.side !== enemy || isAssetUnit(state, ident.unit)) continue;
      const s = state.soldier.get(id), t = state.transform.get(id);
      if (!s || !t || !isAble(s) || s.mental.behaviour === "routed" || isOffMapMan(state, s)) continue;
      if (defs.some((o) => (t.x - o.x) * (t.x - o.x) + (t.y - o.y) * (t.y - o.y) <= r2)) return { ok: false, reason: "enemy-near" };
    }
  } else {
    const e = sideStrength(state, enemy);
    if (!(e.standing === 0 || (e.committed > 0 && e.standing < B.spentShare * e.committed))) return { ok: false, reason: "objectives" };
  }
  if (latePending(ctx, state, enemy)) return { ok: false, reason: "late-enemy" };
  const quietT = Math.round(B.claimQuietS * TICK_HZ);
  if (state.tick - last < quietT) return { ok: false, reason: "contact", secondsLeft: Math.ceil((quietT - (state.tick - last)) / TICK_HZ) };
  const sc = battleScore(ctx, state).scores;
  const mine = sc.find((s) => s.side === side)?.score ?? 0;
  if (!sc.every((s) => s.side === side || s.score < mine)) return { ok: false, reason: "score" };
  return { ok: true };
}

/** Carry out an accepted claim (orders.ts, at reception): the other side loses. */
export function claimVictory(ctx: SimContext, state: SimState, events: EventSink, side: SideId): void {
  endBattle(ctx, state, events, "victory-claimed", otherSide(state, side));
}

/** The side of an order's target (unit or man), for the claim. */
export function sideOfTarget(state: SimView, target: EntityId): SideId | null {
  return state.unit.get(target)?.side ?? state.identity.get(target)?.side ?? null;
}
