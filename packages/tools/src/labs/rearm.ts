/**
 * RE-ARMING AND REFUELLING LAB (M11.5, plan slice 48): how long do a Puma, a BMP-2, a Leopard 2A7V and a T-90M take to
 * re-arm from a full cache, and to refuel from fuel cans and from a supply truck, against a hand calculation?
 *
 * One hull of the type (its faction's vehicle battle, one vehicle per side, everyone on "hold fire", the enemy 1 km
 * off) stands halted on open flat ground with its stowed ammunition gone and its tank at 10 %. Beside it (8 m):
 *  - "cache": a cache with its full standard stowage of ammunition and the fuel cans that fill its tank;
 *  - "truck": the side's supply truck (on the map, halted), nothing else.
 * Measured: the crew's first `vehicle.resupply` "started" to its last "done". Hand calculation from the data:
 * `rearm.baseS` + per item `secondsPerKg` x its mass, then `refuel.setupS` + per can its litres / `jerrycanLpm`
 * (a minute's worth at a time / `pumpLpm` from the truck's tank above `keepL`), for the litres poured (the shortfall plus
 * what the engine burns idling meanwhile). Target: within 10 %. The ledger is
 * checked too: rounds and litres conserved exactly (no event: nothing enters or leaves the battle).
 */
import { buildCatalog, type DataSet } from "@tcs/data";
import { addSupplyAssets, crewTemplateOf, vehicleBattle } from "@tcs/scenario";
import {
  checkChargeConservation, checkConservation, consumedFromEvents, createSim, emptyConsumption, fuelKinds, ledgerOf, step, TICK_HZ, tracerMap,
  type BattleInput, type Catalog, type EntityId, type ItemTypeDef, type Sim, type SimEvent, type VehicleDef,
} from "@tcs/sim";

export interface RearmRow {
  vehicle: string; source: "cache" | "truck";
  items: number; rounds: number; kg: number; litres: number;
  hand: { rearmS: number; refuelS: number; totalS: number };
  measuredS: number | null; errPct: number | null; exact: boolean;
}

const TRIALS: { faction: "de" | "ru"; crew?: string }[] = [
  { faction: "de" }, { faction: "ru" }, { faction: "de", crew: "leopard2a7v-besatzung" }, { faction: "ru", crew: "t90m-ekipazh" },
];

function isAmmo(catalog: Catalog, item: string, charge: number | undefined): boolean {
  const d = catalog.items[item];
  return charge !== undefined ? d?.chargeItem !== undefined && catalog.ammo[d.chargeItem] !== undefined : catalog.ammo[item] !== undefined;
}

/** The lab's set-up (also for tests): the sim, the hull, its fuel short of full, the can type, the truck's litres. */
export interface RearmRig { sim: Sim; input: BattleInput; vid: EntityId; def: VehicleDef; short: number; can: ItemTypeDef; truckL: number }

export function rearmRig(data: DataSet, faction: "de" | "ru", crew: string | undefined, source: "cache" | "truck"): RearmRig {
  const other = faction === "de" ? "ru" : "de";
  const input: BattleInput = vehicleBattle(data, {
    seed: 1, factions: [faction, other], platoonsPerSide: 1, vehiclesPerPlatoon: 1, timeLimitSeconds: 3 * 3600, mapWidthM: 1400, mapHeightM: 600,
    ...(crew !== undefined ? { crewTemplates: [crew, crewTemplateOf(data, other)] as [string, string] } : {}),
  });
  const catalog = input.catalog;
  const blue = input.forces[0]!;
  const rec = blue.vehicles![0]!, def = catalog.vehicles[rec.type]!;
  const vp = blue.vehiclePlacements![0]!;
  // Its stowed ammunition gone, its tank at 10 %.
  const full = def.fuel.capacityL, startL = Math.floor(full * 0.1);
  rec.load = rec.load.filter((l) => !isAmmo(catalog, l.type, l.charge)).map((l) => (l.type === def.fuel.item ? { ...l, charge: startL } : l));
  const short = full - startL;
  const can = Object.values(catalog.items).find((d) => d.id.startsWith(`${faction}-`) && d.category === "fuel-can")!;
  if (source === "cache") {
    const load = [
      ...def.stowed.filter((s) => isAmmo(catalog, s.item, s.charge)).map((s) => (s.charge !== undefined ? { type: s.item, count: s.count, charge: s.charge } : { type: s.item, count: s.count })),
      { type: can.id, count: Math.ceil(short / can.chargeCapacity!), charge: can.chargeCapacity! },
    ];
    blue.caches = [{ x: vp.x, y: vp.y + 8, load }];
  } else {
    addSupplyAssets(data, catalog, blue, 1);
  }
  const sim = createSim(input);
  for (const [uid] of sim.state.unit.entries()) sim.state.unit.req(uid).fireRule = "hold";
  const vid = [...sim.state.vehicle.entries()].find(([, v]) => v.side === "blue" && v.offMap === undefined && v.def === rec.type)![0];
  let truckL = 0;
  if (source === "truck") {
    // The truck on the map, halted 8 m beside the hull (an ordinary vehicle from now on).
    const [tid, tv] = [...sim.state.vehicle.entries()].find(([, v]) => v.side === "blue" && v.offMap?.kind === "supply")!;
    delete tv.offMap;
    const t = sim.state.transform.req(tid);
    t.x = vp.x; t.y = vp.y + 8; t.z = 0; t.heading = 0;
    tv.drive.arrived = true; tv.drive.route = [];
    for (const sid of tv.seats) { if (sid === null) continue; const mt = sim.state.transform.get(sid); if (mt) { mt.x = t.x; mt.y = t.y; mt.z = 0; } }
    const tdef = catalog.vehicles[tv.def]!;
    for (const s of sim.state.container.req(tid).stacks) if (s.type === tdef.fuel.item) truckL += (s.charge ?? 0) * s.count;
  }
  return { sim, input, vid, def, short, can, truckL };
}

