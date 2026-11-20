/**
 * WHAT THE ROSTER SCREENS SHOW (M12.3, plan m12-roster 4.6): pure read-only views of the campaign record, so the
 * phone screens (ui) only lay them out and every number on them is testable in Node. Nothing here changes the record.
 *
 * - `battalionView`: the tree of companies, platoons and squads with strength (places, men, able, walking wounded,
 *   recovering, lost), the ammunition state (share of the standard load) and the hulls (in service, workshop, lost).
 * - `manView`: one man wherever he is (in a unit or a pool): skills with experience, condition, wounds and recovery
 *   days, his service history with its stress peaks, his squad, whether he leads it and may be made its leader.
 * - `briefingView`: the node about to be fought (sector, kind, who attacks, the enemy's estimated strength, the
 *   proposed choice and the cap, the operation's progress).
 * - `afterBattleView`: what the last node changed (killed, wounded with days, captured, experience gained, new
 *   leaders, ammunition fired, hulls lost or in the workshop, the enemy's losses, the operation's progress).
 * - `replenishmentView`: what the last replenishment brought (men back, replacements, hulls repaired and replaced,
 *   rounds delivered).
 * Everything is found by the battle index the record already keeps on pools, logs and service entries, so a view
 * built from a loaded save is the same as one built right after the battle.
 */
import type { DataSet } from "@tcs/data";
import { newVehicleRecord, type SoldierRecord, type UnitInput, type VehicleRecord } from "@tcs/sim";
import { loadOf, standardSlot } from "./between";
import { menOf } from "./carry";
import { commitOf, commitProblems, proposeChoice, selectables, type CommitProblem, type Selectable } from "./commit";
import { enemyFor } from "./flow";
import { canLead } from "./leaders";
import { addHull, addMan, emptyHoldings } from "./holdings";
import { ableShare, operationRules, sectorOf } from "./operation";
import { campaignCatalog, unitsOf, type CampaignForce, type CampaignLogEntry, type CampaignRecord, type CampaignSide, type Holdings, type OperationStep, type PoolMan, type ServiceEntry } from "./record";
import { campaignRules } from "./rules";

// ------------------------------------------------------------------------------------------------ the battalion

export interface HullView { vehicleId: string; type: string; nameKey: string; state: "service" | "workshop" | "lost"; status?: string; days?: number }

export interface UnitView {
  key: string;
  callsign: string;
  echelon: string;
  depth: number;
  /** Its template's places (with its sub-units'), men present, able (fit), walking wounded, recovering (in the pool),
   *  lost for good (dead, missing, held by the enemy: men who served in it). */
  places: number; men: number; able: number; wounded: number; recovering: number; lost: number;
  /** Its leader's personId (null: none). */
  leader: string | null;
  /** Ammunition held against the standard load (0..1, mean over the ammunition kinds it carries; null: none). */
  ammo: number | null;
  /** Hulls its crews (its own and its sub-units') man. */
  hulls: HullView[];
  children: UnitView[];
}

const under = (key: string, unitKey: string) => unitKey === key || unitKey.startsWith(`${key}/`);

function nameKeyOf(data: DataSet, faction: string, type: string): string {
  for (const f of [faction, ...Object.keys(data.factions).sort()]) { const v = data.factions[f]?.vehicles[type]; if (v) return v.nameKey; }
  return type;
}

/** Ammunition share of men's loads and hulls against their standard loads (see `UnitView.ammo`). */
function ammoShare(data: DataSet, record: CampaignRecord, f: CampaignForce, men: { m: SoldierRecord; unitKey: string }[], hulls: readonly VehicleRecord[]): number | null {
  const catalog = campaignCatalog(data, record);
  const have = emptyHoldings(), want = emptyHoldings();
  for (const { m, unitKey } of men) {
    addMan(catalog, have, m);
    const slot = standardSlot(data, f, unitKey, m.role);
    if (slot) addMan(catalog, want, { ...m, load: loadOf(slot) });
  }
  for (const v of hulls) { addHull(catalog, have, v); addHull(catalog, want, newVehicleRecord(catalog, v.type, v.vehicleId)); }
  let sum = 0, n = 0;
  for (const [id, w] of Object.entries(want.ammo)) { if (w <= 0) continue; sum += Math.min(1, Math.max(0, (have.ammo[id] ?? 0) / w)); n++; }
  return n === 0 ? null : sum / n;
}

