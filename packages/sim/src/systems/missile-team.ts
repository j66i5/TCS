/**
 * DISMOUNTED MISSILE TEAMS (M9.3b; owner: the Russian dismounted missile is a Metis-M team at company level).
 *
 * A **missile team** is a unit whose gunner carries a launch post (an item with a `crewServed` block). Its life on
 * the ground — packed, setting up, ready, packing on a move, setting up on its own after standing still, the post
 * passing to an able man when the gunner falls — is the crew-served code in mortars.ts. This file fires it:
 *
 *   - on its own (every quarter second, a ready team with nothing in flight), as its anti-tank rule allows
 *     (`atRuleOf`, as a man with an RPG: "hold" fires only on order; a unit fire rule "hold" too): at the enemy
 *     vehicle its men saw most recently (within `antitank.seenWithinSeconds`) inside the missile's range band,
 *     which the gunner, kneeling at the post (`sightHeightM`), can see well enough to guide onto (the same test as
 *     in flight). Beyond `traverseDeg` either side of the bearing the post is laid on, the crew first re-lays it
 *     (`relaySeconds`). Not from inside a small room, with a wall right behind or a comrade in the danger zone
 *     behind (`backblastM`);
 *   - on an order (a fire order with nature "at" to the team or a unit above it): a packed team stops and sets up
 *     first, then fires (the shot waits as `queued`; a move drops it). At a vehicle the gunner must see it; at a
 *     point he guides onto the point.
 * The shot is an action of the gunner ("fireTeamMissile", `aimSeconds`): at its end one round leaves the team's
 * loads (rule 9), the missile is launched from the post (gunnery.ts `launchGuided`) and guided from the sight's
 * place by missiles.ts. The launch is loud (`launchLoudM`) and shows the gunner (spotting: `launchFlashFactor`); a
 * target crew that has the gunner in sight notices it, fires its smoke toward him and marks the post as a contact.
 *
 * No randomness here (the flight draws on the "missile" stream in missiles.ts).
 */
import { registerActionHandler, startAction } from "../actions";
import type { AmmoDef, CrewServedDef } from "../catalog";
import type { SimContext } from "../context";
import type { EventSink } from "../events";
import { secondsToTicks, type EntityId } from "../ids";
import { isAble } from "../impair";
import { atan2, cos, hypot2, PI, sin, wrapAngle } from "../math";
import type { SimState, SimView } from "../state";
import { heightAt, standZ } from "../terrain";
import { learnContact } from "./contacts";
import { launchGuided, launchNoticed, missileAimPoint, missileSees } from "./gunnery";
import { atRuleOf, backblastBlocked } from "./launcher";
import { busyWithCasualty, crewAt, launcherOf, takeRound, teamRounds, type Launcher } from "./mortars";
import { protectedTargets } from "../protection";


/** The gunner's action that ends in a launch. */
export const TEAM_FIRE_ACTION = "fireTeamMissile";
/** How often a ready team looks for a target (ticks). */
const EVERY = 15;
/** How far ahead of the sight the missile leaves the tube (m). */
const TUBE_M = 0.5;
/** How uncertain the post is to a crew that noticed the launch (m). */
const LAUNCH_CONTACT_ERR_M = 30;

/** Is this man the gunner of a team guiding a missile now (M9.3b)? He stays at his post: no decisions of his own. */
export function isGuiding(state: SimView, id: EntityId): boolean {
  const uid = state.identity.get(id)?.unit;
  const g = uid === undefined ? undefined : state.unit.get(uid)?.missileTeam?.guide;
  return g !== undefined && g !== null && g.gunner === id;
}

/** The guided round a post fires: the round item's missile and its guidance data. */
export function teamRound(ctx: SimContext, def: CrewServedDef): { ammo: string; g: NonNullable<AmmoDef["guided"]> } | null {
  const ammo = ctx.catalog.items[def.round]?.chargeItem;
  const g = ammo !== undefined ? ctx.catalog.ammo[ammo]?.guided : undefined;
  return ammo !== undefined && g ? { ammo, g } : null;
}

/** Can the gunner work the post now: able, arms usable, on foot, not stunned, panicked or routed, not walking, not
 *  carrying a casualty or waiting on one. */
