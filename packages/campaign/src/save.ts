/**
 * CAMPAIGN SAVES (M12.1b, plan m12-roster 4.4; owner 2026-11-19: free saving, several slots, export / import, any
 * time between battles). A save is the whole campaign record in a versioned envelope:
 *
 *   CampaignSave { version, record, slotName, savedAt, fingerprint }
 *
 * - `savedAt` is a string the app supplies (its clock, for the slot list); the rules never read it, so the campaign
 *   stays deterministic. `fingerprint` is the catalog fingerprint of the campaign's factions when it was saved.
 * - Loading (`readSave`): parse -> migrate (`MIGRATIONS`, version n -> n + 1 until the current one) -> validate the
 *   shape (fatal errors refuse the save) -> ID repair (duplicate or missing person ids and hull ids renamed, leaders'
 *   indexes and crews' / carried units' hull links checked, `nextPersonId` and `nextHullSerial` raised past every id
 *   in use) -> the fingerprint compared with the data (a mismatch warns, the save still loads: the data changed, the
 *   records still name the same items).
 * - Export (`exportSave`) is canonical JSON (sorted keys): the same save always gives the same bytes, and a valid
 *   save imports without a change, so export -> import -> export is byte-identical.
 */
import type { DataSet } from "@tcs/data";
import { canonicalJson, type SoldierRecord } from "@tcs/sim";
import { appointLeaders } from "./leaders";
import { CAMPAIGN_VERSION, campaignCatalog, clone, unitsOf, type CampaignForce, type CampaignRecord, type CampaignSide, type PoolMan } from "./record";

export interface CampaignSave {
  version: number;
  record: CampaignRecord;
  /** The slot it was saved in (the player's name, or `AUTO_SLOT`). */
  slotName: string;
  /** When, as the app's clock says it (shown in the slot list; never read by the rules). */
  savedAt: string;
  /** Catalog fingerprint of the campaign's factions at saving ("" when unknown: a migrated version-1 save). */
  fingerprint: string;
}

/** The automatic slot written after every battle. */
export const AUTO_SLOT = "auto";

/** A repair made on load (shown to the player; the record's log is not touched). */
export interface SaveRepair {
  side: CampaignSide;
  kind: "person-id" | "hull-id" | "leader" | "crew-link" | "carrier-link" | "next-person" | "next-hull";
  /** Where: a unit key, a pool name, or the counter. */
  where: string;
  from?: string;
  to?: string;
}

export interface LoadedSave {
  save: CampaignSave;
  /** The version the save was made in (before migration). */
  fromVersion: number;
  /** Not fatal: e.g. "data-changed" (fingerprint mismatch). */
  warnings: string[];
  repairs: SaveRepair[];
}

export class SaveError extends Error {
  constructor(message: string, readonly problems: string[] = []) { super(message); this.name = "SaveError"; }
}

/** A save of a record (deep copy: later changes to the record do not reach the save). */
export function makeSave(data: DataSet, record: CampaignRecord, slotName: string, savedAt: string): CampaignSave {
  return { version: CAMPAIGN_VERSION, record: clone(record), slotName, savedAt, fingerprint: campaignCatalog(data, record).fingerprint };
}

/** The save as text (canonical JSON: the same save always gives the same bytes). */
export function exportSave(save: CampaignSave): string {
  return canonicalJson(save);
}

// ----------------------------------------------------------------------------------------------------------- migrations

type Json = Record<string, unknown>;
const isObj = (x: unknown): x is Json => typeof x === "object" && x !== null && !Array.isArray(x);

/**
 * Migrations: version n -> n + 1, applied in turn. Each takes the raw JSON of its version and returns the next
 * version's raw JSON; never edit a migration once released (old files depend on it), add the next one.
 *
 * - 1 -> 2: version 1 was the bare `CampaignRecord` (M12.1a: what `npm run campaign -- chain` writes as .json). It is
 *   wrapped in the envelope, slot "imported", no time, no fingerprint (so no warning on load).
 */
export const MIGRATIONS: Readonly<Record<number, (old: Json) => Json>> = {
  1: (old) => {
    const record = isObj(old["record"]) ? old["record"] : old;
    return { version: 2, record: { ...record, version: 2 }, slotName: typeof old["slotName"] === "string" ? old["slotName"] : "imported", savedAt: typeof old["savedAt"] === "string" ? old["savedAt"] : "", fingerprint: "" };
  },
};

