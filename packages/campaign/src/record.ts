/**
 * THE CAMPAIGN RECORD (M12.1a, plan m12-roster 4.3): everything a campaign is, as plain data (saved and loaded whole,
 * M12.1b). Both sides are battalions: the player's and the enemy's, each a `UnitInput` tree (the roster records the
 * battles take and give back) with its hulls, the pools of men who are not with their units, the hulls in the
 * workshop or lost, and every man's service history. The rules between battles (`between.ts`) are pure functions of
 * this record; the campaign's own dice (replacements' names and skills) come from its `rng` (named streams, sim/rng).
 */
import type { DataSet } from "@tcs/data";
import { buildCatalog } from "@tcs/data";
import { canonicalJson, createRng, hashText, newVehicleRecord, type Catalog, type RngState, type SoldierRecord, type UnitInput, type VehicleRecord } from "@tcs/sim";
import { buildForceWithVehicles, type CarrierClass } from "@tcs/scenario";

export const CAMPAIGN_VERSION = 1;

export type CampaignMode = "operations" | "endless";
export type CampaignSide = "player" | "enemy";

/** One battle in a man's service history (appended after every battle he took part in; never erased). */
export interface ServiceEntry {
  battle: number;
  /** Minutes under effective fire and in contact, rounds fired, wounds taken (from `BattleResult.service`). */
  underFireMin: number; contactMin: number; rounds: number; wounds: number;
  /** Stress: his peak shock and strain in the battle, his strain as he came out. */
  peakShock: number; peakStrain: number; strainAfter: number;
  /** Experience gained by the battle (after the caps). */
  xp: number;
  /** His roster status as he came out. */
  status: SoldierRecord["status"];
}

/** A man who is not with a unit: his record, the unit he belongs to (or last served in), when he left it. */
export interface PoolMan {
  record: SoldierRecord;
  unitKey: string;
  battle: number;
  /** Recovering: days until he is fit (counts down with the clock). */
  days?: number;
}

/** A man of the other side held as a prisoner (a reference: his record stays in his own side's pool). */
export interface PrisonerRef { personId: string; given: string; family: string; rank: string; battle: number }

/** A hull in the workshop (recovered or towed in a battle): back in service when its days are up. */
export interface WorkshopHull { record: VehicleRecord; days: number; battle: number }

/** A hull lost (destroyed, captured, left): replaced at a replenishment (`rules.repair.replaceLost`). */
export interface LostHull { vehicleId: string; type: string; battle: number; how: "destroyed" | "captured" }

export interface CampaignPools {
  /** Evacuated wounded (days to go). */
  recovering: PoolMan[];
  dead: PoolMan[];
  missing: PoolMan[];
  /** Own men the enemy holds. */
  heldByEnemy: PoolMan[];
  /** Enemy men this side holds. */
  prisoners: PrisonerRef[];
  /** Green replacements waiting for a place (none in stage one: they go straight into empty places). */
  replacements: PoolMan[];
  /** Fit men without a place (a recovered man whose unit was full). */
  unassigned: PoolMan[];
}

export interface CampaignForce {
  faction: string;
  carriers: CarrierClass;
  /** The battalion template (manifest `battalionTemplates`). */
  template: string;
  /** Prefix of every unit key and person id of this force. */
  keyPrefix: string;
  battalion: UnitInput;
  /** Hulls in service. */
  vehicles: VehicleRecord[];
  /** Unit key -> its template (its establishment: the places it has). */
  establishment: Record<string, string>;
  workshop: WorkshopHull[];
  lostHulls: LostHull[];
  pools: CampaignPools;
  /** Per personId: every battle he fought (stress history; kept for the dead too). */
  service: Record<string, ServiceEntry[]>;
  /** The next person number (`${keyPrefix}#${n}`) and hull serial (`${crewKey}~${n}`). */
  nextPersonId: number;
  nextHullSerial: number;
}

/** What one battle was and how it ended (the battle history). */
export interface BattleSummary {
  index: number;
  operation: number;
  kind: string;
  mapKind: string;
  mapSeed: number;
  seed: number;
  /** The player's side in the battle (blue or red) and who attacked. */
  playerSide: "blue" | "red";
  attacker: CampaignSide;
  winner: CampaignSide | null;
  endReason: string;
  durationS: number;
  men: Record<CampaignSide, { in: number; able: number; killed: number; evacuated: number; captured: number; missing: number }>;
  hulls: Record<CampaignSide, { in: number; service: number; workshop: number; lost: number }>;
}

/** Counted holdings (sim/ledger's shape): rounds by ammunition id, charge by kind (litres, Wh, ml), whole items. */
export interface Holdings { ammo: Record<string, number>; charge: Record<string, number>; items: Record<string, number> }

/** The consumption log: per battle and side what the battle took (`net`: records in minus out), what the events say
 *  was fired, and what left with men and hulls who left the force; per replenishment what was delivered. */
export interface ConsumptionEntry {
  battle: number;
  side: CampaignSide;
  kind: "battle" | "replenishment";
  /** Battle: rounds fired by the side (`BattleResult.logistics` consumed). */
  fired?: Record<string, number>;
  /** Battle: what the committed records held going in minus coming out. */
  net?: Holdings;
  /** Battle: the loads of the dead, missing and captured men and the lost hulls (gone from the force). */
  writtenOff?: Holdings;
  /** Replenishment: what was brought up to the standard loads (negative: handed back). */
  delivered?: Holdings;
}

