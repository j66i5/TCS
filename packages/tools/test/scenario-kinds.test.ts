/**
 * M12.0b: scenario kinds and company-size battles (plan docs/plans/m12-roster.md 4.2).
 * - Exit zones: men on foot and a hull with everyone aboard leave by their side's exit, come out "fit" and saved (not
 *   men down), score the zone's points; a side with nobody left on the map ends the battle ("side-withdrew").
 * - An objective with `untilS` keeps its holder from then on.
 * - Late units come on with their hulls, crews seated, riders aboard (the counter-attack reserve, mounted).
 * - Every kind generates on every map kind, from templates and from roster forces; `attack` is `platoon-attack`.
 * - A withdrawal battle with the AI: its men out by the exit are fit (or wounded) and counted saved.
 * - core/campaign.json holds the per-battle cap.
 * The kinds' AI-against-AI matrix (10 seeds x 4 maps, stalemates) is `npm run lab -- kinds` (DECISIONS "M12.0b").
 */
import { describe, expect, it } from "vitest";
import { planControllers } from "@tcs/ai";
import { buildScenario, demoBattle, SCENARIO_KINDS, scenarioMapSize, vehicleBattle, type ScenarioDef } from "@tcs/scenario";
import { createSim, hasExited, isOffMap, rosterStatus, runBattle, step, TICK_HZ, type BattleInput } from "@tcs/sim";
import { KIND_MAPS, kindScenario, rosterForcesOf, runKind } from "../src/labs/kinds";
import { loadData, ON_POSTS } from "../src/scenarios";

const data = loadData(true);

describe("M12.0b exit zones", () => {
  it("men on foot in their side's exit leave the map saved and fit; the side's empty map ends the battle", () => {
    const input = demoBattle(data, { seed: 1, factions: ["de", "ru"], timeLimitSeconds: 60 });
    const W = input.map.widthM;
    // Blue's men all stand in its exit (the west strip); red has none.
    const blue = input.forces.find((f) => f.side === "blue")!;
    for (const p of blue.placements) p.x = 5;
    input.rules.exits = [{ side: "blue", x0: 0, y0: 0, x1: 20, y1: input.map.heightM, pointsPerMan: 2 }];
    input.rules.victory = { casualtyPoints: 5, endOnDefeat: true };
    expect(W).toBeGreaterThan(40);
    const sim = createSim(input);
    for (let i = 0; i <= 2 * TICK_HZ && sim.state.ended === null; i++) step(sim);
    let n = 0;
    for (const [id, ident] of sim.state.identity.entries()) {
      const s = sim.state.soldier.req(id);
      if (ident.side !== "blue") { expect(hasExited(s)).toBe(false); continue; }
      expect(hasExited(s)).toBe(true);
      expect(rosterStatus(s)).toBe("fit");
      expect(sim.state.transform.req(id).x).toBeLessThan(-1000);
      n++;
    }
    expect(n).toBe(blue.placements.length);
    expect(sim.state.ended?.reason).toBe("side-withdrew");
    const r = runBattle(input, {});
    const sb = r.sides.find((s) => s.side === "blue")!;
    expect(sb.saved).toBe(n);
    expect(sb.soldiersFit).toBe(n);
    expect(r.endReason).toBe("side-withdrew");
    const score = r.scores.find((s) => s.side === "blue")!;
    expect(score.menDown).toBe(0);
    expect(score.saved).toBe(n);
    expect(score.savedPoints).toBe(2 * n);
    for (const u of r.forcesOut.find((f) => f.side === "blue")!.units) for (const m of u.members) expect(m.status).toBe("fit");
    expect(r.eventCounts["unit.exited"]).toBe(n);
  });

  it("a hull in its exit leaves with everyone aboard (off the map, crew saved); a battle without exits is unchanged", () => {
    const input = vehicleBattle(data, { seed: 2, factions: ["de", "ru"], mapKind: "farmland", timeLimitSeconds: 30 });
    const blue = input.forces.find((f) => f.side === "blue")!;
    const vp = blue.vehiclePlacements![0]!;
    const plain = runBattle(input, {});
    input.rules.exits = [{ side: "blue", x0: vp.x - 5, y0: vp.y - 5, x1: vp.x + 5, y1: vp.y + 5, pointsPerVehicle: 10 }];
    const sim = createSim(input);
    for (let i = 0; i <= TICK_HZ; i++) step(sim);
    const hull = [...sim.state.vehicle.entries()].find(([, v]) => v.vehicleId === vp.vehicleId)!;
    expect(hull[1].exited).toBeLessThanOrEqual(TICK_HZ);
    expect(isOffMap(hull[1])).toBe(true);
    const aboard = hull[1].seats.filter((x) => x !== null);
    expect(aboard.length).toBeGreaterThan(0);
    for (const m of aboard) { const s = sim.state.soldier.req(m!); expect(s.evacuated?.via).toBe("exit"); expect(rosterStatus(s)).toBe("fit"); }
    // Without the exit the same battle runs as before (no exit system, same hash).
    expect(runBattle({ ...input, rules: { ...input.rules, exits: undefined } }, {}).finalStateHash).toBe(plain.finalStateHash);
  });

  it("an objective with untilS keeps its holder from then on", () => {
    const input = demoBattle(data, { seed: 1, factions: ["de", "ru"], timeLimitSeconds: 20, frontM: 300 });
    const red = input.forces.find((f) => f.side === "red")!;
    const rp = red.placements[0]!;
    // Red stands on an objective blue held, frozen at 0 s: it stays blue's.
    input.rules.objectives = [
      { id: "frozen", nameKey: "objective.main", x: rp.x, y: rp.y, radiusM: 30, points: 10, holder: "blue", untilS: 0 },
      { id: "open", nameKey: "objective.second", x: rp.x, y: rp.y, radiusM: 30, points: 10, holder: "blue" },
    ];
    const sim = createSim(input);
    for (let i = 0; i < 5 * TICK_HZ; i++) step(sim);
    expect(sim.state.objectives[0]!.holder).toBe("blue");
    expect(sim.state.objectives[1]!.holder).toBe("red");
  });
});

