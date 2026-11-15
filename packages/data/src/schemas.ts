/**
 * Schemas for every data file. Each file is validated on load; errors name the file and the path.
 * Every entry carries `sources` (URLs) and `confidence` (SPEC 3, 7).
 */
import { z } from "zod";

export const Confidence = z.enum(["high", "medium", "low"]);

/**
 * Provenance carried by every entry. Sources are URLs. An entry with no source must be marked
 * confidence "low" and explain itself in `note` (a game-design value, not a researched fact).
 */
export const Provenance = z.object({
  sources: z.array(z.url()),
  confidence: Confidence,
  note: z.string().optional(),
});

const Id = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "ids are lower-case letters, digits and '-'");

const withProv = <T extends z.ZodRawShape>(shape: T) => z.object({ ...shape, ...Provenance.shape }).strict();

// ---------- core ----------
export const MovementClass = z.enum(["foot", "wheeled", "tracked"]);
export const PostureId = z.enum(["standing", "crouching", "prone"]);
/** A pace on foot (M1). */
export const FootModeSchema = withProv({
  id: Id, nameKey: z.string(), class: z.literal("foot"), speedMps: z.number().positive().max(40),
  /** Posture a soldier takes for this mode. */
  posture: PostureId,
  /** Work rate of moving in this mode (0 = resting, ~0.85 = running); drives heart rate and fatigue. */
  exertion: z.number().min(0).max(2),
  /** The vehicle pace a vehicle given this foot pace drives at (M7: a platoon order in "walk" moves its IFVs
   *  at a slow drive), per vehicle class. */
  vehiclePace: z.object({ tracked: Id, wheeled: Id }).strict(),
});
/** A vehicle pace (M7): a share of the vehicle's own top speed. */
export const VehiclePaceSchema = withProv({
  id: Id, nameKey: z.string(), class: z.enum(["tracked", "wheeled"]), speedFraction: z.number().positive().max(1),
});
export const MovementModeSchema = z.discriminatedUnion("class", [FootModeSchema, VehiclePaceSchema]);
export const MovementModesFile = z.object({ movementModes: z.array(MovementModeSchema).min(1) }).strict();

export const SKILL_KEYS = ["marksmanship", "fieldcraft", "medical", "leadership", "experience"] as const;
const SkillDist = z.object({ mean: z.number().min(0).max(1), sd: z.number().min(0).max(0.5) }).strict();
export const QualitySchema = withProv({
  id: Id,
  nameKey: z.string(),
  skills: z.object(Object.fromEntries(SKILL_KEYS.map((k) => [k, SkillDist])) as Record<(typeof SKILL_KEYS)[number], typeof SkillDist>).strict(),
});
export const QualitiesFile = z.object({ qualities: z.array(QualitySchema).min(1) }).strict();

export const StringsFile = z.record(z.string(), z.string());

// ---------- body (core/body.json): postures, movement and physiology parameters ----------
const Num = (lo: number, hi: number) => z.number().min(lo).max(hi);
export const BodyFile = z.object({
  postures: z.array(withProv({ id: PostureId, heightM: Num(0.1, 2.5), speedFactor: Num(0.05, 1), muzzleHeightM: Num(0.05, 2.5) })).length(3),
  transitions: withProv({
    values: z.record(z.string().regex(/^(standing|crouching|prone)>(standing|crouching|prone)$/), Num(0.05, 10)),
    freeLoadKg: Num(0, 100), slowdownPerKg: Num(0, 0.2),
  }),
  movement: withProv({
    slopeK: Num(0, 10), slopeOffset: Num(-0.5, 0.5), loadFreeKg: Num(0, 100), loadSpeedPerKg: Num(0, 0.05),
    minLoadSpeedFactor: Num(0.1, 1), fatigueSpeedPenalty: Num(0, 1), noRunFatigue: Num(0, 1),
    /** Paces with exertion above this count as "hard" (running): exhausted men cannot keep them up. */
    hardPaceExertion: Num(0, 2), exhaustedSpeedFactor: Num(0.05, 1), slopeLookAheadM: Num(0.5, 20),
    /** Once winded (fatigue >= noRunFatigue) a man runs again only when fatigue falls below this. */
    runAgainFatigue: Num(0, 1),
  }),
  physiology: withProv({
    bodyMassKg: Num(30, 150), loadExertionK: Num(0, 5), slopeExertionK: Num(0, 20), sustainable: Num(0, 2),
    fatigueGainPerS: Num(0, 0.1), recoveryPerS: Num(0, 0.1), hrRestBpm: Num(30, 120), hrMaxBpm: Num(120, 230),
    hrRiseTauS: Num(1, 600), hrFallTauS: Num(1, 600), heatThresholdC: Num(-50, 60), heatPerC: Num(0, 1),
    postureChangeExertion: Num(0, 2), hrExertionWeight: Num(0, 1), hrFatigueWeight: Num(0, 1),
    /** An exhausted man on a hard pace works at this fraction of the sustainable rate (so he recovers). */
    exhaustedExertionFactor: Num(0, 1),
  }),
}).strict();
export type BodyT = z.infer<typeof BodyFile>;

// ---------- ballistics (core/ballistics.json) and weapons / ammunition (faction packs) ----------
export const BallisticsFile = withProv({
  gravityMps2: Num(1, 30), airDensityKgM3: Num(0.1, 2), referenceTempC: Num(-60, 60),
  /** Penetration capacity scales with (speed / reference speed) to this power. */
  penetrationVelocityExponent: Num(0.5, 3),
  /** Largest random change of direction after just barely penetrating, degrees. */
  penetrationDeflectionDeg: Num(0, 45),
  ricochetSpeedRetention: z.tuple([Num(0, 1), Num(0, 1)]), ricochetScatterDeg: Num(0, 45),
  /** Projectiles slower than this, or older than maxFlightSeconds, are removed as spent. */
  minSpeedMps: Num(1, 200), maxFlightSeconds: Num(1, 120),
  /** Blast (M2.4): effect radii = these x cube root of the filling in kg. */
  blast: z.object({
    severeScaledM: Num(0, 50), injuryScaledM: Num(0, 100), stunScaledM: Num(0, 300),
    stunSeconds: Num(0, 60), craterScaledM: Num(0, 20),
    /** A wall whose steel-equivalent thickness (mm) is below this x cube root of the filling is breached,
     *  if the burst is within breachReachScaledM x cube root of the filling of it. */
    breachSteelMmScaled: Num(0, 1000), breachReachScaledM: Num(0, 50), breachWidthScaledM: Num(0, 50),
    /** A wall thinner than this (steel-equivalent mm) does not shield a man from blast. */
    shieldSteelMm: Num(0, 1000),
  }).strict(),
  /** Armour (M7): published penetration and plate figures in mm of rolled homogeneous armour (RHA) are multiplied
   *  by this to give mild-steel-equivalent mm, the one scale the simulation uses. Equal to the `armour-steel`
   *  material's resistance (a test checks it). */
  rhaToMildSteel: Num(0.5, 3),
  /** Rounds against vehicle armour (M7.4a). losFloorCos: the path through a plate is at most 1 / this times its
   *  thickness; graze: an impact-fused warhead striking at a cosine below this may fail to go off (chance rising
   *  to 1 at 0); jetDecayMmPerM: a shaped-charge jet loses this much penetration per metre inside; a kinetic round
   *  inside keeps going to the far side. Spall: a fragment striking a component takes this off its condition. */
  armour: z.object({
    losFloorCos: Num(0.01, 1), grazeFuseCos: Num(0, 1), jetDecayMmPerM: Num(0, 5000), spallComponentDamage: Num(0, 1),
    /** Seated men inside (M7.4a): a box this wide and deep round each seat's position, from the floor to its head. */
    seatHalfM: Num(0.05, 2), seatHeightM: Num(0.1, 3),
  }).strict(),
  /** Fragments are simulated only inside this band of elevation (degrees): the rest go into the ground or sky. */
  fragments: z.object({ bandDeg: z.tuple([Num(-90, 0), Num(0, 90)]), maxPerBurst: z.number().int().min(1).max(20000),
    /** A burst higher than this above the ground also throws fragments downward. */
    airburstAboveM: Num(0, 10),
    /** Small folds and grass: a fragment flying lower than clutterHeightM above the ground is stopped with
     *  this chance per metre at ground level, falling to zero at that height. */
    clutterHeightM: Num(0, 2), clutterStopPerM: Num(0, 1) }).strict(),
  /** How a grenade that has not yet burst bounces: speed kept along the surface normal and along the surface;
   *  both are multiplied by softFactor on soft ground (material lighter than softBelowDensityKgM3) and by
   *  vegetationFactor in vegetation. Below stopSpeedMps it lies still. */
  bounce: z.object({
    restitution: Num(0, 1), tangentKeep: Num(0, 1), softFactor: Num(0, 1), vegetationFactor: Num(0, 1),
    softBelowDensityKgM3: Num(0, 20000), stopSpeedMps: Num(0.1, 20),
  }).strict(),
});
/** SPEC 6.3: shell and warhead types supported by the data model from the start. */
export const AmmoKind = z.enum([
  "ball", "armour-piercing", "tracer", "high-explosive", "fragmentation", "shaped-charge", "tandem-shaped-charge",
  "kinetic-penetrator", "airburst", "smoke", "illumination", "thermobaric", "fragment",
]);
export const FuseKind = z.enum(["none", "impact", "time", "proximity", "programmable"]);
/** SPEC 6.3: guidance types reserved in the data model. */
export const GuidanceKind = z.enum([
  "unguided", "command-wire", "command-beam", "fire-and-forget-direct", "fire-and-forget-top-attack", "laser", "operator-flown",
]);
export const AmmoSchema = withProv({
  id: Id, nameKey: z.string(), calibre: z.string(), kind: AmmoKind,
  projectileMassKg: z.number().positive().max(100), cartridgeMassKg: z.number().positive().max(200),
  diameterM: z.number().positive().max(0.5),
  /** Drag coefficient as a function of speed v (m/s): Cd = a + b / v, capped at max. Fitted to published
   *  downrange velocities (drag rises as a bullet slows toward the speed of sound). */
  drag: z.object({ a: Num(0, 2), b: Num(0, 1000), max: Num(0.05, 2) }).strict(),
  /** Distance at which a tracer burns out, m (display only). */
  tracerBurnoutM: Num(1, 5000).optional(),
  /** Mild-steel penetration at a reference impact speed; scaled by speed (ballistics.json). */
  penetration: z.object({
    steelMm: Num(0, 2000), atVelocityMps: z.number().positive().max(3000),
    /** Soft-core bullets break up on hard or granular materials: against materials with `breaksBullets`,
     *  penetration does not increase above this impact speed. Omit for hardened-core rounds. */
    breakupVelocityMps: z.number().positive().max(3000).optional(),
  }).strict(),
  tracer: z.boolean(), fuse: FuseKind, guidance: GuidanceKind,
  /** Explosive filling and fragments (M2.4). */
  explosive: z.object({
    fillingKg: Num(0, 100), fragmentCount: z.number().int().min(0).max(20000),
    /** The ammunition entry (kind "fragment") that describes one fragment: mass, size, drag, penetration. */
    fragmentAmmo: Id, fragmentVelocityMps: z.tuple([Num(0, 4000), Num(0, 4000)]),
    /** Time fuse: seconds from release to burst. Omit for an impact fuse. */
    fuseSeconds: Num(0.1, 60).optional(),
    /** An impact fuse is live only after this flight time (a round that strikes earlier is a dud). */
    armingSeconds: Num(0, 5).optional(),
    /** Impact HE that bursts on a man it strikes (M7.3, owner Q18: only the new cannon rounds; default false). */
    burstOnBody: z.boolean().optional(),
    /** Rockets (M7.4a): it bursts by itself this long after launch if it has struck nothing. */
    selfDestructSeconds: Num(0.1, 60).optional(),
  }).strict().optional(),
  /** Rockets (M7.4a): a motor that ignites `ignitionSeconds` after launch and speeds it up at `accelMps2` for
   *  `burnSeconds` along its flight path. */
  propulsion: z.object({ ignitionSeconds: Num(0, 10), burnSeconds: Num(0, 30), accelMps2: Num(0, 5000) }).strict().optional(),
  /** Wire-guided (SACLOS) missiles (owner 2026-11-13, a simple model; full guided weapons are M9): after launch
   *  it speeds up at `accelMps2` to `cruiseMps` and flies toward the gunner's line of sight to his aim point,
   *  turning at most `turnRateDegS`; the gunner's tracking error is `trackErrorMrad` (one standard deviation at
   *  skill 0.5, wandering with `trackTauS`). Fired only between `minRangeM` and `maxRangeM` (the wire's length);
   *  with guidance lost it flies on unguided, thrown off by `lostKickMrad`. */
  guided: z.object({
    cruiseMps: Num(10, 2000), accelMps2: Num(0, 5000), turnRateDegS: Num(1, 360), minRangeM: Num(0, 2000), maxRangeM: Num(10, 20000),
    trackErrorMrad: Num(0, 20), trackTauS: Num(0.05, 30), lookaheadS: Num(0, 5), lostKickMrad: Num(0, 500),
    /** M9.3a, guidance "fire-and-forget-top-attack": it climbs `climbM` above the target's aim point and dives on it
     *  within `diveAtM` (horizontal); `launchElevationDeg` above the sight line at launch. */
    topAttack: z.object({ climbM: Num(0, 1000), diveAtM: Num(10, 5000), launchElevationDeg: Num(0, 60) }).strict().optional(),
    /** M9.3a, fire-and-forget: the share of its seeker's view kept through ordinary smoke (multispectral: none). */
    seekerSmokeFactor: Num(0, 1).optional(),
  }).strict().optional(),
  /** Kinetic rounds against armour (M7.4a): ricochet below sin(material angle) x this (default 1). */
  ricochetFactor: Num(0, 2).optional(),
  /** What a round that gets through armour throws inside (M7.4a, owner Q11): fragments of the plate and the
   *  round in a cone behind the hole. */
  behindArmour: z.object({ spallCount: z.number().int().min(0).max(200), spallConeDeg: Num(0, 90), spallEnergyJ: Num(0, 100000) }).strict().optional(),
  /** Smoke rounds (M7.3): a multispectral cloud also blinds thermal sights (default false). */
  multispectral: z.boolean().optional(),
  /** Hand smoke grenades (D1, M10): `fuseSeconds` after release the grenade starts to smoke where it lies, a cloud
   *  of `radiusM` (growing over spotting.smokeBuildSeconds) for `seconds`. No explosive: it never wounds. */
  smoke: z.object({ fuseSeconds: Num(0.1, 30), radiusM: Num(1, 100), seconds: Num(1, 1200),
    /** M8.1 volume: the cloud's height (m); it burns `seconds` at its place (a plume in wind) and lingers over the
     *  spotting fade after. */
    topM: Num(0.5, 100).optional() }).strict().optional(),
  /** Illumination rounds (M8.4, `kind: "illumination"`): a flare of `candela` burns `burnSeconds` under a parachute
   *  from `heightM` above the ground, sinking at `descentMps`. Saved in the state; the light it gives comes in M9.1. */
  illum: z.object({ candela: Num(0, 1e8), burnSeconds: Num(1, 600), heightM: Num(1, 2000), descentMps: Num(0, 50) }).strict().optional(),
  /** How a soldier sends it on its way without a weapon of its own state: thrown by hand, or fired from a
   *  launcher item he carries (under-barrel or stand-alone grenade launcher). */
  delivery: z.object({
    method: z.enum(["thrown", "launched", "direct"]), velocityMps: Num(1, 400).optional(), launcher: Id.optional(),
    maxRangeM: Num(1, 2000).optional(),
    /** "direct" (M7.4a: shoulder-fired anti-tank rockets, aimed at what the firer sees): dispersion of launcher
     *  and round (one standard deviation, mrad), time to aim, danger zone behind the tube, and whether the tube
     *  is thrown away (the round item is the tube). */
    dispersionMrad: Num(0, 50).optional(), aimSeconds: Num(0, 60).optional(), backblastM: Num(0, 200).optional(), disposable: z.boolean().optional(),
  }).strict().optional(),
});
export const AmmunitionFile = z.object({ ammunition: z.array(AmmoSchema) }).strict();
export const WeaponSchema = withProv({
  id: Id, nameKey: z.string(),
  type: z.enum(["rifle", "carbine", "marksman-rifle", "light-machine-gun", "machine-gun", "pistol", "grenade-launcher", "launcher", "autocannon", "tank-gun"]),
  /** M7.6a: up to 5000 kg (a tank's main gun with its mount). */
  calibre: z.string(), massKg: Num(0.1, 5000),
  feed: z.object({ magazine: Id }).strict(),
  fireModes: z.array(z.enum(["semi", "burst", "auto"])).min(1),
  cyclicRpm: Num(1, 6000),
  /** Mechanical dispersion of weapon and ammunition (one standard deviation), milliradians. */
  dispersionMrad: Num(0, 50),
  reloadSeconds: Num(0.1, 600), setupSeconds: Num(0, 600),
  /** M9.3a: a vehicle launcher reloaded from outside by a crewman on the roof (exposed), halted. */
  reloadOutside: z.boolean().optional(),
  /** Chance of a stoppage per round fired. */
  jamProbability: Num(0, 0.1),
  sights: z.array(z.object({ kind: z.enum(["iron", "reflex", "magnified", "telescopic", "night", "thermal"]), magnification: Num(1, 60) }).strict()).min(1),
  /** Ammunition this weapon fires, with its muzzle velocity from this barrel, m/s. */
  ammo: z.record(Id, z.number().positive().max(3000)),
  /** Machine guns: always fires bursts of this many rounds, this many seconds apart, whatever the range. */
  sustained: z.object({
    burstRounds: z.number().int().min(2).max(50), intervalS: Num(0.1, 60),
    /** How much of a rifle's climb within a burst this weapon shows (bipod and mass hold it down). */
    recoilFactor: Num(0, 1),
  }).strict().optional(),
});
export const WeaponsFile = z.object({ weapons: z.array(WeaponSchema) }).strict();
export type BallisticsT = z.infer<typeof BallisticsFile>;
export type AmmoT = z.infer<typeof AmmoSchema>;
export type WeaponT = z.infer<typeof WeaponSchema>;

