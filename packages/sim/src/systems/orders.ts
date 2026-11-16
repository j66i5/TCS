/**
 * Order pipeline: inbox (issued) -> validation -> comms delay (pending) -> delivery (applied).
 */
import { droneOrder, droneRiderOf, hasDrone } from "./drones";
import { callFire } from "./support";
import { refusesFireAt } from "../protection";
import { leaveCarry } from "./carry";
import { casualtyPointOrder, evacuateOrder, releaseForBoarding } from "./nest";
import { callAmbulanceOrder } from "./evacuation";
import { rearRunGate, rearRunOrder } from "./rearrun";
import { kitSource, takeKitOrder } from "./consolidate";
import { aglOf, crewServedKind, startSetup } from "./mortars";
import { aglOrderFire } from "./agl-team";
import { teamOrderShot } from "./missile-team";
import { clearDrills, drillGroups, dropFromDrill, releaseFromParentDrills } from "./drills";
import { clearable, startClear } from "./clear";
import { freeSpotNear, placeFree, placesTaken } from "./decisions";
import type { SimContext } from "../context";
import { floorAtZ, indoorAt, indoorSpots, routeBetween, routeWaypoints } from "../interior-nav";
import type { EventSink } from "../events";
import type { EntityId } from "../ids";
import { OWN_ORDER_KINDS, type Order, type OrderRejectReason, type PendingOrder, type Waypoint } from "../orders";
import { bestCoverNear, clearLine, navCostAt, nearestPassable } from "../nav";
import { PI, atan2, cos, hypot2, sin, wrapAngle } from "../math";
import { canReport, isAble } from "../impair";
import { navFor } from "../navctx";
import { requestPosture } from "./body";
import { buildingIndex, occupyBuilding, windowPlaces } from "./occupy";
import { aimHeightAt, assignFireTask } from "./fire";
import { grenadeOption, throwArcExists, type GrenadeOption } from "./grenades";
import { screenOnOrder } from "./smoke";
import { orderLauncherShot } from "./launcher";
import { startAction } from "../actions";
import { noteVehicleOrder, vehicleHalt, vehicleMove, vehicleOrder, type OrderResult } from "./drive";
import { dischargeSmoke, stationCeaseFire, stationFireOrder, vehicleHasMissiles } from "./gunnery";
import { boardingOrder, dismountThen, hasRiders, leaveBoarding } from "./boarding";
import { secondsToTicks } from "../ids";
import type { Contact, Unit } from "../components";
import type { SimState } from "../state";

function sideOf(state: SimState, target: EntityId): string | null {
  return state.unit.get(target)?.side ?? state.identity.get(target)?.side ?? null;
}

function validate(ctx: SimContext, state: SimState, o: Order): OrderRejectReason | null {
  if (state.ended) return "battle-ended";
  if (o.tick < state.tick) return "late";
  const side = sideOf(state, o.target);
  if (side === null) return "unknown-target";
  if (side !== o.issuer) return "not-your-unit";
  if (!orderApplies(ctx, state, o)) return "not-applicable";
  // (Its own men only: a unit without a vehicle that has men of its own, and an order kind that takes it.)
  if (o.own !== undefined) {
    const u = state.unit.get(o.target);
    if (o.own !== true || !u || u.vehicle !== undefined || u.members.length === 0 || !OWN_ORDER_KINDS.includes(o.kind)) return "invalid-params";
  }
  switch (o.kind) {
    case "move":
      if (o.waypoints.length === 0 || o.waypoints.length > 64) return "invalid-params";
      if (o.floor !== undefined && !(Number.isInteger(o.floor) && o.floor >= 0 && o.floor < 64)) return "invalid-params";
      for (const w of o.waypoints) {
        if (!Number.isFinite(w.x) || !Number.isFinite(w.y)) return "invalid-params";
        if (w.x < 0 || w.y < 0 || w.x > ctx.map.widthM || w.y > ctx.map.heightM) return "invalid-params";
        if (w.z !== undefined && !(w.z >= 0 && w.z <= 100)) return "invalid-params";
        const mode = ctx.catalog.movementModes[w.mode];
        if (!mode) return "invalid-params";
        // A vehicle crew drives at a foot pace (mapped) or a pace of its own class; men on foot at foot paces.
        const vcls = vehicleClassOf(ctx, state, o.target);
        if (mode.class !== "foot" && mode.class !== vcls) return "invalid-params";
        if (w.reverse !== undefined && (w.reverse !== true || vcls === null)) return "invalid-params";
        if (w.posture !== undefined && w.posture !== "standing" && w.posture !== "crouching" && w.posture !== "prone") return "invalid-params";
      }
      if (o.formation !== undefined && !ctx.catalog.formations[o.formation]) return "invalid-params";
      if (o.facing !== undefined && !Number.isFinite(o.facing)) return "invalid-params";
      if (o.frontageM !== undefined && !(o.frontageM >= 1 && o.frontageM <= 500)) return "invalid-params";
      return null;
    case "halt":
    case "deploy":
      return null;
    case "posture":
      return o.posture === "standing" || o.posture === "crouching" || o.posture === "prone" ? null : "invalid-params";
    case "fire":
      if (!Number.isFinite(o.x) || !Number.isFinite(o.y) || o.x < 0 || o.y < 0 || o.x > ctx.map.widthM || o.y > ctx.map.heightM) return "invalid-params";
      if (o.heightM !== undefined && !(o.heightM >= 0 && o.heightM <= 50)) return "invalid-params";
      if (o.nature !== undefined && o.nature !== "ap" && o.nature !== "he" && o.nature !== "mg" && o.nature !== "at") return "invalid-params";
      return null;
    case "ceaseFire":
      return null;
    case "rules":
      if (o.fire !== undefined && o.fire !== "free" && o.fire !== "return" && o.fire !== "hold") return "invalid-params";
      if (o.maxEngageM !== undefined && !(o.maxEngageM >= 0 && o.maxEngageM <= 5000)) return "invalid-params";
      if (o.onContact !== undefined && o.onContact !== "ground" && o.onContact !== "push" && o.onContact !== "back") return "invalid-params";
      if (o.ammo !== undefined && o.ammo !== "conserve" && o.ammo !== "normal" && o.ammo !== "max") return "invalid-params";
      if (o.at !== undefined && o.at !== "vehicles" && o.at !== "vehiclesAndPositions" && o.at !== "hold") return "invalid-params";
      return null;
    case "callFire":
      if (!Number.isFinite(o.x) || !Number.isFinite(o.y) || o.x < 0 || o.y < 0 || o.x > ctx.map.widthM || o.y > ctx.map.heightM) return "invalid-params";
      if (o.ammo !== "he" && o.ammo !== "smoke" && o.ammo !== "illum") return "invalid-params";
      if (o.asset !== undefined && o.asset !== "mortar" && o.asset !== "artillery") return "invalid-params";
      if (o.fuse !== undefined && (o.fuse !== "airburst" || o.ammo !== "he")) return "invalid-params";
      if ((o.x2 === undefined) !== (o.y2 === undefined)) return "invalid-params";
      if (o.x2 !== undefined && (o.ammo !== "smoke" || !Number.isFinite(o.x2) || !Number.isFinite(o.y2!) || o.x2 < 0 || o.y2! < 0 || o.x2 > ctx.map.widthM || o.y2! > ctx.map.heightM)) return "invalid-params";
      return Number.isInteger(o.rounds) && o.rounds >= 1 && o.rounds <= 24 ? null : "invalid-params";
    case "assault":
    case "withdraw":
      if (!state.unit.has(o.target)) return "invalid-params"; // a drill is for a unit, not one man
      if (!Number.isFinite(o.x) || !Number.isFinite(o.y) || o.x < 0 || o.y < 0 || o.x > ctx.map.widthM || o.y > ctx.map.heightM) return "invalid-params";
      // A house to clear (M7.5e): a building with an interior and a way in.
      if (o.kind === "assault" && o.building !== undefined && !clearable(ctx, o.building)) return "invalid-params";
      return null;
    case "grenade":
      if (!Number.isFinite(o.x) || !Number.isFinite(o.y) || o.x < 0 || o.y < 0 || o.x > ctx.map.widthM || o.y > ctx.map.heightM) return "invalid-params";
      if (o.count !== undefined && !(Number.isInteger(o.count) && o.count >= 1 && o.count <= 50)) return "invalid-params";
      if (o.smoke !== undefined && typeof o.smoke !== "boolean") return "invalid-params";
      return null;
    case "mount":
      // An own vehicle, if one is named.
      if (o.vehicle !== undefined && state.vehicle.get(o.vehicle)?.side !== o.issuer) return "invalid-params";
      return null;
    case "dismount":
      if (o.wounded !== undefined && typeof o.wounded !== "boolean") return "invalid-params";
      return null;
    case "discharge":
      return null;
    case "drone":
      if (o.op !== "fly" && o.op !== "home") return "invalid-params";
      if (o.op === "fly" && (o.x === undefined || o.y === undefined)) return "invalid-params";
      if (o.x !== undefined && (!Number.isFinite(o.x) || o.x < 0 || o.x > ctx.map.widthM)) return "invalid-params";
      if (o.y !== undefined && (!Number.isFinite(o.y) || o.y < 0 || o.y > ctx.map.heightM)) return "invalid-params";
      if (o.altM !== undefined && !(o.altM >= 0 && o.altM <= 5000)) return "invalid-params";
      if (o.dismount !== undefined && typeof o.dismount !== "boolean") return "invalid-params";
      return null;
    case "occupy":
      if (buildingIndex(ctx, o.building) < 0) return "invalid-params";
      if (o.floor !== undefined && !(Number.isInteger(o.floor) && o.floor >= 0 && o.floor < 64)) return "invalid-params";
      if (o.facing !== undefined && !Number.isFinite(o.facing)) return "invalid-params";
      if (o.windowIndex !== undefined && !(Number.isInteger(o.windowIndex) && o.windowIndex >= 0 && o.windowIndex < windowPlaces(ctx, buildingIndex(ctx, o.building)).length)) return "invalid-params";
      if (o.mode !== undefined && ctx.catalog.movementModes[o.mode]?.class !== "foot") return "invalid-params";
      return null;
    case "casualtyPoint":
      if (!Number.isFinite(o.x) || !Number.isFinite(o.y) || o.x < 0 || o.y < 0 || o.x > ctx.map.widthM || o.y > ctx.map.heightM) return "invalid-params";
      return ctx.catalog.medical?.nest ? null : "not-applicable";
    case "evacuate":
      // The target is the wounded man himself (M10.5).
      if (!state.soldier.has(o.target)) return "invalid-params";
      return ctx.catalog.medical?.nest ? null : "not-applicable";
    case "callAmbulance":
      return ctx.catalog.medical?.nest && ctx.catalog.medical.evacuation ? null : "not-applicable";
    case "ambush":
      // (D4b: a unit, and a range its men can hold their fire to.)
      if (!state.unit.has(o.target)) return "invalid-params";
      return Number.isFinite(o.rangeM) && o.rangeM >= 10 && o.rangeM <= 2000 ? null : "invalid-params";
    case "defendArc":
      if (!state.unit.has(o.target)) return "invalid-params";
      return Number.isFinite(o.facing) && Number.isFinite(o.widthRad) && o.widthRad > 0 && o.widthRad <= 2 * PI ? null : "invalid-params";
    case "takeKit":
      // (M11.2: men on foot; an enemy casualty or prisoner, or a pile on the ground.)
      if (state.unit.get(o.target)?.vehicle !== undefined || !Number.isInteger(o.source)) return "invalid-params";
      if (!ctx.catalog.behaviour.consolidate) return "not-applicable";
      return kitSource(state, o.issuer, o.source) ? null : "invalid-params";
    case "rearRun":
      // A vehicle crew's hull (M10.6b).
      if (state.unit.get(o.target)?.vehicle === undefined) return "invalid-params";
      return ctx.catalog.medical?.nest && ctx.catalog.medical.rearRun ? null : "not-applicable";
  }
}

