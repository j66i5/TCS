/**
 * ON-MAP MORTARS (M8.3a): crews that set up a tube and fire missions from where they stand.
 *
 * A **mortar team** is a unit whose men carry a tube: an item with a `mortar` block (the tube lies with the man who
 * carries it, its gunner). Its rounds are counted round items in the crew's loads (rule 9), taken out one at a time
 * as the tube fires. A team is "packed" (it can move), "setting" up (`setupSeconds`, longer with fewer men: x crew /
 * men at the tube), or "ready". A `deploy` order sets it up where it stands (SPEC 6.6 "deploy crew-served weapon");
 * a team that has stood still for `AUTO_DEPLOY_S` sets up on its own (player and AI alike); any move packs it up again
 * (`packSeconds` before it leaves: the move waits). The section above the teams (a unit whose sub-units are all
 * teams) is a **mortar section**: the AI commander leaves it alone (it does not fight as a squad).
 *
 * Firing is the fire-mission system's (support.ts): a call for fire goes to the side's set-up teams that reach the
 * point (between `minRangeM` and `maxRangeM` from the tube) and hold rounds of the kind asked; out of their range
 * and with no off-map battery, the call is refused.
 *
 * M9.3b: the same crew-served life (carried item, crew at it, packed / setting / ready, pack on move, auto-deploy,
 * a fallen gunner's item taken over) for a **missile team**: a unit whose gunner carries an item with a
 * `crewServed` block (a guided missile launch post). Its firing is systems/missile-team.ts; while it guides a
 * missile its men's moves wait until the missile's flight ends.
 */
import type { SimContext } from "../context";
import type { EventSink } from "../events";
import { secondsToTicks, type EntityId, type SideId } from "../ids";
import { isAble } from "../impair";
import { countItems, removeItems, transferItems } from "../items";
import { atan2, sqrt } from "../math";
import type { AglPostDef, CrewServedDef, ItemTypeDef, MissilePostDef, MortarDef } from "../catalog";
import type { SimState, SimView } from "../state";

/** A team that has stood still this long sets up on its own. */
export const AUTO_DEPLOY_S = 3;
/** Its crew are the able men within this of the tube. */
export const CREW_RADIUS_M = 20;

/** Where a team's tube is and what it is: the man carrying it, the item, its data. */
export interface Tube { team: EntityId; carrier: EntityId; item: string; def: MortarDef; x: number; y: number }
/** M9.3b: where a missile team's launch post is and what it is (the man carrying it is its gunner). M7.6d: the
 *  same for an automatic grenade launcher's post (`Post<AglPostDef>`) and either (`Post`). */
export interface Post<D extends CrewServedDef = CrewServedDef> { team: EntityId; carrier: EntityId; item: string; def: D; x: number; y: number }
export type Launcher = Post<MissilePostDef>;
export type AglPost = Post<AglPostDef>;

/** The crew-served item (picked by `pick`) a unit's men carry: the first man in ID order who has one, or null. */
function carriedOf<D>(ctx: SimContext, state: SimView, team: EntityId, pick: (it: ItemTypeDef | undefined) => D | undefined): { team: EntityId; carrier: EntityId; item: string; def: D; x: number; y: number } | null {
  const u = state.unit.get(team);
  if (!u) return null;
  for (const m of u.members) {
    const c = state.container.get(m);
    if (!c) continue;
    for (const st of c.stacks) {
      const def = st.count > 0 ? pick(ctx.catalog.items[st.type]) : undefined;
      if (!def) continue;
      const t = state.transform.get(m);
      if (!t) return null;
      return { team, carrier: m, item: st.type, def, x: t.x, y: t.y };
    }
  }
  return null;
}
const pickMortar = (it: ItemTypeDef | undefined) => it?.mortar;
const pickCrewServed = (it: ItemTypeDef | undefined) => it?.crewServed;
const pickMissile = (it: ItemTypeDef | undefined) => (it?.crewServed?.kind === "missile" ? it.crewServed : undefined);
const pickAgl = (it: ItemTypeDef | undefined) => (it?.crewServed?.kind === "agl" ? it.crewServed : undefined);

/** The tube a unit's men carry (the first man in ID order who has one), or null. */
export function tubeOf(ctx: SimContext, state: SimView, team: EntityId): Tube | null {
  return carriedOf(ctx, state, team, pickMortar);
}

/** The missile launch post a unit's men carry (M9.3b; the first man in ID order who has one), or null. */
export function launcherOf(ctx: SimContext, state: SimView, team: EntityId): Launcher | null {
  return carriedOf(ctx, state, team, pickMissile);
}

