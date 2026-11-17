/**
 * PRISONERS LAB (M11.9a, plan docs/plans/m11-mp-pow.md slice 53, part 1): the chain from taken to held, against the
 * rules and a hand calculation.
 *
 * A German Panzergrenadierzug and a Russian motor rifle platoon (data templates, on foot) stand on open flat ground;
 * the platoon's supply point (crates) and a wounded man of its own (a broken leg: the Verwundetennest is sited at once)
 * behind it; its first squad 200 m in front. Seven men of the other side give up 15 m in front of that squad: 1
 * officer, 1 NCO, 4 men (ranks by NATO code) who can walk, and one more man with a broken leg. Nobody fires. Measured:
 * each search (action start to end), each group's walk from its last search to its arrival at the collection point
 * (against the distance / the prisoners' pace with the slower man's load), what is left on each prisoner after his
 * search (nothing of the taken classes, every `prisonerKeeps` item), the groups at the point (never mixed), the guards
 * (= ceil(held / guard.perGuard)), the point's distance to the nest and the supply point, the non-walking prisoner at
 * the captors' nest, and the conservation guard (exact). `runs` battles per faction with different seeds.
 */
import { buildCatalog, type DataSet } from "@tcs/data";
import { buildForce, withoutVehicles } from "@tcs/scenario";
import {
  checkConservation, consumedFromEvents, createSim, DEFAULT_COMMS, emptyConsumption, flatMap, ledgerOf, loadKg, step, TICK_HZ, tracerMap,
  type BattleInput, type Catalog, type EntityId, type SimEvent, type SoldierRecord, type UnitInput, type Wound,
} from "@tcs/sim";

export interface PrisonersRow {
  faction: string; seed: number;
  searches: number; searchS: number[]; searchExact: boolean;
  walks: { group: string; n: number; distM: number; measuredS: number; handS: number; errPct: number }[];
  takenLeft: number; keptMissing: number; documentsTaken: number;
  mixed: boolean; held: number; guards: number; guardsOk: boolean;
  pointToNestM: number | null; pointToSupplyM: number | null;
  woundedAtNest: boolean; ledgerExact: boolean; endS: number;
}

function members(u: UnitInput): UnitInput["members"] { return [...u.members, ...u.subunits.flatMap(members)]; }

const brokenLeg = (): Wound => ({ id: 1, zone: "legL", mechanism: "bullet", severity: 0.3, bleedingLps: 0, compressible: false, airway: false, breathing: false, consciousness: false, tickInflicted: 0, treatments: [], fracture: true });

/** Two tins of the faction's largest ammunition package up to 1,200 rounds (the supply point's crates). */
function crate(catalog: Catalog, faction: string): { type: string; count: number; charge: number } {
  const d = Object.values(catalog.items).filter((x) => x.category === "ammo-package" && x.id.startsWith(`${faction}-`) && (x.chargeCapacity ?? 0) <= 1200)
    .sort((a, b) => (b.chargeCapacity ?? 0) - (a.chargeCapacity ?? 0) || (a.id < b.id ? -1 : 1))[0]!;
  return { type: d.id, count: 2, charge: d.chargeCapacity! };
}

function rankBy(catalog: Catalog, faction: string, want: "officer" | "nco" | "man"): string {
  const codes = catalog.factions[faction]?.natoCodes ?? {};
  const ids = Object.keys(codes).sort();
  const pick = ids.find((r) => {
    const c = codes[r]!;
    if (want === "officer") return c.startsWith("OF-");
    const n = Number(c.slice(3));
    return want === "nco" ? c.startsWith("OR-") && n >= 5 : c.startsWith("OR-") && n <= 3;
  });
  return pick ?? ids[0]!;
}

/** The lab's battle (also for tests): the platoon of `faction` (template `template`), seven men of the other side who
 *  have given up in front of its first squad (`pris`: officer, NCO, 4 men, a man with a broken leg). */