// ---------- shooting (core/shooting.json): aiming error and fire control ----------
const PostureFactors = z.object({ standing: Num(0.1, 20), crouching: Num(0.1, 20), prone: Num(0.1, 20) }).strict();
export const ShootingFile = z.object({
  aim: withProv({
    /** Aiming error (one standard deviation, mrad) of a soldier of skill 0.5: prone, rested, calm, aimed fire. */
    baseMrad: Num(0, 50), skillSlope: Num(0, 10), minSkillFactor: Num(0.05, 1),
    postureFactor: PostureFactors,
    fatigueK: Num(0, 10), heartRateK: Num(0, 10), heartRateCalmBpm: Num(40, 200), suppressionK: Num(0, 20),
    rapidFactor: Num(1, 10), burstGrowth: Num(0, 10),
    sightFactor: z.record(z.string(), Num(0.1, 3)),
    /** Error in judging the range (one standard deviation, as a fraction of the range) at skill 0.5. */
    rangeErrorFraction: Num(0, 1),
    /** Time spent aiming: right after he starts on a target his error is (1 + settleK) times larger; the excess
     *  fades with the time constant settleTauS. */
    settleK: Num(0, 10), settleTauS: Num(0.1, 60),
    /** Bracing: kneeling or standing next to a wall, tree or other cover he rests the weapon on it. */
    bracedFactor: Num(0.1, 1),
  }),
  fire: withProv({
    /** Rate of fire by range: the first band whose maxRangeM is not exceeded applies. */
    bands: z.array(z.object({
      maxRangeM: z.number().positive(), mode: z.enum(["aimed", "rapid", "burst"]),
      intervalS: Num(0.05, 600), burstRounds: z.number().int().min(1).max(50),
    }).strict()).min(1),
    fullRateSeconds: Num(0, 3600), trickleIntervalS: Num(0.1, 600), trickleSeconds: Num(0, 3600), incomingRadiusM: Num(1, 500),
    /** In a lull a man changes a magazine that is below this fraction of full, if he has a fuller one. */
    topUpBelowFraction: Num(0, 1),
    /** Enemy rounds fired past a unit within incomingRadiusM, out to this distance from the muzzle, count as incoming fire. */
    incomingReachM: Num(1, 5000),
    topUpAfterSeconds: Num(0.5, 600), clearStoppageSeconds: Num(0.1, 120), aimPointHeightM: Num(0, 3), safetyConeDeg: Num(0, 45),
    /** Soldier AI package A (2026-11-13): aim height above the ground at a man seen in each posture, m. */
    aimHeightByPostureM: z.object({ standing: Num(0, 3), crouching: Num(0, 3), prone: Num(0, 3) }).strict(),
  }),
  grenades: withProv({
    /** How far a soldier of skill 0.5 in full kit throws a hand grenade, by posture, m. */
    throwRangeM: z.object({ standing: Num(1, 100), crouching: Num(1, 100), prone: Num(1, 100) }).strict(), throwElevationDeg: Num(5, 80),
    /** Where it lands: one standard deviation = errorMinM + errorFraction x distance (skill 0.5). */
    throwErrorFraction: Num(0, 1), throwErrorMinM: Num(0, 10), throwSeconds: Num(0.1, 30), postErrorM: Num(0, 10),
    launchErrorFraction: Num(0, 1), launchErrorMinM: Num(0, 20), launchSeconds: Num(0.1, 60),
    /** A man does not throw or fire at a point nearer than this (his own fragments). */
    minSafeDistanceM: Num(0, 100),
    /** Throw angles he considers, in order of preference: the first whose path is clear of ceilings and walls
     *  (openings count as clear) is used. throwElevationDeg is the angle the ranges above are given for. */
    throwAnglesDeg: z.array(Num(1, 85)).min(1).max(8),
    /** He can throw this much harder than a full-range lob needs (flat throws need more speed). */
    throwPowerMargin: Num(1, 2),
    /** He aims short by this many seconds of the grenade's landing speed, because it bounces and rolls on. */
    carrySeconds: Num(0, 5),
    /** With several grenades in one order, each further man lets go this much later. */
    staggerSeconds: Num(0, 10),
    /** A grenade landing within reactRadiusM makes a man drop flat (after reactDelaySeconds); within
     *  runRadiusM he runs from it first (owner decision 2026-11-11). */
    reactRadiusM: Num(0, 100), runRadiusM: Num(0, 100), reactDelaySeconds: Num(0, 10),
  }),
}).strict();
export type ShootingT = z.infer<typeof ShootingFile>;

