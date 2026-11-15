/**
 * AUTOMATIC GRENADE LAUNCHER TEAMS ON FOOT (M7.6d; an AGS-30 or a GMW on its tripod).
 *
 * An **AGL team** is a unit whose gunner carries a post item with a `crewServed` block of kind "agl". Its life on the
 * ground — packed, setting up, ready, packing on a move, setting up on its own after standing still, the post passing
 * to an able man when the gunner falls — is the crew-served code in mortars.ts (the post state is `Unit.missileTeam`
 * with `kind: "agl"`). This file fires it, direct and flat only (high-angle fire is deferred):
 *
 *   - on its own (looked at every quarter second, a ready team between bursts), unless its fire rule is "hold": at
 *     the enemy men its men saw (or a comrade reported to within `REPORTED_ERR_M`) within `SEEN_S`, inside
 *     `engageRangeM`, beyond the round's arming distance and in the gun's line; the
 *     group with the most men close together first, then the freshest, then the nearest. It aims at their feet (the
 *     round bursts on the ground);
 *   - on an order (a fire order to the team or a unit above it, not "at"): a packed team stops and sets up first, then
 *     fires `ORDER_BURSTS` bursts at the point (the order waits as `queued`; a move drops it).
 * A bearing beyond `traverseDeg` either side of the laid heading first costs a re-lay (`relaySeconds`); the first
 * burst at a new aim costs `aimSeconds`. Rounds come out of the box on the gun (`box`); an empty box is replaced by a
 * full one from the team's loads (the post's carrier first, then the others in ID order; rule 9), which takes the
 * weapon's `reloadSeconds` (the first box goes on while the post is set up). Each round is laid with the drop table
 * as a vehicle's gun is (shot.ts `launchShot`: the range believed, an aiming error that grows through the burst) and
 * fired as `shot.fired` without a vehicle (expenditure: `grenadeMg`). While the team fires, its gunner is busy with
 * the action `workAgl` (no rifle fire, no moves of his own).
 *
 * Randomness: the range error of a series on the "agl" stream; the rounds' errors on "fire" (launchShot).
 */
import { registerActionHandler, startAction } from "../actions";
import type { AglPostDef } from "../catalog";
import type { Unit } from "../components";
import type { SimContext } from "../context";
import type { EventSink } from "../events";
import { secondsToTicks, type EntityId } from "../ids";
import { isAble } from "../impair";
import { removeItems } from "../items";
import { sight } from "../los";
import { atan2, hypot2, PI, sqrt, wrapAngle } from "../math";
import { protectedTargets } from "../protection";
import { nextNormal, Streams } from "../rng";
import type { SimState, SimView } from "../state";
import { heightAt, standZ } from "../terrain";
import { friendInLine, skillFactor } from "./fire";
import { aglOf, busyWithCasualty, crewAt, type AglPost } from "./mortars";
import { burstCadence, launchShot } from "./shot";

/** The gunner's action while his team fires (keeps him at the gun). */
export const AGL_ACTION = "workAgl";
/** How often a ready team looks for a target (ticks). */
const EVERY = 15;
/** Enemy men seen this recently count as targets (s; game value). */
const SEEN_S = 8;
/** A reported enemy man counts as a target if his place is known to within this (m). */
const REPORTED_ERR_M = 25;
/** Men within this of a target man count as his group (m). */
const GROUP_M = 10;
/** Bursts an ordered fire puts on the point (game value). */
const ORDER_BURSTS = 6;
/** The gunner's own aiming error at the post, one standard deviation before the weapon's dispersion (mrad). */
const BASE_MRAD = 1;
/** A burst aimed within this of the last one is a correction of it (m). */
const ADJUST_M = 30;
/** A sight line blocked closer than this to the aim point still lets the team fire (m; ground and cover there). */
const LINE_ALLOWANCE_M = 40;

/** A round's burst that harms men out to about this (m; game value: the published lethal radius of 30 and 40 mm
 *  grenades is 5 to 8 m). */