function placesOf(data: DataSet, f: CampaignForce, u: UnitInput): number {
  return data.factions[f.faction]?.units[f.establishment[u.key] ?? ""]?.members.length ?? u.members.length;
}

/** The battalion as a tree (see the file comment). */
export function battalionView(data: DataSet, record: CampaignRecord, side: CampaignSide = "player"): UnitView {
  const f = record.sides[side];
  const service = new Map(f.vehicles.map((v) => [v.vehicleId, v]));
  const shop = new Map(f.workshop.map((w) => [w.record.vehicleId, w]));
  const lostIds = new Map(f.lostHulls.map((l) => [l.vehicleId, l]));
  const gone = [...f.pools.dead, ...f.pools.missing, ...f.pools.heldByEnemy];
  const walk = (u: UnitInput, depth: number): UnitView => {
    const children = u.subunits.map((s) => walk(s, depth + 1));
    const own: HullView[] = [];
    if (u.vehicleId !== undefined) {
      const v = service.get(u.vehicleId), w = shop.get(u.vehicleId), l = lostIds.get(u.vehicleId);
      if (v) own.push({ vehicleId: v.vehicleId, type: v.type, nameKey: nameKeyOf(data, f.faction, v.type), state: "service", status: v.status ?? "ok" });
      else if (w) own.push({ vehicleId: w.record.vehicleId, type: w.record.type, nameKey: nameKeyOf(data, f.faction, w.record.type), state: "workshop", days: w.days });
      else if (l) own.push({ vehicleId: l.vehicleId, type: l.type, nameKey: nameKeyOf(data, f.faction, l.type), state: "lost", status: l.how });
    }
    const men = unitsOf(u).flatMap((x) => x.members.map((m) => ({ m, unitKey: x.key })));
    const hullsIn = [...own, ...children.flatMap((c) => c.hulls)];
    const leader = u.leaderIndex >= 0 ? u.members[u.leaderIndex]?.personId ?? null : null;
    return {
      key: u.key, callsign: u.callsign, echelon: u.echelon, depth,
      places: placesOf(data, f, u) + children.reduce((s, c) => s + c.places, 0),
      men: men.length,
      able: men.filter((x) => x.m.status === "fit").length,
      wounded: men.filter((x) => x.m.status !== "fit").length,
      recovering: f.pools.recovering.filter((p) => under(u.key, p.unitKey)).length,
      lost: gone.filter((p) => under(u.key, p.unitKey)).length,
      leader,
      ammo: ammoShare(data, record, f, men, hullsIn.filter((h) => h.state === "service").map((h) => service.get(h.vehicleId)!)),
      hulls: hullsIn,
      children,
    };
  };
  return walk(f.battalion, 0);
}

// ------------------------------------------------------------------------------------------------ one man

export type ManWhere = "unit" | "recovering" | "dead" | "missing" | "heldByEnemy" | "unassigned" | "replacements";

export interface ManView {
  record: SoldierRecord;
  faction: string;
  where: ManWhere;
  /** His unit (or the unit he last served in) and its callsign. */
  unitKey: string;
  callsign: string;
  /** Days until he is fit (recovering; a walking wounded man's own days). */
  days?: number;
  /** The battle he left his unit in (a pool). */
  leftIn?: number;
  isLeader: boolean;
  /** May the player make him his unit's leader now (in a unit, not its leader, not medical personnel)? */
  canMakeLeader: boolean;
  service: ServiceEntry[];
  /** Stress peaks over his service (shock, strain) and battles under fire (a minute or more). */
  peaks: { shock: number; strain: number; underFire: number; battles: number };
  /** The men of his unit (himself included). */
  squad: { personId: string; given: string; family: string; rank: string; role: string; status: SoldierRecord["status"]; leader: boolean }[];
}

function findUnit(root: UnitInput, key: string): UnitInput | null {
  if (root.key === key) return root;
  for (const s of root.subunits) { const x = findUnit(s, key); if (x) return x; }
  return null;
}

/** Where a man of a side is (his unit or a pool); null: not of this side. */
export function findMan(record: CampaignRecord, side: CampaignSide, personId: string): { record: SoldierRecord; where: ManWhere; unitKey: string; pool?: PoolMan } | null {
  const f = record.sides[side];
  for (const u of unitsOf(f.battalion)) for (const m of u.members) if (m.personId === personId) return { record: m, where: "unit", unitKey: u.key };
  for (const where of ["recovering", "unassigned", "replacements", "dead", "missing", "heldByEnemy"] as const) {
    const p = f.pools[where].find((x) => x.record.personId === personId);
    if (p) return { record: p.record, where, unitKey: p.unitKey, pool: p };
  }
  return null;
}

