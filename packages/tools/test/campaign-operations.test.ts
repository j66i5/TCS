/**
 * M12.2 linked operations and endless mode (plan docs/plans/m12-roster.md 4.5): the transition table, operations of
 * 3-5 nodes, sector memory (craters, holes and wrecks handed to the sector's next battle), the enemy's roster
 * remembered between battles, replenishments only between operations (endless: every `replenishEvery` nodes), the
 * choice and its validation, the state machine (played and auto-resolved battles give the same record), saves in the
 * middle of the flow, and reproducibility. Real battles with the fixture faction (xf against xf, 90 s each).
 */
import { describe, expect, it } from "vitest";
import {
  autoPlay, autoResolve, battleInputs, campaignRules, checkOperationRules, chooseForces, confirmForces, enemyChoice, exportSave, finishBattle, FlowError,
  generateOperation, hashRecord, makeSave, membersOf, menOf, newCampaign, nextNode, operationRules, phaseOf, proceed, proposeChoice, readSave, rememberSector,
  selectables, setChoice, startFlow, validateCommit, type CampaignRecord, type FlowEnv, type NodeResult,
} from "@tcs/campaign";
import type { DataSet } from "@tcs/data";
import type { BattleResult } from "@tcs/sim";
import { aiRunner } from "../src/campaign";
import { runCampaignPart } from "../src/campaign-batch";
import { loadData, ON_POSTS } from "../src/scenarios";

const data = loadData(true);
const rules = campaignRules(data);
const ENV: FlowEnv = { runner: aiRunner, hooks: ON_POSTS };
const XF = { seed: 11, faction: "xf", enemy: "xf", battleSeconds: 90 } as const;

describe("M12.2 operations: the transition table", () => {
  const o = operationRules(data);
  it("the data is consistent (every node in the lists and the table exists, every node has a row)", () => {
    expect(checkOperationRules(data)).toEqual([]);
  });
  it("nextNode follows the table for every node type and result, on the line and at its ends", () => {
    const planned = ["attack", "meeting", "pursue", "ambush"];
    for (const node of Object.keys(o.nodes)) {
      for (const result of ["win", "loss", "draw"] as NodeResult[]) {
        const row = o.transitions[node]![result];
        for (const pos of [0, 1, 3]) {
          const t = nextNode(o.transitions, node, result, pos, planned.length, (p) => planned[p]!);
          const want = row.sector === "next" ? pos + 1 : row.sector === "back" ? Math.max(0, pos - 1) : pos;
          if (want >= planned.length && result === "win") { expect(t.success, `${node} ${result} @${pos}`).toBe(true); continue; }
          expect(t.success).toBe(false);
          expect(t.pos, `${node} ${result} @${pos}`).toBe(Math.min(want, planned.length - 1));
          expect(t.node).toBe(row.node === "planned" ? planned[t.pos] : row.node);
        }
      }
    }
    // The table's shape the owner was told about: a win goes on, a loss turns into a counter-attack or a withdrawal.
    expect(o.transitions["attack"]!.win).toEqual({ node: "planned", sector: "next" });
    expect(o.transitions["attack"]!.loss.node).toBe("defend");
    expect(o.transitions["defend"]!.loss.node).toBe("withdraw");
    expect(o.transitions["withdraw"]!.win.sector).toBe("back");
  });
});