/**
 * Does this kind of order mean anything to its target (plan §11, M7.3)? A vehicle crew does not take a posture,
 * assault, withdraw or throw grenades; smoke dischargers belong to a vehicle crew or a unit with vehicles.
 */
function orderApplies(ctx: SimContext, state: SimState, o: Order): boolean {
  const vid = state.unit.get(o.target)?.vehicle;
  const crew = vid !== undefined;
  switch (o.kind) {
    case "posture": case "assault": case "withdraw": case "grenade": case "occupy": case "defendArc":
      return !crew;
    case "fire":
      // A crew has no launcher (M7.4a), unless its vehicle carries guided missiles (owner 2026-11-13).
      return !(crew && o.nature === "at") || vehicleHasMissiles(ctx, state, vid);
    case "discharge":
      return crew || (state.unit.has(o.target) && vehicleChildren(state, o.target).length > 0);
    case "deploy":
      return crewServedTeamsUnder(state, o.target).length > 0; // (M9.3b: missile teams too)
    case "drone":
      return hasDrone(ctx, state, o.target);
    default:
      return true;
  }
}

/** The movement class of a vehicle crew unit's vehicle, or null for anything else. */
function vehicleClassOf(ctx: SimContext, state: SimState, target: EntityId): "tracked" | "wheeled" | null {
  const vid = state.unit.get(target)?.vehicle;
  const v = vid === undefined ? undefined : state.vehicle.get(vid);
  return v ? ctx.catalog.vehicles[v.def]?.class ?? null : null;
}

/** Queue an order. Called by the outside world (via Sim.submit). */
export function enqueueOrder(state: SimState, order: Order): number {
  const seq = state.nextOrderSeq++;
  // Deep copy: the caller must not be able to mutate state through the order object.
  state.inbox.push({ seq, order: JSON.parse(JSON.stringify(order)) as Order });
  return seq;
}

/** Process orders issued for this tick: validate and hand to the comms model. */
export function receiveOrders(ctx: SimContext, state: SimState, events: EventSink): void {
  if (state.inbox.length === 0) return;
  const now: typeof state.inbox = [];
  const later: typeof state.inbox = [];
  for (const io of state.inbox) (io.order.tick <= state.tick ? now : later).push(io);
  state.inbox = later;
  now.sort((a, b) => a.seq - b.seq);
  for (const { seq, order } of now) {
    const reason = validate(ctx, state, order);
    if (reason !== null) {
      events.emit({ kind: "order.rejected", tick: state.tick, seq, issuer: order.issuer, target: order.target, reason });
      continue;
    }
    const delay = ctx.comms.orderDelayTicks(state, ctx.rules.comms, order);
    if (delay === null) {
      // Out of contact: in the foundations the order is simply lost. M14 adds runners/retries.
      events.emit({ kind: "order.rejected", tick: state.tick, seq, issuer: order.issuer, target: order.target, reason: "unknown-target" });
      continue;
    }
    const p: PendingOrder = { seq, order, receivedTick: state.tick, deliverTick: state.tick + delay };
    state.pendingOrders.push(p);
    events.emit({
      kind: "order.received", tick: state.tick, seq, issuer: order.issuer, target: order.target,
      orderKind: order.kind, deliverTick: p.deliverTick,
    });
  }
}

/** Deliver orders whose comms delay has elapsed. */
export function deliverOrders(ctx: SimContext, state: SimState, events: EventSink): void {
  if (state.pendingOrders.length === 0) return;
  const due: PendingOrder[] = [];
  const rest: PendingOrder[] = [];
  for (const p of state.pendingOrders) (p.deliverTick <= state.tick ? due : rest).push(p);
  if (due.length === 0) return;
  state.pendingOrders = rest;
  due.sort((a, b) => a.deliverTick - b.deliverTick || a.seq - b.seq);
  const done = new Set<number>();
  const deliver = (p: PendingOrder): void => {
    done.add(p.seq);
    const res = applyOrder(ctx, state, p.order, events);
    if (res === true) screenAfterOrder(ctx, state, p.order, events);
    const ou = state.unit.has(p.order.target) ? p.order.target : state.identity.get(p.order.target)?.unit;
    if (ou !== undefined) { const mark = (u: EntityId) => { const x = state.unit.get(u); if (!x) return; x.orderTick = state.tick; if (p.order.own !== true) x.children.forEach(mark); }; mark(ou); }
    events.emit({ kind: "order.delivered", tick: state.tick, seq: p.seq, target: p.order.target, orderKind: p.order.kind });
    radioFromTarget(state, p.order.target, res === true ? (p.order.kind === "grenade" && p.order.smoke === true ? "radio.ack.smoke" : `radio.ack.${p.order.kind}`) : res === "unable" ? "radio.unable" : res === false ? "radio.noRoute" : res.unable, events);
    if (res === false) events.emit({ kind: "move.noRoute", tick: state.tick, target: p.order.target });
  };
  for (const p of due) {
    if (done.has(p.seq)) continue;
    // An order that moves or stops the men meets older orders they are still hesitating over (D4b):
    // - one that reaches all of their men replaces it (if they would hesitate over it too, they take it up when
    //   they would have moved anyway: an order repeated every few seconds must not keep them waiting for ever);
    // - one to part of them (a sub-unit, one man) lets the broader order go first, now, so the two come in the
    //   order they were given, as without hesitation.
    let replacedUntil = -1;
    if (SUPERSEDES_HESITATION.includes(p.order.kind)) {
      const older = (h: PendingOrder) => h !== p && h.hesitated === true && h.seq < p.seq && !done.has(h.seq);
      const cands = [...state.pendingOrders.filter(older), ...due.filter(older)].sort((a, b) => a.seq - b.seq);
      for (const h of cands) {
        if (ordersCover(state, p.order, h.order)) {
          replacedUntil = Math.max(replacedUntil, h.deliverTick);
          done.add(h.seq);
          state.pendingOrders = state.pendingOrders.filter((x) => x !== h);
          // (Events are the only channel out, rule 5: the order is over, its marker goes.)
          events.emit({ kind: "order.rejected", tick: state.tick, seq: h.seq, issuer: h.order.issuer, target: h.order.target, reason: "superseded" });
        } else if (ordersCover(state, h.order, p.order)) {
          state.pendingOrders = state.pendingOrders.filter((x) => x !== h);
          deliver(h);
        }
      }
    }
    // Shaken men hesitate before obeying (D4b): the order waits a little, once.
    const wait = hesitationTicks(ctx, state, p);
    const until = wait <= 0 ? -1 : replacedUntil >= 0 ? replacedUntil : state.tick + wait;
    if (until > state.tick) {
      p.hesitated = true;
      p.deliverTick = until;
      state.pendingOrders.push(p);
      events.emit({ kind: "order.hesitating", tick: state.tick, seq: p.seq, target: p.order.target, orderKind: p.order.kind, deliverTick: p.deliverTick });
      if (replacedUntil < 0) radioFromTarget(state, p.order.target, "radio.hesitate", events);
      continue;
    }
    deliver(p);
  }
}

