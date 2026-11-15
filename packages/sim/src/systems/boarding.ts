/**
 * GETTING IN AND OUT OF VEHICLES (M7.2, plan §6; owner answers Q12, Q13 default, Q24, Q25).
 *
 *   mount      The men on foot of a unit walk (run) to the nearest exit of their vehicle. Within reach of it, and
 *              with the vehicle halted, they get in one at a time per exit (the ramp opens once first), lowest ID
 *              first. A wounded man who cannot walk and lies within a few metres of an exit is carried in by two
 *              comrades (Q25); wounded men farther away stay where they are. Boarding is complete when every able
 *              man and every such casualty is in, or a while after the first man got in.
 *   dismount   The vehicle holds; once it has stopped the ramp opens and the passengers get out one at a time per
 *              exit, landing a few metres behind it, crouching, facing away from the hull. Wounded men stay
 *              aboard, unless the order says `wounded`: then two of the unit's men carry each casualty out through
 *              an exit and lay him down behind it (M10.4b). An order given to a squad aboard is carried out once it
 *              is out (`then`, Q12).
 *   seat swap  A crewman takes over the seat of a fallen driver or station operator after `seatSwapSeconds` (Q13,
 *              recommended option, decided without the owner); the casualty stays aboard in the seat he left. A
 *              station worked from the commander's seat (GTK Boxer) may be taken over by a passenger (M7.6c review).
 *
 * Casualties (M10.4b, SPEC 9.1): a unit getting in fetches its wounded who cannot walk from up to
 * `vehicleLoading.fetchM` away: a carrying party (systems/carry.ts) takes each to the nearest exit, then two men load
 * him. Aboard, a casualty sits or lies (`liesAboard`: unconscious or in shock); places are the vehicle's passenger
 * seats, a man lying taking `vehicleLoading.lyingSeats` of them, or an ambulance's own layouts (`placesFit`).
 *
 * Boarding is state on the unit (`Unit.boarding`), not a drill; a new order replaces it (`clearDrills`). The
 * seats and `SoldierState.mount` are written only here and by the battle setup. Values: core/behaviour.json
 * `mounting`, core/medical.json `vehicleLoading` and the vehicle's `ramp` and `ambulance` blocks.
 */
import { isOffMap } from "../offmap";
import { registerActionHandler, startAction } from "../actions";
import type { VehicleDef } from "../catalog";
import type { Boarding, SoldierState, Unit, VehicleState } from "../components";
import type { SimContext } from "../context";
import { routeBetween, routeWaypoints } from "../interior-nav";
import type { EventSink } from "../events";
import { secondsToTicks, type EntityId } from "../ids";
import { transferItems } from "../items";
import { isAble, isCaptive, isConscious } from "../impair";
import { atan2, cos, hypot2, PI, sin } from "../math";
import { nearestPassable } from "../nav";
import { navFor } from "../navctx";
import type { Order, OrderBody } from "../orders";
import { seatWorld } from "../setup";
import type { SimState } from "../state";
import type { OrderResult } from "./drive";
import { applyOrderNow, radioFromTarget } from "./orders";
import { startCarry } from "./carry";

const HALTED_MPS = 0.3;

/** Able, walking, not running away: a man who can get in on his own. */
function walker(s: SoldierState | undefined): boolean {
  return isAble(s) && s!.impair.canWalk && s!.mental.behaviour !== "routed";
}

/** Alive, not a prisoner, but cannot walk: a man who must be carried in (Q25). */
function carriable(s: SoldierState | undefined): boolean {
  return s !== undefined && s.physiology.alive && !isCaptive(s) && s.evacuated === undefined && !walker(s) && s.mental.behaviour !== "routed";
}

/** Where exit `k` of a vehicle is in the world. */
export function exitWorld(def: VehicleDef, k: number, x: number, y: number, h: number): { x: number; y: number } {
  const e = def.ramp.exits[k]!;
  const c = cos(h), s = sin(h);
  return { x: x + c * e[0] - s * e[1], y: y + s * e[0] + c * e[1] };
}

/** Index of the exit nearest to (px, py), and how far it is. */
function nearestExit(def: VehicleDef, x: number, y: number, h: number, px: number, py: number): { k: number; d: number; x: number; y: number } {
  let best = { k: 0, d: Infinity, x, y };
  for (let k = 0; k < def.ramp.exits.length; k++) {
    const p = exitWorld(def, k, x, y, h);
    const d = hypot2(p.x - px, p.y - py);
    if (d < best.d) best = { k, d, x: p.x, y: p.y };
  }
  return best;
}

/** Stopped (and not about to drive off). */
function halted(v: VehicleState): boolean {
  const d = v.drive;
  return Math.abs(d.speed) < HALTED_MPS && (d.arrived || d.holdForDismount || d.routeIdx >= d.route.length);
}

/** Can men get in or out of it at all: not wrecked, not burning. */
function usable(v: VehicleState | undefined): v is VehicleState {
  return v !== undefined && v.status !== "destroyed" && v.status !== "abandoned" && v.fire === null;
}

// ---------------------------------------------------------------- places (M10.4b)

/** Vehicle loading values (core/medical.json `vehicleLoading`); without them nobody is fetched and lying takes a seat. */
export function loadingParams(ctx: SimContext): { fetchM: number; lyingSeats: number; lyingShock: number } {
  return ctx.catalog.medical?.vehicleLoading ?? { fetchM: 0, lyingSeats: 1, lyingShock: 2 };
}

/** Does this casualty travel lying down (unconscious, or in shock at `lyingShock`)? Everyone else sits. */
export function liesAboard(ctx: SimContext, s: SoldierState): boolean {
  return !isConscious(s) || s.physiology.shock >= loadingParams(ctx).lyingShock;
}

/** The men in a vehicle's passenger seats: lying and sitting (the dead included: they take their places). */
export function placesUsed(state: SimState, v: VehicleState, def: VehicleDef): { lying: number; sitting: number } {
  let lying = 0, sitting = 0;
  for (let i = 0; i < def.seats.length; i++) {
    const o = v.seats[i];
    if (o === null || o === undefined || def.seats[i]!.station !== "passenger") continue;
    if (state.soldier.get(o)?.mount?.lying) lying++; else sitting++;
  }
  return { lying, sitting };
}

/**
 * Can the vehicle hold `lying` men lying and `sitting` men sitting in its passenger places? An ambulance: one of its
 * layouts holds them (lying places inside or outside on the hull); any other vehicle: a man lying takes
 * `lyingSeats` passenger seats. Never more men than passenger seats (each man has a seat index).
 */
export function placesFit(ctx: SimContext, def: VehicleDef, lying: number, sitting: number): boolean {
  let seats = 0;
  for (const q of def.seats) if (q.station === "passenger") seats++;
  if (lying + sitting > seats) return false;
  const amb = def.ambulance;
  if (amb) return amb.layouts.some((l) => lying <= l.lying + l.lyingOutside && sitting <= l.sitting);
  return lying * loadingParams(ctx).lyingSeats + sitting <= seats;
}

/** Room for `more` men sitting on top of those aboard (and a free seat for each). */
function roomFor(ctx: SimContext, state: SimState, v: VehicleState, def: VehicleDef, moreLying: number, moreSitting: number): boolean {
  const u = placesUsed(state, v, def);
  return placesFit(ctx, def, u.lying + moreLying, u.sitting + moreSitting);
}

