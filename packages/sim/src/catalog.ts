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

/** A pace on foot ("walk", "run", "sneak", "crawl" ... data, not code). */
export interface FootModeDef {
  id: DefId;
  /** Which terrain cost column applies. */
  class: "foot";
  /** Posture taken for this mode. */
  posture: "standing" | "crouching" | "prone";
  /** Work rate (0 rest .. ~0.85 running): drives heart rate and fatigue. */
  exertion: number;
  /** Nominal speed on open, level ground, m/s. */
  speedMps: number;
  /** The vehicle pace a vehicle given this foot pace drives at, per vehicle class (M7). */
  vehiclePace: { tracked: DefId; wheeled: DefId };
}

/** A vehicle pace (M7): a share of the vehicle's own top speed. */
export interface VehiclePaceDef {
  id: DefId;
  class: "tracked" | "wheeled";
  speedFraction: number;
}

export type MovementModeDef = FootModeDef | VehiclePaceDef;

/** A foot pace by id; throws on a vehicle pace or an unknown id (foot code reads modes only through this). */
export function footMode(catalog: Catalog, id: DefId): FootModeDef {
  const m = catalog.movementModes[id];
  if (!m || m.class !== "foot") throw new Error(`'${id}' is not a foot pace`);
  return m;
}

/** A foot pace by id, or undefined (unknown id or a vehicle pace). */
export function footModeOrUndefined(catalog: Catalog, id: DefId): FootModeDef | undefined {
  const m = catalog.movementModes[id];
  return m && m.class === "foot" ? m : undefined;
}

/** Time multiplier per movement class; null = impassable. */
export type MoveCost = Record<MovementClass, number | null>;

export interface MaterialDef {
  id: DefId;
  densityKgM3: number;
  /** Penetration resistance, mm of mild steel equivalent per mm of material. */
  resistance: number;
  /** Resistance against shaped-charge jets, if it differs (M7). */
  resistanceShaped?: number;
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
  /** How vehicles drive on it (M7); absent: no vehicle can. */
  vehicle?: SurfaceVehicleDef;
}

/** Vehicle driving on a surface (M7): rolling resistance and friction coefficients, cap, rain factors. */
export interface SurfaceVehicleDef {
  rolling: number; traction: number; lateral: number; capKmh?: number;
  wetTractionFactor: number; wetRollingFactor: number;
}