export const AGL_BURST_M = 8;

/**
 * How far past the point aimed at (and round it) own men are in danger from a burst at `rangeM` (m): the round's burst
 * plus one standard deviation of a series' range error (the gunner's skill not counted: the worst case near enough).
 */
export function aglDangerM(ctx: SimContext, rangeM: number): number {
  return AGL_BURST_M + ctx.catalog.shooting.aim.rangeErrorFraction * rangeM;
}

/** Is this unit an automatic grenade launcher team that has rounds (on the gun or in its loads) and its post? */
export function aglRoundsLeft(ctx: SimContext, state: SimView, uid: EntityId): number {
  const u = state.unit.get(uid), l = aglOf(ctx, state, uid);
  if (!u || !l || u.missileTeam?.kind !== "agl") return 0;
  const cap = ctx.catalog.items[l.def.round]?.chargeCapacity ?? 1;
  let n = u.missileTeam.box?.rounds ?? 0;
  for (const m of u.members) { const c = state.container.get(m); if (c) for (const st of c.stacks) if (st.type === l.def.round) n += st.count * (st.charge ?? cap); }
  return n;
}

/** Can the gunner work the gun now: able, arms usable, on foot, not stunned, panicked or routed, not walking, not
 *  carrying a casualty. */
function gunnerFit(state: SimState, id: EntityId): boolean {
  const s = state.soldier.get(id);
  if (!s || !isAble(s) || !s.impair.canUseArms || s.mount !== undefined || state.tick < s.stunnedUntilTick || s.evade !== null) return false;
  if (s.mental.behaviour === "panicked" || s.mental.behaviour === "routed") return false;
  if (busyWithCasualty(s)) return false;
  return (state.mover.get(id)?.waypoints.length ?? 0) === 0;
}

/** The gun's muzzle: over the post, at the sight's height above the gunner's ground. */
function muzzleOf(ctx: SimContext, state: SimState, l: AglPost): [number, number, number] {
  const t = state.transform.req(l.carrier);
  return [l.x, l.y, standZ(ctx.map, t) + l.def.sightHeightM];
}

/** Shortest range the team fires at: the round must arm (m). */
function minRangeM(ctx: SimContext, l: AglPost): number {
  const ammo = ctx.catalog.items[l.def.round]?.chargeItem;
  const v0 = ammo !== undefined ? ctx.catalog.weapons[l.def.weapon]?.ammo[ammo] ?? 0 : 0;
  return Math.max(30, 1.5 * v0 * (ammo !== undefined ? ctx.catalog.ammo[ammo]?.explosive?.armingSeconds ?? 0 : 0));
}

/** The drop-table length for the gun (as a vehicle's: past the engage range). */
function tableRangeM(def: AglPostDef): number {
  return Math.max(1500, Math.ceil(def.engageRangeM / 500) * 500 + 500);
}

/** Can the muzzle see (x, y) on the ground well enough to fire there? */
function lineOk(ctx: SimContext, state: SimState, l: AglPost, x: number, y: number): boolean {
  const [mx, my, mz] = muzzleOf(ctx, state, l);
  const r = sight(ctx, mx, my, mz, x, y, heightAt(ctx.map, x, y) + 1, l.carrier, -1); // ground: ok (the point fired at)
  return r.blockedBy === null || (1 - r.blockedAt) * hypot2(x - mx, y - my) <= LINE_ALLOWANCE_M;
}

