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
  postures: z.array(withProv({ id: PostureId, heightM: Num(0.1, 2.5), speedFactor: Num(0.05, 1) })).length(3),
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
  /** 0..1, how readily projectiles ricochet. */
  hardness: z.number().min(0).max(1),
});
export const SurfaceSchema = withProv({
  id: Id, nameKey: z.string(), moveCost: MoveCost,
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
});
export const ItemsFile = z.object({ items: z.array(ItemSchema) }).strict();

const LoadEntry = z.object({ item: Id, count: z.number().int().positive(), charge: z.number().int().min(0).optional() }).strict();
const MemberSlot = z.object({ role: Id, rank: Id, load: z.array(LoadEntry).default([]) }).strict();
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
] as const;
export const DoctrineFile = withProv({
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