export function manView(data: DataSet, record: CampaignRecord, personId: string, side: CampaignSide = "player"): ManView | null {
  const f = record.sides[side];
  const found = findMan(record, side, personId);
  if (!found) return null;
  const u = findUnit(f.battalion, found.unitKey);
  const isLeader = found.where === "unit" && u !== null && u.leaderIndex >= 0 && u.members[u.leaderIndex]?.personId === personId;
  const service = f.service[personId] ?? [];
  const days = found.pool?.days ?? found.record.recoveryDays;
  return {
    record: found.record, faction: f.faction, where: found.where, unitKey: found.unitKey, callsign: u?.callsign ?? found.unitKey,
    ...(days !== undefined ? { days } : {}), ...(found.pool ? { leftIn: found.pool.battle } : {}),
    isLeader,
    canMakeLeader: found.where === "unit" && !isLeader && canLead(data, f.faction, found.record) && record.flow?.phase !== "battle",
    service,
    peaks: {
      shock: service.reduce((s, e) => Math.max(s, e.peakShock), 0), strain: service.reduce((s, e) => Math.max(s, e.peakStrain), 0),
      underFire: service.filter((e) => e.underFireMin >= 1).length, battles: service.length,
    },
    squad: (u?.members ?? []).map((m, i) => ({ personId: m.personId, given: m.given, family: m.family, rank: m.rank, role: m.role, status: m.status, leader: i === u!.leaderIndex })),
  };
}

// ------------------------------------------------------------------------------------------------ the briefing

export interface ForceEstimate { men: number; platoons: number; hulls: { nameKey: string; count: number }[] }

export interface BriefingView {
  operation: number;
  endless: boolean;
  /** The node: its type, kind, who attacks; its place on the line (1-based) and the line's length (endless: 0). */
  node: string;
  kind: string;
  attacker: CampaignSide;
  pos: number;
  lineLength: number;
  /** The sector: its id, map kind and seed, size, battles fought on it before, wrecks and craters on it. */
  sector: { id: number; mapKind: string; mapSeed: number; widthM: number; heightM: number; battles: number; wrecks: number; craters: number };
  flank: { node: string; kind: string } | null;
  /** The campaign clock (hours since it began) and the battle's time limit (s). */
  hours: number;
  seconds: number;
  /** What the player picks from, the choice now (or proposed), its problems, the proposed choice and the cap. */
  selectables: (Selectable & { callsign: string; hulls: number })[];
  choice: string[];
  proposed: string[];
  /** As string-table keys (`cmp.problem.<key>`) with their parameters (review M12, rule 12). */
  problems: CommitProblem[];
  cap: { platoons: number; companyHq: boolean; mortarSections: number; missileTeams: number; aglTeams: number; tankSections: number };
  /** The committed men and hulls, and the enemy's estimated strength against them (rounded: the player does not know it). */
  own: { men: number; hulls: number };
  enemy: ForceEstimate;
  /** The operation so far (its steps) and the battalion's able share. */
  steps: OperationStep[];
  ableShare: number;
}

function hullsOfKeys(data: DataSet, f: CampaignForce, keys: readonly string[]): { men: number; hulls: VehicleRecord[]; platoons: number } {
  const forces = commitOf(data, f, keys);
  const sel = new Map(selectables(data, f).map((s) => [s.key, s]));
  return { men: menOf(forces.units), hulls: forces.vehicles ?? [], platoons: keys.filter((k) => sel.get(k)?.what === "platoon").length };
}

/** Round an estimate (the player sees the enemy's strength only roughly). */
const roughly = (n: number) => (n <= 10 ? n : n <= 50 ? Math.round(n / 5) * 5 : Math.round(n / 10) * 10);