/** M7.6d: the automatic grenade launcher's post a unit's men carry (the first man in ID order who has one), or null. */
export function aglOf(ctx: SimContext, state: SimView, team: EntityId): AglPost | null {
  return carriedOf(ctx, state, team, pickAgl);
}

/** The crew-served post of either kind a unit's men carry (M7.6d), or null. */
export function crewPostOf(ctx: SimContext, state: SimView, team: EntityId): Post | null {
  return carriedOf(ctx, state, team, pickCrewServed);
}

/** Is this unit a dismounted missile team (M9.3b)? (M7.6d: not an automatic grenade launcher team.) */
export function isMissileTeam(state: SimView, uid: EntityId): boolean {
  const mt = state.unit.get(uid)?.missileTeam;
  return mt !== undefined && mt.kind !== "agl";
}

/** M7.6d: is this unit an automatic grenade launcher team (its post state is `Unit.missileTeam` with kind "agl")? */
export function isAglTeam(state: SimView, uid: EntityId): boolean {
  return state.unit.get(uid)?.missileTeam?.kind === "agl";
}

/** M7.6d: the kind of crew-served team this unit is ("missile", "agl"), or null (not a crew-served team). */
export function crewServedKind(state: SimView, uid: EntityId): "missile" | "agl" | null {
  const mt = state.unit.get(uid)?.missileTeam;
  return mt === undefined ? null : mt.kind === "agl" ? "agl" : "missile";
}

/** Is this unit a mortar team (it has a tube state), or a section made only of teams? */
export function isMortarUnit(state: SimView, uid: EntityId): boolean {
  const u = state.unit.get(uid);
  if (!u) return false;
  if (u.mortar !== undefined) return true;
  return u.members.length === 0 && u.children.length > 0 && u.children.every((c) => state.unit.get(c)?.mortar !== undefined);
}

/** The side's mortar teams, ascending id. */
export function mortarTeams(state: SimView, side: SideId): EntityId[] {
  const out: EntityId[] = [];
  for (const [id, u] of state.unit.entries()) if (u.side === side && u.mortar !== undefined) out.push(id);
  return out;
}

/** The able men of a team at its tube who can work it (not panicked, routed or aboard a vehicle), ascending id.
 *  `free` (missile teams, review fix): also not carrying a casualty or waiting on one (intent "care"). */
export function crewAt(state: SimView, tube: { team: EntityId; x: number; y: number }, free = false): EntityId[] {
  const u = state.unit.get(tube.team);
  if (!u) return [];
  const out: EntityId[] = [];
  const r2 = CREW_RADIUS_M * CREW_RADIUS_M;
  for (const m of u.members) {
    const s = state.soldier.get(m), t = state.transform.get(m);
    if (!s || !t || !isAble(s) || !s.impair.canUseArms || s.mount !== undefined) continue;
    if (s.mental.behaviour === "panicked" || s.mental.behaviour === "routed") continue;
    if (free && busyWithCasualty(s)) continue;
    if ((t.x - tube.x) * (t.x - tube.x) + (t.y - tube.y) * (t.y - tube.y) > r2) continue;
    out.push(m);
  }
  return out;
}

/** Is this man carrying a casualty or waiting on one (intent "care")? He has left the fight (carry.ts). */
export function busyWithCasualty(s: { carrying?: unknown; intent?: { kind: string } | null }): boolean {
  return s.carrying !== undefined || s.intent?.kind === "care";
}

/** Rounds of `type` the team's men hold (counted items, rule 9). */
export function teamRounds(state: SimView, team: EntityId, type: string): number {
  const u = state.unit.get(team);
  if (!u) return 0;
  let n = 0;
  for (const m of u.members) { const c = state.container.get(m); if (c) for (const st of c.stacks) if (st.type === type) n += st.count; }
  return n;
}

/** Take one round of `type` from the team: the tube's carrier first, then the others in ID order. False if none. */
export function takeRound(state: SimState, tube: { team: EntityId; carrier: EntityId }, type: string): boolean {
  const u = state.unit.get(tube.team);
  if (!u) return false;
  const order = [tube.carrier, ...u.members.filter((m) => m !== tube.carrier)];
  for (const m of order) {
    const c = state.container.get(m);
    if (c && countItems(c, type) > 0) { removeItems(c, type, 1); return true; }
  }
  return false;
}

/** Distance from the tube to a point (m). */
export function tubeRangeM(tube: Tube, x: number, y: number): number {
  return sqrt((x - tube.x) * (x - tube.x) + (y - tube.y) * (y - tube.y));
}

