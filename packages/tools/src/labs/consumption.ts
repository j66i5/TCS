/**
 * CONSUMPTION LAB (M11.1, plan section 2 and slice 43 point 1): how much ammunition the battles use, per scenario,
 * side and weapon type, read from the state every 5 s and from the shots (`shot.fired` with a man's own weapon).
 *
 * A man's LOAD is the rounds in the magazine in his weapon plus his loaded magazines or belts for it; his LOOSE
 * rounds are those in packages (bandoliers, packs) of the same cartridge. OUT OF SPARES: no loaded spare magazine or
 * belt; DRY: no round in the weapon either. IN CONTACT: from a 5 s sample on which he has fired or been under fire
 * (suppression 0.1 or more) within the last 60 s. VEHICLE STOWAGE USED: rounds of the men's cartridges gone from the
 * vehicles' containers (not their guns' feeds).
 *
 *   npm run lab -- consumption [seeds] [--seconds 1200,2400] [--scenarios a,b] [--conservation] [--no-resupply] [--no-deliveries]
 */
import {
  continueBattle, createSim, isAssetUnit, isOffMapMan, type BattleInput, type Catalog, type EntityId, type SimEvent, type SimView,
} from "@tcs/sim";
import type { DataSet } from "@tcs/data";
import { getScenario } from "../scenarios";
import { conservationRun } from "../conservation";

export const CONSUMPTION_SCENARIOS = ["platoon", "platoon-ru", "platoon-vehicles", "platoon-ru-vehicles", "hold-resupply"];
const SAMPLE_S = 5;
const CONTACT_S = 60;
const UNDER_FIRE = 0.1;

interface ManTrack {
  side: string; faction: string; wtype: string; squad: EntityId;
  start: number; startLoose: number; atMark: number | null; end: number; fired: number;
  lastShotS: number; lastFireS: number; contactSamples: number; sampledFrom: number;
  outS: number | null; dryS: number | null;
}

export interface ConsumptionBattle {
  scenario: string; seed: number; endS: number; reason: string; winner: string | null; handovers: number; refills: number;
  men: ManTrack[];
  /** Per side: rounds of the men's cartridges in vehicle containers at start and end. */
  stowage: Record<string, { start: number; end: number }>;
  /** Per side: first time a squad had a man out of loaded spares, per squad (s). */
  squadsOut: Record<string, number[]>;
  /** First time a man of each side's machine guns was dry (s). */
  mgDry: Record<string, number | null>;
  /** M11.2: rounds taken from own casualties (and at the nest), takings from a live casualty before any treatment of
   *  his (must be 0), piles left outside the nest, rifles swapped. */
  taken: number; takenEvents: number; beforeTreatment: number; piles: number; swaps: number;
}

function manLoad(catalog: Catalog, state: SimView, id: EntityId): { load: number; loose: number; spares: number } {
  const w = state.weapon.get(id);
  if (!w) return { load: 0, loose: 0, spares: 0 };
  const wd = catalog.weapons[w.weapon];
  const mag = wd?.feed.magazine;
  const cart = mag !== undefined ? catalog.items[mag]?.chargeItem : undefined;
  let load = w.magazine?.rounds ?? 0, loose = 0, spares = 0;
  const c = state.container.get(id);
  if (c) for (const s of c.stacks) {
    if (s.type === mag) { load += (s.charge ?? 0) * s.count; if ((s.charge ?? 0) > 0) spares += s.count; }
    else if (cart !== undefined && s.type !== mag && catalog.items[s.type]?.chargeItem === cart && catalog.items[s.type]?.category === "ammo-package") loose += (s.charge ?? 0) * s.count;
  }
  return { load, loose, spares };
}

function stowageRounds(catalog: Catalog, state: SimView, side: string, carts: Set<string>): number {
  let n = 0;
  for (const [vid, v] of state.vehicle.entries()) {
    if (v.side !== side || v.offMap !== undefined) continue;
    const c = state.container.get(vid);
    if (c) for (const s of c.stacks) { const ci = catalog.items[s.type]?.chargeItem; if (ci !== undefined && carts.has(ci)) n += (s.charge ?? 0) * s.count; }
  }
  return n;
}