// ---------- spotting (core/spotting.json, M3.2)
export const SpottingFile = withProv({
  scanSeconds: Num(0.1, 10), baseRatePerS: Num(0, 10), referenceRangeM: Num(1, 5000), rangeExponent: Num(0, 4),
  minRangeM: Num(0.5, 500), maxRangeM: Num(10, 20000),
  postureSize: z.object({ standing: Num(0, 2), crouching: Num(0, 2), prone: Num(0, 2) }).strict(),
  stillBelowMps: Num(0, 5), movingFactor: Num(1, 50), runningAboveMps: Num(0, 20), runningFactor: Num(1, 50), movingVisibilityFloor: Num(0, 1),
  firingWithinSeconds: Num(0, 60), firingFactor: Num(1, 500), firingVisibilityFloor: Num(0, 1),
  /** M9.3b: a man who launched a guided missile from the ground shows this much more (on top of the firing factor:
   *  the launch's flash, dust and smoke) for this long. */
  launchFlashFactor: Num(1, 50).default(1), launchFlashSeconds: Num(0, 60).default(0),
  frontHalfAngleDeg: Num(0, 180), sideHalfAngleDeg: Num(0, 180), sideFactor: Num(0, 1), rearFactor: Num(0, 1),
  /** Sensors by kind (weapon sight kinds and item `sensor` kinds): detection factor beyond fromM, and the light
   *  level they give at least (0 = eyes need daylight; 1 = thermal sees as by day). "eye" is everyone's. */
  sensors: z.record(z.string(), z.object({
    factor: Num(0.1, 10), fromM: Num(0, 5000), nightLight: Num(0, 1),
    /** M9.2: it sees heat (target signature by `thermal` below; vegetation thins it less), and the half-angle it
     *  covers from where its holder looks (a man's sight or goggle; absent: everywhere he looks). */
    thermal: z.boolean().optional(), arcDeg: Num(1, 180).optional(),
    /** M7.3: share of the view kept through a standard (not multispectral) smoke cloud (0 = blinded; default 0). */
    smokeFactor: Num(0, 1).optional(),
    /** M7.3 vehicle sights: range limit (default: maxRangeM), fog floor (it sees at least this far in fog) and
     *  the factor rain puts on it. */
    maxRangeM: Num(10, 20000).optional(), fogFloorM: Num(0, 20000).optional(), rainFactor: Num(0, 1).optional(),
  }).strict()),
  /** Vehicles as targets and contacts (M7.3): visible area per 0.7 m^2 of a standing man (geometry gives the
   *  area), moving above this speed, how many vehicles a man keeps track of besides men, how fast a vehicle
   *  contact's uncertainty grows and when it is forgotten; engine noise is heard every engineEverySeconds within
   *  the vehicle's noise range x (surfaceBase + surface noise) x (1 - rainK x rain), x downwind / upwind. */
  vehicles: z.object({
    referenceAreaM2: Num(0.1, 10), targetMaxRangeM: Num(100, 20000), movingAboveMps: Num(0, 10), maxTracked: z.number().int().min(0).max(20),
    driftMps: Num(0, 50), forgetSeconds: Num(1, 3600), engineEverySeconds: Num(0.5, 60), surfaceBase: Num(0, 2),
    rainK: Num(0, 1), downwind: Num(0.5, 2), upwind: Num(0.1, 2),
  }).strict(),
  skillSlope: Num(0, 5), stressK: Num(0, 1), lightFloor: Num(0, 1),
  /** Night and light (M9.1). `sun`: ambient light 0..1 by local time, [hour, light] points (rising hours, 0 to 24),
   *  interpolated; `moonFullLight`: the light of a full moon (scaled by the moon's illumination). At night a man's
   *  muzzle flash lights him for observers as at least `flashLight`, a vehicle's gun flash lights it as at least
   *  `vehicleFlashLight`, and a man firing tracers (a belt with tracer rounds) shows
   *  `tracerContrast` times more in full darkness (scaled by the darkness). */
  /** Thermal signatures (M9.2), relative to what the eye sees: a man; a vehicle halted longer than `hotSeconds`
   *  (cooled), moving or moved within `hotSeconds` (hot), firing, burning; vegetation lets heat through as visibility^vegetationExponent. */
  /** Drone cameras (M9.4a): a man's size seen from above by posture (per 0.7 m^2 of a standing man seen from the
   *  side), the error a drone's report adds to a man's own sighting (m; reading the position off the picture). */
  drone: z.object({
    postureSize: z.object({ standing: Num(0, 2), crouching: Num(0, 2), prone: Num(0, 2) }).strict(), feedErrorM: Num(0, 500),
    /** The camera searches its whole footprint (a rate factor); a man under a canopy higher than canopyAboveM over him
     *  shows canopyDay of himself to a day camera, canopyThermal to a thermal one. */
    searchFactor: Num(0, 1), canopyAboveM: Num(0, 50), canopyDay: Num(0, 1), canopyThermal: Num(0, 1),
    /** M9.4b, a drone as a target: contrast against the sky, how far it is seen, how much harder men look for one
     *  they hear, how far they engage one, the share of its movement during a bullet's flight a shooter gets wrong,
     *  the highest chance one round hits it, the extra aim error firing up at it (mrad), the share of hits that down it. */
    targetContrast: Num(0, 20), seenMaxM: Num(0, 5000), heardLookFactor: Num(1, 20), engageM: Num(0, 2000), leadErrorShare: Num(0, 2), maxHitChance: Num(0, 1), aerialAimMrad: Num(0, 100), killShare: Num(0, 1),
  }).strict().optional(),
  thermal: z.object({
    man: Num(0, 10), vehicleCold: Num(0, 10), vehicleHot: Num(0, 10), vehicleFiring: Num(0, 20), vehicleBurning: Num(0, 50),
    hotSeconds: Num(0, 7200), vegetationExponent: Num(0.1, 1),
  }).strict(),
  night: z.object({
    sun: z.array(z.tuple([Num(0, 24), Num(0, 1)])).min(2),
    moonFullLight: Num(0, 1), flashLight: Num(0, 1), vehicleFlashLight: Num(0, 1), tracerContrast: Num(1, 50),
  }).strict(),
  minVisibility: Num(0, 1), /** Smoke (M6.5c): share of the view lost per metre of smoke, as an extinction rate. */ smokeExtinctionPerM: Num(0, 10), /** A smoke cloud grows to its full size over this time. */ smokeBuildSeconds: Num(0, 120),
  /** Smoke v2 (M8.1): a cloud thins to nothing over its last seconds; it moves with this share of the wind; a
   *  plume is cut this far behind its head. */
  smokeFadeSeconds: Num(0, 600).default(0), smokeDriftFactor: Num(0, 2).default(1), smokeStretchMaxM: Num(1, 2000).default(200), keepRateFactor: Num(1, 1000), forgetSeconds: Num(0, 600), maxTracked: z.number().int().min(1).max(100),
  contacts: z.object({
    seenErrorM: Num(0, 100), seenErrorPerM: Num(0, 1), hearingRangeM: Num(0, 20000), bearingErrorDeg: Num(0, 90), rangeErrorFraction: Num(0, 2),
    heardEverySeconds: Num(0, 60), forgetSeconds: Num(1, 3600), driftMps: Num(0, 20), reportEverySeconds: Num(0, 600), reportedErrorM: Num(0, 500),
    voiceDelaySeconds: Num(0, 60), callEverySeconds: Num(0, 600),
  }).strict(),
});
export type SpottingT = z.infer<typeof SpottingFile>;

// ---------- behaviour (core/behaviour.json, M4)
export const BehaviourFile = withProv({
  suppression: z.object({ nearMissRadiusM: Num(0, 50), perRound: Num(0, 1), energyRefJ: Num(1, 1e6), blastFactor: Num(0, 5), blastRadiusScale: Num(0, 10), decayPerS: Num(0, 10), max: Num(0, 1),
    /** M7.3: the energy factor of a near miss is capped at 2; heavy rounds (12.7 mm and up) at this. */
    heavyEnergyCap: Num(0.25, 20).optional() }).strict(),
  stress: z.object({ fromSuppressionPerS: Num(0, 10), casualtyNearbyM: Num(0, 1000), fromCasualty: Num(0, 1), fromLeaderLoss: Num(0, 1), fromWound: Num(0, 1), decayPerS: Num(0, 1), experienceDamp: Num(0, 1), leaderNearbyM: Num(0, 500), leaderNearbyDamp: Num(0, 1), quietBelowSuppression: Num(0, 1),
    /** Men aboard a closed vehicle (owner 2026-11-13, "only own vehicle"): stress when their own hull is penetrated,
     *  and when it is struck by a heavy round (12.7 mm and up) or a burst that does not get through. */
    fromOwnVehiclePenetrated: Num(0, 1).optional(), fromOwnVehicleStruck: Num(0, 1).optional() }).strict(),
  states: z.object({ pinnedSuppression: Num(0, 1), unpinnedBelow: Num(0, 1), cautiousStress: Num(0, 1), shakenStress: Num(0, 1), panickedStress: Num(0, 1), calmBelowStress: Num(0, 1) }).strict(),
  effects: z.object({ pinnedFireRateFactor: Num(0, 1), shakenFireRateFactor: Num(0, 1) }).strict(),
  stepSeconds: Num(0.05, 10),
  decisions: z.object({
    stepSeconds: Num(0.1, 10), defaultFireRule: z.enum(["free", "return", "hold"]),
    engageRangeM: z.object({ rifle: Num(0, 5000), magnified: Num(0, 5000), sustained: Num(0, 5000) }).strict(),
    underFireSuppression: Num(0, 1), underFireMemorySeconds: Num(0, 600), seenWithinSeconds: Num(0, 60), contactLostSeconds: Num(0, 600),
    seekCoverSuppression: Num(0, 1), coverSearchM: Num(0, 100), coverRetrySeconds: Num(0, 600), threatEyeHeightM: Num(0, 5),
    shareRangeM: Num(0, 500), keepSpare: Num(0, 20), passSeconds: Num(0, 60),
    ammoIntervalFactor: z.object({ conserve: Num(0.1, 10), normal: Num(0.1, 10), max: Num(0.1, 10) }).strict(),
  }).strict(),
  drills: z.object({
    stepSeconds: Num(0.05, 10), reactToContact: z.boolean(), boundM: Num(1, 500), finalM: Num(0, 500), phaseTimeoutSeconds: Num(1, 600), spreadM: Num(0, 50),
    breakPanickedFraction: Num(0, 1), rallyDistanceM: Num(0, 2000), rallyQuietSeconds: Num(0, 600), rallyStressFactor: Num(0, 1), fallBackM: Num(0, 2000),
    reactNeighbourM: Num(0, 1000), boundDoneShare: Num(0, 1), stragglerS: Num(0, 600), withdrawTogetherMen: Num(0, 50),
    suppressShortM: Num(0, 100), coverTargetM: Num(0, 500), laneClearM: Num(0, 50), laneShiftMaxM: Num(0, 100), coverFiredS: Num(0, 60), coverWaitS: Num(0, 600), coverRetaskS: Num(0, 60), sidestep: z.boolean(), sidestepM: z.array(Num(-20, 20)).max(12), coverCandidates: z.number().int().min(1).max(50), suppressIntervalS: Num(0, 60),
    clearEntryMen: z.number().int().min(1).max(20), clearStackOffM: Num(0, 10), clearStackAsideM: Num(0, 10), clearAfterBurstS: Num(0, 30), clearStackWaitS: Num(0, 600), clearThrowWaitS: Num(0, 600), clearRoomS: Num(1, 600), clearTimeoutS: Num(1, 3600), clearMinMen: z.number().int().min(1).max(20),
    clearOfM: Num(0, 50), clearShieldM: Num(0, 50), clearThrowMinM: Num(0, 50), clearAimInM: Num(0, 10), clearStackRankM: Num(0.3, 10), clearThrowAsideM: Num(0, 10), clearEntrySeenW: Num(0, 1000), clearEntrySeenM: Num(0, 500), clearKnownS: Num(0, 600), clearMoveAwayM: Num(0, 100), clearStackNearM: Num(0, 100),
  }).strict(),
  /** Surrender (M6.6, owner 2026-11-12): the same for every side. 0 switches a rule off. */
  surrender: z.object({
    stepSeconds: Num(0.1, 10), downedEnemyM: Num(0, 500), comradeNearM: Num(0, 500), caughtEnemyM: Num(0, 500), attackerDownedEnemyM: Num(0, 500), attackerPanicGivesUp: z.boolean(), captureM: Num(0, 50),
    fetchWithinM: Num(0, 500), fetchQuietSeconds: Num(0, 600), fetchTimeoutSeconds: Num(1, 3600),
    walkToEnemyM: Num(0, 500), walkSeenFactor: Num(0.05, 1), handOverM: Num(0, 50), walkSpeedFactor: Num(0.1, 1), walkReplanM: Num(0.5, 100), walkTimeoutSeconds: Num(1, 3600),
    /** Owner request 2026-11-15: a surrendered man under fire crawls to cover this close (0 = off), by a way at most crawlMaxM. */
    crawlSearchM: Num(0, 100).optional(), crawlMaxM: Num(0, 200).optional(),
  }).strict(),
  /** Getting in and out of vehicles (M7.2): the same for every side. */
  mounting: z.object({
    boardReachM: Num(0.5, 20), approachReplanM: Num(0.5, 50), casualtyLoadM: Num(0, 50), carriersWithinM: Num(0, 500),
    completeAfterSeconds: Num(1, 3600), giveUpSeconds: Num(1, 7200), exitFanMinM: Num(0, 50), exitFanMaxM: Num(0, 50),
    remountM: Num(0, 2000), holdDismountM: Num(0, 2000), resupplyRangeM: Num(0, 500), resupplyReachM: Num(0, 50),
    resupplyCount: z.number().int().min(0).max(50), seatSwapCheckSeconds: Num(0.1, 60),
  }).strict(),
  /** Vehicle gunnery (M7.3): the same for every side. See BehaviourDef.gunnery. */
  gunnery: z.object({
    stepSeconds: Num(0.1, 10), seenWithinSeconds: Num(0, 60), reportedErrorM: Num(0, 200), reportedWithinSeconds: Num(0, 120),
    groupRadiusM: Num(0, 100), coaxSingleWithinM: Num(0, 3000), vehicleScore: Num(0.01, 10), firingScore: Num(0.01, 10),
    lrfRangeErrorFraction: Num(0, 1), refillBelowFraction: Num(0, 1),
    friendlyClearM: Num(0, 500), scanReturnSeconds: Num(0, 600), dischargeAheadM: Num(0, 200),
    /** Guided missiles from a station (owner 2026-11-13): a crew prefers the missile against an enemy vehicle beyond
     *  `missileBeyondM`, or nearer when its armour-piercing round cannot get through the face it shows; it fires
     *  halted only (below `missileHaltedMps`); the gunner checks his sight line every `missileSightSeconds` and
     *  loses the missile when it is blocked or seen through less than `missileSeenFloor`, and with a chance of
     *  `missileHitLoseChance` when his own hull is struck by an enemy round or burst (12.7 mm and up). */
    missileBeyondM: Num(0, 10000).optional(), missileHaltedMps: Num(0, 10).optional(), missileSightSeconds: Num(0.02, 5).optional(),
    missileSeenFloor: Num(0, 1).optional(), missileHitLoseChance: Num(0, 1).optional(),
  }).strict(),
  /** Shoulder-fired anti-tank weapons (M7.4a). See BehaviourDef.antitank. */
  antitank: z.object({
    atRuleDefault: z.enum(["vehicles", "vehiclesAndPositions", "hold"]), stepSeconds: Num(0.1, 10), seenWithinSeconds: Num(0, 60),
    rangeErrorFraction: Num(0, 1), skillMrad: Num(0, 50), largeRoomM2: Num(0, 10000), wallBehindM: Num(0, 20), handOverM: Num(0, 200),
  }).strict(),
  /** Individual soldier AI (owner 2026-11-13, packages A-D). See BehaviourDef.soldier. */
  soldier: withProv({
    reserveCloseM: Num(0, 1000), reserveAssaultM: Num(0, 2000), longRangeM: Num(0, 5000), longRangeIntervalFactor: Num(0.1, 20), keepTargetFactor: Num(0, 1), keepTargetSeenSeconds: Num(0, 60),
    crawlMode: z.string(), crawlSearchM: Num(0, 50), crawlSearchFarM: Num(0, 50), crawlRetrySeconds: Num(0, 600), minSpacingM: Num(0, 50),
    beatenNoticeM: Num(0, 500), beatenRadiusM: Num(0, 500), beatenMemorySeconds: Num(0, 3600), beatenMoveM: Num(0, 500), beatenHouseM: Num(0, 500), beatenOpenExposure: Num(0, 1),
    riseBelowSuppression: Num(0, 1), lookEverySeconds: Num(0.5, 60), faceEnemy: z.boolean(), rearWatchMinMen: z.number().int().min(0).max(50),
    atMoveM: Num(0, 200), atMoveMinRangeM: Num(0, 1000), atMoveRetrySeconds: Num(0, 600), atContactSeconds: Num(0, 600),
    grenadeEverySeconds: Num(0, 600), grenadeClearM: Num(0, 100), grenadeContactSeconds: Num(0, 120), assaultFireM: Num(0, 500), assaultFireAimFactor: Num(1, 20),
    friendBeyondM: Num(0, 500), overlapM: Num(0, 10), stepAsideM: z.array(Num(0.5, 20)).min(1).max(4), overlapCheckSeconds: Num(0.1, 60), duckAboveIntervalS: Num(0, 60), duckHoldS: Num(0, 10),
    hurryModes: z.array(z.string()), hurryMode: z.string(), hurryFiredOnSeconds: Num(0, 60), hurryQuietSeconds: Num(0, 120),
    houseLeave: z.boolean(), houseTrapBursts: Num(0, 50), houseTrapSeconds: Num(0, 600), houseHeavyKg: Num(0, 100), houseHeavyCount: Num(0, 10), houseBurstNearM: Num(0, 20),
    houseEnemySeconds: Num(0, 120), houseFightM: Num(0, 50), houseFlankM: Num(0, 2000), houseFlankDeg: Num(0, 180), houseFlankSeconds: Num(0, 120),
    houseLeaveM: z.tuple([Num(0, 500), Num(0, 500)]), houseLeaveDeg: Num(0, 180), houseLeaveMode: z.string(), houseReenterSeconds: Num(0, 3600), houseContactErrM: Num(0, 1000),
    houseLeaveCoverM: Num(0, 50), houseLeaveTries: z.number().int().min(1).max(50), houseLeaveCost: z.tuple([Num(1, 50), Num(0, 1000)]), houseFrontMin: Num(0, 1), houseLeaveRetryS: Num(0, 600),
  }),
  /** Crews of damaged vehicles (M7.4a, owner Q14/Q15). See BehaviourDef.crew. */
  crew: z.object({
    bailOnFireSeconds: Num(0, 120), burnSeconds: Num(1, 3600), cookOffCheckSeconds: Num(0.1, 120), cookOffChancePerCheck: Num(0, 1),
    fireSmokeRadiusM: Num(0, 100), /** M8.1: the burning vehicle's smoke column's height (m). */ fireSmokeTopM: Num(0, 500).default(30), occupantBurnSeverity: z.tuple([Num(0, 1), Num(0, 1)]),
    /** Crew reactions (M7.4b): how often a crew thinks; a hit this recent counts; a crew reversing out goes this
     *  far back and keeps to it this long; enemy men this close (fire rule not "free") make it back off. */
    reactionStepSeconds: Num(0.1, 30), recentHitSeconds: Num(0.1, 60), reverseOutM: Num(5, 500), reverseHoldSeconds: Num(1, 600), atThreatM: Num(0, 2000),
    /** M9.3a: a crew that notices a missile launched at it fires its smoke toward the launcher this long after. */
    launchReactionSeconds: Num(0, 30),
  }).strict(),
  /** Hand smoke screens (D1, M10): the same for every side. See BehaviourDef.smoke. */
  smoke: z.object({
    screenM: Num(1, 100), enemyMinM: Num(0, 2000), enemyMaxM: Num(0, 5000), knownWithinS: Num(0, 600), cooldownS: Num(0, 3600),
    onWithdraw: z.boolean(), onMoveUnderFire: z.boolean(), underFireS: Num(0, 600),
  }).strict(),
});
export type BehaviourT = z.infer<typeof BehaviourFile>;