function gunnerFit(state: SimState, id: EntityId): boolean {
  const s = state.soldier.get(id);
  if (!s || !isAble(s) || !s.impair.canUseArms || s.mount !== undefined || state.tick < s.stunnedUntilTick || s.evade !== null) return false;
  if (s.mental.behaviour === "panicked" || s.mental.behaviour === "routed") return false;
  if (busyWithCasualty(s)) return false; // (review fix: a carrier has left the fight, carry.ts)
  return (state.mover.get(id)?.waypoints.length ?? 0) === 0;
}

/** The sight's place: over the post, at the sight's height above the gunner's ground. */
function sightOf(ctx: SimContext, state: SimState, l: Launcher): [number, number, number] {
  const t = state.transform.req(l.carrier);
  return [l.x, l.y, standZ(ctx.map, t) + l.def.sightHeightM];
}

const AIM = { x: 0, y: 0, z: 0 };

/** The point a shot aims at: a vehicle's aim point (true place: he sees it), else the ground point + 1 m. */
function aimAt(ctx: SimContext, state: SimState, target: EntityId, x: number, y: number): boolean {
  if (target >= 0) return missileAimPoint(ctx, state, target, AIM);
  AIM.x = x; AIM.y = y; AIM.z = heightAt(ctx.map, x, y) + 1; // ground: ok (a point on the ground)
  return true;
}

/** Why the team cannot fire at the aim point now (a key), or null: range band, sight line, danger zone behind. */
function shotBlocked(ctx: SimContext, state: SimState, l: Launcher, gr: { ammo: string; g: NonNullable<AmmoDef["guided"]> }, target: EntityId): string | null {
  const [sx, sy, sz] = sightOf(ctx, state, l);
  const d = hypot2(AIM.x - sx, AIM.y - sy);
  if (d < gr.g.minRangeM || d > gr.g.maxRangeM) return "team.range";
  if (target >= 0 && !missileSees(ctx, state, l.carrier, target, sx, sy, sz, AIM.x, AIM.y, AIM.z)) return "team.unseen";
  return backblastBlocked(ctx, state, l.carrier, gr.ammo, atan2(AIM.y - sy, AIM.x - sx), l.def.backblastM);
}

/**
 * Fire decisions of the ready teams (every quarter second): a shot ordered (queued), else one of its own. Each
 * starts the gunner's aiming action; a bearing outside the post's traverse first costs a re-lay.
 */
export function missileTeamSystem(ctx: SimContext, state: SimState, events: EventSink): void {
  if (state.tick % EVERY !== 0) return;
  for (const [uid, u] of state.unit.entries()) {
    const mt = u.missileTeam;
    if (!mt || mt.state !== "ready" || mt.guide) continue;
    if (mt.relayTick !== undefined) { if (state.tick < mt.relayTick) continue; delete mt.relayTick; }
    const l = launcherOf(ctx, state, uid);
    if (!l || state.action.has(l.carrier) || !gunnerFit(state, l.carrier)) continue;
    const gr = teamRound(ctx, l.def);
    if (!gr || teamRounds(state, uid, l.def.round) <= 0 || crewAt(state, l, true).length < l.def.crewMin) continue;
    let pick: { target: EntityId; x: number; y: number } | null;
    const ordered = mt.queued !== undefined;
    if (mt.queued) {
      const q = mt.queued;
      const live = q.target < 0 || vehicleLive(state, q.target);
      const why = !live ? "team.gone" : !aimAt(ctx, state, q.target, q.x, q.y) ? "team.unseen" : shotBlocked(ctx, state, l, gr, q.target);
      delete mt.queued;
      if (why !== null) { teamRadio(state, events, uid, "radio.missileTeamNoShot"); continue; }
      pick = { target: q.target, x: AIM.x, y: AIM.y };
    } else {
      if (u.fireRule === "hold" || atRuleOf(ctx, state, uid) === "hold") continue;
      pick = ownTarget(ctx, state, uid, l, gr);
      if (!pick) continue;
    }
    // Outside the post's traverse: re-lay it first (the shot is looked for again once laid).
    const [sx, sy] = sightOf(ctx, state, l);
    const bearing = atan2(pick.y - sy, pick.x - sx);
    if (Math.abs(wrapAngle(bearing - mt.heading)) > (l.def.traverseDeg * PI) / 180) {
      mt.heading = bearing;
      mt.relayTick = state.tick + secondsToTicks(l.def.relaySeconds);
      if (ordered) mt.queued = { x: pick.x, y: pick.y, target: pick.target }; // (an ordered shot waits for it)
      continue;
    }
    startAction(state, events, l.carrier, TEAM_FIRE_ACTION, Math.max(1, secondsToTicks(l.def.aimSeconds)), { team: uid, target: pick.target, x: pick.x, y: pick.y });
    const s = state.soldier.req(l.carrier);
    if (pick.target >= 0) s.intent = { kind: "engage", tick: state.tick, target: pick.target };
  }
}

