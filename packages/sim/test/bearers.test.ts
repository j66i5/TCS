/** M11.4a: squads ask for ammunition; bearers carry a crate from the platoon's supply point (the carry store). */
import { describe, expect, it } from "vitest";
import {
  createSim, flatMap, hashState, ledgerOf, loadSim, saveSim, secondsToTicks, step, submitOrder,
  type BattleInput, type Catalog, type Sim, type SimEvent, type SupplyDef, type UnitInput,
} from "../src/index";
import { DEFAULT_COMMS } from "../src/index";
import { rec, testCatalog } from "./helpers";
import { pickSupplyBearers, squadAmmo, squadLow } from "../src/systems/supply";

const SUPPLY: SupplyDef = {
  stepS: 1, nestApartM: 50, nestClearM: 15,
  site: { backM: 100, searchM: 40, minBackM: 50, maxBackM: 250, threatM: 100, driftM: 300, checkS: 10 },
  seeM: 250, heightM: 0.5,
  capture: { holdM: 50, enemyM: 10, seconds: 10 },
  blast: { reachScaledM: 5, hpKg: 4, chancePerKg: 0.3, maxChance: 0.9 },
  cookoff: { minS: 30, maxS: 120, stepS: 5, maxBurstsPerStep: 1, fireM: 8, fireChancePerS: 0.02, smokeRadiusM: 4, smokeTopM: 8 },
  take: { baseS: 10, bulkSecondsPerRound: 0.02, magSecondsPerRound: 0.4, reachM: 400, underFireS: 15 },
  ai: { heRounds: 3, everyS: 300, ownClearM: 100 },
  request: { stepS: 2, below: 0.4, beltsBelow: 1, everyS: 120, useM: 60, useMinRounds: 30 },
  bearers: {
    maxKg: 25, crateMaxKg: 40, loadS: 30, deliverM: 15, waitMateS: 60, giveUpS: 900, contactS: 30,
    methods: {
      crate: { carriers: 2, speedMps: 1, enduranceM: 250, restS: 30, setupS: 5, upright: true },
      load: { carriers: 1, speedMps: 1, enduranceM: 400, restS: 30, setupS: 5, upright: true },
    },
  },
};

const catalog: Catalog = {
  ...testCatalog,
  supply: SUPPLY,
  items: {
    ...testCatalog.items,
    can: { id: "can", massKg: 2.4, category: "ammo-package", chargeCapacity: 840, chargeMassKg: 0.012, chargeItem: "ball" },
  },
};

const EMPTY = [{ type: "mag", count: 1, charge: 30 }, { type: "mag", count: 3, charge: 0 }];
const FULL = [{ type: "mag", count: 3, charge: 30 }];

/**
 * A platoon (leader and runner) with one squad of five (leader, machine gunner, three riflemen) at x 400; its supply
 * point (two cans) at x `pointX`; an unarmed red man far away. The riflemen's spare magazines are empty unless `full`.
 */
function platoonInput(opts: { full?: boolean; pointX?: number; seconds?: number } = {}): BattleInput {
  const squad: UnitInput = {
    key: "sq", callsign: "Squad", echelon: "squad", leaderIndex: 0, subunits: [],
    members: [
      { ...rec("sq.0", FULL), weapon: "rifle" },
      { ...rec("sq.1", opts.full ? [{ type: "belt", count: 2, charge: 50 }] : [{ type: "belt", count: 1, charge: 50 }, { type: "belt", count: 1, charge: 0 }]), weapon: "gun" },
      ...[2, 3, 4].map((i) => ({ ...rec(`sq.${i}`, opts.full ? FULL : EMPTY), weapon: "rifle" })),
    ],
  };
  const plt: UnitInput = { key: "plt", callsign: "Platoon", echelon: "platoon", leaderIndex: 0, subunits: [squad], members: [{ ...rec("plt.0", FULL), weapon: "rifle" }, { ...rec("plt.1", FULL), weapon: "rifle" }] };
  const red: UnitInput = { key: "b", callsign: "b", echelon: "team", leaderIndex: 0, subunits: [], members: [rec("b.0")] };
  const px = opts.pointX ?? 100;
  return {
    map: flatMap("t", 600, 200),
    catalog,
    forces: [
      {
        side: "blue", faction: "fa", units: [plt],
        placements: [
          { personId: "plt.0", x: 350, y: 60, heading: 0 }, { personId: "plt.1", x: 352, y: 66, heading: 0 },
          ...squad.members.map((m, i) => ({ personId: m.personId, x: 400, y: 80 + i * 5, heading: 0 })),
        ],
        caches: [{ x: px, y: 100, load: [{ type: "can", count: 2, charge: 840 }], point: true }],
      },
      { side: "red", faction: "fb", units: [red], placements: [{ personId: "b.0", x: 590, y: 190, heading: 0 }] },
    ],
    rules: { timeLimitSeconds: opts.seconds ?? 1200, commsModel: "simple", comms: { ...DEFAULT_COMMS, orderDelaySeconds: 0, orderDelayJitterSeconds: 0 }, physiologyModel: "none", physiologyParams: {}, objectives: [] },
    seed: 1,
    orders: [],
  };
}