/**
 * The orders that replace one the men are hesitating over (D4b): those that send them somewhere, or stop them
 * where they are (a fire task stops them too). Everything else (rules, an ambush, cease-fire, a call for fire, a
 * grenade, a posture, smoke, a drone...) leaves the hesitating order pending: it changes how they fight, not where
 * they go, and the move must still come. A fire order is in the set because it stops them: were the older move
 * left pending, it would later end the newer fire task and walk them off, the reverse of the order given.
 */
const SUPERSEDES_HESITATION: readonly string[] = ["move", "assault", "withdraw", "occupy", "halt", "mount", "dismount", "defendArc", "fire"];

/**
 * How long the men hesitate over a due order (D4b, SPEC 6.6, behaviour.hesitation), in ticks; 0 = they obey now.
 * Only listed kinds, only once per order, only men on foot (not a crew, not aboard, not a unit with vehicles):
 * when at least `shakenShare` of the able men who would carry it out are shaken, pinned or panicked, they wait
 * `baseSeconds` + `perSuppressionSeconds` x their mean suppression, at most `maxSeconds`.
 */
function hesitationTicks(ctx: SimContext, state: SimState, p: PendingOrder): number {
  const H = ctx.catalog.behaviour.hesitation;
  if (!H || p.hesitated === true || !H.kinds.includes(p.order.kind)) return 0;
  const o = p.order;
  const isUnit = state.unit.has(o.target);
  const own = isUnit && o.own === true;
  if (isUnit) {
    if (state.unit.req(o.target).vehicle !== undefined || (!own && vehicleChildren(state, o.target).length > 0) || hasRiders(ctx, state, o.target, own)) return 0;
  } else if (state.soldier.get(o.target)?.mount !== undefined) return 0;
  // (The same men applyOrder would move: able, not routed, on foot, not busy with a casualty.)
  const men = (own ? [...state.unit.req(o.target).members].sort((a, b) => a - b) : isUnit ? unitSoldiers(state, o.target) : [o.target]).filter((m) => {
    const s = state.soldier.get(m);
    return isAble(s) && s!.mental.behaviour !== "routed" && s!.mount === undefined
      && !(isUnit && (s!.intent?.kind === "care" || s!.carrying !== undefined || s!.atNest !== undefined));
  });
  if (men.length === 0) return 0;
  let shaken = 0, supp = 0;
  for (const m of men) {
    const ms = state.soldier.req(m).mental;
    if (ms.behaviour === "shaken" || ms.behaviour === "pinned" || ms.behaviour === "panicked") shaken++;
    supp += ms.suppression;
  }
  if (shaken < H.shakenShare * men.length) return 0;
  return Math.max(1, secondsToTicks(Math.min(H.maxSeconds, H.baseSeconds + H.perSuppressionSeconds * supp / men.length)));
}

/**
 * Does order `a` reach every man order `b` reaches? A man: only himself. A unit with `own`: its own men (an order
 * to it with `own`, or to one of them). A unit: everybody under it.
 */
function ordersCover(state: SimState, a: Order, b: Order): boolean {
  const aUnit = state.unit.has(a.target), bUnit = state.unit.has(b.target);
  if (!aUnit) return !bUnit && a.target === b.target;
  const bu = bUnit ? b.target : state.identity.get(b.target)?.unit;
  if (bu === undefined) return false;
  if (a.own === true) return bu === a.target && (!bUnit || b.own === true);
  for (let u: EntityId | null = bu; u !== null; u = state.unit.get(u)?.parent ?? null) if (u === a.target) return true;
  return false;
}

/**
 * Carry out an order now, without the comms delay: the order a squad was given while aboard, once it is out
 * (Q12). A refusal is reported on the radio as for a delivered order.
 */
export function applyOrderNow(ctx: SimContext, state: SimState, order: Order, events: EventSink): void {
  const res = applyOrder(ctx, state, order, events, true);
  if (res === true) screenAfterOrder(ctx, state, order, events);
  if (res !== true) radioFromTarget(state, order.target, res === "unable" ? "radio.unable" : res === false ? "radio.noRoute" : res.unable, events);
  if (res === false) events.emit({ kind: "move.noRoute", tick: state.tick, target: order.target });
}

/** Hand smoke (D1): a unit withdrawing, or moving off under fire, screens itself (systems/smoke.ts). */
function screenAfterOrder(ctx: SimContext, state: SimState, order: Order, events: EventSink): void {
  if ((order.kind !== "withdraw" && order.kind !== "move") || !state.unit.has(order.target) || order.own === true) return;
  screenOnOrder(ctx, state, events, order.target, order.kind);
}

/** All soldiers in a unit and its sub-units, ascending ID. */
export function unitSoldiers(state: SimState, unitId: EntityId): EntityId[] {
  const out: EntityId[] = [];
  const walk = (u: EntityId) => {
    const unit = state.unit.get(u);
    if (!unit) return;
    out.push(...unit.members);
    for (const c of unit.children) walk(c);
  };
  walk(unitId);
  return out.sort((a, b) => a - b);
}

function radioFromTarget(state: SimState, target: EntityId, key: string, events: EventSink): void {
  const unitId = state.unit.has(target) ? target : state.identity.get(target)?.unit;
  if (unitId === undefined) return;
  const unit = state.unit.req(unitId);
  // The leader speaks; if he is down, the first man who still can.
  // mounted: ok the radio reaches every man
  const from = unit.leader !== null && canReport(state.soldier.get(unit.leader)) ? unit.leader : unitSoldiers(state, unitId).find((m) => canReport(state.soldier.get(m)));
  if (from === undefined) return;
  events.emit({ kind: "radio", tick: state.tick, side: unit.side, from, key, params: { callsign: unit.callsign } });
}

/**
 * Apply a delivered order. Returns false if a move order found no route, "unable" if nobody can carry it out,
 * `{unable: key}` when the reason has its own radio message (a vehicle without a driver, M7.1c).
 */