function vehicleLive(state: SimState, vid: EntityId): boolean {
  const v = state.vehicle.get(vid);
  return v !== undefined && v.status !== "destroyed" && v.status !== "abandoned";
}

/** The team's own target: the enemy vehicle its men saw most recently, in the range band, that the gunner can
 *  guide onto from the post (the three freshest tried, nearest first among equals). */
function ownTarget(ctx: SimContext, state: SimState, uid: EntityId, l: Launcher, gr: { ammo: string; g: NonNullable<AmmoDef["guided"]> }): { target: EntityId; x: number; y: number } | null {
  const u = state.unit.req(uid);
  const seen = secondsToTicks(ctx.catalog.behaviour.antitank.seenWithinSeconds);
  const cands: { target: EntityId; tick: number; d: number }[] = [];
  const prot = protectedTargets(state, u.members);
  for (const m of u.members) {
    const s = state.soldier.get(m);
    if (!isAble(s)) continue;
    for (const c of s!.contacts) {
      if (c.cls !== "vehicle" || c.kind !== "seen" || c.wreck || state.tick - c.tick > seen) continue;
      if (prot !== null && prot.has(c.target)) continue; // (M10.7a: a recognised marked ambulance)
      const v = state.vehicle.get(c.target);
      if (!v || v.side === u.side || !vehicleLive(state, c.target)) continue;
      const d = hypot2(c.x - l.x, c.y - l.y);
      if (d < gr.g.minRangeM || d > gr.g.maxRangeM) continue;
      const k = cands.findIndex((q) => q.target === c.target);
      if (k < 0) cands.push({ target: c.target, tick: c.tick, d });
      else if (c.tick > cands[k]!.tick) cands[k] = { target: c.target, tick: c.tick, d };
    }
  }
  cands.sort((a, b) => b.tick - a.tick || a.d - b.d || a.target - b.target);
  for (let i = 0; i < cands.length && i < 3; i++) {
    const c = cands[i]!;
    if (!aimAt(ctx, state, c.target, 0, 0) || shotBlocked(ctx, state, l, gr, c.target) !== null) continue;
    return { target: c.target, x: AIM.x, y: AIM.y };
  }
  return null;
}

function teamRadio(state: SimState, events: EventSink, uid: EntityId, key: string): void {
  const u = state.unit.req(uid);
  const lead = u.leader ?? u.members[0];
  if (lead !== undefined) events.emit({ kind: "radio", tick: state.tick, side: u.side, from: lead, key, params: { callsign: u.callsign } });
}

/**
 * Order (M9.3b): fire the teams' missiles at (x, y) or at the named enemy vehicle. Each team that can (a launch post,
 * rounds, enough crew) stops, sets up if packed, and fires once ready. Returns false if none can.
 */
export function teamOrderShot(ctx: SimContext, state: SimState, teams: readonly EntityId[], x: number, y: number, contact: EntityId | undefined, stop: (team: EntityId) => void, setup: (team: EntityId) => boolean): boolean {
  let any = false;
  for (const uid of teams) {
    const u = state.unit.get(uid), mt = u?.missileTeam;
    const l = launcherOf(ctx, state, uid);
    if (!u || !mt || !l || teamRounds(state, uid, l.def.round) <= 0 || !teamRound(ctx, l.def)) continue;
    // Review fix: a team without enough free men at the post, or whose post carrier cannot work it, is unable
    // (the order falls through to "unable").
    const cs = state.soldier.get(l.carrier);
    if (!isAble(cs) || busyWithCasualty(cs!) || crewAt(state, l, true).length < l.def.crewMin) continue;
    const target = contact !== undefined && state.vehicle.has(contact) ? contact : -1;
    // Every team that takes the shot stops (a move given just before would otherwise pack it and drop the shot).
    stop(uid);
    mt.queued = { x, y, target };
    if (mt.state === "packed" && !setup(uid)) { delete mt.queued; continue; }
    any = true;
  }
  return any;
}