function run(sim: Sim, seconds: number): SimEvent[] {
  const out: SimEvent[] = [];
  for (let i = 0; i < secondsToTicks(seconds); i++) out.push(...step(sim));
  return out;
}
const unitOf = (sim: Sim, key: string) => [...sim.state.unit.entries()].find(([, u]) => u.callsign === key)![0];
const man = (sim: Sim, pid: string) => [...sim.state.identity.entries()].find(([, i]) => i.personId === pid)![0];

describe("resupply on foot (M11.4a)", () => {
  it("request thresholds: below 40 % of the standard load, or a machine gunner below one belt", () => {
    const full = createSim(platoonInput({ full: true }));
    const sq = unitOf(full, "Squad");
    expect(squadAmmo(full.ctx, full.state, sq).share).toBeCloseTo(1, 5);
    expect(squadLow(full.ctx, full.state, sq)).toBe(false);
    // The gunner's spare belts empty and his weapon's belt under 50: low on the belt alone.
    const g = man(full, "sq.1");
    full.state.container.req(g).stacks.forEach((s) => { s.charge = 0; });
    full.state.weapon.req(g).magazine!.rounds = 49;
    expect(squadAmmo(full.ctx, full.state, sq).gunnerLow).toBe(true);
    expect(squadLow(full.ctx, full.state, sq)).toBe(true);
    const low = createSim(platoonInput());
    const sq2 = unitOf(low, "Squad");
    const a = squadAmmo(low.ctx, low.state, sq2);
    // Leader 90 of 90, gunner 50 of 100, riflemen 30 of 120 each (a magazine in the weapon, three empty): 230 of 550.
    expect(a.share).toBeCloseTo(230 / 550, 5);
    expect(squadLow(low.ctx, low.state, sq2)).toBe(false); // 42 %: not yet
    low.state.weapon.req(man(low, "sq.2")).magazine!.rounds = 0;
    expect(squadLow(low.ctx, low.state, sq2)).toBe(true);
  });

  it("bearers: the headquarters' man (not its leader) and a rifleman of the squad, never the gunner or a leader", () => {
    const sim = createSim(platoonInput());
    const sq = unitOf(sim, "Squad");
    const point = [...sim.state.cache.entries()][0]![0];
    const b = pickSupplyBearers(sim.ctx, sim.state, sq, point, false);
    expect(b).toEqual([man(sim, "plt.1"), man(sim, "sq.4")]); // (the rifleman nearest the point: the rear)
    // Fired on: the squad gives nobody; the headquarters still sends its man.
    sim.state.unit.req(sq).ownFireTick = sim.state.tick;
    expect(pickSupplyBearers(sim.ctx, sim.state, sq, point, false)).toEqual([man(sim, "plt.1")]);
    // "Fetch ammunition": two of the squad's own riflemen, never its gunner or leader.
    const own = pickSupplyBearers(sim.ctx, sim.state, sq, point, true);
    expect(own).toHaveLength(2);
    for (const m of own) expect([man(sim, "sq.2"), man(sim, "sq.3"), man(sim, "sq.4")]).toContain(m);
  });

  it("a low squad asks; two bearers carry a crate from the point 300 m away; the men fill up; the ledger is exact", () => {
    const sim = createSim(platoonInput());
    const sq = unitOf(sim, "Squad");
    sim.state.weapon.req(man(sim, "sq.2")).magazine!.rounds = 0;
    const before = ledgerOf(catalog, sim.state);
    const ev = run(sim, 900);
    if (process.env["TRACE"]) for (const e of ev) if (e.kind.startsWith("supply") || e.kind === "medical.carried" || e.kind === "items.taken" || e.kind === "radio" || e.kind === "action.started" || e.kind==="action.interrupted") console.log(e.tick / 60, JSON.stringify(e));
    const radio = ev.filter((e) => e.kind === "radio").map((e) => (e.kind === "radio" ? e.key : ""));
    expect(radio).toContain("radio.ammoRequest");
    expect(radio).toContain("radio.bearersSent");
    const sent = ev.find((e) => e.kind === "supply.bearers");
    expect(sent && sent.kind === "supply.bearers" ? sent.men : []).toEqual([man(sim, "plt.1"), man(sim, "sq.4")]);
    expect(ev.some((e) => e.kind === "supply.loaded")).toBe(true);
    expect(ev.some((e) => e.kind === "medical.carried" && e.method === "crate" && e.phase === "start")).toBe(true);
    const del = ev.find((e) => e.kind === "supply.delivered");
    expect(del).toBeDefined();
    // The riflemen took from the crate beside them and are full again.
    expect(ev.some((e) => e.kind === "items.taken" && e.source === "cache")).toBe(true);
    for (const pid of ["sq.2", "sq.3"]) for (const s of sim.state.container.req(man(sim, pid)).stacks) if (s.type === "mag") expect(s.charge).toBe(30);
    expect(squadLow(sim.ctx, sim.state, sq)).toBe(false);
    // Nothing made or lost.
    expect(ledgerOf(catalog, sim.state).ammo).toEqual(before.ammo);
    // The bearers are free again.
    for (const pid of ["plt.1", "sq.4"]) expect(sim.state.soldier.req(man(sim, pid)).intent?.kind).not.toBe("bear");
  });

  it("under fire the bearers stop and lie down, and go on when it is quiet", () => {
    const sim = createSim(platoonInput());
    const sq = unitOf(sim, "Squad");
    sim.state.weapon.req(man(sim, "sq.2")).magazine!.rounds = 0;
    run(sim, 6);
    const b = man(sim, "plt.1");
    expect(sim.state.soldier.req(b).intent?.kind).toBe("bear");
    run(sim, 20);
    const x0 = sim.state.transform.req(b).x;
    // Pinned for a while: he stays where he is.
    for (let k = 0; k < 10; k++) { sim.state.soldier.req(b).mental.suppression = 0.9; run(sim, 1); }
    expect(Math.abs(sim.state.transform.req(b).x - x0)).toBeLessThan(6);
    expect(sim.state.soldier.req(b).intent?.kind).toBe("bear");
    run(sim, 60);
    expect(sim.state.transform.req(b).x).toBeLessThan(x0 - 50);
    void sq;
  });

  it("the player's rule \"ask\": the request waits for the order; save and load mid-carry continue identically", () => {
    const sim = createSim(platoonInput());
    const sq = unitOf(sim, "Squad");
    submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: sq, kind: "rules", supply: "ask" });
    sim.state.weapon.req(man(sim, "sq.2")).magazine!.rounds = 0;
    let ev = run(sim, 10);
    expect(ev.some((e) => e.kind === "supply.request" && e.pending === true)).toBe(true);
    expect(ev.some((e) => e.kind === "supply.bearers")).toBe(false);
    expect(sim.state.unit.req(sq).supplyAsk?.pending).toBe(true);
    submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: sq, kind: "bearers" });
    ev = run(sim, 200);
    expect(ev.some((e) => e.kind === "supply.bearers")).toBe(true);
    expect(sim.state.unit.req(sq).supplyAsk?.pending).toBeUndefined();
    // Mid-carry (the crate is on its way): save, load, both go on alike.
    let guard = 0;
    while (![...sim.state.carry.values()].some((c) => c.cargo === true) && guard++ < 400) run(sim, 1);
    expect([...sim.state.carry.values()].some((c) => c.cargo === true)).toBe(true);
    const saved = saveSim(sim);
    const other = loadSim(platoonInput(), saved);
    run(sim, 120); run(other, 120);
    expect(hashState(other.state)).toBe(hashState(sim.state));
  });

  it("with resupply off nobody asks and nobody is sent", () => {
    const input = platoonInput();
    input.rules.resupply = false;
    const sim = createSim(input);
    sim.state.weapon.req(man(sim, "sq.2")).magazine!.rounds = 0;
    const ev = run(sim, 60);
    expect(ev.some((e) => e.kind === "supply.request" || e.kind === "supply.bearers")).toBe(false);
  });
});
