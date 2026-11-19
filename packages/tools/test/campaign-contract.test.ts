/**
 * M12.0a: the battle contract a campaign needs (plan docs/plans/m12-roster.md 4.1).
 * - Every field of every roster record that comes out of battle 1 arrives in battle 2 (real records, and seeded
 *   variations of them: a property test over the record fields).
 * - The damage of battle 1 is in battle 2's navigation: a crater is rough ground, a hole in a wall is open, a wreck
 *   blocks the grid; the wreck belongs to neither force.
 * - `rules.campaignOut` adds `damageOut` and `service` and changes nothing else the battle does.
 * - xf runs a two-battle chain. Lint rejects Math.random in packages/campaign/src.
 */
import { describe, expect, it } from "vitest";
import { ESLint } from "eslint";
import { fieldForce, menOf, runChain, sectorTerrain } from "@tcs/campaign";
import { buildScenario, type ScenarioDef, type ScenarioForces } from "@tcs/scenario";
import {
  createRng, createSim, CRATER_NAV, nextFloat, navFor, runBattle, soldierRecordFromState, vehicleRecordFromState, WRECK_SIDE,
  type BattleInput, type BattleResult, type SoldierRecord, type UnitInput, type VehicleRecord,
} from "@tcs/sim";
import { aiRunner } from "../src/campaign";
import { loadData, ON_POSTS } from "../src/scenarios";

const data = loadData(true);

const def = (over: Partial<ScenarioDef> = {}): ScenarioDef => ({
  kind: "platoon-attack", seed: 3, mapKind: "village", factions: ["de", "ru"], attacker: "blue", attackerPlatoons: 1, vehicles: true,
  timeLimitSeconds: 420, campaignOut: true, ...over,
});

/** Battle 1 with the AI, once for the file. */
let first: { input: BattleInput; result: BattleResult } | null = null;
function battle1(): { input: BattleInput; result: BattleResult } {
  if (first) return first;
  const input = buildScenario(data, def(), ON_POSTS);
  first = { input, result: aiRunner(input, {}) };
  return first;
}

function fielded(): [ScenarioForces, ScenarioForces] {
  const { input, result } = battle1();
  return (["blue", "red"] as const).map((side) => fieldForce(result.forcesOut.find((f) => f.side === side)!, input.forces.find((f) => f.side === side)!)) as [ScenarioForces, ScenarioForces];
}

const members = (us: readonly UnitInput[]): SoldierRecord[] => us.flatMap((u) => [...u.members, ...members(u.subunits)]);
/** A record with its load as a sorted multiset (the order of stacks is not part of it). */
const norm = (r: SoldierRecord) => ({ ...r, load: [...r.load].sort((a, b) => (a.type !== b.type ? (a.type < b.type ? -1 : 1) : (a.charge ?? -1) - (b.charge ?? -1))) });
const normV = (r: VehicleRecord) => ({ ...r, load: [...r.load].sort((a, b) => (a.type !== b.type ? (a.type < b.type ? -1 : 1) : (a.charge ?? -1) - (b.charge ?? -1))), capturedBy: r.capturedBy ?? null });

/** Battle 2's records at its first tick against the records that went in. */
function roundTrip(forces: [ScenarioForces, ScenarioForces]): { men: number; hulls: number } {
  const input = buildScenario(data, def({ forces, terrain: sectorTerrain(battle1().result) }), ON_POSTS);
  const sim = createSim(input);
  const byPerson = new Map<string, number>();
  // mounted: ok (every man)
  for (const [id, ident] of sim.state.identity.entries()) byPerson.set(ident.personId, id);
  let men = 0, hulls = 0;
  forces.forEach((f) => {
    for (const m of members(f.units)) {
      const id = byPerson.get(m.personId);
      expect(id, m.personId).toBeDefined();
      expect(norm(soldierRecordFromState(sim.state, id!))).toEqual(norm(m));
      men++;
    }
    for (const v of f.vehicles ?? []) {
      const vid = [...sim.state.vehicle.entries()].find(([, x]) => x.vehicleId === v.vehicleId)![0];
      const out = vehicleRecordFromState(sim.state, vid);
      expect(normV(out)).toEqual(normV({ ...v, ready: v.ready ?? out.ready, components: v.components ?? out.components, status: v.status ?? "ok" }));
      hulls++;
    }
  });
  return { men, hulls };
}

