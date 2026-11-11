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
import { exp } from "./math";

export type BodyZone =
  | "head" | "neck" | "chest" | "abdomen" | "pelvis"
  | "armL" | "armR" | "legL" | "legR";

export const BODY_ZONES: readonly BodyZone[] = [
  "head", "neck", "chest", "abdomen", "pelvis", "armL", "armR", "legL", "legR",
];

export type WoundMechanism = "bullet" | "fragment" | "blast" | "burn" | "crush" | "blunt";

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
  /** Lack of oxygen from untreated breathing or airway problems, 0 .. 1 (fatal at 1). */
  respiratory: number;
  alive: boolean;
}

export function healthyPhysiology(): Physiology {
  return { bloodVolumeL: 5.0, shock: 0, consciousness: 1, pain: 0, respiratory: 0, alive: true };
}

/** What a soldier can still do, derived from wounds + physiology (SPEC 6.4 "functional effects"). */
export interface Capabilities {
  walk: boolean;
  useArms: boolean;
  fight: boolean;
  speak: boolean;
}

/**
 * The swappable physiology model. `step` is called every `stepSeconds` for every living soldier with wounds.
 * Rates come from data (`params`, core/wounds.json "physiology"), never from constants in code.
 */
export interface PhysiologyModel {
  id: string;
  step(physiology: Physiology, wounds: Wound[], dtSeconds: number, params: Readonly<Record<string, number>>): void;
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Foundations model (M2.3): blood is lost at the wounds' bleeding rates (small bleeds clot by themselves);
 * shock follows the share of blood lost; untreated breathing and airway wounds starve the man of oxygen;
 * consciousness fades as either gets bad; death at a blood-loss fraction or when oxygen runs out.
 * The medical system (M10) replaces this function, not its interface.
 */
export const simplePhysiology: PhysiologyModel = {
  id: "simple",
  step(p, wounds, dt, k) {
    if (!p.alive) return;
    let bleed = 0, breathing = false, airway = false, knockedOut = false;
    for (const w of wounds) {
      if (w.bleedingLps > 0) {
        if (w.bleedingLps < k["clotBelowLps"]!) {
          w.bleedingLps *= exp(-dt / k["clotTauS"]!);
          if (w.bleedingLps < 1e-6) w.bleedingLps = 0;
        }
        bleed += w.bleedingLps;
      }
      if (w.breathing) breathing = true;
      if (w.airway) airway = true;
      if (w.consciousness) knockedOut = true;
    }
    const v0 = k["bloodVolumeL"]!;
    p.bloodVolumeL = Math.max(0, p.bloodVolumeL - bleed * dt);
    const loss = 1 - p.bloodVolumeL / v0;
    p.respiratory = clamp01(p.respiratory + ((breathing ? k["breathingShockPerS"]! : 0) + (airway ? k["airwayShockPerS"]! : 0)) * dt);
    const dead = k["deathLossFraction"]!, start = k["shockStartFraction"]!, out = k["unconsciousLossFraction"]!;
    p.shock = Math.max(clamp01((loss - start) / (dead - start)), p.respiratory);
    let c = knockedOut ? 0 : 1;
    c = Math.min(c, clamp01(1 - (loss - 0.8 * out) / (0.2 * out)), clamp01(1 - (p.respiratory - 0.6) / 0.25));
    // Overwhelming pain (many wounds at once): he collapses until it eases.
    if (p.pain >= (k["painCollapseAt"] ?? 2)) c = 0;
    p.consciousness = c;
    p.pain = Math.max(0, p.pain - k["painDecayPerS"]! * dt);
    if (loss >= dead || p.respiratory >= 1) { p.alive = false; p.consciousness = 0; }
  },
};

export const PHYSIOLOGY_MODELS: Record<string, PhysiologyModel> = { simple: simplePhysiology };
