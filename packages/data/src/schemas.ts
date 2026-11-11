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
export const MovementModeSchema = withProv({
  id: Id, nameKey: z.string(), class: MovementClass, speedMps: z.number().positive().max(40),
  /** Posture a soldier takes for this mode (vehicles: ignored). */
  posture: PostureId,
  /** Work rate of moving in this mode (0 = resting, ~0.85 = running); drives heart rate and fatigue. */
  exertion: z.number().min(0).max(2),
});
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
});
/** SPEC 6.3: shell and warhead types supported by the data model from the start. */
export const AmmoKind = z.enum([
  "ball", "armour-piercing", "tracer", "high-explosive", "fragmentation", "shaped-charge", "tandem-shaped-charge",
  "kinetic-penetrator", "airburst", "smoke", "illumination", "thermobaric",
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
    fragmentMassKg: Num(0, 1), fragmentVelocityMps: z.tuple([Num(0, 4000), Num(0, 4000)]),
  }).strict().optional(),
});
export const AmmunitionFile = z.object({ ammunition: z.array(AmmoSchema) }).strict();
export const WeaponSchema = withProv({
  id: Id, nameKey: z.string(),
  type: z.enum(["rifle", "carbine", "marksman-rifle", "light-machine-gun", "machine-gun", "pistol", "grenade-launcher", "launcher"]),
  calibre: z.string(), massKg: Num(0.1, 500),
  feed: z.object({ magazine: Id }).strict(),
  fireModes: z.array(z.enum(["semi", "burst", "auto"])).min(1),
  cyclicRpm: Num(1, 6000),
  /** Mechanical dispersion of weapon and ammunition (one standard deviation), milliradians. */
  dispersionMrad: Num(0, 50),
  reloadSeconds: Num(0.1, 120), setupSeconds: Num(0, 600),
  /** Chance of a stoppage per round fired. */
  jamProbability: Num(0, 0.1),
  sights: z.array(z.object({ kind: z.enum(["iron", "reflex", "magnified", "night", "thermal"]), magnification: Num(1, 60) }).strict()).min(1),
  /** Ammunition this weapon fires, with its muzzle velocity from this barrel, m/s. */
  ammo: z.record(Id, z.number().positive().max(3000)),
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
  }),
}).strict();
export type ShootingT = z.infer<typeof ShootingFile>;

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
  }),
  physiology: withProv({
    bloodVolumeL: Num(1, 10), unconsciousLossFraction: Num(0.05, 1), deathLossFraction: Num(0.05, 1), shockStartFraction: Num(0, 1),
    clotBelowLps: Num(0, 0.1), clotTauS: Num(1, 100000), breathingShockPerS: Num(0, 1), airwayShockPerS: Num(0, 1),
    painDecayPerS: Num(0, 1), stepSeconds: Num(0.05, 10),
  }),
  effects: withProv({
    legNoWalkSeverity: Num(0, 2), armNoFightSeverity: Num(0, 2), painNoFightAt: Num(0, 2),
    moveSeverityK: Num(0, 10), aimSeverityK: Num(0, 20), aimPainK: Num(0, 20), minMoveFactor: Num(0.01, 1),
  }),
}).strict();
export type WoundsT = z.infer<typeof WoundsFile>;

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
});
export const VegetationSchema = withProv({
  id: Id, nameKey: z.string(), heightM: z.number().positive().max(60),
  /** Fraction of a line of sight blocked per metre travelled through it. */
  concealmentPerM: z.number().min(0).max(1),
  /** Fraction of a bullet's energy lost per metre (M2). */
  stoppingPerM: z.number().min(0).max(0.1),
  moveCost: MoveCost, colour: Colour,
});
export const ObstacleKindSchema = withProv({
  id: Id, nameKey: z.string(), heightM: z.number().positive().max(20), thicknessM: z.number().positive().max(30),
  material: Id, seeThrough: z.number().min(0).max(1),
  footCrossTimeS: z.number().positive().max(600).nullable(),
  wheeledCrossable: z.boolean(), trackedCrossable: z.boolean(), colour: Colour,
});
export const BuildingKindSchema = withProv({
  id: Id, nameKey: z.string(), widthM: Range, depthM: Range, storeys: IntRange, storeyHeightM: z.number().positive().max(20),
  wallMaterial: Id, wallThicknessM: z.number().positive().max(3), roofColours: z.array(Colour).min(1),
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

export const RoleSchema = withProv({ id: Id, nameKey: z.string(), leader: z.boolean().optional() });
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
  /** Body armour and helmets: which body zones it covers, how much of each, and how much it stops. */
  armour: z.array(z.object({
    zone: z.enum(["head", "neck", "chest", "abdomen", "pelvis", "arm", "leg"]),
    /** Share of the zone covered, seen from the front or back / from the side. */
    coverageFront: z.number().min(0).max(1), coverageSide: z.number().min(0).max(1),
    /** Protection in mm of mild steel equivalent (compared with the bullet's penetration at impact). */
    protectionSteelMm: z.number().min(0).max(200),
  }).strict()).optional(),
});
export const ItemsFile = z.object({ items: z.array(ItemSchema) }).strict();

const LoadEntry = z.object({ item: Id, count: z.number().int().positive(), charge: z.number().int().min(0).optional() }).strict();
const MemberSlot = z.object({
  role: Id, rank: Id,
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
});
export const UnitsFile = z.object({ units: z.array(UnitTemplateSchema).min(1) }).strict();

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
] as const;
export const DoctrineFile = withProv({
  /** Formation used when an order does not name one (core/formations.json). */
  defaultFormation: Id,
  values: z.object(Object.fromEntries(DOCTRINE_KEYS.map((k) => [k, z.number().min(0).max(100)])) as Record<(typeof DOCTRINE_KEYS)[number], z.ZodNumber>).strict(),
});

export type FactionManifestT = z.infer<typeof FactionManifest>;
export type RankT = z.infer<typeof RankSchema>;
export type RoleT = z.infer<typeof RoleSchema>;
export type NamesT = z.infer<typeof NamesFile>;
export type ItemT = z.infer<typeof ItemSchema>;
export type UnitTemplateT = z.infer<typeof UnitTemplateSchema>;
export type DoctrineT = z.infer<typeof DoctrineFile>;
export type MovementModeT = z.infer<typeof MovementModeSchema>;
export type QualityT = z.infer<typeof QualitySchema>;