describe("M12.2 choosing forces", () => {
  const r = newCampaign(data, { seed: 3, faction: "de", enemy: "ru" });
  const p = r.sides.player;
  it("proposeChoice: the fittest company (headquarters, 3 platoons) and the support within the cap; validated", () => {
    const keys = proposeChoice(data, p);
    const sel = new Map(selectables(data, p).map((s) => [s.key, s]));
    expect(keys.filter((k) => sel.get(k)!.what === "platoon")).toHaveLength(rules.battle.platoons);
    expect(keys.filter((k) => sel.get(k)!.what === "hq")).toHaveLength(1);
    expect(validateCommit(data, p, keys)).toEqual([]);
    // A second company for a flank battle: none of the first's units.
    const flank = proposeChoice(data, p, keys);
    expect(flank.some((k) => keys.includes(k))).toBe(false);
    expect(flank.filter((k) => sel.get(k)!.what === "platoon").length).toBeGreaterThan(0);
  });
  it("validateCommit: over the cap, no platoon, twice, unknown, committed elsewhere", () => {
    const sel = selectables(data, p);
    const plats = sel.filter((s) => s.what === "platoon").map((s) => s.key);
    expect(validateCommit(data, p, plats.slice(0, 4)).some((x) => x.startsWith("platoons 4"))).toBe(true);
    expect(validateCommit(data, p, sel.filter((s) => s.what === "hq").slice(0, 1).map((s) => s.key))).toContain("no able platoon");
    expect(validateCommit(data, p, [plats[0]!, plats[0]!])).toContain(`twice: ${plats[0]}`);
    expect(validateCommit(data, p, ["nonsense"])).toContain("not selectable: nonsense");
    expect(validateCommit(data, p, [plats[0]!], [plats[0]!])).toContain(`committed elsewhere: ${plats[0]}`);
    expect(validateCommit(data, p, sel.filter((s) => s.what === "hq").slice(0, 2).map((s) => s.key).concat(plats[0]!)).some((x) => x.startsWith("company headquarters 2"))).toBe(true);
  });
  it("enemyChoice commits by the ratio, the fittest platoons first, within the cap", () => {
    const e = r.sides.enemy;
    const sel = new Map(selectables(data, e).map((s) => [s.key, s]));
    const men = (keys: string[]) => keys.reduce((n, k) => n + sel.get(k)!.men, 0);
    const small = enemyChoice(data, e, 30, 0.7, false);
    expect(small).toHaveLength(1);
    const big = enemyChoice(data, e, 200, 1, false);
    expect(big.filter((k) => sel.get(k)!.what === "platoon")).toHaveLength(rules.battle.platoons);
    const sup = enemyChoice(data, e, 60, 1, true);
    expect(sup.some((k) => sel.get(k)!.what === "hq")).toBe(true);
    expect(validateCommit(data, e, sup)).toEqual([]);
    expect(men(small)).toBeGreaterThan(0);
  });
});