export function consumptionBattle(data: DataSet, scenario: string, seed: number, seconds: number, markS: number, tweak?: (input: BattleInput) => void): ConsumptionBattle {
  const sc = getScenario(scenario);
  const input = sc.build(data, seed, seconds);
  tweak?.(input);
  const controllers = sc.controllers?.(input) ?? [];
  const sim = createSim({ ...input, orders: [] });
  const catalog = input.catalog;
  const state = sim.state as SimView;
  const men = new Map<EntityId, ManTrack>();
  const carts = new Set<string>();
  for (const [id, ident] of state.identity.entries()) {
    if (isAssetUnit(state, ident.unit)) continue;
    const w = state.weapon.get(id);
    if (!w) continue;
    const wd = catalog.weapons[w.weapon];
    const cart = wd ? catalog.items[wd.feed.magazine]?.chargeItem : undefined;
    if (cart) carts.add(cart);
    const l = manLoad(catalog, state, id);
    men.set(id, {
      side: ident.side, faction: ident.faction, wtype: wd?.type ?? "?", squad: ident.unit, start: l.load, startLoose: l.loose,
      atMark: null, end: l.load, fired: 0, lastShotS: -1e9, lastFireS: -1e9, contactSamples: 0, sampledFrom: -1, outS: null, dryS: null,
    });
  }
  const stowage: ConsumptionBattle["stowage"] = {};
  for (const sd of state.sides) stowage[sd.id] = { start: stowageRounds(catalog, state, sd.id, carts), end: 0 };
  let handovers = 0, refills = 0, taken = 0, takenEvents = 0, beforeTreatment = 0, piles = 0, swaps = 0;
  const treated = new Set<EntityId>();
  const onEvents = (ev: SimEvent[]) => {
    for (const e of ev) {
      if (e.kind === "shot.fired" && e.vehicle === undefined && !e.indirect) {
        const m = men.get(e.shooter);
        const w = state.weapon.get(e.shooter);
        if (m && w && e.weapon === w.weapon) { m.fired++; m.lastShotS = e.tick / 60; }
      } else if (e.kind === "items.transferred" && men.has(e.from) && men.has(e.to) && catalog.items[e.item]?.chargeItem !== undefined) handovers++;
      else if (e.kind === "items.refilled") refills++;
      else if (e.kind === "medical.treated") treated.add(e.casualty);
      else if (e.kind === "items.taken" && (e.source === "casualty" || e.source === "nest")) {
        taken += e.rounds; takenEvents++;
        if (e.dead !== true && !treated.has(e.from)) beforeTreatment++;
      } else if (e.kind === "items.dropped") piles++;
      else if (e.kind === "weapon.swapped") swaps++;
    }
  };
  const onTick = () => {
    const t = state.tick;
    if (t % (SAMPLE_S * 60) !== 0) return;
    const s = t / 60;
    for (const [id, m] of men) {
      const so = state.soldier.get(id);
      if (!so || isOffMapMan(state, so)) continue; // (not arrived yet, or away)
      if (m.sampledFrom < 0) m.sampledFrom = s;
      const l = manLoad(catalog, state, id);
      m.end = l.load;
      if (s === markS) m.atMark = l.load;
      if (so.mental.suppression >= UNDER_FIRE) m.lastFireS = s;
      if (s - m.lastShotS <= CONTACT_S || s - m.lastFireS <= CONTACT_S) m.contactSamples++;
      if (m.outS === null && l.spares === 0 && m.start > 0) m.outS = s;
      if (m.dryS === null && l.load === 0 && m.start > 0) m.dryS = s;
    }
  };
  const res = continueBattle(sim, input, { controllers, onEvents, onTick });
  for (const [id, m] of men) { m.end = manLoad(catalog, state, id).load; if (m.atMark === null) m.atMark = m.end; }
  for (const sd of state.sides) stowage[sd.id]!.end = stowageRounds(catalog, state, sd.id, carts);
  const squadsOut: ConsumptionBattle["squadsOut"] = {}, mgDry: ConsumptionBattle["mgDry"] = {};
  for (const sd of state.sides) {
    const first = new Map<EntityId, number>();
    let mg: number | null = null;
    for (const m of men.values()) {
      if (m.side !== sd.id) continue;
      if (m.outS !== null) first.set(m.squad, Math.min(first.get(m.squad) ?? Infinity, m.outS));
      if (m.wtype === "machine-gun" && m.dryS !== null) mg = mg === null ? m.dryS : Math.min(mg, m.dryS);
    }
    squadsOut[sd.id] = [...first.values()].sort((a, b) => a - b);
    mgDry[sd.id] = mg;
  }
  return {
    scenario, seed, endS: res.durationSeconds, reason: res.endReason, winner: res.winner ?? null, handovers, refills,
    men: [...men.values()], stowage, squadsOut, mgDry, taken, takenEvents, beforeTreatment, piles, swaps,
  };
}

const q = (xs: number[], p: number) => { if (xs.length === 0) return 0; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]!; };
const med = (xs: number[]) => q(xs, 0.5);
const mean = (xs: number[]) => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);
const pct = (x: number) => `${Math.round(x * 100)} %`;
const f2 = (x: number) => x.toFixed(2);