/** Men already on their way into this vehicle (other units' mount queues). */
function reserved(state: SimState, vid: EntityId, except: EntityId): number {
  let n = 0;
  for (const [uid, u] of state.unit.entries()) {
    const b = u.boarding;
    if (uid === except || !b || b.kind !== "mount" || b.vehicle !== vid) continue;
    n += b.queue.length;
  }
  return n;
}

function halt(state: SimState, id: EntityId): void {
  const m = state.mover.get(id);
  if (m) { m.waypoints = []; m.speedMps = 0; m.formation = null; m.endPosture = null; m.endHeading = null; }
}

/**
 * Send a man along a foot path to (x, y) at a run, standing at the end; `gz`: the goal's height above the ground
 * (a casualty upstairs, M7.5 review fix; a vehicle's exit is on the ground).
 */
function runTo(ctx: SimContext, state: SimState, id: EntityId, x: number, y: number, gz = 0): boolean {
  const t = state.transform.req(id), m = state.mover.get(id);
  if (!m) return false;
  const gx = Math.min(Math.max(x, 1), ctx.map.widthM - 1), gy = Math.min(Math.max(y, 1), ctx.map.heightM - 1);
  const leg = routeBetween(ctx, navFor(ctx, "foot").search, t.x, t.y, gx, gy, { maxExpansions: 8000, snapCells: 3 }, { sz: t.z, gz });
  if (!leg) return false;
  m.waypoints = routeWaypoints(leg, { x: 0, y: 0, mode: "run" });
  m.formation = null; m.endPosture = null; m.endHeading = null;
  return true;
}

/** Put a man in a seat (from outside). */
function seatIn(state: SimState, def: VehicleDef, vid: EntityId, seat: number, sid: EntityId, events: EventSink): void {
  const v = state.vehicle.req(vid), t = state.transform.req(vid), mt = state.transform.req(sid), s = state.soldier.req(sid);
  v.seats[seat] = sid;
  s.mount = { vehicle: vid, seat };
  const [x, y, z] = seatWorld(def, seat, t.x, t.y, t.heading);
  mt.x = x; mt.y = y; mt.z = z; mt.heading = t.heading;
  halt(state, sid);
  state.fire.delete(sid);
  s.evade = null;
  s.intent = null;
  s.postureTo = null;
  events.emit({ kind: "soldier.mounted", tick: state.tick, soldier: sid, vehicle: vid, seat });
}

function firstFreePassengerSeat(v: VehicleState, def: VehicleDef): number {
  return def.seats.findIndex((q, i) => q.station === "passenger" && v.seats[i] === null);
}

/**
 * Put a casualty into a free passenger place of vehicle `vid` (M10.6a: an ambulance's crew lifts him in), lying or
 * sitting as `liesAboard` says. False if no place fits him.
 */
export function seatCasualty(ctx: SimContext, state: SimState, vid: EntityId, c: EntityId, events: EventSink): boolean {
  const v = state.vehicle.req(vid), def = ctx.catalog.vehicles[v.def];
  const s = state.soldier.get(c);
  if (!def || !s || s.mount !== undefined) return false;
  const lies = liesAboard(ctx, s);
  const seat = firstFreePassengerSeat(v, def);
  if (seat < 0 || !roomFor(ctx, state, v, def, lies ? 1 : 0, lies ? 0 : 1)) return false;
  state.action.delete(c);
  seatIn(state, def, vid, seat, c, events);
  if (lies) s.mount!.lying = true;
  return true;
}

// ---------------------------------------------------------------- actions

/** Getting in through an exit. params: { vehicle, exit } */
registerActionHandler("mount", {
  check(ctx, state, actor, a) {
    const v = state.vehicle.get(Number(a.params["vehicle"])), s = state.soldier.get(actor);
    if (!usable(v)) return "no-vehicle";
    if (!walker(s) || s!.mount !== undefined) return "unable";
    if (!halted(v)) return "moving";
    const def = ctx.catalog.vehicles[v.def];
    if (!def || firstFreePassengerSeat(v, def) < 0 || !roomFor(ctx, state, v, def, 0, 1)) return "no-seat";
    return null;
  },
  complete(ctx, state, actor, a, events) {
    const vid = Number(a.params["vehicle"]), v = state.vehicle.req(vid), def = ctx.catalog.vehicles[v.def]!;
    const seat = firstFreePassengerSeat(v, def);
    if (seat >= 0) seatIn(state, def, vid, seat, actor, events);
  },
});

/** Getting out through an exit. params: { vehicle, exit } */
registerActionHandler("dismount", {
  check(_ctx, state, actor, a) {
    const v = state.vehicle.get(Number(a.params["vehicle"])), s = state.soldier.get(actor);
    if (!v || v.status === "destroyed") return "no-vehicle";
    if (!walker(s) || s!.mount?.vehicle !== Number(a.params["vehicle"])) return "unable";
    if (Math.abs(v.drive.speed) >= HALTED_MPS) return "moving";
    return null;
  },
  complete(ctx, state, actor, a, events) {
    getOut(ctx, state, actor, Number(a.params["vehicle"]), Number(a.params["exit"]), events);
  },
});

/**
 * A man aboard leaves his seat through exit `exit` and lands outside (dismount, M7.2; bailing out, M7.4a).
 */
export function getOut(ctx: SimContext, state: SimState, actor: EntityId, vid: EntityId, exit: number, events: EventSink, laidDown = false): void {
  {
    const v = state.vehicle.req(vid), def = ctx.catalog.vehicles[v.def]!;
    const s = state.soldier.req(actor), seat = s.mount!.seat;
    v.seats[seat] = null;
    delete s.mount;
    // He lands in a fan behind the exit (each seat its own spot), on ground a man can stand on.
    const M = ctx.catalog.behaviour.mounting, t = state.transform.req(vid);
    const e = exitWorld(def, exit, t.x, t.y, t.heading);
    const ex = def.ramp.exits[exit]!;
    // Out of the exit: backwards for a rear exit, sideways for a side door.
    const outA = t.heading + atan2(ex[1], ex[0]);
    const n = Math.max(1, def.seats.length);
    const spread = ((seat % 3) - 1) * (PI / 4) + (seat / n - 0.5) * 0.3;
    // (A casualty carried out is laid down close behind the exit, about half the nearest landing distance.)
    const dist = laidDown ? M.exitFanMinM * 0.5 : M.exitFanMinM + ((seat * 7) % 5) / 4 * (M.exitFanMaxM - M.exitFanMinM);
    let px = e.x + cos(outA + spread) * dist, py = e.y + sin(outA + spread) * dist;
    px = Math.min(Math.max(px, 1), ctx.map.widthM - 1); py = Math.min(Math.max(py, 1), ctx.map.heightM - 1);
    const grid = navFor(ctx, "foot").grid;
    const cell = nearestPassable(grid, px, py, 6);
    if (cell >= 0) { px = ((cell % grid.cols) + 0.5) * grid.cellM; py = (Math.floor(cell / grid.cols) + 0.5) * grid.cellM; }
    const mt = state.transform.req(actor);
    mt.x = px; mt.y = py; mt.z = 0; mt.heading = t.heading + PI;
    // A casualty carried out (M10.4b) is laid down; a man getting out crouches.
    const posture = laidDown ? "prone" : "crouching";
    s.posture = posture; s.postureTo = null;
    halt(state, actor);
    events.emit({ kind: "soldier.dismounted", tick: state.tick, soldier: actor, vehicle: vid, seat });
    events.emit({ kind: "posture.changed", tick: state.tick, soldier: actor, posture });
  }
}

