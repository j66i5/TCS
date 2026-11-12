/**
 * Component types. Entities are numbers; each kind of state lives in its own store (SPEC 4.3 rule 6).
 * All components are plain data (no methods, no class instances) so the whole state serialises.
 */
import type { AmmoRule, ContactRule, FireRule } from "./catalog";
import type { DefId, EntityId, SideId } from "./ids";
import type { Posture, Waypoint } from "./orders";
import type { Physiology, Wound } from "./wounds";

/** Who a soldier is. Persistent across battles via the roster (`personId`). */
export interface Identity {
  personId: string;
  given: string;
  family: string;
  rank: DefId;
  role: DefId;
  faction: DefId;
  side: SideId;
  /** The lowest unit (team/squad) he belongs to. Unit path = walk up `Unit.parent`. */
  unit: EntityId;
}

export interface Transform {
  x: number;
  y: number;
  /** Height above ground, metres (eye/centre height is derived from posture). */
  z: number;
  /** Facing, radians, 0 = east, PI/2 = south (y grows south). */
  heading: number;
}

export interface Mover {
  /** Remaining waypoints; empty = idle. */
  waypoints: Waypoint[];
  /** Current speed, m/s. */
  speedMps: number;
  /** Grade of the ground along the direction of travel (rise/run), for exertion. */
  grade: number;
  /** Movement mode of the current leg (exertion), or null when not moving. */
  mode: DefId | null;
  /** Formation slot of a follower: offset from the leader in metres (right, back of his heading). */
  formation: { leader: EntityId; rightM: number; backM: number } | null;
  /** How far behind his slot this follower was last tick (m, 0 if not behind); the leader waits for laggards. */
  slotLagM: number;
  /** On reaching the last waypoint: take this posture and face this way (halt drill). */
  endPosture: Posture | null;
  endHeading: number | null;
}

export type Behaviour =
  | "steady" | "cautious" | "pinned" | "shaken" | "panicked" | "routed" | "surrendered" | "incapacitated";

/** Individual soldier state (SPEC 6.4). M0 holds the fields; systems that change them come in M1-M4. */
export interface SoldierState {
  /** Skills 0..1: marksmanship, fieldcraft, medical, leadership, experience (keys are data). */
  skills: Record<string, number>;
  posture: Posture;
  /** Posture being taken, or null. The change completes at `postureDoneTick`. */
  postureTo: Posture | null;
  postureDoneTick: number;
  /** winded: reached the exhaustion limit; stays true until fatigue falls below the run-again level. */
  physical: { fatigue: number; heartRateBpm: number; hydration: number; winded: boolean };
  mental: { stress: number; suppression: number; morale: number; behaviour: Behaviour };
  physiology: Physiology;
  wounds: Wound[];
  nextWoundId: number;
  /** What his wounds and condition allow, refreshed when they change (see systems/wounds.ts). */
  impair: { move: number; aim: number; canWalk: boolean; canUseArms: boolean; canFight: boolean; canSpeak: boolean };
  /** Knocked down (e.g. a round stopped by his plate): no moving or firing until this tick. */
  stunnedUntilTick: number;
  /** Enemies he can see now or saw moments ago (M3.2), ascending target ID. */
  seen: { target: EntityId; firstTick: number; lastTick: number }[];
  /** What he knows of the enemy (M3.3), ascending target ID: from his own eyes, his ears, or reports. */
  contacts: Contact[];
  /** Getting away from a grenade at (x, y): from startTick he runs from it (`run`) or drops flat; over at untilTick. */
  evade: { x: number; y: number; startTick: number; untilTick: number; run: boolean; /** He has left his planned way. */ ran: boolean } | null;
  /** What he decided on his own last (M4.2), for the debug overlay and to pace his decisions. */
  intent: Intent | null;
  /** Last tick he went looking for cover on his own. */
  coverTick: number;
  /** Casualty status already reported: none, incapacitated (unconscious or unable to act) or killed. */
  casualty: "none" | "incapacitated" | "killed";
}

export type CommLink = "voice" | "radio" | "none";

/** Communication state of a unit (SPEC 6.5, 9.5). Updated by the CommsModel. */
export interface CommState {
  link: CommLink;
  /** Extra delay on top of the model's base delay, seconds (EW, leader condition ... later). */
  extraDelaySeconds: number;
}

/**
 * A contact: what one soldier believes about one enemy (SPEC 6.5). The position is an estimate with an
 * uncertainty; `tick` is when that information was true. `target` identifies the enemy inside the simulation
 * (for merging reports and for fire orders); the player's view shows only kind, position, uncertainty, age.
 */
/** A soldier's own decision (M4.2): firing at an enemy, going to cover, bringing or waiting for ammunition. */
export interface Intent {
  kind: "engage" | "cover" | "bringAmmo";
  tick: number;
  target?: EntityId;
  x?: number;
  y?: number;
}

