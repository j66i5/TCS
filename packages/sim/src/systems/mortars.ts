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
 */
import type { SimContext } from "../context";
import type { EventSink } from "../events";
import { secondsToTicks, type EntityId, type SideId } from "../ids";
import { isAble } from "../impair";
import { countItems, removeItems, transferItems } from "../items";
import { sqrt } from "../math";
import type { MortarDef } from "../catalog";
import type { SimState, SimView } from "../state";

/** A team that has stood still this long sets up on its own. */
export const AUTO_DEPLOY_S = 3;
/** Its crew are the able men within this of the tube. */
export const CREW_RADIUS_M = 20;

/** Where a team's tube is and what it is: the man carrying it, the item, its data. */
export interface Tube { team: EntityId; carrier: EntityId; item: string; def: MortarDef; x: number; y: number }

/** The tube a unit's men carry (the first man in ID order who has one), or null. */
export function tubeOf(ctx: SimContext, state: SimView, team: EntityId): Tube | null {
  const u = state.unit.get(team);
  if (!u) return null;
  for (const m of u.members) {
    const c = state.container.get(m);
    if (!c) continue;
    for (const st of c.stacks) {
      const def = st.count > 0 ? ctx.catalog.items[st.type]?.mortar : undefined;
      if (!def) continue;
      const t = state.transform.get(m);
      if (!t) return null;
      return { team, carrier: m, item: st.type, def, x: t.x, y: t.y };
    }
  }
  return null;
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

/** The able men of a team at its tube who can work it (not panicked, routed or aboard a vehicle), ascending id. */
export function crewAt(state: SimView, tube: Tube): EntityId[] {
  const u = state.unit.get(tube.team);
  if (!u) return [];
  const out: EntityId[] = [];
  const r2 = CREW_RADIUS_M * CREW_RADIUS_M;
  for (const m of u.members) {
    const s = state.soldier.get(m), t = state.transform.get(m);
    if (!s || !t || !isAble(s) || !s.impair.canUseArms || s.mount !== undefined) continue;
    if (s.mental.behaviour === "panicked" || s.mental.behaviour === "routed") continue;
    if ((t.x - tube.x) * (t.x - tube.x) + (t.y - tube.y) * (t.y - tube.y) > r2) continue;
    out.push(m);
  }
  return out;
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
export function takeRound(state: SimState, tube: Tube, type: string): boolean {
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
    if (u.mortar !== undefined) continue;
    if (tubeOf(ctx, state, id)) u.mortar = { state: "packed", readyTick: -1, stillTick: 0 };
  }
}

/** Start setting up (a `deploy` order or standing still): ready after the set-up time, longer with fewer men. */
export function startSetup(ctx: SimContext, state: SimState, events: EventSink, team: EntityId): boolean {
  const u = state.unit.get(team);
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

/**
 * The mortar teams' state (every half second): a moving team is packed (a deployed one first spends `packSeconds`
 * packing: its move waits), a team still for `AUTO_DEPLOY_S` sets up, a setting team becomes ready.
 */
const EVERY = 30;
export function mortarSystem(ctx: SimContext, state: SimState, events: EventSink): void {
  if (state.tick % EVERY !== 0) return;
  for (const [id, u] of state.unit.entries()) {
    const ms = u.mortar;
    if (!ms) continue;
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

/** If the man carrying the tube is no longer able, the nearest able man of the team within `CREW_RADIUS_M` of it
 *  takes it over (counted item, `transferItems`): the tube is worked, seen and heard where a living crewman is. */
function passTube(ctx: SimContext, state: SimState, team: EntityId): void {
  const tube = tubeOf(ctx, state, team);
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