/**
 * Two men carry a wounded comrade in (Q25). The lead holds the action that seats him; the helper holds an action
 * of the same kind (`role` helper) so neither does anything else meanwhile. params: { vehicle, casualty, other, role }
 */
registerActionHandler("loadCasualty", {
  check(ctx, state, actor, a) {
    const vid = Number(a.params["vehicle"]), v = state.vehicle.get(vid);
    const c = Number(a.params["casualty"]), other = Number(a.params["other"]);
    if (!usable(v)) return "no-vehicle";
    if (!walker(state.soldier.get(actor)) || !walker(state.soldier.get(other))) return "unable";
    const cs = state.soldier.get(c);
    if (!carriable(cs) || cs!.mount !== undefined) return "no-casualty";
    if (!halted(v)) return "moving";
    const def = ctx.catalog.vehicles[v.def];
    const lies = liesAboard(ctx, cs!);
    if (!def || firstFreePassengerSeat(v, def) < 0 || !roomFor(ctx, state, v, def, lies ? 1 : 0, lies ? 0 : 1)) return "no-seat";
    const ta = state.transform.req(actor), tc = state.transform.req(c);
    if (hypot2(ta.x - tc.x, ta.y - tc.y) > 3) return "out-of-reach";
    return null;
  },
  complete(ctx, state, actor, a, events) {
    if (a.params["role"] !== "lead") return;
    const vid = Number(a.params["vehicle"]), v = state.vehicle.req(vid), def = ctx.catalog.vehicles[v.def]!;
    const seat = firstFreePassengerSeat(v, def), c = Number(a.params["casualty"]);
    if (seat < 0) return;
    const lies = liesAboard(ctx, state.soldier.req(c));
    seatIn(state, def, vid, seat, c, events);
    if (lies) state.soldier.req(c).mount!.lying = true;
  },
});

/**
 * Two men carry a casualty out of a halted vehicle through an exit and lay him down behind it (M10.4b; a dismount
 * order with `wounded`). As loading: the lead's action does it, the helper's keeps him busy meanwhile.
 * params: { vehicle, casualty, other, role, exit }
 */
registerActionHandler("unloadCasualty", {
  check(ctx, state, actor, a) {
    const vid = Number(a.params["vehicle"]), v = state.vehicle.get(vid);
    const c = Number(a.params["casualty"]), other = Number(a.params["other"]);
    if (!v || v.status === "destroyed" || v.fire !== null) return "no-vehicle";
    const sa = state.soldier.get(actor), so = state.soldier.get(other);
    if (!walker(sa) || !walker(so) || sa!.mount !== undefined || so!.mount !== undefined) return "unable";
    if (state.soldier.get(c)?.mount?.vehicle !== vid) return "no-casualty";
    if (Math.abs(v.drive.speed) >= HALTED_MPS) return "moving";
    const def = ctx.catalog.vehicles[v.def];
    if (!def) return "no-vehicle";
    const t = state.transform.req(vid), ta = state.transform.req(actor);
    if (nearestExit(def, t.x, t.y, t.heading, ta.x, ta.y).d > ctx.catalog.behaviour.mounting.boardReachM + 0.5) return "out-of-reach";
    return null;
  },
  complete(ctx, state, actor, a, events) {
    if (a.params["role"] !== "lead") return;
    const vid = Number(a.params["vehicle"]), c = Number(a.params["casualty"]);
    if (state.soldier.get(c)?.mount?.vehicle !== vid) return;
    getOut(ctx, state, c, vid, Number(a.params["exit"]), events, true);
  },
});

/** A crewman moves into the seat of a fallen one (Q13). params: { vehicle, seat } */
registerActionHandler("seatSwap", {
  check(_ctx, state, actor, a) {
    const vid = Number(a.params["vehicle"]), v = state.vehicle.get(vid), s = state.soldier.get(actor);
    if (!v || v.status === "destroyed" || v.status === "abandoned") return "no-vehicle";
    if (!isAble(s) || s!.mount?.vehicle !== vid) return "unable";
    const o = v.seats[Number(a.params["seat"])];
    if (o !== null && o !== undefined && isAble(state.soldier.get(o))) return "filled";
    return null;
  },
  complete(_ctx, state, actor, a, events) {
    const vid = Number(a.params["vehicle"]), v = state.vehicle.req(vid), seat = Number(a.params["seat"]);
    const s = state.soldier.req(actor), from = s.mount!.seat;
    const casualty = v.seats[seat] ?? null;
    // The casualty (if any) is moved into the seat the crewman left: he stays aboard (rule 10).
    v.seats[seat] = actor; s.mount = { vehicle: vid, seat };
    v.seats[from] = casualty;
    if (casualty !== null) state.soldier.req(casualty).mount = { vehicle: vid, seat: from };
    v.seatSwap = null;
    events.emit({ kind: "vehicle.seatSwap", tick: state.tick, vehicle: vid, seat, soldier: actor, casualty: casualty ?? -1 });
  },
});

/**
 * A man takes ammunition from a halted own vehicle (plan §6 "resupply from the vehicle", M7.2): standing within
 * reach of an exit, through the one generic transfer (rule 9). params: { from, item, count }
 */
registerActionHandler("takeFromVehicle", {
  check(ctx, state, actor, a) {
    const vid = Number(a.params["from"]), v = state.vehicle.get(vid);
    const def = v ? ctx.catalog.vehicles[v.def] : undefined;
    if (!v || !def || v.status === "destroyed" || v.fire !== null) return "no-vehicle";
    if (!walker(state.soldier.get(actor)) || state.soldier.get(actor)!.mount !== undefined) return "unable";
    if (!halted(v)) return "moving";
    const t = state.transform.req(vid), mt = state.transform.req(actor);
    if (nearestExit(def, t.x, t.y, t.heading, mt.x, mt.y).d > ctx.catalog.behaviour.mounting.resupplyReachM + 0.5) return "out-of-reach";
    return null;
  },
  complete(ctx, state, actor, a, events) {
    const from = Number(a.params["from"]), item = String(a.params["item"]);
    // Full ones first: the fullest stacks of that item.
    const c = state.container.get(from);
    let left = Number(a.params["count"]), moved = 0;
    while (c && left > 0) {
      const best = c.stacks.filter((s) => s.type === item && (s.charge ?? 1) > 0).reduce((m, s) => Math.max(m, s.charge ?? 0), -1);
      if (best < 0) break;
      const r = transferItems(ctx.catalog, state.container, { from, to: actor, type: item, count: 1, ...(best > 0 ? { charge: best } : {}) });
      if (r.moved === 0) break;
      moved += r.moved; left -= r.moved;
    }
    if (moved > 0) {
      events.emit({ kind: "items.transferred", tick: state.tick, from, to: actor, item, count: moved });
      const w = state.weapon.get(actor);
      if (w) { w.lowAmmoReported = false; w.lowAmmoRadioed = false; }
    }
  },
});

