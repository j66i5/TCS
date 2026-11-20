/**
 * M12 review fixes (DECISIONS "M12 review"): deployable men (crews of hulls in the workshop or lost do not count, a
 * flank company that cannot fight gives no flank battle), walking wounded without recovery days heal, hulls in the
 * workshop are refilled at a replenishment, the endless run keeps a bounded list of steps, saves carry a rules
 * fingerprint and refuse unknown node types.
 */
import { describe, expect, it } from "vitest";
import {
  addHoldings, advance, applyResult, ableShare, battleInputs, bookedChange, campaignCatalog, chooseForces, clone, confirmForces, deployableMen, ENDLESS_STEPS_KEPT,
  exportSave, forceHoldings, generateOperation, holdingsDiff, makeSave, membersOf, newCampaign, nodesFought, proposeChoice, proposeCommit, readSave, replenish,
  SaveError, selectables, startFlow, unitsOf, validateCommit, type CampaignBattle, type CampaignRecord,
} from "@tcs/campaign";
import type { DataSet } from "@tcs/data";
import { newVehicleRecord, type BattleInput, type BattleResult, type ServiceTally, type SoldierRecord, type UnitInput } from "@tcs/sim";
import { loadData, ON_POSTS } from "../src/scenarios";

const data = loadData(true);

type Out = { player: UnitInput[]; enemy: UnitInput[]; service: Record<string, ServiceTally> };

/** A battle as if fought (campaign-rules.test.ts): both sides' commits go in; `edit` changes what comes out. */
function fakeBattle(record: CampaignRecord, edit: (o: Out) => void, seconds = 600): CampaignBattle {
  const pc = proposeCommit(data, record.sides.player), ec = proposeCommit(data, record.sides.enemy);
  const input = {
    seed: 7, forces: [
      { side: "blue", faction: record.sides.player.faction, units: pc.units, placements: [], vehicles: pc.vehicles },
      { side: "red", faction: record.sides.enemy.faction, units: ec.units, placements: [], vehicles: ec.vehicles },
    ],
  } as unknown as BattleInput;
  const o: Out = { player: clone(pc.units), enemy: clone(ec.units), service: {} };
  for (const m of [...o.player, ...o.enemy].flatMap(membersOf)) o.service[m.personId] = { underFireS: 0, contactS: 0, roundsFired: 0, wounds: 0, peakShock: 0, peakStrain: 0 };
  edit(o);
  const result = {
    seed: 7, durationSeconds: seconds, endReason: "time-limit", winner: null, logistics: [], service: o.service,
    forcesOut: [{ side: "blue", faction: record.sides.player.faction, units: o.player, vehicles: clone(pc.vehicles ?? []) }, { side: "red", faction: record.sides.enemy.faction, units: o.enemy, vehicles: clone(ec.vehicles ?? []) }],
  } as unknown as BattleResult;
  return { input, result, playerSide: "blue", kind: "attack", mapKind: "village", mapSeed: 1, attacker: "player" };
}

/** The hulls of a company (its crews' hull ids) sent to the workshop for `days`, and its men without a hull removed:
 *  what is left of the company is the crews of hulls not in service. */
function idleCrewsOnly(r: CampaignRecord, companyKey: string, days = 100): void {
  const f = r.sides.player;
  const c = f.battalion.subunits.find((u) => u.key === companyKey)!;
  const ids = new Set(unitsOf(c).filter((u) => u.vehicleId !== undefined).map((u) => u.vehicleId!));
  for (const u of unitsOf(c)) if (u.vehicleId === undefined) u.members = [];
  f.workshop.push(...f.vehicles.filter((v) => ids.has(v.vehicleId)).map((record) => ({ record, days, battle: 0 })));
  f.vehicles = f.vehicles.filter((v) => !ids.has(v.vehicleId));
}

const manIn = (r: CampaignRecord, pid: string): SoldierRecord | undefined => membersOf(r.sides.player.battalion).find((m) => m.personId === pid);
const wound = (mechanism: string) => ({ id: 1, zone: "leg", mechanism, severity: 0.2 } as unknown as SoldierRecord["wounds"][number]);

