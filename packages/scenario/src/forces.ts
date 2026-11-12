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

/** A vehicle of a built force (M7.2): its id (the crew unit's key), type, and the seat each crewman takes. */
export interface ForceVehicle {
  vehicleId: string;
  type: string;
  /** Crewmen whose template slot names a seat (vehicle seat id). */
  crewSeats: { personId: string; seat: string }[];
}

export function buildForce(data: DataSet, opts: BuildForceOptions): UnitInput {
  return buildForceWithVehicles(data, opts).unit;
}

/**
 * As `buildForce`, and the vehicles its crews man (M7.2): a crew template (`vehicle`) gives its unit a
 * `vehicleId` (its key); a parent's `carriage` gives the carried sub-units (and, with `hq`, the parent itself) a
 * `carrierId`. Crew sub-units come after the squads in the templates, so the squads' names and skills are drawn
 * exactly as without them.
 */
export function buildForceWithVehicles(data: DataSet, opts: BuildForceOptions): { unit: UnitInput; vehicles: ForceVehicle[] } {
  const pack = data.factions[opts.faction];
  if (!pack) throw new Error(`unknown faction '${opts.faction}'`);
  const quality = data.qualities[opts.quality ?? pack.manifest.defaultQuality];
  if (!quality) throw new Error(`unknown quality '${opts.quality}'`);
  const rng = createRng(opts.seed);
  const counter = { n: 0 };
  const vehicles: ForceVehicle[] = [];
  const unit = buildUnit(pack, opts.template, quality.skills, rng, `${opts.keyPrefix}`, opts.number ?? 1, counter, vehicles);
  return { unit, vehicles };
}

/** The same force without vehicles: crew units removed and no carriers (infantry battles). */
export function withoutVehicles(u: UnitInput): UnitInput {
  const { carrierId: _c, vehicleId: _v, ...rest } = u;
  void _c; void _v;
  return { ...rest, subunits: u.subunits.filter((s) => s.vehicleId === undefined).map(withoutVehicles) };
}

function buildUnit(
  pack: FactionPack,
  templateId: string,
  skills: Record<string, { mean: number; sd: number }>,
  rng: RngState,
  key: string,
  n: number,
  counter: { n: number },
  vehicles: ForceVehicle[],
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
  if (t.vehicle !== undefined) {
    vehicles.push({ vehicleId: key, type: t.vehicle, crewSeats: t.members.flatMap((slot, i) => (slot.seat === undefined ? [] : [{ personId: members[i]!.personId, seat: slot.seat }])) });
  }
  // Each sub-unit is numbered among its siblings of the same template ("Puma 1" .. "Puma 4" after three squads).
  const subunits = t.subunits.map((s, i) => buildUnit(pack, s, skills, rng, `${key}/${i + 1}`, t.subunits.slice(0, i).filter((x) => x === s).length + 1, counter, vehicles));
  const unit: UnitInput = {
    key,
    callsign: t.callsign.replace("{n}", String(n)),
    echelon: t.echelon,
    leaderIndex: t.leaderIndex,
    members,
    subunits,
    ...(t.vehicle !== undefined ? { vehicleId: key } : {}),
  };
  // Who rides in which vehicle (the parent's carriage).
  for (const c of t.carriage ?? []) {
    const vid = subunits[c.crew]?.vehicleId;
    if (vid === undefined) continue;
    for (const k of c.carries) { const su = subunits[k]; if (su) su.carrierId = vid; }
    if (c.hq === true) unit.carrierId = vid;
  }
  return unit;
}

/** All soldier records of a unit tree, depth first. */
export function allMembers(u: UnitInput): SoldierRecord[] {
  return [...u.members, ...u.subunits.flatMap(allMembers)];
}