describe("M12.0b scenario kinds", () => {
  it("attack is platoon-attack with the plans and the attacker's break-off exit (platoon-attack unchanged)", () => {
    const a = buildScenario(data, { kind: "platoon-attack", seed: 4, mapKind: "village", factions: ["de", "ru"], attacker: "red", vehicles: true }, ON_POSTS);
    const b = buildScenario(data, { kind: "attack", seed: 4, mapKind: "village", factions: ["de", "ru"], attacker: "red", vehicles: true }, ON_POSTS);
    expect(a.forces.some((f) => f.plan !== undefined)).toBe(false);
    expect(a.rules.exits).toBeUndefined();
    expect(b.rules.exits).toEqual([{ side: "red", x0: b.map.widthM - 15, y0: 0, x1: b.map.widthM, y1: b.map.heightM, pointsPerMan: 0, pointsPerVehicle: 0 }]);
    expect(b.forces.find((f) => f.side === "red")!.plan).toEqual({ posture: "attack", breakOff: { x0: b.map.widthM - 15, y0: 0, x1: b.map.widthM, y1: b.map.heightM } });
    expect(b.forces.find((f) => f.side === "blue")!.plan).toEqual({ posture: "defend" });
    const strip = (i: BattleInput) => JSON.stringify({ ...i, catalog: null, rules: { ...i.rules, exits: undefined }, forces: i.forces.map((f) => ({ ...f, plan: undefined })) });
    expect(strip(b)).toBe(strip(a));
  });

  it("every kind generates on every map kind, from templates and from roster forces", () => {
    for (const kind of SCENARIO_KINDS) for (const map of KIND_MAPS) for (const vehicles of [false, true]) {
      const def = kindScenario(kind, map, 3, 1200, { vehicles });
      const input = buildScenario(data, def, ON_POSTS);
      const men = (i: BattleInput) => i.forces.map((f) => f.placements.length);
      expect(men(input).every((n) => n > 0)).toBe(true);
      for (const f of input.forces) for (const p of f.placements) {
        if (p.mountedIn !== undefined) continue;
        expect(p.x).toBeGreaterThanOrEqual(0); expect(p.x).toBeLessThanOrEqual(input.map.widthM);
      }
      expect(input.forces.every((f) => f.plan !== undefined)).toBe(true);
      // The kinds' exits: the ambushed side's and the withdrawing side's; each attacking side's break-off at its own edge.
      expect(input.rules.exits?.length).toBe(kind === "meeting" || kind === "withdrawal" ? 2 : 1);
      // Nobody starts in an exit zone of his side.
      for (const f of input.forces) for (const p of f.placements) {
        if (p.mountedIn !== undefined) continue;
        for (const z of input.rules.exits!) if (z.side === f.side) expect(p.x < Math.min(z.x0, z.x1) || p.x > Math.max(z.x0, z.x1)).toBe(true);
      }
      if (kind === "withdrawal") expect(input.rules.objectives.every((o) => o.untilS !== undefined)).toBe(true);
      if (kind === "meeting") expect(input.rules.objectives.every((o) => o.holder === null)).toBe(true);
      if (kind === "defence-counterattack") {
        const late = input.forces.flatMap((f) => f.units.filter((u) => (u.arriveS ?? 0) > 0));
        expect(late.length).toBe(1);
        expect(input.forces.find((f) => f.side !== def.attacker)!.plan!.reserve).toEqual([late[0]!.callsign]);
      }
      // Roster forces: the same men go in, placed by the kind.
      const rin = buildScenario(data, { ...def, forces: rosterForcesOf(input) }, ON_POSTS);
      expect(men(rin)).toEqual(men(input));
      createSim(rin);
    }
  });

  it("the counter-attack reserve comes on mounted at its time: hulls, crews seated, riders aboard", () => {
    const input = buildScenario(data, { ...kindScenario("defence-counterattack", "farmland", 1, 600, { vehicles: true }), reserveAtS: 5 }, ON_POSTS);
    const def = input.forces.find((f) => f.side === "red")!;
    const reserve = def.units.find((u) => (u.arriveS ?? 0) > 0)!;
    const hulls = new Set<string>();
    const walk = (u: typeof reserve) => { if (u.vehicleId !== undefined) hulls.add(u.vehicleId); u.subunits.forEach(walk); };
    walk(reserve);
    expect(hulls.size).toBeGreaterThan(0);
    const sim = createSim(input);
    const present = () => [...sim.state.vehicle.values()].filter((v) => hulls.has(v.vehicleId));
    expect(present().length).toBe(0);
    for (let i = 0; i <= 6 * TICK_HZ; i++) step(sim);
    const vs = present();
    expect(vs.length).toBe(hulls.size);
    for (const v of vs) expect(v.unit).not.toBeNull();
    const riders = vs.reduce((n, v) => n + v.seats.filter((x) => x !== null).length, 0);
    expect(riders).toBeGreaterThan(vs.length * 2);
  });

  it("a company each: three platoons and the support per side, on a larger map", () => {
    const def: ScenarioDef = { kind: "attack", size: "company", seed: 1, mapKind: "farmland", factions: ["de", "ru"], attacker: "blue", vehicles: true };
    const { W, H } = scenarioMapSize(def);
    expect(W).toBeGreaterThan(1200); expect(H).toBeGreaterThan(900);
    const input = buildScenario(data, def, ON_POSTS);
    for (const f of input.forces) expect(f.units.filter((u) => u.echelon === "platoon").length).toBe(3);
    const men = input.forces.map((f) => f.placements.length);
    expect(men.every((n) => n >= 100)).toBe(true);
  });

  it("withdrawal with the AI: the men out by the exit are fit or wounded and counted saved", () => {
    const { row, result } = runKind(data, kindScenario("withdrawal", "village", 1, 900), false);
    const side = result.sides.find((s) => (s.saved ?? 0) > 0);
    expect(side).toBeDefined();
    expect(row.savedBad).toBe(0);
    expect(row.savedFit).toBeGreaterThan(0);
    expect(side!.saved).toBe(row.saved[side!.side === "blue" ? 0 : 1]);
  }, 120_000);

  it("planControllers gives every side a commander; a battle without plans keeps the platoon commander", () => {
    const input = buildScenario(data, kindScenario("ambush", "woodland", 2, 60), ON_POSTS);
    expect(planControllers(input).map((c) => c.side)).toEqual(["blue", "red"]);
  });
});

describe("M12.0b campaign data", () => {
  it("core/campaign.json holds the per-battle cap (a company: three platoons and its support)", () => {
    const c = data.campaign?.campaign.battle;
    expect(c).toBeDefined();
    expect(c!.platoons).toBeGreaterThanOrEqual(1);
    expect(c!.measuredX).toBeGreaterThanOrEqual(c!.floorX);
  });
});
