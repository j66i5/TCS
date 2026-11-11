/**
 * Force builder: turns a faction's unit template (data) + a quality level + a seed into roster records
 * (UnitInput). Names, ranks, skills and loads all come from data; no faction is special-cased.
 */
import type { DataSet, FactionPack } from "@tcs/data";
import {
  clamp, createRng, nextFloat, nextNormal, pick, type RngState, type SoldierRecord, type UnitInput,
} from "@tcs/sim";

export interface BuildForceOptions {
  faction: string;
  template: string;
  /** Quality level ID (core/qualities.json). Defaults to the faction's default. */
  quality?: string;
  seed: number;
  /** Prefix for unit keys and person IDs, unique within a battle (e.g. "blue"). */
  keyPrefix: string;
  /** Number used in the callsign pattern `{n}`. */
  number?: number;
}

export function buildForce(data: DataSet, opts: BuildForceOptions): UnitInput {
  const pack = data.factions[opts.faction];
  if (!pack) throw new Error(`unknown faction '${opts.faction}'`);
  const quality = data.qualities[opts.quality ?? pack.manifest.defaultQuality];
  if (!quality) throw new Error(`unknown quality '${opts.quality}'`);
  const rng = createRng(opts.seed);
  const counter = { n: 0 };
  return buildUnit(pack, opts.template, quality.skills, rng, `${opts.keyPrefix}`, opts.number ?? 1, counter);
}

function buildUnit(
  pack: FactionPack,
  templateId: string,
  skills: Record<string, { mean: number; sd: number }>,
  rng: RngState,
  key: string,
  n: number,
  counter: { n: number },
): UnitInput {
  const t = pack.units[templateId];
  if (!t) throw new Error(`unknown unit template '${templateId}' in faction '${pack.manifest.id}'`);
  const members: SoldierRecord[] = t.members.map((slot) => {
    const female = nextFloat(rng, "names") < pack.names.femaleShare;
    const given = pick(rng, "names", female && pack.names.givenFemale.length > 0 ? pack.names.givenFemale : pack.names.given);
    const family = pick(rng, "names", pack.names.family) + (female ? pack.names.familyFemaleSuffix : "");
    const sk: Record<string, number> = {};
    for (const [k, d] of Object.entries(skills).sort()) sk[k] = clamp(d.mean + d.sd * nextNormal(rng, "skills"), 0, 1);
    return {
      personId: `${key}#${counter.n++}`,
      given,
      family,
      rank: slot.rank,
      role: slot.role,
      ...(slot.weapon === undefined ? {} : { weapon: slot.weapon }),
      skills: sk,
      fatigue: 0,
      stress: 0,
      wounds: [],
      load: slot.load.map((l) => (l.charge === undefined ? { type: l.item, count: l.count } : { type: l.item, count: l.count, charge: l.charge })),
      status: "fit" as const,
    };
  });
  return {
    key,
    callsign: t.callsign.replace("{n}", String(n)),
    echelon: t.echelon,
    leaderIndex: t.leaderIndex,
    members,
    subunits: t.subunits.map((s, i) => buildUnit(pack, s, skills, rng, `${key}/${i + 1}`, i + 1, counter)),
  };
}

/** All soldier records of a unit tree, depth first. */
export function allMembers(u: UnitInput): SoldierRecord[] {
  return [...u.members, ...u.subunits.flatMap(allMembers)];
}
