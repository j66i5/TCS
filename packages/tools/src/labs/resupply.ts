/**
 * RESUPPLY LAB (M11.4a, plan slice 46): how long does resupply on foot take, against a hand calculation?
 *
 * A German Panzergrenadierzug and a Russian motor rifle platoon (data templates, on foot) stand on open flat ground, the
 * platoon's supply point (one tin of loose rounds per cartridge per squad, as in hold-resupply) `distanceM` behind
 * them; an enemy team far off; nobody fires. The first squad's riflemen have fired their spare magazines empty, so it
 * asks for ammunition at once. Measured: the request, the bearers sent, their arrival at the point (loading starts),
 * the crate loaded, delivered beside the squad, and the last man of the squad filled up from it. Hand calculation:
 * the bearers' walk to the point (distance / walk speed with their load), loading (`bearers.loadS`), the carry back
 * (set-up, distance / carry speed with the crate's mass, a rest each `enduranceM`), and the men's walk to the crate
 * and taking (`take.baseS` + 0.4 s a round into a magazine). Target: within 10 %.
 */
import { buildCatalog, type DataSet } from "@tcs/data";
import { addSupplyAssets, buildForce, defaultRules, vehicleBattle, withoutVehicles } from "@tcs/scenario";
import {
  checkConservation, consumedFromEvents, createSim, DEFAULT_COMMS, emptyConsumption, flatMap, ledgerOf, loadKg, step, submitOrder, TICK_HZ, tracerMap,
  type BattleInput, type Catalog, type EntityId, type SimEvent, type UnitInput,
} from "@tcs/sim";

export interface ResupplyRow {
  faction: string; distanceM: number; bearers: string[];
  requestS: number | null; atPointS: number | null; loadedS: number | null; deliveredS: number | null; fullS: number | null;
  crateKg: number; crateRounds: number; carryMps: number;
  hand: { walkS: number; loadS: number; carryS: number; takeS: number; totalS: number };
  measuredS: number | null; errPct: number | null; ledgerExact: boolean;
}

/** A pace's speed on foot (m/s). */
function footSpeed(catalog: Catalog, id: string): number {
  const m = catalog.movementModes[id];
  return m !== undefined && "speedMps" in m && typeof m.speedMps === "number" ? m.speedMps : 1.5;
}

function members(u: UnitInput): UnitInput["members"] { return [...u.members, ...u.subunits.flatMap(members)]; }

