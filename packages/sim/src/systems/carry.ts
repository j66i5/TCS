/**
 * CARRYING AS A MOVEMENT MODE (SPEC 9.1, M10.4a).
 *
 * A carrying party moves a payload (a casualty now; supplies in M11: an entity with mass) with one of the carry methods
 * of core/medical.json (`carry`: walking wounded, supported, drag, two-man drag, fireman's carry, two-man carry,
 * four-man litter), kept in the `carry` store under the payload. carriers[0] leads: he walks the route
 * (`routeBetween`, houses and stairs included) at the method's speed — scaled by the payload's mass, then by ground,
 * slope and stairs, his fatigue and his wounds as any walker (movement.ts) — and the payload and the other carriers
 * follow on his trail at fixed distances (`carryLayout`), so the casualty is never more than 1.5 m from a carrier.
 * Walking wounded have no carrier: the casualty leads himself.
 *
 * Phases: the carriers gather beside him (`carrying.reachM`), unfold a litter (`setupS`), set off; after
 * `enduranceM` they rest `restS`. Carriers leave the fight: decisions, unit orders and drills pass them by (an order
 * to one of them alone takes him out of the party), and they fire only at an enemy within `carrying.selfDefenceM`
 * while the party is still (owner M10-2 Q-2f). A party fired on (a carrier pinned or at `carrying.holdSuppression`)
 * takes cover with the casualty — to the nearest spot hidden from the enemy within `care.dragSearchM`, or where it is
 * if that is hidden already — lies down, and goes on after `carrying.resumeQuietS` without fire. A carrier lost (hit,
 * panicking, ordered away) makes the rest carry on with a method for fewer men, or put the casualty down.
 * `medical.carried` events. Same rules for every side, the player's and the AI's.
 */
import type { Carry, SoldierState } from "../components";
import type { CarryMethodDef } from "../catalog";
import type { SimContext } from "../context";
import type { EventSink } from "../events";
import { secondsToTicks, type DefId, type EntityId } from "../ids";
import { isAble, isConscious } from "../impair";
import { routeBetween, routeWaypoints, type RouteResult } from "../interior-nav";
import { atan2, clamp, cos, hypot2, PI, sin, sqrt } from "../math";
import { carryLayout, chooseCarryMethod, downUnknown } from "../medical";
import { isMounted } from "../mount";
import { navFor } from "../navctx";
import { clearLine } from "../nav";
import type { Posture } from "../orders";
import type { SimState } from "../state";
import { loadKg, requestPosture } from "./body";
import { coveredFrom, threatOf, unitThreat } from "./decisions";
import { isCowering } from "./morale";
import { freePositionNear } from "../positions";
import { indoorAt } from "../interior-nav";
import { freePlaceNear } from "./occupy";

/** Code defaults when the data has no `carrying` block (old data sets). */
const DEFAULTS = { reachM: 2, holdSuppression: 0.3, resumeQuietS: 10, selfDefenceM: 30, massRefKg: 105 };
/** A trip to the Verwundetennest cut short is tried again after this long (s, M10.5). */
const EVAC_RETRY_S = 30;
/** Carriers who have not gathered after this long give up (s). */
const GATHER_TIMEOUT_S = 120;
/** M11.4a: bearers lift a crate within this of the leader where he stands (m; a man takes from a cache within 4.5 m). */
const CARGO_LIFT_M = 5;
/** A new trail point when the leader has moved this far (m). */
const TRAIL_STEP_M = 0.15;

export function carryParams(ctx: SimContext): typeof DEFAULTS {
  return ctx.catalog.medical?.carrying ?? DEFAULTS;
}

/** A carry method by id: the medical ones (core/medical.json `carry`), else the bearers' (M11.4a, core/supply.json
 *  `bearers.methods`: `crate`, `load`). */
export function carryMethodDef(ctx: SimContext, id: DefId): CarryMethodDef | undefined {
  const m = ctx.catalog.medical?.carry[id];
  if (m) return m;
  const B = ctx.catalog.supply?.bearers?.methods;
  return id === "crate" ? B?.crate : id === "load" ? B?.load : undefined;
}

/** Who leads a party: the first carrier, or the walking wounded man himself. */
export function carryLeader(c: Carry, payload: EntityId): EntityId {
  return c.carriers[0] ?? payload;
}

/** The payload's mass (kg): a man's body and what he carries. */
export function payloadMassKg(ctx: SimContext, state: SimState, id: EntityId): number {
  return (state.soldier.has(id) ? ctx.catalog.body.physiology.bodyMassKg : 0) + loadKg(ctx, state, id);
}

