/**
 * The CATALOG is the static, read-only rulebook a battle runs with: item types, factions, movement
 * modes, quality levels and so on. It is produced from data files by @tcs/data (validated there) and
 * handed to the simulation. The simulation never branches on a specific faction or item ID; it only
 * reads numbers and flags from these definitions (SPEC 4.3 rule 8).
 *
 * Only the fields the simulation reads are declared here. Data files may carry more (sources,
 * confidence, notes) which the loader keeps out of the sim.
 */
import type { DefId } from "./ids";

export interface ItemTypeDef {
  id: DefId;
  /** Mass of one item, kg (for a magazine: the empty magazine). */
  massKg: number;
  /** Category, used by systems to find items generically ("magazine", "grenade", "medical", "armour", ...). */
  category: string;
  /** For items that hold a charge (rounds in a magazine, Wh in a battery, litres in a can): maximum charge. */
  chargeCapacity?: number;
  /** Mass of one unit of charge, kg (one round, one litre ...). */
  chargeMassKg?: number;
  /** Which ammunition type the charge consists of (for magazines and belts). */
  chargeItem?: DefId;
}

export type MovementClass = "foot" | "wheeled" | "tracked";

export interface MovementModeDef {
  id: DefId; // "walk" | "run" | "sneak" | "crawl" | "wheeled" | "tracked" ... (data, not code)
  /** Which terrain cost column applies. */
  class: MovementClass;
  /** Posture taken for this mode. */
  posture: "standing" | "crouching" | "prone";
  /** Work rate (0 rest .. ~0.85 running): drives heart rate and fatigue. */
  exertion: number;
  /** Nominal speed on open, level ground, m/s. */
  speedMps: number;
}

/** Time multiplier per movement class; null = impassable. */
export type MoveCost = Record<MovementClass, number | null>;

export interface MaterialDef {
  id: DefId;
  densityKgM3: number;
  /** Penetration resistance, mm of mild steel equivalent per mm of material. */
  resistance: number;
  /** Largest angle from the surface at which a bullet can still ricochet, degrees. */
  ricochetAngleDeg: number;
  /** Soft-core bullets break up in this material at high impact speed. */
  breaksBullets: boolean;
}

export interface SurfaceDef {
  id: DefId;
  moveCost: MoveCost;
  noise: number;
  dust: number;
  /** Presentation colour (#rrggbb), kept in data so new surfaces need no code. */
  colour: string;
  /** Material of the ground for bullet impacts and ricochets. */
  material: DefId;
}

export interface VegetationDef {
  id: DefId;
  heightM: number;
  concealmentPerM: number;
  stoppingPerM: number;
  moveCost: MoveCost;
  colour: string;
}

export interface ObstacleKindDef {
  id: DefId;
  heightM: number;
  thicknessM: number;
  material: DefId;
  seeThrough: number;
  footCrossTimeS: number | null;
  wheeledCrossable: boolean;
  trackedCrossable: boolean;
  colour: string;
}

export interface BuildingKindDef {
  id: DefId;
  widthM: [number, number];
  depthM: [number, number];
  storeys: [number, number];
  storeyHeightM: number;
  wallMaterial: DefId;
  wallThicknessM: number;
  roofColours: string[];
}

/** Body model parameters (core/body.json): postures, movement and physiology. All data-driven. */
export interface BodyDef {
  postures: Record<"standing" | "crouching" | "prone", { heightM: number; speedFactor: number; muzzleHeightM: number }>;
  transitions: { values: Record<string, number>; freeLoadKg: number; slowdownPerKg: number };
  movement: {
    slopeK: number; slopeOffset: number; loadFreeKg: number; loadSpeedPerKg: number; minLoadSpeedFactor: number;
    fatigueSpeedPenalty: number; noRunFatigue: number; hardPaceExertion: number; exhaustedSpeedFactor: number;
    slopeLookAheadM: number; runAgainFatigue: number;
  };
  physiology: {
    bodyMassKg: number; loadExertionK: number; slopeExertionK: number; sustainable: number; fatigueGainPerS: number;
    recoveryPerS: number; hrRestBpm: number; hrMaxBpm: number; hrRiseTauS: number; hrFallTauS: number;
    heatThresholdC: number; heatPerC: number; postureChangeExertion: number; hrExertionWeight: number;
    hrFatigueWeight: number; exhaustedExertionFactor: number;
  };
}

