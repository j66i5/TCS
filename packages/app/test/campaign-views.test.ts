/**
 * M12.3 the roster screens' views (plan docs/plans/m12-roster.md 4.6; campaign/src/view.ts): every number the phone
 * screens show is computed here from the record, so it is tested here. The battalion tree adds up, the man card finds
 * a man wherever he is, the briefing's choice and estimate follow the flow, the after-battle card is built from the
 * record alone (the same from a loaded save as right after the battle), "Make leader" and "Change forces", the
 * replenishment card, and the played battle's hand-back (`battleResultOf`) gives the same record as the auto-resolve.
 * Real battles with the fixture faction (xf against xf, 90 s each) and one DE vs RU node.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  afterBattleView, autoResolve, battalionView, battleInputs, briefingView, chooseForces, confirmForces, exportSave, finishBattle, findMan, hashRecord, makeLeader,
  makeSave, manView, newCampaign, phaseOf, proceed, readSave, replenishmentView, reviseForces, setChoice, startFlow, unitsOf, type CampaignRecord, type FlowEnv, type UnitView,
} from "@tcs/campaign";
import { battleResultOf, createSim, emptyLogistics, logisticsFromEvents, step, submitOrder, tracerMap, type Order } from "@tcs/sim";
import { planControllers } from "@tcs/ai";
import { aiRunner } from "../../tools/src/campaign";
import { loadData, ON_POSTS } from "../../tools/src/scenarios";
import { finishNode, sectorPreview } from "../src/campaign/resolve";
import { CAMPAIGN_HOOKS } from "../src/campaign/hooks";

const data = loadData(true);
const ENV: FlowEnv = { runner: aiRunner, hooks: ON_POSTS };
const XF = { seed: 21, faction: "xf", enemy: "xf", battleSeconds: 90 } as const;

function sumTree(u: UnitView, f: (x: UnitView) => number): number {
  return u.children.reduce((s, c) => s + sumTree(c, f), 0) + f(u);
}

/** One node auto-resolved from a fresh campaign. */
function firstNode(opts: Parameters<typeof newCampaign>[1] = XF): { before: CampaignRecord; after: CampaignRecord } {
  let r = startFlow(data, newCampaign(data, opts));
  r = confirmForces(data, chooseForces(data, r));
  return { before: r, after: autoResolve(data, r, ENV) };
}

describe("M12.3 views: the battalion and the man card", () => {
  const r = startFlow(data, newCampaign(data, { seed: 3, faction: "de", enemy: "ru" }));
  it("the tree: places and men add up over the units, a full new battalion is all fit, ammunition full, every hull in service", () => {
    const v = battalionView(data, r);
    const men = unitsOf(r.sides.player.battalion).reduce((s, u) => s + u.members.length, 0);
    expect(v.men).toBe(men);
    expect(v.able).toBe(men);
    expect(v.places).toBe(men); // (a new battalion fills its establishment)
    expect(v.wounded + v.recovering + v.lost).toBe(0);
    expect(v.ammo).toBeCloseTo(1, 6);
    expect(v.hulls.length).toBe(r.sides.player.vehicles.length);
    expect(v.hulls.every((h) => h.state === "service" && h.nameKey.startsWith("vehicle."))).toBe(true);
    // The root's numbers are its own men's plus its children's.
    const own = (x: UnitView) => unitsOf(r.sides.player.battalion).find((u) => u.key === x.key)!.members.length;
    expect(sumTree(v, own)).toBe(v.men);
    for (const c of v.children) expect(c.men).toBe(sumTree(c, own));
  });
  it("the man card: skills with experience, his squad, Make leader (not for medics, not his own leader, not once committed)", () => {
    const sq = unitsOf(r.sides.player.battalion).find((u) => u.echelon === "squad" && u.members.length > 2)!;
    const leader = sq.members[sq.leaderIndex]!;
    const other = sq.members.find((m, i) => i !== sq.leaderIndex && !/medic|sanit/i.test(m.role))!;
    const mv = manView(data, r, other.personId)!;
    expect(mv.where).toBe("unit");
    expect(mv.unitKey).toBe(sq.key);
    expect(mv.record.skills["experience"]).toBeGreaterThan(0);
    expect(mv.squad.map((x) => x.personId)).toEqual(sq.members.map((x) => x.personId));
    expect(mv.squad.filter((x) => x.leader).map((x) => x.personId)).toEqual([leader.personId]);
    expect(mv.isLeader).toBe(false);
    expect(mv.canMakeLeader).toBe(true);
    expect(manView(data, r, leader.personId)!.canMakeLeader).toBe(false);
    const r2 = makeLeader(data, r, other.personId);
    expect(manView(data, r2, other.personId)!.isLeader).toBe(true);
    expect(manView(data, r2, leader.personId)!.isLeader).toBe(false);
    expect(manView(data, r2, leader.personId)!.where).toBe("unit"); // (the old leader stays in the squad)
    expect(r2.log.at(-1)).toMatchObject({ kind: "leader", how: "player", personId: other.personId, replaced: leader.personId, unitKey: sq.key });
    expect(hashRecord(r)).not.toBe(hashRecord(r2));
    expect(() => makeLeader(data, r2, other.personId)).toThrow(/already leads/);
    // A medic never leads; once the forces are committed leaders wait for the battle's end.
    const medic = unitsOf(r.sides.player.battalion).flatMap((u) => u.members).find((m) => data.factions.de!.roles[m.role]?.medical?.level === "medic");
    if (medic) { expect(manView(data, r, medic.personId)!.canMakeLeader).toBe(false); expect(() => makeLeader(data, r, medic.personId)).toThrow(/medical/); }
    const committed = confirmForces(data, chooseForces(data, r));
    expect(manView(data, committed, other.personId)!.canMakeLeader).toBe(false);
    expect(() => makeLeader(data, committed, other.personId)).toThrow(/committed/);
    // The battle a player-chosen leader fights in has him as the squad's leader.
    const r3 = confirmForces(data, chooseForces(data, makeLeader(data, r, other.personId)));
    const nb = battleInputs(data, r3);
    const inBattle = nb.main!.input.forces.find((f) => f.side === "blue")!.units.flatMap(unitsOf).find((u) => u.key === sq.key);
    if (inBattle) expect(inBattle.members[inBattle.leaderIndex]!.personId).toBe(other.personId);
  });
});