/** What changed between battles that the player is shown (M12.3): leaders appointed, men back, replacements, refill. */
export interface CampaignLogEntry {
  battle: number;
  side: CampaignSide;
  kind: "leader" | "rejoin" | "unassigned" | "replacement" | "refill" | "hull-repaired" | "hull-replaced" | "replenishment";
  unitKey?: string;
  personId?: string;
  /** Leader: whom he replaced; how he was chosen ("own": a man of the unit; "sub": a sub-unit's leader moved up). */
  replaced?: string;
  how?: "own" | "sub";
  vehicleId?: string;
  count?: number;
}

export interface CampaignRecord {
  version: number;
  seed: number;
  /** The campaign's own dice (replacements). */
  rng: RngState;
  /** Hours since the campaign began. */
  hours: number;
  mode: CampaignMode;
  /** The operation (0-based) and how many battles of it were fought; battles fought in all. */
  operation: { index: number; battles: number };
  battles: number;
  sides: Record<CampaignSide, CampaignForce>;
  history: BattleSummary[];
  consumption: ConsumptionEntry[];
  log: CampaignLogEntry[];
}

export interface NewCampaignOptions {
  seed: number;
  faction: string;
  enemy: string;
  carriers?: CarrierClass;
  enemyCarriers?: CarrierClass;
  mode?: CampaignMode;
}

/** The battalion template of a faction for a carrier class (the other class when it has none). */
export function battalionTemplateOf(data: DataSet, faction: string, carriers: CarrierClass): { template: string; carriers: CarrierClass } {
  const bt = data.factions[faction]?.manifest.battalionTemplates;
  const other: CarrierClass = carriers === "tracked" ? "wheeled" : "tracked";
  const t = bt?.[carriers] ?? bt?.[other];
  if (t === undefined) throw new Error(`faction '${faction}' has no battalionTemplates`);
  return { template: t, carriers: bt?.[carriers] !== undefined ? carriers : other };
}

/** The catalog of a campaign (both factions). */
export function campaignCatalog(data: DataSet, record: CampaignRecord): Catalog {
  return buildCatalog(data, [record.sides.player.faction, record.sides.enemy.faction].filter((f, i, a) => a.indexOf(f) === i));
}

/** Unit key -> template id, walking the template tree as `buildForceWithVehicles` builds it. */
function establishmentOf(data: DataSet, faction: string, template: string, unit: UnitInput, out: Record<string, string>): void {
  out[unit.key] = template;
  const t = data.factions[faction]!.units[template]!;
  t.subunits.forEach((s, i) => { const su = unit.subunits[i]; if (su) establishmentOf(data, faction, s, su, out); });
}

function newForce(data: DataSet, catalog: Catalog, faction: string, carriers: CarrierClass, keyPrefix: string, seed: number): CampaignForce {
  const bt = battalionTemplateOf(data, faction, carriers);
  const built = buildForceWithVehicles(data, { faction, template: bt.template, seed, keyPrefix });
  const establishment: Record<string, string> = {};
  establishmentOf(data, faction, bt.template, built.unit, establishment);
  let men = 0;
  const count = (u: UnitInput) => { men += u.members.length; u.subunits.forEach(count); };
  count(built.unit);
  return {
    faction, carriers: bt.carriers, template: bt.template, keyPrefix, battalion: built.unit,
    vehicles: built.vehicles.map((v) => newVehicleRecord(catalog, v.type, v.vehicleId)),
    establishment, workshop: [], lostHulls: [],
    pools: { recovering: [], dead: [], missing: [], heldByEnemy: [], prisoners: [], replacements: [], unassigned: [] },
    service: {}, nextPersonId: men, nextHullSerial: 1,
  };
}

/** A new campaign: the player's battalion (prefix "P") and the enemy's ("E"), both full and fresh. */
export function newCampaign(data: DataSet, opts: NewCampaignOptions): CampaignRecord {
  const catalog = buildCatalog(data, [opts.faction, opts.enemy].filter((f, i, a) => a.indexOf(f) === i));
  return {
    version: CAMPAIGN_VERSION, seed: opts.seed, rng: createRng(opts.seed), hours: 0, mode: opts.mode ?? "operations",
    operation: { index: 0, battles: 0 }, battles: 0,
    sides: {
      player: newForce(data, catalog, opts.faction, opts.carriers ?? "tracked", "P", opts.seed * 2 + 1),
      enemy: newForce(data, catalog, opts.enemy, opts.enemyCarriers ?? opts.carriers ?? "tracked", "E", opts.seed * 2 + 2),
    },
    history: [], consumption: [], log: [],
  };
}

/** The record's content hash (canonical JSON; reproducibility checks). */
export function hashRecord(record: CampaignRecord): string {
  return hashText(canonicalJson(record));
}

/** Every unit of a tree, depth first (the tree's own order). */
export function unitsOf(u: UnitInput): UnitInput[] {
  return [u, ...u.subunits.flatMap(unitsOf)];
}

/** Every man of a tree. */
export function membersOf(u: UnitInput): SoldierRecord[] {
  return unitsOf(u).flatMap((x) => x.members);
}

/** Deep copy of plain data. */
export function clone<T>(x: T): T {
  return JSON.parse(JSON.stringify(x)) as T;
}
