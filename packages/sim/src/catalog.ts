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
  /** A sensor kind the wearer looks through (core/spotting.json `sensors`). */
  sensor?: string;
  /** Belts: every `tracerEvery`-th round is `tracerItem`. */
  tracerItem?: DefId;
  tracerEvery?: number;
  /** Body armour and helmets: zones covered (zone group: "arm" and "leg" cover both sides). */
  armour?: { zone: string; coverageFront: number; coverageSide: number; protectionSteelMm: number }[];
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
  roofMaterial: DefId;
  roofThicknessM: number;
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
  blast: {
    severeScaledM: number; injuryScaledM: number; stunScaledM: number; stunSeconds: number; craterScaledM: number;
    breachSteelMmScaled: number; breachReachScaledM: number; breachWidthScaledM: number;
    /** A wall thinner than this (steel-equivalent mm) does not shield a man from blast. */
    shieldSteelMm: number;
  };
  fragments: { bandDeg: [number, number]; maxPerBurst: number; airburstAboveM: number; clutterHeightM: number; clutterStopPerM: number };
  bounce: { restitution: number; tangentKeep: number; softFactor: number; vegetationFactor: number; softBelowDensityKgM3: number; stopSpeedMps: number };
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
  explosive?: { fillingKg: number; fragmentCount: number; fragmentAmmo: DefId; fragmentVelocityMps: [number, number]; fuseSeconds?: number; armingSeconds?: number };
  /** Thrown by hand or fired from a launcher item the soldier carries. */
  delivery?: { method: "thrown" | "launched"; velocityMps?: number; launcher?: DefId; maxRangeM?: number };
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
  /** Machine guns: always fires bursts of this many rounds, this many seconds apart, whatever the range. */
  sustained?: { burstRounds: number; intervalS: number; recoilFactor: number };
}

/** Aiming error and fire control parameters (core/shooting.json). */
export interface ShootingDef {
  aim: {
    baseMrad: number; skillSlope: number; minSkillFactor: number;
    postureFactor: Record<"standing" | "crouching" | "prone", number>;
    fatigueK: number; heartRateK: number; heartRateCalmBpm: number; suppressionK: number;
    rapidFactor: number; burstGrowth: number; sightFactor: Record<string, number>; rangeErrorFraction: number;
    settleK: number; settleTauS: number; bracedFactor: number;
  };
  fire: {
    bands: { maxRangeM: number; mode: "aimed" | "rapid" | "burst"; intervalS: number; burstRounds: number }[];
    fullRateSeconds: number; trickleIntervalS: number; trickleSeconds: number; incomingRadiusM: number;
    topUpBelowFraction: number; incomingReachM: number; topUpAfterSeconds: number; clearStoppageSeconds: number; aimPointHeightM: number; safetyConeDeg: number;
  };
  grenades: {
    throwRangeM: Record<"standing" | "crouching" | "prone", number>; throwElevationDeg: number;
    throwErrorFraction: number; throwErrorMinM: number; throwSeconds: number;
    launchErrorFraction: number; launchErrorMinM: number; launchSeconds: number; minSafeDistanceM: number;
    throwAnglesDeg: number[]; throwPowerMargin: number; carrySeconds: number; staggerSeconds: number;
    reactRadiusM: number; runRadiusM: number; reactDelaySeconds: number;
  };
}

export interface HitboxDef {
  widthM: number; depthM: number; heightM: number; along: "height" | "length";
  bands: { zone: string; from: number; to: number; halfWidthM: number; armsToM?: number }[];
}
export interface ZoneWoundDef {
  severityBase: number; severitySpread: number; fatalAt: number; unconsciousAt: number;
  bleedLps: number; compressible: boolean; airway: boolean; breathing: boolean;
}
export interface BehaviourDef {
  suppression: { nearMissRadiusM: number; perRound: number; energyRefJ: number; blastFactor: number; blastRadiusScale: number; decayPerS: number; max: number };
  stress: { fromSuppressionPerS: number; casualtyNearbyM: number; fromCasualty: number; fromLeaderLoss: number; fromWound: number; decayPerS: number; experienceDamp: number; leaderNearbyM: number; leaderNearbyDamp: number; quietBelowSuppression: number };
  states: { pinnedSuppression: number; unpinnedBelow: number; cautiousStress: number; shakenStress: number; panickedStress: number; calmBelowStress: number };
  effects: { pinnedFireRateFactor: number; shakenFireRateFactor: number };
  stepSeconds: number;
  /** Soldier decisions (M4.2). */
  decisions: {
    stepSeconds: number; defaultFireRule: FireRule;
    engageRangeM: { rifle: number; magnified: number; sustained: number };
    underFireSuppression: number; underFireMemorySeconds: number; seenWithinSeconds: number; contactLostSeconds: number;
    seekCoverSuppression: number; coverSearchM: number; coverRetrySeconds: number; threatEyeHeightM: number;
    shareRangeM: number; keepSpare: number; passSeconds: number;
    ammoIntervalFactor: Record<AmmoRule, number>;
  };
  /** Squad drills (M4.3). */
  drills: {
    stepSeconds: number; reactToContact: boolean; boundM: number; finalM: number; phaseTimeoutSeconds: number; spreadM: number;
    breakPanickedFraction: number; rallyDistanceM: number; rallyQuietSeconds: number; rallyStressFactor: number; fallBackM: number;
  };
}

