/**
 * CACHE LAB (M11.3, plan slice 45): what sets a crate of ammunition off, and what a cook-off does.
 *
 * Part A, the chance table: a full crate (a German 840-round can of 5.56 mm and a crate of 20 DM51 hand grenades; the
 * Russian tin of 1,080 5.45 mm and a crate of 20 RGD-5) and one high-explosive round bursting 0, 5, 10 and 20 m from it:
 * the tank guns' 120 mm and 125 mm HE, the 120 mm mortar bomb and the 152 / 155 mm shell. Each cell: the chance from
 * the data (`supply.blast`, one burst: `cookoffChance`) and the share of `trials` real bursts (`detonate` at that
 * distance) that set it off.
 * Part B, a cook-off to the end: the crate set off, the battle stepped until it has burnt out: how long it burnt, its
 * bursts (explosive rounds going off), the rounds lost (`items.destroyed`) against the ledger (exact), and a crate of
 * rifle rounds alone (no bursts).
 */
import { buildCatalog, type DataSet } from "@tcs/data";
import { buildForce, withoutVehicles } from "@tcs/scenario";
import {
  ammoIndexOf, checkConservation, consumedFromEvents, cookoffChance, createSim, DEFAULT_COMMS, detonate, emptyConsumption, EventSink, flatMap, ignite, ledgerOf, newCache, step, TICK_HZ, tracerMap,
  type BattleInput, type Catalog, type ItemStack, type Sim, type SimEvent,
} from "@tcs/sim";

export interface CacheChanceRow { round: string; fillingKg: number; cells: { d: number; data: number; real: number }[] }
export interface CacheBurnRow { crate: string; rounds: number; burntS: number; bursts: number; destroyed: number; exact: boolean }

const ROUNDS = ["de-120-dm11", "ru-125-3of26", "de-120-he", "ru-120-he", "ru-152-he", "de-155-he"];
const DIST = [0, 5, 10, 20];
const CRATES: Record<string, ItemStack[]> = {
  "DE can 5.56 + DM51 crate": [{ type: "de-556-can", count: 1, charge: 840 }, { type: "de-dm51-crate", count: 1, charge: 20 }],
  "RU tin 5.45 + RGD-5 crate": [{ type: "ru-545-tin", count: 1, charge: 1080 }, { type: "ru-rgd5-crate", count: 1, charge: 20 }],
  "DE can 5.56 alone": [{ type: "de-556-can", count: 1, charge: 840 }],
};

function labSim(data: DataSet, catalog: Catalog, seed: number): Sim {
  const a = withoutVehicles(buildForce(data, { faction: "de", template: "demo-team", seed, keyPrefix: "b" }));
  const b = withoutVehicles(buildForce(data, { faction: "ru", template: "demo-team", seed, keyPrefix: "r" }));
  const input: BattleInput = {
    map: flatMap("cache", 2000, 400, 4), catalog, seed, orders: [],
    rules: { timeLimitSeconds: 3600, commsModel: "simple", comms: { ...DEFAULT_COMMS, orderDelaySeconds: 0, orderDelayJitterSeconds: 0 }, physiologyModel: "none", physiologyParams: {}, objectives: [] },
    forces: [
      { side: "blue", faction: "de", units: [a], placements: a.members.map((m, i) => ({ personId: m.personId, x: 30, y: 30 + i * 4, heading: 0 })) },
      { side: "red", faction: "ru", units: [b], placements: b.members.map((m, i) => ({ personId: m.personId, x: 1970, y: 30 + i * 4, heading: Math.PI })) },
    ],
  };
  const sim = createSim(input);
  // (Nobody fires: the men are there only so that the battle is a battle.)
  for (const [uid] of sim.state.unit.entries()) sim.state.unit.req(uid).fireRule = "hold";
  return sim;
}