// ---------- wounds (core/wounds.json): body outline, wound effects, simple physiology ----------
const BodyZoneGroup = z.enum(["head", "neck", "chest", "abdomen", "pelvis", "arm", "leg"]);
const Hitbox = z.object({
  widthM: Num(0.1, 3), depthM: Num(0.1, 3), heightM: Num(0.1, 3),
  /** Zones are stacked by height (upright) or along the body from the head (prone). */
  along: z.enum(["height", "length"]),
  bands: z.array(z.object({
    zone: BodyZoneGroup, from: Num(0, 1), to: Num(0, 1), halfWidthM: Num(0.01, 1),
    /** If given, hits between halfWidthM and this distance from the centre line strike an arm. */
    armsToM: Num(0.01, 1).optional(),
  }).strict()).min(1),
}).strict();
const ZoneWound = z.object({
  severityBase: Num(0, 1), severitySpread: Num(0, 1),
  /** Severity at or above which the wound kills at once / knocks out (2 = never). */
  fatalAt: Num(0, 2), unconsciousAt: Num(0, 2),
  /** Bleeding of the worst case, litres per second. */
  bleedLps: Num(0, 0.2), compressible: z.boolean(), airway: z.boolean(), breathing: z.boolean(),
}).strict();
export const WoundsFile = z.object({
  hitboxes: withProv({ standing: Hitbox, crouching: Hitbox, prone: Hitbox }),
  zones: withProv({ head: ZoneWound, neck: ZoneWound, chest: ZoneWound, abdomen: ZoneWound, pelvis: ZoneWound, arm: ZoneWound, leg: ZoneWound }),
  wounding: withProv({
    referenceEnergyJ: Num(1, 100000), energyFactorMin: Num(0, 2), energyFactorMax: Num(0, 5),
    bleedFloor: Num(0, 1), bleedPower: Num(0.5, 10), bluntSeverity: Num(0, 1), knockdownSeconds: Num(0, 120), flagSeverity: Num(0, 1), energyExponent: Num(0, 2), throughArmChance: Num(0, 1), throughArmEnergy: Num(0, 1),
    fragment: z.object({ minEnergyJ: Num(0, 1000), referenceEnergyJ: Num(1, 100000), exponent: Num(0, 2), factorMin: Num(0, 2), factorMax: Num(0, 5) }).strict(),
    blast: z.object({ severityInjury: Num(0, 1), severitySevere: Num(0, 1), bleedLps: Num(0, 0.2) }).strict(),
    /** Run over by a vehicle (M7.1c). */
    crush: z.object({ severityMin: Num(0, 1), severityMax: Num(0, 1), bleedLps: Num(0, 0.2) }).strict().optional(),
    /** Heavy projectiles (M7.3): a round of at least this diameter that strikes a man wounds at least this badly. */
    heavy: z.object({ minDiameterM: Num(0.001, 0.5), severityMin: Num(0, 1) }).strict().optional(),
    /** A bullet that is not stopped by armour leaves the body with this share of its speed (limb / trunk or head). */
    exit: z.object({ limb: Num(0, 1), trunk: Num(0, 1) }).strict(),
  }),
  physiology: withProv({
    bloodVolumeL: Num(1, 10), unconsciousLossFraction: Num(0.05, 1), deathLossFraction: Num(0.05, 1), shockStartFraction: Num(0, 1),
    clotBelowLps: Num(0, 0.1), clotTauS: Num(1, 100000), breathingShockPerS: Num(0, 1), airwayShockPerS: Num(0, 1),
    painDecayPerS: Num(0, 1), stepSeconds: Num(0.05, 10), painCollapseAt: Num(0, 2),
  }),
  effects: withProv({
    legNoWalkSeverity: Num(0, 2), armNoFightSeverity: Num(0, 2), painNoFightAt: Num(0, 2), painPerWoundK: Num(0, 2),
    moveSeverityK: Num(0, 10), aimSeverityK: Num(0, 20), aimPainK: Num(0, 20), minMoveFactor: Num(0.01, 1),
  }),
}).strict();
export type WoundsT = z.infer<typeof WoundsFile>;