/** The version of raw save JSON (a bare record carries its own `version`). */
function versionOf(raw: Json): number {
  const v = raw["version"];
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1) throw new SaveError("not a campaign save: no version");
  return v;
}

export function migrate(raw: Json): { json: Json; fromVersion: number } {
  const fromVersion = versionOf(raw);
  if (fromVersion > CAMPAIGN_VERSION) throw new SaveError(`the save is from a newer version (${fromVersion}; this game reads up to ${CAMPAIGN_VERSION})`);
  let json = raw;
  for (let v = fromVersion; v < CAMPAIGN_VERSION; v++) {
    const m = MIGRATIONS[v];
    if (!m) throw new SaveError(`no migration from version ${v}`);
    json = m(json);
    if (versionOf(json) !== v + 1) throw new SaveError(`migration from version ${v} gave version ${String(json["version"])}`);
  }
  return { json, fromVersion };
}

// ----------------------------------------------------------------------------------------------------------- validation

const POOLS = ["recovering", "dead", "missing", "heldByEnemy", "replacements", "unassigned"] as const;

/** Shape problems that make a save unreadable (empty: readable). Ids are not checked here (`repairIds` does that). */
export function validateSave(data: DataSet, json: Json): string[] {
  const p: string[] = [];
  const need = (ok: boolean, what: string) => { if (!ok) p.push(what); return ok; };
  need(typeof json["slotName"] === "string", "slotName");
  need(typeof json["savedAt"] === "string", "savedAt");
  need(typeof json["fingerprint"] === "string", "fingerprint");
  const r = json["record"];
  if (!isObj(r)) { p.push("record"); return p; }
  need(r["version"] === json["version"], "record.version");
  need(typeof r["seed"] === "number", "record.seed");
  need(isObj(r["rng"]), "record.rng");
  need(typeof r["hours"] === "number", "record.hours");
  need(r["mode"] === "operations" || r["mode"] === "endless", "record.mode");
  const op = r["operation"];
  need(isObj(op) && typeof op["index"] === "number" && typeof op["battles"] === "number", "record.operation");
  need(typeof r["battles"] === "number", "record.battles");
  for (const k of ["history", "consumption", "log"]) need(Array.isArray(r[k]), `record.${k}`);
  const sides = r["sides"];
  if (!isObj(sides)) { p.push("record.sides"); return p; }
  for (const s of ["player", "enemy"] as const) {
    const f = sides[s];
    const at = `record.sides.${s}`;
    if (!isObj(f)) { p.push(at); continue; }
    if (need(typeof f["faction"] === "string", `${at}.faction`)) need(data.factions[f["faction"] as string] !== undefined, `${at}.faction '${String(f["faction"])}' is not in the data`);
    need(f["carriers"] === "tracked" || f["carriers"] === "wheeled", `${at}.carriers`);
    for (const k of ["template", "keyPrefix"]) need(typeof f[k] === "string", `${at}.${k}`);
    need(isObj(f["establishment"]) && isObj(f["service"]), `${at}.establishment/service`);
    for (const k of ["vehicles", "workshop", "lostHulls"]) need(Array.isArray(f[k]), `${at}.${k}`);
    need(typeof f["nextPersonId"] === "number" && typeof f["nextHullSerial"] === "number", `${at}.next ids`);
    const unitOk = (u: unknown, path: string): void => {
      if (!isObj(u)) { p.push(path); return; }
      need(typeof u["key"] === "string", `${path}.key`);
      need(typeof u["leaderIndex"] === "number", `${path}.leaderIndex`);
      if (need(Array.isArray(u["members"]), `${path}.members`)) (u["members"] as unknown[]).forEach((m, i) => need(isObj(m) && Array.isArray(m["load"]) && typeof m["role"] === "string", `${path}.members[${i}]`));
      if (need(Array.isArray(u["subunits"]), `${path}.subunits`)) (u["subunits"] as unknown[]).forEach((x, i) => unitOk(x, `${path}.subunits[${i}]`));
    };
    unitOk(f["battalion"], `${at}.battalion`);
    const pools = f["pools"];
    if (!isObj(pools)) p.push(`${at}.pools`);
    else {
      for (const k of POOLS) if (need(Array.isArray(pools[k]), `${at}.pools.${k}`)) (pools[k] as unknown[]).forEach((x, i) => need(isObj(x) && isObj(x["record"]), `${at}.pools.${k}[${i}]`));
      need(Array.isArray(pools["prisoners"]), `${at}.pools.prisoners`);
    }
    (Array.isArray(f["vehicles"]) ? f["vehicles"] as unknown[] : []).forEach((v, i) => need(isObj(v) && typeof v["type"] === "string" && Array.isArray(v["load"]), `${at}.vehicles[${i}]`));
    (Array.isArray(f["workshop"]) ? f["workshop"] as unknown[] : []).forEach((v, i) => need(isObj(v) && isObj(v["record"]), `${at}.workshop[${i}]`));
  }
  return p;
}