/** The team's own target: the enemy men its men saw within SEEN_S, in range, the biggest group first. */
function ownTarget(ctx: SimContext, state: SimState, u: Unit, l: AglPost): { target: EntityId; x: number; y: number } | null {
  const seen = secondsToTicks(SEEN_S), tick = state.tick, minR = minRangeM(ctx, l);
  const prot = protectedTargets(state, u.members);
  const cands: { target: EntityId; x: number; y: number; tick: number; d: number; n: number }[] = [];
  for (const m of u.members) {
    const s = state.soldier.get(m);
    if (!isAble(s)) continue;
    for (const c of s!.contacts) {
      // (Seen by its men, or reported by a comrade with the place known to within REPORTED_ERR_M: area fire.)
      if (c.cls === "vehicle" || c.kind === "heard" || (c.kind === "reported" && c.errM > REPORTED_ERR_M) || c.down === true || c.surrendered === true || tick - c.tick > seen) continue;
      if (prot !== null && prot.has(c.target)) continue;
      const d = hypot2(c.x - l.x, c.y - l.y);
      if (d < minR || d > l.def.engageRangeM) continue;
      const k = cands.findIndex((q) => q.target === c.target);
      if (k < 0) cands.push({ target: c.target, x: c.x, y: c.y, tick: c.tick, d, n: 0 });
      else if (c.tick > cands[k]!.tick) cands[k] = { target: c.target, x: c.x, y: c.y, tick: c.tick, d, n: 0 };
    }
  }
  if (cands.length === 0) return null;
  for (const a of cands) for (const b of cands) if ((a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y) <= GROUP_M * GROUP_M) a.n++;
  cands.sort((a, b) => b.n - a.n || b.tick - a.tick || a.d - b.d || a.target - b.target);
  for (let i = 0; i < cands.length && i < 3; i++) {
    const c = cands[i]!;
    if (lineOk(ctx, state, l, c.x, c.y)) return { target: c.target, x: c.x, y: c.y };
  }
  return null;
}

/** Put a full box on the gun from the team's loads (the post's carrier first). True if one went on. */
function loadBox(state: SimState, u: Unit, l: AglPost): boolean {
  const mt = u.missileTeam!;
  for (const m of [l.carrier, ...u.members.filter((x) => x !== l.carrier)]) {
    const c = state.container.get(m);
    if (!c || !c.stacks.some((s) => s.type === l.def.round && (s.charge ?? 0) > 0)) continue;
    const taken = removeItems(c, l.def.round, 1)[0];
    if (!taken) continue;
    // (The empty box is thrown away: an empty AGL box is not carried on.)
    mt.box = { item: taken.type, rounds: taken.charge ?? 0, holder: l.carrier };
    return true;
  }
  return false;
}

/**
 * The teams' fire: every tick the rounds of the bursts under way; every quarter second, for a ready team between
 * bursts, the next burst (ordered or its own).
 */