function applyOrder(ctx: SimContext, state: SimState, order: Order, events: EventSink, afterDismount = false): OrderResult {
  const isUnit = state.unit.has(order.target);
  // (A platoon's headquarters on its own, owner 2026-11-15: its own men, not its sub-units or their vehicles.)
  const own = isUnit && order.own === true;
  // The Verwundetennest (M10.5): nobody's errand or drill changes.
  if (order.kind === "casualtyPoint") return casualtyPointOrder(ctx, state, events, order.target, order.x, order.y) ? true : "unable";
  if (order.kind === "evacuate") return evacuateOrder(state, order.target) ? true : "unable";
  // An ambulance from the rear (M10.6a): the platoon's call; nothing of the unit changes.
  if (order.kind === "callAmbulance") return callAmbulanceOrder(ctx, state, events, order.target, order.player === true);
  // A combat vehicle's rear run (M10.6b): the hull's own task; an order to a hull away on one is refused, on the map
  // it ends the run.
  if (order.kind === "rearRun") return rearRunOrder(ctx, state, events, order.target);
  // Take enemy kit (M11.2): one man's errand; nothing else of the unit changes.
  if (order.kind === "takeKit") {
    const men = isUnit ? (own ? [...state.unit.req(order.target).members].sort((a, b) => a - b) : unitSoldiers(state, order.target)) : [order.target];
    return takeKitOrder(ctx, state, events, men, order.source);
  }
  const gate = rearRunGate(state, events, order);
  if (gate !== null) return gate;
  // (D4b: a halt, getting in or out, or a move of the vehicle that carries them ends an arc they were defending.)
  if (isUnit && (order.kind === "halt" || order.kind === "mount" || order.kind === "dismount" || order.kind === "move")) clearArcs(state, order.target, own);
  // A reconnaissance quadcopter (M9.4a): its own business; nobody gets out, nothing else of the unit changes.
  // (With `dismount`: its carrier, if he rides, gets out first; the order goes to him once he is out.)
  if (order.kind === "drone") {
    const rider = order.op === "fly" && order.dismount === true && !afterDismount ? droneRiderOf(ctx, state, order.target) : null;
    if (rider !== null) {
      const res = dismountThen(ctx, state, { ...order, target: rider }) ?? "unable";
      if (res === true) radioFromTarget(state, order.target, "radio.dismountFirst", events);
      return res;
    }
    return droneOrder(ctx, state, events, order.target, order.op, order.x, order.y, order.altM) ? true : "unable";
  }
  // Getting in and out (M7.2): replaces a drill or a boarding under way, like any order.
  if (order.kind === "mount" || order.kind === "dismount") {
    // (M10.5: getting in takes the wounded along, from the Verwundetennest too.)
    if (order.kind === "mount" && isUnit && !own) releaseForBoarding(ctx, state, events, order.target);
    if (own) clearOwn(state, order.target, state.unit.req(order.target).members);
    else if (isUnit) clearDrills(state, order.target);
    else { leaveBoarding(state, order.target); releaseFromParentDrills(state, state.identity.get(order.target)?.unit ?? -1, [order.target]); }
    return boardingOrder(ctx, state, order, events);
  }
  // A vehicle crew: move and halt drive the vehicle; rules and cease-fire as for any unit.
  const crewOf = isUnit ? state.unit.req(order.target).vehicle : undefined;
  if (crewOf !== undefined && order.kind === "ceaseFire") { stationCeaseFire(state, order.target, events); return true; }
  if (crewOf !== undefined && order.kind !== "rules" && order.kind !== "ambush") return vehicleOrder(ctx, state, order, crewOf);
  // Owner Q-7 (M10.7a): fire, a grenade or a fire mission at a recognised medic, ambulance, carrying party or
  // Verwundetennest is refused, and a refused order changes nothing: no drill, errand or carrying party ends, nobody
  // gets out (review fix). What men aboard know counts too.
  if (ctx.catalog.medical !== undefined) {
    const P = ctx.catalog.medical.protection;
    const hostile = order.kind === "fire" || (order.kind === "grenade" && order.smoke !== true) || (order.kind === "callFire" && order.ammo === "he");
    if (hostile) {
      // mounted: ok what men aboard know counts too
      const men = (own ? [...state.unit.req(order.target).members].sort((a, b) => a - b) : isUnit ? unitSoldiers(state, order.target) : [order.target])
        .filter((s) => isAble(state.soldier.get(s)) && state.soldier.get(s)!.mental.behaviour !== "routed"
          && !(isUnit && order.kind !== "callFire" && (state.soldier.get(s)!.intent?.kind === "care" || state.soldier.get(s)!.carrying !== undefined || state.soldier.get(s)!.atNest !== undefined)));
      const named = order.kind === "fire" ? order.contact : undefined;
      if (refusesFireAt(state, men, order.x, order.y, named, order.kind === "callFire" ? P.missionSpareM : P.aimSpareM)) return { unable: "radio.refuseProtected" };
    }
  }
  // A parent unit's vehicles (M7.1c): moves and halts are split to them; their own fire rules stay theirs.
  const vehicles = isUnit && !own ? vehicleChildren(state, order.target) : [];
  // Men still aboard (owner Q12): a squad (or a man) gets out first, then carries the order out. Orders to a
  // platoon with vehicles go to the vehicles (the squads ride along). Rules, cease-fire, a call for fire and a
  // halt need nobody to get out.
  const passThrough = order.kind === "rules" || order.kind === "ambush" || order.kind === "ceaseFire" || order.kind === "callFire" || order.kind === "halt" || order.kind === "discharge";
  if (!afterDismount && !passThrough && crewOf === undefined && vehicles.length === 0) {
    const aboard = isUnit ? hasRiders(ctx, state, order.target, own) : state.soldier.get(order.target)?.mount !== undefined;
    if (aboard) {
      if (own) clearOwn(state, order.target, state.unit.req(order.target).members);
      else if (isUnit) clearDrills(state, order.target);
      const res = dismountThen(ctx, state, order) ?? "unable";
      if (res === true) radioFromTarget(state, order.target, "radio.dismountFirst", events);
      return res;
    }
  }
  if (!isUnit && state.soldier.get(order.target)?.mount !== undefined && order.kind !== "rules" && order.kind !== "callFire") return "unable";
  if (!isUnit) leaveBoarding(state, order.target);
  // (D4b: going somewhere else ends an arc the unit was defending.)
  if (isUnit && (order.kind === "assault" || order.kind === "withdraw" || order.kind === "occupy")) clearArcs(state, order.target, own);
  let vehicleRes: OrderResult | null = null;
  if (vehicles.length > 0) vehicleRes = splitToVehicles(ctx, state, order, vehicles, events);
  // Smoke (M7.3) is the vehicles' alone: nothing else changes.
  if (order.kind === "discharge") return vehicleRes ?? "unable";
  // Only men who are alive and conscious carry out orders; casualties stay where they fell.
  // Men of a broken unit, running back, do not listen (M4.3). Men aboard vehicles ride (M7).
  // A man gone to a wounded comrade (M10.3a) stays with him, and a man carrying one (M10.4a) carries on: orders to
  // his unit pass him by (an order to him alone ends the errand, below).
  const soldiers = (own ? [...state.unit.req(order.target).members].sort((a, b) => a - b) : isUnit ? unitSoldiers(state, order.target) : [order.target]).filter((s) => isAble(state.soldier.get(s)) && state.soldier.get(s)!.mental.behaviour !== "routed" && state.soldier.get(s)!.mount === undefined
    && !(isUnit && (state.soldier.get(s)!.intent?.kind === "care" || state.soldier.get(s)!.carrying !== undefined || state.soldier.get(s)!.atNest !== undefined)));
  // Any order but a change of rules ends a drill in progress (an order to one man ends his unit's drill).
  // (Grenades are thrown in the course of a drill, e.g. before the last rush: they do not end it.)
  // An order ends a walk to take a prisoner (M6.6): orders always win.
  // (An anti-tank shot, M7.4a, is like a grenade: one man acts, the drill goes on.)
  const keepsDrill = order.kind === "rules" || order.kind === "ambush" || order.kind === "grenade" || order.kind === "callFire" || (order.kind === "fire" && order.nature === "at");
  if (!keepsDrill) {
    for (const m of soldiers) {
      const ms = state.soldier.get(m);
      if (ms?.intent?.kind === "takePrisoner" || ms?.intent?.kind === "care" || ms?.intent?.kind === "takeAmmo" || ms?.intent?.kind === "takeKit") ms.intent = null;
      if (ms?.carrying !== undefined) leaveCarry(state, m); // an order to him alone takes him out of his carrying party
    }
  }
  if (!keepsDrill) {
    const ou = isUnit ? order.target : state.identity.get(order.target)?.unit ?? -1;
    if (own) clearOwn(state, ou, soldiers);
    else if (isUnit) clearDrills(state, ou);
    releaseFromParentDrills(state, ou, soldiers);
    // (An order to one man takes him out of his own unit's drill too.)
    if (!isUnit) { const d = state.unit.get(ou)?.drill; if (d && d.kind !== "rout") dropFromDrill(d, new Set([order.target])); }
  }
  // (Rules and cease-fire reach a crew unit, or a unit whose only men are aboard, all the same.)
  const ridersOnly = isUnit && (crewOf !== undefined || vehicles.length > 0 || hasRiders(ctx, state, order.target, own)) && (order.kind === "rules" || order.kind === "ambush" || order.kind === "ceaseFire" || order.kind === "halt" || order.kind === "callFire");
  if (soldiers.length === 0 && !ridersOnly) {
    if (vehicleRes !== null) return vehicleRes; // only vehicles under it: their answer
    // Nobody left to obey: the unit is neither moving nor firing any more.
    const u = isUnit ? order.target : state.identity.get(order.target)?.unit;
    if (u !== undefined && state.unit.has(u)) { state.unit.req(u).moving = false; topUnitOf(state, u).firing = false; }
    return "unable";
  }
  switch (order.kind) {
    case "move": {
      // The unit's route is planned once from its reference man (leader, else first man), seeking cover as
      // the faction's doctrine prefers. Followers walk their formation slot alongside that route (slot offset
      // rotated with each leg), repairing legs that would cross walls or houses; at the end every man takes
      // the best cover within ~15 m of his slot, goes prone and faces outward (owner decisions 2026-11-11).
      const unit = isUnit ? state.unit.req(order.target) : null;
      const refId = unit ? (unit.leader !== null && soldiers.includes(unit.leader) ? unit.leader : soldiers[0]) : order.target;
      const ref = refId === undefined ? undefined : state.transform.get(refId);
      if (refId === undefined || !ref) return false;
      const factionId = unit ? unit.faction : state.identity.req(order.target).faction;
      const doctrine = ctx.catalog.factions[factionId];
      const coverW = doctrine?.doctrine["coverPreference"] ?? 0;
      const spacing = doctrine?.doctrine["preferredSpacingM"] ?? 8;
      const formation = ctx.catalog.formations[order.formation ?? doctrine?.defaultFormation ?? ""];
      const owps = withFloor(ctx, order.waypoints, order.floor);
      const route = routeThrough(ctx, ref.x, ref.y, owps, coverW, ref.z);
      if (!route) return false;
      const end = route[route.length - 1]!;
      const followers = soldiers.filter((s) => s !== refId);
      const assign = (s: EntityId, ws: Waypoint[], slot: [number, number] | null) => {
        const m = state.mover.get(s);
        if (!m) return;
        m.waypoints = ws;
        m.formation = slot && (slot[0] !== 0 || slot[1] !== 0) ? { leader: refId, rightM: slot[0] * spacing, backM: slot[1] * spacing } : null;
        m.slotLagM = 0;
        m.endPosture = null;
        m.endHeading = null;
      };
      // Moving ends a fire order.
      endFire(state, order.target, soldiers, "moved", events);
      // Into a building with an interior (M7.5c): no formation; each man to his own place in the room (a window
      // first), by his own route through the doors; he crouches there facing out.
      const indoor = indoorAt(ctx, end.x, end.y);
      if (indoor >= 0) {
        const spots = indoorSpots(ctx, indoor, end.x, end.y, soldiers.length, order.floor ?? 0);
        const ordered = [refId, ...followers];
        ordered.forEach((s, k) => {
          const t = state.transform.req(s), sp = spots[k]!;
          const wps = owps.map((w, i) => {
            if (i !== owps.length - 1) return w;
            const nw: Waypoint = { ...w, x: sp.x, y: sp.y };
            if (sp.z > 0) nw.z = sp.z; else delete nw.z;
            return nw;
          });
          const own = s === refId && hypot2(end.x - sp.x, end.y - sp.y) < 1e-9 && sp.z === (end.z ?? 0) ? route : routeThrough(ctx, t.x, t.y, wps, coverW, t.z);
          assign(s, (own ?? []).map((w) => ({ ...w })), null);
          const m = state.mover.get(s);
          if (m && m.waypoints.length > 0) { m.endPosture = "crouching"; m.endHeading = sp.heading; }
        });
        if (unit) { unit.moving = true; unit.moveTick = state.tick; }
        else { markUnitMoving(state, order.target); const mu = state.unit.get(state.identity.req(order.target).unit); if (mu) mu.moveTick = state.tick; }
        break;
      }
      assign(refId, route.map((w) => ({ ...w })), null);
      // Out of a building (M7.5c): men indoors come out by the doors on their own routes, then form up.
      const fromIndoors = indoorAt(ctx, ref.x, ref.y) >= 0 || followers.some((f) => { const t = state.transform.get(f); return t !== undefined && indoorAt(ctx, t.x, t.y) >= 0; });
      followers.forEach((s, k) => {
        const t = state.transform.req(s);
        const slot = formation ? slotFor(formation.slots, k + 1) : null;
        if (fromIndoors) {
          const fx = route.length >= 2 ? end.x - route[route.length - 2]!.x : end.x - ref.x, fy = route.length >= 2 ? end.y - route[route.length - 2]!.y : end.y - ref.y;
          const fl = hypot2(fx, fy) || 1, ux = fx / fl, uy = fy / fl;
          const rM = (slot?.[0] ?? 0) * spacing, bM = (slot?.[1] ?? k + 1) * spacing;
          const gx = Math.min(Math.max(end.x - uy * rM - ux * bM, 1), ctx.map.widthM - 1), gy = Math.min(Math.max(end.y + ux * rM - uy * bM, 1), ctx.map.heightM - 1);
          const wps = order.waypoints.map((w, i) => (i === order.waypoints.length - 1 ? { ...w, x: gx, y: gy } : w));
          assign(s, (routeThrough(ctx, t.x, t.y, wps, coverW, t.z) ?? routeThrough(ctx, t.x, t.y, order.waypoints, coverW, t.z) ?? []).map((w) => ({ ...w })), null);
          return;
        }
        const ws = slot
          ? formationRoute(ctx, t.x, t.y, ref.x, ref.y, route, slot[0] * spacing, slot[1] * spacing, coverW)
          : personalRoute(ctx, t.x, t.y, t.x - ref.x, t.y - ref.y, route);
        assign(s, ws, slot);
      });
      // Formation laid out at the destination (M5, the dragged marker): each man's slot, turned to the given
      // facing, spaced to the given frontage. He goes there, then takes cover close by and faces that way.
      const laid = order.facing !== undefined || order.frontageM !== undefined;
      if (laid) {
        const face = order.facing ?? (route.length >= 2 ? atan2(end.y - route[route.length - 2]!.y, end.x - route[route.length - 2]!.x) : atan2(end.y - ref.y, end.x - ref.x));
        const fx = cos(face), fy = sin(face);
        const slots = soldiers.map((s) => (s === refId ? [0, 0] as [number, number] : formation ? slotFor(formation.slots, followers.indexOf(s) + 1) : [0, 0] as [number, number]));
        const rights = slots.map((sl) => sl[0]);
        const span = Math.max(...rights) - Math.min(...rights);
        const sp = order.frontageM !== undefined && span > 1e-6 ? order.frontageM / span : spacing;
        soldiers.forEach((s, i) => {
          const m = state.mover.get(s);
          if (!m) return;
          const [r, b] = slots[i]!;
          let tx = end.x + -fy * r * sp - fx * b * sp, ty = end.y + fx * r * sp - fy * b * sp;
          tx = Math.min(Math.max(tx, 1), ctx.map.widthM - 1); ty = Math.min(Math.max(ty, 1), ctx.map.heightM - 1);
          const from = m.waypoints[m.waypoints.length - 1] ?? { ...end, x: state.transform.req(s).x, y: state.transform.req(s).y };
          if (hypot2(from.x - tx, from.y - ty) < 1) return;
          const { search } = navFor(ctx, ctx.catalog.movementModes[from.mode]?.class ?? "foot");
          const leg = routeBetween(ctx, search, from.x, from.y, tx, ty, { maxExpansions: 6000, snapCells: 3 });
          if (leg) for (let k = 0; k < leg.points.length; k += 2) m.waypoints.push({ ...from, x: leg.points[k]!, y: leg.points[k + 1]! });
        });
      }
      // Halt drill: cover near the slot, prone, facing outward from the group (or the ordered facing).
      const travel = order.facing ?? (route.length >= 2 ? atan2(end.y - route[route.length - 2]!.y, end.x - route[route.length - 2]!.x) : atan2(end.y - ref.y, end.x - ref.x));
      for (const s of soldiers) {
        const m = state.mover.get(s);
        if (!m || m.waypoints.length === 0) continue;
        const last = m.waypoints[m.waypoints.length - 1]!;
        const { grid, search } = navFor(ctx, ctx.catalog.movementModes[last.mode]?.class ?? "foot");
        // (With a laid-out formation, cover only close by, so the shape the player chose holds.)
        // (Package B: not on a place another man has taken, men keep minSpacingM apart.)
        const spot = bestCoverNear(grid, last.x, last.y, laid ? LAID_COVER_RADIUS_M : HALT_COVER_RADIUS_M, placesTaken(state, s), ctx.catalog.behaviour.soldier.minSpacingM);
        if (spot && (spot.x !== last.x || spot.y !== last.y)) {
          const leg = routeBetween(ctx, search, last.x, last.y, spot.x, spot.y, { maxExpansions: 4000, snapCells: 2 });
          // Only if it is really near on foot (not "15 m away" behind a wall that means a long detour).
          if (leg && leg.cost <= HALT_COVER_RADIUS_M * 2.5) for (let i = 0; i < leg.points.length; i += 2) m.waypoints.push({ ...last, x: leg.points[i]!, y: leg.points[i + 1]! });
        }
        // (Fire discipline, 2026-11-14: never ending on top of a man of his side, of any unit, who is there or going
        // there: within 2 x soldier.overlapM of such a place he takes the nearest free spot instead.)
        const OV = ctx.catalog.behaviour.soldier.overlapM;
        let fin = m.waypoints[m.waypoints.length - 1]!;
        if (OV > 0 && indoorAt(ctx, fin.x, fin.y) < 0 && !placeFree(placesTaken(state, s), fin.x, fin.y, 2 * OV)) {
          const p = freeSpotNear(ctx, state, s, fin.x, fin.y);
          if (p.x !== fin.x || p.y !== fin.y) {
            const leg = routeBetween(ctx, search, fin.x, fin.y, p.x, p.y, { maxExpansions: 2000, snapCells: 2 });
            if (leg && leg.cost <= HALT_COVER_RADIUS_M * 2.5) for (let i = 0; i < leg.points.length; i += 2) m.waypoints.push({ ...fin, x: leg.points[i]!, y: leg.points[i + 1]! });
            fin = m.waypoints[m.waypoints.length - 1]!;
          }
        }
        const ox = fin.x - end.x, oy = fin.y - end.y;
        m.endPosture = "prone";
        m.endHeading = laid || s === refId || ox * ox + oy * oy < 4 ? travel : atan2(oy, ox);
      }
      if (unit) { unit.moving = true; unit.moveTick = state.tick; }
      else { markUnitMoving(state, order.target); const mu = state.unit.get(state.identity.req(order.target).unit); if (mu) mu.moveTick = state.tick; }
      break;
    }
    case "occupy": {
      // Occupy a building (M7.5d): every man to a window place (or one inside), no formation.
      endFire(state, order.target, soldiers, "moved", events);
      const bi = buildingIndex(ctx, order.building);
      if (occupyBuilding(ctx, state, soldiers, bi, order.floor, order.facing, order.windowIndex, order.mode) === 0) return false;
      if (isUnit) { const u = state.unit.req(order.target); u.moving = true; u.moveTick = state.tick; }
      else { markUnitMoving(state, order.target); const mu = state.unit.get(state.identity.req(order.target).unit); if (mu) mu.moveTick = state.tick; }
      break;
    }
    case "deploy": {
      // Stop and set up each mortar team (M8.3a; M9.3b: and missile team): the men's moves end where they are.
      let ok = false;
      for (const team of crewServedTeamsUnder(state, order.target)) {
        const tu = state.unit.get(team)!;
        for (const s of tu.members) { const m = state.mover.get(s); if (m) { m.waypoints = []; m.speedMps = 0; m.formation = null; } }
        stopUnit(state, team);
        if (startSetup(ctx, state, events, team)) ok = true;
      }
      return ok ? true : "unable";
    }
    case "halt": {
      for (const s of soldiers) {
        const m = state.mover.get(s);
        if (m) { m.waypoints = []; m.speedMps = 0; m.formation = null; m.endPosture = null; m.endHeading = null; }
      }
      stopUnit(state, order.target);
      break;
    }
    case "fire": {
      // (Owner Q-7: a fire order at recognised protected people was refused above, before anything changed.)
      if (order.nature === "at") {
        // One anti-tank round (M7.4a): the best-placed man with a loaded launcher fires; the others carry on.
        const named = order.contact !== undefined && state.identity.get(order.contact)?.side !== order.issuer && (state.soldier.has(order.contact) || state.vehicle.has(order.contact)) ? order.contact : undefined;
        // M9.3b: missile teams at or under the unit fire their post (setting it up first if packed).
        const teams = (own ? [] : crewServedTeamsUnder(state, order.target)).filter((u) => crewServedKind(state, u) === "missile");
        if (teams.length > 0) {
          const stop = (team: EntityId): void => {
            const tu = state.unit.get(team)!;
            for (const s of tu.members) { const m = state.mover.get(s); if (m) { m.waypoints = []; m.speedMps = 0; m.formation = null; } }
            stopUnit(state, team);
          };
          const setup = (team: EntityId): boolean => startSetup(ctx, state, events, team);
          if (teamOrderShot(ctx, state, teams, order.x, order.y, named, stop, setup)) return true;
        }
        return orderLauncherShot(ctx, state, events, soldiers, order.x, order.y, named) ? true : "unable";
      }
      // M7.6d: automatic grenade launcher teams at or under the unit fire their gun at the point (setting it up
      // first if packed); their gunners are busy with it, the other men fire as below.
      const agl = own ? [] : crewServedTeamsUnder(state, order.target).filter((u) => crewServedKind(state, u) === "agl");
      let aglAny = false;
      const aglGunners = new Set<EntityId>();
      if (agl.length > 0) {
        const stop = (team: EntityId): void => {
          const tu = state.unit.get(team)!;
          for (const s of tu.members) { const m = state.mover.get(s); if (m) { m.waypoints = []; m.speedMps = 0; m.formation = null; } }
          stopUnit(state, team);
        };
        for (const team of aglOrderFire(ctx, state, agl, order.x, order.y, stop, (team) => startSetup(ctx, state, events, team))) {
          aglAny = true;
          const g = aglOf(ctx, state, team);
          if (g) aglGunners.add(g.carrier);
        }
      }
      // Stop where they are and open fire; each man keeps his posture (order a posture first if wanted).
      stopUnit(state, order.target);
      let any = false;
      for (const s of soldiers) {
        const m = state.mover.get(s);
        if (m) { m.waypoints = []; m.speedMps = 0; m.formation = null; m.endPosture = null; m.endHeading = null; }
        if (aglGunners.has(s)) continue; // (M7.6d: he works the gun)
        // At a contact: where this man believes the enemy to be, else the point given with the order (what
        // comrades know reaches him only through contact sharing).
        let x = order.x, y = order.y, known: Contact | undefined;
        // (A contact naming a man who is dead or of the issuer's own side is simply ignored: rejecting the order
        // would tell the player something his men do not know.)
        const named = order.contact !== undefined && state.soldier.get(order.contact)?.physiology.alive === true && state.identity.get(order.contact)?.side !== order.issuer ? order.contact : undefined;
        if (named !== undefined) {
          const c = state.soldier.get(s)?.contacts.find((k) => k.target === named);
          // A man who knows the named enemy has given up (M6.6) halts with the others but does not fire at him.
          if (c?.surrendered === true || c?.down === true) continue;
          if (c) { x = c.x; y = c.y; known = c; }
        }
        if (assignFireTask(ctx, state, s, x, y, order.heightM ?? aimHeightAt(ctx, known), order.player === true)) {
          any = true;
          const ft = state.fire.get(s);
          if (ft && named !== undefined) { ft.contact = named; if (order.heightM === undefined) ft.aimAuto = true; else delete ft.aimAuto; }
          else if (ft) delete ft.aimAuto;
          // (Ordered fire is covering fire: it may go into the cover the enemy is behind, overnight pick "covering-fire".)
          if (ft) ft.suppress = "order";
        }
      }
      const u = state.unit.has(order.target) ? order.target : state.identity.get(order.target)?.unit;
      if (!any && !aglAny) return vehicleRes ?? "unable"; // nobody there has a weapon he can use (its vehicles may)
      if (u !== undefined) { const top = topUnitOf(state, u); top.firing = true; top.lineBlockedReported = false; }
      break;
    }
    case "ceaseFire": {
      endFire(state, order.target, soldiers, "ordered", events);
      // They hold their fire until they are fired upon again (M4.2).
      const cu = state.unit.has(order.target) ? order.target : state.identity.get(order.target)?.unit;
      if (cu !== undefined) topUnitOf(state, cu).ceaseFireTick = state.tick;
      // Its vehicles (M7.3): only an order to their own platoon (or a unit above them) reaches them (plan C19).
      for (const c of vehicles) stationCeaseFire(state, c, events);
      break;
    }
    case "assault":
    case "withdraw": {
      const du = isUnit ? order.target : state.identity.get(order.target)?.unit;
      if (du === undefined) return "unable";
      endFire(state, order.target, soldiers, "moved", events);
      stopUnit(state, order.target);
      const groups = drillGroups(state, du);
      if (groups.length === 0) return "unable";
      state.unit.req(du).drill = order.kind === "assault" && order.building !== undefined
        ? startClear(ctx, state, du, order.building, groups)
        : { kind: order.kind, x: order.x, y: order.y, groups, mover: 0, phaseTick: -1, final: false };
      break;
    }
    case "callFire": {
      // (Owner Q-7: no high explosive where the enemy they know is only protected people: refused above.)
      // The leader calls it (or whoever of the unit can still use the radio); the unit keeps doing what it did.
      const cu = isUnit ? order.target : state.identity.get(order.target)?.unit;
      const u = cu !== undefined ? state.unit.get(cu) : undefined;
      // (A unit: its leader first if he is one of the men who can act; one man: only he.)
      // (Men aboard can use the radio too.)
      // mounted: ok a call for fire goes over the radio from inside a vehicle as well
      const all = isUnit ? (own ? [...state.unit.req(order.target).members].sort((a, b) => a - b) : unitSoldiers(state, order.target)).filter((s) => isAble(state.soldier.get(s)) && state.soldier.get(s)!.mental.behaviour !== "routed") : soldiers.length > 0 ? soldiers : [order.target];
      const callers = isUnit && u && u.leader !== null && all.includes(u.leader) ? [u.leader, ...all] : all;
      const cf = callFire(ctx, state, events, order.issuer, callers, order.x, order.y, order.ammo, order.rounds, order.x2 !== undefined && order.y2 !== undefined ? { x2: order.x2, y2: order.y2 } : undefined,
        { ...(order.asset === "artillery" ? { asset: "artillery" as const } : {}), ...(order.fuse ? { fuse: order.fuse } : {}), ...(order.dangerClose ? { dangerClose: true } : {}) });
      if (cf === "range") return { unable: "radio.fireOutOfRange" };
      if (cf === "dangerClose") return { unable: "radio.fireDangerClose" };
      if (cf === "moving") return { unable: "radio.batteryMoving" };
      if (cf === "guided") return { unable: "radio.guidedNotYet" };
      if (cf === "noFuse") return { unable: "radio.noAirburst" };
      if (!cf) return "unable";
      break;
    }
    case "rules": {
      const ru = state.unit.has(order.target) ? order.target : state.identity.get(order.target)?.unit;
      const set = (u: EntityId) => {
        const x = state.unit.get(u);
        if (!x) return;
        if (order.fire !== undefined) x.fireRule = order.fire;
        // (A vehicle under the unit keeps its own engagement range unless the order names it, M7.1c.)
        if (order.maxEngageM !== undefined && (x.vehicle === undefined || u === order.target)) x.maxEngageM = order.maxEngageM;
        if (order.onContact !== undefined) x.onContact = order.onContact;
        if (order.ammo !== undefined) x.ammoRule = order.ammo;
        if (order.at !== undefined) x.atRule = order.at;
        // (A new fire rule ends an ambush laid, D4b: the player has decided otherwise.)
        if (order.fire !== undefined) delete x.ambush;
        if (!own) x.children.forEach(set);
      };
      // (With `own` too: the sub-units holding the same ambush as the target lose it with it, or they would hold
      // fire for an ambush nobody can spring any more.)
      const laid = ru !== undefined && order.fire !== undefined ? state.unit.get(ru)?.ambush?.root : undefined;
      if (laid !== undefined) forTree(state, ru!, false, (x) => { if (x.ambush?.root === laid) delete x.ambush; });
      if (ru !== undefined) set(ru);
      break;
    }
    case "ambush": {
      // Lay an ambush (D4b): whatever they were firing at, they stop; from now on the ambush governs their fire
      // (systems/ambush.ts springs it). A cease-fire before it no longer holds them once it is sprung.
      endFire(state, order.target, soldiers, "ordered", events);
      const lay = { rangeM: order.rangeM, tick: state.tick, root: order.target };
      forTree(state, order.target, own, (x, uid) => {
        if (x.vehicle !== undefined) stationCeaseFire(state, uid, events);
        x.ambush = { ...lay };
        x.fireRule = "free";
        if (x.parent !== null) x.ceaseFireTick = -1e9; // (a crew's own, gunnery.ts; the top unit's below)
      });
      // A cease-fire is read from the top unit for every man of the platoon (decisions.ts fireAllowed): only an
      // ambush on the whole platoon (the top unit, not its headquarters alone) lifts it. One on part of it leaves the others' cease-fire alone (its own men
      // stay held by it too, until they are fired on).
      if (state.unit.req(order.target).parent === null && !own) state.unit.req(order.target).ceaseFireTick = -1e9;
      break;
    }
    case "defendArc": {
      // Defend an arc (D4b): the men stop where they are and face it; the arc limits their own fire (decisions.ts).
      stopUnit(state, order.target);
      const arc = { facing: wrapAngle(order.facing), halfRad: order.widthRad / 2 };
      forTree(state, order.target, own, (x) => { x.arc = { ...arc }; });
      for (const s of soldiers) {
        const m = state.mover.get(s);
        if (m) { m.waypoints = []; m.speedMps = 0; m.formation = null; m.endPosture = null; m.endHeading = null; }
        // (Indoors his window place sets his facing.)
        const t = state.transform.get(s);
        if (t && !state.fire.has(s) && indoorAt(ctx, t.x, t.y) < 0) t.heading = arc.facing;
      }
      break;
    }
    case "grenade": {
      // The best-placed men act: throwers in range first (nearest first), then men with a launcher (nearest
      // first). Each further man lets go a moment later, so the grenades do not all burst in the same instant.
      const able: { id: EntityId; opt: GrenadeOption }[] = [];
      let blocked = 0;
      for (const s of soldiers) {
        const opt = grenadeOption(ctx, state, s, order.x, order.y, order.smoke === true);
        // (A man who has no way to get it there from where he is — a wall, a roof — is not picked, package D.)
        if (opt && !throwArcExists(ctx, state, s, opt.ammo, order.x, order.y)) { blocked++; continue; }
        if (opt) able.push({ id: s, opt });
      }
      // Out of range, too close, or nothing to send; or no way to get it there (he keeps it and says so).
      if (able.length === 0) return blocked > 0 ? { unable: "radio.grenadeBlocked" } : "unable";
      able.sort((p, q) => (p.opt.method === q.opt.method ? p.opt.distanceM - q.opt.distanceM || p.id - q.id : p.opt.method === "thrown" ? -1 : 1));
      const G = ctx.catalog.shooting.grenades;
      able.slice(0, order.count ?? 1).forEach(({ id, opt }, k) => {
        const t = state.transform.req(id);
        t.heading = atan2(order.y - t.y, order.x - t.x);
        // A man on the move stops to throw (package D: before, a running man's throw was broken off at once).
        const mv = state.mover.get(id);
        if (mv && mv.waypoints.length > 0) { mv.waypoints = []; mv.speedMps = 0; mv.formation = null; mv.endPosture = null; mv.endHeading = null; }
        startAction(state, events, id, "grenade", secondsToTicks((opt.method === "thrown" ? G.throwSeconds : G.launchSeconds) + k * G.staggerSeconds), { ammo: opt.ammo, x: order.x, y: order.y });
      });
      break;
    }
    case "posture": {
      stopUnit(state, order.target);
      for (const s of soldiers) {
        const m = state.mover.get(s);
        if (m) { m.waypoints = []; m.speedMps = 0; m.formation = null; m.endPosture = null; m.endHeading = null; }
        requestPosture(ctx, state, s, order.posture);
        const ss = state.soldier.get(s);
        if (ss) ss.homePosture = order.posture; // (his posture from now on, package C)
        // A man firing keeps firing; this is now the posture he goes back down to.
        const ft = state.fire.get(s);
        if (ft) ft.basePosture = order.posture;
      }
      break;
    }
  }
  void events;
  return true;
}

