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
import { buildForce, withoutVehicles } from "@tcs/scenario";
import {
  createSim, DEFAULT_COMMS, flatMap, ledgerOf, loadKg, step, TICK_HZ,
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