function oneTrial(data: DataSet, catalog: Catalog, faction: string, template: string, distanceM: number): ResupplyRow {
  const plt = withoutVehicles(buildForce(data, { faction, template, seed: 1, keyPrefix: "b" }));
  const foe = withoutVehicles(buildForce(data, { faction: faction === "de" ? "ru" : "de", template: "demo-team", seed: 1, keyPrefix: "r" }));
  const squad = plt.subunits[0]!;
  // The first squad's riflemen have fired their spare magazines empty (the one in the weapon full).
  for (const m of members(squad)) {
    const wd = m.weapon !== undefined ? catalog.weapons[m.weapon] : undefined;
    if (!wd || wd.sustained !== undefined) continue;
    const feed = wd.feed.magazine, cap = catalog.items[feed]!.chargeCapacity!;
    const n = m.load.filter((l) => l.type === feed).reduce((k, l) => k + l.count, 0);
    m.load = m.load.filter((l) => l.type !== feed && catalog.items[l.type]?.category !== "ammo-package");
    m.load.push({ type: feed, count: 1, charge: cap }, { type: feed, count: Math.max(0, n - 1), charge: 0 });
  }
  // The supply point: per squad one tin of each cartridge its men fire (the hold battle's rule, plan slice 43).
  const packages = Object.values(catalog.items).filter((d) => d.category === "ammo-package" && d.id.startsWith(`${faction}-`));
  const load = new Map<string, { type: string; count: number; charge: number }>();
  for (const sq of plt.subunits) {
    const carts = new Set<string>();
    for (const m of members(sq)) for (const l of m.load) { const d = catalog.items[l.type]; if (d?.category === "magazine" && d.chargeItem !== undefined) carts.add(d.chargeItem); }
    for (const c of [...carts].sort()) {
      const best = packages.filter((d) => d.chargeItem === c && (d.chargeCapacity ?? 0) <= 1200).sort((a, b) => (b.chargeCapacity ?? 0) - (a.chargeCapacity ?? 0) || (a.id < b.id ? -1 : 1))[0];
      if (!best) continue;
      const x = load.get(best.id);
      if (x) x.count++; else load.set(best.id, { type: best.id, count: 1, charge: best.chargeCapacity! });
    }
  }
  const X = 100 + distanceM, all = members(plt), fm = members(foe);
  // Headquarters a little behind, the squads side by side (10 m between men across, squads 40 m apart).
  const place: { personId: string; x: number; y: number; heading: number }[] = [];
  plt.members.forEach((m, i) => place.push({ personId: m.personId, x: X - 20, y: 300 + i * 5, heading: 0 }));
  plt.subunits.forEach((sq, k) => members(sq).forEach((m, i) => place.push({ personId: m.personId, x: X + (i % 2) * 4, y: 220 + k * 60 + Math.floor(i / 2) * 6, heading: 0 })));
  const input: BattleInput = {
    map: flatMap("resupply", 2000, 600, 4), catalog, seed: 1, orders: [],
    rules: { timeLimitSeconds: 1800, commsModel: "simple", comms: { ...DEFAULT_COMMS, orderDelaySeconds: 0, orderDelayJitterSeconds: 0 }, physiologyModel: "none", physiologyParams: {}, objectives: [] },
    forces: [
      { side: "blue", faction, units: [plt], placements: place, caches: [{ x: 100, y: 300, load: [...load.values()].sort((a, b) => (a.type < b.type ? -1 : 1)), point: true }] },
      { side: "red", faction: faction === "de" ? "ru" : "de", units: [foe], placements: fm.map((m, i) => ({ personId: m.personId, x: 1980, y: 300 + i * 5, heading: Math.PI })) },
    ],
  };
  void all;
  const sim = createSim(input);
  for (const [uid] of sim.state.unit.entries()) sim.state.unit.req(uid).fireRule = "hold";
  const S = catalog.supply!, B = S.bearers!, beh = catalog.body;
  const start = ledgerOf(catalog, sim.state);
  const ev: SimEvent[] = [];
  let full: number | null = null;
  const sqId = [...sim.state.unit.entries()].find(([, u]) => u.callsign === squad.callsign && u.parent !== null)?.[0];
  let load_: EntityId | null = null;
  for (let t = 0; t < 1800 * TICK_HZ && full === null; t++) {
    const out = step(sim);
    ev.push(...out);
    for (const e of out) if (e.kind === "supply.delivered" && e.unit === sqId) load_ = e.load;
    if (load_ !== null && t % 30 === 0) {
      // Filled up: every man of the squad who took from the crate is back to it doing nothing else.
      const takers = ev.filter((e) => e.kind === "items.taken" && e.from === load_);
      const busy = (sim.state.unit.get(sqId!)?.members ?? []).some((m) => { const s = sim.state.soldier.get(m); return s?.intent?.kind === "resupply" && s.intent.target === load_ && s.intent.back !== true; })
        || (sim.state.unit.get(sqId!)?.members ?? []).some((m) => sim.state.action.get(m)?.kind === "takeSupply");
      if (takers.length > 0 && !busy) full = takers[takers.length - 1]!.tick;
    }
  }
  const at = (k: SimEvent["kind"], f: (e: SimEvent) => boolean = () => true) => { const e = ev.find((x) => x.kind === k && f(x)); return e ? e.tick / TICK_HZ : null; };
  const sent = ev.find((e) => e.kind === "supply.bearers" && e.unit === sqId);
  const men = sent && sent.kind === "supply.bearers" ? sent.men : [];
  const loaded = ev.find((e) => e.kind === "supply.loaded" && e.unit === sqId);
  const crateKg = loaded && loaded.kind === "supply.loaded" ? loaded.kg : 0;
  const crateRounds = loaded && loaded.kind === "supply.loaded" ? loaded.rounds : 0;
  // ---- the hand calculation (from the start positions and the data)
  const walk = footSpeed(catalog, "walk");
  const pt = { x: 100, y: 300 };
  const p0 = (pid: string) => place.find((p) => p.personId === pid)!;
  const ident = (m: EntityId) => sim.state.identity.req(m).personId;
  const sim0 = createSim(input);
  const loadF = (m: EntityId) => {
    const kg = loadKg(sim0.ctx, sim0.state, m);
    return Math.min(1, Math.max(beh.movement.minLoadSpeedFactor, 1 - beh.movement.loadSpeedPerKg * Math.max(0, kg - beh.movement.loadFreeKg)));
  };
  const walkS = Math.max(0, ...men.map((m) => { const p = p0(ident(m)); return Math.hypot(p.x - pt.x, p.y - pt.y) / (walk * loadF(m)); }));
  const leader = squad.members[squad.leaderIndex] ?? squad.members[0]!;
  const drop = p0(leader.personId);
  const d2 = Math.hypot(drop.x - pt.x, drop.y - pt.y);
  const def = B.methods.crate;
  const carryMps = def.speedMps * Math.min(1.15, Math.max(0.75, Math.sqrt((catalog.medical?.carrying?.massRefKg ?? 105) / Math.max(1, crateKg))));
  const carryS = def.setupS + d2 / carryMps + Math.floor(d2 / def.enduranceM) * def.restS;
  // Taking: the riflemen each put (magazines - 1) x capacity into magazines; they walk from their place to the crate.
  let takeS = 0;
  for (const m of members(squad)) {
    const wd = m.weapon !== undefined ? catalog.weapons[m.weapon] : undefined;
    if (!wd || wd.sustained !== undefined) continue;
    const feed = wd.feed.magazine, cap = catalog.items[feed]!.chargeCapacity!;
    const empty = m.load.filter((l) => l.type === feed && l.charge === 0).reduce((k, l) => k + l.count, 0);
    if (empty === 0) continue;
    const p = p0(m.personId);
    const way = Math.hypot(p.x - drop.x, p.y - drop.y) / footSpeed(catalog, "run");
    takeS = Math.max(takeS, way + S.take.baseS + empty * cap * S.take.magSecondsPerRound);
  }
  const totalS = walkS + B.loadS + carryS + takeS;
  const req = at("supply.request", (e) => e.kind === "supply.request" && e.unit === sqId);
  const measuredS = full !== null && req !== null ? full / TICK_HZ - req : null;
  const end = ledgerOf(catalog, sim.state);
  const same = (a: Record<string, number>, b: Record<string, number>) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());
  return {
    faction, distanceM, bearers: men.map((m) => `${sim.state.identity.req(m).role}`),
    requestS: req, atPointS: at("action.started", (e) => e.kind === "action.started" && e.action === "loadSupply"), loadedS: at("supply.loaded", (e) => e.kind === "supply.loaded" && e.unit === sqId),
    deliveredS: at("supply.delivered", (e) => e.kind === "supply.delivered" && e.unit === sqId), fullS: full !== null ? full / TICK_HZ : null,
    crateKg, crateRounds, carryMps,
    hand: { walkS, loadS: B.loadS, carryS, takeS, totalS }, measuredS, errPct: measuredS !== null ? (100 * (measuredS - totalS)) / totalS : null,
    ledgerExact: same(start.ammo, end.ammo) && same(start.items, end.items),
  };
}

