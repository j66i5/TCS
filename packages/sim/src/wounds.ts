/**
 * A WOUND IS A RECORD, NOT A HIT-POINT SUBTRACTION (SPEC 4.3 rule 10, 6.4, 9.1).
 *
 * A soldier carries a list of wound records. A PHYSIOLOGY state (blood volume, shock, consciousness,
 * pain) is derived from the wounds and evolves over time in a time-stepped system with data-driven rates.
 * The medical extension (M10) replaces the CONTENTS of `PhysiologyModel`, never this interface.
 *
 * M0 status: types and the model interface only. The simple model and wound creation arrive in M2.
 */
import type { DefId, EntityId } from "./ids";

export type BodyZone =
  | "head" | "neck" | "chest" | "abdomen" | "pelvis"
  | "armL" | "armR" | "legL" | "legR";

export const BODY_ZONES: readonly BodyZone[] = [
  "head", "neck", "chest", "abdomen", "pelvis", "armL", "armR", "legL", "legR",
];

export type WoundMechanism = "bullet" | "fragment" | "blast" | "burn" | "crush";

export interface TreatmentRecord {
  tick: number;
  /** Who treated (may be the casualty himself: self-aid). */
  by: EntityId;
  /** Intervention type, data ID ("tourniquet", "pressure-dressing", ...). */
  intervention: DefId;
  /** Items consumed, by type. */
  itemsUsed: Record<DefId, number>;
  success: boolean;
}

export interface Wound {
  /** Unique within the soldier, increasing. */
  id: number;
  zone: BodyZone;
  mechanism: WoundMechanism;
  /** 0 (scratch) .. 1 (unsurvivable). */
  severity: number;
  /** Current blood loss, litres per second (after treatment effects). */
  bleedingLps: number;
  /** Whether external pressure / tourniquet can stop the bleeding. */
  compressible: boolean;
  airway: boolean;
  breathing: boolean;
  consciousness: boolean;
  tickInflicted: number;
  /** Entity that caused it, if known (for after-action review). */
  source?: EntityId;
  treatments: TreatmentRecord[];
}

export interface Physiology {
  /** Litres; a healthy adult ~5.0. */
  bloodVolumeL: number;
  /** 0 none .. 1 irreversible. */
  shock: number;
  /** 0 unconscious .. 1 fully alert. */
  consciousness: number;
  /** 0 .. 1. */
  pain: number;
  alive: boolean;
}

export function healthyPhysiology(): Physiology {
  return { bloodVolumeL: 5.0, shock: 0, consciousness: 1, pain: 0, alive: true };
}

/** What a soldier can still do, derived from wounds + physiology (SPEC 6.4 "functional effects"). */
export interface Capabilities {
  walk: boolean;
  useArms: boolean;
  fight: boolean;
  speak: boolean;
}

/**
 * The swappable physiology model. Called once per physiology interval for every soldier with wounds.
 * Rates come from data (`params`), never from constants in code.
 */
export interface PhysiologyModel {
  id: string;
  step(physiology: Physiology, wounds: readonly Wound[], dtSeconds: number, params: Readonly<Record<string, number>>): void;
  capabilities(physiology: Physiology, wounds: readonly Wound[]): Capabilities;
}