/** Action "fireTeamMissile" (the gunner lays on the target): params { team, target, x, y }. */
registerActionHandler(TEAM_FIRE_ACTION, {
  check(_ctx, state, actor, a) {
    const mt = state.unit.get(Number(a.params["team"]))?.missileTeam;
    if (!mt || mt.state !== "ready" || mt.guide) return "unable";
    if (!gunnerFit(state, actor)) return "unable";
    const t = state.transform.req(actor);
    t.heading = atan2(Number(a.params["y"]) - t.y, Number(a.params["x"]) - t.x);
    return null;
  },
  complete(ctx, state, actor, a, events) {
    launchFromPost(ctx, state, events, actor, Number(a.params["team"]), Number(a.params["target"]), Number(a.params["x"]), Number(a.params["y"]));
  },
});

/** The launch: one round from the team's loads, the missile off the post, the guide written, the signature. */
function launchFromPost(ctx: SimContext, state: SimState, events: EventSink, gunner: EntityId, uid: EntityId, target: EntityId, x: number, y: number): void {
  const u = state.unit.get(uid), mt = u?.missileTeam;
  const l = launcherOf(ctx, state, uid);
  if (!u || !mt || !l || l.carrier !== gunner || mt.guide) return;
  const gr = teamRound(ctx, l.def);
  if (!gr || (target >= 0 && !vehicleLive(state, target)) || !aimAt(ctx, state, target, x, y)) return;
  if (shotBlocked(ctx, state, l, gr, target) !== null) return; // the line closed or a comrade stepped behind
  if (!takeRound(state, l, l.def.round)) return;
  const tick = state.tick;
  const [sx, sy, sz] = sightOf(ctx, state, l);
  const tx = AIM.x, ty = AIM.y, tz = AIM.z;
  const b = atan2(ty - sy, tx - sx);
  const mx = sx + cos(b) * TUBE_M, my = sy + sin(b) * TUBE_M;
  const v0 = ctx.catalog.weapons[l.def.weapon]?.ammo[gr.ammo] ?? 50;
  const a0 = launchGuided(ctx, state, gr, v0, mx, my, sz, tx, ty, tz, gunner);
  events.emit({ kind: "shot.fired", tick, shooter: gunner, x: mx, y: my, z: sz, dirX: cos(a0), dirY: sin(a0), weapon: l.def.weapon, ammo: gr.ammo, loudM: l.def.launchLoudM });
  mt.guide = { ammo: gr.ammo, weapon: 0, gunner, launchTick: tick, target, errH: 0, errV: 0, checkTick: -1, ax: tx, ay: ty, az: tz, ox: sx, oy: sy, oz: sz };
  const kind = ctx.catalog.ammo[gr.ammo]?.guidance;
  if (kind !== undefined && kind !== "command-wire") mt.guide.kind = kind;
  mt.lastLaunchTick = tick;
  mt.shots++;
  delete mt.queued;
  const s = state.soldier.req(gunner);
  s.launchTick = tick;
  state.fire.delete(gunner); // (review fix: his own fire task ends; he guides)
  const w = state.weapon.get(gunner);
  if (w) w.lastShotTick = tick;
  if (ctx.catalog.medical !== undefined) s.protLostTick = tick; // (M10.7b: firing is not self-defence)
  // Launch warning (as from a vehicle, M9.3a): a crew that has the gunner in sight fires its smoke toward him a
  // moment later, and marks the post (its crewmen get a contact there).
  if (target >= 0 && launchNoticed(ctx, state, target, gunner, kind)) {
    mt.guide.warnTick = tick + Math.max(1, secondsToTicks(ctx.catalog.behaviour.crew.launchReactionSeconds));
    const v = state.vehicle.req(target);
    for (const m of v.seats) {
      const cs = m === null || m === undefined ? undefined : state.soldier.get(m);
      if (!isAble(cs)) continue;
      learnContact(ctx, cs!.contacts, { target: gunner, x: sx, y: sy, errM: LAUNCH_CONTACT_ERR_M, kind: "heard", tick }, tick);
    }
  }
}