export function aglTeamSystem(ctx: SimContext, state: SimState, events: EventSink): void {
  const look = state.tick % EVERY === 0;
  for (const [uid, u] of state.unit.entries()) {
    const mt = u.missileTeam;
    if (!mt || mt.kind !== "agl") continue;
    if (mt.burst) { fireRound(ctx, state, events, uid, u); continue; }
    if (!look || mt.state !== "ready") continue;
    if (mt.relayTick !== undefined) { if (state.tick < mt.relayTick) continue; delete mt.relayTick; }
    const l = aglOf(ctx, state, uid);
    if (l && mt.box && mt.box.holder !== l.carrier) mt.box.holder = l.carrier; // (the box goes with the gun)
    if (!l || !gunnerFit(state, l.carrier) || crewAt(state, l, true).length < l.def.crewMin) continue;
    if (state.action.has(l.carrier) && state.action.get(l.carrier)!.kind !== AGL_ACTION) continue;
    const wd = ctx.catalog.weapons[l.def.weapon];
    if (!wd) continue;
    // The box on the gun: the first goes on with the set-up; an empty one is replaced (the weapon's reload time).
    if ((mt.box?.rounds ?? 0) <= 0) {
      const first = mt.box === undefined;
      if (!loadBox(state, u, l)) { if (mt.queued) { delete mt.queued; teamRadio(state, events, uid, "radio.missileTeamNoShot"); } continue; }
      if (!first) { mt.relayTick = state.tick + secondsToTicks(wd.reloadSeconds); continue; }
    }
    const between = secondsToTicks(wd.sustained?.intervalS ?? 1);
    if (state.tick - mt.lastLaunchTick < between) continue;
    let pick: { target: EntityId; x: number; y: number } | null;
    const prevAim = mt.lastLaunchTick >= 0 && state.tick - mt.lastLaunchTick <= 2 * between;
    if (mt.queued) {
      const q = mt.queued;
      if (!lineOk(ctx, state, l, q.x, q.y) || hypot2(q.x - l.x, q.y - l.y) > tableRangeM(l.def)) { delete mt.queued; teamRadio(state, events, uid, "radio.missileTeamNoShot"); continue; }
      pick = { target: q.target, x: q.x, y: q.y };
    } else {
      if (u.fireRule === "hold") continue;
      pick = ownTarget(ctx, state, u, l);
      if (!pick) continue;
    }
    // Outside the gun's traverse: re-lay it first (the burst is looked for again once laid).
    const bearing = atan2(pick.y - l.y, pick.x - l.x);
    if (Math.abs(wrapAngle(bearing - mt.heading)) > (l.def.traverseDeg * PI) / 180) {
      mt.heading = bearing;
      mt.relayTick = state.tick + secondsToTicks(l.def.relaySeconds);
      continue;
    }
    // (Own men in the line, or past the point within the burst and the range error: no burst.)
    if (friendInLine(ctx, state, l.carrier, pick.x, pick.y, aglDangerM(ctx, hypot2(pick.x - l.x, pick.y - l.y)), { x: l.x, y: l.y })) continue;
    if (mt.queued) {
      // An ordered series: one burst now, the rest stay queued.
      const left = (mt.queued.bursts ?? ORDER_BURSTS) - 1;
      if (left > 0) mt.queued.bursts = left;
      else delete mt.queued;
    }
    const a = ctx.catalog.shooting.aim;
    const s = state.soldier.req(l.carrier);
    // The same place again soon after: the crew has watched the last burst fall and corrects (half the error).
    const la = mt.lastAim, same = prevAim && la !== undefined && hypot2(la.x - pick.x, la.y - pick.y) <= ADJUST_M;
    const aimTicks = same ? 0 : secondsToTicks(l.def.aimSeconds);
    const rounds = wd.sustained?.burstRounds ?? 1;
    const rangeError = same ? la!.rangeError * 0.5 : a.rangeErrorFraction * skillFactor(ctx, s.skills["marksmanship"] ?? 0.5) * nextNormal(state.rng, Streams.agl);
    mt.burst = { left: rounds, nextTick: state.tick + aimTicks, index: 0, target: pick.target, x: pick.x, y: pick.y, rangeError };
    mt.lastAim = { x: pick.x, y: pick.y, rangeError };
    const dur = aimTicks + rounds * burstCadence(wd.cyclicRpm) + 1;
    startAction(state, events, l.carrier, AGL_ACTION, dur, { team: uid });
    const t = state.transform.req(l.carrier);
    t.heading = bearing;
    if (pick.target >= 0) s.intent = { kind: "engage", tick: state.tick, target: pick.target };
  }
}

