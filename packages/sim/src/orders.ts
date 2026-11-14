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
  /** Height above the ground at this point, m (M7.5d: a floor of a building, or a step on its stairs); the man
   *  climbs or descends evenly along the leg. Absent: his height does not change (outdoors: 0). */
  z?: number;
  /** A flight that pinning does not hold (M7.5e: men leaving a house that has become a trap). */
  bolt?: true;
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
    /** A destination inside a building: the floor (0 = ground, M7.5d; the floor the player has on screen). */
    floor?: number;
  }
  | { kind: "halt" }
  /** Stop and take a posture. */
  | { kind: "posture"; posture: Posture }
  /** Fire at a point (suppressive or at a seen target). `heightM`: aim height above ground there. */
  | {
    kind: "fire"; x: number; y: number; heightM?: number; /** Fire at this enemy wherever each man believes him to be (his contact); x, y are the fallback. */ contact?: EntityId;
    /** Vehicles (M7.3): armour-piercing, high explosive or the machine gun; absent: the crew chooses. "at" (M7.4a):
     *  men on foot fire one anti-tank round (Panzerfaust, RPG) at it — any target the player picks (owner Q19); a
     *  vehicle crew fires its guided missile if it has one ready (owner 2026-11-13), else armour-piercing. */
    nature?: "ap" | "he" | "mg" | "at";
  }
  | { kind: "ceaseFire" }
  /** Standing rules for the unit and its sub-units (M4.2, M5); only the rules given change. */
  | {
    kind: "rules"; fire?: "free" | "return" | "hold"; /** 0 = no limit beyond the weapon's own. */ maxEngageM?: number; onContact?: "ground" | "push" | "back"; ammo?: "conserve" | "normal" | "max";
    /** Anti-tank weapons on their own (M7.4a, SPEC 6.6): at vehicles only, also at positions, or only on order. */
    at?: "vehicles" | "vehiclesAndPositions" | "hold";
  }
  /** Fire and movement onto (x, y) (M4.3): two halves of the unit bound in turn, one firing while the other runs.
   *  M7.5e: `building` (a building's id, with an interior) makes it a house clearing: the halves close in by bounds
   *  on a door of that building (x, y: where the unit comes from does not matter, the building does), stack beside
   *  it, throw a grenade in, and clear the rooms one by one (drill "clear"). */
  | { kind: "assault"; x: number; y: number; building?: number }
  /** Break contact back to (x, y) (M4.3): the halves bound back in turn, one covering toward the enemy. */
  | { kind: "withdraw"; x: number; y: number }
  /** Call mortar fire (M6.5c): high explosive or smoke, this many rounds at (x, y); the unit's leader (or a man
   *  who can still use the radio) passes it on; the side's allotment pays for it.
   *  M8.1: smoke along a line: `x2, y2` the line's other end; the rounds for effect land spread evenly from (x, y)
   *  to (x2, y2) (a screen; ranging aims at the line's middle). */
  | { kind: "callFire"; x: number; y: number; ammo: "he" | "smoke"; rounds: number; x2?: number; y2?: number }
  /** Grenades at a point: the best-placed men throw a hand grenade or fire their grenade launcher, a moment apart. */
  | { kind: "grenade"; x: number; y: number; /** How many men throw or fire (default 1). */ count?: number }
  /** Get in (M7.2): the men on foot walk to the vehicle and board it; to a parent, each unit under it boards its
   *  own carrier. `vehicle` (an own vehicle) overrides the carrier. */
  | { kind: "mount"; vehicle?: EntityId }
  /** Get out (M7.2): the unit's men aboard get out behind their vehicle; to a vehicle's crew: all its passengers. */
  | { kind: "dismount" }
  /** Fire the smoke dischargers (M7.3): a vehicle crew, or a unit with vehicles under it. */
  | { kind: "discharge" }
  /** Occupy a building (M7.5d): the men take the window places of building `building` (its id), on every floor
   *  (`floor`: that floor first), those facing `facing` (rad; absent: away from the building's centre) first.
   *  M7.5e: `windowIndex` (an index into the building's window places, `windowPlaces`) sends the first man to exactly
   *  that window (any others take the next places); `mode` is the pace there (a foot movement mode; default run). */
  | { kind: "occupy"; building: number; floor?: number; facing?: number; windowIndex?: number; mode?: DefId };

export type OrderKind = OrderBody["kind"];

export type Order = {
  /** Tick at which the order is issued. Must be >= the current tick when submitted. */
  tick: number;
  issuer: SideId;
  target: EntityId;
  /** Given by the player (the app's own orders; absent for AI and scripted orders). A vehicle under a player's
   *  move or halt order holds it against close enemy men (owner 2026-11-13). */
  player?: true;
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
  /** This kind of order means nothing to that kind of unit (M7.3: a grenade to a vehicle crew, smoke to men on foot). */
  | "not-applicable"
  | "battle-ended";