/** The briefing of the node about to be fought (phases briefing, choose, battle). */
export function briefingView(data: DataSet, record: CampaignRecord): BriefingView {
  const op = record.op;
  if (!op) throw new Error("no operation under way (startFlow first)");
  const o = operationRules(data);
  const nt = o.nodes[op.node]!;
  const s = sectorOf(op, "main");
  const p = record.sides.player, e = record.sides.enemy;
  const proposed = proposeChoice(data, p);
  const choice = record.flow?.choice ?? proposed;
  const own = hullsOfKeys(data, p, choice);
  const ek = own.men > 0 ? enemyFor(data, record, "main", own.men) : [];
  const en = hullsOfKeys(data, e, ek);
  const byName = new Map<string, number>();
  for (const v of en.hulls) { const k = nameKeyOf(data, e.faction, v.type); byName.set(k, (byName.get(k) ?? 0) + 1); }
  const units = new Map(unitsOf(p.battalion).map((u) => [u.key, u]));
  const crews = (key: string) => {
    const u = units.get(key);
    if (!u) return 0;
    const inUnit = u.echelon === "company" ? [u, ...u.subunits.filter((x) => x.echelon !== "platoon").flatMap(unitsOf)] : unitsOf(u);
    const have = new Set(p.vehicles.map((v) => v.vehicleId));
    return inUnit.filter((x) => x.vehicleId !== undefined && have.has(x.vehicleId) && x.members.length > 0).length;
  };
  const cap = campaignRules(data).battle;
  return {
    operation: record.operation.index + 1, endless: op.endless, node: op.node, kind: nt.kind, attacker: nt.attacker, pos: op.pos + 1, lineLength: op.endless ? 0 : op.line.length,
    sector: { id: s.id, mapKind: s.mapKind, mapSeed: s.mapSeed, widthM: s.widthM, heightM: s.heightM, battles: s.battles, wrecks: s.wrecks?.length ?? 0, craters: s.damage?.craters?.length ?? 0 },
    flank: op.flank ? { node: op.flank.node, kind: o.nodes[op.flank.node]!.kind } : null,
    hours: record.hours, seconds: record.battleSeconds ?? o.seconds,
    selectables: selectables(data, p).map((x) => ({ ...x, callsign: units.get(x.key)?.callsign ?? x.key, hulls: crews(x.key) })),
    choice, proposed, problems: commitProblems(data, p, choice),
    cap: { platoons: cap.platoons, companyHq: cap.companyHq, mortarSections: cap.mortarSections, missileTeams: cap.missileTeams, aglTeams: cap.aglTeams, tankSections: cap.tankSections },
    own: { men: own.men, hulls: own.hulls.length },
    enemy: { men: roughly(en.men), platoons: en.platoons, hulls: [...byName].map(([nameKey, count]) => ({ nameKey, count })).sort((a, b) => b.count - a.count || (a.nameKey < b.nameKey ? -1 : 1)) },
    steps: op.steps, ableShare: ableShare(data, p),
  };
}

// ------------------------------------------------------------------------------------------------ after a battle

export interface ChangedMan { personId: string; given: string; family: string; rank: string; role: string; unitKey: string; callsign: string; days?: number; xp?: number; replaced?: string; how?: string }

export interface BattleOutcome {
  index: number;
  flank: boolean;
  node: string;
  kind: string;
  mapKind: string;
  winner: CampaignSide | null;
  endReason: string;
  durationS: number;
  men: { player: { in: number; killed: number; evacuated: number; captured: number; missing: number }; enemy: { in: number; killed: number; evacuated: number; captured: number; missing: number } };
  hulls: { player: { in: number; workshop: number; lost: number }; enemy: { in: number; workshop: number; lost: number } };
}

export interface AfterBattleView {
  /** The node's result and how it went (absent battles: won without one). */
  result: "win" | "loss" | "draw";
  walkover: boolean;
  battles: BattleOutcome[];
  killed: ChangedMan[];
  wounded: ChangedMan[];
  captured: ChangedMan[];
  missing: ChangedMan[];
  /** Men who gained experience (the most first) and the total. */
  experience: { men: number; total: number; top: ChangedMan[] };
  leaders: ChangedMan[];
  /** Men back from recovery in their units (or waiting unassigned). */
  rejoined: ChangedMan[];
  /** Rounds fired by the player's side, by ammunition id (the most first). */
  fired: { ammo: string; calibre: string; kind: string; rounds: number }[];
  hullsLost: HullView[];
  hullsWorkshop: HullView[];
  hullsRepaired: HullView[];
  prisonersTaken: number;
  /** The operation: its steps so far, its end (null: goes on), the next node. */
  steps: OperationStep[];
  end: string | null;
  next: { node: string; pos: number } | null;
  endless: boolean;
  lineLength: number;
}