export function resupplyLab(data: DataSet, distances: readonly number[] = [400]): ResupplyRow[] {
  const catalog = buildCatalog(data, ["de", "ru"]);
  const rows: ResupplyRow[] = [];
  for (const d of distances) for (const [f, t] of [["de", "pzgren-zug"], ["ru", "motor-rifle-platoon"]] as const) rows.push(oneTrial(data, catalog, f, t, d));
  return rows;
}

const f1 = (x: number | null) => (x === null ? "-" : x.toFixed(0));

export function resupplyLabMarkdown(rows: ResupplyRow[]): string {
  const out = [
    "A platoon on open flat ground, its supply point the given distance behind; the first squad's riflemen have no loaded spare magazine, so it asks at once. Times in s after the start (the request comes at the squad's first look, within 2 s). Hand calculation: walk to the point (distance / walk speed with the bearer's load), loading (`bearers.loadS`), carry back (`crate` set-up + distance / carry speed with the crate's mass + a rest each `enduranceM`), the men's run to the crate and taking (`take.baseS` + 0.4 s a round). Target: measured within 10 % of the hand calculation.", "",
    "| platoon | distance (m) | bearers | request | at the point | loaded | delivered | squad full | crate kg / rounds | carry m/s | hand: walk + load + carry + take = total | measured (request to full) | difference | ledger |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
  ];
  for (const r of rows) {
    const h = r.hand;
    const miss = r.errPct === null || Math.abs(r.errPct) > 10;
    out.push(`| ${r.faction} | ${r.distanceM} | ${r.bearers.join(", ")} | ${f1(r.requestS)} | ${f1(r.atPointS)} | ${f1(r.loadedS)} | ${f1(r.deliveredS)} | ${f1(r.fullS)} | ${r.crateKg.toFixed(1)} / ${r.crateRounds} | ${r.carryMps.toFixed(2)} | ${h.walkS.toFixed(0)} + ${h.loadS.toFixed(0)} + ${h.carryS.toFixed(0)} + ${h.takeS.toFixed(0)} = ${h.totalS.toFixed(0)} | ${f1(r.measuredS)} | ${r.errPct === null ? "-" : `${r.errPct >= 0 ? "+" : ""}${r.errPct.toFixed(1)} %`}${miss ? " **miss**" : ""} | ${r.ledgerExact ? "exact" : "**changed**"} |`);
  }
  const met = rows.filter((r) => r.errPct !== null && Math.abs(r.errPct) <= 10 && r.ledgerExact).length;
  out.push("", `Met in ${met} of ${rows.length} trials.`);
  return out.join("\n");
}