// ----------------------------------------------------------------------------------------------------------- ID repair

/** The number after `${prefix}${sep}` at the end of an id (or -1). */
function serialOf(id: string, sep: string): number {
  const k = id.lastIndexOf(sep);
  if (k < 0) return -1;
  const tail = id.slice(k + 1);
  return /^\d+$/.test(tail) ? Number(tail) : -1;
}

/**
 * Repair the ids of a record in place (see the file comment); returns what was changed. Order: every man of the
 * battalion (depth first, roster order), then the pools in a fixed order; an id with a side's prefix belongs to that
 * side; the first holder of an id keeps it, later holders and men without one get a new `${keyPrefix}#n` (n past every serial in use). Hulls: in service, then the workshop; a duplicate gets
 * `${base}~n`, and the crews that named the duplicated id are shared out over the copies in roster order. Links to a
 * hull the force does not have at all (not in service, workshop or lost) are dropped; leaders' indexes out of range
 * are cleared and the leader rule (`appointLeaders`) appoints one.
 */
export function repairIds(data: DataSet, record: CampaignRecord): SaveRepair[] {
  const repairs: SaveRepair[] = [];
  const persons = new Set<string>();
  const sides = ["player", "enemy"] as const;
  const men = sides.map((side) => {
    const f = record.sides[side];
    const all: { m: SoldierRecord; where: string }[] = [];
    for (const u of unitsOf(f.battalion)) for (const m of u.members) all.push({ m, where: u.key });
    for (const k of POOLS) for (const p of f.pools[k] as PoolMan[]) all.push({ m: p.record, where: k });
    return all;
  });
  const idOf = (m: SoldierRecord) => (typeof m.personId === "string" ? m.personId : "");
  // Both sides' men share one battle, so ids are unique across them; a side's own ids (its prefix) are claimed first.
  sides.forEach((side, i) => {
    for (const { m } of men[i]!) { const id = idOf(m); if (id !== "" && id.startsWith(record.sides[side].keyPrefix) && !persons.has(id)) persons.add(id); }
  });
  sides.forEach((side, i) => {
    const f = record.sides[side];
    let nextP = Math.max(0, Math.trunc(f.nextPersonId));
    const usedSerial = (id: string) => { if (id.startsWith(f.keyPrefix)) nextP = Math.max(nextP, serialOf(id, "#") + 1); };
    for (const pid of Object.keys(f.service)) usedSerial(pid);
    for (const { m } of men[i]!) usedSerial(idOf(m));
    const kept = new Set<string>();
    for (const { m, where } of men[i]!) {
      const id = idOf(m);
      if (id !== "" && !kept.has(id) && (id.startsWith(f.keyPrefix) || !persons.has(id))) { kept.add(id); persons.add(id); continue; }
      let nid = `${f.keyPrefix}#${nextP++}`;
      while (persons.has(nid)) nid = `${f.keyPrefix}#${nextP++}`;
      persons.add(nid);
      m.personId = nid;
      repairs.push({ side, kind: "person-id", where, ...(id !== "" ? { from: id } : {}), to: nid });
    }
    if (nextP !== f.nextPersonId) { repairs.push({ side, kind: "next-person", where: "nextPersonId", from: String(f.nextPersonId), to: String(nextP) }); f.nextPersonId = nextP; }
    repairHulls(data, f, side, repairs);
  });
  return repairs;
}

