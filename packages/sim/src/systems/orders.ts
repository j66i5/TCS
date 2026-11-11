/**
 * Order pipeline: inbox (issued) -> validation -> comms delay (pending) -> delivery (applied).
 */
import type { SimContext } from "../context";
import type { EventSink } from "../events";
import type { EntityId } from "../ids";
import type { Order, OrderRejectReason, PendingOrder, Waypoint } from "../orders";
import { bestCoverNear, clearLine, findPath, navCostAt, nearestPassable } from "../nav";
import { atan2, hypot2 } from "../math";
import { canReport, isAble } from "../impair";
import { navFor } from "../navctx";
import { requestPosture } from "./body";
import { assignFireTask } from "./fire";
import type { Unit } from "../components";
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
  switch (o.kind) {
    case "move":
      if (o.waypoints.length === 0 || o.waypoints.length > 64) return "invalid-params";
      for (const w of o.waypoints) {
        if (!Number.isFinite(w.x) || !Number.isFinite(w.y)) return "invalid-params";
        if (w.x < 0 || w.y < 0 || w.x > ctx.map.widthM || w.y > ctx.map.heightM) return "invalid-params";
        if (!ctx.catalog.movementModes[w.mode]) return "invalid-params";
        if (w.posture !== undefined && w.posture !== "standing" && w.posture !== "crouching" && w.posture !== "prone") return "invalid-params";
      }
      if (o.formation !== undefined && !ctx.catalog.formations[o.formation]) return "invalid-params";
      return null;
    case "halt":
      return null;
    case "posture":
      return o.posture === "standing" || o.posture === "crouching" || o.posture === "prone" ? null : "invalid-params";
    case "fire":
      if (!Number.isFinite(o.x) || !Number.isFinite(o.y) || o.x < 0 || o.y < 0 || o.x > ctx.map.widthM || o.y > ctx.map.heightM) return "invalid-params";
      if (o.heightM !== undefined && !(o.heightM >= 0 && o.heightM <= 50)) return "invalid-params";
      return null;
    case "ceaseFire":
      return null;
  }
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
  for (const p of due) {
    const res = applyOrder(ctx, state, p.order, events);
    events.emit({ kind: "order.delivered", tick: state.tick, seq: p.seq, target: p.order.target, orderKind: p.order.kind });
    radioFromTarget(state, p.order.target, res === true ? `radio.ack.${p.order.kind}` : res === "unable" ? "radio.unable" : "radio.noRoute", events);
    if (res === false) events.emit({ kind: "move.noRoute", tick: state.tick, target: p.order.target });
  }
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
  const from = unit.leader !== null && canReport(state.soldier.get(unit.leader)) ? unit.leader : unitSoldiers(state, unitId).find((m) => canReport(state.soldier.get(m)));
  if (from === undefined) return;
  events.emit({ kind: "radio", tick: state.tick, side: unit.side, from, key, params: { callsign: unit.callsign } });
}