describe("M12.3 views: the briefing and the choice", () => {
  const r0 = startFlow(data, newCampaign(data, { seed: 3, faction: "de", enemy: "ru" }));
  it("proposed choice, cap, own and enemy strength (rounded), problems; Change forces goes back to the choice", () => {
    const r = chooseForces(data, r0);
    const b = briefingView(data, r);
    expect(b.choice).toEqual(b.proposed);
    expect(b.problems).toEqual([]);
    expect(b.own.men).toBeGreaterThan(90);
    expect(b.own.hulls).toBeGreaterThan(8);
    expect(b.enemy.men).toBeGreaterThan(0);
    expect(b.enemy.men % 5).toBe(0); // (an estimate: rounded)
    expect(b.enemy.hulls.length).toBeGreaterThan(0);
    expect(b.selectables.length).toBeGreaterThan(b.choice.length);
    expect(b.selectables.every((x) => x.callsign.length > 0)).toBe(true);
    expect(b.pos).toBe(1);
    expect(b.lineLength).toBe(r.op!.line.length);
    // Nothing chosen: a problem; a carrier-less squad split from its platoon is not selectable (platoons whole).
    const none = setChoice(data, r, []);
    expect(briefingView(data, none.record).problems.map((x) => x.key)).toContain("noPlatoon");
    // Change forces: battle -> choose, the choice kept.
    const c = confirmForces(data, r);
    expect(phaseOf(c)).toBe("battle");
    const back = reviseForces(c);
    expect(phaseOf(back)).toBe("choose");
    expect(back.flow!.choice).toEqual(c.flow!.choice);
    expect(() => reviseForces(r)).toThrow();
  });
  it("the sector preview paints the map in both looks and places the player's men", () => {
    const r = chooseForces(data, r0);
    for (const look of ["photo", "flat"] as const) {
      const p = sectorPreview(data, r, look, 400)!;
      expect(p.w).toBe(400);
      expect(p.rgba.length).toBe(p.w * p.h * 4);
      expect(p.men.length + p.hulls.length).toBeGreaterThan(0);
      expect(p.objectives.length).toBeGreaterThan(0);
      // Not one flat colour.
      const seen = new Set<number>();
      for (let i = 0; i < p.rgba.length; i += 4 * 97) seen.add((p.rgba[i]! << 16) | (p.rgba[i + 1]! << 8) | p.rgba[i + 2]!);
      expect(seen.size).toBeGreaterThan(20);
    }
  });
});