/**
 * A halted own vehicle (his unit's carrier first, else the nearest) within reach that carries this item: where
 * a man out of spare goes for more (M7.2). M7.4b: an own hull abandoned by its crew counts too (cross-loading:
 * he takes what fits his weapon); the owner's review (2026-11-13): never an enemy hull. null when there is none.
 */
export function vehicleSource(ctx: SimContext, state: SimState, id: EntityId, item: string): EntityId | null {
  if (state.vehicle.size === 0) return null;
  const ident = state.identity.get(id), me = state.transform.get(id);
  if (!ident || !me) return null;
  const M = ctx.catalog.behaviour.mounting;
  const ok = (vid: EntityId): number => {
    const v = state.vehicle.get(vid);
    const def = v ? ctx.catalog.vehicles[v.def] : undefined;
    if (!v || !def || v.status === "destroyed" || v.fire !== null || !halted(v)) return Infinity;
    if (v.side !== ident.side) return Infinity; // own side only, abandoned or not (owner, 2026-11-13)
    const c = state.container.get(vid);
    if (!c || !c.stacks.some((s) => s.type === item && (s.charge ?? 1) > 0 && s.count > 0)) return Infinity;
    const t = state.transform.req(vid);
    const d = nearestExit(def, t.x, t.y, t.heading, me.x, me.y).d;
    return d <= M.resupplyRangeM ? d : Infinity;
  };
  const own = carrierOf(state, ident.unit);
  if (own !== undefined && ok(own) < Infinity) return own;
  let best: EntityId | null = null, bestD = Infinity;
  for (const [vid, v] of state.vehicle.entries()) { if (isOffMap(v)) continue; const d = ok(vid); if (d < bestD) { bestD = d; best = vid; } }
  return best;
}

/** The man going for ammunition: walk to the nearest exit, then take it. False when he gives up. */
export function stepFetchAmmo(ctx: SimContext, state: SimState, events: EventSink, id: EntityId, vid: EntityId, item: string, sinceTick: number): boolean {
  const M = ctx.catalog.behaviour.mounting;
  const v = state.vehicle.get(vid);
  const def = v ? ctx.catalog.vehicles[v.def] : undefined;
  if (!v || !def || !halted(v) || state.tick - sinceTick > secondsToTicks(60)) return false;
  if (state.action.has(id)) return true;
  const t = state.transform.req(vid), mt = state.transform.req(id);
  const ex = nearestExit(def, t.x, t.y, t.heading, mt.x, mt.y);
  if (ex.d <= M.resupplyReachM) {
    halt(state, id);
    startAction(state, events, id, "takeFromVehicle", secondsToTicks(ctx.catalog.behaviour.decisions.passSeconds), { from: vid, item, count: M.resupplyCount });
    return false;
  }
  const w = state.mover.get(id)?.waypoints;
  const goal = w && w.length > 0 ? w[w.length - 1]! : null;
  if (!goal || hypot2(goal.x - ex.x, goal.y - ex.y) > 2) return runTo(ctx, state, id, ex.x, ex.y);
  return true;
}

// ---------------------------------------------------------------- orders

/** Foot units of a subtree (units that do not crew a vehicle), the unit itself first, then ID order. */
function footUnits(state: SimState, uid: EntityId, own = false): EntityId[] {
  // (`own`: the unit alone, not its sub-units: a platoon's headquarters, owner 2026-11-15.)
  if (own) return state.unit.get(uid)?.vehicle === undefined && state.unit.has(uid) ? [uid] : [];
  const out: EntityId[] = [];
  const walk = (u: EntityId) => {
    const x = state.unit.get(u);
    if (!x || x.vehicle !== undefined) return;
    out.push(u);
    [...x.children].sort((a, b) => a - b).forEach(walk);
  };
  walk(uid);
  return out;
}

/** The carrier a unit rides in: its own, else the nearest one above it. */
function carrierOf(state: SimState, uid: EntityId): EntityId | undefined {
  for (let u: EntityId | null = uid; u !== null; u = state.unit.get(u)?.parent ?? null) {
    const c = state.unit.get(u)?.carrier;
    if (c !== undefined) return c;
  }
  return undefined;
}

/**
 * Does this man (aboard) sit in a crew seat, not a passenger's? A passenger who took over a fallen operator's seat
 * (seat swap, M7.6c review: a GTK Boxer's commander) stays at that station when his squad gets out, as crew do.
 */
function atStation(ctx: SimContext, state: SimState, s: SoldierState): boolean {
  const mt = s.mount;
  if (mt === undefined) return false;
  const v = state.vehicle.get(mt.vehicle);
  const st = v ? ctx.catalog.vehicles[v.def]?.seats[mt.seat]?.station : undefined;
  return st !== undefined && st !== "passenger";
}

/** Passengers (not crew, nor a passenger at a crew station) of a unit's own members who are aboard and could get out on their own. */
function ridersOf(ctx: SimContext, state: SimState, uid: EntityId): EntityId[] {
  const u = state.unit.get(uid);
  if (!u || u.vehicle !== undefined) return [];
  return u.members.filter((m) => { const s = state.soldier.get(m); return s?.mount !== undefined && walker(s) && !atStation(ctx, state, s); }).sort((a, b) => a - b);
}

/** Does any foot unit of this subtree have men aboard who could get out (Q12)? */
export function hasRiders(ctx: SimContext, state: SimState, uid: EntityId, own = false): boolean {
  return footUnits(state, uid, own).some((u) => ridersOf(ctx, state, u).length > 0);
}

function setBoarding(state: SimState, uid: EntityId, b: Boarding): void {
  const u = state.unit.req(uid);
  if (u.drill?.kind !== "rout") u.drill = null;
  u.boarding = b;
  u.moving = false;
}

/** Casualties of a unit aboard (alive, cannot get out on their own): carried out on a dismount with `wounded`. */
function woundedAboard(state: SimState, uid: EntityId): EntityId[] {
  const u = state.unit.get(uid);
  if (!u || u.vehicle !== undefined) return [];
  return u.members.filter((m) => { const s = state.soldier.get(m); return s?.mount !== undefined && carriable(s); }).sort((a, b) => a - b);
}

/**
 * Start getting a unit's men out (and an order to carry out afterwards); `wounded`: casualties aboard its men then
 * carry out (M10.4b). Returns whether anyone gets out.
 */
function startDismount(state: SimState, uid: EntityId, men: EntityId[], then: OrderBody | null, thenTarget: EntityId | undefined, wounded: EntityId[] = []): boolean {
  if (men.length === 0 && wounded.length === 0) return false;
  const first = state.soldier.req((men[0] ?? wounded[0])!).mount!.vehicle;
  const u = state.unit.req(uid);
  if (u.boarding?.kind === "dismount") {
    // A man or an order added to a dismount already under way.
    u.boarding.queue = [...new Set([...u.boarding.queue, ...men])].sort((a, b) => a - b);
    if (wounded.length > 0) u.boarding.casualties = [...new Set([...(u.boarding.casualties ?? []), ...wounded])].sort((a, b) => a - b);
    if (then) { u.boarding.then = then; if (thenTarget !== undefined) u.boarding.thenTarget = thenTarget; else delete u.boarding.thenTarget; }
    return true;
  }
  const b: Boarding = { kind: "dismount", vehicle: first, startTick: state.tick, queue: [...men].sort((a, b) => a - b), then, rampOpenTick: -1 };
  if (wounded.length > 0) b.casualties = [...wounded];
  if (thenTarget !== undefined) b.thenTarget = thenTarget;
  setBoarding(state, uid, b);
  return true;
}