// ---------------------------------------------------------------- M11.4b: by vehicle and from off the map

export interface VehicleResupplyRow {
  kind: "delivery" | "vehicle run"; faction: string; vehicle: string; distanceM: number;
  /** Delay drawn (delivery) or time away (run), the drive(s), unloading. */
  hand: { waitS: number; driveS: number; unloadS: number; totalS: number };
  measured: { driveS: number | null; totalS: number | null };
  kg: number; rounds: number; restocked: number; errPct: number | null; conservation: boolean;
}

/** A vehicle pace's speed for this hull type (m/s), as the drive model takes it (drive.ts `paceSpeed`). */
function vehicleSpeed(catalog: Catalog, type: string, mode: string): number {
  const def = catalog.vehicles[type]!, m = catalog.movementModes[mode];
  let frac = 1;
  if (m && m.class === "foot") { const p = catalog.movementModes[m.vehiclePace[def.class]]; frac = p && p.class !== "foot" ? p.speedFraction : 0.3; }
  else if (m) frac = m.speedFraction;
  return frac * def.drive.topSpeedMps;
}

function conserved(catalog: Catalog, start: ReturnType<typeof ledgerOf>, end: ReturnType<typeof ledgerOf>, ev: readonly SimEvent[]): boolean {
  const c = emptyConsumption();
  consumedFromEvents(c, ev, tracerMap(catalog));
  return Object.keys(checkConservation(start, end, c)).length === 0;
}

/**
 * An off-map delivery: a platoon on foot on open flat ground (2000 x 1200 m), its (empty) supply point `distanceM` from
 * the west edge; the side's stock at the rear; the player orders a delivery at once. Hand calculation: the delay drawn
 * (the call's `dueS`), the drive from where it comes on to `delivery.standM` short of the point at its pace, unloading
 * (`unloadBaseS` + `unloadSecondsPerKg` x kg). Measured: call to unloaded.
 */