export function prisonersBattle(data: DataSet, faction: string, template: string, seed: number): { input: BattleInput; pris: SoldierRecord[]; plt: UnitInput } {
  const enemy = faction === "de" ? "ru" : "de";
  const catalog = buildCatalog(data, ["de", "ru"]);
  const plt = withoutVehicles(buildForce(data, { faction, template, seed, keyPrefix: "b" }));
  const foe = withoutVehicles(buildForce(data, { faction: enemy, template: enemy === "de" ? "pzgren-zug" : "motor-rifle-platoon", seed, keyPrefix: "r" }));
  // Seven men of the other side give up: its first squad's men with a personal weapon, the leader first (he carries
  // the documents); ranks set to 1 officer, 1 NCO, 4 men, and a seventh with a broken leg.
  const fm = members(foe).filter((m) => m.weapon !== undefined).slice(0, 7);
  const want = ["officer", "nco", "man", "man", "man", "man", "man"] as const;
  const pris: SoldierRecord[] = fm.map((m, i) => ({ ...m, rank: rankBy(catalog, enemy, want[i]!), status: "surrendered" as const, ...(i === 6 ? { wounds: [brokenLeg()] } : {}) }));
  const foeUnit: UnitInput = { key: "rp", callsign: "RP", echelon: "squad", leaderIndex: 0, subunits: [], members: pris };
  // The platoon: headquarters (and a wounded man of its own) at x 300, its squads at x 500 (200 m in front).
  const own = members(plt);
  const hq = plt.members;
  const hurt = own.find((m) => !hq.includes(m) && m.weapon !== undefined && plt.subunits[1] !== undefined && members(plt.subunits[1]).includes(m))!;
  hurt.wounds = [brokenLeg()]; hurt.status = "wounded";
  const place: { personId: string; x: number; y: number; heading: number }[] = [];
  hq.forEach((m, i) => place.push({ personId: m.personId, x: 300, y: 300 + i * 5, heading: 0 }));
  plt.subunits.forEach((sq, k) => members(sq).forEach((m, i) => place.push({ personId: m.personId, x: (k === 0 ? 500 : 320) + (i % 2) * 4, y: 220 + k * 60 + Math.floor(i / 2) * 6, heading: 0 })));
  // (The man who cannot walk lies beside the squad, where it takes him at once.)
  // (Each run gives up at a slightly different spot: seed-dependent offsets of a few metres.)
  const jx = ((seed * 37) % 11) - 5, jy = ((seed * 53) % 9) - 4;
  pris.forEach((m, i) => place.push(i === 6 ? { personId: m.personId, x: 506, y: 232, heading: Math.PI } : { personId: m.personId, x: 515 + jx + (i % 3) * (3 + (seed % 3)), y: 225 + jy + Math.floor(i / 3) * (4 + (seed % 2)), heading: Math.PI }));
  const input: BattleInput = {
    map: flatMap("prisoners", 2000, 600, 4), catalog, seed, orders: [],
    rules: { timeLimitSeconds: 1800, commsModel: "simple", comms: { ...DEFAULT_COMMS, orderDelaySeconds: 0, orderDelayJitterSeconds: 0 }, physiologyModel: "medical", physiologyParams: {}, objectives: [] },
    forces: [
      { side: "blue", faction, units: [plt], placements: place.filter((p) => own.some((m) => m.personId === p.personId)), caches: [{ x: 120, y: 260, load: [crate(catalog, faction)], point: true }] },
      { side: "red", faction: enemy, units: [foeUnit], placements: place.filter((p) => pris.some((m) => m.personId === p.personId)) },
    ],
  };
  return { input, pris, plt };
}