/**
 * Orders to men aboard (Q12): a squad (or a man) still aboard gets out first, then carries the order out.
 * Returns null when the order is not for riders (the caller goes on as usual).
 */
export function dismountThen(ctx: SimContext, state: SimState, order: Order): OrderResult | null {
  const isUnit = state.unit.has(order.target);
  const body = toBody(order);
  if (!isUnit) {
    const s = state.soldier.get(order.target);
    if (s?.mount === undefined) return null;
    const uid = state.identity.req(order.target).unit;
    if (state.unit.get(uid)?.vehicle !== undefined || !walker(s) || atStation(ctx, state, s)) return "unable"; // crew stay at their stations
    startDismount(state, uid, [order.target], body, order.target);
    return true;
  }
  const units = footUnits(state, order.target, order.own === true).filter((u) => ridersOf(ctx, state, u).length > 0);
  if (units.length === 0) return null;
  // The order goes with the target's own boarding if its own men ride, else with the first unit under it.
  const holder = units.includes(order.target) ? order.target : units[0]!;
  for (const u of units) startDismount(state, u, ridersOf(ctx, state, u), u === holder ? body : null, u === holder && holder !== order.target ? order.target : undefined);
  return true;
}

function toBody(order: Order): OrderBody {
  const { tick: _t, issuer: _i, target: _g, ...body } = order;
  void _t; void _i; void _g;
  return body as OrderBody;
}

/** A mount or dismount order (plan §6, §11). */
export function boardingOrder(ctx: SimContext, state: SimState, order: Order & { kind: "mount" | "dismount" }, events: EventSink): OrderResult {
  const isUnit = state.unit.has(order.target);
  if (order.kind === "dismount") {
    // To a vehicle's crew: every passenger of that vehicle gets out, unit by unit.
    const crewOf = isUnit ? state.unit.req(order.target).vehicle : undefined;
    if (crewOf !== undefined) {
      const v = state.vehicle.get(crewOf);
      if (!v) return "unable";
      const byUnit = new Map<EntityId, EntityId[]>();
      for (const sid of v.seats) {
        if (sid === null) continue;
        const s = state.soldier.get(sid), uid = state.identity.get(sid)?.unit;
        if (uid === undefined || !walker(s) || state.unit.get(uid)?.vehicle !== undefined || atStation(ctx, state, s!)) continue;
        byUnit.set(uid, [...(byUnit.get(uid) ?? []), sid]);
      }
      let any = false;
      for (const uid of [...byUnit.keys()].sort((a, b) => a - b)) any = startDismount(state, uid, byUnit.get(uid)!, null, undefined) || any;
      return any ? true : "unable";
    }
    if (!isUnit) {
      const s = state.soldier.get(order.target);
      if (s?.mount === undefined || !walker(s) || atStation(ctx, state, s)) return "unable";
      const uid = state.identity.req(order.target).unit;
      if (state.unit.get(uid)?.vehicle !== undefined) return "unable";
      return startDismount(state, uid, [order.target], null, undefined) ? true : "unable";
    }
    let any = false;
    for (const u of footUnits(state, order.target, order.own === true)) any = startDismount(state, u, ridersOf(ctx, state, u), null, undefined, order.wounded ? woundedAboard(state, u) : []) || any;
    return any ? true : "unable";
  }
  // ---- mount
  if (order.vehicle !== undefined) {
    const side = state.unit.get(order.target)?.side ?? state.identity.get(order.target)?.side;
    if (state.vehicle.get(order.vehicle)?.side !== side) return "unable";
  }
  if (isUnit && state.unit.req(order.target).vehicle !== undefined) return "unable"; // a crew is aboard already
  const groups: { uid: EntityId; men: EntityId[]; vid: EntityId }[] = [];
  if (!isUnit) {
    const s = state.soldier.get(order.target);
    if (!walker(s) || s!.mount !== undefined) return "unable";
    const uid = state.identity.req(order.target).unit;
    const vid = order.vehicle ?? carrierOf(state, uid);
    if (vid === undefined) return { unable: "radio.noVehicle" };
    groups.push({ uid, men: [order.target], vid });
  } else {
    for (const u of footUnits(state, order.target, order.own === true)) {
      const men = state.unit.req(u).members.filter((m) => { const s = state.soldier.get(m); return walker(s) && s!.mount === undefined; }).sort((a, b) => a - b);
      if (men.length === 0) continue;
      const vid = order.vehicle ?? carrierOf(state, u);
      if (vid === undefined) continue;
      groups.push({ uid: u, men, vid });
    }
    if (groups.length === 0) return { unable: "radio.noVehicle" };
  }
  let res: OrderResult = "unable";
  for (const g of groups) {
    const v = state.vehicle.get(g.vid);
    const def = v ? ctx.catalog.vehicles[v.def] : undefined;
    if (!usable(v) || !def) { if (res !== true) res = "unable"; continue; }
    const u = state.unit.req(g.uid);
    const prev = u.boarding?.kind === "mount" && u.boarding.vehicle === g.vid ? u.boarding : undefined;
    const men = prev ? [...new Set([...prev.queue, ...g.men])].sort((a, b) => a - b) : g.men;
    // Fewer free places than men to get in: unable (no partial mount, plan §6 default).
    if (!roomFor(ctx, state, v, def, 0, reserved(state, g.vid, g.uid) + men.length)) {
      if (res !== true) res = { unable: "radio.noSeats" };
      if (groups.length > 1) radioFromTarget(state, g.uid, "radio.noSeats", events);
      continue;
    }
    const t = state.transform.req(g.vid);
    // Wounded men of the unit lying near an exit are carried in (Q25); M10.4b: from up to `fetchM` away, carried
    // to the exit first. Only as many as there are places for once the able men are in. A single man boards alone.
    const M = ctx.catalog.behaviour.mounting;
    const reach = Math.max(M.casualtyLoadM, ctx.rules.medicalCare !== false ? loadingParams(ctx).fetchM : 0); // (not with care off)
    const used = placesUsed(state, v, def);
    let lying = used.lying, sitting = used.sitting + reserved(state, g.vid, g.uid) + men.length;
    const casualties = !isUnit ? [] : u.members.filter((m) => {
      const s = state.soldier.get(m);
      if (!carriable(s) || s!.mount !== undefined || prev?.casualties?.includes(m)) return false;
      const mt = state.transform.req(m);
      if (nearestExit(def, t.x, t.y, t.heading, mt.x, mt.y).d > reach) return false;
      const lies = liesAboard(ctx, s!);
      if (!placesFit(ctx, def, lying + (lies ? 1 : 0), sitting + (lies ? 0 : 1))) return false;
      if (lies) lying++; else sitting++;
      return true;
    }).sort((a, b) => a - b);
    for (const m of men) { state.fire.delete(m); const s = state.soldier.req(m); if (s.intent?.kind !== "takePrisoner") s.intent = null; }
    setBoarding(state, g.uid, {
      kind: "mount", vehicle: g.vid, startTick: state.tick, queue: men, then: null, rampOpenTick: prev?.rampOpenTick ?? -1,
      firstTick: prev?.firstTick ?? -1, casualties: [...new Set([...(prev?.casualties ?? []), ...casualties])].sort((a, b) => a - b),
      ...(prev?.fetched ? { fetched: prev.fetched } : {}),
    });
    res = true;
  }
  return res;
}