/** An order to a unit's own men (`own`): they leave its drill (the sub-units carry on with it), and its getting
 *  in or out is replaced (not a bail-out). */
function clearOwn(state: SimState, uid: EntityId, men: readonly EntityId[]): void {
  const u = state.unit.get(uid);
  if (!u) return;
  if (u.drill && u.drill.kind !== "rout") {
    dropFromDrill(u.drill, new Set(men));
    if (u.drill.groups.every((g) => g.length === 0)) u.drill = null;
  }
  if (u.boarding && u.boarding.kind !== "bailOut") delete u.boarding;
}

/** Crew units under a unit (not the unit itself), ID order. */
function vehicleChildren(state: SimState, unit: EntityId): EntityId[] {
  const out: EntityId[] = [];
  const walk = (u: EntityId) => {
    for (const c of state.unit.get(u)?.children ?? []) {
      const cu = state.unit.get(c);
      if (!cu) continue;
      if (cu.vehicle !== undefined) out.push(c); else walk(c);
    }
  };
  walk(unit);
  return out.sort((a, b) => a - b);
}

/** Lateral spacing of the vehicles of one move order at its end, m. */
const VEHICLE_SLOT_M = 12;

/**
 * A parent's order to the vehicles under it (plan §11): a move gives each its own route to a slot 12 m apart
 * across the last leg, at the vehicle pace its foot pace maps to; a halt stops them; other orders are for the
 * men (fire rules reach them through the rules cascade).
 */