/** The carry speed on level open ground for this method and mass (m/s): speed x sqrt(massRef / mass), 0.75-1.15. */
export function carrySpeedMps(ctx: SimContext, def: CarryMethodDef, massKg: number): number {
  if (def.carriers === 0) return def.speedMps; // he carries himself
  return def.speedMps * clamp(sqrt(carryParams(ctx).massRefKg / Math.max(1, massKg)), 0.75, 1.15);
}

/** An item with medical tag `tag` held by one of `men` (the first in their order), or null. */
export function itemWithTag(ctx: SimContext, state: SimState, men: readonly EntityId[], tag: DefId): { type: DefId; from: EntityId } | null {
  for (const m of men) {
    const c = state.container.get(m);
    if (!c) continue;
    for (const st of c.stacks) if (st.count > 0 && ctx.catalog.items[st.type]?.medical?.tags.includes(tag)) return { type: st.type, from: m };
  }
  return null;
}

/** Can he carry (alive, awake, legs and arms, on foot, not panicking)? */
function canCarry(s: SoldierState | undefined): boolean {
  return s !== undefined && isAble(s) && s.impair.canWalk && s.impair.canUseArms && !isMounted(s) && s.captive === null
    && s.mental.behaviour !== "panicked" && s.mental.behaviour !== "routed";
}

/** Does he walk (awake, legs that carry him, not knocked down)? */
function walksSelf(state: SimState, id: EntityId): boolean {
  const s = state.soldier.get(id);
  return s !== undefined && isConscious(s) && s.impair.canWalk && state.tick >= s.stunnedUntilTick && s.captive === null;
}

export interface CarryOptions {
  /** A method by id (labs, tests); otherwise the best for the men given (`chooseCarryMethod`). */
  method?: DefId;
  purpose?: Carry["purpose"];
  /** Under fire: only methods that keep everyone low. */
  underFire?: boolean;
  /** Give up after this many seconds (a drag to cover). */
  limitS?: number;
  /** Taken to this rear point (M10.5, the Verwundetennest). */
  point?: EntityId;
  /** M11.4a: the payload is supplies (a crate) and `method` one of the bearers' methods. */
  cargo?: boolean;
}

/**
 * Start carrying `payload` to `dest` with `carriers` (the nearest first; the method uses as many as it needs, the man
 * with the litter among them). The party first gathers beside him. Null if no method fits or he is already carried.
 */
export function startCarry(ctx: SimContext, state: SimState, events: EventSink, payload: EntityId, carriers: readonly EntityId[], dest: { x: number; y: number; z: number }, opts: CarryOptions = {}): Carry | null {
  if (state.carry.has(payload) || !state.transform.has(payload)) return null;
  if (opts.cargo === true) return startCargo(ctx, state, events, payload, carriers, dest, opts);
  const C = ctx.catalog.medical?.carry;
  if (!C) return null;
  const ps = state.soldier.get(payload);
  // (A dead man may be dragged to cover while his comrades do not know he is dead: owner request 2026-11-15.)
  if (ps && ((!ps.physiology.alive && !(opts.purpose === "cover" && downUnknown(ctx.catalog, ps))) || isMounted(ps) || ps.carrying !== undefined)) return null;
  const men = carriers.filter((m) => m !== payload && canCarry(state.soldier.get(m)) && state.soldier.get(m)!.carrying === undefined);
  const walks = ps !== undefined && walksSelf(state, payload);
  let method = opts.method;
  const def0 = method !== undefined ? C[method] : undefined;
  const litter = itemWithTag(ctx, state, men, def0?.needsTag ?? "litter");
  if (method === undefined) method = chooseCarryMethod(ctx.catalog, men.length, walks, ps?.impair.move ?? 1, opts.underFire === true, litter !== null) ?? undefined;
  const def = method !== undefined ? C[method] : undefined;
  if (method === undefined || !def || def.carriers > men.length || (def.casualtyWalks === true && !walks)) return null;
  if (def.needsTag !== undefined && litter === null) return null;
  const use = men.slice(0, def.carriers);
  if (def.needsTag !== undefined && litter && !use.includes(litter.from)) use[use.length - 1] = litter.from;
  const massKg = payloadMassKg(ctx, state, payload);
  const c: Carry = {
    method, carriers: use, phase: "gather", phaseTick: state.tick, startTick: state.tick, dest: { ...dest }, purpose: opts.purpose ?? "move",
    massKg, speedMps: carrySpeedMps(ctx, def, massKg), trail: [], sinceRestM: 0, totalM: 0,
    ...(def.needsTag !== undefined && litter ? { litter } : {}),
    ...(opts.limitS !== undefined ? { untilTick: state.tick + secondsToTicks(opts.limitS) } : {}),
    ...(opts.point !== undefined ? { point: opts.point } : {}),
  };
  state.carry.set(payload, c);
  for (const m of use) {
    const s = state.soldier.req(m);
    s.carrying = payload;
    state.fire.delete(m);
  }
  if (use.length === 0 && ps) ps.carrying = payload;
  const t = state.transform.req(payload);
  events.emit({ kind: "medical.carried", tick: state.tick, payload, by: carryLeader(c, payload), method, carriers: use.length, phase: "start", distanceM: Math.round(hypot2(dest.x - t.x, dest.y - t.y)) });
  stepParty(ctx, state, events, payload, c); // (gathered already: off at once)
  return c;
}