/** What the last node changed (phases after-battle, replenishment, operation-end). */
export function afterBattleView(data: DataSet, record: CampaignRecord): AfterBattleView {
  const op = record.op;
  if (!op || op.steps.length === 0) throw new Error("no node fought yet in this operation");
  const step = op.steps[op.steps.length - 1]!;
  const idx = [step.flank?.battle, step.battle].filter((x): x is number => x !== undefined);
  const inStep = (b: number) => idx.includes(b);
  const p = record.sides.player;
  const units = new Map(unitsOf(p.battalion).map((u) => [u.key, u]));
  const callsignOf = (key: string) => units.get(key)?.callsign ?? key;
  const man = (m: SoldierRecord, unitKey: string, extra: Partial<ChangedMan> = {}): ChangedMan => ({
    personId: m.personId, given: m.given, family: m.family, rank: m.rank, role: m.role, unitKey, callsign: callsignOf(unitKey), ...extra,
  });
  const pool = (list: readonly PoolMan[], days = false) => list.filter((x) => inStep(x.battle)).map((x) => man(x.record, x.unitKey, days && x.days !== undefined ? { days: x.days } : {}));
  // Walking wounded who stay with their units (wounded in these battles: a wound inflicted, still with recovery days).
  const walking: ChangedMan[] = [];
  for (const u of unitsOf(p.battalion)) for (const m of u.members) {
    const e = p.service[m.personId]?.find((x) => inStep(x.battle));
    if (e && e.wounds > 0 && m.status === "wounded") walking.push(man(m, u.key, m.recoveryDays !== undefined ? { days: m.recoveryDays } : {}));
  }
  const gains: ChangedMan[] = [];
  let total = 0;
  for (const [pid, list] of Object.entries(p.service)) {
    const xp = list.filter((x) => inStep(x.battle)).reduce((s, x) => s + x.xp, 0);
    if (xp <= 0) continue;
    total += xp;
    const f = findMan(record, "player", pid);
    if (f) gains.push(man(f.record, f.unitKey, { xp }));
  }
  gains.sort((a, b) => b.xp! - a.xp! || (a.personId < b.personId ? -1 : 1));
  const logs = (kind: CampaignLogEntry["kind"]) => record.log.filter((l) => l.side === "player" && l.kind === kind && (inStep(l.battle) || (idx.length === 0 && l.battle === record.battles)));
  // (The player's own appointments ("Make leader") are not news after the battle: only the automatic ones, review M12.)
  const leaders = logs("leader").filter((l) => l.how !== "player").flatMap((l) => {
    const f = findMan(record, "player", l.personId!);
    if (!f) return [];
    const old = l.replaced !== undefined ? findMan(record, "player", l.replaced) : null;
    return [man(f.record, l.unitKey!, { ...(old ? { replaced: `${old.record.given} ${old.record.family}` } : {}), ...(l.how ? { how: l.how } : {}) })];
  });
  const rejoined = [...logs("rejoin"), ...logs("unassigned")].flatMap((l) => { const f = findMan(record, "player", l.personId!); return f ? [man(f.record, l.unitKey!, { how: l.kind })] : []; });
  const fired = new Map<string, number>();
  for (const c of record.consumption) if (c.side === "player" && c.kind === "battle" && inStep(c.battle)) for (const [a, n] of Object.entries(c.fired ?? {})) fired.set(a, (fired.get(a) ?? 0) + n);
  const catalog = campaignCatalog(data, record);
  const hv = (vehicleId: string, type: string, state: HullView["state"], extra: Partial<HullView> = {}): HullView => ({ vehicleId, type, nameKey: nameKeyOf(data, p.faction, type), state, ...extra });
  const repaired = logs("hull-repaired").map((l) => { const v = p.vehicles.find((x) => x.vehicleId === l.vehicleId); return hv(l.vehicleId!, v?.type ?? "", "service"); });
  const battles: BattleOutcome[] = record.history.filter((h) => inStep(h.index)).map((h) => ({
    index: h.index, flank: h.flank === true, node: h.node ?? "", kind: h.kind, mapKind: h.mapKind, winner: h.winner, endReason: h.endReason, durationS: h.durationS,
    men: { player: h.men.player, enemy: h.men.enemy }, hulls: { player: h.hulls.player, enemy: h.hulls.enemy },
  }));
  return {
    result: step.result, walkover: step.walkover === true, battles,
    killed: pool(p.pools.dead), wounded: [...pool(p.pools.recovering, true), ...walking], captured: pool(p.pools.heldByEnemy), missing: pool(p.pools.missing),
    experience: { men: gains.length, total, top: gains.slice(0, 5) },
    leaders, rejoined,
    fired: [...fired].map(([ammo, rounds]) => ({ ammo, calibre: catalog.ammo[ammo]?.calibre ?? ammo, kind: catalog.ammo[ammo]?.kind ?? "", rounds })).sort((a, b) => b.rounds - a.rounds || (a.ammo < b.ammo ? -1 : 1)),
    hullsLost: p.lostHulls.filter((l) => inStep(l.battle)).map((l) => hv(l.vehicleId, l.type, "lost", { status: l.how })),
    hullsWorkshop: p.workshop.filter((w) => inStep(w.battle)).map((w) => hv(w.record.vehicleId, w.record.type, "workshop", { days: w.days })),
    hullsRepaired: repaired,
    prisonersTaken: p.pools.prisoners.filter((x) => inStep(x.battle)).length,
    steps: op.steps, end: op.end, next: step.next ?? null, endless: op.endless, lineLength: op.endless ? 0 : op.line.length,
  };
}