function splitToVehicles(ctx: SimContext, state: SimState, order: Order, crews: EntityId[], events: EventSink): OrderResult | null {
  if (order.kind === "halt") {
    for (const c of crews) { const v = state.unit.get(c)?.vehicle; if (v !== undefined) { noteVehicleOrder(state, v, order); vehicleHalt(state, v); } }
    return true;
  }
  // Anti-tank rounds are the men's (M7.4a); an order to a crew itself fires its guided missile (owner 2026-11-13).
  if (order.kind === "fire" && order.nature === "at" && state.unit.get(order.target)?.vehicle === undefined) return null;
  if (order.kind === "fire" || order.kind === "discharge") {
    // Fire (M7.3): every vehicle under the unit engages too; smoke: every vehicle fires a salvo.
    let res: OrderResult | null = null;
    for (const c of crews) {
      const vid = state.unit.get(c)?.vehicle;
      if (vid === undefined) continue;
      const r = order.kind === "fire" ? stationFireOrder(ctx, state, vid, order, order.issuer) : dischargeSmoke(ctx, state, vid);
      if (res !== true) res = r;
    }
    return res;
  }
  if (order.kind !== "move") return null;
  const last = order.waypoints[order.waypoints.length - 1]!;
  const prev = order.waypoints.length >= 2 ? order.waypoints[order.waypoints.length - 2]! : null;
  let any: OrderResult | null = null;
  crews.forEach((c, k) => {
    const vid = state.unit.get(c)?.vehicle;
    if (vid === undefined) return;
    noteVehicleOrder(state, vid, order);
    const t = state.transform.req(vid);
    const fx0 = prev ? last.x - prev.x : last.x - t.x, fy0 = prev ? last.y - prev.y : last.y - t.y;
    const fl = hypot2(fx0, fy0) || 1, fx = fx0 / fl, fy = fy0 / fl;
    const side = k % 2 === 0 ? 1 : -1, rank = Math.ceil(k / 2) + (crews.length % 2 === 0 ? 0.5 : 0);
    const off = (crews.length === 1 ? 0 : side * rank * VEHICLE_SLOT_M);
    const shift = (w: Waypoint): Waypoint => ({ ...w, x: Math.min(Math.max(w.x - fy * off, 1), ctx.map.widthM - 1), y: Math.min(Math.max(w.y + fx * off, 1), ctx.map.heightM - 1) });
    const res = vehicleMove(ctx, state, vid, order.waypoints.map(shift), order.facing);
    if (res !== true) radioFromTarget(state, c, res === false ? "radio.noRoute" : res === "unable" ? "radio.unable" : res.unable, events);
    if (any !== true) any = res;
  });
  return any;
}