function deliveryTrial(data: DataSet, catalog: Catalog, faction: string, template: string, distanceM: number): VehicleResupplyRow {
  const D = catalog.supply!.delivery!;
  const plt = withoutVehicles(buildForce(data, { faction, template, seed: 1, keyPrefix: "b" }));
  const px = distanceM, py = 600;
  const place = members(plt).map((m, i) => ({ personId: m.personId, x: px + 150 + (i % 6) * 5, y: 560 + Math.floor(i / 6) * 8, heading: 0 }));
  const packages = Object.values(catalog.items).filter((d) => d.category === "ammo-package" && d.id.startsWith(`${faction}-`) && (d.chargeCapacity ?? 0) <= 1200);
  const carts = new Set<string>();
  for (const m of members(plt)) for (const l of m.load) { const d = catalog.items[l.type]; if (d?.category === "magazine" && d.chargeItem !== undefined) carts.add(d.chargeItem); }
  const stock = [...carts].sort().map((c) => packages.filter((d) => d.chargeItem === c).sort((a, b) => (b.chargeCapacity ?? 0) - (a.chargeCapacity ?? 0))[0]).filter((d) => d !== undefined).map((d) => ({ type: d!.id, count: 4, charge: d!.chargeCapacity! }));
  const force: BattleInput["forces"][number] = { side: "blue", faction, units: [plt], placements: place, caches: [{ x: px, y: py, load: [], point: true }], stock: { load: stock } };
  addSupplyAssets(data, catalog, force, 1);
  const input: BattleInput = { map: flatMap("delivery-lab", 2000, 1200, 4), catalog, seed: 1, orders: [], rules: { ...defaultRules(3 * 3600) }, forces: [force] };
  const sim = createSim(input);
  const top = [...sim.state.unit.entries()].find(([, u]) => u.parent === null && u.asset === undefined)![0];
  const start = ledgerOf(catalog, sim.state);
  submitOrder(sim, { tick: 0, issuer: "blue", target: top, kind: "callDelivery", player: true });
  const ev: SimEvent[] = [];
  let called: Extract<SimEvent, { kind: "supply.delivery" }> | null = null, entered: number | null = null, arrived: number | null = null, unloaded: Extract<SimEvent, { kind: "supply.delivery" }> | null = null;
  let entry: { x: number; y: number } | null = null, vtype = "";
  for (let t = 0; t < 2 * 3600 * TICK_HZ && unloaded === null; t++) {
    for (const e of step(sim)) {
      ev.push(e);
      if (e.kind !== "supply.delivery") continue;
      if (e.phase === "called") { called = e; const v = sim.state.vehicle.req(e.vehicle); entry = v.offMap!.entry!; vtype = v.def; }
      if (e.phase === "entered") entered = e.tick;
      if (e.phase === "arrived") arrived = e.tick;
      if (e.phase === "unloaded") unloaded = e;
    }
  }
  const end = ledgerOf(catalog, sim.state);
  const speed = vtype ? vehicleSpeed(catalog, vtype, D.pace) : 1;
  const driveM = entry ? Math.max(0, Math.hypot(entry.x - px, entry.y - py) - D.standM) : 0;
  const kg = called?.kg ?? 0;
  const hand = { waitS: called?.dueS ?? 0, driveS: driveM / speed, unloadS: D.unloadBaseS + D.unloadSecondsPerKg * kg, totalS: 0 };
  hand.totalS = hand.waitS + hand.driveS + hand.unloadS;
  const totalS = unloaded && called ? (unloaded.tick - called.tick) / TICK_HZ : null;
  return {
    kind: "delivery", faction, vehicle: vtype, distanceM, hand, measured: { driveS: entered !== null && arrived !== null ? (arrived - entered) / TICK_HZ : null, totalS },
    kg, rounds: unloaded?.rounds ?? 0, restocked: 0, errPct: totalS !== null ? (100 * (totalS - hand.totalS)) / hand.totalS : null, conservation: conserved(catalog, start, end, ev),
  };
}

