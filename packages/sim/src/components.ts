/**
 * Component types. Entities are numbers; each kind of state lives in its own store (SPEC 4.3 rule 6).
 * All components are plain data (no methods, no class instances) so the whole state serialises.
 */
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
  /** Current speed, m/s (for renderer interpolation and fatigue later). */
  speedMps: number;
}

export type Behaviour =
  | "steady" | "cautious" | "pinned" | "shaken" | "panicked" | "routed" | "surrendered" | "incapacitated";

/** Individual soldier state (SPEC 6.4). M0 holds the fields; systems that change them come in M1-M4. */
export interface SoldierState {
  /** Skills 0..1: marksmanship, fieldcraft, medical, leadership, experience (keys are data). */
  skills: Record<string, number>;
  posture: Posture;
  physical: { fatigue: number; heartRateBpm: number; hydration: number };
  mental: { stress: number; suppression: number; morale: number; behaviour: Behaviour };
  physiology: Physiology;
  wounds: Wound[];
  nextWoundId: number;
}

export type CommLink = "voice" | "radio" | "none";

/** Communication state of a unit (SPEC 6.5, 9.5). Updated by the CommsModel. */
export interface CommState {
  link: CommLink;
  /** Extra delay on top of the model's base delay, seconds (EW, leader condition ... later). */
  extraDelaySeconds: number;
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
}

/** An action with duration that can be interrupted (SPEC 9.1 foundation requirement). */
export interface Action {
  kind: string;
  startTick: number;
  durationTicks: number;
  params: Record<string, string | number>;
}