describe("M12 review: deployable men", () => {
  it("crews of hulls in the workshop are not deployable: no company of idle crews is proposed, the battle never has 0 men (code review p2)", () => {
    const r = newCampaign(data, { seed: 1, faction: "de", enemy: "ru" });
    const f = r.sides.player;
    for (const c of f.battalion.subunits.filter((u) => u.echelon === "company")) idleCrewsOnly(r, c.key);
    // (Before the fix every member counted: a company of crews whose hulls were all in the workshop was proposed.)
    expect(membersOf(f.battalion.subunits[0]!).length).toBeGreaterThan(0);
    expect(deployableMen(f, f.battalion.subunits[0]!)).toBe(0);
    expect(selectables(data, f).filter((s) => s.what === "platoon" || s.what === "hq").every((s) => s.men === 0)).toBe(true);
    expect(proposeChoice(data, f).filter((k) => f.battalion.subunits.some((c) => c.key === k || c.subunits.some((p) => p.key === k)))).toEqual([]);
    expect(validateCommit(data, f, ["P/1", "P/1/1"])).toContain("no able platoon");
    expect(ableShare(data, f)).toBeLessThan(0.2);
  });

  it("a flank company of idle crews gives no flank battle; the main battle is built (code review p3)", () => {
    let r = startFlow(data, newCampaign(data, { seed: 2, faction: "de", enemy: "ru", battleSeconds: 60 }));
    idleCrewsOnly(r, "P/2");
    idleCrewsOnly(r, "P/3");
    r.op!.flank = { node: "attack", sector: r.op!.line[0]! };
    r = confirmForces(data, chooseForces(data, r));
    expect(r.flow!.choice!.some((k) => k.startsWith("P/1"))).toBe(true);
    expect(r.flow!.flankChoice).toBeUndefined();
    const nb = battleInputs(data, r, ON_POSTS);
    expect(nb.main).not.toBeNull();
    expect(nb.flank).toBeNull();
    // A damaged save whose confirmed choice cannot fight is refused when the battle is built (not a 0-men battle).
    const bad = clone(r);
    bad.flow!.choice = ["P/2/1"];
    expect(() => battleInputs(data, bad, ON_POSTS)).toThrow(/cannot fight/);
  });
});

describe("M12 review: walking wounded and the workshop at a replenishment", () => {
  it("bruises only: healed after the battle; other wounds without days: walkingWoundedDays, then healed with his unit", () => {
    let r = newCampaign(data, { seed: 1, faction: "de", enemy: "ru" });
    const sq = proposeCommit(data, r.sides.player).units.flatMap(unitsOf).find((u) => u.echelon === "squad" && u.members.length >= 6)!;
    const bruised = sq.members[2]!.personId, hurt = sq.members[3]!.personId;
    r = applyResult(data, r, fakeBattle(r, (o) => {
      const s = o.player.flatMap(unitsOf).find((u) => u.key === sq.key)!;
      Object.assign(s.members[2]!, { status: "wounded", wounds: [wound("blunt"), wound("blunt")] });
      Object.assign(s.members[3]!, { status: "wounded", wounds: [wound("bullet")] }); // (e.g. out by an exit zone: never in care)
    }));
    expect(manIn(r, bruised)).toMatchObject({ status: "fit", wounds: [] });
    const h = manIn(r, hurt)!;
    expect(h.status).toBe("wounded");
    expect(h.recoveryDays).toBeGreaterThan(0);
    expect(h.recoveryDays).toBeLessThanOrEqual(data.campaign!.campaign.recovery.walkingWoundedDays!);
    for (let k = 0; k < 6; k++) r = applyResult(data, r, fakeBattle(r, () => {}));
    expect(manIn(r, hurt)).toMatchObject({ status: "fit", wounds: [] });
    expect(manIn(r, hurt)!.recoveryDays).toBeUndefined();
  });

  it("a hull in the workshop is refilled at the replenishment (its repair goes on); the books balance", () => {
    let r = newCampaign(data, { seed: 1, faction: "de", enemy: "ru" });
    const start = clone(r);
    const cat = campaignCatalog(data, r);
    const f = r.sides.player;
    const v = f.vehicles[0]!;
    v.load[0]!.charge = 17;
    v.status = "immobilised" as typeof v.status;
    f.workshop.push({ record: v, days: 30, battle: 0 });
    f.vehicles = f.vehicles.slice(1);
    // (The hull's fuel left the books when it went in short: booked as a battle's net, as applyResult would.)
    const net = { ammo: {}, charge: {}, items: {} } as ReturnType<typeof forceHoldings>;
    addHoldings(net, holdingsDiffAsHoldings(forceHoldings(cat, start.sides.player), forceHoldings(cat, f)));
    r.consumption.push({ battle: 0, side: "player", kind: "battle", fired: {}, net, writtenOff: { ammo: {}, charge: {}, items: {} } });
    const after = replenish(data, r);
    const w = after.sides.player.workshop.find((x) => x.record.vehicleId === v.vehicleId)!;
    expect(w.days).toBeGreaterThan(0);
    expect(w.record.load).toEqual(newVehicleRecord(cat, v.type, v.vehicleId).load);
    expect(holdingsDiff(forceHoldings(cat, after.sides.player), addHoldings(forceHoldings(cat, start.sides.player), bookedChange(after, "player")))).toEqual({});
  });
});