/** Can this team fire on (x, y) now or once set up: set up or setting up, enough crew, in its range band. */
export function tubeReaches(tube: Tube, x: number, y: number): boolean {
  const d = tubeRangeM(tube, x, y);
  return d >= tube.def.minRangeM && d <= tube.def.maxRangeM;
}

/** Give every unit whose men carry a tube its mortar state (packed) at the start of the battle. */
export function initMortars(ctx: SimContext, state: SimState): void {
  for (const [id, u] of state.unit.entries()) {
    if (u.mortar !== undefined || u.missileTeam !== undefined) continue;
    if (tubeOf(ctx, state, id)) u.mortar = { state: "packed", readyTick: -1, stillTick: 0 };
    // M9.3b: a missile team, packed, laid the way its gunner faces.
    // (M7.6d: an automatic grenade launcher's team the same, marked kind "agl".)
    else {
      const l = crewPostOf(ctx, state, id);
      if (l) u.missileTeam = { state: "packed", readyTick: -1, stillTick: 0, heading: state.transform.get(l.carrier)?.heading ?? 0, lastLaunchTick: -1, shots: 0, guide: null, ...(l.def.kind === "agl" ? { kind: "agl" as const } : {}) };
    }
  }
}

/** Start setting up (a `deploy` order or standing still): ready after the set-up time, longer with fewer men. */
export function startSetup(ctx: SimContext, state: SimState, events: EventSink, team: EntityId): boolean {
  const u = state.unit.get(team);
  if (u?.missileTeam) return startTeamSetup(ctx, state, events, team);
  const tube = tubeOf(ctx, state, team);
  if (!u?.mortar || !tube) return false;
  if (u.mortar.state !== "packed") return true;
  const crew = crewAt(state, tube).length;
  if (crew < tube.def.crewMin) return false;
  u.mortar.state = "setting";
  u.mortar.readyTick = state.tick + secondsToTicks(tube.def.setupSeconds * Math.max(1, tube.def.crew / crew));
  events.emit({ kind: "mortar.setup", tick: state.tick, unit: team, readyTick: u.mortar.readyTick });
  return true;
}

/** M9.3b: a missile team starts setting up its post (laid toward a queued shot, else the way its gunner faces). */
function startTeamSetup(ctx: SimContext, state: SimState, events: EventSink, team: EntityId): boolean {
  const u = state.unit.get(team), mt = u?.missileTeam;
  const l = crewPostOf(ctx, state, team);
  if (!mt || !l) return false;
  if (mt.state !== "packed") return true;
  if (!isAble(state.soldier.get(l.carrier)) || busyWithCasualty(state.soldier.req(l.carrier))) return false;
  const crew = crewAt(state, l, true).length;
  if (crew < l.def.crewMin) return false;
  mt.state = "setting";
  mt.readyTick = state.tick + secondsToTicks(l.def.setupSeconds * Math.max(1, l.def.crew / crew));
  mt.heading = mt.queued ? atan2(mt.queued.y - l.y, mt.queued.x - l.x) : state.transform.get(l.carrier)?.heading ?? mt.heading;
  events.emit({ kind: "missileTeam.setup", tick: state.tick, unit: team, readyTick: mt.readyTick });
  return true;
}

/**
 * The mortar teams' state (every half second): a moving team is packed (a deployed one first spends `packSeconds`
 * packing: its move waits), a team still for `AUTO_DEPLOY_S` sets up, a setting team becomes ready.
 */
const EVERY = 30;
export function mortarSystem(ctx: SimContext, state: SimState, events: EventSink): void {
  if (state.tick % EVERY !== 0) return;
  for (const [id, u] of state.unit.entries()) {
    const ms = u.mortar;
    if (!ms) { if (u.missileTeam) missileTeamState(ctx, state, events, id); continue; }
    // A fallen gunner (review fix): an able man of the team near him takes the tube over (one generic transfer).
    passTube(ctx, state, id);
    // Moving: any man of the team walking (a move given to the team, its section or one man).
    if (u.moving || u.members.some((m) => (state.mover.get(m)?.waypoints.length ?? 0) > 0)) {
      if (ms.state !== "packed") {
        // Packing up before the move: the men wait for it (their move resumes after `packSeconds`).
        const tube = tubeOf(ctx, state, id);
        const packT = state.tick + secondsToTicks(tube?.def.packSeconds ?? 0);
        ms.state = "packed"; ms.readyTick = -1;
        for (const m of u.members) { const mv = state.mover.get(m); if (mv && mv.waypoints.length > 0) mv.holdUntilTick = Math.max(mv.holdUntilTick ?? 0, packT); }
        events.emit({ kind: "mortar.packed", tick: state.tick, unit: id });
      }
      ms.stillTick = state.tick;
      continue;
    }
    if (ms.state === "packed") {
      if (state.tick - ms.stillTick >= secondsToTicks(AUTO_DEPLOY_S)) startSetup(ctx, state, events, id);
    } else if (ms.state === "setting" && state.tick >= ms.readyTick) {
      ms.state = "ready";
      events.emit({ kind: "mortar.ready", tick: state.tick, unit: id });
      const lead = u.leader ?? u.members[0];
      if (lead !== undefined) events.emit({ kind: "radio", tick: state.tick, side: u.side, from: lead, key: "radio.mortarReady", params: { callsign: u.callsign } });
    }
  }
}

