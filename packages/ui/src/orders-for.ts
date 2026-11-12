/**
 * Which orders the order bar offers for the selected unit (M7.1c): men on foot get every order; a vehicle crew
 * unit (move, fire with a choice of gun and round, smoke screen, halt, cease fire, rules; M7.3) gets its class's
 * paces and "reverse". Pure: tested without a DOM.
 */
import type { OrderMode } from "./hud";

export interface OrderSet {
  modes: OrderMode[];
  halt: boolean;
  ceaseFire: boolean;
  posture: boolean;
  rules: boolean;
  /** Paces for the legs of a planned move, first = default. "reverse" = the slowest vehicle pace, in reverse. */
  paces: string[];
  /** The pace "reverse" stands for (the slowest vehicle pace), if offered. */
  reversePace?: string;
  /** Get in (men on foot with a vehicle to ride in) / get out (men aboard, or a vehicle with passengers) (M7.2). */
  mount: boolean;
  dismount: boolean;
  /** Vehicles (M7.3): the smoke dischargers, and the choice of gun and round for a fire order. */
  discharge: boolean;
  nature: boolean;
}

/** What the selected unit can do about vehicles now (M7.2). */
export interface BoardingChoice { mount: boolean; dismount: boolean }

export const FOOT_PACES = ["walk", "run", "sneak", "crawl"];
const FOOT_MODES: OrderMode[] = ["move", "assault", "withdraw", "fire", "grenade", "grenades", "mortar", "smoke"];

/**
 * `vehicleClass`: the class of the unit's vehicle, or null for men on foot. `modes`: the catalog's movement
 * modes (vehicle paces ordered slow to fast by their share of top speed).
 */
export function ordersFor(vehicleClass: "tracked" | "wheeled" | null, modes: Readonly<Record<string, { class: string; speedFraction?: number }>>, boarding: BoardingChoice = { mount: false, dismount: false }): OrderSet {
  if (vehicleClass === null) return { modes: FOOT_MODES, halt: true, ceaseFire: true, posture: true, rules: true, paces: FOOT_PACES, mount: boarding.mount, dismount: boarding.dismount, discharge: false, nature: false };
  const paces = Object.entries(modes).filter(([, m]) => m.class === vehicleClass).sort((a, b) => (a[1].speedFraction ?? 0) - (b[1].speedFraction ?? 0) || (a[0] < b[0] ? -1 : 1)).map(([id]) => id);
  // Default: the middle pace ("drive"), then the others, then reverse.
  const mid = paces[Math.floor((paces.length - 1) / 2)];
  const ordered = mid === undefined ? [] : [mid, ...paces.filter((p) => p !== mid)];
  // A vehicle's crew can only let its passengers out (they get in by an order to their own unit).
  // It fires its guns (M7.3) and its smoke dischargers.
  const out: OrderSet = { modes: ["move", "fire"], halt: true, ceaseFire: true, posture: false, rules: true, paces: ordered, mount: false, dismount: boarding.dismount, discharge: true, nature: true };
  if (paces[0] !== undefined) { out.paces = [...ordered, "reverse"]; out.reversePace = paces[0]; }
  return out;
}

/** A planned leg's pace as a waypoint mode: "reverse" drives the slowest vehicle pace backwards. */
export function paceToWaypoint(pace: string, set: OrderSet): { mode: string; reverse?: true } {
  if (pace === "reverse" && set.reversePace !== undefined) return { mode: set.reversePace, reverse: true };
  return { mode: pace };
}
