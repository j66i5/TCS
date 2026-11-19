/**
 * M12.1b campaign saves (plan docs/plans/m12-roster.md 4.4): a chain saved after battle 3, loaded and continued to
 * battle 6 gives the record of an uninterrupted chain; the version-1 fixture (a bare M12.1a record, as `npm run
 * campaign -- chain` wrote it) migrates and continues; a corrupted id set is repaired and continues.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  addHoldings, bookedChange, campaignCatalog, campaignRules, CAMPAIGN_VERSION, clone, continueCampaignChain, exportSave, forceHoldings, hashRecord, holdingsDiff,
  makeSave, membersOf, migrate, newCampaign, readSave, runCampaignChain, SaveError, unitsOf, type CampaignRecord,
} from "@tcs/campaign";
import type { DataSet } from "@tcs/data";
import { aiRunner } from "../src/campaign";
import { loadData, ON_POSTS } from "../src/scenarios";

const data = loadData(true);
const rules = campaignRules(data);
/** Operations of 3 battles: the replenishment falls after the save (battle 3), inside the continued part. */
const d3: DataSet = { ...data, campaign: { campaign: { ...rules, operation: { battles: 3 } } } };
const FIXTURE = new URL("../../campaign/test/fixtures/campaign-v1.json", import.meta.url);
const CHAIN = { seed: 6, faction: "xf", enemy: "xf", battles: 6, timeLimitSeconds: 90, hooks: ON_POSTS };

function idsUnique(r: CampaignRecord): void {
  const pids: string[] = [];
  for (const s of ["player", "enemy"] as const) {
    const f = r.sides[s];
    pids.push(...membersOf(f.battalion).map((m) => m.personId));
    for (const k of ["recovering", "dead", "missing", "heldByEnemy", "replacements", "unassigned"] as const) pids.push(...f.pools[k].map((p) => p.record.personId));
    const hulls = [...f.vehicles.map((v) => v.vehicleId), ...f.workshop.map((w) => w.record.vehicleId)];
    expect(new Set(hulls).size, `${s} hull ids`).toBe(hulls.length);
    const known = new Set([...hulls, ...f.lostHulls.map((l) => l.vehicleId)]);
    for (const u of unitsOf(f.battalion)) {
      if (u.vehicleId !== undefined) expect(known.has(u.vehicleId), `${u.key} crews ${u.vehicleId}`).toBe(true);
      if (u.carrierId !== undefined) expect(known.has(u.carrierId), `${u.key} rides ${u.carrierId}`).toBe(true);
      expect(u.leaderIndex).toBeGreaterThanOrEqual(-1);
      expect(u.leaderIndex).toBeLessThan(Math.max(u.members.length, 0) || 1);
    }
  }
  expect(pids.every((p) => typeof p === "string" && p !== "")).toBe(true);
  expect(new Set(pids).size).toBe(pids.length);
}

function booksBalance(d: DataSet, r: CampaignRecord, start: CampaignRecord): void {
  const cat = campaignCatalog(d, r);
  for (const s of ["player", "enemy"] as const) {
    expect(holdingsDiff(forceHoldings(cat, r.sides[s]), addHoldings(forceHoldings(cat, start.sides[s]), bookedChange(r, s))), s).toEqual({});
  }
}

