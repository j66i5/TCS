/**
 * THE RULES BETWEEN BATTLES (M12.1a, plan m12-roster 4.3; owner answers 2026-11-19). Pure functions of the record:
 * each returns a new record and leaves its argument alone.
 *
 * `applyResult` (after every battle, both sides alike):
 *   - the committed units' records come back into the battalion by unit key (men by personId, hulls by vehicleId);
 *   - men: "fit" and "wounded" (walking wounded) stay with their units; "evacuated" (and "incapacitated") to the
 *     recovering pool with their recovery days (`recovery.defaultDays` when the battle settled none); "killed" to the
 *     dead, "missing" to the missing, "captured" / "surrendered" to the men held by the enemy (and the enemy's
 *     prisoners list). The dead, missing and captured take their loads with them (written off in the books);
 *   - hulls: in service ("ok", "disarmed", out by an exit) stay; recovered or towed to the workshop for their repair
 *     days (`repair.defaultDays` when none were settled); destroyed or captured are lost (written off);
 *   - experience from `BattleResult.service`: `perBattle` plus `perMinuteUnderFire`, at most `capPerBattle`, never above
 *     `cap`; every man's service entry (minutes under fire, wounds, peak shock and strain, strain after) appended;
 *   - the clock runs (the battle and `hoursBetweenBattles`): fatigue, shock and strain recover, water is drunk; a walking
 *     wounded man's days run down (healed: fit, wounds gone); recovering men whose days are up rejoin their old unit if
 *     there is room, else they wait unassigned (owner Q-A (a): inside an operation too); workshop hulls whose days are
 *     up are back in service, repaired;
 *   - automatic leaders where one is gone (leaders.ts);
 *   - NO replacements and NO refill: units keep the ammunition, fuel and loads they came out with.
 *   The consumption log gets per side what the committed records held going in minus coming out (`net`), the rounds
 *   the events say were fired (`fired`), and what left with men and hulls (`writtenOff`).
 *
 * `replenish` (between operations; in endless mode every `replenishEvery` battles): `daysBetweenOperations` pass; men
 * without a place fill empty places of their own role; green replacements (the `replacements.quality` level, new
 * person ids) fill every other empty place; every man's load, every hull's stowage, fuel and ready belts back to the
 * standard load of the data (the difference logged as delivered); hulls in service repaired; lost hulls replaced
 * (`repair.replaceLost`, new vehicle ids). The operation counter moves on.
 */
import type { DataSet } from "@tcs/data";
import {
  clamp, newVehicleRecord, nextFloat, nextNormal, pick, type BattleInput, type BattleResult, type Catalog, type SoldierRecord, type UnitInput, type VehicleRecord,
} from "@tcs/sim";
import { addHoldings, addHull, addMan, addUnits, emptyHoldings } from "./holdings";
import { appointLeaders } from "./leaders";
import {
  campaignCatalog, clone, unitsOf, type BattleSummary, type CampaignForce, type CampaignLogEntry, type CampaignRecord, type CampaignSide, type Holdings, type PoolMan,
} from "./record";
import { campaignRules, type CampaignRules } from "./rules";

/** A battle as the campaign fought it. */
export interface CampaignBattle {
  input: BattleInput;
  result: BattleResult;
  /** The player's side in the battle. */
  playerSide: "blue" | "red";
  kind: string;
  mapKind: string;
  mapSeed: number;
  attacker: CampaignSide;
  /** M12.2: the node type and sector; `flank`: a flank battle fought at the same time as the node's main battle (it is
   *  applied first, without the clock and without appointing leaders: the main battle's application does both for the
   *  two, and only the main battle counts as a battle of the operation). */
  node?: string;
  sector?: number;
  flank?: boolean;
}

const STAY: ReadonlySet<SoldierRecord["status"]> = new Set(["fit", "wounded"]);

function findUnit(root: UnitInput, key: string): UnitInput | null {
  if (root.key === key) return root;
  for (const s of root.subunits) { const x = findUnit(s, key); if (x) return x; }
  return null;
}

/** The unit's places (its template's member slots). */
function slotsOf(data: DataSet, f: CampaignForce, key: string) {
  return data.factions[f.faction]?.units[f.establishment[key] ?? ""]?.members ?? [];
}

function hasRoom(data: DataSet, f: CampaignForce, u: UnitInput): boolean {
  return u.members.length < slotsOf(data, f, u.key).length;
}