/** M11.4a: bearers carry a crate (`opts.method`: a bearers' method; all the carriers it needs, no gathering wait). */
function startCargo(ctx: SimContext, state: SimState, events: EventSink, payload: EntityId, carriers: readonly EntityId[], dest: { x: number; y: number; z: number }, opts: CarryOptions): Carry | null {
  const method = opts.method;
  const def = method !== undefined ? carryMethodDef(ctx, method) : undefined;
  const men = carriers.filter((m) => m !== payload && canCarry(state.soldier.get(m)) && state.soldier.get(m)!.carrying === undefined);
  if (method === undefined || !def || def.carriers < 1 || def.carriers > men.length) return null;
  const use = men.slice(0, def.carriers);
  // (He lifts it where he stands: a crate against a wall lies off the navigation cells, out of the gathering reach.)
  const pt0 = state.transform.req(payload), lt0 = state.transform.req(use[0]!);
  if (hypot2(pt0.x - lt0.x, pt0.y - lt0.y) <= CARGO_LIFT_M && Math.abs(pt0.z - lt0.z) <= 1.5) { pt0.x = lt0.x; pt0.y = lt0.y; pt0.z = lt0.z; }
  const massKg = payloadMassKg(ctx, state, payload);
  const c: Carry = {
    method, carriers: use, phase: "gather", phaseTick: state.tick, startTick: state.tick, dest: { ...dest }, purpose: "move",
    massKg, speedMps: carrySpeedMps(ctx, def, massKg), trail: [], sinceRestM: 0, totalM: 0, cargo: true,
  };
  state.carry.set(payload, c);
  for (const m of use) { state.soldier.req(m).carrying = payload; state.fire.delete(m); }
  const t = state.transform.req(payload);
  events.emit({ kind: "medical.carried", tick: state.tick, payload, by: use[0]!, method, carriers: use.length, phase: "start", distanceM: Math.round(hypot2(dest.x - t.x, dest.y - t.y)) });
  stepParty(ctx, state, events, payload, c);
  return c;
}

/** End a party: everyone is free again, the payload stays where he is. */
export function endCarry(ctx: SimContext, state: SimState, events: EventSink, payload: EntityId, reason: string): void {
  const c = state.carry.get(payload);
  if (!c) return;
  const lead = carryLeader(c, payload);
  for (const m of c.carriers) {
    const s = state.soldier.get(m);
    if (s?.carrying === payload) delete s.carrying;
  }
  const ps = state.soldier.get(payload);
  if (ps?.carrying === payload) delete ps.carrying;
  // (Short of the destination the leader stops; the payload goes nowhere on his own, a walking wounded man too.)
  const lm = reason !== "arrived" && c.carriers.length > 0 ? state.mover.get(lead) : undefined;
  if (lm && lm.waypoints.length > 0) { lm.waypoints = []; lm.speedMps = 0; }
  const pm = state.mover.get(payload);
  if (pm && pm.waypoints.length > 0) { pm.waypoints = []; pm.speedMps = 0; }
  state.carry.delete(payload);
  setDownOffCarrier(ctx, state, c, payload, lead);
  // Brought to the Verwundetennest (M10.5): he is at it, and the bearers go back to their squad.
  if (c.point !== undefined && reason === "arrived" && ps) {
    ps.atNest = c.point;
    if (ps.evacOrdered) delete ps.evacOrdered;
    events.emit({ kind: "medical.evac", tick: state.tick, casualty: payload, point: c.point, phase: "arrived" });
    bearersBack(ctx, state, c.carriers);
  } else if (c.point !== undefined && ps && reason !== "dead") {
    // (Cut short: tried again after a while, not every second.)
    ps.evacRetryTick = state.tick + secondsToTicks(EVAC_RETRY_S);
  }
  if (c.purpose === "cover" && reason === "arrived" && ps) {
    const pt = state.transform.req(payload);
    ps.sheltered = { x: pt.x, y: pt.y };
    if (state.soldier.has(lead)) requestPosture(ctx, state, lead, "prone");
    events.emit({ kind: "medical.dragged", tick: state.tick, casualty: payload, by: lead, done: true, distanceM: Math.round(c.totalM) });
  }
  events.emit({ kind: "medical.carried", tick: state.tick, payload, by: lead, method: c.method, carriers: c.carriers.length, phase: "done", distanceM: Math.round(c.totalM), reason });
}