describe("M12.0a records out of battle 1 arrive in battle 2", () => {
  it("every field of every man and hull, as they came out", () => {
    const forces = fielded();
    const all = forces.flatMap((f) => members(f.units));
    // (The battle left its marks: the test is not of fresh records.)
    expect(all.some((m) => m.fatigue > 0)).toBe(true);
    expect(all.some((m) => m.stress > 0)).toBe(true);
    expect(all.some((m) => m.powerFitted === true)).toBe(true);
    expect(forces.flatMap((f) => f.vehicles ?? []).some((v) => (v.ready ?? []).some((w) => w.length > 0))).toBe(true);
    const { men, hulls } = roundTrip(forces);
    expect(men).toBe(menOf(forces[0].units) + menOf(forces[1].units));
    expect(hulls).toBeGreaterThan(0);
  }, 300_000);

  it("property: seeded variations of every record field arrive unchanged", () => {
    const rng = createRng(17);
    // Wounds and physiology from men hit in battle 1 (whatever became of them), grafted onto men going in.
    // (Conscious ones: a man going in unconscious is "incapacitated", his status follows his condition.)
    const hurt = battle1().result.forcesOut.flatMap((f) => members(f.units)).filter((m) => m.wounds.length > 0 && m.physiology?.alive === true && m.physiology.consciousness >= 0.5);
    expect(hurt.length).toBeGreaterThan(0);
    for (let trial = 0; trial < 4; trial++) {
      const forces = JSON.parse(JSON.stringify(fielded())) as [ScenarioForces, ScenarioForces];
      for (const f of forces) {
        for (const m of members(f.units)) {
          const r = () => nextFloat(rng, "t");
          if (r() < 0.2) {
            const h = hurt[Math.floor(r() * hurt.length)]!;
            m.wounds = JSON.parse(JSON.stringify(h.wounds)) as SoldierRecord["wounds"];
            m.physiology = { ...h.physiology! };
            m.status = "wounded";
          }
          m.fatigue = Math.round(r() * 1000) / 1000;
          m.stress = Math.round(r() * 1000) / 1000;
          if (r() < 0.7) m.strain = Math.round(r() * 1000) / 1000 || 0.001;
          if (r() < 0.7) m.hydration = 0.3 + Math.round(r() * 600) / 1000;
          if (r() < 0.3) m.recoveryDays = 1 + Math.floor(r() * 20);
          // loads to the round: one magazine part-used
          const mag = m.load.find((l) => l.charge !== undefined && l.charge > 1 && l.count >= 1);
          if (mag && r() < 0.5) { if (mag.count > 1) { mag.count--; m.load.push({ type: mag.type, count: 1, charge: mag.charge! - 1 - Math.floor(r() * (mag.charge! - 1)) }); } else mag.charge = Math.max(0, mag.charge! - 1 - Math.floor(r() * (mag.charge! - 1))); }
        }
        for (const v of f.vehicles ?? []) {
          const fuel = v.load.find((l) => l.charge !== undefined && /fuel|diesel/.test(l.type));
          if (fuel) fuel.charge = Math.round(fuel.charge! * (0.3 + 0.7 * nextFloat(rng, "t")) * 10) / 10;
          v.components = (v.components ?? []).map((c) => (nextFloat(rng, "t") < 0.3 ? Math.round(c * nextFloat(rng, "t") * 100) / 100 : c));
          v.ready = (v.ready ?? []).map((w) => w.map((fd) => ({ ...fd, rounds: Math.floor(fd.rounds * nextFloat(rng, "t")) })));
        }
      }
      roundTrip(forces);
    }
  }, 300_000);
});

