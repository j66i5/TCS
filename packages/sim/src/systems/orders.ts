/**
 * Order pipeline: inbox (issued) -> validation -> comms delay (pending) -> delivery (applied).
 */
import type { SimContext } from "../context";
import type { EventSink } from "../events";
import type { EntityId } from "../ids";
import type { Order, OrderRejectReason, PendingOrder } from "../orders";
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
export function deliverOrders(_ctx: SimContext, state: SimState, events: EventSink): void {
  if (state.pendingOrders.length === 0) return;
  const due: PendingOrder[] = [];
  const rest: PendingOrder[] = [];
  for (const p of state.pendingOrders) (p.deliverTick <= state.tick ? due : rest).push(p);
  if (due.length === 0) return;
  state.pendingOrders = rest;
  due.sort((a, b) => a.deliverTick - b.deliverTick || a.seq - b.seq);
  for (const p of due) {
    applyOrder(state, p.order, events);
    events.emit({ kind: "order.delivered", tick: state.tick, seq: p.seq, target: p.order.target, orderKind: p.order.kind });
    radioFromTarget(state, p.order.target, `radio.ack.${p.order.kind}`, events);
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

function applyOrder(state: SimState, order: Order, events: EventSink): void {
  const isUnit = state.unit.has(order.target);
  const soldiers = isUnit ? unitSoldiers(state, order.target) : [order.target];
  switch (order.kind) {
    case "move": {
      // M0: every man keeps his offset from the unit's reference point (leader, else first man).
      // M1 replaces this with formations and individual cover-seeking near the formation slot.
      const unit = isUnit ? state.unit.req(order.target) : null;
      const refId = unit ? (unit.leader ?? soldiers[0]) : order.target;
      const ref = refId === undefined ? undefined : state.transform.get(refId);
      for (const s of soldiers) {
        const t = state.transform.get(s);
        const m = state.mover.get(s);
        if (!t || !m || !ref) continue;
        const ox = t.x - ref.x, oy = t.y - ref.y;
        m.waypoints = order.waypoints.map((w) => ({ ...w, x: w.x + ox, y: w.y + oy }));
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
  }
  void events;
}

function markUnitMoving(state: SimState, soldier: EntityId): void {
  const u = state.identity.get(soldier)?.unit;
  if (u !== undefined) state.unit.req(u).moving = true;
}

export { radioFromTarget };
