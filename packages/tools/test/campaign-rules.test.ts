/**
 * M12.1a: the campaign record and the rules between battles (plan docs/plans/m12-roster.md 4.3, owner answers
 * 2026-11-19). Synthetic results (the committed forces as they went in, changed by hand) test each rule exactly; a
 * short real chain (xf, AI both sides, an operation of two battles) tests reproducibility and the books.
 */
import { describe, expect, it } from "vitest";
import {
  addHoldings, appointLeaders, applyResult, bookedChange, campaignCatalog, campaignRules, canLead, clone, forceHoldings, hashRecord, holdingsDiff,
  membersOf, newCampaign, proposeCommit, replenish, runCampaignChain, unitsOf, type CampaignBattle, type CampaignRecord,
} from "@tcs/campaign";
import type { DataSet } from "@tcs/data";
import { buildScenario } from "@tcs/scenario";
import { createSim, newVehicleRecord, type BattleInput, type BattleResult, type ServiceTally, type SoldierRecord, type UnitInput } from "@tcs/sim";
import { aiRunner } from "../src/campaign";
import { loadData, ON_POSTS } from "../src/scenarios";

const data = loadData(true);
const rules = campaignRules(data);

type Out = { player: UnitInput[]; enemy: UnitInput[]; service: Record<string, ServiceTally> };

/** A battle as if fought: both sides' commits go in; `edit` changes what comes out. */
function fakeBattle(record: CampaignRecord, edit: (o: Out & { vehicles: { player: NonNullable<BattleResult["forcesOut"][number]["vehicles"]> } }) => void, seconds = 600): CampaignBattle {
  const pc = proposeCommit(data, record.sides.player), ec = proposeCommit(data, record.sides.enemy);
  const input = {
    seed: 7, forces: [
      { side: "blue", faction: record.sides.player.faction, units: pc.units, placements: [], vehicles: pc.vehicles },
      { side: "red", faction: record.sides.enemy.faction, units: ec.units, placements: [], vehicles: ec.vehicles },
    ],
  } as unknown as BattleInput;
  const o = { player: clone(pc.units), enemy: clone(ec.units), service: {} as Record<string, ServiceTally>, vehicles: { player: clone(pc.vehicles ?? []) } };
  for (const m of [...o.player, ...o.enemy].flatMap(membersOf)) o.service[m.personId] = { underFireS: 0, contactS: 0, roundsFired: 0, wounds: 0, peakShock: 0, peakStrain: 0 };
  edit(o);
  const result = {
    seed: 7, durationSeconds: seconds, endReason: "time-limit", winner: null, logistics: [], service: o.service,
    forcesOut: [{ side: "blue", faction: record.sides.player.faction, units: o.player, vehicles: o.vehicles.player }, { side: "red", faction: record.sides.enemy.faction, units: o.enemy, vehicles: clone(ec.vehicles ?? []) }],
  } as unknown as BattleResult;
  return { input, result, playerSide: "blue", kind: "attack", mapKind: "village", mapSeed: 1, attacker: "player" };
}

const fresh = (faction = "de", enemy = "ru") => newCampaign(data, { seed: 1, faction, enemy });
const squadOf = (units: UnitInput[]) => units.flatMap(unitsOf).find((u) => u.echelon === "squad" && u.members.length >= 6)!;
const findUnit = (u: UnitInput, key: string) => unitsOf(u).find((x) => x.key === key)!;
const manIn = (r: CampaignRecord, pid: string): SoldierRecord | undefined => membersOf(r.sides.player.battalion).find((m) => m.personId === pid);