describe("M12.1b campaign saves", () => {
  it("save after battle 3 -> export -> load -> continue to battle 6 = the uninterrupted chain (record hash)", () => {
    let saved = "";
    const whole = runCampaignChain(d3, { ...CHAIN, onStep: (r, step) => { if (step.kind === "battle" && r.battles === 3) saved = exportSave(makeSave(d3, r, "before-4", "2026-11-19T12:00:00Z")); } }, aiRunner);
    expect(whole.end).toBe("done");
    expect(whole.record.battles).toBe(6);
    expect(whole.record.consumption.filter((c) => c.kind === "replenishment").map((c) => c.battle)).toEqual([3, 3]);
    expect(saved).not.toBe("");
    const loaded = readSave(d3, saved);
    expect(loaded.fromVersion).toBe(CAMPAIGN_VERSION);
    expect(loaded.repairs).toEqual([]);
    expect(loaded.warnings).toEqual([]);
    expect(loaded.save.record.battles).toBe(3);
    const cont = continueCampaignChain(d3, loaded.save.record, CHAIN, aiRunner);
    expect(cont.end).toBe("done");
    expect(hashRecord(cont.record)).toBe(hashRecord(whole.record));
    booksBalance(d3, cont.record, newCampaign(d3, CHAIN));
  }, 300_000);

  it("the version-1 fixture (a bare M12.1a record) migrates to the current version and continues", () => {
    const text = readFileSync(FIXTURE, "utf8");
    const v1 = JSON.parse(text) as CampaignRecord;
    expect(v1.version).toBe(1);
    const loaded = readSave(data, text);
    expect(loaded.fromVersion).toBe(1);
    expect(loaded.save.version).toBe(CAMPAIGN_VERSION);
    expect(loaded.save.slotName).toBe("imported");
    expect(loaded.save.fingerprint).toBe("");
    expect(loaded.repairs).toEqual([]);
    expect(loaded.warnings).toEqual([]);
    // Nothing but the version changed.
    expect({ ...loaded.save.record, version: 1 }).toEqual(v1);
    const before = loaded.save.record.battles;
    const run = () => continueCampaignChain(data, clone(loaded.save.record), { battles: before + 2, timeLimitSeconds: 90, hooks: ON_POSTS }, aiRunner);
    const a = run(), b = run();
    expect(a.end).toBe("done");
    expect(a.record.battles).toBe(before + 2);
    expect(a.record.history).toHaveLength(before + 2);
    expect(hashRecord(a.record)).toBe(hashRecord(b.record));
    booksBalance(data, a.record, newCampaign(data, { seed: v1.seed, faction: "xf", enemy: "xf" }));
    // Saved again, it is a current save.
    expect(readSave(data, exportSave(makeSave(data, a.record, "x", ""))).fromVersion).toBe(CAMPAIGN_VERSION);
  }, 300_000);

  it("a corrupted id set is repaired on load (duplicates and missing ids renamed, links and leaders checked, counters raised) and the campaign continues", () => {
    const r = readSave(data, readFileSync(FIXTURE, "utf8")).save.record;
    const p = r.sides.player, e = r.sides.enemy;
    const men = membersOf(p.battalion);
    const units = unitsOf(p.battalion);
    // Two men with one id, a man without one, a recovering man with a battalion man's id, a player man with an enemy id.
    men[5]!.personId = men[4]!.personId;
    (men[6] as { personId?: string }).personId = undefined;
    men[7]!.personId = membersOf(e.battalion)[3]!.personId;
    p.pools.recovering.push({ record: { ...clone(men[8]!), status: "evacuated" }, unitKey: "P/1", battle: 1, days: 3 });
    // Two hulls (and their crews) with one id.
    const [h0, h1] = p.vehicles;
    const crew1 = units.find((u) => u.vehicleId === h1!.vehicleId)!;
    const type1 = h1!.type, h1Old = h1!.vehicleId;
    h1!.vehicleId = h0!.vehicleId;
    crew1.vehicleId = h0!.vehicleId;
    // Links to hulls the force does not have, a leader beyond his unit, counters set back.
    const walkers = units.find((u) => u.vehicleId !== undefined && u !== crew1 && u.vehicleId !== h0!.vehicleId)!;
    walkers.vehicleId = "P/nowhere";
    const riders = units.find((u) => u.carrierId !== undefined)!;
    riders.carrierId = "P/ghost";
    const led = units.find((u) => u.leaderIndex >= 0 && u.members.length > 1)!;
    led.leaderIndex = 99;
    p.nextPersonId = 0;
    p.nextHullSerial = 0;
    const save = makeSave(data, r, "broken", "");
    const loaded = readSave(data, exportSave(save));
    const kinds = loaded.repairs.map((x) => `${x.side}:${x.kind}`);
    expect(kinds.filter((k) => k === "player:person-id")).toHaveLength(4);
    expect(kinds).toContain("player:hull-id");
    expect(kinds).toContain("player:crew-link");
    expect(kinds).toContain("player:carrier-link");
    expect(kinds).toContain("player:leader");
    expect(kinds).toContain("player:next-person");
    expect(kinds).toContain("player:next-hull");
    expect(kinds.some((k) => k.startsWith("enemy:"))).toBe(false);
    const fixed = loaded.save.record;
    idsUnique(fixed);
    // The duplicated hull got a new id and its own crew followed it; the first keeps the old id and crew.
    const fp = fixed.sides.player;
    const renamed = fp.vehicles.find((v) => v.vehicleId.startsWith(h0!.vehicleId.split("~")[0]!) && v.vehicleId !== h0!.vehicleId && v.type === type1)!;
    expect(renamed).toBeDefined();
    expect(renamed.vehicleId).not.toBe(h1Old);
    expect(unitsOf(fp.battalion).find((u) => u.key === crew1.key)!.vehicleId).toBe(renamed.vehicleId);
    expect(unitsOf(fp.battalion).find((u) => u.key === walkers.key)!.vehicleId).toBeUndefined();
    expect(unitsOf(fp.battalion).find((u) => u.key === riders.key)!.carrierId).toBeUndefined();
    const led2 = unitsOf(fp.battalion).find((u) => u.key === led.key)!;
    expect(led2.leaderIndex).toBeGreaterThanOrEqual(0);
    expect(led2.leaderIndex).toBeLessThan(led2.members.length);
    // Counters past every id in use.
    const serial = (id: string, sep: string) => Number(id.slice(id.lastIndexOf(sep) + 1));
    expect(fp.nextPersonId).toBeGreaterThan(Math.max(...membersOf(fp.battalion).map((m) => serial(m.personId, "#"))));
    expect(fp.nextHullSerial).toBeGreaterThan(serial(renamed.vehicleId, "~"));
    // Loading the repaired save again changes nothing.
    expect(readSave(data, exportSave(loaded.save)).repairs).toEqual([]);
    // And it fights on.
    const cont = continueCampaignChain(data, fixed, { battles: fixed.battles + 2, timeLimitSeconds: 90, hooks: ON_POSTS }, aiRunner);
    expect(cont.end).toBe("done");
    expect(cont.record.battles).toBe(fixed.battles + 2);
    idsUnique(cont.record);
  }, 300_000);

  it("refuses what it cannot read; a newer version is refused; changed data warns and loads", () => {
    const fresh = newCampaign(data, { seed: 2, faction: "xf", enemy: "xf" });
    const good = makeSave(data, fresh, "a", "t");
    expect(() => readSave(data, "{not json")).toThrow(SaveError);
    expect(() => readSave(data, "[]")).toThrow(SaveError);
    expect(() => readSave(data, JSON.stringify({ ...good, version: CAMPAIGN_VERSION + 1 }))).toThrow(/newer/);
    const damaged = clone(good) as unknown as { record: { sides: { enemy: unknown; player: { battalion: { members: unknown } } } } };
    damaged.record.sides.enemy = null;
    damaged.record.sides.player.battalion.members = 3;
    try { readSave(data, JSON.stringify(damaged)); expect.unreachable(); } catch (e) {
      expect(e).toBeInstanceOf(SaveError);
      expect((e as SaveError).problems).toEqual(expect.arrayContaining(["record.sides.enemy", "record.sides.player.battalion.members"]));
    }
    const other = readSave(data, JSON.stringify({ ...good, fingerprint: "0000000000000000" }));
    expect(other.warnings).toEqual(["data-changed"]);
    expect(hashRecord(other.save.record)).toBe(hashRecord(fresh));
    // The migration table runs in order and checks each step.
    expect(migrate({ ...fresh, version: 1 }).json["version"]).toBe(CAMPAIGN_VERSION);
    expect(() => migrate({ version: 0 })).toThrow(SaveError);
  });
});
