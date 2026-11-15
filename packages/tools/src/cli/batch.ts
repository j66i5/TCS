/**
 * Batch runner: runs a scenario with many seeds and writes a report to reports/.
 *   npm run batch -- --scenario demo --runs 200 --seconds 120
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { careNeed, needsEvacuation, environmentAt, finishRecord, lifeThreatNeed, newBattleRecord, newSideRecord, parseTimeOfDay, recordEvents, runBattle, stripInteriors, type SideRecord, type SimEvent, type Sim } from "@tcs/sim";
import { parseArgs } from "../args";
import { getScenario, loadData } from "../scenarios";
import { buildingsMarkdown, buildingsTally, type BuildingsTally } from "../buildings";

const args = parseArgs(process.argv.slice(2));
const timeOfDay = parseTimeOfDay(args["time"]);
const name = args["scenario"] ?? "demo";
const runs = Number(args["runs"] ?? 100);
const seconds = Number(args["seconds"] ?? 120);
const firstSeed = Number(args["seed"] ?? 1);
/** `--no-interiors`: the maps without building interiors, exactly as before M7.5c (comparison batches). */
const noInteriors = args["no-interiors"] !== undefined;
/** `--no-medical` (M10.2): care of the wounded switched off (`rules.medicalCare: false`), for comparison batches. */
const noMedical = args["no-medical"] !== undefined;
const sc = getScenario(name);
const data = loadData(sc.fixtures ?? false);