/** An order to one man takes him out of his unit's boarding queue (orders win). */
export function leaveBoarding(state: SimState, man: EntityId): void {
  const uid = state.identity.get(man)?.unit;
  const b = uid === undefined ? undefined : state.unit.get(uid)?.boarding;
  if (b && b.kind !== "bailOut") b.queue = b.queue.filter((m) => m !== man);
}

// ---------------------------------------------------------------- the system

/** The ramp (doors) opens once, when the first man is ready to pass; true once it is open. */
function ensureRamp(b: Boarding, def: VehicleDef, tick: number): boolean {
  if (b.rampOpenTick < 0) b.rampOpenTick = tick + secondsToTicks(def.ramp.openSeconds);
  return tick >= b.rampOpenTick;
}

/** Exits in use by a getting-in or -out action on this vehicle. */
function busyExits(state: SimState, vid: EntityId, men: readonly EntityId[]): Set<number> {
  const out = new Set<number>();
  for (const m of men) {
    const a = state.action.get(m);
    if (a && (a.kind === "mount" || a.kind === "dismount") && Number(a.params["vehicle"]) === vid) out.add(Number(a.params["exit"]));
  }
  return out;
}

function finish(ctx: SimContext, state: SimState, uid: EntityId, u: Unit, events: EventSink): void {
  const b = u.boarding!;
  delete u.boarding;
  const aboard = state.unit.req(uid).members.some((m) => state.soldier.get(m)?.mount?.vehicle === b.vehicle);
  if (b.kind === "mount") {
    for (const m of b.queue) if (state.soldier.get(m)?.mount === undefined) halt(state, m); // left outside
    if (aboard) {
      events.emit({ kind: "unit.mounted", tick: state.tick, unit: uid, vehicle: b.vehicle });
      radioFromTarget(state, uid, "radio.mounted", events);
    }
    return;
  }
  events.emit({ kind: "unit.dismounted", tick: state.tick, unit: uid, vehicle: b.vehicle });
  radioFromTarget(state, uid, "radio.dismounted", events);
  if (b.then) {
    const target = b.thenTarget ?? uid;
    const issuer = state.unit.get(uid)!.side;
    applyOrderNow(ctx, state, { ...b.then, tick: state.tick, issuer, target } as Order, events);
  }
}

/** Is (p) within `r` of an exit of the vehicle at (t)? */
function nearExit(def: VehicleDef, t: { x: number; y: number; heading: number }, p: { x: number; y: number }, r: number): boolean {
  return nearestExit(def, t.x, t.y, t.heading, p.x, p.y).d <= r;
}

/**
 * M10.4b: the boarding unit's casualties lying farther than `casualtyLoadM` from an exit are carried to the nearest
 * exit, each by a carrying party of up to four of the men still outside (nearest first; the method is the carry
 * system's choice). Each is fetched once: one whose party ended short of the exit is left where he is. True while a
 * party is under way (the boarding then waits for it, up to `giveUpSeconds`).
 */
function fetchCasualties(ctx: SimContext, state: SimState, events: EventSink, b: Boarding, v: VehicleState, def: VehicleDef): boolean {
  const M = ctx.catalog.behaviour.mounting;
  const cs = b.casualties ?? [];
  if (cs.length === 0) return false;
  const t = state.transform.req(b.vehicle);
  let under = false;
  // One waiting at the exit is lifted in first (by the same men, perhaps) before anyone goes for the next.
  const waiting = cs.some((c) => !state.carry.has(c) && nearExit(def, t, state.transform.req(c), M.casualtyLoadM));
  for (const c of [...cs]) {
    if (state.carry.has(c)) { under = true; continue; }
    const ct = state.transform.req(c);
    const ex = nearestExit(def, t.x, t.y, t.heading, ct.x, ct.y);
    if (ex.d <= M.casualtyLoadM) continue;
    if (b.fetched?.includes(c)) { b.casualties = b.casualties!.filter((m) => m !== c); continue; }
    if (waiting) continue;
    // Up to four of the men still outside and free (not busy, not carrying), nearest to him first.
    const free = b.queue.filter((m) => !state.action.has(m) && state.soldier.req(m).carrying === undefined)
      .map((m) => { const mt = state.transform.req(m); return { m, d: hypot2(mt.x - ct.x, mt.y - ct.y) }; })
      .sort((p, q) => p.d - q.d || p.m - q.m).slice(0, 4).map((p) => p.m);
    if (free.length === 0) continue;
    b.fetched = [...(b.fetched ?? []), c].sort((p, q) => p - q);
    // To a spot just outside the exit, away from the hull, on ground a man can stand on.
    const ox = ex.x - t.x, oy = ex.y - t.y, ol = hypot2(ox, oy) || 1;
    let dx = ex.x + (ox / ol) * 1.5, dy = ex.y + (oy / ol) * 1.5;
    const grid = navFor(ctx, "foot").grid;
    const cell = nearestPassable(grid, Math.min(Math.max(dx, 1), ctx.map.widthM - 1), Math.min(Math.max(dy, 1), ctx.map.heightM - 1), 6);
    if (cell >= 0) { dx = ((cell % grid.cols) + 0.5) * grid.cellM; dy = (Math.floor(cell / grid.cols) + 0.5) * grid.cellM; }
    if (startCarry(ctx, state, events, c, free, { x: dx, y: dy, z: 0 }, { purpose: "move" })) under = true;
  }
  return under;
}