export function prisonersTrial(data: DataSet, faction: string, template: string, seed: number, trace?: (events: readonly SimEvent[], sim: ReturnType<typeof createSim>) => void): PrisonersRow {
  const { input, pris } = prisonersBattle(data, faction, template, seed);
  const catalog = input.catalog, P = catalog.prisoners!;
  const sim = createSim(input);
  for (const [uid] of sim.state.unit.entries()) sim.state.unit.req(uid).fireRule = "hold";
  const start = ledgerOf(catalog, sim.state);
  const cons = emptyConsumption(), tracer = tracerMap(catalog);
  const ev: SimEvent[] = [];
  const pid = (p: string): EntityId => [...sim.state.identity.entries()].find(([, i]) => i.personId === p)![0];
  const ids = pris.map((m) => pid(m.personId));
  const walkers = ids.slice(0, 6), lame = ids[6]!;
  // Load factors at the start of each walk (the prisoner after his search, his escort with what he took).
  const B = catalog.body.movement;
  const loadF = (m: EntityId) => Math.min(1, Math.max(B.minLoadSpeedFactor, 1 - B.loadSpeedPerKg * Math.max(0, loadKg(sim.ctx, sim.state, m) - B.loadFreeKg)));
  const walkStart = new Map<EntityId, { tick: number; x: number; y: number; f: number }>();
  let mixed = false;
  const done = () => walkers.every((m) => sim.state.soldier.get(m)?.captive?.point !== undefined || !sim.state.soldier.get(m)?.physiology.alive)
    && (sim.state.soldier.get(lame)?.atNest !== undefined || !sim.state.soldier.get(lame)?.physiology.alive);
  let t = 0;
  for (; t < 1800 * TICK_HZ; t++) {
    const out = step(sim);
    consumedFromEvents(cons, out, tracer);
    ev.push(...out);
    trace?.(out, sim);
    for (const e of out) {
      if (e.kind === "pow.escort") {
        const gs = new Set(e.prisoners.map((m) => sim.state.soldier.get(m)?.captive?.group));
        if (gs.size > 1) mixed = true;
      }
      if (e.kind === "pow.searched") {
        const g = sim.state.soldier.get(e.by)?.guard;
        if (g && g.men.every((m) => sim.state.soldier.get(m)?.captive?.searched !== undefined)) {
          // (His last search: the walk starts now.)
          const slow = Math.min(loadF(e.by), ...g.men.map(loadF));
          for (const m of g.men) { const tr = sim.state.transform.req(m); walkStart.set(m, { tick: e.tick, x: tr.x, y: tr.y, f: slow }); }
        }
      }
    }
    if (t % 60 === 0 && done()) break;
  }
  const end = ledgerOf(catalog, sim.state);
  const leaks = checkConservation(start, end, cons);
  // ---- the searches
  const started = new Map<EntityId, number>();
  const searchS: number[] = [];
  for (const e of ev) {
    if (e.kind === "action.started" && e.action === "searchPrisoner") started.set(e.actor, e.tick);
    if (e.kind === "action.completed" && e.action === "searchPrisoner") { const s0 = started.get(e.actor); if (s0 !== undefined) searchS.push((e.tick - s0) / TICK_HZ); }
  }
  const interrupted = ev.some((e) => e.kind === "action.interrupted" && e.action === "searchPrisoner");
  // ---- what is left on them
  let takenLeft = 0, keptMissing = 0;
  for (const m of ids) {
    const s = sim.state.soldier.get(m);
    if (!s || s.captive?.searched === undefined) continue;
    if (sim.state.weapon.has(m)) takenLeft++;
    for (const st of sim.state.container.get(m)?.stacks ?? []) if (catalog.items[st.type]?.prisonerKeeps !== true) takenLeft += st.count;
    const rec = pris[ids.indexOf(m)]!;
    for (const l of rec.load) if (catalog.items[l.type]?.prisonerKeeps === true) {
      const have = (sim.state.container.get(m)?.stacks ?? []).filter((x) => x.type === l.type).reduce((n, x) => n + x.count, 0);
      if (have < l.count) keptMissing += l.count - have;
    }
  }
  const documentsTaken = ev.filter((e) => e.kind === "pow.documents").reduce((n, e) => n + (e.kind === "pow.documents" ? e.count : 0), 0);
  // ---- the walks (by group: from the escort's last search to the last of them held)
  const walks: PrisonersRow["walks"] = [];
  const pt = [...sim.state.rear.entries()].find(([, p]) => p.kind === "prisoners");
  const groups = new Map<EntityId, EntityId[]>();
  for (const e of ev) if (e.kind === "pow.escort") groups.set(e.escort * 1000 + e.tick, e.prisoners);
  const walk = catalog.movementModes["walk"]!, pace = ("speedMps" in walk ? walk.speedMps : 1.4) * catalog.behaviour.surrender.walkSpeedFactor;
  for (const [, men] of [...groups.entries()].sort((a, b) => a[0] - b[0])) {
    const ws = men.filter((m) => walkers.includes(m) && walkStart.has(m));
    if (ws.length === 0) continue;
    let measured = 0, hand = 0, d = 0;
    for (const m of ws) {
      const h = ev.find((e) => e.kind === "pow.held" && e.soldier === m);
      const w0 = walkStart.get(m)!;
      if (!h) continue;
      const tr = sim.state.transform.req(m);
      const dm = Math.hypot(tr.x - w0.x, tr.y - w0.y);
      measured = Math.max(measured, (h.tick - w0.tick) / TICK_HZ);
      hand = Math.max(hand, dm / (pace * w0.f));
      d = Math.max(d, dm);
    }
    const g = sim.state.soldier.get(ws[0]!)?.captive?.group ?? "man";
    walks.push({ group: g, n: ws.length, distM: Math.round(d), measuredS: Math.round(measured), handS: Math.round(hand), errPct: hand > 0 ? Math.round(((measured - hand) / hand) * 1000) / 10 : 0 });
  }
  // ---- the point: groups apart, guards, distances
  let held = 0, guards = 0;
  if (pt) {
    for (const [, s] of sim.state.soldier.entries()) {
      if (s.captive?.point === pt[0] && s.physiology.alive && s.atNest === undefined) held++;
      if (s.guard?.point === pt[0] && s.guard.phase === "guard") guards++;
    }
    // Mixed: a held man nearer another group's spot than his own.
    const spots: Record<string, { x: number; y: number }> = {};
    for (const g of ["officer", "nco", "man"] as const) spots[g] = { x: pt[1].x + (g === "officer" ? -P.segregation.apartM : g === "nco" ? P.segregation.apartM : 0), y: pt[1].y };
    for (const m of walkers) {
      const s = sim.state.soldier.get(m), tr = sim.state.transform.get(m);
      if (!s?.captive?.point || !tr) continue;
      const own = s.captive.group ?? "man";
      const dOwn = Math.hypot(tr.x - spots[own]!.x, tr.y - spots[own]!.y);
      for (const g of Object.keys(spots)) if (g !== own && Math.hypot(tr.x - spots[g]!.x, tr.y - spots[g]!.y) < dOwn) mixed = true;
    }
  }
  const rear = (k: string) => [...sim.state.rear.entries()].find(([, p]) => p.kind === k)?.[1];
  const nest = rear("medical"), sup = rear("supply");
  const dTo = (q: { x: number; y: number } | undefined) => (pt && q ? Math.round(Math.hypot(pt[1].x - q.x, pt[1].y - q.y)) : null);
  return {
    faction, seed, searches: searchS.length, searchS, searchExact: !interrupted && searchS.length > 0 && searchS.every((x) => Math.abs(x - P.search.seconds) < 1 / TICK_HZ + 1e-9),
    walks, takenLeft, keptMissing, documentsTaken, mixed, held, guards, guardsOk: guards === Math.ceil(held / P.guard.perGuard),
    pointToNestM: dTo(nest), pointToSupplyM: dTo(sup), woundedAtNest: sim.state.soldier.get(lame)?.atNest !== undefined && sim.state.rear.get(sim.state.soldier.get(lame)!.atNest!)?.side === "blue",
    ledgerExact: Object.keys(leaks).length === 0, endS: Math.round(t / TICK_HZ),
  };
}