/** One round of the burst under way, when it is due; the burst ends when it is fired out or the team cannot go on. */
function fireRound(ctx: SimContext, state: SimState, events: EventSink, uid: EntityId, u: Unit): void {
  const mt = u.missileTeam!, b = mt.burst!;
  if (state.tick < b.nextTick) return;
  const l = aglOf(ctx, state, uid);
  const wd = l ? ctx.catalog.weapons[l.def.weapon] : undefined;
  const ammo = l ? ctx.catalog.items[l.def.round]?.chargeItem : undefined;
  const v0 = wd && ammo !== undefined ? wd.ammo[ammo] : undefined;
  if (!l || !wd || ammo === undefined || v0 === undefined || mt.state !== "ready" || !gunnerFit(state, l.carrier) || (mt.box?.rounds ?? 0) <= 0) { endBurst(state, u); return; }
  const [mx, my, mz] = muzzleOf(ctx, state, l);
  const tz = heightAt(ctx.map, b.x, b.y); // ground: ok (the point fired at: the round bursts on the ground)
  const range = hypot2(b.x - mx, b.y - my);
  if (range < 2) { endBurst(state, u); return; }
  const a = ctx.catalog.shooting.aim, s = state.soldier.req(l.carrier);
  const sd = BASE_MRAD * skillFactor(ctx, s.skills["marksmanship"] ?? 0.5) * (1 + a.burstGrowth * (wd.sustained?.recoilFactor ?? 1) * b.index) * s.impair.aim;
  const err = sqrt(sd * sd + wd.dispersionMrad * wd.dispersionMrad) / 1000;
  launchShot(ctx, state, events, l.carrier, l.def.weapon, ammo, v0, mx, my, mz, tz, atan2(b.y - my, b.x - mx), range, range * (1 + b.rangeError), err, undefined, tableRangeM(l.def));
  mt.box!.rounds--;
  const w = state.weapon.get(l.carrier);
  if (w) w.lastShotTick = state.tick;
  if (ctx.catalog.medical !== undefined) s.protLostTick = state.tick; // (M10.7b: firing is not self-defence)
  b.index++;
  b.left--;
  b.nextTick = state.tick + burstCadence(wd.cyclicRpm);
  if (b.left <= 0 || mt.box!.rounds <= 0) {
    mt.lastLaunchTick = state.tick;
    mt.shots++;
    endBurst(state, u);
  }
}

function endBurst(state: SimState, u: Unit): void {
  delete u.missileTeam!.burst;
  for (const m of u.members) { const a = state.action.get(m); if (a?.kind === AGL_ACTION) state.action.delete(m); }
}

function teamRadio(state: SimState, events: EventSink, uid: EntityId, key: string): void {
  const u = state.unit.req(uid);
  const lead = u.leader ?? u.members[0];
  if (lead !== undefined) events.emit({ kind: "radio", tick: state.tick, side: u.side, from: lead, key, params: { callsign: u.callsign } });
}

/**
 * Order (M7.6d): the teams fire at (x, y) (a fire order that is not "at"). Each team that can (its post, rounds, enough
 * crew) stops, sets up if packed, and fires once ready. Returns the teams that took it.
 */
export function aglOrderFire(ctx: SimContext, state: SimState, teams: readonly EntityId[], x: number, y: number, stop: (team: EntityId) => void, setup: (team: EntityId) => boolean): EntityId[] {
  const out: EntityId[] = [];
  for (const uid of teams) {
    const u = state.unit.get(uid), mt = u?.missileTeam;
    const l = aglOf(ctx, state, uid);
    if (!u || !mt || mt.kind !== "agl" || !l || aglRoundsLeft(ctx, state, uid) <= 0) continue;
    const cs = state.soldier.get(l.carrier);
    if (!isAble(cs) || busyWithCasualty(cs!) || crewAt(state, l, true).length < l.def.crewMin) continue;
    stop(uid);
    mt.queued = { x, y, target: -1, bursts: ORDER_BURSTS };
    delete mt.burst;
    if (mt.state === "packed" && !setup(uid)) { delete mt.queued; continue; }
    out.push(uid);
  }
  return out;
}

/** Action "workAgl": the gunner at his gun while it fires; params { team }. Ends with the burst (agl-team.ts). */
registerActionHandler(AGL_ACTION, {
  check(_ctx, state, actor, a) {
    const mt = state.unit.get(Number(a.params["team"]))?.missileTeam;
    if (!mt || mt.kind !== "agl" || mt.state !== "ready" || !mt.burst) return "unable";
    return gunnerFit(state, actor) ? null : "unable";
  },
  complete() { /* the burst ends in aglTeamSystem */ },
});
