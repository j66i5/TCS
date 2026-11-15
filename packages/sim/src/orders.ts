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
   *  to (x2, y2) (a screen; ranging aims at the line's middle).
   *  M8.4: `asset` "artillery" for the off-map battery (default: the mortars); `ammo` "illum" for illumination; `fuse`
   *  "airburst" for high explosive bursting over the target; `dangerClose` to fire this close to own men. */
  | { kind: "callFire"; x: number; y: number; ammo: "he" | "smoke" | "illum"; rounds: number; x2?: number; y2?: number; asset?: "mortar" | "artillery"; fuse?: "airburst"; dangerClose?: boolean }
  /** Grenades at a point: the best-placed men throw a hand grenade or fire their grenade launcher, a moment apart. */
  | { kind: "grenade"; x: number; y: number; /** How many men throw or fire (default 1). */ count?: number; /** Hand smoke grenades only (D1): a screen at the point. */ smoke?: boolean }
  /** Get in (M7.2): the men on foot walk to the vehicle and board it; to a parent, each unit under it boards its
   *  own carrier. `vehicle` (an own vehicle) overrides the carrier. */
  | { kind: "mount"; vehicle?: EntityId }
  /** Get out (M7.2): the unit's men aboard get out behind their vehicle; to a vehicle's crew: all its passengers.
   *  `wounded` (M10.4b): then two of them carry the casualties aboard out too (laid down behind the exit). */
  | { kind: "dismount"; wounded?: boolean }
  /** Set up a crew-served weapon where the men stand (M8.3a, SPEC 6.6 "deploy crew-served weapon"): a mortar team,
   *  or a section of them; the men stop. */
  | { kind: "deploy" }
  /** A reconnaissance quadcopter (M9.4a): "fly" sends the unit's drone to (x, y) (its operator launches it first if
   *  it is not up; `altM`: its height above the ground), "home" brings it back to land with its operator. The
   *  target: the unit whose men carry it (a platoon: its headquarters) or one of them. `dismount` (the player's
   *  orders): if the man who carries it rides, he gets out first and then launches it (a quadcopter goes up by hand
   *  from the ground). */
  | { kind: "drone"; op: "fly" | "home"; x?: number; y?: number; altM?: number; dismount?: boolean }
  /** Fire the smoke dischargers (M7.3): a vehicle crew, or a unit with vehicles under it. */
  | { kind: "discharge" }
  /** Occupy a building (M7.5d): the men take the window places of building `building` (its id), on every floor
   *  (`floor`: that floor first), those facing `facing` (rad; absent: away from the building's centre) first.
   *  M7.5e: `windowIndex` (an index into the building's window places, `windowPlaces`) sends the first man to exactly
   *  that window (any others take the next places); `mode` is the pace there (a foot movement mode; default run). */
  | { kind: "occupy"; building: number; floor?: number; facing?: number; windowIndex?: number; mode?: DefId }
  /** Put the Verwundetennest here (M10.5, owner answer 4): the target's platoon (its top unit) gathers its casualties
   *  at (x, y) from now on; the nest stays where the player put it. */
  | { kind: "casualtyPoint"; x: number; y: number }
  /** Take this casualty to the Verwundetennest now (M10.5, owner answer 4): the target is the wounded man; he goes
   *  first in the bearers' queue, and walks there himself if he can, even if he could still fight. */
  | { kind: "evacuate" }
  /** Call an ambulance to the Verwundetennest (M10.6a, owner answer 4): the target's platoon (its top unit) asks for
   *  its side's next waiting ambulance now, even before anyone lies at the nest (the nest is sited if it has none). */
  | { kind: "callAmbulance" }
  /** Evacuate with this vehicle (M10.6b, owner Q-9): the target crew's hull takes the casualties at its platoon's
   *  Verwundetennest (or the wounded aboard) off the map, then comes back. */
  | { kind: "rearRun" }
  /** Lay an ambush (D4b, SPEC 6.6): the unit and its sub-units (vehicle crews too) hold their fire until an enemy
   *  comes within `rangeM` of one of their men, one of them fires, or they come under fire; then the ambush is
   *  sprung for all of them and they fire at will. */
  | { kind: "ambush"; rangeM: number }
  /** Defend an arc (D4b, SPEC 6.6): the men on foot of the unit and its sub-units stop, face `facing` (rad) and
   *  open fire on their own only at enemies within `widthRad / 2` either side of it; the next move, assault,
   *  withdrawal or occupation ends the arc. */
  | { kind: "defendArc"; facing: number; widthRad: number };

export type OrderKind = OrderBody["kind"];

export type Order = {
  /** Tick at which the order is issued. Must be >= the current tick when submitted. */
  tick: number;
  issuer: SideId;
  target: EntityId;
  /** Given by the player (the app's own orders; absent for AI and scripted orders). A vehicle under a player's
   *  move or halt order holds it against close enemy men (owner 2026-11-13). */
  player?: true;
  /** Only the target unit's own men, not its sub-units or their vehicles: a platoon's headquarters on its own
   *  (owner 2026-11-15). Moves, halts, getting in and out, postures, fire, cease-fire, grenades, calls for fire,
   *  rules, ambushes and arcs (`OWN_ORDER_KINDS`); a unit target without a vehicle. */
  own?: true;
} & OrderBody;

/** The order kinds that take `own` (the others are drills of a unit with its sub-units). */
export const OWN_ORDER_KINDS: readonly string[] = ["move", "halt", "mount", "dismount", "posture", "fire", "ceaseFire", "grenade", "callFire", "rules", "ambush", "defendArc"];

/** An order after reception, waiting for the comms delay. Part of the serialised state. */
export interface PendingOrder {
  seq: number;
  order: Order;
  receivedTick: number;
  deliverTick: number;
  /** The men hesitated over it once (D4b, behaviour.hesitation): it was put back to `deliverTick` and will be
   *  carried out then, unless a later order to them replaces it first. */
  hesitated?: true;
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