// ---------- medical (core/medical.json, M10.1): physiology of the medical model, treatments, carrying ----------
export const CARE_SKILLS = ["self", "buddy", "firstResponder", "medic"] as const;
export const MEDICAL_LEVELS = ["firstResponder", "medic", "stretcherBearer", "ambulanceCrew"] as const;
const CareSkill = z.enum(CARE_SKILLS);
const BySkill = (lo: number, hi: number) => z.object({
  self: Num(lo, hi).optional(), buddy: Num(lo, hi).optional(), firstResponder: Num(lo, hi).optional(), medic: Num(lo, hi).optional(),
}).strict();
/** The conditions a treatment can address (keys the medical system knows; M10.2). */
export const TREATS = [
  "limb-bleed", "compressible-bleed", "junctional-bleed", "airway", "open-chest", "tension", "access", "volume", "pain",
  "cold", "fracture", "tourniquet",
] as const;
export const InterventionSchema = withProv({
  id: Id, nameKey: z.string(), treats: z.enum(TREATS),
  /** Allowed under effective fire (TCCC care under fire). */
  underFire: z.boolean(),
  timeS: BySkill(1, 7200), success: BySkill(0, 1),
  stressFactor: Num(0, 1), selfFactor: Num(0, 1), underFireTimeFactor: Num(1, 5),
  consumes: z.array(z.object({ tag: Id, count: z.number().int().min(1).max(10) }).strict()),
  effect: z.object({
    bleedFactor: Num(0, 1).optional(), painAdd: Num(0, 1).optional(), painRelief: Num(0, 1).optional(), tourniquet: z.boolean().optional(),
    airwayFactor: Num(0, 1).optional(), breathingFactor: Num(0, 1).optional(), decompress: z.boolean().optional(), access: z.boolean().optional(),
    fluidL: Num(0, 5).optional(), warms: z.boolean().optional(), splints: z.boolean().optional(),
  }).strict(),
});
export const CarrySchema = withProv({
  id: Id, nameKey: z.string(), carriers: z.number().int().min(0).max(8), speedMps: Num(0.1, 3), enduranceM: Num(1, 5000),
  restS: Num(0, 3600), setupS: Num(0, 600), upright: z.boolean(),
  /** The casualty walks himself (M10.4a: walking wounded, supported). */
  casualtyWalks: z.boolean().optional(),
  /** An item one of the carriers must have (its `medical.tags`), e.g. a litter (M10.4a). */
  needsTag: Id.optional(),
});
export const MedicalFile = z.object({
  /** Rates of the "medical" physiology model (flat numbers, merged into the physiology parameters). */
  physiology: withProv({
    tensionChance: Num(0, 1), tensionOnsetMinS: Num(0, 36000), tensionOnsetMaxS: Num(0, 36000), tensionDeathS: Num(10, 36000),
    headChance: Num(0, 1), headMinSeverity: Num(0, 1), headOnsetMinS: Num(0, 36000), headOnsetMaxS: Num(0, 36000),
    fractureChance: Num(0, 1), fractureMinSeverity: Num(0, 1),
    burnFluidLps: Num(0, 0.01), fluidLps: Num(0, 0.1), fluidVolumeFactor: Num(0, 1),
    hypoC: Num(25, 37), hypoClotFactor: Num(1, 10), hypoDeathLossPerC: Num(0, 0.2), coldOutC: Num(15, 37), coldDeathC: Num(10, 37),
    coolPerS: Num(0, 0.1), rainCoolK: Num(0, 10), windCoolK: Num(0, 10), shelteredCoolFactor: Num(0, 1), warmedCoolFactor: Num(0, 1),
    ischaemiaSafeS: Num(0, 360000), ischaemiaMidS: Num(0, 360000), ischaemiaMidChance: Num(0, 1), ischaemiaLateS: Num(0, 360000), ischaemiaLateChance: Num(0, 1),
  }),
  /** What each medical job treats with. */
  levels: withProv({
    firstResponder: z.object({ skill: CareSkill }).strict(), medic: z.object({ skill: CareSkill }).strict(),
    stretcherBearer: z.object({ skill: CareSkill }).strict(), ambulanceCrew: z.object({ skill: CareSkill }).strict(),
  }),
  interventions: z.array(InterventionSchema).min(1),
  carry: z.array(CarrySchema).min(1),
  /** Carrying parties (M10.4a): gathering, cover under fire, self-defence, the mass the carry speeds are for. */
  carrying: withProv({ reachM: Num(0.5, 10), holdSuppression: Num(0, 1), resumeQuietS: Num(0, 600), selfDefenceM: Num(0, 300), massRefKg: Num(10, 500) }).optional(),
  /** Casualties into and out of vehicles (M10.4b): how far a mounting unit fetches its wounded, places a lying man takes. */
  vehicleLoading: withProv({ fetchM: Num(0, 1000), lyingSeats: z.number().int().min(1).max(6), lyingShock: Num(0, 1) }).optional(),
  /** The Verwundetennest (M10.5): siting, moving, bearers, the platoon medic. */
  nest: withProv({
    backM: Num(0, 2000), minBackM: Num(0, 2000), maxBackM: Num(0, 2000), searchM: Num(0, 500), arriveM: Num(1, 50), threatM: Num(0, 2000),
    checkS: Num(1, 600), driftM: Num(0, 5000), maxParties: z.number().int().min(0).max(20), bearers: z.number().int().min(1).max(4),
    minFitLeft: z.number().int().min(0).max(20), medicReachM: Num(0, 5000),
  }).optional(),
  /** Ambulance runs from the rear (M10.6a): delay, pace, where it stands, loading, how long it waits. */
  evacuation: withProv({
    delayMinS: Num(0, 36000), delayMaxS: Num(0, 36000), pace: Id, nearPace: Id, standM: Num(0, 100), carryMps: Num(0.1, 5), loadSecondsExtra: Num(0, 600),
    waitS: Num(0, 3600), maxStayS: Num(0, 36000), edgeM: Num(1, 200), retryS: Num(1, 600), requestAt: z.number().int().min(1).max(20),
  }).optional(),
  /** Combat vehicles' rear run (M10.6b): when an idle hull takes the nest's casualties off the map, and back. */
  rearRun: withProv({
    idleS: Num(0, 3600), quietS: Num(0, 3600), enemyM: Num(0, 5000), startT1: z.number().int().min(1).max(20), startAny: z.number().int().min(1).max(20),
    ambulanceWithinS: Num(0, 36000), maxNestM: Num(0, 10000), maxPerPlatoon: z.number().int().min(1).max(10), keepVehicles: z.number().int().min(0).max(10),
    waitS: Num(0, 3600), maxStayS: Num(0, 36000), awayS: Num(0, 36000), pace: Id, backM: Num(1, 200),
  }).optional(),
  /** Role 1 outcome at hand-over and the end-of-battle settlement (M10.6b): delays, died of wounds, recovery days. */
  role1: withProv({
    transferS: Num(0, 360000), settleDelayS: Num(0, 360000), captiveTransferS: Num(0, 360000), holdM: Num(1, 5000),
    dow: z.object({
      base: Num(0, 1), shockK: Num(0, 5), bloodK: Num(0, 5), respK: Num(0, 5), unconsciousK: Num(0, 5), severityK: Num(0, 5), max: Num(0, 1),
      lateKPerH: Num(0, 10), captorFactor: Num(0, 10), delayMinH: Num(0, 10000), delayMaxH: Num(0, 10000),
    }).strict(),
    recovery: z.object({
      bands: z.array(z.object({ upTo: Num(0, 1), minD: Num(0, 10000), maxD: Num(0, 10000) }).strict()).min(1),
      fractureMinD: Num(0, 10000), fractureMaxD: Num(0, 10000), untreatedFactor: Num(0, 10), lateFactor: Num(0, 10), amputationD: Num(0, 10000),
    }).strict(),
  }).optional(),
  chain: withProv({ firstAidS: Num(0, 36000), role1S: Num(0, 360000), surgeryS: Num(0, 360000) }),
  protection: withProv({
    recognitionM: z.object({ vehicleEye: Num(0, 5000), vehicleOptics: Num(0, 5000), armbandEye: Num(0, 1000), armbandOptics: Num(0, 2000) }).strict(),
    obscuredFactor: Num(0, 1), breachBase: Num(0, 1), breachLossesK: Num(1, 20), breachLowDisciplineK: Num(1, 20), breachPanicK: Num(1, 20),
    medicFiredLosesProtectionS: Num(0, 3600),
  }),
  /** Triage (M10.3b): error chances by training, what makes a casualty T1, when he is tagged again. */
  triage: withProv({
    errorChance: BySkill(0, 1), underFireAdd: Num(0, 1), immediateTreats: z.array(z.string()), immediateShock: Num(0, 1),
    immediateConsciousness: Num(0, 1), retriageS: Num(0, 36000),
  }),
  /** How care is given (M10.2): cadence, buddy reach, attempts, thresholds, the MARCH order of interventions. */
  care: withProv({
    stepS: Num(0.1, 60), buddyReachM: Num(0.5, 20), maxAttempts: z.number().int().min(1).max(10), painTreatAt: Num(0, 1),
    skillRef: Num(0, 1), skillK: Num(0, 2), underFireSuppression: Num(0, 1), underFireSeconds: Num(0, 600),
    junctionalZones: z.array(z.enum(["head", "neck", "chest", "abdomen", "pelvis", "armL", "armR", "legL", "legR"])),
    order: z.array(Id).min(1),
    dragSearchM: Num(0, 100), dragMaxM: Num(0, 200), radioCooldownS: Num(0, 600),
  }),
  /** Who goes to a casualty further away (M10.3a): reach, what looks urgent, willingness, the cap, the timeout. */
  carers: withProv({
    comradeReachM: Num(0, 1000), responderReachM: Num(0, 2000), urgentTreats: z.array(z.string()),
    willingAt: Num(0, 10), behaviourK: z.record(z.string(), Num(0, 2)), suppressionK: Num(0, 5), otherUnitK: Num(0, 1),
    exposedK: Num(0, 1), responderK: Num(0, 10), comradesPerCasualty: z.number().int().min(0).max(4), timeoutS: Num(1, 3600),
  }).optional(),
  /** Men down, dead or alive (owner request 2026-11-15): the check, the identity tag, a casualty crawling to cover. */
  down: withProv({
    checkS: Num(0.5, 120), tagS: Num(0.5, 120), tagSuppression: Num(0, 1), tagQuietS: Num(0, 600),
    crawlSearchM: Num(0, 100), crawlMaxM: Num(0, 200), crawlLookS: Num(0.5, 60), crawlCarerNearM: Num(0, 200),
  }).optional(),
}).strict();
export type MedicalT = z.infer<typeof MedicalFile>;

// ---------- formations (core/formations.json) ----------
export const FormationSchema = withProv({
  id: Id, nameKey: z.string(),
  /** Slot offsets [right, back] in units of the doctrine spacing; slot 0 is the leader. */
  slots: z.array(z.tuple([z.number().min(-20).max(20), z.number().min(-20).max(20)])).min(2).max(40),
});
export const FormationsFile = z.object({ formations: z.array(FormationSchema).min(1) }).strict();
export type FormationT = z.infer<typeof FormationSchema>;