/**
 * A combat vehicle's supply run: the faction's carrier platoon with one vehicle on open flat ground (1200 x 900 m), its
 * supply point 150 m from the west edge, half its stowed rifle magazines gone; the player orders "Restock". Hand
 * calculation: the drive to the map edge (where it leaves), `rearRun.awayS` off the map, the drive back to the point
 * (`vehicleRun.standM` short) at the run's pace, unloading the share (`unloadBaseS` + `unloadSecondsPerKg` x kg).
 * Measured: the run's start to its share unloaded.
 */
function runTrial(data: DataSet, faction: string): VehicleResupplyRow {
  const input = vehicleBattle(data, { seed: 1, factions: faction === "de" ? ["de", "ru"] : ["ru", "de"], platoonsPerSide: 1, vehiclesPerPlatoon: 1, timeLimitSeconds: 3 * 3600 });
  const catalog = input.catalog, R = catalog.medical!.rearRun!, V = catalog.supply!.vehicleRun!;
  const blue = input.forces[0]!;
  const rec = blue.vehicles![0]!, def = catalog.vehicles[rec.type]!;
  // Half its stowed rifle magazines gone (the first magazine stowed).
  const mag = def.stowed.find((s) => catalog.items[s.item]?.category === "magazine");
  if (mag) rec.load = rec.load.map((l) => (l.type === mag.item ? { ...l, count: Math.ceil(l.count / 2) } : l));
  const packages = Object.values(catalog.items).filter((d) => d.category === "ammo-package" && d.id.startsWith(`${faction}-`) && (d.chargeCapacity ?? 0) <= 1200);
  const stock = [...def.stowed.filter((s) => s.charge !== undefined && catalog.items[s.item]?.chargeItem !== undefined).map((s) => ({ type: s.item, count: s.count, charge: s.charge! })), ...packages.map((d) => ({ type: d.id, count: 4, charge: d.chargeCapacity! }))];
  const px = 150, py = 450;
  blue.caches = [{ x: px, y: py, load: [], point: true }];
  blue.stock = { load: stock };
  for (const f of input.forces) f.vehiclePlacements = f.vehiclePlacements?.map((p) => ({ ...p }));
  const sim = createSim(input);
  for (const [uid] of sim.state.unit.entries()) sim.state.unit.req(uid).fireRule = "hold";
  const vid = [...sim.state.vehicle.entries()].find(([, v]) => v.side === "blue" && v.offMap === undefined)![0];
  const crew = sim.state.vehicle.req(vid).unit!;
  const start = ledgerOf(catalog, sim.state);
  const t0 = sim.state.transform.req(vid);
  const from = { x: t0.x, y: t0.y };
  submitOrder(sim, { tick: 0, issuer: "blue", target: crew, kind: "rearRun", cargo: "supplies", player: true });
  const ev: SimEvent[] = [];
  let started: number | null = null, unloaded: Extract<SimEvent, { kind: "medical.rearRun" }> | null = null, restocked = 0, exit: { x: number; y: number } | null = null, kg = 0;
  for (let t = 0; t < 2 * 3600 * TICK_HZ && unloaded === null; t++) {
    for (const e of step(sim)) {
      ev.push(e);
      if (e.kind !== "medical.rearRun" || e.vehicle !== vid) continue;
      if (e.phase === "started") { started = e.tick; exit = sim.state.vehicle.req(vid).rearRun?.exit ?? null; }
      if (e.phase === "restocked") { restocked = e.rounds ?? 0; const sh = sim.state.vehicle.req(vid).rearRun?.share ?? []; for (const s of sh) { const d = catalog.items[s.type]!; kg += s.count * (d.massKg + (s.charge ?? 0) * (d.chargeMassKg ?? 0)); } }
      if (e.phase === "unloaded") unloaded = e;
    }
    if (exit === null && started !== null) exit = sim.state.vehicle.req(vid).rearRun?.exit ?? null;
  }
  const end = ledgerOf(catalog, sim.state);
  const speed = vehicleSpeed(catalog, rec.type, R.pace);
  const outM = exit ? Math.hypot(exit.x - from.x, exit.y - from.y) : 0;
  const backM = exit ? Math.max(0, Math.hypot(exit.x - px, exit.y - py) - V.standM) : 0;
  const hand = { waitS: R.awayS, driveS: (outM + backM) / speed, unloadS: V.unloadBaseS + V.unloadSecondsPerKg * kg, totalS: 0 };
  hand.totalS = hand.waitS + hand.driveS + hand.unloadS;
  const totalS = unloaded && started !== null ? (unloaded.tick - started) / TICK_HZ : null;
  return {
    kind: "vehicle run", faction, vehicle: rec.type, distanceM: Math.round(outM), hand, measured: { driveS: totalS !== null ? totalS - hand.waitS - hand.unloadS : null, totalS },
    kg, rounds: unloaded?.rounds ?? 0, restocked, errPct: totalS !== null ? (100 * (totalS - hand.totalS)) / hand.totalS : null, conservation: conserved(catalog, start, end, ev),
  };
}