describe("M12.0a battle 1's damage and wrecks in battle 2", () => {
  it("craters are rough ground, holes in walls are open, wrecks block the grid and are nobody's", () => {
    const { result } = battle1();
    const terrain = sectorTerrain(result);
    // A wreck of our own on open ground, so the test does not hang on what battle 1 destroyed.
    const base = buildScenario(data, def({ forces: fielded() }), ON_POSTS);
    const plain = createSim(base);
    const foot0 = navFor(plain.ctx, "foot").grid, tr0 = navFor(plain.ctx, "tracked").grid;
    let wx = -1, wy = -1;
    for (let y = 100; y < base.map.heightM - 100 && wx < 0; y += 10) for (let x = 100; x < base.map.widthM - 100; x += 10) {
      const i = Math.floor(y / 2) * tr0.cols + Math.floor(x / 2);
      if (tr0.cost[i]! > 0 && Math.abs(tr0.cost[i]! - tr0.minCost) < 1e-6) { wx = x; wy = y; break; }
    }
    expect(wx).toBeGreaterThan(0);
    const wrecks = [...(terrain.wrecks ?? []), { vehicleId: "old-1", type: "ru-bmp2", side: "red", x: wx, y: wy, heading: 0.3, status: "destroyed" as const }];
    const input = buildScenario(data, def({ forces: fielded(), terrain: { ...terrain, wrecks } }), ON_POSTS);
    const sim = createSim(input);
    const foot = navFor(sim.ctx, "foot").grid, tr = navFor(sim.ctx, "tracked").grid;
    // Craters of battle 1: the cell under each is costlier by the factor, where it was passable.
    const craters = result.damageOut!.craters;
    expect(craters.length).toBeGreaterThan(0);
    let rough = 0;
    for (const c of craters) {
      const i = Math.floor(c.y / 2) * foot.cols + Math.floor(c.x / 2);
      if (foot0.cost[i]! > 0 && foot0.wall[i] === 0 && !(input.wrecksIn ?? []).some((w) => Math.abs(w.x - c.x) < 8 && Math.abs(w.y - c.y) < 8)) {
        expect(foot.cost[i]).toBeCloseTo(foot0.cost[i]! * CRATER_NAV.foot, 4);
        rough++;
      }
    }
    expect(rough).toBeGreaterThan(0);
    // Holes in obstacles: the cell at each hole's middle is no wall cell in battle 2 (it was one before).
    const holes = result.damageOut!.breaches.filter((b) => b.owner === "obstacle");
    let opened = 0;
    for (const b of holes) {
      const o = input.map.obstacles.find((q) => q.id === b.id)!;
      const ax = o.points[b.part * 2]!, ay = o.points[b.part * 2 + 1]!, bx = o.points[b.part * 2 + 2]!, by = o.points[b.part * 2 + 3]!;
      const len = Math.hypot(bx - ax, by - ay) || 1;
      const i = Math.floor((ay + ((by - ay) * b.offsetM) / len) / 2) * foot.cols + Math.floor((ax + ((bx - ax) * b.offsetM) / len) / 2);
      if (foot0.wall[i] === 1 && foot.wall[i] === 0) opened++;
    }
    // A hole in a building's wall: an entry in the state's breaches the interiors read (ctx.breaches).
    expect(sim.ctx.breaches.length).toBe(result.damageOut!.breaches.length);
    if (holes.length > 0) expect(opened).toBeGreaterThan(0);
    // Positions dug in battle 1 are there in battle 2.
    expect(sim.state.terrain.positions?.length ?? 0).toBe(result.damageOut!.positions?.length ?? 0);
    // The wreck: blocked in every grid, of neither force.
    const wi = Math.floor(wy / 2) * tr.cols + Math.floor(wx / 2);
    expect(tr.cost[wi]).toBe(0);
    expect(foot.cost[wi]).toBe(0);
    const wv = [...sim.state.vehicle.values()].find((v) => v.vehicleId === "old-1")!;
    expect(wv.side).toBe(WRECK_SIDE);
    expect(wv.unit).toBeNull();
    // Run it a little: the wreck comes out as a wreck of its old side, counted in neither side's hulls.
    const r = runBattle({ ...input, rules: { ...input.rules, timeLimitSeconds: 5 } });
    expect(r.wrecks!.find((w) => w.vehicleId === "old-1")).toMatchObject({ side: "red", status: "destroyed", x: wx, y: wy });
    for (const s of r.sides) expect(s.vehicles?.start ?? 0).toBe((input.forces.find((f) => f.side === s.side)!.vehicles ?? []).filter((v) => !(input.forces.find((f) => f.side === s.side)!.offMap ?? []).some((a) => a.vehicleId === v.vehicleId)).length);
    expect(r.forcesOut.flatMap((f) => f.vehicles ?? []).some((v) => v.vehicleId === "old-1")).toBe(false);
    // damageOut keeps the input's damage.
    expect(r.damageOut!.craters.length).toBeGreaterThanOrEqual(craters.length);
  }, 300_000);
});