/** Apply a delivered order. Returns false if a move order found no route, "unable" if nobody can carry it out. */
function applyOrder(ctx: SimContext, state: SimState, order: Order, events: EventSink): boolean | "unable" {
  const isUnit = state.unit.has(order.target);
  // Only men who are alive and conscious carry out orders; casualties stay where they fell.
  const soldiers = (isUnit ? unitSoldiers(state, order.target) : [order.target]).filter((s) => isAble(state.soldier.get(s)));
  if (soldiers.length === 0) {
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
      const route = routeThrough(ctx, ref.x, ref.y, order.waypoints, coverW);
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
      assign(refId, route.map((w) => ({ ...w })), null);
      followers.forEach((s, k) => {
        const t = state.transform.req(s);
        const slot = formation ? slotFor(formation.slots, k + 1) : null;
        const ws = slot
          ? formationRoute(ctx, t.x, t.y, ref.x, ref.y, route, slot[0] * spacing, slot[1] * spacing, coverW)
          : personalRoute(ctx, t.x, t.y, t.x - ref.x, t.y - ref.y, route);
        assign(s, ws, slot);
      });
      // Halt drill: cover near the slot, prone, facing outward from the group.
      const travel = route.length >= 2 ? atan2(end.y - route[route.length - 2]!.y, end.x - route[route.length - 2]!.x) : atan2(end.y - ref.y, end.x - ref.x);
      for (const s of soldiers) {
        const m = state.mover.get(s);
        if (!m || m.waypoints.length === 0) continue;
        const last = m.waypoints[m.waypoints.length - 1]!;
        const { grid, search } = navFor(ctx, ctx.catalog.movementModes[last.mode]?.class ?? "foot");
        const spot = bestCoverNear(grid, last.x, last.y, HALT_COVER_RADIUS_M);
        if (spot && (spot.x !== last.x || spot.y !== last.y)) {
          const leg = findPath(search, last.x, last.y, spot.x, spot.y, { maxExpansions: 4000, snapCells: 2 });
          // Only if it is really near on foot (not "15 m away" behind a wall that means a long detour).
          if (leg && leg.cost <= HALT_COVER_RADIUS_M * 2.5) for (let i = 0; i < leg.points.length; i += 2) m.waypoints.push({ ...last, x: leg.points[i]!, y: leg.points[i + 1]! });
        }
        const fin = m.waypoints[m.waypoints.length - 1]!;
        const ox = fin.x - end.x, oy = fin.y - end.y;
        m.endPosture = "prone";
        m.endHeading = s === refId || ox * ox + oy * oy < 4 ? travel : atan2(oy, ox);
      }
      if (unit) unit.moving = true;
      else markUnitMoving(state, order.target);
      break;
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
      // Stop where they are and open fire; each man keeps his posture (order a posture first if wanted).
      stopUnit(state, order.target);
      let any = false;
      for (const s of soldiers) {
        const m = state.mover.get(s);
        if (m) { m.waypoints = []; m.speedMps = 0; m.formation = null; m.endPosture = null; m.endHeading = null; }
        if (assignFireTask(ctx, state, s, order.x, order.y, order.heightM ?? ctx.catalog.shooting.fire.aimPointHeightM)) any = true;
      }
      const u = state.unit.has(order.target) ? order.target : state.identity.get(order.target)?.unit;
      if (!any) return "unable"; // nobody there has a weapon he can use
      if (u !== undefined) topUnitOf(state, u).firing = true;
      break;
    }
    case "ceaseFire": {
      endFire(state, order.target, soldiers, "ordered", events);
      break;
    }
    case "posture": {
      stopUnit(state, order.target);
      for (const s of soldiers) {
        const m = state.mover.get(s);
        if (m) { m.waypoints = []; m.speedMps = 0; m.formation = null; m.endPosture = null; m.endHeading = null; }
        requestPosture(ctx, state, s, order.posture);
      }
      break;
    }
  }
  void events;
  return true;
}

/** Path through the order's waypoints (each leg with its own mode). null if any leg has no route. */
function routeThrough(ctx: SimContext, x: number, y: number, wps: readonly Waypoint[], coverW = 0): Waypoint[] | null {
  const out: Waypoint[] = [];
  let px = x, py = y;
  for (const w of wps) {
    const mode = ctx.catalog.movementModes[w.mode];
    if (!mode) return null;
    const { search } = navFor(ctx, mode.class, coverW);
    const p = findPath(search, px, py, w.x, w.y);
    if (!p) return null;
    for (let i = 0; i < p.points.length; i += 2) out.push({ ...w, x: p.points[i]!, y: p.points[i + 1]! });
    px = p.goalX; py = p.goalY;
  }
  return out;
}

/** Slot `i` of a formation; beyond the listed slots, extra men extend the last slot straight back. */
function slotFor(slots: readonly [number, number][], i: number): [number, number] {
  if (i < slots.length) return slots[i]!;
  const last = slots[slots.length - 1]!;
  return [last[0], last[1] + (i - slots.length + 1)];
}

/** Radius within which each man looks for cover when the unit halts (owner decision: ~15 m). */
const HALT_COVER_RADIUS_M = 15;

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
      const leg = findPath(search, px, py, qx, qy, { maxExpansions: 6000, snapCells: 3 }) ?? findPath(search, px, py, qx, qy);
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
  const join = findPath(search, x, y, first.x, first.y, { maxExpansions: 3000 }) ?? findPath(search, x, y, first.x, first.y);
  if (!join) return []; // cannot reach the route at all: he stays where he is
  for (let i = 0; i + 2 < join.points.length; i += 2) out.push({ ...first, x: join.points[i]!, y: join.points[i + 1]! });
  for (const w of route) out.push({ ...w });
  const end = findPath(search, last.x, last.y, last.x + ox, last.y + oy, { maxExpansions: 3000, snapCells: 4 });
  if (end) for (let i = 0; i < end.points.length; i += 2) out.push({ ...last, x: end.points[i]!, y: end.points[i + 1]! });
  return out;
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