describe("M12.3 views: after a battle, replenishment, the played battle", () => {
  it("what changed: the battle's numbers match its summary, lists from the pools, and the same view from a loaded save", () => {
    const { after } = firstNode();
    expect(phaseOf(after)).toBe("after-battle");
    const a = afterBattleView(data, after);
    const main = a.battles.find((x) => !x.flank)!;
    const h = after.history.find((x) => x.index === main.index)!;
    expect(main.men.player.killed).toBe(h.men.player.killed);
    expect(a.killed.length).toBe(a.battles.reduce((s, x) => s + x.men.player.killed, 0));
    expect(a.captured.length).toBe(a.battles.reduce((s, x) => s + x.men.player.captured, 0));
    expect(a.wounded.filter((w) => w.days !== undefined && findMan(after, "player", w.personId)?.where === "recovering").length).toBe(a.battles.reduce((s, x) => s + x.men.player.evacuated, 0));
    expect(a.experience.men).toBeGreaterThan(0);
    expect(a.experience.total).toBeGreaterThan(0);
    expect(a.steps.length).toBe(1);
    expect(a.fired.length).toBeGreaterThan(0);
    const loaded = readSave(data, exportSave(makeSave(data, after, "x", "t"))).save.record;
    expect(afterBattleView(data, loaded)).toEqual(a);
  });
  it("replenishment: the card lists what the replenishment brought (operation's end)", () => {
    let r = startFlow(data, newCampaign(data, { ...XF, seed: 23 }));
    let rv = null;
    for (let k = 0; k < 6 && !rv; k++) {
      r = autoResolve(data, confirmForces(data, chooseForces(data, r)), ENV);
      let p = proceed(data, r);
      if (phaseOf(p) === "replenishment" || phaseOf(p) === "operation-end") { p = proceed(data, p); rv = replenishmentView(data, p); }
      r = p;
    }
    expect(rv).not.toBeNull();
    expect(rv!.days).toBeGreaterThan(0);
    expect(rv!.rounds).toBeGreaterThanOrEqual(0);
    expect(rv!.ableShare).toBeGreaterThan(0.5);
    expect(rv!.men).toBe(battalionView(data, r).men);
  });
  it("a played battle handed back (battleResultOf with the logistics from the events) gives the record the auto-resolve gives", () => {
    let r = startFlow(data, newCampaign(data, { ...XF, seed: 25, battleSeconds: 60 }));
    r = confirmForces(data, chooseForces(data, r));
    const nb = battleInputs(data, r, CAMPAIGN_HOOKS);
    const input = nb.main!.input;
    // The app's loop: AI orders each tick, events into the logistics.
    const sim = createSim({ ...input, orders: [] });
    const ctrls = planControllers(input);
    const logistics = sim.state.sides.map((s) => emptyLogistics(s.id));
    const tracer = tracerMap(input.catalog);
    const orders: Order[] = [];
    const max = input.rules.timeLimitSeconds * 60 + 1;
    while (!sim.state.ended && sim.state.tick < max) {
      for (const c of ctrls) for (const o of c.think(sim.state, sim.state.tick)) { submitOrder(sim, o); orders.push(o); }
      const ev = step(sim);
      if (ev.length > 0) logisticsFromEvents(logistics, ev, sim.state, input.catalog, tracer);
    }
    const played = battleResultOf(sim, input, orders, logistics);
    const viaPlayed = finishBattle(data, r, ENV, played, nb);
    const viaAuto = finishNode(data, r, null, () => undefined, undefined, aiRunner);
    expect(hashRecord(viaPlayed)).toBe(hashRecord(viaAuto));
    expect(phaseOf(viaPlayed)).toBe("after-battle");
  });
  it("review M12: the app builds its campaign battles as the tools do (the defence's hulls on their posts)", () => {
    let r = startFlow(data, newCampaign(data, { seed: 3, faction: "de", enemy: "ru", battleSeconds: 60 }));
    r = confirmForces(data, chooseForces(data, r));
    const tb = battleInputs(data, r, ON_POSTS), bb = battleInputs(data, r);
    // (The runner sees the flank battle first when the node has one.)
    const tools = (tb.flank ?? tb.main)!.input, bare = (bb.flank ?? bb.main)!.input;
    let seen: unknown = null;
    const stop = new Error("captured");
    expect(() => finishNode(data, r, null, () => undefined, undefined, (input) => { seen = input; throw stop; })).toThrow(stop);
    expect(hashText(seen)).toBe(hashText(tools));
    // (The hook matters here: without it the defence's hulls start elsewhere.)
    expect(hashText(bare)).not.toBe(hashText(tools));
    const p = sectorPreview(data, r, "flat", 200)!;
    const blue = tb.main!.input.forces.find((f) => f.side === "blue")!;
    expect(p.hulls).toEqual((blue.vehiclePlacements ?? []).map((v) => ({ x: v.x, y: v.y })));
  });
});

const hashText = (x: unknown) => createHash("sha256").update(JSON.stringify(x)).digest("hex");