function repairHulls(data: DataSet, f: CampaignForce, side: CampaignSide, repairs: SaveRepair[]): void {
  let nextH = Math.max(1, Math.trunc(f.nextHullSerial));
  const hulls = [...f.vehicles, ...f.workshop.map((w) => w.record)];
  for (const id of [...hulls.map((v) => v.vehicleId), ...f.lostHulls.map((l) => l.vehicleId)]) if (typeof id === "string") nextH = Math.max(nextH, serialOf(id, "~") + 1);
  const seen = new Set<string>(f.lostHulls.map((l) => l.vehicleId));
  /** Old id -> the ids its holders have now (the first keeps it). */
  const copies = new Map<string, string[]>();
  const units = unitsOf(f.battalion);
  for (const v of hulls) {
    const id = typeof v.vehicleId === "string" ? v.vehicleId : "";
    if (id !== "" && !seen.has(id)) { seen.add(id); copies.set(id, [id]); continue; }
    const base = id !== "" ? id.split("~")[0]! : `${f.keyPrefix}/hull`;
    let nid = `${base}~${nextH++}`;
    while (seen.has(nid)) nid = `${base}~${nextH++}`;
    seen.add(nid);
    v.vehicleId = nid;
    if (id !== "") (copies.get(id) ?? copies.set(id, []).get(id)!).push(nid);
    repairs.push({ side, kind: "hull-id", where: "vehicles", ...(id !== "" ? { from: id } : {}), to: nid });
  }
  if (nextH !== f.nextHullSerial) { repairs.push({ side, kind: "next-hull", where: "nextHullSerial", from: String(f.nextHullSerial), to: String(nextH) }); f.nextHullSerial = nextH; }
  // Crews: the n-th crew naming a duplicated id gets its n-th copy; a crew naming a hull the force does not have walks.
  const given = new Map<string, number>();
  for (const u of units) {
    if (u.vehicleId === undefined) continue;
    const list = copies.get(u.vehicleId);
    if (list) {
      const n = given.get(u.vehicleId) ?? 0;
      given.set(u.vehicleId, n + 1);
      if (n > 0 && n < list.length) { repairs.push({ side, kind: "crew-link", where: u.key, from: u.vehicleId, to: list[n]! }); u.vehicleId = list[n]!; }
      continue;
    }
    if (seen.has(u.vehicleId)) continue; // a lost hull: replaced at the replenishment
    repairs.push({ side, kind: "crew-link", where: u.key, from: u.vehicleId });
    delete u.vehicleId;
  }
  for (const u of units) {
    if (u.carrierId === undefined || seen.has(u.carrierId)) continue;
    repairs.push({ side, kind: "carrier-link", where: u.key, from: u.carrierId });
    delete u.carrierId;
  }
  // Leaders.
  const lost = new Map<string, string>();
  for (const u of units) {
    if (Number.isInteger(u.leaderIndex) && u.leaderIndex >= -1 && u.leaderIndex < u.members.length) continue;
    repairs.push({ side, kind: "leader", where: u.key, from: String(u.leaderIndex) });
    u.leaderIndex = -1;
    lost.set(u.key, "");
  }
  if (lost.size > 0) {
    for (const e of appointLeaders(data, f, -1, side)) if (e.unitKey !== undefined && e.personId !== undefined) {
      const r = repairs.find((x) => x.kind === "leader" && x.where === e.unitKey && x.side === side && x.to === undefined);
      if (r) r.to = e.personId; else repairs.push({ side, kind: "leader", where: e.unitKey, to: e.personId });
    }
  }
}

// ----------------------------------------------------------------------------------------------------------- loading

/** Read a save from its text or parsed JSON (see the file comment); throws `SaveError` when it cannot be read. */
export function readSave(data: DataSet, input: string | unknown): LoadedSave {
  let raw: unknown = input;
  if (typeof input === "string") {
    try { raw = JSON.parse(input); } catch { throw new SaveError("not a campaign save: not JSON"); }
  }
  if (!isObj(raw)) throw new SaveError("not a campaign save");
  const { json, fromVersion } = migrate(raw);
  const problems = validateSave(data, json);
  if (problems.length > 0) throw new SaveError(`the save is damaged (${problems.length} problems)`, problems);
  const save = json as unknown as CampaignSave;
  const repairs = repairIds(data, save.record);
  const warnings: string[] = [];
  const fp = campaignCatalog(data, save.record).fingerprint;
  if (save.fingerprint !== "" && save.fingerprint !== fp) warnings.push("data-changed");
  return { save, fromVersion, warnings, repairs };
}