/** Days of the clock. */
const dayOf = (hours: number) => hours / 24;

export function applyResult(data: DataSet, record0: CampaignRecord, battle: CampaignBattle): CampaignRecord {
  const rules = campaignRules(data);
  const record = clone(record0);
  const catalog = campaignCatalog(data, record);
  const index = record.battles;
  const sideOf: Record<CampaignSide, "blue" | "red"> = { player: battle.playerSide, enemy: battle.playerSide === "blue" ? "red" : "blue" };
  const men: BattleSummary["men"] = { player: { in: 0, able: 0, killed: 0, evacuated: 0, captured: 0, missing: 0 }, enemy: { in: 0, able: 0, killed: 0, evacuated: 0, captured: 0, missing: 0 } };
  const hulls: BattleSummary["hulls"] = { player: { in: 0, service: 0, workshop: 0, lost: 0 }, enemy: { in: 0, service: 0, workshop: 0, lost: 0 } };
  const captives: Record<CampaignSide, PoolMan[]> = { player: [], enemy: [] };
  const lost: Record<CampaignSide, Map<string, string>> = { player: new Map(), enemy: new Map() };
  for (const side of ["player", "enemy"] as const) {
    const f = record.sides[side];
    const inF = battle.input.forces.find((x) => x.side === sideOf[side]);
    const outF = battle.result.forcesOut.find((x) => x.side === sideOf[side]);
    if (!inF || !outF) continue;
    // The committed units are those of the battalion (the battle's own assets, ambulances and the like, are not).
    const inUnits = inF.units.filter((u) => findUnit(f.battalion, u.key) !== null);
    const outUnits = outF.units.filter((u) => findUnit(f.battalion, u.key) !== null);
    const offMap = new Set((inF.offMap ?? []).map((a) => a.vehicleId));
    const own = new Set(f.vehicles.map((v) => v.vehicleId));
    const inHulls = (inF.vehicles ?? []).filter((v) => !offMap.has(v.vehicleId) && own.has(v.vehicleId));
    const outHulls = (outF.vehicles ?? []).filter((v) => !offMap.has(v.vehicleId) && own.has(v.vehicleId));
    const net = emptyHoldings(), writtenOff = emptyHoldings();
    addUnits(catalog, net, inUnits);
    for (const v of inHulls) addHull(catalog, net, v);
    addUnits(catalog, net, outUnits, -1);
    for (const v of outHulls) addHull(catalog, net, v, -1);
    // Who led each committed unit going in.
    const leaderIn = new Map<string, string>();
    for (const u of inUnits) for (const x of unitsOf(u)) { const l = x.leaderIndex >= 0 ? x.members[x.leaderIndex] : undefined; if (l) leaderIn.set(x.key, l.personId); }
    const wentIn = new Map<string, Set<string>>();
    for (const u of inUnits) for (const x of unitsOf(u)) wentIn.set(x.key, new Set(x.members.map((m) => m.personId)));
    // Men back into the battalion, by unit key.
    const merge = (o: UnitInput) => {
      const t = findUnit(f.battalion, o.key);
      if (!t) return;
      const was = leaderIn.get(o.key);
      const stay: SoldierRecord[] = [];
      for (const m of o.members) {
        men[side].in++;
        const r = clone(m);
        if (STAY.has(r.status)) { walkingWounded(rules, r); stay.push(r); men[side].able++; continue; }
        const p: PoolMan = { record: r, unitKey: o.key, battle: index };
        if (r.status === "evacuated" || r.status === "incapacitated") { p.days = r.recoveryDays ?? rules.recovery.defaultDays; f.pools.recovering.push(p); men[side].evacuated++; }
        else if (r.status === "killed") { f.pools.dead.push(p); addMan(catalog, writtenOff, r); men[side].killed++; }
        else if (r.status === "missing") { f.pools.missing.push(p); addMan(catalog, writtenOff, r); men[side].missing++; }
        else { f.pools.heldByEnemy.push(p); captives[side].push(p); addMan(catalog, writtenOff, r); men[side].captured++; }
      }
      // Balance pass 6 (half platoons): men of the unit who did not go into the battle stay where they are (a
      // platoon's second half goes without its headquarters). Everyone went (every battle before pass 6): as before.
      const went = wentIn.get(o.key);
      const home = t.members.filter((m) => went === undefined || !went.has(m.personId));
      if (home.length === 0) {
        t.members = stay;
        t.leaderIndex = was !== undefined ? stay.findIndex((m) => m.personId === was) : t.leaderIndex >= 0 && t.leaderIndex < stay.length ? t.leaderIndex : -1;
      } else {
        const leader = was ?? (t.leaderIndex >= 0 ? t.members[t.leaderIndex]?.personId : undefined);
        t.members = [...home, ...stay];
        t.leaderIndex = leader !== undefined ? t.members.findIndex((m) => m.personId === leader) : -1;
      }
      if (was !== undefined && t.leaderIndex < 0) lost[side].set(o.key, was);
      o.subunits.forEach(merge);
    };
    outUnits.forEach(merge);
    // Hulls.
    const byId = new Map(outHulls.map((v) => [v.vehicleId, v]));
    hulls[side].in = inHulls.length;
    const keep: VehicleRecord[] = [];
    for (const v of f.vehicles) {
      const o = byId.get(v.vehicleId);
      if (!o) { keep.push(v); continue; }
      const r = clone(o);
      const rec = r.recovery ?? null, st = r.status ?? "ok";
      delete r.recovery;
      if ((r.capturedBy !== undefined && r.capturedBy !== null) || rec?.state === "captured") {
        f.lostHulls.push({ vehicleId: r.vehicleId, type: r.type, battle: index, how: "captured" }); addHull(catalog, writtenOff, r); hulls[side].lost++;
      } else if (st === "destroyed" || rec?.state === "lost") {
        f.lostHulls.push({ vehicleId: r.vehicleId, type: r.type, battle: index, how: "destroyed" }); addHull(catalog, writtenOff, r); hulls[side].lost++;
      } else if (rec !== null || (st !== "ok" && st !== "disarmed")) {
        f.workshop.push({ record: r, days: rec?.repairDays ?? rules.repair.defaultDays, battle: index }); hulls[side].workshop++;
      } else { keep.push(r); hulls[side].service++; }
    }
    f.vehicles = keep;
    // Experience and the service history (every man who took part, wherever he is now).
    const service = battle.result.service ?? {};
    const all: SoldierRecord[] = [...unitsOf(f.battalion).flatMap((u) => u.members), ...f.pools.recovering.map((p) => p.record), ...f.pools.dead.map((p) => p.record),
      ...f.pools.missing.map((p) => p.record), ...f.pools.heldByEnemy.map((p) => p.record)];
    for (const m of all) {
      const s = service[m.personId];
      if (!s) continue;
      // (Experience only for men still with the battalion or recovering: the dead, missing and captured gain none.)
      const xp = STAY.has(m.status) || m.status === "evacuated" || m.status === "incapacitated" ? gainXp(rules, m, s.underFireS) : 0;
      (f.service[m.personId] ??= []).push({
        battle: index, underFireMin: s.underFireS / 60, contactMin: s.contactS / 60, rounds: s.roundsFired, wounds: s.wounds,
        peakShock: s.peakShock, peakStrain: s.peakStrain, strainAfter: m.strain ?? 0, xp, status: m.status,
      });
    }
    const fired = battle.result.logistics?.find((l) => l.side === sideOf[side])?.consumed ?? {};
    record.consumption.push({ battle: index, side, kind: "battle", fired: { ...fired }, net, writtenOff });
  }
  // Prisoners: each side's list of the other's men it holds.
  for (const side of ["player", "enemy"] as const) {
    const other = side === "player" ? "enemy" : "player";
    for (const p of captives[other]) record.sides[side].pools.prisoners.push({ personId: p.record.personId, given: p.record.given, family: p.record.family, rank: p.record.rank, battle: index });
  }
  // The clock: the battle and the hours to the next (a flank battle: the main battle's application runs it).
  const hours = battle.result.durationSeconds / 3600 + rules.clock.hoursBetweenBattles;
  if (!battle.flank) record.hours += hours;
  for (const side of ["player", "enemy"] as const) {
    // A flank battle appoints no leaders: a leader moved up from a sub-unit now could be a man of the main battle,
    // whose records come back by unit key afterwards (he would be in two units); the main battle's application
    // appoints them for both.
    if (battle.flank) continue;
    record.log.push(...passTime(data, rules, record.sides[side], hours, rules.recovery.rejoinWithinOperation, index, side));
    record.log.push(...appointLeaders(data, record.sides[side], index, side, lost[side]));
  }
  const w = battle.result.winner;
  record.history.push({
    index, operation: record.operation.index, kind: battle.kind, mapKind: battle.mapKind, mapSeed: battle.mapSeed, seed: battle.input.seed,
    ...(battle.node !== undefined ? { node: battle.node } : {}), ...(battle.sector !== undefined ? { sector: battle.sector } : {}), ...(battle.flank ? { flank: true } : {}),
    playerSide: battle.playerSide, attacker: battle.attacker, winner: w === null ? null : w === sideOf.player ? "player" : "enemy",
    endReason: battle.result.endReason, durationS: battle.result.durationSeconds, men, hulls,
  });
  record.battles++;
  if (!battle.flank) record.operation.battles++;
  return record;
}

