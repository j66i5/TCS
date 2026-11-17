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
import { addMpAssets, buildForce, withoutVehicles } from "@tcs/scenario";
import {
  addSmoke, checkConservation, consumedFromEvents, createSim, DEFAULT_COMMS, detonate, EventSink, heldPrisoner, mpApproach, mpThere, emptyConsumption, flatMap, ledgerOf, loadKg, step, TICK_HZ, tracerMap,
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
export function prisonersBattle(data: DataSet, faction: string, template: string, seed: number, opts: { walkers?: number; mp?: boolean; limitS?: number } = {}): { input: BattleInput; pris: SoldierRecord[]; plt: UnitInput } {
  const enemy = faction === "de" ? "ru" : "de";
  const catalog = buildCatalog(data, ["de", "ru"]);
  const plt = withoutVehicles(buildForce(data, { faction, template, seed, keyPrefix: "b" }));
  const foe = withoutVehicles(buildForce(data, { faction: enemy, template: enemy === "de" ? "pzgren-zug" : "motor-rifle-platoon", seed, keyPrefix: "r" }));
  // Seven men of the other side give up: its first squad's men with a personal weapon, the leader first (he carries
  // the documents); ranks set to 1 officer, 1 NCO, 4 men, and a seventh with a broken leg. (Part 2, M11.9b: `walkers`
  // who can walk, the last of them a man with a broken leg as before.)
  const nw = opts.walkers ?? 6;
  const fm = members(foe).filter((m) => m.weapon !== undefined).slice(0, nw + 1);
  const want = ["officer", "nco", ...Array.from({ length: nw - 1 }, () => "man" as const)] as const;
  const pris: SoldierRecord[] = fm.map((m, i) => ({ ...m, rank: rankBy(catalog, enemy, want[i] ?? "man"), status: "surrendered" as const, ...(i === nw ? { wounds: [brokenLeg()] } : {}) }));
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
  // (Part 2's larger groups stand closer, beside the squad, so that every man is taken.)
  pris.forEach((m, i) => place.push(i === nw ? { personId: m.personId, x: 506, y: 232, heading: Math.PI } : (nw <= 6 ? { personId: m.personId, x: 515 + jx + (i % 3) * (3 + (seed % 3)), y: 225 + jy + Math.floor(i / 3) * (4 + (seed % 2)), heading: Math.PI } : { personId: m.personId, x: 510 + (i % 3) * 4, y: 218 + Math.floor(i / 3) * 7 + (i % 3) * 2.3 + (jy % 2), heading: Math.PI })));
  const input: BattleInput = {
    map: flatMap("prisoners", 2000, 600, 4), catalog, seed, orders: [],
    rules: { timeLimitSeconds: opts.limitS ?? 1800, commsModel: "simple", comms: { ...DEFAULT_COMMS, orderDelaySeconds: 0, orderDelayJitterSeconds: 0 }, physiologyModel: "medical", physiologyParams: {}, objectives: [] },
    forces: [
      { side: "blue", faction, units: [plt], placements: place.filter((p) => own.some((m) => m.personId === p.personId)), caches: [{ x: 120, y: 260, load: [crate(catalog, faction)], point: true }] },
      { side: "red", faction: enemy, units: [foeUnit], placements: place.filter((p) => pris.some((m) => m.personId === p.personId)) },
    ],
  };
  // (M11.9b: the platoon's side has its military police off the map; part 1 runs without it, as built in slice 53.)
  if (opts.mp === true) addMpAssets(data, catalog, input.forces[0]!, seed);
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

// ---------------------------------------------------------------- part 2: the military police (M11.9b)

export interface MpRunRow {
  faction: string; seed: number; walkers: number; places: number;
  /** Per run of the hull: the drawn delay, call to the edge, the drive alone, call to arrival (s). */
  runs: { dueS: number; edgeS: number; driveAloneS: number; arriveS: number; errPct: number; boarded: number; groups: string; evacuated: number; releasedS: number | null; awayS: number | null }[];
  maxAboard: number; officersFirst: boolean; allEvacuated: boolean; secondRun: boolean; ledgerExact: boolean; endS: number;
}

/** The hull driving alone from where it came on to where it stopped (a fresh battle, nobody else moving; s). */
function driveAlone(data: DataSet, faction: string, template: string, seed: number, walkers: number, entry: { x: number; y: number; heading: number }, goal: { x: number; y: number; px: number; py: number }): number {
  const { input } = prisonersBattle(data, faction, template, seed, { walkers, mp: true, limitS: 3600 });
  const sim = createSim(input);
  const [vid, v] = [...sim.state.vehicle.entries()].find(([, x]) => x.offMap?.kind === "mp")!;
  delete v.offMap;
  const t = sim.state.transform.req(vid);
  t.x = entry.x; t.y = entry.y; t.heading = entry.heading;
  const d = v.drive; d.progressX = entry.x; d.progressY = entry.y; d.progressTick = 0; d.backX = entry.x; d.backY = entry.y; d.brake = 0;
  // (The same way in as on its run: mp.ts mpApproach, arrival by mpThere, looked at once a second.)
  const g = mpApproach(sim.ctx, sim.state, vid, { x: goal.px, y: goal.py }).goal;
  for (let k = 0; k < 3600 * TICK_HZ; k++) {
    step(sim);
    if (k % TICK_HZ === TICK_HZ - 1 && mpThere(sim.ctx, sim.state, vid, g)) return (k + 1) / TICK_HZ;
  }
  return NaN;
}

export function mpTrial(data: DataSet, faction: string, template: string, seed: number, walkers: number): MpRunRow {
  const limitS = 7200;
  const { input } = prisonersBattle(data, faction, template, seed, { walkers, mp: true, limitS });
  const catalog = input.catalog;
  const sim = createSim(input);
  for (const [uid] of sim.state.unit.entries()) sim.state.unit.req(uid).fireRule = "hold";
  const start = ledgerOf(catalog, sim.state);
  const cons = emptyConsumption(), tracer = tracerMap(catalog);
  const [vid, v0] = [...sim.state.vehicle.entries()].find(([, x]) => x.offMap?.kind === "mp")!;
  const places = catalog.vehicles[v0.def]!.seats.filter((q) => q.station === "passenger").length;
  const ev: SimEvent[] = [];
  const legs: { entry: { x: number; y: number; heading: number }; goal: { x: number; y: number; px: number; py: number } | null }[] = [];
  let maxAboard = 0, t = 0;
  const walkersIds = new Set<EntityId>();
  for (const [id, i] of sim.state.identity.entries()) if (i.side === "red") { const s = sim.state.soldier.req(id); if (s.wounds.length === 0) walkersIds.add(id); }
  const allGone = () => [...walkersIds].every((m) => sim.state.soldier.get(m)?.captive?.evacTick !== undefined || !sim.state.soldier.get(m)?.physiology.alive);
  for (; t < limitS * TICK_HZ; t++) {
    const out = step(sim);
    consumedFromEvents(cons, out, tracer);
    ev.push(...out);
    // (A man of a larger group nobody walked over to or fetched within two minutes is taken where he stands by the
    // unit that took the others: part 2 measures the military police, not the hand-over.)
    if (t === 120 * TICK_HZ) {
      const by = ev.find((e): e is Extract<SimEvent, { kind: "captured" }> => e.kind === "captured");
      const unit = by ? sim.state.identity.req(by.by).unit : undefined;
      for (const m of walkersIds) { const c = sim.state.soldier.req(m).captive; if (c?.state === "surrendered" && unit !== undefined) { c.state = "captured"; c.by = "blue"; c.unit = unit; } }
    }
    const o = sim.state.vehicle.req(vid).offMap!;
    for (const e of out) if (e.kind === "pow.mp" && e.vehicle === vid && e.phase === "arrived") legs.push({ entry: { ...o.entry! }, goal: o.goal ? { ...o.goal } : null });
    if (t % TICK_HZ === 0) {
      let n = 0;
      for (const m of sim.state.vehicle.req(vid).seats) if (m !== null && sim.state.soldier.get(m)?.captive?.vehicle !== undefined && sim.state.soldier.get(m)?.captive?.evacTick === undefined) n++;
      maxAboard = Math.max(maxAboard, n);
      if (allGone()) break;
    }
  }
  const leaks = checkConservation(start, ledgerOf(catalog, sim.state), cons);
  const mp = ev.filter((e): e is Extract<SimEvent, { kind: "pow.mp" }> => e.kind === "pow.mp" && e.vehicle === vid);
  const runs: MpRunRow["runs"] = [];
  const calls = mp.filter((e) => e.phase === "called");
  calls.forEach((c, k) => {
    const next = calls[k + 1]?.tick ?? Infinity;
    const at = (ph: string) => mp.find((e) => e.phase === ph && e.tick >= c.tick && e.tick < next)?.tick;
    const enter = at("entered"), arrive = at("arrived"), away = at("away");
    const leg = legs[runs.length];
    const alone = leg?.goal ? driveAlone(data, faction, template, seed, walkers, leg.entry, leg.goal) : NaN;
    const arriveS = arrive !== undefined ? (arrive - c.tick) / TICK_HZ : NaN;
    const hand = (c.dueS ?? 0) + alone;
    const boarded = ev.filter((e): e is Extract<SimEvent, { kind: "pow.boarded" }> => e.kind === "pow.boarded" && e.tick >= c.tick && e.tick < next);
    const evac = ev.filter((e) => e.kind === "pow.evacuated" && e.tick >= c.tick && e.tick < next).length;
    const rel = ev.filter((e) => e.kind === "pow.guard" && e.phase === "released" && arrive !== undefined && e.tick >= arrive && e.tick < arrive + 60 * TICK_HZ);
    runs.push({
      dueS: c.dueS ?? 0, edgeS: enter !== undefined ? (enter - c.tick) / TICK_HZ : NaN, driveAloneS: Math.round(alone), arriveS: Math.round(arriveS),
      errPct: Number.isFinite(arriveS) && hand > 0 ? Math.round(((arriveS - hand) / hand) * 1000) / 10 : NaN,
      boarded: boarded.length, groups: boarded.map((b) => b.group[0]).join(""), evacuated: evac,
      releasedS: rel.length > 0 && arrive !== undefined ? Math.max(...rel.map((r) => (r.tick - arrive) / TICK_HZ)) : null, awayS: away !== undefined ? Math.round((away - c.tick) / TICK_HZ) : null,
    });
  });
  const order = (g: string) => (g === "o" ? 0 : g === "n" ? 1 : 2);
  const officersFirst = runs.every((r) => [...r.groups].every((g, i, a) => i === 0 || order(a[i - 1]!) <= order(g)));
  const boardedAll = ev.filter((e) => e.kind === "pow.boarded").map((e) => (e as Extract<SimEvent, { kind: "pow.boarded" }>).soldier);
  const evacAll = new Set(ev.filter((e) => e.kind === "pow.evacuated").map((e) => (e as Extract<SimEvent, { kind: "pow.evacuated" }>).soldier));
  return {
    faction, seed, walkers, places, runs, maxAboard, officersFirst,
    allEvacuated: boardedAll.length > 0 && boardedAll.every((m) => evacAll.has(m)) && allGone(),
    secondRun: runs.length >= 2 && runs[1]!.evacuated > 0, ledgerExact: Object.keys(leaks).length === 0, endS: Math.round(t / TICK_HZ),
  };
}

/** Part 2: per faction `runs` battles with one more walking prisoner than its hull has places (a second run). */
export function mpLab(data: DataSet, runs: number): MpRunRow[] {
  const catalog = buildCatalog(data, ["de", "ru"]);
  const rows: MpRunRow[] = [];
  for (const [f, tpl] of [["de", "pzgren-zug"], ["ru", "motor-rifle-platoon"]] as const) {
    const mp = data.factions[f]!.manifest.mp!, vt = data.factions[f]!.units[mp.template]!.vehicle!;
    const places = catalog.vehicles[vt]!.seats.filter((q) => q.station === "passenger").length;
    for (let s = 1; s <= runs; s++) rows.push(mpTrial(data, f, tpl, s, places + 1));
  }
  return rows;
}

export function mpLabMarkdown(rows: readonly MpRunRow[], catalog: Catalog): string {
  const MP = catalog.prisoners!.mp!;
  const out: string[] = [];
  out.push(`Delay ${MP.delayMinS}-${MP.delayMaxS} s (stream "mp"), stop ${MP.standM} m short, ${MP.loadS} s a prisoner to board, ready again ${MP.backS} s after it left the map. Each battle has one more walking prisoner than the hull has places, so a second run takes the rest. Drive alone: the same hull from the same entry to the same stop in an empty battle. Guards released: seconds from the MP's arrival to the last squad guard sent back.`);
  out.push("");
  out.push("| Faction | Seed | Walkers / places | Run | Delay (s) | Call to edge (s) | Drive alone (s) | Call to arrival (s) | vs delay + drive | Boarded (groups) | Evacuated | Guards released (s) |");
  out.push("|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const r of rows) r.runs.forEach((x, k) => out.push(`| ${r.faction} | ${r.seed} | ${r.walkers} / ${r.places} | ${k + 1} | ${x.dueS} | ${x.edgeS} | ${x.driveAloneS} | ${x.arriveS} | ${Number.isFinite(x.errPct) ? `${x.errPct > 0 ? "+" : ""}${x.errPct} %` : "-"} | ${x.boarded} (${x.groups || "-"}) | ${x.evacuated} | ${x.releasedS ?? "-"} |`));
  out.push("");
  out.push("| Faction | Seed | Most aboard / places | Officers first | Everyone aboard evacuated | Second run | Ledger | End (s) |");
  out.push("|---|---|---|---|---|---|---|---|");
  for (const r of rows) out.push(`| ${r.faction} | ${r.seed} | ${r.maxAboard} / ${r.places}${r.maxAboard > r.places ? " EXCEEDED" : ""} | ${r.officersFirst ? "yes" : "NO"} | ${r.allEvacuated ? "yes" : "NO"} | ${r.secondRun ? "yes" : "NO"} | ${r.ledgerExact ? "exact" : "LEAK"} | ${r.endS} |`);
  out.push("");
  for (const f of [...new Set(rows.map((r) => r.faction))]) {
    const rs = rows.filter((r) => r.faction === f), all = rs.flatMap((r) => r.runs);
    const edge = all.filter((x) => Math.abs(x.edgeS - x.dueS) <= 1).length;
    const within = rs.filter((r) => r.runs[0] !== undefined && Math.abs(r.runs[0].errPct) <= 10).length;
    const rel = all.filter((x) => x.releasedS !== null);
    out.push(`Summary ${f}: ${rs.length} battles, ${all.length} runs; call to edge = the drawn delay (to the second) in ${edge} of ${all.length}; first run's call to arrival within 10 % of delay + drive alone in ${within} of ${rs.length}; guards released within 30 s in ${rel.filter((x) => x.releasedS! <= 30).length} of ${rel.length} runs that found guards; places exceeded in ${rs.filter((r) => r.maxAboard > r.places).length}; officers first in ${rs.filter((r) => r.officersFirst).length}; everyone aboard evacuated in ${rs.filter((r) => r.allEvacuated).length}; second run in ${rs.filter((r) => r.secondRun).length}; ledger exact in ${rs.filter((r) => r.ledgerExact).length}.`);
  }
  return out.join("\n");
}

// ---------------------------------------------------------------- part 3: under fire (M11.9c)

export interface FireRow {
  faction: string; seed: number; kind: "near" | "far";
  /** Seconds from the first round to the point moving (`pow.point` "underFire"), and to every prisoner held there being
   *  more than `pcp.fireM` from where the rounds land; null: never (within the trial). */
  movedS: number | null; clearS: number | null; held: number;
  /** Prisoners hit (law.hit "prisoner") and wounded by the rounds; crawls out of the fire; exposures. */
  hits: number; wounded: number; crawls: number; exposures: number; underFireS: number;
}

/** The ammunition of the other side's mortar (its HE round): the rounds land near the point. */
function mortarHe(catalog: Catalog, faction: string): string {
  const he = catalog.factions[faction]?.fireSupport?.heAmmo;
  if (he === undefined) throw new Error(`no fire support HE for ${faction}`);
  return he;
}

/** Part 3: six walking prisoners held at the platoon's point, then the enemy's mortar rounds land `distM` from it every
 *  10 s for `forS` (near: 20 m east of it, 60 s; far: 300 m east, 120 s). */
export function fireTrial(data: DataSet, faction: string, template: string, seed: number, kind: "near" | "far"): FireRow {
  const { input } = prisonersBattle(data, faction, template, seed, { limitS: 3600 });
  const catalog = input.catalog, P = catalog.prisoners!;
  const sim = createSim(input);
  for (const [uid] of sim.state.unit.entries()) sim.state.unit.req(uid).fireRule = "hold";
  const red = [...sim.state.identity.entries()].filter(([, i]) => i.side === "red").map(([id]) => id);
  const walkers = red.filter((m) => sim.state.soldier.req(m).wounds.length === 0);
  const heldAll = () => walkers.every((m) => { const s = sim.state.soldier.get(m); return !s?.physiology.alive || s.captive?.point !== undefined; });
  let t = 0;
  for (; t < 1800 * TICK_HZ && !(t % TICK_HZ === 0 && heldAll() && t > 0); t++) step(sim);
  const ammo = catalog.ammoIds.indexOf(mortarHe(catalog, faction === "de" ? "ru" : "de"));
  const [pid, p0] = [...sim.state.rear.entries()].find(([, p]) => p.kind === "prisoners")!;
  const dist = kind === "near" ? 20 : 300, forS = kind === "near" ? 60 : 120;
  const fx = p0.x + dist, fy = p0.y;
  const held = walkers.filter((m) => sim.state.soldier.get(m)?.captive?.point === pid).length;
  const t0 = sim.state.tick;
  let movedS: number | null = null, clearS: number | null = null, hits = 0, wounded = 0, crawls = 0, exposures = 0, underFireS = 0;
  const hurt = new Set<EntityId>();
  for (let k = 0; k < (forS + 120) * TICK_HZ; k++) {
    const dt = sim.state.tick - t0;
    if (dt % (10 * TICK_HZ) === 0 && dt <= forS * TICK_HZ) {
      const ev = new EventSink();
      detonate(sim.ctx, sim.state, ev, fx, fy, 0, ammo, walkers[0]!);
    }
    for (const e of step(sim)) {
      if (e.kind === "pow.point" && e.reason === "underFire" && movedS === null) movedS = Math.round((e.tick - t0) / TICK_HZ);
      if (e.kind === "law.hit" && e.protection === "prisoner") hits++;
      if (e.kind === "wound" && walkers.includes(e.soldier) && !hurt.has(e.soldier)) { hurt.add(e.soldier); wounded++; }
      if (e.kind === "surrender.crawl" && walkers.includes(e.soldier)) crawls++;
      if (e.kind === "law.exposure") exposures++;
      if (e.kind === "pow.underFire") underFireS++;
    }
    if (clearS === null && sim.state.tick % TICK_HZ === 0) {
      // (Those who can still walk: a prisoner the rounds put down waits for the nest's bearers.)
      const far = walkers.every((m) => { const s = sim.state.soldier.get(m), tr = sim.state.transform.get(m); return !s?.physiology.alive || !s.impair.canWalk || s.physiology.consciousness < 0.5 || s.captive?.point !== pid || !tr || Math.hypot(tr.x - fx, tr.y - fy) > (P.pcp.fireM ?? 30); });
      if (far && (kind === "far" || movedS !== null)) clearS = Math.round((sim.state.tick - t0) / TICK_HZ);
    }
  }
  return { faction, seed, kind, movedS, clearS: kind === "far" ? null : clearS, held, hits, wounded, crawls, exposures, underFireS };
}

export function fireLab(data: DataSet, runs: number): FireRow[] {
  const rows: FireRow[] = [];
  for (const kind of ["near", "far"] as const) for (const [f, tpl] of [["de", "pzgren-zug"], ["ru", "motor-rifle-platoon"]] as const) for (let s = 1; s <= runs; s++) rows.push(fireTrial(data, f, tpl, s, kind));
  return rows;
}

export function fireLabMarkdown(rows: readonly FireRow[], catalog: Catalog): string {
  const P = catalog.prisoners!;
  const out: string[] = [];
  out.push(`The other side's mortar HE round bursts every 10 s: "near" 20 m east of the collection point for 60 s (the point moves when rounds land within ${P.pcp.fireM} m, at least ${P.pcp.fireClearM} m away from them), "far" 300 m east of it for 120 s. Moved: first round to the point moving; clear: to every prisoner held there who can walk more than ${P.pcp.fireM} m from the bursts. Hits: law.hit on a prisoner; wounded: prisoners wounded.`);
  out.push("");
  out.push("| Faction | Seed | Fire | Held | Moved (s) | Clear (s) | Prisoners hit | Wounded | Crawled | Under fire (s) | Exposures |");
  out.push("|---|---|---|---|---|---|---|---|---|---|---|");
  for (const r of rows) out.push(`| ${r.faction} | ${r.seed} | ${r.kind} | ${r.held} | ${r.movedS ?? "-"} | ${r.clearS ?? "-"} | ${r.hits} | ${r.wounded} | ${r.crawls} | ${r.underFireS} | ${r.exposures} |`);
  const near = rows.filter((r) => r.kind === "near"), far = rows.filter((r) => r.kind === "far");
  out.push("");
  out.push(`Summary: near ${near.length} runs, point moved within 60 s in ${near.filter((r) => r.movedS !== null && r.movedS <= 60).length}, prisoners clear within 60 s in ${near.filter((r) => r.clearS !== null && r.clearS <= 60).length} (median ${medianS(near.map((r) => r.clearS))} s); far ${far.length} runs, prisoners hit in ${far.filter((r) => r.hits + r.wounded > 0).length}, point moved in ${far.filter((r) => r.movedS !== null).length}, exposures ${far.reduce((n, r) => n + r.exposures, 0)}.`);
  return out.join("\n");
}

function medianS(xs: readonly (number | null)[]): string {
  const v = xs.filter((x): x is number => x !== null).sort((a, b) => a - b);
  return v.length === 0 ? "-" : String(v[Math.floor(v.length / 2)]);
}

// ---------------------------------------------------------------- part 4: escapes (M11.9c)

export interface EscapeRow {
  condition: "day" | "night" | "searched" | "smoke" | "guarded"; seed: number;
  /** Prisoner-minutes at risk (a walking prisoner held at his minute's roll), escapes started, the data chance a minute. */
  minutes: number; escapes: number; chance: number; expected: number; free: number; recaptured: number;
}

/**
 * Part 4: `n` prisoners of the other side (taken by the platoon's first squad, rule "ask": nobody escorts them) stand
 * 6 m apart in a field 300 m from the platoon, one man of their side 1,200 m east (where they run). Day (light 1),
 * night (light 0.05), searched, smoke over them, or guarded (four of the platoon's men among them). `minutes` long.
 */
/** Part 4's battle (also for tests): `n` prisoners of the Russian side held by the German platoon's first squad (rule
 *  "ask": nobody escorts them) 6 m apart at x 600, the platoon at x 300, the man they run to at x 1,800. */
export function escapeSetup(data: DataSet, seed: number, n: number, minutes: number, searched = false) {
  const catalog = buildCatalog(data, ["de", "ru"]);
  const plt = withoutVehicles(buildForce(data, { faction: "de", template: "pzgren-zug", seed, keyPrefix: "b" }));
  const foes: UnitInput[] = [];
  for (let k = 0; foes.reduce((x, u) => x + members(u).length, 0) < n + 1; k++) foes.push(withoutVehicles(buildForce(data, { faction: "ru", template: "motor-rifle-platoon", seed: seed * 10 + k, keyPrefix: `r${k}` })));
  const red = foes.flatMap(members).slice(0, n + 1);
  const own = members(plt);
  const place: { personId: string; x: number; y: number; heading: number }[] = [];
  own.forEach((m, i) => place.push({ personId: m.personId, x: 300 + (i % 6) * 4, y: 200 + Math.floor(i / 6) * 5, heading: 0 }));
  const side = Math.ceil(Math.sqrt(n));
  red.forEach((m, i) => place.push(i === n ? { personId: m.personId, x: 1800, y: 300, heading: Math.PI } : { personId: m.personId, x: 600 + (i % side) * 6, y: 270 + Math.floor(i / side) * 6, heading: Math.PI }));
  const input: BattleInput = {
    map: flatMap("escapes", 2000, 600, 4), catalog, seed, orders: [],
    rules: { timeLimitSeconds: (minutes + 5) * 60, commsModel: "simple", comms: { ...DEFAULT_COMMS, orderDelaySeconds: 0, orderDelayJitterSeconds: 0 }, physiologyModel: "medical", physiologyParams: {}, objectives: [] },
    forces: [
      { side: "blue", faction: "de", units: [plt], placements: place.filter((p) => own.some((m) => m.personId === p.personId)) },
      { side: "red", faction: "ru", units: foes, placements: place.filter((p) => red.some((m) => m.personId === p.personId)).concat(foes.flatMap(members).filter((m) => !red.includes(m)).map((m, i) => ({ personId: m.personId, x: 1900, y: 100 + i * 3, heading: 0 }))) },
    ],
  };
  const sim = createSim(input);
  const st = sim.state;
  for (const [, u] of st.unit.entries()) { u.fireRule = "hold"; if (u.side === "blue") u.prisonerRule = "ask"; }
  const pid = (p: string): EntityId => [...st.identity.entries()].find(([, i]) => i.personId === p)![0];
  const pris = red.slice(0, n).map((m) => pid(m.personId));
  const squad = st.identity.req(pid(plt.subunits[0]!.members[0]!.personId)).unit;
  for (const m of pris) {
    const s = st.soldier.req(m);
    s.captive = { state: "captured", tick: 0, by: "blue", unit: squad, ...(searched ? { searched: 0 } : {}) };
    s.mental.behaviour = "surrendered";
  }
  const dest = pid(red[n]!.personId);
  // (The rest of the other side's men, apart from the one they run to, are out of it: far away and taken too.)
  for (const [id, i] of st.identity.entries()) if (i.side === "red" && !pris.includes(id) && id !== dest) { const s = st.soldier.req(id); s.captive = { state: "captured", tick: 0, by: "blue", unit: squad }; s.mental.behaviour = "surrendered"; }
  const ownIds = own.map((m) => pid(m.personId)), hq = plt.members.map((m) => pid(m.personId));
  return { input, sim, pris, dest, own: ownIds, hq, squad, side, catalog };
}

export function escapeTrial(data: DataSet, condition: EscapeRow["condition"], seed: number, n = 100, minutes = 30): EscapeRow {
  const { sim, pris, own, hq, side, catalog } = escapeSetup(data, seed, n, minutes, condition === "searched");
  const E = catalog.prisoners!.escape!, st = sim.state;
  if (condition === "night") st.environment.light = 0.05;
  // (Guards stay where they are put: held there each second, whatever their squad does.)
  const pinned: { id: EntityId; x: number; y: number }[] = [];
  const pin = () => { for (const p of pinned) { const tr = st.transform.req(p.id); tr.x = p.x; tr.y = p.y; const mv = st.mover.get(p.id); if (mv) mv.waypoints = []; } };
  if (condition === "guarded") {
    // Four of the platoon's men stand among them (their quarters' middles).
    const g = own.filter((m) => !hq.includes(m)).slice(0, 4);
    const q = (side * 6) / 4;
    g.forEach((m, k) => pinned.push({ id: m, x: 600 + q + (k % 2) * 2 * q - 3, y: 270 + q + Math.floor(k / 2) * 2 * q - 3 }));
  }
  let minutes0 = 0, escapes = 0, free = 0, recaptured = 0, smokeLaid = false;
  const everyT = Math.max(1, Math.round(catalog.prisoners!.stepS * TICK_HZ)), per = Math.max(1, Math.round(60 / catalog.prisoners!.stepS));
  for (let t = 0; t < minutes * 60 * TICK_HZ; t++) {
    if (condition === "smoke" && (!smokeLaid || t % (60 * TICK_HZ) === 0)) {
      // (A thick cloud over the field, renewed every minute.)
      for (let k = 0; k < 4; k++) addSmoke(sim.ctx, st, 600 + side * 1.5 + (k % 2) * side * 3, 270 + side * 1.5 + Math.floor(k / 2) * side * 3, side * 3, 120, 6, 60);
      smokeLaid = true;
    }
    if (st.tick % everyT === 0) {
      pin();
      const slot = Math.floor(st.tick / everyT);
      for (const m of pris) {
        if ((slot + m) % per !== 0) continue;
        const s = st.soldier.req(m);
        if (heldPrisoner(s) && s.impair.canWalk && s.physiology.consciousness >= 0.5) minutes0++;
      }
    }
    for (const e of step(sim)) if (e.kind === "pow.escape" && pris.includes(e.soldier)) { if (e.phase === "started") escapes++; else if (e.phase === "free") free++; else if (e.phase === "recaptured") recaptured++; }
  }
  const chance = Math.min(1, E.perMinute * (condition === "night" ? E.darkFactor : 1) * (condition === "searched" ? E.searchedFactor : 1) * (condition === "smoke" ? E.smokeFactor : 1)) * (condition === "guarded" ? 0 : 1);
  return { condition, seed, minutes: minutes0, escapes, chance, expected: Math.round(minutes0 * chance * 10) / 10, free, recaptured };
}

export function escapeLab(data: DataSet, seeds: number): EscapeRow[] {
  const rows: EscapeRow[] = [];
  for (const c of ["day", "night", "searched", "smoke", "guarded"] as const) for (let s = 1; s <= seeds; s++) rows.push(escapeTrial(data, c, s));
  return rows;
}

export function escapeLabMarkdown(rows: readonly EscapeRow[], catalog: Catalog): string {
  const E = catalog.prisoners!.escape!;
  const out: string[] = [];
  out.push(`Data: ${E.perMinute} a minute unwatched; x ${E.darkFactor} below light ${E.darkBelowLight}, x ${E.smokeFactor} in smoke, x ${E.searchedFactor} searched; watched (a fit man of the holding side within ${catalog.prisoners!.guard.watchM} m who sees him): none. Prisoner-minutes: a walking prisoner held at his minute's roll.`);
  out.push("");
  out.push("| Condition | Seed | Prisoner-minutes | Chance a minute | Expected | Escapes | Free | Recaptured |");
  out.push("|---|---|---|---|---|---|---|---|");
  for (const r of rows) out.push(`| ${r.condition} | ${r.seed} | ${r.minutes} | ${r.chance} | ${r.expected} | ${r.escapes} | ${r.free} | ${r.recaptured} |`);
  out.push("");
  for (const c of [...new Set(rows.map((r) => r.condition))]) {
    const rs = rows.filter((r) => r.condition === c);
    const m = rs.reduce((x, r) => x + r.minutes, 0), e = rs.reduce((x, r) => x + r.escapes, 0), x = rs.reduce((y, r) => y + r.minutes * r.chance, 0);
    const dev = x > 0 ? Math.round(((e - x) / x) * 1000) / 10 : 0;
    out.push(`Summary ${c}: ${m} prisoner-minutes, ${e} escapes, expected ${Math.round(x * 10) / 10}${x > 0 ? ` (${dev > 0 ? "+" : ""}${dev} %, ${Math.abs(dev) <= 30 ? "within" : "OUTSIDE"} +-30 %)` : e === 0 ? " (none, as it should be)" : " (SHOULD BE NONE)"}; rate ${m > 0 ? Math.round((e / m) * 100000) / 100000 : 0} a minute.`);
  }
  return out.join("\n");
}
