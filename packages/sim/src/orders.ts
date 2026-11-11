/**
 * ORDERS ARE THE ONLY WAY TO CHANGE THE SIMULATION FROM OUTSIDE (SPEC 4.3 rule 3).
 *
 * An order is a plain, serialisable record: the tick it is issued at, the issuing side, the target entity
 * (a unit or a soldier) and a body. Human input, the AI commander, replays, network play and the campaign
 * auto-resolver all produce exactly these records. A replay is just the list of orders.
 *
 * Life of an order:
 *   issued (tick T, enters the inbox) -> received (validated at tick T, or rejected)
 *   -> pending (comms delay, decided by the CommsModel) -> delivered (the unit acts and acknowledges).
 */
import type { DefId, EntityId, SideId } from "./ids";

export type Posture = "standing" | "crouching" | "prone";

export interface Waypoint {
  x: number;
  y: number;
  /** Movement mode for the leg TO this waypoint (data ID: "walk", "run", "sneak", ...). */
  mode: DefId;
  /** Posture for the leg; reserved (M1). */
  posture?: Posture;
}

/** Order bodies. M0 implements move and halt; the rest of SPEC 6.6's list arrives in M5. */
export type OrderBody =
  /** Move along waypoints; `formation` (data ID) overrides the faction's default formation. */
  | { kind: "move"; waypoints: Waypoint[]; formation?: DefId }
  | { kind: "halt" }
  /** Stop and take a posture. */
  | { kind: "posture"; posture: Posture };

export type OrderKind = OrderBody["kind"];

export type Order = {
  /** Tick at which the order is issued. Must be >= the current tick when submitted. */
  tick: number;
  issuer: SideId;
  target: EntityId;
} & OrderBody;

/** An order after reception, waiting for the comms delay. Part of the serialised state. */
export interface PendingOrder {
  seq: number;
  order: Order;
  receivedTick: number;
  deliverTick: number;
}

/** An order submitted but not yet processed (its tick is in the future). Part of the serialised state. */
export interface InboxOrder {
  seq: number;
  order: Order;
}

export type OrderRejectReason =
  | "late"
  | "unknown-target"
  | "not-your-unit"
  | "invalid-params"
  | "battle-ended";