/** M12.2: the clock runs `hours` without a battle (a node won without one): men rest, the recovering heal and rejoin,
 *  the workshop repairs, leaders are appointed where one is missing. */
export function passHours(data: DataSet, record0: CampaignRecord, hours: number): CampaignRecord {
  const rules = campaignRules(data);
  const record = clone(record0);
  record.hours += hours;
  for (const side of ["player", "enemy"] as const) {
    record.log.push(...passTime(data, rules, record.sides[side], hours, rules.recovery.rejoinWithinOperation, record.battles, side));
    record.log.push(...appointLeaders(data, record.sides[side], record.battles, side));
  }
  return record;
}

/** Experience from a battle (see the file comment); changes the record, returns what was gained. */
export function gainXp(rules: CampaignRules, m: SoldierRecord, underFireS: number): number {
  const E = rules.experience;
  const old = m.skills["experience"] ?? 0;
  if (old >= E.cap) return 0;
  const gain = Math.min(E.capPerBattle, E.perBattle + (E.perMinuteUnderFire * underFireS) / 60);
  const now = Math.min(E.cap, old + gain);
  m.skills["experience"] = now;
  return now - old;
}

/** Recovery of a man's condition over `hours`; a walking wounded man's days run down and he heals. */
function rest(rules: CampaignRules, m: SoldierRecord, hours: number): void {
  const R = rules.recovery;
  m.fatigue = Math.max(0, m.fatigue - R.fatiguePerHour * hours);
  m.stress = Math.max(0, m.stress - R.shockPerHour * hours);
  if (m.strain !== undefined) { m.strain = Math.max(0, m.strain - R.strainPerHour * hours); if (m.strain === 0) delete m.strain; }
  delete m.hydration;
  if (m.recoveryDays !== undefined) {
    m.recoveryDays = Math.max(0, m.recoveryDays - dayOf(hours));
    if (m.recoveryDays <= 0) heal(m);
  }
}