/** Global ballistics parameters (core/ballistics.json). */
export interface BallisticsDef {
  gravityMps2: number;
  airDensityKgM3: number;
  referenceTempC: number;
  penetrationVelocityExponent: number;
  penetrationDeflectionDeg: number;
  ricochetSpeedRetention: [number, number];
  ricochetScatterDeg: number;
  minSpeedMps: number;
  maxFlightSeconds: number;
}

export interface AmmoDef {
  id: DefId;
  calibre: string;
  /** "ball", "tracer", "high-explosive", ... (SPEC 6.3 list; data, not code branches on IDs). */
  kind: string;
  projectileMassKg: number;
  cartridgeMassKg: number;
  diameterM: number;
  /** Cd(v) = a + b / v, capped at max. */
  drag: { a: number; b: number; max: number };
  tracerBurnoutM?: number;
  penetration: { steelMm: number; atVelocityMps: number; breakupVelocityMps?: number };
  tracer: boolean;
  fuse: string;
  guidance: string;
  explosive?: { fillingKg: number; fragmentCount: number; fragmentMassKg: number; fragmentVelocityMps: [number, number] };
}

export interface WeaponDef {
  id: DefId;
  type: string;
  calibre: string;
  massKg: number;
  feed: { magazine: DefId };
  fireModes: string[];
  cyclicRpm: number;
  dispersionMrad: number;
  reloadSeconds: number;
  setupSeconds: number;
  jamProbability: number;
  sights: { kind: string; magnification: number }[];
  /** Ammunition ID -> muzzle velocity from this weapon, m/s. */
  ammo: Record<DefId, number>;
}

/** Aiming error and fire control parameters (core/shooting.json). */
export interface ShootingDef {
  aim: {
    baseMrad: number; skillSlope: number; minSkillFactor: number;
    postureFactor: Record<"standing" | "crouching" | "prone", number>;
    fatigueK: number; heartRateK: number; heartRateCalmBpm: number; suppressionK: number;
    rapidFactor: number; burstGrowth: number; sightFactor: Record<string, number>; rangeErrorFraction: number;
  };
  fire: {
    bands: { maxRangeM: number; mode: "aimed" | "rapid" | "burst"; intervalS: number; burstRounds: number }[];
    fullRateSeconds: number; trickleIntervalS: number; trickleSeconds: number; incomingRadiusM: number;
    topUpAfterSeconds: number; clearStoppageSeconds: number; aimPointHeightM: number; safetyConeDeg: number;
  };
}

export interface TerrainCatalog {
  materials: Record<DefId, MaterialDef>;
  surfaces: Record<DefId, SurfaceDef>;
  vegetation: Record<DefId, VegetationDef>;
  obstacles: Record<DefId, ObstacleKindDef>;
  buildings: Record<DefId, BuildingKindDef>;
}

export interface QualityDef {
  id: DefId; // "conscript" | "regular" | "veteran" ...
  /** Mean and standard deviation of each skill, 0..1. */
  skills: Record<string, { mean: number; sd: number }>;
}

export interface FactionDef {
  id: DefId;
  /** Key into the string table for the faction's display name. */
  nameKey: string;
  /** Doctrine profile values (data-driven behaviour weights; SPEC 6.6). */
  doctrine: Record<string, number>;
  /** Formation used when an order names none. */
  defaultFormation: DefId;
}

export interface FormationDef {
  id: DefId;
  /** [right, back] offsets in units of spacing; slot 0 = leader. */
  slots: [number, number][];
}

export interface Catalog {
  /** Content fingerprint of the loaded data (stable hash). Stored in battle results and saves. */
  fingerprint: string;
  items: Record<DefId, ItemTypeDef>;
  movementModes: Record<DefId, MovementModeDef>;
  qualities: Record<DefId, QualityDef>;
  factions: Record<DefId, FactionDef>;
  terrain: TerrainCatalog;
  body: BodyDef;
  formations: Record<DefId, FormationDef>;
  ballistics: BallisticsDef;
  shooting: ShootingDef;
  ammo: Record<DefId, AmmoDef>;
  /** Ammunition IDs in ascending order; projectiles store the index into this list. */
  ammoIds: DefId[];
  weapons: Record<DefId, WeaponDef>;
}

export function getItemDef(catalog: Catalog, id: DefId): ItemTypeDef {
  const d = catalog.items[id];
  if (!d) throw new Error(`Unknown item type '${id}'`);
  return d;
}
