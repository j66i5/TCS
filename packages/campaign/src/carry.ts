/**
 * BETWEEN TWO BATTLES ON ONE SECTOR (M12.0a): what a battle's result hands the next battle on the same map.
 *
 * - `fieldForce`: a side's force as it comes out (`forcesOut`) cut to what can fight the next battle: the men who are
 *   "fit" or "wounded" (walking wounded stay with their unit); not the dead, the evacuated (in the rear), the
 *   prisoners or the missing. Its hulls that are still in service (status "ok" or "disarmed", neither captured nor
 *   towed nor lost; the end settlement's mark on a hull that came through is cleared); a crew whose hull is gone goes
 *   on foot; the off-map assets of the battle (ambulances, recovery, military police) are left out (the next battle
 *   gets its own from the manifest). Records go in as they came out: condition, wounds, loads to the round, fitted
 *   batteries, belts, fuel and components unchanged. A unit whose leader is gone has none until the campaign rules
 *   appoint one (M12.1a); empty units are dropped.
 * - `sectorTerrain`: the map's damage at the end (`damageOut`, the earlier battles' included) and every wreck on it.
 */
import type { BattleResult, ForceInput, SoldierRecord, UnitInput, VehicleRecord } from "@tcs/sim";
import type { ScenarioForces, ScenarioTerrain } from "@tcs/scenario";

/** Roster statuses that take part in the next battle. */
const FIELDED: ReadonlySet<SoldierRecord["status"]> = new Set(["fit", "wounded"]);

/** Is this hull fit to fight the next battle (in service, not lost, captured, towed away or awaiting repair)? */
export function hullInService(v: VehicleRecord): boolean {
  const st = v.status ?? "ok";
  if (st !== "ok" && st !== "disarmed") return false;
  if (v.capturedBy !== undefined && v.capturedBy !== null) return false;
  return v.recovery === undefined || v.recovery === null || v.recovery.state === "recovered";
}

/** A side's force for the next battle on this sector (see the file comment). `input`: the force as it went in. */
export function fieldForce(out: BattleResult["forcesOut"][number], input: ForceInput): ScenarioForces {
  const offMap = new Set((input.offMap ?? []).map((a) => a.vehicleId));
  const vehicles = (out.vehicles ?? []).filter((v) => !offMap.has(v.vehicleId) && hullInService(v)).map((v) => {
    const { recovery: _r, ...rest } = v;
    void _r;
    return JSON.parse(JSON.stringify(rest)) as VehicleRecord;
  });
  const keep = new Set(vehicles.map((v) => v.vehicleId));
  const unit = (u: UnitInput): UnitInput | null => {
    if (u.vehicleId !== undefined && offMap.has(u.vehicleId)) return null;
    const leader = u.leaderIndex >= 0 ? u.members[u.leaderIndex] : undefined;
    const members = u.members.filter((m) => FIELDED.has(m.status)).map((m) => JSON.parse(JSON.stringify(m)) as SoldierRecord);
    const subunits = u.subunits.map(unit).filter((x): x is UnitInput => x !== null);
    if (members.length === 0 && subunits.length === 0) return null;
    const li = leader ? members.findIndex((m) => m.personId === leader.personId) : -1;
    const { vehicleId, carrierId, arriveS: _a, ...rest } = u;
    void _a;
    return {
      ...rest, leaderIndex: li, members, subunits,
      ...(vehicleId !== undefined && keep.has(vehicleId) ? { vehicleId } : {}),
      ...(carrierId !== undefined && keep.has(carrierId) ? { carrierId } : {}),
    };
  };
  const units = out.units.map(unit).filter((x): x is UnitInput => x !== null);
  // (A hull whose crew is all gone stays out: nobody to drive it.)
  const crewed = new Set<string>();
  const walk = (u: UnitInput) => { if (u.vehicleId !== undefined && u.members.length > 0) crewed.add(u.vehicleId); u.subunits.forEach(walk); };
  units.forEach(walk);
  const strip = (u: UnitInput): UnitInput => {
    const { vehicleId, carrierId, ...rest } = u;
    return { ...rest, ...(vehicleId !== undefined && crewed.has(vehicleId) ? { vehicleId } : {}), ...(carrierId !== undefined && crewed.has(carrierId) ? { carrierId } : {}), subunits: u.subunits.map(strip) };
  };
  return { units: units.map(strip), vehicles: vehicles.filter((v) => crewed.has(v.vehicleId)) };
}

/** Men in a force (every unit, every level). */
export function menOf(units: readonly UnitInput[]): number {
  const n = (u: UnitInput): number => u.members.length + u.subunits.reduce((k, c) => k + n(c), 0);
  return units.reduce((k, u) => k + n(u), 0);
}

/** The sector as a battle leaves it: its damage (earlier battles' included) and every wreck on it. */
export function sectorTerrain(result: BattleResult): ScenarioTerrain {
  return {
    ...(result.damageOut ? { damage: JSON.parse(JSON.stringify(result.damageOut)) as NonNullable<ScenarioTerrain["damage"]> } : {}),
    ...(result.wrecks && result.wrecks.length > 0 ? { wrecks: result.wrecks.map((w) => ({ ...w })) } : {}),
  };
}