/** A payload set down closer than this to the leader is moved back off his spot (m). */
const SET_DOWN_APART_M = 0.3;
/** ... to this far back along the leader's trail (m). */
const SET_DOWN_BACK_M = 0.9;

/**
 * Review 2026-11-24, problem 1: a man carried on the leader's back (fireman's carry: the payload on the leader's own
 * spot, `carryLayout`) is set down behind him on the way they came, lying along it, whatever ended the carry (his
 * death too): left on the carrier's spot, his body lay over the carrier's muzzle and took 14 of his rounds.
 */
function setDownOffCarrier(ctx: SimContext, state: SimState, c: Carry, payload: EntityId, lead: EntityId): void {
  if (c.carriers.length === 0 || lead === payload || !state.soldier.has(payload)) return;
  const pt = state.transform.get(payload), lt = state.transform.get(lead);
  if (!pt || !lt || hypot2(pt.x - lt.x, pt.y - lt.y) >= SET_DOWN_APART_M || Math.abs(pt.z - lt.z) > 0.5) return;
  let p: { x: number; y: number; z: number; h: number } | null = null;
  if (c.trail.length >= 6) {
    const q = along([lt.x, lt.y, lt.z, ...c.trail], SET_DOWN_BACK_M);
    if (hypot2(q.x - lt.x, q.y - lt.y) >= SET_DOWN_APART_M * 2) p = q;
  }
  if (p === null && indoorAt(ctx, lt.x, lt.y) < 0) {
    // (No trail behind him: straight back from where he faces, where the ground lets a man lie.)
    const x = lt.x - cos(lt.heading) * SET_DOWN_BACK_M, y = lt.y - sin(lt.heading) * SET_DOWN_BACK_M;
    if (clearLine(navFor(ctx, "foot").grid, lt.x, lt.y, x, y)) p = { x, y, z: lt.z, h: lt.heading };
  }
  if (p === null) return;
  pt.x = p.x; pt.y = p.y; pt.z = p.z; pt.heading = p.h;
}

/** Bearers back with their squad (M10.5, on arrival at the nest; a man returned to duty): each walks to his unit's leader. */
/** M11: a bearer back from a carry takes a free fighting position within this of his leader (m; game value). */
const FP_BACK_M = 25;

export function bearersBack(ctx: SimContext, state: SimState, carriers: readonly EntityId[]): void {
  for (const m of carriers) {
    const s = state.soldier.get(m), mv = state.mover.get(m);
    const u = state.unit.get(state.identity.get(m)?.unit ?? -1);
    if (!s || !mv || !isAble(s) || !u || u.leader === null || u.leader === m) continue;
    const a = state.transform.req(m), b0 = state.transform.get(u.leader);
    if (!b0) continue;
    // (M11: into a free fighting position of his side near his leader, where there is one.)
    const fpos = b0.z === 0 ? freePositionNear(ctx, state, u.side, b0.x, b0.y, FP_BACK_M, m) : null;
    // (Balance pass 4 review: his leader in a house, a free place there near him, never the leader's own spot: two
    // men on one window place held each other's fire. Outdoors the step-aside rule parts men who end up together.)
    const bi = fpos ? -1 : indoorAt(ctx, b0.x, b0.y);
    const inside = bi >= 0 ? freePlaceNear(ctx, state, m, bi, b0.x, b0.y, b0.z) : null;
    const b = fpos ? { x: fpos.x, y: fpos.y, z: 0 } : inside ?? b0;
    if (hypot2(a.x - b.x, a.y - b.y) < (fpos || inside ? 0.3 : 5) && Math.abs(a.z - b.z) < 1) continue;
    const leg = routeBetween(ctx, navFor(ctx, "foot").search, a.x, a.y, b.x, b.y, { maxExpansions: 8000, snapCells: 3 }, { sz: a.z, gz: b.z });
    if (!leg) continue;
    mv.waypoints = routeWaypoints(leg, { x: 0, y: 0, mode: "walk" });
    mv.formation = null; mv.endPosture = inside ? inside.posture ?? "crouching" : "prone"; mv.endHeading = inside ? inside.heading : null;
  }
}

/** Take one man out of the party he carries in (an order to him alone; the system then carries on without him). */
export function leaveCarry(state: SimState, id: EntityId): void {
  const s = state.soldier.get(id);
  if (s?.carrying !== undefined) delete s.carrying;
}

/** The enemy a party hides from: the nearest the man knows, else where the rounds came from, else his unit's. */
export function casualtyThreat(state: SimState, helper: EntityId, c: EntityId): { x: number; y: number; z: number } | null {
  const hs = state.soldier.req(helper);
  const t = threatOf(state, helper, hs);
  if (t) return t;
  const ff = state.soldier.get(c)?.fireFrom ?? hs.fireFrom, ct = state.transform.req(c);
  if (ff && state.tick - ff.tick <= secondsToTicks(30)) return { x: ct.x + ff.dx * 150, y: ct.y + ff.dy * 150, z: 0 };
  const uid = state.identity.get(helper)?.unit;
  return uid !== undefined ? unitThreat(state, helper, uid) : null;
}