/** A vehicle crossing a linear obstacle (M7). */
export interface VehicleCrossingDef { crossCostCells: number; capKmh: number; flattens: boolean }

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
  /** Per vehicle class: null = cannot cross (goes round). */
  vehicle: { tracked: VehicleCrossingDef | null; wheeled: VehicleCrossingDef | null };
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
  /** mm RHA x this = mild-steel-equivalent mm (M7). */
  rhaToMildSteel: number;
  blast: {
    severeScaledM: number; injuryScaledM: number; stunScaledM: number; stunSeconds: number; craterScaledM: number;
    breachSteelMmScaled: number; breachReachScaledM: number; breachWidthScaledM: number;
    /** A wall thinner than this (steel-equivalent mm) does not shield a man from blast. */
    shieldSteelMm: number;
  };
  fragments: { bandDeg: [number, number]; maxPerBurst: number; airburstAboveM: number; clutterHeightM: number; clutterStopPerM: number };
  bounce: { restitution: number; tangentKeep: number; softFactor: number; vegetationFactor: number; softBelowDensityKgM3: number; stopSpeedMps: number };
  /** Rounds against vehicle armour (M7.4a). */
  armour: { losFloorCos: number; grazeFuseCos: number; jetDecayMmPerM: number; spallComponentDamage: number; seatHalfM: number; seatHeightM: number };
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
  explosive?: { fillingKg: number; fragmentCount: number; fragmentAmmo: DefId; fragmentVelocityMps: [number, number]; fuseSeconds?: number; armingSeconds?: number; /** Bursts on a man it strikes (M7.3, Q18). */ burstOnBody?: boolean; /** Rockets (M7.4a). */ selfDestructSeconds?: number };
  /** Rocket motor (M7.4a). */
  propulsion?: { ignitionSeconds: number; burnSeconds: number; accelMps2: number };
  /** Wire-guided (SACLOS) missiles (owner 2026-11-13; full guided weapons M9). */
  guided?: { cruiseMps: number; accelMps2: number; turnRateDegS: number; minRangeM: number; maxRangeM: number; trackErrorMrad: number; trackTauS: number; lookaheadS: number; lostKickMrad: number };
  /** Kinetic rounds against armour (M7.4a): ricochet threshold factor (default 1). */
  ricochetFactor?: number;
  /** Fragments thrown inside a hull it penetrates (M7.4a, owner Q11). */
  behindArmour?: { spallCount: number; spallConeDeg: number; spallEnergyJ: number };
  /** Smoke (M7.3): a multispectral cloud blinds thermal sights too. */
  multispectral?: boolean;
  /** Thrown by hand or fired from a launcher item the soldier carries. */
  delivery?: { method: "thrown" | "launched" | "direct"; velocityMps?: number; launcher?: DefId; maxRangeM?: number; dispersionMrad?: number; aimSeconds?: number; backblastM?: number; disposable?: boolean };
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
    /** Aim height above the ground at a man seen in each posture (soldier AI package A). */
    aimHeightByPostureM: Record<"standing" | "crouching" | "prone", number>;
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
  suppression: { nearMissRadiusM: number; perRound: number; energyRefJ: number; blastFactor: number; blastRadiusScale: number; decayPerS: number; max: number; heavyEnergyCap?: number };
  stress: { fromSuppressionPerS: number; casualtyNearbyM: number; fromCasualty: number; fromLeaderLoss: number; fromWound: number; decayPerS: number; experienceDamp: number; leaderNearbyM: number; leaderNearbyDamp: number; quietBelowSuppression: number; fromOwnVehiclePenetrated?: number; fromOwnVehicleStruck?: number };
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
  /**
   * Surrender (M6.6, owner 2026-11-12): the same for every side. 0 switches a rule off.
   * stepSeconds: how often each man reconsiders. downedEnemyM / comradeNearM: a wounded man who cannot fight
   * gives up with a known enemy this close and no fit comrade this close. caughtEnemyM: a panicked or routed
   * man gives up with a known enemy this close. captureM: a fit enemy this close takes him prisoner.
   * attackerDownedEnemyM / attackerPanicGivesUp: the same for a man of the attacking side or of a unit in an
   * assault (owner: attackers are less likely to give up).
   * fetchWithinM / fetchQuietSeconds / fetchTimeoutSeconds: one fit enemy this close who saw the surrender
   * walks over when his unit has not been fired upon for this long, and gives the errand up after this long.
   */
  surrender: {
    stepSeconds: number; downedEnemyM: number; comradeNearM: number; caughtEnemyM: number; attackerDownedEnemyM: number; attackerPanicGivesUp: boolean; captureM: number;
    fetchWithinM: number; fetchQuietSeconds: number; fetchTimeoutSeconds: number;
  };
  /**
   * Getting in and out of vehicles (M7.2). boardReachM: a man this close to an exit can board; approachReplanM:
   * his walk to the exit is planned again when the hull has moved this far; casualtyLoadM / carriersWithinM: a
   * wounded man this close to an exit is loaded by two comrades if two able men are this close to him (owner
   * Q25); completeAfterSeconds / giveUpSeconds: boarding ends this long after the first man got in, or after
   * this long at all; exitFanMinM/MaxM: men getting out land this far behind the exit; remountM: a withdrawing
   * squad this close to its vehicle gets back in (Q24); holdDismountM: a squad aboard this close to an objective
   * it holds gets out; resupplyRangeM / resupplyReachM / resupplyCount: a man out of spare walks to a halted own
   * vehicle this close and takes this many from it standing this close to an exit; seatSwapCheckSeconds: how
   * often a crew sees whether a fallen driver or gunner must be replaced.
   */
  mounting: {
    boardReachM: number; approachReplanM: number; casualtyLoadM: number; carriersWithinM: number;
    completeAfterSeconds: number; giveUpSeconds: number; exitFanMinM: number; exitFanMaxM: number;
    remountM: number; holdDismountM: number; resupplyRangeM: number; resupplyReachM: number; resupplyCount: number; seatSwapCheckSeconds: number;
  };
  /**
   * Vehicle gunnery (M7.3). stepSeconds: how often a crew chooses its target. A crew engages what it has seen
   * within seenWithinSeconds, or a comrade's report no vaguer than reportedErrorM and younger than
   * reportedWithinSeconds. groupRadiusM: men this close together are a group (HE); a single man within
   * coaxSingleWithinM gets the coaxial machine gun. Target score = range x vehicleScore for a vehicle x
   * firingScore for an enemy firing now (lower is first). The commander fires the gun when the gunner is out. lrfRangeErrorFraction: range error with a laser
   * rangefinder. refillBelowFraction: halted, a crew refills a ready belt below this share of full.
   * friendlyClearM: no fire at a point this close to own men on foot. scanReturnSeconds: the turret comes back
   * to the front this long after its last target. dischargeAheadM: unused distance reserve for the smoke screen.
   */
  gunnery: {
    stepSeconds: number; seenWithinSeconds: number; reportedErrorM: number; reportedWithinSeconds: number;
    groupRadiusM: number; coaxSingleWithinM: number; vehicleScore: number; firingScore: number;
    lrfRangeErrorFraction: number; refillBelowFraction: number;
    friendlyClearM: number; scanReturnSeconds: number; dischargeAheadM: number;
    /** Guided missiles (owner 2026-11-13; see the schema). */
    missileBeyondM?: number; missileHaltedMps?: number; missileSightSeconds?: number; missileSeenFloor?: number; missileHitLoseChance?: number;
  };
  /**
   * Shoulder-fired anti-tank weapons (M7.4a, owner Q19/Q20). atRuleDefault: a unit's standing rule unless set;
   * a man looks once per stepSeconds for an enemy vehicle he saw within seenWithinSeconds; his range error
   * (fraction) and aiming error (mrad, regular soldier) add to the round's dispersion. No shot from inside a
   * house smaller than largeRoomM2 that is not breached, nor with a wall within wallBehindM behind him; a
   * comrade within handOverM brings him a round when he has none.
   */
  antitank: { atRuleDefault: "vehicles" | "vehiclesAndPositions" | "hold"; stepSeconds: number; seenWithinSeconds: number; rangeErrorFraction: number; skillMrad: number; largeRoomM2: number; wallBehindM: number; handOverM: number };
  /**
   * Crews of damaged vehicles (M7.4a, owner Q14/Q15): men get out bailOnFireSeconds after a fire starts; a fire
   * burns the vehicle out (destroyed) after burnSeconds, the ammunition may cook off every cookOffCheckSeconds;
   * a burning vehicle makes smoke; men still inside a destroyed vehicle are burnt (severity range).
   */
  /**
   * Individual soldier AI (owner 2026-11-13, packages A-D; game values, low).
   * reserveCloseM / reserveAssaultM: a rifleman down to his last magazine fires it only at an enemy this close, or
   * this close and assaulting. longRangeM / longRangeIntervalFactor: beyond this range a rifleman's pause between
   * shots is this many times longer. keepTargetFactor: a man changes his own target only for one that scores
   * below this fraction of the current one (or when the current one is down or out of sight).
   * B: crawlMode (movement mode id) / crawlSearchM / crawlRetrySeconds: a pinned or panicked man in sight of the
   * enemy crawls to cover this near, at most this often. minSpacingM: men going to cover keep this far from each
   * other's places. beaten*: enemy mortar bursts within beatenNoticeM are remembered for beatenMemorySeconds; a man
   * halted in the open within beatenRadiusM of the mission goes into a house within beatenHouseM, else beatenMoveM
   * out of it.
   * C: riseBelowSuppression: a man not pinned whose suppression is below this takes his fire position's posture
   * again; lookEverySeconds: how often a man lying blind to the enemy he knows checks whether to rise and look;
   * rearWatchMinMen: in a team of this many idle men the last watches the rear; atMove*: a man with an anti-tank
   * launcher who knows of an enemy vehicle he cannot see (contact within atContactSeconds) moves up to atMoveM to
   * a spot that sees it, at least atMoveMinRangeM from it, at most every atMoveRetrySeconds.
   */
  soldier: {
    reserveCloseM: number; reserveAssaultM: number; longRangeM: number; longRangeIntervalFactor: number; keepTargetFactor: number; keepTargetSeenSeconds: number;
    crawlMode: string; crawlSearchM: number; crawlRetrySeconds: number; minSpacingM: number;
    beatenNoticeM: number; beatenRadiusM: number; beatenMemorySeconds: number; beatenMoveM: number; beatenHouseM: number; beatenOpenExposure: number;
    riseBelowSuppression: number; lookEverySeconds: number; faceEnemy: boolean; rearWatchMinMen: number;
    atMoveM: number; atMoveMinRangeM: number; atMoveRetrySeconds: number; atContactSeconds: number;
  };
  crew: { bailOnFireSeconds: number; burnSeconds: number; cookOffCheckSeconds: number; cookOffChancePerCheck: number; fireSmokeRadiusM: number; occupantBurnSeverity: [number, number]; reactionStepSeconds: number; recentHitSeconds: number; reverseOutM: number; reverseHoldSeconds: number; atThreatM: number };
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
  sensors: Record<string, { factor: number; fromM: number; nightLight: number; smokeFactor?: number; maxRangeM?: number; fogFloorM?: number; rainFactor?: number }>;
  /** Vehicles as targets and contacts (M7.3). */
  vehicles: {
    referenceAreaM2: number; targetMaxRangeM: number; movingAboveMps: number; maxTracked: number; driftMps: number; forgetSeconds: number;
    engineEverySeconds: number; surfaceBase: number; rainK: number; downwind: number; upwind: number;
  };
  skillSlope: number; stressK: number; lightFloor: number;
  minVisibility: number; smokeExtinctionPerM: number; smokeBuildSeconds: number; keepRateFactor: number; forgetSeconds: number; maxTracked: number;
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
    /** Run over by a vehicle (M7.1c): severity drawn between min and max, bleeding per unit severity. */
    crush?: { severityMin: number; severityMax: number; bleedLps: number };
    /** Heavy projectiles (M7.3): a round this wide or wider wounds at least this badly. */
    heavy?: { minDiameterM: number; severityMin: number };
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
  /** Mortar fire the platoon can call (M6.5c); none if absent. */
  fireSupport?: { heAmmo: DefId; smokeAmmo: DefId; delaySeconds: number; dispersionM: number; intervalSeconds: number; smokeRadiusM: number; smokeSeconds: number; roundsFactor: number };
  /** Where the AI gets its men out of their vehicles (M7.2, owner Q22: per side, from doctrine research): this far
   *  short of the objective, at a point out of sight of the enemy if there is one. Absent: no doctrine given. */
  dismountM?: number;
  /** After the squads are out (M7.3): vehicles stay in overwatch, or follow the squads `followM` behind. */
  afterDismount?: { kind: "overwatch" | "follow"; followM: number };
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
  /** Vehicle types of the factions taking part (M7). */
  vehicles: Record<DefId, VehicleDef>;
}