// ---------- terrain (core/terrain/*.json) ----------
const Colour = z.string().regex(/^#[0-9a-f]{6}$/i, "colour must be #rrggbb");
/** Time multiplier per movement class; null = impassable. */
const MoveCost = z.object({ foot: z.number().min(0.5).max(10).nullable(), wheeled: z.number().min(0.5).max(10).nullable(), tracked: z.number().min(0.5).max(10).nullable() }).strict();
const Range = z.tuple([z.number().positive(), z.number().positive()]).refine((r) => r[0] <= r[1], "range must be [min, max]");
const IntRange = z.tuple([z.number().int().min(1), z.number().int().min(1)]).refine((r) => r[0] <= r[1], "range must be [min, max]");

export const MaterialSchema = withProv({
  id: Id, nameKey: z.string(),
  densityKgM3: z.number().positive().max(20000),
  /** Penetration resistance in mm of mild steel equivalent per mm of material. */
  resistance: z.number().min(0).max(3),
  /** Resistance against shaped-charge jets, if it differs from `resistance` (composites, M7). */
  resistanceShaped: z.number().min(0).max(5).optional(),
  /** Largest angle from the surface at which a bullet can still ricochet, degrees (0 = never). */
  ricochetAngleDeg: z.number().min(0).max(45),
  /** Masonry, concrete, soil, wood: soft-core bullets break up in it at high impact speed. */
  breaksBullets: z.boolean(),
});
export const SurfaceSchema = withProv({
  id: Id, nameKey: z.string(), moveCost: MoveCost,
  /** What the ground is made of, for bullet impacts and ricochets (materials.json). */
  material: Id,
  noise: z.number().min(0).max(1), dust: z.number().min(0).max(1), colour: Colour,
  /** How vehicles drive on it (M7): rolling resistance coefficient, traction and lateral friction coefficients,
   *  an optional speed cap, and what rain does to traction and rolling resistance (factors at full wetness).
   *  Absent: vehicles cannot drive on it. */
  vehicle: z.object({
    rolling: Num(0.001, 1), traction: Num(0.05, 1.5), lateral: Num(0.05, 1.5), capKmh: Num(1, 200).optional(),
    wetTractionFactor: Num(0.1, 1), wetRollingFactor: Num(1, 3),
  }).strict().optional(),
});
export const VegetationSchema = withProv({
  id: Id, nameKey: z.string(), heightM: z.number().positive().max(60),
  /** Fraction of a line of sight blocked per metre travelled through it. */
  concealmentPerM: z.number().min(0).max(1),
  /** Fraction of a bullet's energy lost per metre (M2). */
  stoppingPerM: z.number().min(0).max(0.1),
  moveCost: MoveCost, colour: Colour,
});
const VehicleCrossing = z.object({ crossCostCells: Num(0, 50), capKmh: Num(1, 100), flattens: z.boolean() }).strict();
export const ObstacleKindSchema = withProv({
  id: Id, nameKey: z.string(), heightM: z.number().positive().max(20), thicknessM: z.number().positive().max(30),
  material: Id, seeThrough: z.number().min(0).max(1),
  footCrossTimeS: z.number().positive().max(600).nullable(),
  /** Vehicles (M7), per class: null = it cannot cross (goes round); otherwise the extra route cost in cells, the
   *  speed while crossing, and whether the hull flattens it (leaving a gap as wide as the hull's path). */
  vehicle: z.object({ tracked: VehicleCrossing.nullable(), wheeled: VehicleCrossing.nullable() }).strict(),
  colour: Colour,
});
export const BuildingKindSchema = withProv({
  id: Id, nameKey: z.string(), widthM: Range, depthM: Range, storeys: IntRange, storeyHeightM: z.number().positive().max(20),
  wallMaterial: Id, wallThicknessM: z.number().positive().max(3), roofColours: z.array(Colour).min(1),
  /** What the roof is made of and how thick (stops bullets, fragments and grenades from above). */
  roofMaterial: Id, roofThicknessM: z.number().positive().max(2),
});
export const MaterialsFile = z.object({ materials: z.array(MaterialSchema).min(1) }).strict();
export const SurfacesFile = z.object({ surfaces: z.array(SurfaceSchema).min(1) }).strict();
export const VegetationFile = z.object({ vegetation: z.array(VegetationSchema).min(1) }).strict();
export const ObstaclesFile = z.object({ obstacles: z.array(ObstacleKindSchema).min(1) }).strict();
export const BuildingsFile = z.object({ buildings: z.array(BuildingKindSchema).min(1) }).strict();
export type MaterialT = z.infer<typeof MaterialSchema>;
export type SurfaceT = z.infer<typeof SurfaceSchema>;
export type VegetationT = z.infer<typeof VegetationSchema>;
export type ObstacleKindT = z.infer<typeof ObstacleKindSchema>;
export type BuildingKindT = z.infer<typeof BuildingKindSchema>;

// ---------- faction ----------
export const FactionManifest = withProv({
  id: Id,
  kind: z.literal("faction"),
  nameKey: z.string(),
  /** Pack format version; the loader rejects packs it does not understand. */
  formatVersion: z.literal(1),
  /** Default unit quality for generated forces. */
  defaultQuality: Id,
  /** Unit template the demo scenario and the app start with (default "demo-team"). */
  demoTemplate: Id.optional(),
  /** Platoon used by generated battles (M6). */
  platoonTemplate: Id.optional(),
  /** On-map mortar section generated battles add with `mortars` (M8.3a). */
  mortarTemplate: Id.optional(),
  /** Dismounted missile team generated battles add with `missileTeams` (M9.3b). */
  missileTeamTemplate: Id.optional(),
  /** Ambulances off the map (M10.6a): generated battles give each side `count` of this crew template's vehicle
   *  (a template with `vehicle`, an ambulance), waiting at the rear to be called. */
  ambulance: z.object({ template: Id, count: z.number().int().min(0).max(10) }).strict().optional(),
  /** True for test fixtures; fixtures may omit real-world sources. */
  fixture: z.boolean().optional(),
});

export const RankSchema = withProv({
  id: Id,
  nameKey: z.string(),
  abbrKey: z.string(),
  /** NATO STANAG 2116 code, e.g. "OR-4", "OF-1". */
  natoCode: z.string().regex(/^(OR-[1-9]|OF-(D|[1-9]|10)|WO-[1-5])$/),
  /** Ordering for seniority and succession, higher = more senior. */
  grade: z.number().int().min(1).max(30),
}).strict();
export const RanksFile = z.object({ ranks: z.array(RankSchema).min(1) }).strict();

export const RoleSchema = withProv({
  id: Id, nameKey: z.string(), leader: z.boolean().optional(),
  /** Medical job (M10.1): the level, and the interventions (core/medical.json ids) this role is trained for when
   *  national training is narrower than the level (owner Q-1b); absent: everything the level's skill can do. */
  medical: z.object({ level: z.enum(MEDICAL_LEVELS), interventions: z.array(Id).optional() }).strict().optional(),
});
export const RolesFile = z.object({ roles: z.array(RoleSchema).min(1) }).strict();

export const NamesFile = withProv({
  given: z.array(z.string().min(1)).min(10),
  givenFemale: z.array(z.string().min(1)),
  family: z.array(z.string().min(1)).min(10),
  /** Share of female soldiers in generated forces, 0..1. */
  femaleShare: z.number().min(0).max(1),
  /** Suffix appended to the family name for women (e.g. "a" for Ivanov -> Ivanova). Empty if none. */
  familyFemaleSuffix: z.string(),
});

export const ItemSchema = withProv({
  id: Id,
  nameKey: z.string(),
  category: z.string(),
  massKg: z.number().min(0).max(5000),
  chargeCapacity: z.number().int().positive().optional(),
  chargeMassKg: z.number().min(0).max(100).optional(),
  chargeItem: Id.optional(),
  /** A sensor the wearer looks through (night-vision goggle ...): a kind in core/spotting.json `sensors`. */
  sensor: z.string().optional(),
  /** Thermal blanket (M9.2): a man carrying it who is still and not firing shows this share of his heat. */
  thermalCover: Num(0, 1).optional(),
  /** Battery life of a powered item, hours (M9.2: reserved, not used yet; batteries are M11.6). */
  batteryHours: Num(0, 10000).optional(),
  /** M8.2a: a laser rangefinder (binocular): its carrier locates a target for indirect fire with it. */
  rangefinder: z.boolean().optional(),
  /** M8.3a: a crew-served mortar (the tube; its carrier is the gunner): its HE and smoke rounds (counted round items
   *  in the crew's loads), minimum and maximum range (m), seconds to set up and to pack, seconds per round at the
   *  sustained rate with a full crew, crew (and the fewest who can still fire), the first round's aim error (m per
   *  axis, as the off-map battery's `rangingErrorM`), dispersion (m per axis per km of range), seconds the crew
   *  takes to compute and lay a mission, the flight (base + per km), how far the enemy hears it (m). */
  mortar: z.object({
    calibre: z.string(), he: Id, smoke: Id, minRangeM: Num(0, 20000), maxRangeM: Num(1, 20000), setupSeconds: Num(0, 1800), packSeconds: Num(0, 1800),
    roundSeconds: Num(0.5, 120), crew: z.number().int().min(1).max(12), crewMin: z.number().int().min(1).max(12), aimErrorM: Num(0, 500),
    dispersionPerKmM: Num(0, 200), processingSeconds: Num(0, 600), flightBaseSeconds: Num(0, 120), flightPerKmSeconds: Num(0, 60), hearingRangeM: Num(0, 20000),
  }).strict().optional(),
  /** M9.3b: a crew-served weapon on a tripod worked by a team on foot (its carrier is the gunner). `kind "missile"`:
   *  a guided missile launch post: the weapon (weapons.json: its launch velocity per round), the round item (a
   *  counted container whose `chargeItem` is the guided ammunition), seconds to set up and to pack, crew (and the
   *  fewest who can still fire), the sight's height above the ground, the danger zone behind (m), how far the
   *  launch is heard (m), the traverse either side of the laid heading before a re-lay (deg) and its time, and the
   *  seconds to lay on a target. */
  crewServed: z.object({
    kind: z.literal("missile"), weapon: Id, round: Id, setupSeconds: Num(0, 1800), packSeconds: Num(0, 1800),
    crew: z.number().int().min(1).max(12), crewMin: z.number().int().min(1).max(12), sightHeightM: Num(0, 5), backblastM: Num(0, 200),
    launchLoudM: Num(0, 20000), traverseDeg: Num(1, 180), relaySeconds: Num(0, 60), aimSeconds: Num(0, 60),
  }).strict().optional(),
  /** M9.4a: a reconnaissance quadcopter (the airframe item; its operator carries it and its batteries): the battery
   *  item (charge = Wh) and the power it draws (W), the share of a battery kept to fly home on, cruise and climb
   *  speeds (m/s), the usual, lowest and highest flying height above the ground (m), seconds to launch, how far from
   *  its operator it can be flown (m), its cameras (sensor kinds in core/spotting.json) and the radius on the ground
   *  they search (m), how far it is heard (m) and the area it shows to an eye (m^2; M9.4b). */
  drone: z.object({
    battery: Id, powerW: Num(1, 5000), reserveShare: Num(0, 0.9), cruiseMps: Num(1, 60), climbMps: Num(0.5, 30),
    altitudeM: Num(5, 2000), minAltitudeM: Num(5, 2000), maxAltitudeM: Num(5, 3000), launchSeconds: Num(0, 600), controlRangeM: Num(50, 50000),
    sensors: z.array(z.string()).min(1), footprintM: Num(10, 5000), noiseM: Num(0, 2000), areaM2: Num(0.001, 10),
  }).strict().optional(),
  /** M7.6a: an explosive reactive armour tile (fitted to a vehicle face through `armour.tiles[].coverage`): the
   *  mild-steel mm it adds to the plate's need against a long rod, a single shaped charge and the main jet of a
   *  tandem charge (its precursor sets the tile off), and the least kinetic penetration (mild-steel mm) of a heavy
   *  round that sets it off. Values are game abstractions of published "share of penetration taken off" figures. */
  reactive: z.object({ addKineticMm: Num(0, 2000), addShapedMm: Num(0, 3000), addTandemMm: Num(0, 3000), triggerSteelMm: Num(0, 2000) }).strict().optional(),
  /** Belts: every `tracerEvery`-th round is this tracer ammunition instead of `chargeItem`. */
  tracerItem: Id.optional(), tracerEvery: z.number().int().min(2).max(100).optional(),
  /** Body armour and helmets: which body zones it covers, how much of each, and how much it stops. */
  armour: z.array(z.object({
    zone: z.enum(["head", "neck", "chest", "abdomen", "pelvis", "arm", "leg"]),
    /** Share of the zone covered, seen from the front or back / from the side. */
    coverageFront: z.number().min(0).max(1), coverageSide: z.number().min(0).max(1),
    /** Protection in mm of mild steel equivalent (compared with the bullet's penetration at impact). */
    protectionSteelMm: z.number().min(0).max(200),
  }).strict()).optional(),
  /** Medical supplies (M10.1): tags matched by core/medical.json `consumes`; slower / less reliable than the
   *  reference item by these factors (e.g. a rubber tourniquet against the CAT). */
  medical: z.object({ tags: z.array(Id).min(1), timeFactor: Num(0.2, 5).default(1), successFactor: Num(0, 2).default(1) }).strict().optional(),
  /** A protective emblem worn by medical personnel (red cross armband). */
  emblem: z.literal(true).optional(),
});
export const ItemsFile = z.object({ items: z.array(ItemSchema) }).strict();

const LoadEntry = z.object({ item: Id, count: z.number().int().positive(), charge: z.number().int().min(0).optional() }).strict();
const MemberSlot = z.object({
  role: Id, rank: Id,
  /** Crew templates (M7): the seat (vehicle seat id) this man takes; default: crew seats in station order. */
  seat: Id.optional(),
  /** Personal weapon (weapons.json); its magazines are in `load`. */
  weapon: Id.optional(),
  load: z.array(LoadEntry).default([]),
}).strict();
export const UnitTemplateSchema = withProv({
  id: Id,
  echelon: Id,
  /** Callsign pattern; `{n}` is replaced by the unit's number. */
  callsign: z.string(),
  /** Index of the leader in `members`, or -1. */
  leaderIndex: z.number().int().min(-1),
  members: z.array(MemberSlot),
  subunits: z.array(Id).default([]),
  /** Crew templates (M7): the vehicle type (vehicles.json) this unit crews. */
  vehicle: Id.optional(),
  /** Parent templates (M7): which sub-unit (index into `subunits`) is the crew of a vehicle that carries which
   *  other sub-units. A crew template never names its siblings itself. */
  carriage: z.array(z.object({
    crew: z.number().int().min(0), carries: z.array(z.number().int().min(0)),
    /** The parent's own men (its headquarters) ride in this vehicle too (M7.2). */
    hq: z.boolean().optional(),
  }).strict()).optional(),
});
export const UnitsFile = z.object({ units: z.array(UnitTemplateSchema).min(1) }).strict();

// ---------- vehicles (factions/<id>/vehicles.json, optional; M7) ----------
/** Generic crew station kinds (code keys, not faction words). */
export const StationKind = z.enum(["commander", "gunner", "driver", "loader", "passenger"]);
const Span = (lo: number, hi: number) => z.tuple([Num(lo, hi), Num(lo, hi)]).refine((r) => r[0] <= r[1], "range must be [min, max]");
/** A box in hull coordinates: f forward (+) / back, r right (+) / left, u up from the ground, metres. */
const Box = z.object({ f: Span(-20, 20), r: Span(-10, 10), u: Span(0, 10) }).strict();
const Pos3 = z.tuple([Num(-20, 20), Num(-10, 10), Num(0, 10)]);
export const VehicleWeaponSchema = z.object({
  weapon: Id, coax: z.boolean(), muzzle: Pos3,
  feeds: z.array(z.object({ item: Id, ready: z.object({ count: z.number().int().min(0), charge: z.number().int().min(0) }).strict() }).strict()).min(1),
  switchSeconds: Num(0, 60), engageRangeM: Num(0, 10000),
  /** "belt": rounds come off the ready belt; "single": one round loaded at a time (needs `roundLoadSeconds`);
   *  "autoloader": single rounds without a loader. */
  feedKind: z.enum(["belt", "single", "autoloader"]),
  loaderStation: StationKind.optional(), roundLoadSeconds: Num(0.1, 120).optional(), noLoaderFactor: Num(1, 20).optional(),
  /** M7.6a: "single" / "autoloader": a round is in the breech when the battle starts (taken from the first feed). */
  startLoaded: z.boolean().optional(),
  /** M7.6a: a guided weapon: the crew chooses it against vehicles at or beyond this range (m); default
   *  `behaviour.gunnery.missileBeyondM`. */
  missileBeyondM: Num(0, 10000).optional(),
}).strict();
/** Component kinds a vehicle's parts may be (M7.4a/b); what each does when damaged is in systems/armour.ts. */
export const COMPONENT_KINDS = ["engine", "transmission", "track", "wheels", "turret-drive", "stabiliser", "gun", "coax", "sights", "radio", "dischargers", "extinguisher", "ammo", "fuel"] as const;
export const VehicleSchema = withProv({
  id: Id, nameKey: z.string(), class: z.enum(["tracked", "wheeled"]),
  body: withProv({
    lengthM: Num(1, 20), widthM: Num(0.5, 6), heightM: Num(0.5, 6), groundClearanceM: Num(0, 2),
    hull: Box,
    turret: z.object({ pivotF: Num(-10, 10), f: Span(-10, 10), r: Span(-5, 5), u: Span(0, 10), barrelM: Num(0, 15), trunnionU: Num(0, 10) }).strict().optional(),
    trackContactM: Num(0.5, 15).optional(), trackGaugeM: Num(0.5, 6).optional(), wheelbaseM: Num(0.5, 15).optional(),
  }),
  mass: withProv({ kg: Num(500, 200000) }),
  drive: withProv({
    powerKw: Num(10, 5000), efficiency: Num(0.1, 1), topSpeedKmh: Num(1, 200), reverseTopSpeedKmh: Num(1, 100), brakeMps2: Num(0.5, 15),
    gears: z.array(z.object({ toKmh: Num(1, 200) }).strict()).min(1).max(12),
    reverseGears: z.array(z.object({ toKmh: Num(1, 100) }).strict()).min(1).max(6),
    shiftSeconds: Num(0, 5),
    steering: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("tracked"), pivot: z.boolean(), pivotRateDegS: Num(1, 180), maxLatAccelMps2: Num(0.5, 15), slipCoeff: Num(0, 2), turnResistance: Num(0, 3) }).strict(),
      z.object({ kind: z.literal("wheeled"), maxSteerDeg: Num(5, 60), steerRateDegS: Num(1, 180), maxLatAccelMps2: Num(0.5, 15) }).strict(),
    ]),
    idleKw: Num(0, 500), litresPerKwh: Num(0.05, 2),
  }),
  /** The tank: an item whose charge is litres (counted in the vehicle's container, SPEC 4.3 rule 9). */
  fuel: z.object({ item: Id, capacityL: Num(1, 5000) }).strict(),
  seats: z.array(z.object({
    id: Id, station: StationKind, pos: Pos3, part: z.enum(["hull", "turret"]), hatch: z.boolean(),
    /** Sensor kinds (core/spotting.json) this seat looks through (M7.3). */
    sensors: z.array(z.object({ kind: z.string(), pos: Pos3.optional(), arcDeg: Num(1, 360), sideFactor: Num(0, 1), rearFactor: Num(0, 1), follows: z.enum(["own", "station"]), lrf: z.boolean().optional() }).strict()).optional(),
  }).strict()).min(1),
  ramp: withProv({
    /** Exit points in hull coordinates [f, r]. */
    exits: z.array(z.tuple([Num(-20, 20), Num(-10, 10)])).min(1),
    openSeconds: Num(0, 60), mountSecondsPerMan: Num(0, 60), dismountSecondsPerMan: Num(0, 60), bailOutSeconds: Num(0, 120),
    seatSwapSeconds: Num(0, 300), loadCasualtySeconds: Num(0, 300),
  }),
  stations: z.array(withProv({
    id: Id, kind: z.enum(["turret", "mount"]), operator: StationKind, commanderOverride: z.boolean(),
    traverseDegS: Num(0, 360), elevateDegS: Num(0, 180), elevationDeg: Span(-30, 90), traverseArcDeg: Span(-180, 180).optional(),
    stabiliser: z.enum(["none", "one-plane", "two-plane"]), baseErrorMrad: Num(0, 50), movingMradPerMps: Num(0, 20),
    layToleranceMrad: Num(0, 100), rangefinder: z.boolean(), readyRefillInBattle: z.boolean(),
    /** Refilling the ready belts from stowage, halted (M7.3, owner Q17: both vehicles, about 90 s). */
    refillSeconds: Num(1, 1200).optional(),
    /** The station's weapons (filled in M7.3 for the real vehicles). */
    weapons: z.array(VehicleWeaponSchema).default([]),
  })).default([]),
  /** Stowed items in the hull (belts, smoke charges, extinguisher charges ...). */
  stowed: z.array(z.object({ item: Id, count: z.number().int().positive(), charge: z.number().int().min(0).optional() }).strict()).default([]),
  /** Reserved blocks (declared now so the schema shape is known; filled by the slices that use them). */
  /** Smoke grenade dischargers (M7.3): `perSalvo` rounds of `item` (counted in the container) burst `rangeM` out
   *  over `arcDeg` ahead of the turret after `delaySeconds`, each a cloud of `cloudRadiusM` for `cloudSeconds`. */
  dischargers: withProv({
    item: Id, perSalvo: z.number().int().min(1).max(20), salvos: z.number().int().min(1).max(20), arcDeg: Num(1, 360),
    rangeM: Num(1, 200), delaySeconds: Num(0, 30), cloudRadiusM: Num(1, 100), cloudSeconds: Num(1, 1200), component: Id.optional(),
    /** M8.1: the cloud's height (m); a grenade cloud is a puff (it drifts whole). */
    cloudTopM: Num(0.5, 200).default(8),
  }).optional(),
  /** Armour (M7.4a): one plate per part and face. Thickness in mm of `material` (resistance per mm from
   *  materials.json, kinetic and shaped); slopeDeg: the plate's lean back from upright (top plates: ignored). */
  armour: withProv({
    plates: z.array(z.object({
      part: z.enum(["hull", "turret"]), face: z.enum(["front", "side", "rear", "top"]), material: Id, thicknessMm: Num(0, 2000), slopeDeg: Num(0, 89),
    }).strict()).min(1),
    /** Add-on tiles on a part and face, counted items of the vehicle's container (each `item` stowed, one row per
     *  item). Exactly one of:
     *  - `factor` (M7.4b, fixture): a shaped-charge hit uses up one tile and needs `factor` times the penetration;
     *  - `coverage` (M7.6a, explosive reactive armour): the item has a `reactive` block; a hit meets a live tile with
     *    chance `coverage * tiles left / tiles fitted` (fitted = the stowed count), uses it up and adds the tile's
     *    mm to the need (kinetic rounds: heavy rounds at or above its trigger only). */
    tiles: z.array(z.object({
      part: z.enum(["hull", "turret"]), face: z.enum(["front", "side", "rear", "top"]), item: Id, factor: Num(1, 20).optional(), coverage: Num(0, 1).optional(),
    }).strict().refine((t) => (t.factor === undefined) !== (t.coverage === undefined), "a tile has exactly one of factor or coverage")).optional(),
  }).optional(),
  /** Parts inside and outside the hull a penetrating round can damage (M7.4a). Box in the part's frame (turret:
   *  about the turret pivot); toughnessMm: residual penetration that wrecks it outright (less: that share of its
   *  condition), absorbMm: what passing through it takes off the round; fireChance: a penetrating hit on it
   *  starts a fire; cookOffChance (ammunition): it blows up at once. external: struck from outside (tracks). */
  components: withProv({
    parts: z.array(z.object({
      id: Id, kind: z.enum(COMPONENT_KINDS), part: z.enum(["hull", "turret"]), box: Box,
      external: z.boolean().optional(), toughnessMm: Num(0.1, 2000), absorbMm: Num(0, 2000),
      fireChance: Num(0, 1).optional(), cookOffChance: Num(0, 1).optional(),
    }).strict()).min(1),
  }).optional(),
  cookOffAmmo: Id.optional(),
  /** Fire extinguishing (M7.4b): when a fire starts, after `delaySeconds` one charge `item` from the container
   *  (counted) puts it out with `chance` (half that for a fire in the ammunition); another try with the next
   *  charge while the fire burns. Needs a working "extinguisher" component if the vehicle lists one. */
  extinguisher: withProv({ item: Id, chance: Num(0, 1), delaySeconds: Num(0, 60) }).optional(),
  /** How it is seen and heard (M7.3). sizeFactor multiplies the area its boxes show (camouflage, shape);
   *  identifyM: its type is known within this range (owner Q6); noise ranges idle / moving; aim points [f, r, u]. */
  signature: withProv({
    sizeFactor: Num(0.05, 5), movingFactor: Num(1, 50), firingFactor: Num(1, 500), identifyM: Num(0, 10000),
    noiseIdleM: Num(0, 10000), noiseMovingM: Num(0, 20000), aimPoints: z.array(Pos3).min(1).max(8),
  }).optional(),
  /** Active protection (M7.4b; only the fixture uses it): a rocket coming within `detectM` is engaged; with
   *  `interceptChance` one charge `item` (counted in the container) bursts it `standoffM` short of the hull (no jet
   *  reaches the plate); the next engagement no sooner than `cooldownSeconds` later. */
  activeProtection: withProv({ item: Id, detectM: Num(0.5, 100), standoffM: Num(0.5, 50), interceptChance: Num(0, 1), cooldownSeconds: Num(0, 60) }).optional(),
  /** An ambulance (M10.6-data): the patient layouts it can take (alternatives: lying places, sitting places and
   *  lying places outside the hull), and whether it carries the protective emblem (recognition: M10.7a). How
   *  casualties are loaded and carried is the medical line's (M10.6a); the seats list the sitting places. */
  ambulance: withProv({
    layouts: z.array(z.object({ lying: z.number().int().min(0).max(20), sitting: z.number().int().min(0).max(20), lyingOutside: z.number().int().min(0).max(10).optional() }).strict()).min(1),
    marked: z.boolean(),
  }).optional(),
  /** M9.3a: a laser warning receiver: the crew notices a beam-riding missile aimed at it. */
  laserWarner: z.boolean().optional(),
  recovery: z.null().optional(),
});
export const VehiclesFile = z.object({ vehicles: z.array(VehicleSchema) }).strict();
export type VehicleT = z.infer<typeof VehicleSchema>;