// ------------------------------------------------------------------------------------------------ replenishment

export interface ReplenishmentView {
  /** The record's battle count when it ran (the log's battle index). */
  battle: number;
  replacements: ChangedMan[];
  rejoined: ChangedMan[];
  hullsReplaced: HullView[];
  hullsRepaired: HullView[];
  /** Rounds, litres and items brought up (the sums of `delivered`; negative: handed back). */
  rounds: number;
  litres: number;
  /** Days that passed. */
  days: number;
  /** Men and able share after it. */
  men: number;
  ableShare: number;
}

/** The last replenishment of the player's side (null: none yet). */
export function replenishmentView(data: DataSet, record: CampaignRecord): ReplenishmentView | null {
  const p = record.sides.player;
  const last = [...record.log].reverse().find((l) => l.side === "player" && l.kind === "replenishment");
  if (!last) return null;
  const b = last.battle;
  // The entries of that replenishment: after the previous "replenishment" entry and up to this one, at its battle index.
  const end = record.log.lastIndexOf(last);
  let start = end;
  while (start > 0 && record.log[start - 1]!.battle === b && !(record.log[start - 1]!.side === "player" && record.log[start - 1]!.kind === "replenishment")) start--;
  const entries = record.log.slice(start, end).filter((l) => l.side === "player");
  const units = new Map(unitsOf(p.battalion).map((u) => [u.key, u]));
  const man = (l: CampaignLogEntry): ChangedMan[] => {
    const f = findMan(record, "player", l.personId!);
    return f ? [{ personId: f.record.personId, given: f.record.given, family: f.record.family, rank: f.record.rank, role: f.record.role, unitKey: f.unitKey, callsign: units.get(f.unitKey)?.callsign ?? f.unitKey }] : [];
  };
  const hull = (l: CampaignLogEntry): HullView[] => { const v = p.vehicles.find((x) => x.vehicleId === l.vehicleId); return v ? [{ vehicleId: v.vehicleId, type: v.type, nameKey: nameKeyOf(data, p.faction, v.type), state: "service" }] : []; };
  const delivered: Holdings = record.consumption.filter((c) => c.side === "player" && c.kind === "replenishment" && c.battle === b).map((c) => c.delivered!).at(-1) ?? emptyHoldings();
  return {
    battle: b,
    replacements: entries.filter((l) => l.kind === "replacement").flatMap(man),
    rejoined: entries.filter((l) => l.kind === "rejoin").flatMap(man),
    hullsReplaced: entries.filter((l) => l.kind === "hull-replaced").flatMap(hull),
    hullsRepaired: entries.filter((l) => l.kind === "hull-repaired").flatMap(hull),
    rounds: Object.values(delivered.ammo).reduce((s, n) => s + n, 0),
    litres: Object.values(delivered.charge).reduce((s, n) => s + n, 0),
    days: campaignRules(data).clock.daysBetweenOperations,
    men: unitsOf(p.battalion).reduce((s, u) => s + u.members.length, 0),
    ableShare: ableShare(data, p),
  };
}