/** Standing fire rule of a unit: fire at any enemy seen, only once fired upon, or not at all without orders. */
export type FireRule = "free" | "return" | "hold";
/** Standing rule for contact while moving (M5): go to ground, push on, or fall back. */
export type ContactRule = "ground" | "push" | "back";
/** Ammunition discipline (M5): slower, normal or faster fire. */
export type AmmoRule = "conserve" | "normal" | "max";

export interface SpottingDef {
  scanSeconds: number; baseRatePerS: number; referenceRangeM: number; rangeExponent: number; minRangeM: number; maxRangeM: number;
  postureSize: Record<"standing" | "crouching" | "prone", number>;
  stillBelowMps: number; movingFactor: number; runningAboveMps: number; runningFactor: number; movingVisibilityFloor: number;
  firingWithinSeconds: number; firingFactor: number; firingVisibilityFloor: number;
  frontHalfAngleDeg: number; sideHalfAngleDeg: number; sideFactor: number; rearFactor: number;
  sensors: Record<string, { factor: number; fromM: number; nightLight: number }>;
  skillSlope: number; stressK: number; lightFloor: number;
  minVisibility: number; keepRateFactor: number; forgetSeconds: number; maxTracked: number;
  contacts: {
    seenErrorM: number; seenErrorPerM: number; hearingRangeM: number; bearingErrorDeg: number; rangeErrorFraction: number;
    heardEverySeconds: number; forgetSeconds: number; driftMps: number; reportEverySeconds: number; reportedErrorM: number;
    voiceDelaySeconds: number; callEverySeconds: number;
  };
}

/** Body outline, wounding and simple physiology parameters (core/wounds.json). */
export interface WoundsDef {
  hitboxes: Record<"standing" | "crouching" | "prone", HitboxDef>;
  zones: Record<string, ZoneWoundDef>;
  wounding: {
    referenceEnergyJ: number; energyFactorMin: number; energyFactorMax: number; bleedFloor: number; bleedPower: number;
    bluntSeverity: number; knockdownSeconds: number; flagSeverity: number;
    /** A round striking an arm from the side goes on into the trunk with this chance, keeping this share of its energy. */
    throughArmChance: number; throughArmEnergy: number;
    /** Severity scales with (energy / referenceEnergyJ) to this power. */
    energyExponent: number;
    /** Fragments: below minEnergyJ no wound; severity factor = (energy / referenceEnergyJ)^exponent within [factorMin, factorMax]. */
    fragment: { minEnergyJ: number; referenceEnergyJ: number; exponent: number; factorMin: number; factorMax: number };
    /** Blast wounds: severity at the edge of the injury radius and at the severe radius or nearer. */
    blast: { severityInjury: number; severitySevere: number; bleedLps: number };
    /** Share of its speed a bullet keeps on leaving a limb / the trunk or head. */
    exit: { limb: number; trunk: number };
  };
  physiology: Record<string, number>;
  effects: {
    legNoWalkSeverity: number; armNoFightSeverity: number; painNoFightAt: number; painPerWoundK: number;
    moveSeverityK: number; aimSeverityK: number; aimPainK: number; minMoveFactor: number;
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
  wounds: WoundsDef;
  /** Suppression, stress and behaviour states (core/behaviour.json, M4). */
  behaviour: BehaviourDef;
  /** Detection (core/spotting.json, M3.2). */
  spotting: SpottingDef;
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