/**
 * Review M12: a man who comes out "wounded" without recovery days (bruises under body armour only, which the battle's
 * medical settlement skips; or wounded and out by an exit zone, never handed to care) would never heal (`rest` counts
 * days down). Bruises only: healed now (fit). Other wounds: `recovery.walkingWoundedDays` (he stays with his unit and
 * heals when they are up, as a walking wounded man the battle gave days to).
 */
function walkingWounded(rules: CampaignRules, m: SoldierRecord): void {
  if (m.status !== "wounded" || m.recoveryDays !== undefined) return;
  if (m.wounds.every((w) => w.mechanism === "blunt")) { heal(m); return; }
  m.recoveryDays = rules.recovery.walkingWoundedDays ?? 3;
}

function heal(m: SoldierRecord): void {
  m.wounds = [];
  delete m.physiology;
  delete m.recoveryDays;
  m.status = "fit";
}

/** Time passes for a force: men rest, the recovering heal (and rejoin when `rejoin`), the workshop repairs. */
function passTime(data: DataSet, rules: CampaignRules, f: CampaignForce, hours: number, rejoin: boolean, battle: number, side: CampaignSide): CampaignLogEntry[] {
  const log: CampaignLogEntry[] = [];
  for (const u of unitsOf(f.battalion)) for (const m of u.members) rest(rules, m, hours);
  for (const p of [...f.pools.unassigned, ...f.pools.replacements]) rest(rules, p.record, hours);
  const still: PoolMan[] = [];
  for (const p of f.pools.recovering) {
    p.days = Math.max(0, (p.days ?? 0) - dayOf(hours));
    const r = p.record;
    r.fatigue = Math.max(0, r.fatigue - rules.recovery.fatiguePerHour * hours);
    r.stress = Math.max(0, r.stress - rules.recovery.shockPerHour * hours);
    if (p.days > 0 || !rejoin) { still.push(p); continue; }
    delete r.hydration;
    heal(r);
    const u = findUnit(f.battalion, p.unitKey);
    if (u && hasRoom(data, f, u)) { u.members.push(r); log.push({ battle, side, kind: "rejoin", unitKey: u.key, personId: r.personId }); }
    else { const { days: _d, ...rest_ } = p; void _d; f.pools.unassigned.push(rest_); log.push({ battle, side, kind: "unassigned", unitKey: p.unitKey, personId: r.personId }); }
  }
  f.pools.recovering = still;
  const shop: typeof f.workshop = [];
  for (const w of f.workshop) {
    w.days = Math.max(0, w.days - dayOf(hours));
    if (w.days > 0) { shop.push(w); continue; }
    const r = w.record;
    delete r.components;
    r.status = "ok";
    f.vehicles.push(r);
    log.push({ battle, side, kind: "hull-repaired", vehicleId: r.vehicleId });
  }
  f.workshop = shop;
  f.vehicles.sort((a, b) => (a.vehicleId < b.vehicleId ? -1 : a.vehicleId > b.vehicleId ? 1 : 0));
  return log;
}

