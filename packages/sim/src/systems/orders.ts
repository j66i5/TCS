/**
 * Order pipeline: inbox (issued) -> validation -> comms delay (pending) -> delivery (applied).
 */
import type { SimContext } from "../context";
import type { EventSink } from "../events";
import type { EntityId } from "../ids";
import type { Order, OrderRejectReason, PendingOrder, Waypoint } from "../orders";
import { clearLine, findPath } from "../nav";
import { navFor } from "../navctx";
import { requestPosture } from "./body";
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
      }
      return null;
    case "halt":
      return null;
    case "posture":
      return o.posture === "standing" || o.posture === "crouching" || o.posture === "prone" ? null : "invalid-params";
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
    const ok = applyOrder(ctx, state, p.order, events);
    events.emit({ kind: "order.delivered", tick: state.tick, seq: p.seq, target: p.order.target, orderKind: p.order.kind });
    radioFromTarget(state, p.order.target, ok ? `radio.ack.${p.order.kind}` : "radio.noRoute", events);
    if (!ok) events.emit({ kind: "move.noRoute", tick: state.tick, target: p.order.target });
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
  const from = unit.leader ?? unit.members[0];
  if (from === undefined) return;
  events.emit({ kind: "radio", tick: state.tick, side: unit.side, from, key, params: { callsign: unit.callsign } });
}

/** Apply a delivered order. Returns false if a move order found no route (nothing changes then). */
function applyOrder(ctx: SimContext, state: SimState, order: Order, events: EventSink): boolean {
  const isUnit = state.unit.has(order.target);
  const soldiers = isUnit ? unitSoldiers(state, order.target) : [order.target];
  switch (order.kind) {
    case "move": {
      // The unit's route is found once, from its reference man (leader, else first man) through all waypoints.
      // Every man joins that route from where he stands and leaves it for his own spot at the end: the
      // destination plus his current offset from the reference man. (M1.4 replaces this with formations.)
      const unit = isUnit ? state.unit.req(order.target) : null;
      const refId = unit ? (unit.leader ?? soldiers[0]) : order.target;
      const ref = refId === undefined ? undefined : state.transform.get(refId);
      if (!ref) return false;
      const route = routeThrough(ctx, ref.x, ref.y, order.waypoints);
      if (!route) return false;
      for (const s of soldiers) {
        const t = state.transform.get(s);
        const m = state.mover.get(s);
        if (!t || !m) continue;
        m.waypoints = s === refId ? route.map((w) => ({ ...w })) : personalRoute(ctx, t.x, t.y, t.x - ref.x, t.y - ref.y, route);
      }
      if (unit) unit.moving = true;
      else markUnitMoving(state, order.target);
      break;
    }
    case "halt": {
      for (const s of soldiers) {
        const m = state.mover.get(s);
        if (m) { m.waypoints = []; m.speedMps = 0; }
      }
      break;
    }
    case "posture": {
      for (const s of soldiers) {
        const m = state.mover.get(s);
        if (m) { m.waypoints = []; m.speedMps = 0; }
        requestPosture(ctx, state, s, order.posture);
      }
      break;
    }
  }
  void events;
  return true;
}

/** Path through the order's waypoints (each leg with its own mode). null if any leg has no route. */
function routeThrough(ctx: SimContext, x: number, y: number, wps: readonly Waypoint[]): Waypoint[] | null {
  const out: Waypoint[] = [];
  let px = x, py = y;
  for (const w of wps) {
    const mode = ctx.catalog.movementModes[w.mode];
    if (!mode) return null;
    const { search } = navFor(ctx, mode.class);
    const p = findPath(search, px, py, w.x, w.y);
    if (!p) return null;
    for (let i = 0; i < p.points.length; i += 2) out.push({ ...w, x: p.points[i]!, y: p.points[i + 1]! });
    px = p.goalX; py = p.goalY;
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

function markUnitMoving(state: SimState, soldier: EntityId): void {
  const u = state.identity.get(soldier)?.unit;
  if (u !== undefined) state.unit.req(u).moving = true;
}

export { radioFromTarget };
