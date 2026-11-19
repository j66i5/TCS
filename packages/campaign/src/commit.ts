/**
 * WHO FIGHTS (M12.1a; the player's choice and validation come with M12.2): a battle takes at most one company's worth
 * per side (`core/campaign.json` `battle`): the fittest company (most men; ties: the first), its headquarters and its
 * platoons, and the battalion's support up to the cap (mortar section, AGL team, missile team, tank section). The
 * committed units go into the battle as top-level units (the company headquarters with its own hull, each platoon,
 * each support unit); hulls not in service stay out, and their crews with them (they rest); a carried squad whose
 * carrier is not there walks. Everything is a deep copy: the record is changed only by `applyResult`.
 */
import type { DataSet } from "@tcs/data";
import type { UnitInput, VehicleRecord } from "@tcs/sim";
import type { ScenarioForces } from "@tcs/scenario";
import type { CampaignForce } from "./record";
import { clone, membersOf } from "./record";
import { campaignRules } from "./rules";

const menIn = (u: UnitInput) => membersOf(u).length;

/** The fittest company of a battalion (most men; ties: the first in order), or null when none has a man. */
export function fittestCompany(f: CampaignForce): UnitInput | null {
  let best: UnitInput | null = null;
  for (const c of f.battalion.subunits) if (c.echelon === "company" && menIn(c) > 0 && (best === null || menIn(c) > menIn(best))) best = c;
  return best;
}

/** The support units of a battalion by kind (its sub-units made from the manifest's support templates). */
function supportOf(data: DataSet, f: CampaignForce): { kind: "mortarSections" | "aglTeams" | "missileTeams" | "tankSections"; unit: UnitInput }[] {
  const m = data.factions[f.faction]!.manifest;
  const kinds: [string | undefined, "mortarSections" | "aglTeams" | "missileTeams" | "tankSections"][] = [
    [m.mortarTemplate, "mortarSections"], [m.aglTeamTemplate, "aglTeams"], [m.missileTeamTemplate, "missileTeams"], [m.tankSectionTemplate, "tankSections"],
  ];
  const out: { kind: "mortarSections" | "aglTeams" | "missileTeams" | "tankSections"; unit: UnitInput }[] = [];
  for (const u of f.battalion.subunits) {
    const t = f.establishment[u.key];
    const k = kinds.find(([id]) => id !== undefined && id === t);
    if (k) out.push({ kind: k[1], unit: u });
  }
  return out;
}

/** The units and hulls a side commits to a battle (see the file comment). Empty units: none to commit. */
export function proposeCommit(data: DataSet, f: CampaignForce): ScenarioForces {
  const cap = campaignRules(data).battle;
  const units: UnitInput[] = [];
  const company = fittestCompany(f);
  if (company) {
    const plats = company.subunits.filter((s) => s.echelon === "platoon" && menIn(s) > 0).slice(0, cap.platoons);
    if (cap.companyHq) {
      const hq: UnitInput = { ...company, subunits: company.subunits.filter((s) => s.echelon !== "platoon") };
      if (menIn(hq) > 0) units.push(hq);
    }
    units.push(...plats);
    const left = { mortarSections: cap.mortarSections, aglTeams: cap.aglTeams, missileTeams: cap.missileTeams, tankSections: cap.tankSections };
    for (const s of supportOf(data, f)) if (left[s.kind] > 0 && menIn(s.unit) > 0) { left[s.kind]--; units.push(s.unit); }
  }
  return withHulls(clone(units), f.vehicles);
}

/** Committed units with the hulls in service they crew: crews without a hull in service left out, carriers that are
 *  not there taken off their squads. */
function withHulls(units: UnitInput[], inService: readonly VehicleRecord[]): ScenarioForces {
  const have = new Set(inService.map((v) => v.vehicleId));
  const crewed = new Set<string>();
  const strip = (u: UnitInput): UnitInput | null => {
    if (u.vehicleId !== undefined && !have.has(u.vehicleId)) return null;
    const subunits = u.subunits.map(strip).filter((x): x is UnitInput => x !== null);
    if (u.members.length === 0 && subunits.length === 0) return null;
    if (u.vehicleId !== undefined && u.members.length > 0) crewed.add(u.vehicleId);
    return { ...u, subunits };
  };
  const kept = units.map(strip).filter((x): x is UnitInput => x !== null);
  const fix = (u: UnitInput): UnitInput => {
    const { carrierId, vehicleId, arriveS: _a, ...rest } = u;
    void _a;
    return {
      ...rest, subunits: u.subunits.map(fix),
      ...(vehicleId !== undefined && crewed.has(vehicleId) ? { vehicleId } : {}),
      ...(carrierId !== undefined && crewed.has(carrierId) ? { carrierId } : {}),
    };
  };
  const out = kept.map(fix);
  return { units: out, vehicles: clone(inService.filter((v) => crewed.has(v.vehicleId))) };
}