function stepMount(ctx: SimContext, state: SimState, uid: EntityId, u: Unit, events: EventSink): void {
  const b = u.boarding!, M = ctx.catalog.behaviour.mounting;
  const v = state.vehicle.get(b.vehicle);
  const def = v ? ctx.catalog.vehicles[v.def] : undefined;
  if (!usable(v) || !def) { delete u.boarding; for (const m of b.queue) halt(state, m); radioFromTarget(state, uid, "radio.unable", events); return; }
  // Who is still to get in: able men not yet aboard; wounded still lying there.
  b.queue = b.queue.filter((m) => { const s = state.soldier.get(m); return walker(s) && s!.mount === undefined; });
  b.casualties = (b.casualties ?? []).filter((m) => { const s = state.soldier.get(m); return carriable(s) && s!.mount === undefined; });
  const t = state.transform.req(b.vehicle);
  const stopped = halted(v);
  if (stopped) v.drive.holdForDismount = true;
  const tick = state.tick;
  // M10.4b: a casualty farther from an exit is carried to it first; one carried there in vain is left.
  // (A fetched casualty is waited for until he is in: past `completeAfterSeconds`, up to `giveUpSeconds`.)
  const fetching = fetchCasualties(ctx, state, events, b, v, def) || (b.casualties ?? []).some((c) => b.fetched?.includes(c));
  const done = b.queue.length === 0 && b.casualties.length === 0;
  const late = ((b.firstTick ?? -1) >= 0 && tick - b.firstTick! >= secondsToTicks(M.completeAfterSeconds) && !fetching) || tick - b.startTick >= secondsToTicks(M.giveUpSeconds);
  if (done || late || firstFreePassengerSeat(v, def) < 0) { finish(ctx, state, uid, u, events); return; }
  // The walk to the vehicle is planned again when the hull has moved.
  const moved = !(hypot2(t.x - (b.hullX ?? Number.NaN), t.y - (b.hullY ?? Number.NaN)) <= M.approachReplanM);
  if (moved) { b.hullX = t.x; b.hullY = t.y; }
  // Wounded men near an exit: the two lowest-ID able men within reach carry each in, one at a time (Q25).
  const carriers = new Set<EntityId>();
  const cas = b.casualties.find((c) => !state.carry.has(c) && nearExit(def, t, state.transform.req(c), M.casualtyLoadM));
  if (cas !== undefined) {
    const ct = state.transform.req(cas);
    const within = b.queue.filter((m) => { const mt = state.transform.req(m); return hypot2(mt.x - ct.x, mt.y - ct.y) <= M.carriersWithinM; });
    // (Men still carrying another casualty to the exit come to him afterwards.)
    // The two already lifting him keep at it (a man freed meanwhile does not take over).
    const lifting = (m: EntityId) => { const a = state.action.get(m); return a?.kind === "loadCasualty" && Number(a.params["casualty"]) === cas; };
    const near = within.filter((m) => state.soldier.req(m).carrying === undefined).sort((m, n) => Number(lifting(n)) - Number(lifting(m)) || m - n);
    if (near.length >= 2) {
      const [p, q] = [near[0]!, near[1]!];
      carriers.add(p); carriers.add(q);
      const ap = state.action.get(p), aq = state.action.get(q);
      if (ap?.kind !== "loadCasualty" || aq?.kind !== "loadCasualty") {
        const tp = state.transform.req(p), tq = state.transform.req(q);
        const atP = hypot2(tp.x - ct.x, tp.y - ct.y) <= 2.5 && Math.abs(tp.z - ct.z) < 1, atQ = hypot2(tq.x - ct.x, tq.y - ct.y) <= 2.5 && Math.abs(tq.z - ct.z) < 1;
        if (atP && atQ && stopped && ensureRamp(b, def, tick)) {
          const dur = secondsToTicks(def.ramp.loadCasualtySeconds);
          startAction(state, events, p, "loadCasualty", dur, { vehicle: b.vehicle, casualty: cas, other: q, role: "lead" });
          startAction(state, events, q, "loadCasualty", dur, { vehicle: b.vehicle, casualty: cas, other: p, role: "helper" });
          // (The time left to finish counts from the last casualty lifted in: his two carriers still get in.)
          b.firstTick = tick;
        } else {
          for (const [m, at] of [[p, atP], [q, atQ]] as const) {
            const w = state.mover.get(m)?.waypoints;
            const goal = w && w.length > 0 ? w[w.length - 1]! : null;
            if (!at && (!goal || hypot2(goal.x - ct.x, goal.y - ct.y) > 2)) runTo(ctx, state, m, ct.x, ct.y, ct.z);
          }
        }
      }
    } else if (within.length < 2) {
      // Nobody to carry him (fewer than two able men near): he stays where he is.
      b.casualties = b.casualties.filter((m) => m !== cas);
    }
  }
  // Able men: to the nearest exit, then in, one at a time per exit, lowest ID first.
  const busy = busyExits(state, b.vehicle, b.queue);
  for (const m of b.queue) {
    if (carriers.has(m) || state.action.has(m) || state.soldier.req(m).carrying !== undefined) continue;
    const mt = state.transform.req(m);
    const ex = nearestExit(def, t.x, t.y, t.heading, mt.x, mt.y);
    if (ex.d <= M.boardReachM) {
      if (!stopped || busy.has(ex.k) || !ensureRamp(b, def, tick)) continue;
      // Two men stay outside while a wounded comrade still has to be carried in.
      if (b.casualties.length > 0 && b.queue.length <= 2) continue;
      busy.add(ex.k);
      halt(state, m);
      startAction(state, events, m, "mount", secondsToTicks(def.ramp.mountSecondsPerMan), { vehicle: b.vehicle, exit: ex.k });
      if ((b.firstTick ?? -1) < 0) b.firstTick = tick;
      continue;
    }
    const w = state.mover.get(m)?.waypoints;
    if (moved || !w || w.length === 0) runTo(ctx, state, m, ex.x, ex.y);
  }
}

function stepDismount(ctx: SimContext, state: SimState, uid: EntityId, u: Unit, events: EventSink): void {
  const b = u.boarding!, M = ctx.catalog.behaviour.mounting;
  // Still to get out: able men still aboard (a man hit meanwhile stays aboard).
  b.queue = b.queue.filter((m) => { const s = state.soldier.get(m); return walker(s) && s!.mount !== undefined; });
  if (b.casualties) b.casualties = b.casualties.filter((m) => { const s = state.soldier.get(m); return s?.mount !== undefined && carriable(s); });
  const left = b.queue.length + (b.casualties?.length ?? 0);
  if (left === 0 || state.tick - b.startTick >= secondsToTicks(M.giveUpSeconds)) { finish(ctx, state, uid, u, events); return; }
  // The able men are out: carry out the wounded (M10.4b).
  if (b.queue.length === 0) { stepUnload(ctx, state, uid, b, events); return; }
  // Vehicle by vehicle (a unit spread over two hulls gets out of both).
  const vehicles = [...new Set(b.queue.map((m) => state.soldier.req(m).mount!.vehicle))].sort((a, b2) => a - b2);
  for (const vid of vehicles) {
    const v = state.vehicle.get(vid);
    const def = v ? ctx.catalog.vehicles[v.def] : undefined;
    if (!v || !def) continue;
    v.drive.holdForDismount = true;
    if (Math.abs(v.drive.speed) >= HALTED_MPS || !ensureRamp(b, def, state.tick)) continue;
    const men = b.queue.filter((m) => state.soldier.req(m).mount!.vehicle === vid);
    const busy = busyExits(state, vid, men);
    for (const m of men) {
      if (state.action.has(m)) continue;
      // The free exit nearest his seat.
      const seat = def.seats[state.soldier.req(m).mount!.seat]!;
      let best = -1, bestD = Infinity;
      def.ramp.exits.forEach((e, k) => { if (busy.has(k)) return; const d = hypot2(e[0] - seat.pos[0], e[1] - seat.pos[1]); if (d < bestD) { bestD = d; best = k; } });
      if (best < 0) break;
      busy.add(best);
      startAction(state, events, m, "dismount", secondsToTicks(def.ramp.dismountSecondsPerMan), { vehicle: vid, exit: best });
    }
  }
}

/**
 * M10.4b: the first casualty still aboard is carried out by the two of the unit's men on foot nearest his vehicle's
 * exit (within `carriersWithinM`, not carrying anyone else): they go to the exit nearest his seat, then take
 * `loadCasualtySeconds` to get him out. With fewer than two such men he stays aboard.
 */