export const DOCTRINE_KEYS = [
  "preferredSpacingM",
  "aggressiveness",
  "willingnessToDismount",
  "casualtyToleranceBeforeWithdrawal",
  "relianceOnSupportingFire",
  "droneUse",
  "evacuationPriority",
  /** How much longer a route may be to stay in cover: 0.3 = accept ~30 % longer (owner decision). */
  "coverPreference",
  /** Fire and movement (M4.4): length of one bound, m, and the last stretch rushed together, m. */
  "boundM",
  "finalAssaultM",
  /** M10.3a: how readily a man leaves the fight to go to a wounded comrade (willingness factor, 0..1). */
  "casualtyCarePriority",
] as const;
/** An off-map fire support asset (M6.5c mortars; M8.4 artillery). */
const FireSupportAsset = z.object({
    heAmmo: Id, smokeAmmo: Id, delaySeconds: Num(0, 1200), dispersionM: Num(0, 500), intervalSeconds: Num(0.5, 120),
    smokeRadiusM: Num(1, 200), smokeSeconds: Num(1, 1800),
    /** M8.1: a smoke round's cloud height (m) and how long the round burns at its place, feeding the plume (s). */
    smokeTopM: Num(0.5, 200).default(15), smokeBurnSeconds: Num(0, 1800).default(0),
    /** Scales the rounds a generated battle gives this faction (owner, 2026-11-12: more rounds for the lighter
     *  Russian mortar rather than a heavier one). */
    roundsFactor: Num(0.1, 10).default(1),
    /** Ranging before the salvo (step fire-support): ranging rounds (0 = none), the first round's aiming error
     *  (one standard deviation per axis, m), the share of the error left after an observed round, seconds between
     *  ranging rounds (and to the first volley), tubes (rounds per volley), seconds between a volley's rounds, and
     *  how close a new mission must be to a point already ranged on to skip ranging (m). */
    rangingRounds: z.number().int().min(0).max(5).default(0), rangingErrorM: Num(0, 500).default(0), rangingCorrection: Num(0, 1).default(0.3),
    rangingSeconds: Num(1, 300).default(20), tubes: z.number().int().min(1).max(12).default(1), volleySpreadSeconds: Num(0, 10).default(0.5),
    registeredM: Num(0, 1000).default(0),
    /** The call-for-fire chain (M8.2a): of `delaySeconds` (the call reaching the section to the first round
     *  landing), the radio call itself takes `requestSeconds` and the round's flight `flightSeconds`; the rest is
     *  processing (computing and laying). "Splash" is called `splashSeconds` before a round lands. */
    requestSeconds: Num(0, 600).default(0), flightSeconds: Num(0, 300).default(0), splashSeconds: Num(0, 60).default(5),
    /** First-round error by how the target was located (M8.2a): one standard deviation per axis, m, of
     *  `baseM` + `perM` x the caller's distance to the point, on top of the battery's own `rangingErrorM`
     *  (absent: the battery's error alone, whatever the method). */
    locationError: z.object({
      estimate: z.object({ baseM: Num(0, 500), perM: Num(0, 1) }).strict(),
      laser: z.object({ baseM: Num(0, 500), perM: Num(0, 1) }).strict(),
      /** M9.5: located by a drone's camera (`perM` x the drone's slant range to the point) and by an off-map
       *  fixed-wing reconnaissance drone (rules.airRecon). Absent: those methods are not used. */
      drone: z.object({ baseM: Num(0, 500), perM: Num(0, 1) }).strict().optional(),
      air: z.object({ baseM: Num(0, 500), perM: Num(0, 1) }).strict().optional(),
    }).strict().optional(),
    /** Adjustment by the observer (M8.2b): his reading error of a fall (m, one standard deviation per axis):
     *  `readBaseM` + `readPerM` x his distance to it by eye, `laserReadM` with a laser; correction share and reading
     *  error x a skill factor from `skillWorst` (skill 0) to `skillBest` (skill 1). Absent: the correction alone. */
    adjust: z.object({
      readBaseM: Num(0, 200), readPerM: Num(0, 1), laserReadM: Num(0, 100), skillWorst: Num(0.1, 5), skillBest: Num(0.1, 5),
      /** M9.5: the reading error of a fall seen through a drone's camera, and by the off-map reconnaissance drone (m). */
      droneReadM: Num(0, 100).optional(), airReadM: Num(0, 100).optional(),
    }).strict().optional(),

    /** M8.4: illumination round (absent: none); airburst height of a proximity or time fuse over the target (m;
     *  absent: no airburst); danger close (m): a call this close to own men needs `dangerClose` in the order;
     *  counter-battery (abstract, owner M8 screen 2 (a)): after `missionsBeforeMove` missions the battery displaces
     *  for `moveSeconds` and takes no calls meanwhile. */
    illumAmmo: Id.optional(), airburstHeightM: Num(1, 50).optional(), dangerCloseM: Num(0, 5000).optional(),
    counterBattery: z.object({ missionsBeforeMove: z.number().int().min(1).max(100), moveSeconds: Num(0, 7200) }).strict().optional(),
  }).strict();