/**
 * A missile team's state (M9.3b; with the mortars, every half second): as a mortar's, except that while it guides a
 * missile it does not pack (its men's moves wait: missiles.ts holds them until the flight ends), a move drops a
 * shot ordered while it was packed, and its post's gunner falls back to an able man of the team.
 */
function missileTeamState(ctx: SimContext, state: SimState, events: EventSink, id: EntityId): void {
  const u = state.unit.get(id)!, mt = u.missileTeam!;
  passCarried(ctx, state, id, pickCrewServed);
  // Review fix: a post carrier who is carrying a casualty (or waiting on one) has left the fight: the post moves
  // with him, so the team counts as moving (packs, does not set up on its own).
  const lc = crewPostOf(ctx, state, id), cs = lc ? state.soldier.get(lc.carrier) : undefined;
  if (u.moving || (cs !== undefined && busyWithCasualty(cs)) || u.members.some((m) => (state.mover.get(m)?.waypoints.length ?? 0) > 0)) {
    if (mt.guide) return; // (packing waits for the missile)
    if (mt.state !== "packed") {
      const packT = state.tick + secondsToTicks(lc?.def.packSeconds ?? 0);
      mt.state = "packed"; mt.readyTick = -1;
      delete mt.relayTick;
      for (const m of u.members) { const mv = state.mover.get(m); if (mv && mv.waypoints.length > 0) mv.holdUntilTick = Math.max(mv.holdUntilTick ?? 0, packT); }
      events.emit({ kind: "missileTeam.packed", tick: state.tick, unit: id });
    }
    delete mt.queued;
    mt.stillTick = state.tick;
    return;
  }
  if (mt.state === "packed") {
    if (state.tick - mt.stillTick >= secondsToTicks(AUTO_DEPLOY_S)) startTeamSetup(ctx, state, events, id);
  } else if (mt.state === "setting" && state.tick >= mt.readyTick) {
    // Review fix: the crew is checked again when the post is laid; too few able men left: packed again.
    if (!lc || !isAble(cs) || crewAt(state, lc, true).length < lc.def.crewMin) {
      mt.state = "packed"; mt.readyTick = -1;
      events.emit({ kind: "missileTeam.packed", tick: state.tick, unit: id });
      return;
    }
    mt.state = "ready";
    events.emit({ kind: "missileTeam.ready", tick: state.tick, unit: id });
    const lead = u.leader ?? u.members[0];
    if (lead !== undefined) events.emit({ kind: "radio", tick: state.tick, side: u.side, from: lead, key: "radio.missileTeamReady", params: { callsign: u.callsign } });
  }
}

/** If the man carrying the tube is no longer able, the nearest able man of the team within `CREW_RADIUS_M` of it
 *  takes it over (counted item, `transferItems`): the tube is worked, seen and heard where a living crewman is. */
function passTube(ctx: SimContext, state: SimState, team: EntityId): void {
  passCarried(ctx, state, team, pickMortar);
}

function passCarried<D>(ctx: SimContext, state: SimState, team: EntityId, pick: (it: ItemTypeDef | undefined) => D | undefined): void {
  const tube = carriedOf(ctx, state, team, pick);
  if (!tube || isAble(state.soldier.get(tube.carrier))) return;
  const u = state.unit.get(team);
  if (!u) return;
  let best = -1, bestD = CREW_RADIUS_M * CREW_RADIUS_M;
  for (const m of u.members) {
    if (m === tube.carrier) continue;
    const s = state.soldier.get(m), t = state.transform.get(m);
    if (!s || !t || !isAble(s) || s.mount !== undefined) continue;
    const d = (t.x - tube.x) * (t.x - tube.x) + (t.y - tube.y) * (t.y - tube.y);
    if (d < bestD) { bestD = d; best = m; }
  }
  if (best >= 0) transferItems(ctx.catalog, state.container, { from: tube.carrier, to: best, type: tube.item, count: 1 });
}
