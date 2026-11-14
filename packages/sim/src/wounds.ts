/**
 * A WOUND IS A RECORD, NOT A HIT-POINT SUBTRACTION (SPEC 4.3 rule 10, 6.4, 9.1).
 *
 * A soldier carries a list of wound records. A PHYSIOLOGY state (blood volume, shock, consciousness,
 * pain) is derived from the wounds and evolves over time in a time-stepped system with data-driven rates.
 * The medical extension (M10) replaces the CONTENTS of `PhysiologyModel`, never this interface.
 *
 * Models: "simple" (M2.3, the foundations clock) and "medical" (M10.1, the default in every scenario): the medical
 * model adds a tension pneumothorax that develops some minutes after a chest wound, a tourniquet clock (limb
 * ischaemia), hypothermia, fluids, a head injury that knocks a man out after a lucid interval, plasma loss from
 * burns and broken bones. Conditions that appear later are rolled when the wound is made (`onWound`).
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
  // ---- conditions of the medical model (M10.1); absent in the simple model and on old saves ----
  /** Seconds until a tension pneumothorax develops from this chest wound (counts down; then `tension`). */
  tensionInS?: number;
  /** A tension pneumothorax: air trapped in the chest; kills in minutes unless decompressed. */
  tension?: true;
  /** Seconds until this head injury knocks him out (a lucid interval; counts down, then `consciousness`). */
  headInS?: number;
  /** A broken bone under this limb wound: he cannot walk on a broken leg or use a broken arm. */
  fracture?: true;
  /** Seconds a tourniquet has been on this limb (absent: none). The limb is at risk after the safe time. */
  tourniquetS?: number;
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
  // ---- medical model (M10.1); absent = normal ----
  /** Core temperature, degrees Celsius (absent: 37). A casualty in shock cools towards the air temperature. */
  coreTempC?: number;
  /** Litres of infusion still to run in (fluids given by a medic, M10.2). */
  fluidL?: number;
  /** Wrapped against the cold (rescue blanket, M10.2): cools far slower. */
  warmed?: true;
}