describe("M12.0a rules.campaignOut", () => {
  it("adds damageOut and service only, and changes nothing the battle does", () => {
    const a = buildScenario(data, def({ campaignOut: false, timeLimitSeconds: 150 }), ON_POSTS);
    const b = buildScenario(data, def({ campaignOut: true, timeLimitSeconds: 150 }), ON_POSTS);
    expect(a.rules.campaignOut).toBeUndefined();
    const ra = aiRunner(a, {}), rb = aiRunner(b, {});
    expect(ra.damageOut).toBeUndefined();
    expect(ra.service).toBeUndefined();
    expect(rb.eventCounts).toEqual(ra.eventCounts);
    expect(rb.orders).toEqual(ra.orders);
    expect(rb.forcesOut).toEqual(ra.forcesOut);
    expect(rb.damageOut).toBeDefined();
    const sv = rb.service!;
    const men = rb.sides.reduce((n, s) => n + s.soldiersStart, 0);
    expect(Object.keys(sv).length).toBe(men);
    const fired = Object.values(sv).reduce((n, x) => n + x.roundsFired, 0);
    expect(fired).toBe(rb.eventCounts["shot.fired"] ?? 0);
    for (const x of Object.values(sv)) expect(x.contactS).toBeLessThanOrEqual(150);
  }, 300_000);
});

describe("M12.0a chains", () => {
  it("xf runs a two-battle chain, the second with the first's men and damage", () => {
    const chain = runChain(data, { factions: ["xf", "de"], battles: 2, seed: 2, timeLimitSeconds: 180, hooks: ON_POSTS }, aiRunner);
    expect(chain.battles.length).toBe(2);
    const [b1, b2] = chain.battles;
    const blue1 = b1!.result.forcesOut.find((f) => f.side === "blue")!;
    const fieldedIds = new Set(members(b1!.next!.forces[0].units).map((m) => m.personId));
    expect(fieldedIds.size).toBeGreaterThan(0);
    // (The off-map assets' crews are the battle's, not the force's.)
    const assets = new Set((b1!.input.forces.find((f) => f.side === "blue")!.offMap ?? []).map((a) => a.vehicleId));
    for (const m of members(blue1.units.filter((u) => u.vehicleId === undefined || !assets.has(u.vehicleId)))) expect(fieldedIds.has(m.personId)).toBe(m.status === "fit" || m.status === "wounded");
    expect(b2!.input.damage).toEqual(b1!.result.damageOut);
    expect(b2!.input.forces.find((f) => f.side === "blue")!.faction).toBe("xf");
  }, 300_000);
});

describe("M12.0a lint", () => {
  it("rejects Math.random in packages/campaign/src", async () => {
    const eslint = new ESLint({ cwd: new URL("../../..", import.meta.url).pathname });
    const [res] = await eslint.lintText("export const x = Math.random();\n", { filePath: "packages/campaign/src/lint-probe.ts" });
    expect(res!.messages.map((m) => m.ruleId)).toContain("no-restricted-properties");
  }, 120_000);
});