describe("M12.2 the flow (xf against xf, 90 s battles)", () => {
  it("an operation: 3-5 nodes, the table followed, the enemy's roster remembered, replenished only at its end; reproducible", { timeout: 600_000 }, () => {
    const part = { faction: "xf", enemy: "xf", carriers: "tracked" as const, seed: 21, mode: "operations" as const, count: 2, seconds: 90 };
    const a = runCampaignPart(data, part);
    expect(a.operations).toHaveLength(2);
    for (const op of a.operations) { expect(op.nodes).toBeGreaterThanOrEqual(3); expect(op.nodes).toBeLessThanOrEqual(5); }
    expect(a.checks).toEqual({ ...a.checks, zeroMen: 0, badOpLength: [], tableMismatch: [], revisitMismatch: [], enemyMismatch: [], replenishmentMisplaced: [], duplicateIds: [] });
    expect(a.replenishments.map((x) => x.afterNode)).toEqual([a.operations[0]!.nodes, a.operations[0]!.nodes + a.operations[1]!.nodes]);
    expect(a.checks.revisits).toBeGreaterThan(0);
    const b = runCampaignPart(data, part);
    expect(b.hash).toBe(a.hash);
  });

  it("endless mode: a replenishment every replenishEvery nodes, a new sector every sectorEvery", { timeout: 600_000 }, () => {
    const d: DataSet = { ...data, campaign: { campaign: { ...rules, endless: { replenishEvery: 2, sectorEvery: 2 } } } };
    const a = runCampaignPart(d, { faction: "xf", enemy: "xf", carriers: "tracked", seed: 4, mode: "endless", count: 5, seconds: 90 }, aiRunner);
    expect(a.rows).toHaveLength(5);
    expect(a.operations).toEqual([]);
    expect(a.replenishments.map((x) => x.afterNode)).toEqual([2, 4]);
    expect(a.checks.replenishmentMisplaced).toEqual([]);
    expect(a.checks.tableMismatch).toEqual([]);
    // Sectors: nodes 1-2 on the first, 3-4 on the second, 5 on the third.
    const sectors = a.rows.map((x) => x.sector);
    expect(sectors[0]).toBe(sectors[1]);
    expect(sectors[2]).toBe(sectors[3]);
    expect(new Set(sectors).size).toBe(3);
  });

  it("phases, the choice, played = auto-resolved, a save in the middle continues the same", { timeout: 600_000 }, () => {
    let r = startFlow(data, newCampaign(data, XF));
    expect(phaseOf(r)).toBe("briefing");
    expect(r.op!.line.length).toBeGreaterThanOrEqual(3);
    expect(r.op!.line.length).toBeLessThanOrEqual(5);
    expect(() => proceed(data, r)).toThrow(FlowError);
    r = chooseForces(data, r);
    expect(phaseOf(r)).toBe("choose");
    const proposal = r.flow!.choice!;
    const bad = setChoice(data, r, []);
    expect(bad.problems).toContain("no able platoon");
    expect(() => confirmForces(data, bad.record)).toThrow(FlowError);
    const ok = setChoice(data, r, proposal);
    expect(ok.problems).toEqual([]);
    r = confirmForces(data, ok.record);
    expect(phaseOf(r)).toBe("battle");
    // A save in the battle phase: loads and continues the same.
    const loaded = readSave(data, exportSave(makeSave(data, r, "mid", ""))).save.record;
    expect(hashRecord(loaded)).toBe(hashRecord(r));
    const nb = battleInputs(data, r, ON_POSTS);
    expect(nb.main).not.toBeNull();
    for (const f of nb.main!.input.forces) expect(menOf(f.units)).toBeGreaterThan(0);
    // Played: the app runs the main battle and hands the result in (the flank battle, if any, is auto-resolved).
    const played: BattleResult = aiRunner(nb.main!.input, {});
    const viaPlayed = finishBattle(data, r, ENV, played);
    const progress: string[] = [];
    const viaAuto = autoResolve(data, loaded, { ...ENV, onProgress: (which, sec) => progress.push(`${which} ${sec}`) });
    expect(hashRecord(viaPlayed)).toBe(hashRecord(viaAuto));
    expect(progress).toContain("main 60");
    expect(phaseOf(viaAuto)).toBe("after-battle");
    const next = proceed(data, viaAuto);
    expect(["briefing", "operation-end"]).toContain(phaseOf(next));
    expect(next.op!.steps).toHaveLength(1);
    expect(next.history.at(-1)!.node).toBe(r.op!.node);
  });

  it("the enemy with nothing able loses the node without a battle (no battle with a side of 0 men)", { timeout: 120_000 }, () => {
    let r = startFlow(data, newCampaign(data, XF));
    // Empty the enemy's platoons (as if all were lost).
    const strip = (u: CampaignRecord["sides"]["enemy"]["battalion"]): void => { if (u.echelon === "platoon") u.members = []; u.subunits.forEach(strip); if (u.echelon === "platoon") u.subunits.forEach((s) => { s.members = []; }); };
    strip(r.sides.enemy.battalion);
    r = confirmForces(data, chooseForces(data, r));
    expect(battleInputs(data, r, ON_POSTS).main).toBeNull();
    const calls: number[] = [];
    const after = finishBattle(data, r, { runner: (i, o) => { calls.push(1); return aiRunner(i, o); }, hooks: ON_POSTS }, "auto");
    expect(calls).toEqual([]);
    const st = after.op!.steps[0]!;
    expect(st.walkover).toBe(true);
    expect(st.result).toBe("win");
    expect(after.battles).toBe(0);
    expect(after.hours).toBe(rules.clock.hoursBetweenBattles);
  });
});