/**
 * The nearest spot within `searchM` of (x, y) hidden from `threat` for a man lying there, not toward the enemy, by a
 * way at most `maxWayM` long (ground floor: in the open or into a house; not from an upper floor). Null: none.
 */
export function coverSpotNear(ctx: SimContext, x0: number, y0: number, z0: number, threat: { x: number; y: number; z: number }, searchM: number, maxWayM: number): { x: number; y: number; leg: RouteResult; face: number } | null {
  if (z0 > 0.5) return null;
  const lie = ctx.catalog.body.postures.prone.heightM * 0.6;
  const tl = hypot2(threat.x - x0, threat.y - y0) || 1, tx = (threat.x - x0) / tl, ty = (threat.y - y0) / tl;
  const { grid, search } = navFor(ctx, "foot");
  const cands: { x: number; y: number; r: number }[] = [];
  for (let ring = 1; ring <= 3 && cands.length === 0; ring++) {
    const r = (searchM * ring) / 3;
    for (let k = 0; k < 12; k++) {
      const ang = (k * PI) / 6 + (ring % 2) * (PI / 12);
      const ux = cos(ang), uy = sin(ang);
      if (ux * tx + uy * ty > 0.3) continue; // not toward the enemy
      const x = x0 + ux * r, y = y0 + uy * r;
      if (x < 1 || y < 1 || x > ctx.map.widthM - 1 || y > ctx.map.heightM - 1) continue;
      const i = Math.floor(y / grid.cellM) * grid.cols + Math.floor(x / grid.cellM);
      if (grid.cost[i]! <= 0 || grid.wall[i] === 1) continue;
      if (!coveredFrom(ctx, x, y, threat.x, threat.y, lie, 0, threat.z)) continue;
      cands.push({ x, y, r });
    }
  }
  cands.sort((p, q) => p.r - q.r || p.x - q.x || p.y - q.y);
  for (const cnd of cands.slice(0, 3)) {
    const leg = routeBetween(ctx, search, x0, y0, cnd.x, cnd.y, { maxExpansions: 1500, snapCells: 1 });
    if (!leg || leg.cost > maxWayM) continue;
    return { x: cnd.x, y: cnd.y, leg, face: atan2(threat.y - cnd.y, threat.x - cnd.x) };
  }
  return null;
}

/** The posture of a party on the move: upright methods walk, the others go crouched (and lie when holding). */
function legPosture(def: CarryMethodDef): Posture {
  return def.upright ? "standing" : "crouching";
}

/** Send the leader along `leg` (a carry pace leg; a drag to cover is not stopped by pinning). */
function setLeg(state: SimState, c: Carry, lead: EntityId, leg: RouteResult, def: CarryMethodDef): void {
  const m = state.mover.get(lead);
  if (!m) return;
  const posture = legPosture(def);
  const bolt = c.purpose === "cover" || c.phase === "cover";
  m.waypoints = routeWaypoints(leg, { x: 0, y: 0, mode: "walk" }).map((w) => ({ ...w, posture, ...(bolt ? { bolt: true as const } : {}) }));
  m.formation = null; m.endPosture = null; m.endHeading = null;
}

/** Route the leader on to the destination; false if there is no way. */
function routeOn(ctx: SimContext, state: SimState, c: Carry, lead: EntityId, def: CarryMethodDef): boolean {
  const t = state.transform.req(lead);
  const leg = routeBetween(ctx, navFor(ctx, "foot").search, t.x, t.y, c.dest.x, c.dest.y, { maxExpansions: 8000, snapCells: 3 }, { sz: t.z, gz: c.dest.z });
  if (!leg) return false;
  setLeg(state, c, lead, leg, def);
  return true;
}

/** Is the party under fire (a carrier, or the walking wounded man himself, pinned or suppressed)? */
function partyUnderFire(ctx: SimContext, state: SimState, c: Carry, payload: EntityId): boolean {
  const H = carryParams(ctx).holdSuppression;
  const men = c.carriers.length > 0 ? c.carriers : [payload];
  for (const m of men) {
    const s = state.soldier.get(m);
    if (s && (s.mental.suppression >= H || isCowering(s))) return true;
  }
  return false;
}