/**
 * Path through the order's waypoints (each leg with its own mode). null if any leg has no route. `sz`: the man's
 * height above the ground (M7.5d: upstairs); each waypoint's own `z` is the floor it lies on.
 */
function routeThrough(ctx: SimContext, x: number, y: number, wps: readonly Waypoint[], coverW = 0, sz = 0): Waypoint[] | null {
  const out: Waypoint[] = [];
  let px = x, py = y, pz = sz;
  for (const w of wps) {
    const mode = ctx.catalog.movementModes[w.mode];
    if (!mode) return null;
    const { search } = navFor(ctx, mode.class, coverW);
    const p = pz > 0 || (w.z ?? 0) > 0 ? routeBetween(ctx, search, px, py, w.x, w.y, {}, { sz: pz, gz: w.z ?? 0 }) : routeBetween(ctx, search, px, py, w.x, w.y);
    if (!p) return null;
    out.push(...routeWaypoints(p, w));
    px = p.goalX; py = p.goalY; pz = p.zs ? p.zs[p.zs.length - 1]! : 0;
  }
  return out;
}

/** The order's waypoints with the last one on floor `floor` of the building it lies in (M7.5d). */
function withFloor(ctx: SimContext, wps: readonly Waypoint[], floor: number | undefined): Waypoint[] {
  if (!floor) return wps as Waypoint[];
  const last = wps[wps.length - 1]!;
  const bi = indoorAt(ctx, last.x, last.y);
  if (bi < 0) return wps as Waypoint[];
  const b = ctx.map.buildings[bi]!;
  return wps.map((w, i) => (i === wps.length - 1 ? { ...w, z: floorAtZ(b, floor * b.storeyHeightM) * b.storeyHeightM } : w));
}