describe("M12.2 sector memory", () => {
  it("a sector fought again gets the craters, holes and wrecks its last battle left", () => {
    let r = generateOperation(data, newCampaign(data, { seed: 5, faction: "de", enemy: "ru" }));
    r.flow = { phase: "choose", choice: proposeChoice(data, r.sides.player) };
    const sector = r.op!.line[0]!;
    // A battle's result as it leaves the sector (only the fields the memory reads).
    const fake = {
      damageOut: { craters: [{ x: 300, y: 400, radiusM: 2.5, depthM: 0.6, tick: 100 }], breaches: [], vegetationLoss: [], positions: [] },
      wrecks: [{ vehicleId: "E-x~1", type: "ru-bmp2", side: "red", x: 500, y: 450, heading: 0, status: "destroyed" }],
    } as unknown as BattleResult;
    rememberSector(r.op!, sector, fake);
    r = confirmForces(data, r);
    const nb = battleInputs(data, r, ON_POSTS);
    expect(nb.main!.input.damage?.craters).toEqual(fake.damageOut!.craters);
    expect(nb.main!.input.wrecksIn?.map((w) => w.vehicleId)).toEqual(["E-x~1"]);
    expect(nb.main!.def.mapWidthM).toBe(r.op!.sectors.find((s) => s.id === sector)!.widthM);
    // Both sides placed, with men.
    for (const f of nb.main!.input.forces) expect(menOf(f.units)).toBeGreaterThan(0);
    expect(membersOf(r.sides.player.battalion).length).toBeGreaterThan(0);
  });
});

void autoPlay;

describe("M12.2 a flank battle and the main battle share a company", () => {
  it("a headquarters lost in the flank battle is not replaced from a platoon fighting the main battle (no man twice)", async () => {
    const { applyResult, unitsOf, clone } = await import("@tcs/campaign");
    const r0 = newCampaign(data, { seed: 9, faction: "de", enemy: "ru" });
    const e = r0.sides.enemy;
    const company = e.battalion.subunits.find((u) => u.echelon === "company")!;
    const hq = { ...company, subunits: company.subunits.filter((s) => s.echelon !== "platoon") };
    const pPlat = r0.sides.player.battalion.subunits.find((u) => u.echelon === "company")!.subunits.find((s) => s.echelon === "platoon")!;
    // The enemy's company HQ fights the flank battle and is lost to the last man; its platoons fight the main battle.
    const fake = (enemyUnits: typeof company[], killHq: boolean) => {
      const out = clone(enemyUnits);
      if (killHq) for (const u of unitsOf(out[0]!)) for (const m of u.members) m.status = "killed";
      const input = { seed: 1, forces: [{ side: "blue", units: [clone(pPlat)], vehicles: [] }, { side: "red", units: clone(enemyUnits), vehicles: [] }] } as unknown as Parameters<typeof applyResult>[2]["input"];
      const result = { forcesOut: [{ side: "blue", units: [clone(pPlat)], vehicles: [] }, { side: "red", units: out, vehicles: [] }], winner: null, endReason: "time-limit", durationSeconds: 60, logistics: [], service: {} } as unknown as BattleResult;
      return { input, result };
    };
    const f1 = fake([hq], true), m1 = fake(company.subunits.filter((s) => s.echelon === "platoon"), false);
    let r = applyResult(data, r0, { ...f1, playerSide: "blue", kind: "attack", mapKind: "village", mapSeed: 1, attacker: "player", flank: true });
    r = applyResult(data, r, { ...m1, playerSide: "blue", kind: "attack", mapKind: "village", mapSeed: 1, attacker: "player" });
    const ids = unitsOf(r.sides.enemy.battalion).flatMap((u) => u.members.map((m) => m.personId));
    expect(new Set(ids).size).toBe(ids.length);
    // The company still gets a leader (appointed once both battles are applied).
    const c = unitsOf(r.sides.enemy.battalion).find((u) => u.key === company.key)!;
    expect(c.leaderIndex).toBeGreaterThanOrEqual(0);
  });
});