export function cacheChanceLab(data: DataSet, trials = 40): CacheChanceRow[] {
  const catalog = buildCatalog(data, ["de", "ru"]);
  const S = catalog.supply;
  if (!S) throw new Error("no core/supply.json");
  const rows: CacheChanceRow[] = [];
  for (const id of ROUNDS) {
    const f = catalog.ammo[id]?.explosive?.fillingKg;
    if (f === undefined) continue;
    const cells = DIST.map((d) => {
      let set = 0;
      for (let k = 1; k <= trials; k++) {
        const sim = labSim(data, catalog, k);
        const cache = newCache(sim.state, "blue", 1000, 200, CRATES["DE can 5.56 + DM51 crate"]!);
        detonate(sim.ctx, sim.state, new EventSink(), 1000 + d, 200, 0.3, ammoIndexOf(catalog, id), cache);
        if (sim.state.cache.req(cache).cookoff !== undefined) set++;
      }
      return { d, data: cookoffChance(S, f, d), real: set / trials };
    });
    rows.push({ round: id, fillingKg: f, cells });
  }
  return rows;
}

export function cacheBurnLab(data: DataSet): CacheBurnRow[] {
  const catalog = buildCatalog(data, ["de", "ru"]);
  const S = catalog.supply!;
  const rows: CacheBurnRow[] = [];
  for (const [name, load] of Object.entries(CRATES)) {
    const sim = labSim(data, catalog, 1);
    const cache = newCache(sim.state, "blue", 1000, 200, load);
    const start = ledgerOf(catalog, sim.state);
    const used = emptyConsumption(), tr = tracerMap(catalog);
    const sink = new EventSink();
    ignite(sim.ctx, sim.state, sink, S, cache, sim.state.cache.req(cache), "fire");
    const t0 = sim.state.tick;
    const ev: SimEvent[] = [...sink.events];
    for (let t = 0; t < (S.cookoff.maxS + 10) * TICK_HZ && sim.state.cache.req(cache).burnt !== true; t++) ev.push(...step(sim));
    consumedFromEvents(used, ev, tr);
    const end = ledgerOf(catalog, sim.state);
    rows.push({
      crate: name, rounds: load.reduce((n, s) => n + (s.charge ?? 1) * s.count, 0), burntS: (sim.state.tick - t0) / TICK_HZ,
      bursts: ev.filter((e) => e.kind === "explosion" && e.owner === cache).length,
      destroyed: Object.values(used.destroyed).reduce((a, b) => a + b, 0),
      exact: Object.keys(checkConservation(start, end, used)).length === 0,
    });
  }
  return rows;
}

export function cacheLabMarkdown(chance: CacheChanceRow[], burn: CacheBurnRow[], trials: number): string {
  const out = [
    "## Part A: one high-explosive burst beside a full crate",
    "",
    `A German can of 840 rounds of 5.56 mm and a crate of 20 DM51 hand grenades on open ground; one round bursts at the distance shown. Each cell: the data's chance for one burst (\`supply.blast\`: within ${"`reachScaledM` x filling^(1/3)"}, (1 - d/R) x min(maxChance, filling x chancePerKg), certain when the burst takes its hp to 0) / the share of ${trials} real bursts (\`detonate\`) that set it off.`,
    "",
    `| round | filling (kg) | ${DIST.map((d) => `${d} m`).join(" | ")} |`,
    `|---|---|${DIST.map(() => "---").join("|")}|`,
  ];
  for (const r of chance) out.push(`| ${r.round} | ${r.fillingKg} | ${r.cells.map((c) => `${(c.data * 100).toFixed(0)} % / ${(c.real * 100).toFixed(0)} %`).join(" | ")} |`);
  out.push("", "## Part B: a crate set off, to the end", "", "| crate | rounds in it | burnt (s) | bursts | rounds lost (events) | ledger |", "|---|---|---|---|---|---|");
  for (const r of burn) out.push(`| ${r.crate} | ${r.rounds} | ${r.burntS.toFixed(0)} | ${r.bursts} | ${r.destroyed} | ${r.exact ? "exact" : "**leak**"} |`);
  return out.join("\n");
}