interface Row {
  seed: number; durationS: number; endReason: string; orders: number; hash: string; casualties: Record<string, number>; prisoners: Record<string, number>; wallMs: number; winner: string | null; scores: Record<string, number>;
  /** Vehicles (M7.2): lost (destroyed or abandoned) and immobilised per side; game time of each side's first dismount, s (null = none). */
  vehiclesLost: Record<string, number>; vehiclesImmobilised: Record<string, number>; firstDismountS: Record<string, number | null>;
  /** Ammunition expenditure (M7.3, plan C4): rounds by source per side (vehicle rounds credited to the vehicle). */
  spent: Record<string, { smallArms: number; grenades: number; handSmoke: number; rockets: number; cannon: number; coax: number; smoke: number }>;
  /** Crews (M7.4b) per side: times a crew reversed out, fires started, fires its extinguisher put out. */
  crews: Record<string, { reversedOut: number; fires: number; firesOut: number }>;
  /** Guided missiles (owner 2026-11-13) per side: fired, hit their target, lost by the gunner, missed; and enemy
   *  hulls penetrated by missiles and by shoulder-fired rockets. */
  missiles: Record<string, { fired: number; hit: number; lost: number; miss: number; penetrated: number; rocketPenetrated: number }>;
  /** Mortar fire (step fire-support) per calling side: HE bursts, of them ranging rounds, enemy men wounded in a
   *  tick with one of its bursts (fragments or blast), and of them put out of action. */
  mortar: Record<string, { bursts: number; ranging: number; enemyWounded: number; enemyDown: number }>;
  /** M7.5e: how the men used the houses (tools/src/buildings.ts). */
  buildings: BuildingsTally;
  /** Care (M10.2) per side of the casualty: treatments finished (self-aid, by a comrade) and of them worked; men
   *  who had at least one; tourniquets that worked. */
  care: Record<string, { self: number; buddy: number; worked: number; men: number; tourniquets: number }>;
  /** Carers (M10.3a) per side of the casualty: carers sent (comrades, first responders or medics); men who needed
   *  care at some time (looked at once a second) and of them men treated; seconds from first needing care to the
   *  first treatment (each treated man); the most comrade carers one casualty had at once (the cap: 1); men who
   *  died untreated within 2 minutes of first needing care (beyond help in time). */
  carers: Record<string, { comrades: number; responders: number; needed: number; cared: number; firstCareS: number[]; maxComrades: number; diedFast: number }>;
  /** M10.3b per side of the casualty: men with a life-threatening need care can answer (massive bleeding, airway,
   *  breathing; looked at once a second, with care on or off) and of them died of wounds before the end (preventable
   *  deaths: no new wound in the 30 s before death) or were killed by a new wound; triage tags by training and of
   *  them wrong; drags to cover started and finished. */
  m103b: Record<string, { lifeThreat: number; preventable: number; killedAfter: number; tags: Record<string, number>; wrong: Record<string, number>; drags: number; dragsDone: number; carries: Record<string, number>; carriedM: number; holds: number; loaded: number; unloaded: number }>;
  /** M10.5 per side: nests sited and moved, casualties sent back with bearers or walking, arrivals; at the end, the
   *  living uncaptured men to be taken back (or at the nest) and of them those who reached it; wrong tags, of them
   *  tagged again, and of those now right. */
  nest: Record<string, { sited: number; moved: number; tasked: number; walks: number; arrived: number; returned: number; needEnd: number; reachedEnd: number; wrong: number; wrongRetagged: number; corrected: number }>;
  /** M7.6b: per side and vehicle type, how many were there, lost (destroyed or abandoned) and immobilised at the end;
   *  per lost vehicle type, who made the last penetrating hit before the loss (the shooter's vehicle type, "team" for a
   *  missile team, "foot" for a man with a launcher, "none"); reactive tiles used per side (of the hulls hit); tank gun
   *  rounds per side (a gun on a vehicle with no passenger seats; armour-piercing and high explosive). */
  types: Record<string, Record<string, { n: number; lost: number; immob: number }>>; killers: Record<string, Record<string, number>>;
  era: Record<string, number>; tankRounds: Record<string, { ap: number; he: number }>;
  /** Men down (owner request 2026-11-15) per side of the man down: checked, found dead, dead dragged before the
   *  check, tags recovered (men), wounded who crawled to cover, prisoners' treatments by the enemy, surrendered men
   *  who crawled out of the fire; killed at the end. */
  down: Record<string, { checked: number; checkedDead: number; deadDragged: number; tags: number; tagMen: number; crawled: number; prisonersTreated: number; surrenderCrawled: number; killed: number }>;
}
const rows: Row[] = [];
const t0 = performance.now();
for (let i = 0; i < runs; i++) {
  const seed = firstSeed + i;
  const input = sc.build(data, seed, seconds);
  // `--time HH:MM [--moon 0..1]` (M9.1): the battle at that local time, the light following the clock.
  if (timeOfDay !== null) input.environment = environmentAt(input.catalog, timeOfDay, Number(args["moon"] ?? 0.5));
  if (noInteriors) input.map = stripInteriors(input.map);
  if (noMedical) input.rules.medicalCare = false;
  const s0 = performance.now();
  // D2: the battle record (`@tcs/sim` record.ts) folds the event stream exactly as the app's review does; the counts
  // below come from it. What it cannot see from events (needs looked at once a second) is kept here.
  const rec = newBattleRecord([...new Set(input.forces.map((f) => f.side))]);
  let pending: SimEvent[] = [];
  const sideOfSoldier = (sim: Sim, id: number) => sim.state.identity.get(id)?.side;
  const treated = (id: number) => rec.firstTreated[String(id)];
  const houses = buildingsTally(input);
  const carers: Record<string, { needed: number; firstCareS: number[]; maxComrades: number; diedFast: number }> = { blue: { needed: 0, firstCareS: [], maxComrades: 0, diedFast: 0 }, red: { needed: 0, firstCareS: [], maxComrades: 0, diedFast: 0 } };
  const gone = new Set<number>();
  const needSince = new Map<number, { tick: number; side: string }>(); // casualty -> tick he first needed care, his side
  const m103b: Record<string, { lifeThreat: number; preventable: number; killedAfter: number }> = { blue: { lifeThreat: 0, preventable: 0, killedAfter: 0 }, red: { lifeThreat: 0, preventable: 0, killedAfter: 0 } };
  const threatened = new Set<number>(), died = new Set<number>();
  // M10.5: who is to be taken back at the last look (living, not captured; at the nest counts).
  let evacEnd: { id: number; side: string }[] = [];
  // M7.6b: vehicles by type, the last penetrating hit on each hull (shooter label), tiles used, tank gun rounds.
  let simRef: Sim | null = null;
  const lastPen = new Map<number, string>();
  const killers: Record<string, Record<string, number>> = {}, era: Record<string, number> = { blue: 0, red: 0 }, tankRounds: Record<string, { ap: number; he: number }> = { blue: { ap: 0, he: 0 }, red: { ap: 0, he: 0 } };
  const shooterLabel = (sim: Sim, owner: number): string => {
    const s = sim.state.soldier.get(owner);
    if (s?.mount) return sim.state.vehicle.get(s.mount.vehicle)?.def ?? "vehicle";
    const uid = sim.state.identity.get(owner)?.unit;
    if (uid !== undefined && sim.state.unit.get(uid)?.missileTeam !== undefined) return "team";
    return s ? "foot" : "none";
  };
  const tankDef = (type: string) => { const d = input.catalog.vehicles[type]; return d !== undefined && !d.seats.some((q) => q.station === "passenger"); };
  const foldTanks = (sim: Sim, ev: readonly SimEvent[]) => {
    for (const e of ev) {
      if (e.kind === "vehicle.hit") {
        if (e.result === "penetrated") lastPen.set(e.vehicle, shooterLabel(sim, e.owner));
        if (e.era !== undefined) { const sd0 = sim.state.vehicle.get(e.vehicle)?.side; if (sd0) era[sd0] = (era[sd0] ?? 0) + 1; }
      } else if (e.kind === "vehicle.destroyed" || e.kind === "vehicle.abandoned") {
        if (lastPen.get(e.vehicle) === "counted") continue; // (abandoned, then destroyed: one loss)
        const t = sim.state.vehicle.get(e.vehicle)?.def ?? "?";
        const k = (killers[t] ??= {}), who = lastPen.get(e.vehicle) ?? "none";
        k[who] = (k[who] ?? 0) + 1;
        lastPen.set(e.vehicle, "counted");
      } else if (e.kind === "shot.fired" && e.vehicle !== undefined) {
        const v = sim.state.vehicle.get(e.vehicle), am = input.catalog.ammo[e.ammo];
        // (The tank's main gun: the first weapon of its first station.)
        if (!v || !am || am.guided !== undefined || !tankDef(v.def) || input.catalog.vehicles[v.def]?.stations[0]?.weapons[0]?.weapon !== e.weapon) continue;
        const tr = tankRounds[v.side] ??= { ap: 0, he: 0 };
        if (am.explosive !== undefined) tr.he++; else tr.ap++;
      }
    }
  };
  const r = runBattle(input, {
    controllers: sc.controllers?.(input) ?? [],
    onEvents: (ev) => { pending = ev; houses.onEvents(ev); },
    onTick: (sim) => {
      simRef = sim;
      foldTanks(sim, pending);
      houses.onTick(sim);
      recordEvents(rec, pending, sim.state, input.catalog);
      pending = [];
      // Life-threatening needs care can answer, and deaths after one (M10.3b), once a second, care on or off.
      if (sim.state.tick % 60 === 0) {
        for (const [id, s] of sim.state.soldier.entries()) {
          if (s.wounds.length === 0) continue;
          const k = m103b[sideOfSoldier(sim, id) ?? ""];
          if (!k) continue;
          if (!s.physiology.alive) {
            if (threatened.has(id) && !died.has(id)) {
              died.add(id);
              const lastHit = Math.max(...s.wounds.map((w) => w.tickInflicted));
              if (sim.state.tick - lastHit > 30 * 60) k.preventable++; else k.killedAfter++;
            }
            continue;
          }
          if (!threatened.has(id) && lifeThreatNeed(input.catalog, sim.state, id, sim.ctx.physiologyParams)) { threatened.add(id); k.lifeThreat++; }
        }
      }
      if (sim.state.tick % 60 === 0) {
        evacEnd = [];
        for (const [id, s] of sim.state.soldier.entries()) if (s.physiology.alive && s.captive === null && (needsEvacuation(s) || s.atNest !== undefined)) evacEnd.push({ id, side: sideOfSoldier(sim, id) ?? "" });
      }
      // Who needs care, once a second (M10.3a), and comrade carers per casualty at once.
      if (sim.state.tick % 60 === 0 && !noMedical) {
        const per = new Map<number, number>();
        for (const [id, s] of sim.state.soldier.entries()) {
          if (s.intent?.kind === "care" && s.intent.responder !== true && s.intent.target !== undefined) per.set(s.intent.target, (per.get(s.intent.target) ?? 0) + 1);
          if (!s.physiology.alive && needSince.has(id) && treated(id) === undefined && !gone.has(id)) {
            gone.add(id);
            const k = carers[sideOfSoldier(sim, id) ?? ""];
            if (k && sim.state.tick - needSince.get(id)!.tick < 120 * 60) k.diedFast++;
          }
          if (s.wounds.length === 0 || !s.physiology.alive || needSince.has(id) || treated(id) !== undefined) continue;
          if (careNeed(input.catalog, sim.state, id, sim.ctx.physiologyParams) === null) continue;
          const side = sideOfSoldier(sim, id) ?? "";
          needSince.set(id, { tick: sim.state.tick, side });
          const c = carers[side];
          if (c) c.needed++;
        }
        for (const [c, n] of per) { const k = carers[sideOfSoldier(sim, c) ?? ""]; if (k) k.maxComrades = Math.max(k.maxComrades, n); }
      }
    },
  });
  finishRecord(rec, r);
  const types: Record<string, Record<string, { n: number; lost: number; immob: number }>> = { blue: {}, red: {} };
  for (const v of (simRef as Sim | null)?.state.vehicle.values() ?? []) {
    const k = ((types[v.side] ??= {})[v.def] ??= { n: 0, lost: 0, immob: 0 });
    k.n++;
    if (v.status === "destroyed" || v.status === "abandoned") k.lost++;
    else if (v.status === "immobilised") k.immob++;
  }
  // Seconds from first needing care to the first treatment, per treated man (by his side).
  for (const [id, since] of needSince) { const t = treated(id), k = carers[since.side]; if (k && t !== undefined) k.firstCareS.push((t - since.tick) / 60); }
  const sd = (side: string) => rec.sides[side] ?? newSideRecord();
  const perSide = <T>(f: (x: SideRecord, side: string) => T): Record<string, T> => Object.fromEntries(["blue", "red"].map((x) => [x, f(sd(x), x)]));
  rows.push({
    seed, durationS: r.durationSeconds, endReason: r.endReason, orders: r.orders.length, hash: r.finalStateHash,
    casualties: Object.fromEntries(r.sides.map((s) => [s.side, s.wounded + s.killed])),
    prisoners: Object.fromEntries(r.sides.map((s) => [s.side, s.surrendered + s.captured])),
    wallMs: performance.now() - s0,
    winner: r.winner, scores: Object.fromEntries(r.scores.map((s) => [s.side, s.score])),
    vehiclesLost: Object.fromEntries(r.sides.map((s) => [s.side, (s.vehicles?.destroyed ?? 0) + (s.vehicles?.abandoned ?? 0)])),
    vehiclesImmobilised: Object.fromEntries(r.sides.map((s) => [s.side, s.vehicles?.immobilised ?? 0])),
    firstDismountS: perSide((x) => (x.firstDismountTick === null ? null : x.firstDismountTick / 60)),
    crews: perSide((x) => x.crews), missiles: perSide((x) => x.missiles), mortar: perSide((x) => x.mortar), buildings: houses.tally,
    care: perSide((x) => x.care),
    carers: perSide((x, side) => ({ comrades: x.carers.comrades, responders: x.carers.responders, needed: carers[side]!.needed, cared: carers[side]!.firstCareS.length, firstCareS: carers[side]!.firstCareS, maxComrades: carers[side]!.maxComrades, diedFast: carers[side]!.diedFast })),
    nest: perSide((x, side) => {
      const mine = evacEnd.filter((e) => e.side === side);
      return { ...x.nest, needEnd: mine.length, reachedEnd: mine.filter((e) => rec.atNest[String(e.id)] !== undefined).length, wrong: Object.values(x.wrongTags).reduce((a, b) => a + b, 0), ...x.retriage };
    }),
    types, killers, era, tankRounds,
    down: perSide((x, side) => ({ ...x.down, killed: r.sides.find((q) => q.side === side)?.killed ?? 0 })),
    m103b: perSide((x, side) => ({ ...m103b[side]!, tags: x.tags, wrong: x.wrongTags, drags: x.drags, dragsDone: x.dragsDone, carries: x.carries, carriedM: x.carriedM, holds: x.holds, loaded: x.loaded, unloaded: x.unloaded })),
    spent: Object.fromEntries(Object.entries(rec.exp).map(([side, e]) => {
      const vs = Object.values(e.vehicles);
      return [side, { smallArms: e.smallArms, grenades: e.grenades, handSmoke: e.handSmoke, rockets: Object.values(e.rockets).reduce((a, b) => a + b, 0), cannon: vs.reduce((n, v) => n + Object.values(v.cannon).reduce((a, b) => a + b, 0), 0), coax: vs.reduce((n, v) => n + v.coax, 0), smoke: vs.reduce((n, v) => n + v.smoke, 0) }];
    })),
  });
}
const totalMs = performance.now() - t0;
const uniqueHashes = new Set(rows.map((r) => r.hash)).size;
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
const ends: Record<string, number> = {};
for (const r of rows) ends[r.endReason] = (ends[r.endReason] ?? 0) + 1;

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const dir = fileURLToPath(new URL("../../../../reports", import.meta.url));
mkdirSync(dir, { recursive: true });
const md = [
  `# Batch report: ${name}`,
  "",
  `${sc.description}`,
  "",
  `- Building interiors: ${noInteriors ? "off (--no-interiors)" : "on"}`,
  `- Care of the wounded: ${noMedical ? "off (--no-medical)" : "on"}`,
  `- Runs: ${runs} (seeds ${firstSeed}..${firstSeed + runs - 1}), ${seconds} s game time each`,
  ...(timeOfDay !== null ? [`- Local time at the start: ${args["time"]} (moon ${args["moon"] ?? 0.5}; M9.1, light from the clock)`] : []),
  `- Wall time: ${(totalMs / 1000).toFixed(1)} s total, mean ${mean(rows.map((r) => r.wallMs)).toFixed(1)} ms per battle`,
  `- Speed: ${((runs * seconds) / (totalMs / 1000)).toFixed(0)}x real time`,
  `- Distinct final states: ${uniqueHashes} of ${runs}`,
  `- End reasons: ${Object.entries(ends).map(([k, v]) => `${k} ${v}`).join(", ")}`,
  `- Mean orders per battle: ${mean(rows.map((r) => r.orders)).toFixed(1)}`,
  `- Mean casualties per side: ${["blue", "red"].map((s) => `${s} ${mean(rows.map((r) => r.casualties[s] ?? 0)).toFixed(2)}`).join(", ")}`,
  `- Mean surrendered or taken prisoner per side: ${["blue", "red"].map((s) => `${s} ${mean(rows.map((r) => r.prisoners[s] ?? 0)).toFixed(2)}`).join(", ")}`,
  "",
  `- Winners: ${["blue", "red"].map((w) => `${w} ${rows.filter((r) => r.winner === w).length}`).join(", ")}, draw ${rows.filter((r) => r.winner === null).length}; mean score ${["blue", "red"].map((s) => `${s} ${mean(rows.map((r) => r.scores[s] ?? 0)).toFixed(1)}`).join(", ")}`,
  "(Winner and score: objectives held at the end minus men down, M6; without objectives every battle is a draw.)",
  `- Vehicles (M7.2): mean lost ${["blue", "red"].map((s) => `${s} ${mean(rows.map((r) => r.vehiclesLost[s] ?? 0)).toFixed(2)}`).join(", ")}; immobilised ${["blue", "red"].map((s) => `${s} ${mean(rows.map((r) => r.vehiclesImmobilised[s] ?? 0)).toFixed(2)}`).join(", ")}; first dismount at ${["blue", "red"].map((s) => { const xs = rows.map((r) => r.firstDismountS[s]).filter((x): x is number => x !== null && x !== undefined); return `${s} ${xs.length ? `${mean(xs).toFixed(0)} s (${xs.length} runs)` : "-"}`; }).join(", ")}`,
  `- Ammunition per battle (M7.3; vehicle rounds credited to the vehicle): ${["blue", "red"].map((s) => `${s} small arms ${mean(rows.map((r) => r.spent[s]?.smallArms ?? 0)).toFixed(0)}, grenades ${mean(rows.map((r) => r.spent[s]?.grenades ?? 0)).toFixed(1)}, anti-tank rounds ${mean(rows.map((r) => r.spent[s]?.rockets ?? 0)).toFixed(1)}, cannon ${mean(rows.map((r) => r.spent[s]?.cannon ?? 0)).toFixed(0)}, coax ${mean(rows.map((r) => r.spent[s]?.coax ?? 0)).toFixed(0)}, smoke salvos ${mean(rows.map((r) => r.spent[s]?.smoke ?? 0)).toFixed(1)}, hand smoke ${mean(rows.map((r) => r.spent[s]?.handSmoke ?? 0)).toFixed(1)}`).join("; ")}`,
  `- Guided missiles per battle (owner 2026-11-13): ${["blue", "red"].map((s) => `${s} fired ${mean(rows.map((r) => r.missiles[s]?.fired ?? 0)).toFixed(1)}, hit ${mean(rows.map((r) => r.missiles[s]?.hit ?? 0)).toFixed(1)}, lost ${mean(rows.map((r) => r.missiles[s]?.lost ?? 0)).toFixed(1)}, missed ${mean(rows.map((r) => r.missiles[s]?.miss ?? 0)).toFixed(1)}, enemy hulls penetrated ${mean(rows.map((r) => r.missiles[s]?.penetrated ?? 0)).toFixed(1)} (by rockets ${mean(rows.map((r) => r.missiles[s]?.rocketPenetrated ?? 0)).toFixed(1)})`).join("; ")}`,
  `- Mortar per battle (by the calling side): ${["blue", "red"].map((s) => `${s} HE bursts ${mean(rows.map((r) => r.mortar[s]?.bursts ?? 0)).toFixed(1)} (ranging rounds of any kind ${mean(rows.map((r) => r.mortar[s]?.ranging ?? 0)).toFixed(1)}), enemy wounded in a burst's tick ${mean(rows.map((r) => r.mortar[s]?.enemyWounded ?? 0)).toFixed(2)}, of them down ${mean(rows.map((r) => r.mortar[s]?.enemyDown ?? 0)).toFixed(2)}`).join("; ")}`,
  ...buildingsMarkdown(rows.map((r) => r.buildings), sc.build(data, firstSeed, 1).rules.objectives[0]?.holder ?? "blue"),
  `- Care per battle (M10.2, by the casualty's side): ${["blue", "red"].map((s) => `${s} self-aid ${mean(rows.map((r) => r.care[s]?.self ?? 0)).toFixed(1)}, by a comrade ${mean(rows.map((r) => r.care[s]?.buddy ?? 0)).toFixed(1)}, worked ${mean(rows.map((r) => r.care[s]?.worked ?? 0)).toFixed(1)}, men treated ${mean(rows.map((r) => r.care[s]?.men ?? 0)).toFixed(1)}, tourniquets on ${mean(rows.map((r) => r.care[s]?.tourniquets ?? 0)).toFixed(1)}`).join("; ")}`,
  `- Carers (M10.3a, by the casualty's side): ${["blue", "red"].map((s) => {
    const all = rows.flatMap((r) => r.carers[s]?.firstCareS ?? []).sort((a, b) => a - b);
    const needed = rows.reduce((n, r) => n + (r.carers[s]?.needed ?? 0), 0), got = rows.reduce((n, r) => n + (r.carers[s]?.cared ?? 0), 0);
    const med = all.length > 0 ? all[Math.floor(all.length / 2)]!.toFixed(0) : "-";
    const fast = rows.reduce((n, r) => n + (r.carers[s]?.diedFast ?? 0), 0), live = needed - fast;
    return `${s} comrades sent ${mean(rows.map((r) => r.carers[s]?.comrades ?? 0)).toFixed(1)}, first responders ${mean(rows.map((r) => r.carers[s]?.responders ?? 0)).toFixed(1)} per battle; needed care ${needed}, treated ${got} (${needed > 0 ? Math.round((100 * got) / needed) : 0} %; died untreated within 2 min ${fast}, treated of the rest ${live > 0 ? Math.round((100 * got) / live) : 0} %), median time to first treatment ${med} s; most comrades on one casualty ${Math.max(0, ...rows.map((r) => r.carers[s]?.maxComrades ?? 0))}`;
  }).join("; ")}`,
  `- Triage, care under fire (M10.3b, by the casualty's side): ${["blue", "red"].map((s) => {
    const sum = (f: (r: Row) => number) => rows.reduce((n, r) => n + f(r), 0);
    const lt = sum((r) => r.m103b[s]?.lifeThreat ?? 0), pd = sum((r) => r.m103b[s]?.preventable ?? 0);
    const skills = ["buddy", "firstResponder", "medic"].map((k) => { const n = sum((r) => r.m103b[s]?.tags[k] ?? 0), w = sum((r) => r.m103b[s]?.wrong[k] ?? 0); return `${k} ${w}/${n}${n > 0 ? ` (${Math.round((100 * w) / n)} %)` : ""}`; }).join(", ");
    const ka = sum((r) => r.m103b[s]?.killedAfter ?? 0);
    return `${s} life-threatening needs ${lt}, died of wounds before the end (preventable) ${pd} (${lt > 0 ? Math.round((100 * pd) / lt) : 0} %), ${(pd / Math.max(1, rows.length)).toFixed(2)} per battle, killed by a new wound ${ka}; wrong tags ${skills}; drags ${sum((r) => r.m103b[s]?.drags ?? 0)} (finished ${sum((r) => r.m103b[s]?.dragsDone ?? 0)}); carrying parties (M10.4a) ${(() => { const by: Record<string, number> = {}; for (const r of rows) for (const [m, n] of Object.entries(r.m103b[s]?.carries ?? {})) by[m] = (by[m] ?? 0) + n; const e = Object.entries(by).sort(); return e.length > 0 ? e.map(([m, n]) => `${m} ${n}`).join(", ") : "none"; })()}, ${sum((r) => r.m103b[s]?.carriedM ?? 0)} m carried, took cover ${sum((r) => r.m103b[s]?.holds ?? 0)}; into vehicles (M10.4b) ${sum((r) => r.m103b[s]?.loaded ?? 0)}, out ${sum((r) => r.m103b[s]?.unloaded ?? 0)}`;
  }).join("; ")}`,
  `- Verwundetennest (M10.5, by the casualty's side): ${["blue", "red"].map((s) => {
    const sum = (f: (r: Row) => number) => rows.reduce((n, r) => n + f(r), 0);
    const need = sum((r) => r.nest[s]?.needEnd ?? 0), got = sum((r) => r.nest[s]?.reachedEnd ?? 0);
    const wrong = sum((r) => r.nest[s]?.wrong ?? 0), again = sum((r) => r.nest[s]?.wrongRetagged ?? 0), fixed = sum((r) => r.nest[s]?.corrected ?? 0);
    return `${s} nests sited ${sum((r) => r.nest[s]?.sited ?? 0)}, moved ${sum((r) => r.nest[s]?.moved ?? 0)}; sent back with bearers ${sum((r) => r.nest[s]?.tasked ?? 0)}, walking ${sum((r) => r.nest[s]?.walks ?? 0)}, arrived ${sum((r) => r.nest[s]?.arrived ?? 0)}, returned to duty ${sum((r) => r.nest[s]?.returned ?? 0)}; at the end ${got} of ${need} to be taken back had reached it (${need > 0 ? Math.round((100 * got) / need) : 0} %); wrong tags ${wrong}, tagged again ${again}, now right ${fixed} (${wrong > 0 ? Math.round((100 * fixed) / wrong) : 0} % of wrong tags corrected)`;
  }).join("; ")}`,
  `- Vehicles by type (M7.6b; mean per battle, lost = destroyed or abandoned): ${["blue", "red"].map((s) => {
    const ts = [...new Set(rows.flatMap((r) => Object.keys(r.types?.[s] ?? {})))].sort();
    return `${s} ${ts.length === 0 ? "none" : ts.map((t) => `${t} x${mean(rows.map((r) => r.types[s]?.[t]?.n ?? 0)).toFixed(1)}: lost ${mean(rows.map((r) => r.types[s]?.[t]?.lost ?? 0)).toFixed(2)}, immobilised ${mean(rows.map((r) => r.types[s]?.[t]?.immob ?? 0)).toFixed(2)}`).join("; ")}`;
  }).join(" | ")}`,
  `- Kills by shooter (M7.6b; the last penetrating hit before each loss, all runs): ${(() => {
    const vs = [...new Set(rows.flatMap((r) => Object.keys(r.killers ?? {})))].sort();
    return vs.length === 0 ? "none" : vs.map((t) => { const by: Record<string, number> = {}; for (const r of rows) for (const [w, n] of Object.entries(r.killers[t] ?? {})) by[w] = (by[w] ?? 0) + n; return `${t} by ${Object.entries(by).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([w, n]) => `${w} ${n}`).join(", ")}`; }).join("; ");
  })()}`,
  `- Reactive tiles used and tank gun rounds per battle (M7.6b): ${["blue", "red"].map((s) => `${s} tiles ${mean(rows.map((r) => r.era?.[s] ?? 0)).toFixed(1)}, tank rounds AP ${mean(rows.map((r) => r.tankRounds?.[s]?.ap ?? 0)).toFixed(1)}, HE ${mean(rows.map((r) => r.tankRounds?.[s]?.he ?? 0)).toFixed(1)}`).join("; ")}`,
  `- Men down (owner 2026-11-15, by the side of the man down): ${["blue", "red"].map((s) => {
    const sum = (f: (r: Row) => number) => rows.reduce((n, r) => n + f(r), 0);
    const g = (k: keyof Row["down"][string]) => sum((r) => r.down[s]?.[k] ?? 0);
    return `${s} killed ${g("killed")}, checked ${g("checked")} (found dead ${g("checkedDead")}), dead dragged into cover before the check ${g("deadDragged")}, tags recovered from ${g("tagMen")} fallen (${g("tags")} items), wounded crawled to cover ${g("crawled")}, treatments as prisoners ${g("prisonersTreated")}, surrendered crawled out of the fire ${g("surrenderCrawled")}`;
  }).join("; ")}`,
  `- Crews per battle (M7.4b): ${["blue", "red"].map((s) => `${s} reversed out ${mean(rows.map((r) => r.crews[s]?.reversedOut ?? 0)).toFixed(1)}, fires ${mean(rows.map((r) => r.crews[s]?.fires ?? 0)).toFixed(1)} (put out ${mean(rows.map((r) => r.crews[s]?.firesOut ?? 0)).toFixed(1)})`).join("; ")}`,
  "",
  "| seed | duration s | end | winner | score blue/red | orders | casualties blue/red | hash |",
  "|---:|---:|---|---|---|---:|---|---|",
  ...rows.slice(0, 20).map((r) => `| ${r.seed} | ${r.durationS.toFixed(0)} | ${r.endReason} | ${r.winner ?? "draw"} | ${r.scores["blue"] ?? 0}/${r.scores["red"] ?? 0} | ${r.orders} | ${r.casualties["blue"] ?? 0}/${r.casualties["red"] ?? 0} | \`${r.hash}\` |`),
  rows.length > 20 ? `\n(first 20 of ${rows.length} rows; all rows in the JSON file)` : "",
].join("\n");
const base = join(dir, `batch-${name}${noInteriors ? "-no-interiors" : ""}${noMedical ? "-no-medical" : ""}-${stamp}`);
writeFileSync(`${base}.md`, md + "\n");
writeFileSync(`${base}.json`, JSON.stringify({ name, runs, seconds, rows }, null, 2));
console.log(md.split("\n").slice(0, 20).join("\n"));
console.log(`\nWrote ${base}.md and .json`);