describe("M12.1a campaign record", () => {
  it("builds both battalions from the manifests' battalion templates (DE, RU, xf), with their establishment", () => {
    for (const [f, e] of [["de", "ru"], ["ru", "de"], ["xf", "de"]] as const) {
      const r = newCampaign(data, { seed: 3, faction: f, enemy: e });
      const b = r.sides.player.battalion;
      expect(b.echelon).toBe("battalion");
      expect(b.subunits.filter((s) => s.echelon === "company")).toHaveLength(3);
      for (const u of unitsOf(b)) expect(r.sides.player.establishment[u.key], u.key).toBeDefined();
      const crews = unitsOf(b).filter((u) => u.vehicleId !== undefined).map((u) => u.vehicleId);
      expect(r.sides.player.vehicles.map((v) => v.vehicleId).sort()).toEqual([...crews].sort());
      expect(new Set(membersOf(b).map((m) => m.personId)).size).toBe(membersOf(b).length);
    }
    const de = newCampaign(data, { seed: 3, faction: "de", enemy: "ru" });
    expect(membersOf(de.sides.player.battalion).length).toBeGreaterThan(300);
    expect(hashRecord(de)).toBe(hashRecord(newCampaign(data, { seed: 3, faction: "de", enemy: "ru" })));
  });

  it("commits one company's worth: the fittest company's headquarters and platoons and the support, within the cap", () => {
    const r = fresh();
    const c = proposeCommit(data, r.sides.player);
    expect(c.units.filter((u) => u.echelon === "platoon")).toHaveLength(rules.battle.platoons);
    expect(c.units.filter((u) => u.echelon === "company")).toHaveLength(1);
    expect(c.units[0]!.subunits.every((s) => s.echelon !== "platoon")).toBe(true);
    expect(c.units.some((u) => u.echelon === "section")).toBe(true);
    // Every committed crew has its hull, every carrier named is there.
    const ids = new Set((c.vehicles ?? []).map((v) => v.vehicleId));
    for (const u of c.units.flatMap(unitsOf)) { if (u.vehicleId) expect(ids.has(u.vehicleId)).toBe(true); if (u.carrierId) expect(ids.has(u.carrierId)).toBe(true); }
    // A company down to a few men is not the fittest.
    const r2 = clone(r);
    for (const p of r2.sides.player.battalion.subunits[0]!.subunits) for (const u of unitsOf(p)) u.members = u.members.slice(0, 1);
    expect(proposeCommit(data, r2.sides.player).units[0]!.key).toBe("P/2");
    // It goes into a battle: the generator places it (DE vs RU mounted).
    const input = buildScenario(data, { kind: "attack", seed: 1, mapKind: "village", factions: ["de", "ru"], attacker: "blue", vehicles: true, timeLimitSeconds: 60, campaignOut: true, forces: [c, proposeCommit(data, r.sides.enemy)] }, ON_POSTS);
    expect(() => createSim(input)).not.toThrow();
  });

  it("a man hit in battle 1 with 5 recovery days recovers in the pool and is back in his squad after the replenishment", () => {
    let r = fresh();
    const sq = squadOf(proposeCommit(data, r.sides.player).units);
    const pid = sq.members[3]!.personId;
    r = applyResult(data, r, fakeBattle(r, (o) => {
      const m = findUnit(o.player[0]!.key === sq.key ? o.player[0]! : o.player.find((u) => unitsOf(u).some((x) => x.key === sq.key))!, sq.key).members[3]!;
      m.status = "evacuated"; m.recoveryDays = 5; m.wounds = [{ zone: "leg" } as unknown as SoldierRecord["wounds"][number]];
    }));
    expect(manIn(r, pid)).toBeUndefined();
    expect(r.sides.player.pools.recovering.map((p) => p.record.personId)).toContain(pid);
    for (let k = 1; k < rules.operation.battles; k++) r = applyResult(data, r, fakeBattle(r, () => {}));
    // 5 battles of an operation (12 h apart) are less than 5 days: still recovering, nobody replaced him.
    expect(r.sides.player.pools.recovering.find((p) => p.record.personId === pid)!.days).toBeGreaterThan(0);
    expect(findUnit(r.sides.player.battalion, sq.key).members).toHaveLength(sq.members.length - 1);
    const back = replenish(data, r);
    const m = findUnit(back.sides.player.battalion, sq.key).members.find((x) => x.personId === pid)!;
    expect(m).toBeDefined();
    expect(m.status).toBe("fit");
    expect(m.wounds).toEqual([]);
    expect(findUnit(back.sides.player.battalion, sq.key).members).toHaveLength(sq.members.length);
    expect(back.log.some((l) => l.kind === "rejoin" && l.personId === pid && l.unitKey === sq.key)).toBe(true);
    // His squad full (a man moved in meanwhile): he waits in the pool instead.
    const full = clone(r);
    const fs = findUnit(full.sides.player.battalion, sq.key);
    fs.members.push({ ...clone(fs.members[1]!), personId: "P#extra" });
    const out = replenish(data, full);
    expect(findUnit(out.sides.player.battalion, sq.key).members.some((x) => x.personId === pid)).toBe(false);
    expect(out.sides.player.pools.unassigned.map((p) => p.record.personId)).toContain(pid);
  });

  it("no replacement and no refill inside an operation; both at the replenishment", () => {
    let r = fresh();
    const start = clone(r);
    const cat = campaignCatalog(data, r);
    const c = proposeCommit(data, r.sides.player);
    const sq = squadOf(c.units);
    const dead = [sq.members[1]!.personId, sq.members[2]!.personId];
    const shooter = sq.members[0]!.personId;
    const hull = c.vehicles![0]!.vehicleId;
    r = applyResult(data, r, fakeBattle(r, (o) => {
      const s = o.player.flatMap(unitsOf).find((u) => u.key === sq.key)!;
      s.members[1]!.status = "killed"; s.members[2]!.status = "killed";
      const mag = s.members[0]!.load.find((l) => l.charge !== undefined)!;
      mag.count = 1; mag.charge = 3;
      const v = o.vehicles.player.find((x) => x.vehicleId === hull)!;
      v.load[0]!.charge = 17;
    }));
    for (let k = 1; k < rules.operation.battles; k++) r = applyResult(data, r, fakeBattle(r, () => {}));
    const men0 = membersOf(start.sides.player.battalion).length;
    expect(membersOf(r.sides.player.battalion)).toHaveLength(men0 - 2);
    expect(r.log.filter((l) => l.kind === "replacement" || l.kind === "refill" || l.kind === "replenishment")).toEqual([]);
    expect(r.consumption.filter((c) => c.kind === "replenishment")).toEqual([]);
    expect(manIn(r, shooter)!.load.find((l) => l.charge !== undefined)).toMatchObject({ count: 1, charge: 3 });
    expect(r.sides.player.vehicles.find((v) => v.vehicleId === hull)!.load[0]!.charge).toBe(17);
    expect(r.sides.player.pools.dead.map((p) => p.record.personId).sort()).toEqual([...dead].sort());
    // Replenishment: green men (new ids) in both places, every load and hull back to the standard.
    const after = replenish(data, r);
    expect(membersOf(after.sides.player.battalion)).toHaveLength(men0);
    const fresh_ = after.log.filter((l) => l.kind === "replacement" && l.side === "player");
    expect(fresh_).toHaveLength(2);
    const startIds = new Set(membersOf(start.sides.player.battalion).map((m) => m.personId));
    for (const l of fresh_) {
      expect(startIds.has(l.personId!)).toBe(false);
      const m = manIn(after, l.personId!)!;
      expect(m.skills["experience"]!).toBeLessThan(0.35); // conscript level
    }
    expect(manIn(after, shooter)!.load).toEqual(membersOf(start.sides.player.battalion).find((m) => m.personId === shooter)!.load);
    const v = after.sides.player.vehicles.find((x) => x.vehicleId === hull)!;
    expect(v.load).toEqual(newVehicleRecord(cat, v.type, v.vehicleId).load);
    const del = after.consumption.find((x) => x.kind === "replenishment" && x.side === "player")!.delivered!;
    expect(Object.values(del.charge).reduce((x, y) => x + y, 0)).toBeGreaterThan(0);
    expect(Object.values(del.ammo).reduce((x, y) => x + y, 0)).toBeGreaterThan(0);
    // The books balance: start + delivered - battles' net - written off = now.
    expect(holdingsDiff(forceHoldings(cat, after.sides.player), addHoldings(forceHoldings(cat, start.sides.player), bookedChange(after, "player")))).toEqual({});
    expect(after.operation).toEqual({ index: 1, battles: 0 });
  });

  it("a unit's leader killed: the deputy leads the next battle (squad, platoon from its sub-units, never a medic)", () => {
    let r = fresh();
    const c = proposeCommit(data, r.sides.player);
    const plat = c.units.find((u) => u.echelon === "platoon")!;
    const sq = plat.subunits.find((u) => u.echelon === "squad")!;
    r = applyResult(data, r, fakeBattle(r, (o) => {
      const p = o.player.find((u) => u.key === plat.key)!;
      p.members[p.leaderIndex]!.status = "killed";
      const s = p.subunits.find((u) => u.key === sq.key)!;
      s.members[s.leaderIndex]!.status = "killed";
    }));
    const P = data.factions["de"]!;
    const expectBest = (men: SoldierRecord[]) => [...men].filter((m) => canLead(data, "de", m))
      .sort((a, b) => (P.roles[b.role]?.leader === true ? 1 : 0) - (P.roles[a.role]?.leader === true ? 1 : 0) || P.ranks[b.rank]!.grade - P.ranks[a.rank]!.grade || (b.skills["experience"] ?? 0) - (a.skills["experience"] ?? 0))[0]!;
    // The squad: its best man (leader's role, rank, experience).
    const s1 = findUnit(r.sides.player.battalion, sq.key);
    const sqLeader = s1.members[s1.leaderIndex]!;
    expect(sqLeader.personId).toBe(expectBest(sq.members.filter((m, i) => i !== sq.leaderIndex)).personId);
    // The platoon: its headquarters has only the Funker and the Sanitaeter left: the Zugtruppfuehrer (the
    // headquarters Puma's commander, a Hauptfeldwebel) moves up and leads; the medic never does.
    const p1 = findUnit(r.sides.player.battalion, plat.key);
    const pl = p1.members[p1.leaderIndex]!;
    expect(pl.rank).toBe("hauptfeldwebel");
    expect(canLead(data, "de", pl)).toBe(true);
    expect(r.log.filter((l) => l.kind === "leader" && l.side === "player").map((l) => l.unitKey)).toEqual(expect.arrayContaining([plat.key, sq.key]));
    expect(r.log.find((l) => l.kind === "leader" && l.unitKey === plat.key)).toMatchObject({ how: "sub", replaced: plat.members[plat.leaderIndex]!.personId });
    // In the next battle he leads: the unit's leader in the sim is him. (The other companies made weaker, so that his
    // is still the fittest.)
    for (const co of r.sides.player.battalion.subunits) if (co.echelon === "company" && co.key !== c.units[0]!.key) for (const u of unitsOf(co)) if (u.echelon === "squad") u.members = u.members.slice(0, 3);
    const next = proposeCommit(data, r.sides.player);
    expect(next.units[0]!.key).toBe(c.units[0]!.key);
    const input = buildScenario(data, { kind: "attack", seed: 2, mapKind: "village", factions: ["de", "ru"], attacker: "blue", vehicles: true, timeLimitSeconds: 60, campaignOut: true, forces: [next, proposeCommit(data, r.sides.enemy)] }, ON_POSTS);
    const sim = createSim(input);
    const leads = (pid: string) => {
      for (const [id, ident] of sim.state.identity.entries()) if (ident.personId === pid) return sim.state.unit.get(ident.unit)?.leader === id;
      return false;
    };
    expect(leads(pl.personId)).toBe(true);
    expect(leads(sqLeader.personId)).toBe(true);
  });

  it("appointLeaders leaves a unit with a leader alone and never picks medical personnel", () => {
    const r = fresh();
    const f = clone(r.sides.player);
    expect(appointLeaders(data, f, 0, "player")).toEqual([]);
    const plat = unitsOf(f.battalion).find((u) => u.echelon === "platoon")!;
    // Only the medic left in the headquarters, no sub-units: nobody is appointed.
    plat.members = plat.members.filter((m) => !canLead(data, "de", m));
    plat.leaderIndex = -1;
    plat.subunits = [];
    expect(appointLeaders(data, f, 0, "player")).toEqual([]);
    expect(plat.leaderIndex).toBe(-1);
  });

  it("experience grows more under fire, capped per battle and overall; the stress history keeps every battle", () => {
    let r = fresh();
    const sq = squadOf(proposeCommit(data, r.sides.player).units);
    const [a, b, c] = [sq.members[1]!.personId, sq.members[2]!.personId, sq.members[3]!.personId];
    // c starts just below the cap.
    findUnit(r.sides.player.battalion, sq.key).members[3]!.skills["experience"] = rules.experience.cap - 0.001;
    const xp0 = (pid: string) => manIn(r, pid)!.skills["experience"]!;
    const a0 = xp0(a), b0 = xp0(b);
    const shocks: number[] = [];
    const startXp = new Map(membersOf(r.sides.player.battalion).map((m) => [m.personId, m.skills["experience"] ?? 0]));
    for (let k = 0; k < 30; k++) {
      r = applyResult(data, r, fakeBattle(r, (o) => {
        o.service[a] = { ...o.service[a]!, underFireS: 900, peakShock: 0.5 + k / 100, peakStrain: 0.3 };
        o.service[c] = { ...o.service[c]!, underFireS: 3600 };
        shocks.push(0.5 + k / 100);
      }));
      if (k === 0) {
        const ga = xp0(a) - a0, gb = xp0(b) - b0;
        expect(gb).toBeCloseTo(rules.experience.perBattle, 9);
        expect(ga).toBeGreaterThan(gb);
        expect(ga).toBeLessThanOrEqual(rules.experience.capPerBattle + 1e-12);
      }
      for (const m of membersOf(r.sides.player.battalion)) expect(m.skills["experience"]!).toBeLessThanOrEqual(Math.max(rules.experience.cap, 1e-9 + (startXp.get(m.personId) ?? 0)));
    }
    expect(xp0(c)).toBeLessThanOrEqual(rules.experience.cap);
    expect(xp0(a)).toBeLessThanOrEqual(rules.experience.cap);
    const hist = r.sides.player.service[a]!;
    expect(hist.map((e) => e.battle)).toEqual([...Array(30).keys()]);
    expect(hist.map((e) => e.peakShock)).toEqual(shocks);
    expect(hist[0]!.underFireMin).toBe(15);
    // Shock and fatigue recover between battles.
    expect(manIn(r, a)!.stress).toBe(0);
  }, 120_000);

  it("the dead keep their history; their loads are written off; the enemy's captured men are in the player's prisoners", () => {
    let r = fresh();
    const sq = squadOf(proposeCommit(data, r.sides.player).units);
    const esq = squadOf(proposeCommit(data, r.sides.enemy).units);
    const pid = sq.members[2]!.personId, eid = esq.members[2]!.personId;
    r = applyResult(data, r, fakeBattle(r, (o) => {
      o.player.flatMap(unitsOf).find((u) => u.key === sq.key)!.members[2]!.status = "killed";
      o.enemy.flatMap(unitsOf).find((u) => u.key === esq.key)!.members[2]!.status = "captured";
      o.service[pid] = { ...o.service[pid]!, underFireS: 30 };
    }));
    expect(r.sides.player.service[pid]).toHaveLength(1);
    expect(r.sides.player.service[pid]![0]!.status).toBe("killed");
    expect(r.sides.enemy.pools.heldByEnemy.map((p) => p.record.personId)).toEqual([eid]);
    expect(r.sides.player.pools.prisoners.map((p) => p.personId)).toEqual([eid]);
    expect(Object.keys(r.consumption.find((c) => c.side === "player")!.writtenOff!.items).length).toBeGreaterThan(0);
  });

  it("hulls: destroyed lost (replaced at replenishment with a new id, crew kept), recovered to the workshop and back when repaired", () => {
    let r = fresh();
    const c = proposeCommit(data, r.sides.player);
    const [h1, h2] = [c.vehicles![1]!.vehicleId, c.vehicles![2]!.vehicleId];
    r = applyResult(data, r, fakeBattle(r, (o) => {
      const a = o.vehicles.player.find((v) => v.vehicleId === h1)!; a.status = "destroyed"; a.recovery = { state: "lost", tick: 1 };
      const b = o.vehicles.player.find((v) => v.vehicleId === h2)!; b.status = "immobilised"; b.components = (b.components ?? [1, 1, 1]).map(() => 0.2); b.recovery = { state: "recovered", tick: 1, repairDays: 1 };
    }));
    const f = r.sides.player;
    expect(f.vehicles.some((v) => v.vehicleId === h1 || v.vehicleId === h2)).toBe(false);
    expect(f.lostHulls.map((l) => l.vehicleId)).toEqual([h1]);
    // 600 s + 12 h: the workshop's day is not up yet; after the next battle it is.
    expect(f.workshop.map((w) => w.record.vehicleId)).toEqual([h2]);
    // Its crew does not fight without it.
    expect(proposeCommit(data, f).units.flatMap(unitsOf).some((u) => u.vehicleId === h2)).toBe(false);
    r = applyResult(data, r, fakeBattle(r, () => {}));
    const back = r.sides.player.vehicles.find((v) => v.vehicleId === h2)!;
    expect(back.status).toBe("ok");
    expect(back.components).toBeUndefined();
    const after = replenish(data, r);
    const crew = unitsOf(after.sides.player.battalion).find((u) => u.key === h1)!;
    expect(crew.vehicleId).not.toBe(h1);
    expect(after.sides.player.vehicles.some((v) => v.vehicleId === crew.vehicleId)).toBe(true);
    expect(after.sides.player.lostHulls).toEqual([]);
  });

  it("a real chain (xf against DE, AI both sides, operations of two battles) is reproducible and its books balance", () => {
    const d2: DataSet = { ...data, campaign: { campaign: { ...rules, operation: { battles: 2 } } } };
    const run = () => runCampaignChain(d2, { seed: 4, faction: "xf", enemy: "de", battles: 4, timeLimitSeconds: 90, hooks: ON_POSTS }, aiRunner);
    const a = run(), b = run();
    expect(a.end).toBe("done");
    expect(a.record.battles).toBe(4);
    expect(hashRecord(a.record)).toBe(hashRecord(b.record));
    // A replenishment after battles 2 only (not after the last).
    expect(a.record.consumption.filter((c) => c.kind === "replenishment").map((c) => c.battle)).toEqual([2, 2]);
    const cat = campaignCatalog(d2, a.record);
    const start = newCampaign(d2, { seed: 4, faction: "xf", enemy: "de" });
    for (const s of ["player", "enemy"] as const) {
      expect(holdingsDiff(forceHoldings(cat, a.record.sides[s]), addHoldings(forceHoldings(cat, start.sides[s]), bookedChange(a.record, s))), s).toEqual({});
    }
    // Something was fought: rounds fired and somebody's service history.
    expect(a.record.consumption.filter((c) => c.kind === "battle").some((c) => Object.keys(c.fired ?? {}).length > 0)).toBe(true);
    expect(Object.keys(a.record.sides.player.service).length).toBeGreaterThan(0);
  }, 300_000);
});