/** The point `d` metres back along the trail (newest first), and the heading toward the leader there. */
function along(trail: readonly number[], d: number): { x: number; y: number; z: number; h: number } {
  let left = d;
  for (let i = 0; i + 5 < trail.length; i += 3) {
    const ax = trail[i]!, ay = trail[i + 1]!, az = trail[i + 2]!, bx = trail[i + 3]!, by = trail[i + 4]!, bz = trail[i + 5]!;
    const L = hypot2(bx - ax, by - ay);
    if (L >= left && L > 1e-9) {
      const k = left / L;
      return { x: ax + (bx - ax) * k, y: ay + (by - ay) * k, z: az + (bz - az) * k, h: atan2(ay - by, ax - bx) };
    }
    left -= L;
  }
  const n = trail.length;
  const h = n >= 6 ? atan2(trail[n - 5]! - trail[n - 2]!, trail[n - 6]! - trail[n - 3]!) : 0;
  return { x: trail[n - 3]!, y: trail[n - 2]!, z: trail[n - 1]!, h };
}

/** The party sets off: a trail from the leader back to the casualty (the others take their places on it). */
function setOff(state: SimState, c: Carry, payload: EntityId): void {
  const lt = state.transform.req(carryLeader(c, payload)), pt = state.transform.req(payload);
  c.trail = c.carriers.length > 0 ? [lt.x, lt.y, lt.z, pt.x, pt.y, pt.z] : [lt.x, lt.y, lt.z];
  c.phase = "move"; c.phaseTick = state.tick;
}

/** The leader's new position on the trail; the payload and the other carriers to their places behind him. */
function follow(ctx: SimContext, state: SimState, c: Carry, payload: EntityId, def: CarryMethodDef): void {
  const lead = carryLeader(c, payload), lt = state.transform.req(lead);
  const tr = c.trail;
  if (tr.length >= 3) {
    const d = hypot2(lt.x - tr[0]!, lt.y - tr[1]!) + Math.abs(lt.z - tr[2]!);
    if (d >= TRAIL_STEP_M) {
      tr.unshift(lt.x, lt.y, lt.z);
      c.sinceRestM += d; c.totalM += d;
    }
  } else tr.push(lt.x, lt.y, lt.z);
  if (c.carriers.length === 0) return; // a walking wounded man: nobody follows
  const lay = carryLayout(def);
  const need = Math.max(lay.payloadM, ...lay.followersM, 0) + 1;
  // Trim the trail to what the party needs (and the point the leader is at).
  let len = 0;
  for (let i = 0; i + 5 < tr.length; i += 3) {
    len += hypot2(tr[i + 3]! - tr[i]!, tr[i + 4]! - tr[i + 1]!);
    if (len > need) { tr.length = i + 6; break; }
  }
  // The leader's current point heads the trail for placing (he may be part way to the next trail point).
  const pts = [lt.x, lt.y, lt.z, ...tr];
  const lm = state.mover.get(lead);
  const holding = c.phase === "hold";
  const posture: Posture = holding ? "prone" : legPosture(def);
  const place = (id: EntityId, dM: number, isPayload: boolean) => {
    const p = dM <= 0 ? { x: lt.x, y: lt.y, z: lt.z, h: lt.heading } : along(pts, dM);
    const t = state.transform.get(id);
    if (!t) return;
    t.x = p.x; t.y = p.y; t.z = p.z; t.heading = dM <= 0 ? lt.heading : p.h;
    const m = state.mover.get(id);
    if (m) {
      if (m.waypoints.length > 0) m.waypoints = [];
      m.formation = null;
      m.mode = lm?.mode ?? null; m.speedMps = lm?.speedMps ?? 0;
    }
    const s = state.soldier.get(id);
    if (!s) return;
    // Carriers keep the party's posture; a supported man walks with his carrier.
    if ((!isPayload || def.casualtyWalks === true) && s.posture !== posture && s.postureTo === null && isConscious(s)) requestPosture(ctx, state, id, posture);
  };
  place(payload, lay.payloadM, true);
  for (let i = 1; i < c.carriers.length; i++) place(c.carriers[i]!, lay.followersM[i - 1] ?? 0.5, false);
  if (holding && state.soldier.get(lead)?.posture !== "prone" && state.soldier.get(lead)?.postureTo === null) requestPosture(ctx, state, lead, "prone");
}

