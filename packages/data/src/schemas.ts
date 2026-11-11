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
export const MovementModeSchema = withProv({ id: Id, nameKey: z.string(), speedMps: z.number().positive().max(40) });
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