/** Generic crew and passenger station kinds (code keys). */
export type StationKind = "commander" | "gunner" | "driver" | "loader" | "passenger";

/** A box in hull coordinates (f forward, r right, u up from the ground), [min, max] metres. */
export interface HullBox { f: [number, number]; r: [number, number]; u: [number, number] }

/** A vehicle type (M7, factions/<id>/vehicles.json). SI units: speeds m/s, angles rad, power W. */
export interface VehicleDef {
  id: DefId;
  class: "tracked" | "wheeled";
  body: {
    lengthM: number; widthM: number; heightM: number; groundClearanceM: number;
    hull: HullBox;
    turret?: { pivotF: number; f: [number, number]; r: [number, number]; u: [number, number]; barrelM: number; trunnionU: number };
    trackContactM?: number; trackGaugeM?: number; wheelbaseM?: number;
  };
  massKg: number;
  drive: {
    powerW: number; efficiency: number; topSpeedMps: number; reverseTopSpeedMps: number; brakeMps2: number;
    /** Upper end of each gear band, m/s (ascending; the last is the top speed). */
    gearsMps: number[]; reverseGearsMps: number[];
    shiftSeconds: number;
    steering:
      | { kind: "tracked"; pivot: boolean; pivotRateRadS: number; maxLatAccelMps2: number; slipCoeff: number; turnResistance: number }
      | { kind: "wheeled"; maxSteerRad: number; steerRateRadS: number; maxLatAccelMps2: number };
    idleW: number; litresPerKwh: number;
  };
  fuel: { item: DefId; capacityL: number };
  seats: { id: string; station: StationKind; pos: [number, number, number]; part: "hull" | "turret"; hatch: boolean;
    sensors?: { kind: string; pos?: [number, number, number]; arcRad: number; sideFactor: number; rearFactor: number; follows: "own" | "station"; lrf?: boolean }[] }[];
  ramp: { exits: [number, number][]; openSeconds: number; mountSecondsPerMan: number; dismountSecondsPerMan: number; bailOutSeconds: number; seatSwapSeconds: number; loadCasualtySeconds: number };
  stations: {
    id: string; kind: "turret" | "mount"; operator: StationKind; commanderOverride: boolean;
    traverseRadS: number; elevateRadS: number; elevationRad: [number, number]; traverseArcRad?: [number, number];
    stabiliser: "none" | "one-plane" | "two-plane"; baseErrorMrad: number; movingMradPerMps: number; layToleranceMrad: number;
    rangefinder: boolean; readyRefillInBattle: boolean;
    /** Seconds to refill the ready belts from stowage, halted (absent: no refill in battle). */
    refillSeconds?: number;
    weapons: {
      weapon: DefId; coax: boolean; muzzle: [number, number, number]; feeds: { item: DefId; ready: { count: number; charge: number } }[];
      switchSeconds: number; engageRangeM: number; feedKind: "belt" | "single" | "autoloader";
      loaderStation?: StationKind; roundLoadSeconds?: number; noLoaderFactor?: number;
    }[];
  }[];
  stowed: { item: DefId; count: number; charge?: number }[];
  cookOffAmmo?: DefId;
  /** Armour plates (M7.4a): one per part and face; absent = rounds stop at the hull as before. Add-on tiles
   *  against shaped charges (M7.4b): one `item` used up per hit on that part and face, `factor` times the need. */
  armour?: { plates: VehiclePlate[]; tiles?: { part: "hull" | "turret"; face: "front" | "side" | "rear" | "top"; item: DefId; factor: number }[] };
  /** Fire extinguishing (M7.4b): charges `item` in the container, each puts a fire out with `chance`. */
  extinguisher?: { item: DefId; chance: number; delaySeconds: number };
  /** Active protection (M7.4b, fixture only): charges `item`, engaged rockets burst `standoffM` short. */
  activeProtection?: { item: DefId; detectM: number; standoffM: number; interceptChance: number; cooldownSeconds: number };
  /** Components a penetrating round can damage (M7.4a). Index = `VehicleState.comp`. */
  components?: VehicleComponent[];
  /** Smoke dischargers (M7.3). */
  dischargers?: { item: DefId; perSalvo: number; salvos: number; arcRad: number; rangeM: number; delaySeconds: number; cloudRadiusM: number; cloudSeconds: number };
  /** How it is seen and heard (M7.3; defaults when the data gives none). */
  signature: { sizeFactor: number; movingFactor: number; firingFactor: number; identifyM: number; noiseIdleM: number; noiseMovingM: number; aimPoints: [number, number, number][] };
}

export interface VehiclePlate { part: "hull" | "turret"; face: "front" | "side" | "rear" | "top"; material: DefId; thicknessMm: number; slopeDeg: number }
/** What a vehicle part is (M7.4a/b); the effect of its damage is in systems/armour.ts. */
export type ComponentKind = "engine" | "transmission" | "track" | "turret-drive" | "stabiliser" | "gun" | "coax" | "sights" | "radio" | "dischargers" | "extinguisher" | "ammo" | "fuel";
export interface VehicleComponent {
  id: string; kind: ComponentKind; part: "hull" | "turret";
  box: { f: [number, number]; r: [number, number]; u: [number, number] };
  external?: boolean; toughnessMm: number; absorbMm: number; fireChance?: number; cookOffChance?: number;
}

export function getItemDef(catalog: Catalog, id: DefId): ItemTypeDef {
  const d = catalog.items[id];
  if (!d) throw new Error(`Unknown item type '${id}'`);
  return d;
}