/** One tick of one party. */
function stepParty(ctx: SimContext, state: SimState, events: EventSink, payload: EntityId, c: Carry): void {
  const M = ctx.catalog.medical, P = carryParams(ctx);
  const ps = state.soldier.get(payload);
  if (!state.transform.has(payload)) { endCarry(ctx, state, events, payload, "gone"); return; }
  if (ps && !ps.physiology.alive && !(c.purpose === "cover" && downUnknown(ctx.catalog, ps))) {
    // (Carrying him, they feel he has died: he is known dead, owner request 2026-11-15.)
    if (ctx.catalog.medical?.down !== undefined && c.carriers.length > 0 && ps.checked?.dead !== true) ps.checked = { tick: state.tick, by: c.carriers[0]!, dead: true };
    endCarry(ctx, state, events, payload, "dead"); return;
  }
  // (M11.9: a prisoner held by a unit's men is carried to its nest like its own wounded.)
  if (ps && (isMounted(ps) || (ps.captive !== null && (ps.captive.unit === undefined || c.point === undefined)))) { endCarry(ctx, state, events, payload, "gone"); return; }
  if (c.untilTick !== undefined && state.tick > c.untilTick) { endCarry(ctx, state, events, payload, "gave-up"); return; }
  let def = carryMethodDef(ctx, c.method);
  if (!def) { endCarry(ctx, state, events, payload, "gone"); return; }
  // (M11.4a: bearers with a crate who lose a man put it down; their errand carries on with whoever is left.)
  if (c.cargo === true && c.carriers.some((m) => state.soldier.get(m)?.carrying !== payload || !canCarry(state.soldier.get(m)))) {
    endCarry(ctx, state, events, payload, "carriers-lost"); return;
  }
  // A walking wounded man knocked down for a moment (a hit, a blast) waits until he is up again (M10.5).
  if (c.carriers.length === 0 && ps?.carrying === payload && state.tick < ps.stunnedUntilTick && isConscious(ps) && ps.impair.canWalk && ps.captive === null) return;
  // A walking wounded man who can no longer walk, or was ordered elsewhere.
  if (c.carriers.length === 0 && (!walksSelf(state, payload) || ps?.carrying !== payload)) { endCarry(ctx, state, events, payload, ps?.carrying !== payload ? "ordered" : "carriers-lost"); return; }
  // Carriers lost (hit, panicking, aboard, ordered away): the rest carry on with a method for fewer men.
  if (c.carriers.some((m) => state.soldier.get(m)?.carrying !== payload || !canCarry(state.soldier.get(m)))) {
    const keep = c.carriers.filter((m) => state.soldier.get(m)?.carrying === payload && canCarry(state.soldier.get(m)));
    for (const m of c.carriers) if (!keep.includes(m)) leaveCarry(state, m);
    const litter = itemWithTag(ctx, state, keep, "litter");
    const walks = ps !== undefined && walksSelf(state, payload);
    const method = keep.length > 0 ? chooseCarryMethod(ctx.catalog, keep.length, walks && def.casualtyWalks === true, ps?.impair.move ?? 1, c.phase === "hold" || c.phase === "cover" || c.purpose === "cover", litter !== null) : null;
    const nd = method !== null ? M?.carry[method] : undefined;
    if (method === null || !nd || nd.carriers === 0) { c.carriers = keep; endCarry(ctx, state, events, payload, "carriers-lost"); return; }
    const use = keep.slice(0, nd.carriers);
    for (const m of keep) if (!use.includes(m)) leaveCarry(state, m);
    const oldLead = c.carriers[0];
    c.carriers = use; c.method = method; def = nd;
    c.speedMps = carrySpeedMps(ctx, nd, c.massKg);
    if (nd.needsTag !== undefined && litter) c.litter = litter; else delete c.litter;
    // A new leader picks the way up from where he stands.
    if (use[0] !== oldLead && (c.phase === "move" || c.phase === "cover")) {
      const nt = state.transform.req(use[0]!);
      c.trail = [nt.x, nt.y, nt.z, ...c.trail];
      if (c.phase === "cover") { c.phase = "hold"; c.phaseTick = state.tick; }
    }
  }
  const lead = carryLeader(c, payload);
  const lm = state.mover.get(lead);
  const second = (state.tick + payload) % 60 === 0;
  switch (c.phase) {
    case "gather": {
      const pt = state.transform.req(payload), r = P.reachM;
      let all = true;
      for (const m of c.carriers) {
        const t = state.transform.req(m);
        if (hypot2(t.x - pt.x, t.y - pt.y) <= r + 0.3 && Math.abs(t.z - pt.z) <= 1.5) continue;
        all = false;
        if (!second) continue;
        const mm = state.mover.get(m), last = mm?.waypoints[mm.waypoints.length - 1];
        if (!mm || (last && hypot2(last.x - pt.x, last.y - pt.y) <= r)) continue;
        const dx = t.x - pt.x, dy = t.y - pt.y, L = hypot2(dx, dy) || 1;
        const gx = pt.x + (dx / L) * r * 0.6, gy = pt.y + (dy / L) * r * 0.6;
        const leg = routeBetween(ctx, navFor(ctx, "foot").search, t.x, t.y, gx, gy, { maxExpansions: 20000, snapCells: 3 }, { sz: t.z, gz: pt.z });
        if (!leg) { endCarry(ctx, state, events, payload, "no-way"); return; }
        mm.waypoints = routeWaypoints(leg, { x: 0, y: 0, mode: "run" });
        mm.formation = null; mm.endPosture = null; mm.endHeading = null;
      }
      if (!all) {
        if (state.tick - c.phaseTick > secondsToTicks(GATHER_TIMEOUT_S)) endCarry(ctx, state, events, payload, "gave-up");
        return;
      }
      for (const m of c.carriers) { const mm = state.mover.get(m); if (mm && mm.waypoints.length > 0) { mm.waypoints = []; mm.speedMps = 0; } }
      if (def.setupS > 0) { c.phase = "setup"; c.phaseTick = state.tick; return; }
      setOff(state, c, payload);
      break;
    }
    case "setup":
      if (state.tick - c.phaseTick < secondsToTicks(def.setupS)) return;
      setOff(state, c, payload);
      break;
    case "rest":
      if (state.tick - c.phaseTick >= secondsToTicks(def.restS)) {
        c.phase = "move"; c.phaseTick = state.tick;
        events.emit({ kind: "medical.carried", tick: state.tick, payload, by: lead, method: c.method, carriers: c.carriers.length, phase: "resume", distanceM: Math.round(c.totalM) });
      }
      break;
    case "hold":
      if (lm && lm.waypoints.length > 0) { lm.waypoints = []; lm.speedMps = 0; }
      if (second && partyUnderFire(ctx, state, c, payload)) c.fireTick = state.tick;
      if (state.tick - (c.fireTick ?? c.phaseTick) >= secondsToTicks(P.resumeQuietS)) {
        c.phase = "move"; c.phaseTick = state.tick;
        events.emit({ kind: "medical.carried", tick: state.tick, payload, by: lead, method: c.method, carriers: c.carriers.length, phase: "resume", distanceM: Math.round(c.totalM) });
      }
      break;
    case "cover":
      if (!lm || lm.waypoints.length === 0) { c.phase = "hold"; c.phaseTick = state.tick; c.fireTick = state.tick; }
      break;
    case "move":
      break;
  }
  if (c.phase === "move") {
    // Fired on: take cover with him (not on a drag to cover: that is what it is).
    if (c.purpose === "move" && second && partyUnderFire(ctx, state, c, payload)) {
      c.fireTick = state.tick;
      const threat = casualtyThreat(state, lead, payload), pt = state.transform.req(payload);
      const lie = ctx.catalog.body.postures.prone.heightM * 0.6;
      const spot = threat && !coveredFrom(ctx, pt.x, pt.y, threat.x, threat.y, lie, pt.z, threat.z) ? coverSpotNear(ctx, pt.x, pt.y, pt.z, threat, M?.care.dragSearchM ?? 15, M?.care.dragMaxM ?? 30) : null;
      c.phaseTick = state.tick;
      if (spot) { c.phase = "cover"; setLeg(state, c, lead, spot.leg, def); }
      else { c.phase = "hold"; if (lm) { lm.waypoints = []; lm.speedMps = 0; } }
      events.emit({ kind: "medical.carried", tick: state.tick, payload, by: lead, method: c.method, carriers: c.carriers.length, phase: "hold", distanceM: Math.round(c.totalM) });
    } else if (c.purpose === "move" && c.sinceRestM >= def.enduranceM && def.restS > 0) {
      c.phase = "rest"; c.phaseTick = state.tick; c.sinceRestM = 0;
      if (lm) { lm.waypoints = []; lm.speedMps = 0; }
      events.emit({ kind: "medical.carried", tick: state.tick, payload, by: lead, method: c.method, carriers: c.carriers.length, phase: "rest", distanceM: Math.round(c.totalM) });
    } else if (lm && lm.waypoints.length === 0) {
      const t = state.transform.req(lead);
      if (hypot2(t.x - c.dest.x, t.y - c.dest.y) <= 1.5 && Math.abs(t.z - c.dest.z) <= 1) {
        follow(ctx, state, c, payload, def);
        endCarry(ctx, state, events, payload, "arrived");
        return;
      }
      if (!routeOn(ctx, state, c, lead, def)) { endCarry(ctx, state, events, payload, "no-way"); return; }
    }
  }
  if (c.trail.length > 0) follow(ctx, state, c, payload, def);
}

/** Every tick, after movement: each party's phase, the leader's way, everyone else on his trail. */
export function carrySystem(ctx: SimContext, state: SimState, events: EventSink): void {
  if (state.carry.size === 0) return;
  const ids: EntityId[] = [];
  for (const [p] of state.carry.entries()) ids.push(p);
  for (const p of ids) {
    const c = state.carry.get(p);
    if (c) stepParty(ctx, state, events, p, c);
  }
}

/** Is he being carried (or walking in a party of his own)? */
export function isCarried(state: SimState, id: EntityId): boolean {
  return state.carry.has(id);
}