export function prisonersLab(data: DataSet, runs: number): PrisonersRow[] {
  const rows: PrisonersRow[] = [];
  for (const [f, tpl] of [["de", "pzgren-zug"], ["ru", "motor-rifle-platoon"]] as const) for (let s = 1; s <= runs; s++) rows.push(prisonersTrial(data, f, tpl, s));
  return rows;
}

export function prisonersLabMarkdown(rows: readonly PrisonersRow[], catalog: Catalog): string {
  const P = catalog.prisoners!;
  const out: string[] = [];
  out.push(`Search ${P.search.seconds} s a man, escorts ${P.escort.perGuard} prisoners of one group, guards 1 per ${P.guard.perGuard} held, point ${P.pcp.apartM} m from the nest and the supply point. Walk: the prisoners' pace (walk x ${catalog.behaviour.surrender.walkSpeedFactor}) with the slower load factor of the group and its escort.`);
  out.push("");
  out.push("| Faction | Seed | Searches (s each) | Walks: group n dist, measured / hand (err) | Taken left | Kept missing | Documents | Mixed | Held / guards | Point to nest / supply (m) | Lame man at nest | Ledger | End (s) |");
  out.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const r of rows) {
    const s = r.searchS.length > 0 ? `${r.searches} (${[...new Set(r.searchS.map((x) => x.toFixed(2)))].join(", ")})${r.searchExact ? "" : " NOT EXACT"}` : "none";
    const w = r.walks.map((x) => `${x.group} ${x.n} ${x.distM} m ${x.measuredS} / ${x.handS} s (${x.errPct > 0 ? "+" : ""}${x.errPct} %)`).join("; ");
    out.push(`| ${r.faction} | ${r.seed} | ${s} | ${w} | ${r.takenLeft} | ${r.keptMissing} | ${r.documentsTaken} | ${r.mixed ? "MIXED" : "no"} | ${r.held} / ${r.guards}${r.guardsOk ? "" : " WRONG"} | ${r.pointToNestM ?? "-"} / ${r.pointToSupplyM ?? "-"} | ${r.woundedAtNest ? "yes" : "NO"} | ${r.ledgerExact ? "exact" : "LEAK"} | ${r.endS} |`);
  }
  const allW = rows.flatMap((r) => r.walks);
  const within = allW.filter((x) => Math.abs(x.errPct) <= 10).length;
  out.push("");
  out.push(`Summary: ${rows.length} battles; searches exact in ${rows.filter((r) => r.searchExact).length}; walks within 10 % of the hand calculation ${within} of ${allW.length}; taken-class items left on searched prisoners ${rows.reduce((n, r) => n + r.takenLeft, 0)}; kept items missing ${rows.reduce((n, r) => n + r.keptMissing, 0)}; groups mixed in ${rows.filter((r) => r.mixed).length}; guards right in ${rows.filter((r) => r.guardsOk).length}; point within ${P.pcp.apartM} m of the nest or supply point in ${rows.filter((r) => (r.pointToNestM ?? 1e9) < P.pcp.apartM || (r.pointToSupplyM ?? 1e9) < P.pcp.apartM).length}; non-walking prisoner at the captors' nest in ${rows.filter((r) => r.woundedAtNest).length}; ledger exact in ${rows.filter((r) => r.ledgerExact).length}.`);
  return out.join("\n");
}