export function vehicleResupplyLab(data: DataSet, distances: readonly number[] = [400]): VehicleResupplyRow[] {
  const catalog = buildCatalog(data, ["de", "ru"]);
  const rows: VehicleResupplyRow[] = [];
  for (const d of distances) for (const [f, t] of [["de", "pzgren-zug"], ["ru", "motor-rifle-platoon"]] as const) rows.push(deliveryTrial(data, catalog, f, t, d));
  for (const f of ["de", "ru"]) rows.push(runTrial(data, f));
  return rows;
}

export function vehicleResupplyLabMarkdown(rows: VehicleResupplyRow[]): string {
  const out = [
    "M11.4b. **Delivery**: a platoon on foot, its empty supply point the given distance from the west edge, the side's stock at the rear; the player orders a delivery at tick 0. Hand: the delay drawn + the drive from where it comes on to `delivery.standM` short of the point at its pace + unloading (`unloadBaseS` + `unloadSecondsPerKg` x kg). **Vehicle run**: the carrier platoon with one vehicle, half its stowed rifle magazines gone, the supply point 150 m from the west edge; the player orders \"Restock\". Hand: the drive to the edge + `rearRun.awayS` + the drive back to the point + unloading its share. Target: measured within 10 % of the hand calculation; the conservation guard exact (`items.delivered` balances the stock).", "",
    "| kind | side | vehicle | distance (m) | hand: wait + drive + unload = total (s) | measured drive (s) | measured total (s) | difference | load kg / rounds to the point | rounds into its own stowage | conservation |",
    "|---|---|---|---|---|---|---|---|---|---|---|",
  ];
  for (const r of rows) {
    const h = r.hand, miss = r.errPct === null || Math.abs(r.errPct) > 10;
    out.push(`| ${r.kind} | ${r.faction} | ${r.vehicle} | ${r.distanceM} | ${h.waitS.toFixed(0)} + ${h.driveS.toFixed(0)} + ${h.unloadS.toFixed(0)} = ${h.totalS.toFixed(0)} | ${f1(r.measured.driveS)} | ${f1(r.measured.totalS)} | ${r.errPct === null ? "-" : `${r.errPct >= 0 ? "+" : ""}${r.errPct.toFixed(1)} %`}${miss ? " **miss**" : ""} | ${r.kg.toFixed(0)} / ${r.rounds} | ${r.restocked} | ${r.conservation ? "exact" : "**leak**"} |`);
  }
  const met = rows.filter((r) => r.errPct !== null && Math.abs(r.errPct) <= 10 && r.conservation).length;
  out.push("", `Met in ${met} of ${rows.length} trials.`);
  return out.join("\n");
}