export function consumptionMarkdown(battles: ConsumptionBattle[], markS: number): string {
  const out: string[] = [];
  const byScenario = new Map<string, ConsumptionBattle[]>();
  for (const b of battles) byScenario.set(b.scenario, [...(byScenario.get(b.scenario) ?? []), b]);
  for (const [name, bs] of byScenario) {
    out.push(`## ${name} (${bs.length} seeds)`, "");
    out.push(`Battle lengths ${bs.map((b) => Math.round(b.endS)).join(", ")} s (ends: ${[...new Set(bs.map((b) => b.reason))].sort().join(", ")}); winners ${bs.map((b) => b.winner ?? "none").join(", ")};`);
    out.push(`hand-overs of ammunition between men per battle: ${bs.map((b) => b.handovers).join(", ")}; magazines refilled from loose rounds: ${bs.map((b) => b.refills).join(", ")}.`);
    out.push(`M11.2: rounds taken from own casualties per battle: ${bs.map((b) => b.taken).join(", ")} (median ${med(bs.map((b) => b.taken))}; takings ${bs.reduce((a, b) => a + b.takenEvents, 0)}); **taken before treatment: ${bs.reduce((a, b) => a + b.beforeTreatment, 0)}**; piles left outside the nest: ${bs.reduce((a, b) => a + b.piles, 0)}; men dry per battle: ${bs.map((b) => b.men.filter((m) => m.dryS !== null).length).join(", ")} (mean ${f2(mean(bs.map((b) => b.men.filter((m) => m.dryS !== null).length)))}); men out of loaded spares per battle: ${bs.map((b) => b.men.filter((m) => m.outS !== null).length).join(", ")} (mean ${f2(mean(bs.map((b) => b.men.filter((m) => m.outS !== null).length)))}).`, "");
    out.push(`| side (who) | weapon | men | load at start (median) | loose at start (median) | fired per man: median / mean / 90th pct / max | per man and minute of battle (mean) | per man and minute IN CONTACT (all rounds / all contact minutes) | contact minutes per man (mean) | load gone by ${markS} s (mean) | load gone by the end (mean) | men out of loaded spares / dry | first out of spares (median s) |`);
    out.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|");
    const groups = new Map<string, ManTrack[]>();
    for (const b of bs) for (const m of b.men) { const k = `${m.side} ${m.faction}|${m.wtype}`; groups.set(k, [...(groups.get(k) ?? []), m]); }
    for (const [k, ms] of [...groups].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      const [who, wt] = k.split("|");
      const fired = ms.map((m) => m.fired);
      const perMin = ms.map((m) => { const b = bs.find((x) => x.men.includes(m))!; const mins = Math.max(1e-9, (b.endS - Math.max(0, m.sampledFrom)) / 60); return m.fired / mins; });
      const contactMin = ms.reduce((a, m) => a + (m.contactSamples * SAMPLE_S) / 60, 0);
      const goneMark = ms.filter((m) => m.start > 0).map((m) => (m.start - (m.atMark ?? m.end)) / m.start);
      const goneEnd = ms.filter((m) => m.start > 0).map((m) => (m.start - m.end) / m.start);
      const outs = ms.filter((m) => m.outS !== null).map((m) => m.outS!);
      out.push(`| ${who} | ${wt} | ${ms.length} | ${med(ms.map((m) => m.start))} | ${med(ms.map((m) => m.startLoose))} | ${med(fired)} / ${Math.round(mean(fired))} / ${q(fired, 0.9)} / ${Math.max(0, ...fired)} | ${f2(mean(perMin))} | ${contactMin > 0 ? f2(fired.reduce((a, b) => a + b, 0) / contactMin) : "-"} | ${f2(contactMin / ms.length)} | ${pct(mean(goneMark))} | ${pct(mean(goneEnd))} | ${outs.length} / ${ms.filter((m) => m.dryS !== null).length} | ${outs.length > 0 ? med(outs) : "-"} |`);
    }
    out.push("");
    const sides = [...new Set(bs.flatMap((b) => Object.keys(b.stowage)))].sort();
    out.push("| side | squads with a man out of loaded spares per battle (first, s) | first machine gun dry (s) per battle | vehicle stowage used (rounds per battle) |", "|---|---|---|---|");
    for (const sd of sides) {
      out.push(`| ${sd} | ${bs.map((b) => `${b.squadsOut[sd]?.length ?? 0}${(b.squadsOut[sd]?.length ?? 0) > 0 ? ` (${Math.round(b.squadsOut[sd]![0]!)})` : ""}`).join(", ")} | ${bs.map((b) => (b.mgDry[sd] === null || b.mgDry[sd] === undefined ? "-" : Math.round(b.mgDry[sd]!))).join(", ")} | ${bs.map((b) => (b.stowage[sd] ? b.stowage[sd]!.start - b.stowage[sd]!.end : 0)).join(", ")} |`);
    }
    out.push("");
  }
  return out.join("\n");
}