function stepUnload(ctx: SimContext, state: SimState, uid: EntityId, b: Boarding, events: EventSink): void {
  const M = ctx.catalog.behaviour.mounting;
  const cas = b.casualties![0]!;
  const vid = state.soldier.req(cas).mount!.vehicle, v = state.vehicle.get(vid);
  const def = v ? ctx.catalog.vehicles[v.def] : undefined;
  if (!v || !def || v.status === "destroyed" || v.fire !== null) { b.casualties = b.casualties!.slice(1); return; }
  v.drive.holdForDismount = true;
  // Being carried out already.
  for (const m of state.unit.req(uid).members) { const a = state.action.get(m); if (a?.kind === "unloadCasualty" && Number(a.params["casualty"]) === cas) return; }
  // The exit nearest his seat.
  const seat = def.seats[state.soldier.req(cas).mount!.seat]!;
  let k = 0, kd = Infinity;
  def.ramp.exits.forEach((e, i) => { const d = hypot2(e[0] - seat.pos[0], e[1] - seat.pos[1]); if (d < kd) { kd = d; k = i; } });
  const t = state.transform.req(vid), ex = exitWorld(def, k, t.x, t.y, t.heading);
  const men = state.unit.req(uid).members.filter((m) => {
    const s = state.soldier.get(m);
    if (!walker(s) || s!.mount !== undefined || s!.carrying !== undefined || s!.captive !== null) return false;
    const mt = state.transform.req(m);
    return hypot2(mt.x - ex.x, mt.y - ex.y) <= M.carriersWithinM;
  }).map((m) => { const mt = state.transform.req(m); return { m, d: hypot2(mt.x - ex.x, mt.y - ex.y) }; })
    .sort((p, q) => p.d - q.d || p.m - q.m).slice(0, 2);
  if (men.length < 2) { b.casualties = b.casualties!.slice(1); return; }
  const [p, q] = [men[0]!.m, men[1]!.m];
  const atP = men[0]!.d <= M.boardReachM, atQ = men[1]!.d <= M.boardReachM;
  if (atP && atQ && Math.abs(v.drive.speed) < HALTED_MPS && ensureRamp(b, def, state.tick)) {
    const dur = secondsToTicks(def.ramp.loadCasualtySeconds);
    halt(state, p); halt(state, q);
    startAction(state, events, p, "unloadCasualty", dur, { vehicle: vid, casualty: cas, other: q, role: "lead", exit: k });
    startAction(state, events, q, "unloadCasualty", dur, { vehicle: vid, casualty: cas, other: p, role: "helper", exit: k });
    return;
  }
  for (const [m, at] of [[p, atP], [q, atQ]] as const) {
    if (at || state.action.has(m)) continue;
    const w = state.mover.get(m)?.waypoints;
    const goal = w && w.length > 0 ? w[w.length - 1]! : null;
    if (!goal || hypot2(goal.x - ex.x, goal.y - ex.y) > 1.5) runTo(ctx, state, m, ex.x, ex.y);
  }
}

/**
 * A fallen driver or station operator is replaced by another man aboard (Q13 default: a crewman, after
 * `seatSwapSeconds`). The seats kept manned come from the data: the driver's and each station's `operator` seat
 * (M7.6c review: a GTK Boxer's FLW 200 is worked from the commander's seat). For the driver's and the gunner's seat
 * the rules are as before (crewmen only: the commander first, then a loader, and for the driver's seat the gunner
 * last); any other operator seat is taken by a loader or gunner whose own seat is not one of these, else by an able
 * passenger (lowest seat first), as a crew of two has nobody else.
 */
function seatSwaps(ctx: SimContext, state: SimState, events: EventSink): void {
  for (const [vid, v] of state.vehicle.entries()) {
    if (isOffMap(v) || v.unit === null || v.seatSwap !== null || v.status === "destroyed" || v.status === "abandoned") continue;
    const def = ctx.catalog.vehicles[v.def];
    const crew = state.unit.get(v.unit);
    if (!def || !crew) continue;
    const needs = swapSeatKinds(def);
    for (const need of needs) {
      const si = def.seats.findIndex((q) => q.station === need);
      if (si < 0) continue;
      const o = v.seats[si] ?? null;
      if (o !== null && isAble(state.soldier.get(o))) continue;
      const free = (a: EntityId | null): a is EntityId => a !== null && isAble(state.soldier.get(a)) && !state.action.has(a);
      const from = need === "driver" ? ["commander", "loader", "gunner"] : need === "gunner" ? ["commander", "loader"]
        : ["loader", "gunner"].filter((k) => !needs.includes(k));
      let actor: EntityId | null = null;
      for (const k of from) {
        for (let i = 0; i < def.seats.length && actor === null; i++) {
          if (def.seats[i]!.station !== k) continue;
          const a = v.seats[i] ?? null;
          if (free(a) && crew.members.includes(a)) actor = a;
        }
        if (actor !== null) break;
      }
      if (actor === null && need !== "driver" && need !== "gunner") {
        for (let i = 0; i < def.seats.length && actor === null; i++) {
          const a = v.seats[i] ?? null;
          if (def.seats[i]!.station === "passenger" && free(a)) actor = a;
        }
      }
      if (actor === null) continue;
      const dur = secondsToTicks(def.ramp.seatSwapSeconds);
      startAction(state, events, actor, "seatSwap", dur, { vehicle: vid, seat: si });
      v.seatSwap = { seat: si, actor, untilTick: state.tick + dur };
      radioFromTarget(state, v.unit, "radio.seatSwap", events);
      break;
    }
  }
}

/** The seat kinds a crew keeps manned: the driver's, then each station's operator's (in station order, once each). */
function swapSeatKinds(def: VehicleDef): string[] {
  const out = ["driver"];
  for (const sn of def.stations) if (!out.includes(sn.operator)) out.push(sn.operator);
  return out;
}

export function boardingSystem(ctx: SimContext, state: SimState, events: EventSink): void {
  if (state.vehicle.size === 0) return;
  const M = ctx.catalog.behaviour.mounting;
  // A seat swap that was broken off (the crewman hit) is forgotten, so another can try.
  // off-map: ok a seat swap is never under way off the map (seatSwaps skips those hulls)
  for (const [, v] of state.vehicle.entries()) {
    if (v.seatSwap && state.action.get(v.seatSwap.actor)?.kind !== "seatSwap") v.seatSwap = null;
  }
  for (const [uid, u] of state.unit.entries()) {
    if (!u.boarding) continue;
    if (u.boarding.kind === "mount") stepMount(ctx, state, uid, u, events);
    else if (u.boarding.kind === "dismount") stepDismount(ctx, state, uid, u, events);
  }
  // A vehicle holds while men get in or out of it, and drives on (its route kept) once they are done.
  const holding = new Set<EntityId>();
  for (const [, u] of state.unit.entries()) {
    const b = u.boarding;
    if (!b) continue;
    if (b.kind === "dismount") for (const m of [...b.queue, ...(b.casualties ?? [])]) { const mv = state.soldier.get(m)?.mount?.vehicle; if (mv !== undefined) holding.add(mv); }
    else if (state.vehicle.get(b.vehicle)?.drive.holdForDismount) holding.add(b.vehicle);
  }
  // off-map: ok only clears a flag that is never set off the map
  for (const [vid, v] of state.vehicle.entries()) if (v.drive.holdForDismount && !holding.has(vid)) v.drive.holdForDismount = false;
  if (state.tick % Math.max(1, secondsToTicks(M.seatSwapCheckSeconds)) === 0) seatSwaps(ctx, state, events);
}