/** Slot `i` of a formation; beyond the listed slots, extra men extend the last slot straight back. */
function slotFor(slots: readonly [number, number][], i: number): [number, number] {
  if (i < slots.length) return slots[i]!;
  const last = slots[slots.length - 1]!;
  return [last[0], last[1] + (i - slots.length + 1)];
}

/** Radius within which each man looks for cover when the unit halts (owner decision: ~15 m). */
const HALT_COVER_RADIUS_M = 15;
/** The same when the player laid the formation out himself (M5): cover only this close to his slot. */
const LAID_COVER_RADIUS_M = 4;

/**
 * A follower's route in formation: each reference-route point shifted by his slot (right/back of the leg's
 * direction). Shifted points that land on blocked ground are moved to the nearest open cell; legs that would
 * cross a wall or house are repaired with a search. Falls back to joining the reference route.
 */
function formationRoute(ctx: SimContext, x: number, y: number, rx: number, ry: number, route: Waypoint[], rightM: number, backM: number, coverW: number): Waypoint[] {
  const first = route[0]!;
  const mode = ctx.catalog.movementModes[first.mode];
  const cls = mode ? mode.class : "foot";
  const plain = navFor(ctx, cls).grid;
  const { search } = navFor(ctx, cls, coverW);
  const out: Waypoint[] = [];
  let px = x, py = y, prevX = rx, prevY = ry;
  for (const w of route) {
    const hx = w.x - prevX, hy = w.y - prevY;
    const len = hypot2(hx, hy) || 1;
    const fx = hx / len, fy = hy / len; // forward
    let qx = w.x + -fy * rightM - fx * backM, qy = w.y + fx * rightM - fy * backM; // right = (-fy, fx)
    if (navCostAt(plain, qx, qy) <= 0 || plain.wall[Math.floor(qy / plain.cellM) * plain.cols + Math.floor(qx / plain.cellM)] === 1) {
      const cell = nearestPassable(plain, Math.min(Math.max(qx, 0), plain.cols * plain.cellM - 0.01), Math.min(Math.max(qy, 0), plain.rows * plain.cellM - 0.01), 4, plain.region[Math.floor(w.y / plain.cellM) * plain.cols + Math.floor(w.x / plain.cellM)]);
      if (cell < 0) { qx = w.x; qy = w.y; } else { qx = ((cell % plain.cols) + 0.5) * plain.cellM; qy = (Math.floor(cell / plain.cols) + 0.5) * plain.cellM; }
    }
    if (clearLine(plain, px, py, qx, qy)) {
      out.push({ ...w, x: qx, y: qy });
    } else {
      const leg = routeBetween(ctx, search, px, py, qx, qy, { maxExpansions: 6000, snapCells: 3 }) ?? routeBetween(ctx, search, px, py, qx, qy);
      if (!leg) return personalRoute(ctx, x, y, x - rx, y - ry, route);
      for (let i = 0; i < leg.points.length; i += 2) out.push({ ...w, x: leg.points[i]!, y: leg.points[i + 1]! });
      qx = leg.goalX; qy = leg.goalY;
    }
    px = qx; py = qy; prevX = w.x; prevY = w.y;
  }
  return out;
}

/**
 * A follower's route: join the reference route at its start, follow it, then go to the destination plus
 * his offset. Joins and the final leg are short bounded searches; if they fail he just follows the route.
 */
function personalRoute(ctx: SimContext, x: number, y: number, ox: number, oy: number, route: Waypoint[]): Waypoint[] {
  const first = route[0]!, last = route[route.length - 1]!;
  const mode = ctx.catalog.movementModes[last.mode];
  const { grid, search } = navFor(ctx, mode ? mode.class : "foot");
  // Open ground: walk a parallel copy of the reference route, keeping the formation's shape.
  const shifted = route.map((w) => ({ ...w, x: w.x + ox, y: w.y + oy }));
  let px = x, py = y, parallel = true;
  for (const w of shifted) {
    if (!clearLine(grid, px, py, w.x, w.y)) { parallel = false; break; }
    px = w.x; py = w.y;
  }
  if (parallel) return shifted;
  // Otherwise join the reference route, follow it, and leave it for his own spot at the end.
  const out: Waypoint[] = [];
  // Join the route: a quick bounded search first, then a full one. Never an unchecked straight line.
  const join = routeBetween(ctx, search, x, y, first.x, first.y, { maxExpansions: 3000 }) ?? routeBetween(ctx, search, x, y, first.x, first.y);
  if (!join) return []; // cannot reach the route at all: he stays where he is
  for (let i = 0; i + 2 < join.points.length; i += 2) out.push({ ...first, x: join.points[i]!, y: join.points[i + 1]! });
  for (const w of route) out.push({ ...w });
  const end = routeBetween(ctx, search, last.x, last.y, last.x + ox, last.y + oy, { maxExpansions: 3000, snapCells: 4 });
  if (end) for (let i = 0; i < end.points.length; i += 2) out.push({ ...last, x: end.points[i]!, y: end.points[i + 1]! });
  return out;
}

/** Call `f` on a unit and (unless `own`: its own men only) every unit under it, parents first. */
function forTree(state: SimState, uid: EntityId, own: boolean, f: (u: Unit, id: EntityId) => void): void {
  const u = state.unit.get(uid);
  if (!u) return;
  f(u, uid);
  if (!own) for (const c of u.children) forTree(state, c, false, f);
}

/** End the arcs (D4b) of a unit and (unless `own`) its sub-units; a crew's: of the units of the men it carries. */
function clearArcs(state: SimState, uid: EntityId, own: boolean): void {
  forTree(state, uid, own, (x) => { delete x.arc; });
  const vid = state.unit.get(uid)?.vehicle;
  if (vid === undefined) return;
  // mounted: ok the men aboard that hull
  for (const [id, s] of state.soldier.entries()) {
    if (s.mount?.vehicle !== vid) continue;
    // (Their own unit's alone: a man's arc is read from it, decisions.ts.)
    const u = state.identity.get(id)?.unit;
    if (u !== undefined) { const x = state.unit.get(u); if (x) delete x.arc; }
  }
}

function topUnitOf(state: SimState, unit: EntityId): Unit {
  let u = state.unit.req(unit);
  while (u.parent !== null) u = state.unit.req(u.parent);
  return u;
}

/** Remove the fire tasks of these soldiers; report once if their unit was firing. */
function endFire(state: SimState, target: EntityId, soldiers: EntityId[], reason: "ordered" | "moved", events: EventSink): void {
  let had = false;
  for (const s of soldiers) if (state.fire.has(s)) { state.fire.delete(s); had = true; }
  const uid = state.unit.has(target) ? target : state.identity.get(target)?.unit;
  if (uid === undefined) return;
  let top = uid;
  for (let p = state.unit.get(top)?.parent ?? null; p !== null; p = state.unit.get(top)?.parent ?? null) top = p;
  const unit = state.unit.req(top);
  // mounted: ok fire tasks belong to men on foot only
  if (unit.firing && !unitSoldiers(state, top).some((m) => state.fire.has(m))) {
    unit.firing = false;
    if (had) events.emit({ kind: "fire.ceased", tick: state.tick, unit: top, reason });
  }
}

/** A halted unit is no longer "moving", so no "in position" report follows. */
function stopUnit(state: SimState, target: EntityId): void {
  const u = state.unit.has(target) ? target : state.identity.get(target)?.unit;
  if (u !== undefined) state.unit.req(u).moving = false;
}

function markUnitMoving(state: SimState, soldier: EntityId): void {
  const u = state.identity.get(soldier)?.unit;
  if (u !== undefined) state.unit.req(u).moving = true;
}

export { radioFromTarget };

/** The crew-served teams (mortar teams, M8.3a; missile teams, M9.3b) at or under a unit, ascending id. */
function crewServedTeamsUnder(state: SimState, uid: EntityId): EntityId[] {
  const out: EntityId[] = [];
  const walk = (u: EntityId) => {
    const unit = state.unit.get(u);
    if (!unit) return;
    if (unit.mortar !== undefined || unit.missileTeam !== undefined) out.push(u);
    for (const c of unit.children) walk(c);
  };
  walk(uid);
  return out.sort((a, b) => a - b);
}