/** Places of a unit no man fills: its template's slots, matched to its men by role; at most as many as it lacks. */
function vacancies(data: DataSet, f: CampaignForce, u: UnitInput) {
  const slots = slotsOf(data, f, u.key);
  const free = slots.map((s, i) => ({ s, i })), used = new Set<number>();
  for (const m of u.members) { const k = free.find((x) => !used.has(x.i) && x.s.role === m.role); if (k) used.add(k.i); }
  return free.filter((x) => !used.has(x.i)).slice(0, Math.max(0, slots.length - u.members.length)).map((x) => x.s);
}

/** The standard load of a man: his role's slot in his unit's template, else the first slot of his role in any template
 *  of his faction (template ids in order); null: none (his load stays). */
export function standardSlot(data: DataSet, f: CampaignForce, unitKey: string, role: string) {
  const own = slotsOf(data, f, unitKey).find((s) => s.role === role);
  if (own) return own;
  const units = data.factions[f.faction]!.units;
  for (const id of Object.keys(units).sort()) { const s = units[id]!.members.find((x) => x.role === role); if (s) return s; }
  return null;
}

export const loadOf = (slot: { load: readonly { item: string; count: number; charge?: number | undefined }[] }) =>
  slot.load.map((l) => (l.charge === undefined ? { type: l.item, count: l.count } : { type: l.item, count: l.count, charge: l.charge }));

/** A green replacement for a slot (new person id; names and skills from the campaign's dice). */
function replacement(data: DataSet, record: CampaignRecord, f: CampaignForce, slot: ReturnType<typeof slotsOf>[number]): SoldierRecord {
  const pack = data.factions[f.faction]!;
  const q = data.qualities[campaignRules(data).replacements.quality] ?? data.qualities[pack.manifest.defaultQuality]!;
  const rng = record.rng, stream = (k: string) => `campaign/${f.keyPrefix}/${k}`;
  const female = nextFloat(rng, stream("names")) < pack.names.femaleShare;
  const given = pick(rng, stream("names"), female && pack.names.givenFemale.length > 0 ? pack.names.givenFemale : pack.names.given);
  const family = pick(rng, stream("names"), pack.names.family) + (female ? pack.names.familyFemaleSuffix : "");
  const skills: Record<string, number> = {};
  for (const [k, d] of Object.entries(q.skills).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) skills[k] = clamp(d.mean + d.sd * nextNormal(rng, stream("skills")), 0, 1);
  return {
    personId: `${f.keyPrefix}#${f.nextPersonId++}`, given, family, rank: slot.rank, role: slot.role,
    ...(slot.weapon === undefined ? {} : { weapon: slot.weapon }),
    skills, fatigue: 0, stress: 0, wounds: [], load: loadOf(slot), status: "fit",
  };
}