/** What the surroundings do to a casualty (the medical model's optional argument; SPEC 9.1 hypothermia). */
export interface PhysiologyEnv {
  temperatureC: number;
  /** Rain 0..1 (wet clothes lose heat faster). */
  rain: number;
  /** Wind speed, m/s. */
  windMps: number;
  /** Out of the weather (aboard a vehicle). */
  sheltered: boolean;
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
  /** `env` (M10.1): the weather around the man; a model that needs it treats a missing one as mild and dry. */
  step(physiology: Physiology, wounds: Wound[], dtSeconds: number, params: Readonly<Record<string, number>>, env?: PhysiologyEnv): void;
  /**
   * A new wound record has been made (M10.1): roll the conditions that appear later (tension pneumothorax, a
   * head injury's lucid interval, a broken bone). `draw` gives uniform numbers in [0, 1) from the "conditions" stream.
   * Optional: the simple model has none and draws nothing.
   */
  onWound?(wound: Wound, draw: () => number, params: Readonly<Record<string, number>>): void;
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

/** Mild, dry and still: the surroundings when none are given. */
const MILD: PhysiologyEnv = { temperatureC: 15, rain: 0, windMps: 0, sheltered: false };

/**
 * The medical model (M10.1, SPEC 9.1). The simple clock (bleeding with clotting of small bleeds, shock from the
 * share of blood lost, breathing and airway wounds starving the man of oxygen, pain fading), plus:
 * - **tension pneumothorax:** some chest wounds develop one after a delay; it then starves him of oxygen
 *   (fatal `tensionDeathS` after onset) unless decompressed (M10.2);
 * - **head injury:** some conscious head wounds knock him out after a lucid interval;
 * - **burns:** lose plasma, a slow fall in circulating volume;
 * - **fluids:** an infusion restores part of the lost volume as it runs in (not red cells, not clotting);
 * - **hypothermia:** a man in shock cools towards the air, faster when wet and windy, far slower when wrapped
 *   or aboard; below `hypoC` his blood clots less and he tolerates less blood loss; below `coldOutC` he passes
 *   out, at `coldDeathC` he dies;
 * - **tourniquet clock:** time on a limb is counted (`amputationChance` reads it);
 * - **fractures:** a flag on limb wounds (impair.ts reads it).
 * Every rate is data (core/medical.json "physiology", merged into the params).
 */
export const medicalPhysiology: PhysiologyModel = {
  id: "medical",
  onWound(w, draw, k) {
    const penetrating = w.mechanism === "bullet" || w.mechanism === "fragment";
    if (!penetrating) return;
    if (w.zone === "chest" && draw() < k["tensionChance"]!) {
      w.tensionInS = k["tensionOnsetMinS"]! + (k["tensionOnsetMaxS"]! - k["tensionOnsetMinS"]!) * draw();
    }
    if (w.zone === "head" && !w.consciousness && w.severity >= k["headMinSeverity"]! && draw() < k["headChance"]!) {
      w.headInS = k["headOnsetMinS"]! + (k["headOnsetMaxS"]! - k["headOnsetMinS"]!) * draw();
    }
    const limb = w.zone === "armL" || w.zone === "armR" || w.zone === "legL" || w.zone === "legR";
    if (limb && w.severity >= k["fractureMinSeverity"]! && draw() < k["fractureChance"]!) w.fracture = true;
  },
  step(p, wounds, dt, k, env = MILD) {
    if (!p.alive) return;
    const v0 = k["bloodVolumeL"]!;
    // Hypothermia first: it slows clotting this step.
    let t = p.coreTempC ?? 37;
    const cold = t < k["hypoC"]!;
    const clotTau = k["clotTauS"]! * (cold ? k["hypoClotFactor"]! : 1);
    let bleed = 0, breathing = false, airway = false, knockedOut = false, tension = false, burn = 0;
    for (const w of wounds) {
      if (w.bleedingLps > 0) {
        if (w.bleedingLps < k["clotBelowLps"]!) {
          w.bleedingLps *= exp(-dt / clotTau);
          if (w.bleedingLps < 1e-6) w.bleedingLps = 0;
        }
        bleed += w.bleedingLps;
      }
      if (w.tensionInS !== undefined) {
        w.tensionInS -= dt;
        if (w.tensionInS <= 0) { delete w.tensionInS; w.tension = true; }
      }
      if (w.headInS !== undefined) {
        w.headInS -= dt;
        if (w.headInS <= 0) { delete w.headInS; w.consciousness = true; }
      }
      if (w.tourniquetS !== undefined) w.tourniquetS += dt;
      if (w.tension) tension = true;
      if (w.mechanism === "burn") burn += w.severity;
      if (w.breathing) breathing = true;
      if (w.airway) airway = true;
      if (w.consciousness) knockedOut = true;
    }
    let vol = p.bloodVolumeL - (bleed + k["burnFluidLps"]! * burn) * dt;
    if (p.fluidL !== undefined && p.fluidL > 0) {
      const run = Math.min(p.fluidL, k["fluidLps"]! * dt);
      p.fluidL -= run;
      vol = Math.min(v0, vol + run * k["fluidVolumeFactor"]!);
      if (p.fluidL <= 1e-9) delete p.fluidL;
    }
    p.bloodVolumeL = Math.max(0, vol);
    const loss = 1 - p.bloodVolumeL / v0;
    p.respiratory = clamp01(p.respiratory + ((breathing ? k["breathingShockPerS"]! : 0) + (airway ? k["airwayShockPerS"]! : 0) + (tension ? 1 / k["tensionDeathS"]! : 0)) * dt);
    const start = k["shockStartFraction"]!, out = k["unconsciousLossFraction"]!;
    // Cold blood: he dies of a smaller loss (the "lethal triad" of bleeding, cold and poor clotting).
    const dead = k["deathLossFraction"]! - (cold ? k["hypoDeathLossPerC"]! * (k["hypoC"]! - t) : 0);
    p.shock = Math.max(clamp01((loss - start) / (dead - start)), p.respiratory);
    // Cooling: only a man in shock (his body no longer keeps itself warm), towards the air temperature.
    if (p.shock > 0 && t > env.temperatureC) {
      const exposed = env.sheltered ? k["shelteredCoolFactor"]! : (1 + k["rainCoolK"]! * env.rain) * (1 + k["windCoolK"]! * Math.min(env.windMps, 15) / 15);
      const rate = k["coolPerS"]! * p.shock * ((t - env.temperatureC) / 22) * exposed * (p.warmed ? k["warmedCoolFactor"]! : 1);
      t = Math.max(env.temperatureC, t - rate * dt);
      p.coreTempC = t;
    }
    let c = knockedOut ? 0 : 1;
    c = Math.min(c, clamp01(1 - (loss - 0.8 * out) / (0.2 * out)), clamp01(1 - (p.respiratory - 0.6) / 0.25));
    if (p.pain >= (k["painCollapseAt"] ?? 2)) c = 0;
    if (t < k["coldOutC"]!) c = 0;
    p.consciousness = c;
    p.pain = Math.max(0, p.pain - k["painDecayPerS"]! * dt);
    if (loss >= dead || p.respiratory >= 1 || t <= k["coldDeathC"]!) { p.alive = false; p.consciousness = 0; }
  },
};

/**
 * Chance that a limb kept under a tourniquet for `seconds` is lost (M10.1 tourniquet clock; the end-of-battle
 * roll in M10.8 reads it): none up to the safe time, then rising linearly through the data's points.
 */
export function amputationChance(seconds: number, k: Readonly<Record<string, number>>): number {
  const pts: [number, number][] = [[k["ischaemiaSafeS"]!, 0], [k["ischaemiaMidS"]!, k["ischaemiaMidChance"]!], [k["ischaemiaLateS"]!, k["ischaemiaLateChance"]!]];
  if (seconds <= pts[0]![0]) return 0;
  for (let i = 1; i < pts.length; i++) {
    const [s1, c1] = pts[i]!, [s0, c0] = pts[i - 1]!;
    if (seconds <= s1) return c0 + ((c1 - c0) * (seconds - s0)) / (s1 - s0);
  }
  return pts[pts.length - 1]![1];
}

export const PHYSIOLOGY_MODELS: Record<string, PhysiologyModel> = { simple: simplePhysiology, medical: medicalPhysiology };