/** a - b as holdings (what left between b and a, as a battle's `net`: in minus out). */
function holdingsDiffAsHoldings(a: ReturnType<typeof forceHoldings>, b: ReturnType<typeof forceHoldings>): ReturnType<typeof forceHoldings> {
  const out = { ammo: {}, charge: {}, items: {} } as ReturnType<typeof forceHoldings>;
  addHoldings(out, a);
  addHoldings(out, b, -1);
  return out;
}

describe("M12 review: the endless run's steps", () => {
  it("keeps the last ENDLESS_STEPS_KEPT steps; the sector rhythm counts the dropped ones", () => {
    const r = generateOperation(data, newCampaign(data, { seed: 4, faction: "xf", enemy: "xf", mode: "endless" }));
    const op = r.op!;
    const first = op.nextSectorId;
    for (let k = 0; k < 40; k++) {
      op.steps.push({ node: op.node, sector: op.line[op.pos]!, pos: op.pos, result: "draw" });
      advance(data, r, "draw", true);
    }
    expect(op.steps.length).toBe(ENDLESS_STEPS_KEPT);
    expect(nodesFought(op)).toBe(40);
    // A new sector every `sectorEvery` (2) nodes: 20, flank sectors besides.
    expect(op.nextSectorId - first).toBeGreaterThanOrEqual(20);
  });
});

describe("M12 review: saves check the campaign rules", () => {
  const r = startFlow(data, newCampaign(data, { seed: 5, faction: "xf", enemy: "xf", battleSeconds: 60 }));
  const text = exportSave(makeSave(data, r, "one", "t"));
  it("a change to core/campaign.json or a faction's campaign block warns rules-changed (the catalog fingerprint is the same)", () => {
    expect(readSave(data, text).warnings).toEqual([]);
    const changed: DataSet = { ...data, campaign: { campaign: { ...data.campaign!.campaign, combatIneffective: 0.4 } } };
    expect(readSave(changed, text).warnings).toEqual(["rules-changed"]);
    const fv: DataSet = { ...data, factions: { ...data.factions, xf: { ...data.factions["xf"]!, campaign: { fightingValue: 2 } as never } } };
    expect(readSave(fv, text).warnings).toEqual(["rules-changed"]);
  });
  it("an operation node the rules do not have is refused on load", () => {
    const bad = JSON.parse(text) as { record: CampaignRecord };
    bad.record.op!.node = "no-such-node";
    try { readSave(data, JSON.stringify(bad)); expect.unreachable(); } catch (e) {
      expect(e).toBeInstanceOf(SaveError);
      expect((e as SaveError).problems.join(" ")).toMatch(/no-such-node/);
    }
  });
});