/** Replenishment (see the file comment). */
export function replenish(data: DataSet, record0: CampaignRecord): CampaignRecord {
  const rules = campaignRules(data);
  const record = clone(record0);
  const catalog = campaignCatalog(data, record);
  const battle = record.battles;
  const hours = rules.clock.daysBetweenOperations * 24;
  record.hours += hours;
  for (const side of ["player", "enemy"] as const) {
    const f = record.sides[side];
    const log: CampaignLogEntry[] = passTime(data, rules, f, hours, true, battle, side);
    const delivered = emptyHoldings();
    // Men without a place fill empty places of their role; green replacements the rest.
    let fresh = 0;
    for (const u of unitsOf(f.battalion)) {
      for (const slot of vacancies(data, f, u)) {
        const k = f.pools.unassigned.findIndex((p) => p.record.role === slot.role);
        if (k >= 0) {
          const p = f.pools.unassigned.splice(k, 1)[0]!;
          u.members.push(p.record);
          log.push({ battle, side, kind: "rejoin", unitKey: u.key, personId: p.record.personId });
          continue;
        }
        const m = replacement(data, record, f, slot);
        addMan(catalog, delivered, m);
        u.members.push(m);
        fresh++;
        log.push({ battle, side, kind: "replacement", unitKey: u.key, personId: m.personId });
      }
    }
    // (Review M12: anyone still wounded with days up or none set is healed; the 7 days have passed.)
    for (const u of unitsOf(f.battalion)) for (const m of u.members) if (m.status === "wounded" && (m.recoveryDays ?? 0) <= 0) heal(m);
    // Loads to the standard (delivered: after minus before).
    for (const u of unitsOf(f.battalion)) for (const m of u.members) {
      const slot = standardSlot(data, f, u.key, m.role);
      if (!slot) continue;
      addMan(catalog, delivered, m, -1);
      m.load = loadOf(slot);
      delete m.powerFitted;
      addMan(catalog, delivered, m);
    }
    // Hulls: repaired and refilled; the lost ones replaced.
    for (const v of f.vehicles) {
      addHull(catalog, delivered, v, -1);
      const fresh_ = newVehicleRecord(catalog, v.type, v.vehicleId);
      v.load = fresh_.load;
      delete v.ready; delete v.components; delete v.capturedBy; delete v.recovery;
      v.status = "ok";
      addHull(catalog, delivered, v);
    }
    // (Review M12: hulls still in the workshop are refilled too, their repair goes on: they come back with the standard
    // load, not what they held when hit, owner 2026-11-19 "refilled to the standard load at replenishment".)
    for (const w of f.workshop) {
      const v = w.record;
      addHull(catalog, delivered, v, -1);
      v.load = newVehicleRecord(catalog, v.type, v.vehicleId).load;
      delete v.ready;
      addHull(catalog, delivered, v);
    }
    if (rules.repair.replaceLost) {
      for (const l of f.lostHulls) {
        const crew = unitsOf(f.battalion).find((u) => u.vehicleId === l.vehicleId);
        const id = `${(crew?.key ?? l.vehicleId).split("~")[0]}~${f.nextHullSerial++}`;
        const v = newVehicleRecord(catalog, l.type, id);
        for (const u of unitsOf(f.battalion)) { if (u.vehicleId === l.vehicleId) u.vehicleId = id; if (u.carrierId === l.vehicleId) u.carrierId = id; }
        f.vehicles.push(v);
        addHull(catalog, delivered, v);
        log.push({ battle, side, kind: "hull-replaced", vehicleId: id, ...(crew ? { unitKey: crew.key } : {}) });
      }
      f.lostHulls = [];
      f.vehicles.sort((a, b) => (a.vehicleId < b.vehicleId ? -1 : a.vehicleId > b.vehicleId ? 1 : 0));
    }
    log.push(...appointLeaders(data, f, battle, side));
    log.push({ battle, side, kind: "replenishment", count: fresh });
    record.log.push(...log);
    record.consumption.push({ battle, side, kind: "replenishment", delivered });
  }
  record.operation = { index: record.operation.index + 1, battles: 0 };
  return record;
}

/** Holdings of a consumption log, summed: delivered minus net minus written off (start + this = now). */
export function bookedChange(record: CampaignRecord, side: CampaignSide): Holdings {
  const h = emptyHoldings();
  for (const c of record.consumption) {
    if (c.side !== side) continue;
    if (c.delivered) addHoldings(h, c.delivered);
    if (c.net) addHoldings(h, c.net, -1);
    if (c.writtenOff) addHoldings(h, c.writtenOff, -1);
  }
  return h;
}

export type { Catalog };
