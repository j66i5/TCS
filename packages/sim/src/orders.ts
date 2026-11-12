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
  /** Vehicles (M7): drive this leg in reverse. */
  reverse?: true;
}

/** Order bodies. M0 implements move and halt; the rest of SPEC 6.6's list arrives in M5. */
export type OrderBody =
  /** Move along waypoints; `formation` (data ID) overrides the faction's default formation. */
  | {
    kind: "move"; waypoints: Waypoint[]; formation?: DefId;
    /** Facing at the destination, rad (0 = east, PI/2 = south): the formation is laid out facing this way (M5). */
    facing?: number;
    /** Width of the formation at the destination, m (its slots are spaced to fit; M5). */
    frontageM?: number;
  }
  | { kind: "halt" }
  /** Stop and take a posture. */
  | { kind: "posture"; posture: Posture }
  /** Fire at a point (suppressive or at a seen target). `heightM`: aim height above ground there. */
  | { kind: "fire"; x: number; y: number; heightM?: number; /** Fire at this enemy wherever each man believes him to be (his contact); x, y are the fallback. */ contact?: EntityId }
  | { kind: "ceaseFire" }
  /** Standing rules for the unit and its sub-units (M4.2, M5); only the rules given change. */
  | { kind: "rules"; fire?: "free" | "return" | "hold"; /** 0 = no limit beyond the weapon's own. */ maxEngageM?: number; onContact?: "ground" | "push" | "back"; ammo?: "conserve" | "normal" | "max" }
  /** Fire and movement onto (x, y) (M4.3): two halves of the unit bound in turn, one firing while the other runs. */
  | { kind: "assault"; x: number; y: number }
  /** Break contact back to (x, y) (M4.3): the halves bound back in turn, one covering toward the enemy. */
  | { kind: "withdraw"; x: number; y: number }
  /** Call mortar fire (M6.5c): high explosive or smoke, this many rounds at (x, y); the unit's leader (or a man
   *  who can still use the radio) passes it on; the side's allotment pays for it. */
  | { kind: "callFire"; x: number; y: number; ammo: "he" | "smoke"; rounds: number }
  /** Grenades at a point: the best-placed men throw a hand grenade or fire their grenade launcher, a moment apart. */
  | { kind: "grenade"; x: number; y: number; /** How many men throw or fire (default 1). */ count?: number };

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