export interface Contact {
  target: EntityId;
  x: number;
  y: number;
  /** Uncertainty of the position (radius, m) at `tick`; it grows with age when used. */
  errM: number;
  /** seen: he saw him; heard: shots from that direction; reported: told by a comrade. */
  kind: "seen" | "heard" | "reported";
  tick: number;
  /** When he last passed this contact on (reports are not passed on again: no gossip chains). */
  reportedTick: number;
}

/** A contact report on its way from one soldier to another. */
export interface ContactReport {
  deliverTick: number;
  from: EntityId;
  to: EntityId;
  contact: Omit<Contact, "reportedTick">;
}

export interface Unit {
  callsign: string;
  side: SideId;
  faction: DefId;
  /** "platoon" | "squad" | "team" | "section" ... (data). */
  echelon: DefId;
  parent: EntityId | null;
  children: EntityId[];
  /** Soldiers directly in this unit (not in child units). */
  members: EntityId[];
  leader: EntityId | null;
  comms: CommState;
  /** True while executing a move order (cleared on arrival). */
  moving: boolean;
  /** True while members are carrying out a fire order. */
  firing: boolean;
  /** "No line of fire" has been reported for the current fire order (reset by the next fire order). */
  lineBlockedReported: boolean;
  /** Tick of this unit's last contact call-out on the radio (call-outs are spaced out). */
  lastCallTick: number;
  /** Standing fire rule (M4.2): when its men open fire on their own. */
  fireRule: FireRule;
  /** Standing rules (M5): no fire on their own beyond this range (0 = the weapon's range), what to do on contact
   * while moving, and ammunition discipline. */
  maxEngageM: number;
  onContact: ContactRule;
  ammoRule: AmmoRule;
  /** Last tick a man of this unit (or its sub-units) came under fire, and of its last cease-fire order. */
  underFireTick: number;
  ceaseFireTick: number;
  /** When the unit's current spell under fire began (fire after a quiet spell), and its last move order (M4.3). */
  contactTick: number;
  moveTick: number;
  /** A drill in progress (M4.3), and whether the unit has broken and is running back. */
  drill: Drill | null;
  broken: boolean;
}

/**
 * A unit drill (M4.3). assault / withdraw: two groups take turns, one bounding toward (x, y) while the other
 * covers; `mover` is the group bounding now, since `phaseTick`; `final`: the last rush (or the last leg back).
 * rout: the unit has broken and runs to (x, y), where it rallies.
 */
export interface Drill {
  kind: "assault" | "withdraw" | "rout";
  x: number;
  y: number;
  groups: EntityId[][];
  mover: number;
  phaseTick: number;
  final: boolean;
}

/** An action with duration that can be interrupted (SPEC 9.1 foundation requirement). */
export interface Action {
  kind: string;
  startTick: number;
  durationTicks: number;
  params: Record<string, string | number>;
}

/**
 * Terrain damage (SPEC 6.1 "destructible in a simple way", 9.3 "persistent map damage stored as data").
 * Lives in SimState so it saves, replays and can be carried into the campaign. Systems that create damage
 * arrive with ballistics (M2); movement, spotting and cover will read it.
 */
export interface TerrainState {
  /** Holes blown in walls: in obstacle/building `id`, segment `part`, centred `offsetM` from its start. */
  breaches: { owner: "obstacle" | "building"; id: number; part: number; offsetM: number; widthM: number; tick: number }[];
  craters: { x: number; y: number; radiusM: number; depthM: number; tick: number }[];
  /** Vegetation thinned by fire: [cell index, fraction removed 0..1], sorted by cell. */
  vegetationLoss: [number, number][];
}

/** A soldier's personal weapon. The loaded magazine is here, not in his container, while it is in the weapon. */
export interface WeaponState {
  weapon: DefId;
  magazine: { item: DefId; rounds: number } | null;
  nextShotTick: number;
  /** Rounds still to fire in the current burst, and rounds already fired in it (recoil builds up). */
  burstLeft: number;
  burstIndex: number;
  jammed: boolean;
  lastShotTick: number;
  /** He has already reported that he is down to his last magazine (reset when he loads a fresh one). */
  lowAmmoReported: boolean;
  /** He has sent that report by radio (one report per unit). */
  lowAmmoRadioed: boolean;
}

/** A soldier's task to fire at a point (from a fire order). */
export interface FireTask {
  x: number;
  y: number;
  /** Aim height above the ground at the target point, m. */
  heightM: number;
  /** Tick of the last reason to fire at the full rate (the order, incoming fire near the unit). */
  reasonTick: number;
  /** His error in judging the range to this target, as a fraction (constant for the task). */
  rangeError: number;
  /** Tick at which he began to aim at this point (his aim settles over the first seconds). */
  startTick: number;
  /** When his line of fire was last checked, and whether it was clear from where he is. */
  lineCheckTick: number;
  lineClear: boolean;
  /** Fire at this enemy as each man knows him (his contact), not at a fixed point. */
  contact?: EntityId;
  /** He opened fire on his own (M4.2), not on an order: he stops when he loses sight of the enemy. */
  self?: boolean;
  /** The posture that check was worked out for, and the lowest posture he may go back down to. */
  linePosture: Posture;
  basePosture: Posture;
}