export const DoctrineFile = withProv({
  /** Formation used when an order does not name one (core/formations.json). */
  defaultFormation: Id,
  values: z.object(Object.fromEntries(DOCTRINE_KEYS.map((k) => [k, z.number().min(0).max(100)])) as Record<(typeof DOCTRINE_KEYS)[number], z.ZodNumber>).strict(),
  /** The fire support a platoon can call (M6.5c): its mortar rounds, how long until the first lands, the spread
   *  of the fall of shot (one standard deviation, m), the time between rounds, and the smoke screen one round
   *  lays (radius, how long it lasts). Optional: a faction without it calls no fire. */
  fireSupport: FireSupportAsset.optional(),
  /** M8.4: the off-map artillery battery (155 mm / 152 mm) a platoon can call, the same fields. */
  artillery: FireSupportAsset.optional(),
  /** Where an attacking AI gets its men out of their vehicles (M7.2, owner Q22): this far short of the objective,
   *  out of sight of the enemy where possible. Sourced per faction (docs/research/dismount.md). */
  dismount: withProv({
    distanceM: Num(0, 5000),
    /** After the squads are out (M7.3): the vehicles stay in overwatch where they dropped them, or follow the
     *  squads this far behind, supporting them by fire. Default overwatch. */
    afterward: z.enum(["overwatch", "follow"]).optional(), followM: Num(0, 2000).optional(),
  }).optional(),
  /** The identity tag every soldier carries (owner request 2026-11-15): `perMan` of the item each; `taken` of them
   *  are taken from a man confirmed dead (the German tag's broken-off half, the Russian tag whole). */
  identityTag: withProv({ item: Id, perMan: z.number().int().min(1).max(4), taken: z.number().int().min(1).max(4) }).optional(),
});

export type FactionManifestT = z.infer<typeof FactionManifest>;
export type RankT = z.infer<typeof RankSchema>;
export type RoleT = z.infer<typeof RoleSchema>;
export type NamesT = z.infer<typeof NamesFile>;
export type ItemT = z.infer<typeof ItemSchema>;
export type UnitTemplateT = z.infer<typeof UnitTemplateSchema>;
export type DoctrineT = z.infer<typeof DoctrineFile>;
export type MovementModeT = z.infer<typeof MovementModeSchema>;
export type FootModeT = z.infer<typeof FootModeSchema>;
export type QualityT = z.infer<typeof QualitySchema>;

// ---- Appearance (M7.5): presentation only. NOT part of the catalog or its fingerprint (plan m7.5 §1.1).
// Original colour choices (docs/ASSETS.md), not researched facts: no provenance, an optional note.
const LookColour = z.string().regex(/^#[0-9a-f]{6}$/, "colours are '#rrggbb' (lower case)");
/**
 * Rank insignia (the "insignia" step, owner 2026-11-14; exact shapes, "insignia-exact" 2026-11-14): what one rank
 * wears on the field uniform, drawn in code by the UI (`ui/src/insignia.ts`) at true proportions. Every length is
 * in millimetres on the real board: x across it from its centre line (+ = right as seen), y along it from its
 * shoulder-seam end (0) towards the collar end. Faction-neutral: the drawing never knows whose uniform it is.
 */
const Mm = z.number().min(-300).max(300);
const PosMm = z.number().positive().max(300);
export const InsigniaElementSchema = z.discriminatedUnion("kind", [
  /** A band across the board between y0 and y1; x0/x1 absent: edge to edge (cross stripes, lychki, galun);
   *  given: a band along the board (a long stripe). */
  z.object({ kind: z.literal("band"), y0: Mm, y1: Mm, x0: Mm.optional(), x1: Mm.optional() }).strict(),
  /** A diagonal stripe (Schraegstreifen) `widthMm` wide, its centre line through (0, y) at `angleDeg` (+ = rising to
   *  the right), its ends cut square to the board's long edges `insetMm` inside them. */
  z.object({ kind: z.literal("bar"), y: Mm, widthMm: PosMm, angleDeg: z.number().min(-75).max(75), insetMm: z.number().min(0).max(50) }).strict(),
  /** A braid (Tresse) `widthMm` wide round the board, `insetMm` inside its edge; `open`: no braid along the
   *  shoulder end (the long sides run out to it). */
  z.object({ kind: z.literal("braid"), widthMm: PosMm, insetMm: z.number().min(0).max(50), open: z.boolean() }).strict(),
  /** A chevron (Winkel) of a `widthMm` band, point towards the collar: its centre line from (-halfSpanMm, y - riseMm)
   *  to the point (0, y) and back down. `headMm` > 0: a headed chevron (Kopfwinkel): the legs cross at (0, y) and run
   *  on `headMm` (measured up the board) to close a diamond above it. */
  z.object({ kind: z.literal("chevron"), y: Mm, halfSpanMm: PosMm, riseMm: PosMm, widthMm: PosMm, headMm: z.number().min(0).max(60).optional() }).strict(),
  /** A star (pip) of `points` points, `diameterMm` across its points, one point towards the collar. */
  z.object({ kind: z.literal("star"), x: Mm, y: Mm, diameterMm: PosMm, points: z.union([z.literal(4), z.literal(5)]) }).strict(),
]);
/** One rank: the devices on its board; `bare`: the rank wears no board at all (only the strap, if any, shows). */
export const InsigniaDeviceSchema = z.object({
  bare: z.boolean().optional(),
  elements: z.array(InsigniaElementSchema).max(12),
  note: z.string().optional(),
}).strict();
/** A faction's rank insignia: the board, the strap under it, the arm-of-service loop, and per rank id its devices. */
export const FactionInsigniaSchema = z.object({
  /** The rank board (slide, sleeve, shoulder board or tab): a trapezoid `lengthMm` long, `widthTopMm` wide at the
   *  collar end and `widthBottomMm` at the shoulder end, corners rounded by `cornerMm`; its cloth and edge colours. */
  board: z.object({ lengthMm: PosMm, widthTopMm: PosMm, widthBottomMm: PosMm, cornerMm: z.number().min(0).max(40), colour: LookColour, edge: LookColour }).strict(),
  /** The uniform's shoulder strap the board is slid onto, where it shows: `aboveMm` beyond the board's collar end
   *  (a blunt point with its button, `buttonMm` across; 0 = none) and `belowMm` beyond its shoulder end. `widthMm`
   *  is its width at the board's collar end; it widens with the board's taper towards the shoulder. Absent: no
   *  strap is drawn. */
  strap: z.object({ widthMm: PosMm, aboveMm: z.number().min(0).max(100), belowMm: z.number().min(0).max(100), buttonMm: z.number().min(0).max(30), colour: LookColour, edge: LookColour }).strict().optional(),
  /** The arm-of-service loop (Litze) round the strap at the shoulder seam, in the branch colour (Waffenfarbe) of
   *  `branch`, `widthMm` wide, `gapMm` below the board's shoulder end. Needs a strap. */
  litze: z.object({ colour: LookColour, widthMm: PosMm, gapMm: z.number().min(0).max(50), branch: z.string() }).strict().optional(),
  /** The devices' colour (embroidered or woven). */
  device: LookColour,
  /** Drawn smaller than `belowPx` tall (a card row): devices in `device` instead (absent: the usual colour) with a
   *  1 px `outline` round them (absent: none), so low-contrast (protective-colour) devices still read. */
  small: z.object({ belowPx: PosMm, device: LookColour.optional(), outline: LookColour.optional() }).strict().optional(),
  ranks: z.record(Id, InsigniaDeviceSchema),
  sources: z.array(z.url()),
  confidence: Confidence,
  note: z.string().optional(),
}).strict();
export type InsigniaElementT = z.infer<typeof InsigniaElementSchema>;
export type InsigniaDeviceT = z.infer<typeof InsigniaDeviceSchema>;
export type FactionInsigniaT = z.infer<typeof FactionInsigniaSchema>;
/** A faction's look: uniform tones for the pixel figures (M7.5b) and its vehicles' paint. */
export const FactionAppearanceFile = z.object({
  uniform: z.object({ base: LookColour, dark: LookColour, light: LookColour, helmet: LookColour, skin: LookColour }).strict(),
  vehicle: z.object({ hull: LookColour, dark: LookColour }).strict(),
  /** Painted emblems by vehicle type (M10.6-data): the red cross on an ambulance's roof and sides. Presentation
   *  only; whether the sim treats the hull as marked is the vehicle's `ambulance.marked` (catalog). */
  markings: z.record(Id, z.enum(["red-cross"])).optional(),
  /** Rank insignia on the field uniform, shown on the unit card (presentation only). */
  insignia: FactionInsigniaSchema.optional(),
  note: z.string().optional(),
}).strict();
/** The flat map palette (M7.5b): one colour per surface, vegetation, roof and floor (keyed by terrain ids). */
export const CoreAppearanceFile = z.object({
  surfaces: z.record(Id, LookColour),
  vegetation: z.record(Id, LookColour),
  roofs: z.record(Id, LookColour),
  floors: z.record(Id, LookColour),
  outline: LookColour,
  /** The photo map (plan "photo"): its own, quieter colours (falling back to the ones above) and its grade. */
  photo: z.object({
    surfaces: z.record(Id, LookColour).optional(),
    vegetation: z.record(Id, LookColour).optional(),
    obstacles: z.record(Id, LookColour).optional(),
    roofs: z.record(Id, LookColour).optional(),
    floors: z.record(Id, LookColour).optional(),
    grade: z.object({ desaturate: z.number().min(0).max(1), contrast: z.number().min(-0.5).max(0.5), warm: z.number().min(-0.2).max(0.2), grain: z.number().min(0).max(0.2) }).strict().optional(),
    ladder: z.string().optional(),
    note: z.string().optional(),
  }).strict().optional(),
  note: z.string().optional(),
}).strict();
export type FactionAppearanceT = z.infer<typeof FactionAppearanceFile>;
export type CoreAppearanceT = z.infer<typeof CoreAppearanceFile>;