export interface ConsumptionOptions { seeds: number[]; marks: number[]; scenarios: string[]; conservation: boolean; noResupply: boolean; /** M11.4b: resupply on foot only (no deliveries from off the map, no vehicle supply runs, no top-up). */ noDeliveries?: boolean; /** M11.2: without consolidation and taking (the slice 43 behaviour), for before/after. */ noConsolidate?: boolean; /** `--scenarios` given (the conservation run then takes only those). */ scenariosGiven?: boolean }

export function consumptionOptions(argv: string[]): ConsumptionOptions {
  const o: ConsumptionOptions = { seeds: [1, 2, 3, 4, 5, 6], marks: [1200, 2400], scenarios: CONSUMPTION_SCENARIOS, conservation: false, noResupply: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--seconds") o.marks = argv[++i]!.split(",").map(Number);
    else if (a === "--scenarios") { o.scenarios = argv[++i]!.split(","); o.scenariosGiven = true; }
    else if (a === "--seeds") o.seeds = argv[++i]!.split(",").map(Number);
    else if (a === "--conservation") o.conservation = true;
    else if (a === "--no-resupply") o.noResupply = true;
    else if (a === "--no-deliveries") o.noDeliveries = true;
    else if (a === "--no-consolidate") o.noConsolidate = true;
    else if (/^\d+$/.test(a)) o.seeds = Array.from({ length: Number(a) }, (_, k) => k + 1);
  }
  return o;
}

/** The lab: the consumption tables, or (`--conservation`) the conservation guard over every named scenario. */
export function consumptionLab(data: DataSet, dataFixtures: DataSet, o: ConsumptionOptions, scenarioNames: string[]): string {
  const tweak = o.noResupply || o.noDeliveries || o.noConsolidate ? (input: BattleInput) => {
    if (o.noResupply) input.rules.resupply = false;
    if (o.noDeliveries) input.rules.deliveries = false;
    if (o.noConsolidate) { const { consolidate: _c, ...rest } = input.catalog.behaviour; void _c; input.catalog = { ...input.catalog, behaviour: rest }; }
  } : undefined;
  if (o.conservation) {
    const rows: string[] = ["| scenario | seed | seconds | ended (s) | rounds fired or used | leaks |", "|---|---|---|---|---|---|"];
    let leaks = 0;
    const runs: [string, number, number][] = [];
    const names = o.scenariosGiven ? o.scenarios : scenarioNames;
    for (const n of names.filter((x) => !x.startsWith("hold"))) for (const s of o.seeds) runs.push([n, s, 300]);
    if (!o.scenariosGiven || names.some((x) => x.startsWith("hold"))) for (const s of o.seeds.slice(0, 2)) runs.push([o.scenariosGiven ? names.find((x) => x.startsWith("hold"))! : "hold-resupply", s, 1200]);
    for (const [n, s, secs] of runs) {
      const sc = getScenario(n);
      const r = conservationRun(sc.fixtures ? dataFixtures : data, n, s, secs, tweak);
      const used = Object.values(r.consumption.used).reduce((a, b) => a + b, 0);
      const l = Object.entries(r.leaks);
      leaks += l.length;
      rows.push(`| ${n} | ${s} | ${secs} | ${Math.round(r.endS)} | ${used} | ${l.length === 0 ? "exact" : l.map(([k, v]) => `${k} ${v}`).join(", ")} |`);
      process.stderr.write(`${n} ${s}: ${l.length === 0 ? "exact" : JSON.stringify(r.leaks)}\n`);
    }
    return `## Conservation guard\n\nFor every ammunition id: start - end = fired + thrown + destroyed - delivered (events only). ${leaks === 0 ? "**Exact in every run.**" : `**${leaks} leaks.**`}\n\n${rows.join("\n")}\n`;
  }
  const limit = o.marks[o.marks.length - 1]!, mark = o.marks.length > 1 ? o.marks[0]! : limit;
  const battles: ConsumptionBattle[] = [];
  for (const n of o.scenarios) for (const s of o.seeds) {
    const secs = n.startsWith("hold") ? Math.max(limit, 3600) : limit;
    battles.push(consumptionBattle(data, n, s, secs, mark, tweak));
    process.stderr.write(`${n} ${s} done\n`);
  }
  return consumptionMarkdown(battles, mark);
}