function trial(data: DataSet, faction: "de" | "ru", crew: string | undefined, source: "cache" | "truck"): RearmRow {
  const { sim, input, vid, def, short, can, truckL } = rearmRig(data, faction, crew, source);
  const catalog = input.catalog, S = catalog.supply!, R = S.rearm!, F = S.refuel!;
  const start = ledgerOf(catalog, sim.state);
  const used = emptyConsumption(), tracer = tracerMap(catalog);
  const ev: SimEvent[] = [];
  let first: number | null = null, last: number | null = null, items = 0, rounds = 0, litres = 0;
  for (let t = 0; t < 2 * 3600 * TICK_HZ; t++) {
    const out = step(sim);
    consumedFromEvents(used, out, tracer);
    for (const e of out) {
      ev.push(e);
      if (e.kind !== "vehicle.resupply" || e.vehicle !== vid) continue;
      if (e.phase === "started" && first === null) first = e.tick;
      if (e.phase === "done") { last = e.tick; items += e.items ?? 0; rounds += e.rounds ?? 0; litres += e.litres ?? 0; }
    }
    if (last !== null && sim.state.vehicle.req(vid).resupply === undefined) break;
    if (first === null && t > 300 * TICK_HZ) break;
  }
  const end = ledgerOf(catalog, sim.state);
  // ---- the hand calculation (whole steps per piece of work, as the sim counts them)
  // (Each piece ends at the first whole `rearm.stepS` at or after its time: whole seconds.)
  const stepS = R.stepS;
  const ticks = (s: number) => Math.max(1, Math.ceil(Math.max(1, Math.round(s * TICK_HZ)) / TICK_HZ / stepS - 1e-9)) * stepS;
  let rearmS = 0, kg = 0;
  if (source === "cache") {
    rearmS = R.baseS;
    for (const s of def.stowed) {
      if (!isAmmo(catalog, s.item, s.charge)) continue;
      const d = catalog.items[s.item]!;
      const one = d.massKg + (s.charge ?? 0) * (d.chargeMassKg ?? 0);
      rearmS += s.count * ticks(one * R.secondsPerKg); kg += s.count * one;
    }
  }
  let refuelS = F.setupS;
  if (source === "cache") {
    // (The litres poured: the tank's shortfall plus what the engine burns idling meanwhile, as the run counted them.)
    for (let left = litres; left > 0; left -= can.chargeCapacity!) refuelS += ticks((Math.min(can.chargeCapacity!, left) / F.jerrycanLpm) * 60);
  } else {
    for (let left = Math.min(short, Math.floor(truckL - F.keepL)); left > 0; left -= Math.floor(F.pumpLpm)) refuelS += ticks((Math.min(Math.floor(F.pumpLpm), left) / F.pumpLpm) * 60);
  }
  const totalS = rearmS + refuelS;
  const measuredS = first !== null && last !== null ? (last - first) / TICK_HZ : null;
  const exact = Object.keys(checkConservation(start, end, used)).length === 0 && Object.keys(checkChargeConservation(start, end, used, fuelKinds(catalog))).length === 0;
  return {
    vehicle: def.id, source, items, rounds, kg, litres, hand: { rearmS, refuelS, totalS }, measuredS,
    errPct: measuredS !== null ? (100 * (measuredS - totalS)) / totalS : null, exact,
  };
}

export function rearmLab(data: DataSet): RearmRow[] {
  buildCatalog(data, ["de", "ru"]);
  const rows: RearmRow[] = [];
  for (const t of TRIALS) for (const s of ["cache", "truck"] as const) rows.push(trial(data, t.faction, t.crew, s));
  return rows;
}

export function rearmLabMarkdown(rows: RearmRow[]): string {
  const f1 = (x: number | null) => (x === null ? "-" : x.toFixed(1));
  const out = [
    "M11.5. One hull halted on flat ground, its stowed ammunition gone and its tank at 10 %; beside it (8 m) a cache with its full standard stowage and the fuel cans to fill it (\"cache\"), or the side's supply truck (\"truck\": its own tank above `refuel.keepL` by pump). Measured: the first `vehicle.resupply` started to the last done. Hand: `rearm.baseS` + `secondsPerKg` x the mass of each item, then `refuel.setupS` + litres / `jerrycanLpm` per can (or / `pumpLpm`). Target: within 10 %; rounds and litres conserved exactly.", "",
    "| vehicle | source | items / rounds / kg into stowage | litres into the tank | hand: re-arm + refuel = total (s) | measured (s) | difference | conservation |",
    "|---|---|---|---|---|---|---|---|",
  ];
  for (const r of rows) {
    const miss = r.errPct === null || Math.abs(r.errPct) > 10;
    out.push(`| ${r.vehicle} | ${r.source} | ${r.items} / ${r.rounds} / ${r.kg.toFixed(0)} | ${r.litres} | ${r.hand.rearmS.toFixed(0)} + ${r.hand.refuelS.toFixed(0)} = ${r.hand.totalS.toFixed(0)} | ${f1(r.measuredS)} | ${r.errPct === null ? "-" : `${r.errPct >= 0 ? "+" : ""}${r.errPct.toFixed(1)} %`}${miss ? " **miss**" : ""} | ${r.exact ? "exact" : "**leak**"} |`);
  }
  const met = rows.filter((r) => r.errPct !== null && Math.abs(r.errPct) <= 10 && r.exact).length;
  out.push("", `Met in ${met} of ${rows.length} trials.`);
  return out.join("\n");
}
