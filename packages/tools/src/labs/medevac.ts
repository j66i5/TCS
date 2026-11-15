/**
 * MEDEVAC LAB (M10.6a, roadmap-detail slice 13): does an ambulance called from the rear arrive when it should, and
 * does it never take more men than it has places for?
 *
 * Per faction and seed: the faction's platoon on a generated map (village, or farmland for odd seeds), on its own (no
 * enemy), with `casualties` men of its first squad down with a broken leg and the faction's ambulances off the map.
 * Bearers carry the men to the platoon's Verwundetennest, the platoon calls an ambulance, it comes onto the map after
 * the delay, drives to the nest, loads and leaves. Measured: the delay drawn (the call's `dueS`), the time from the
 * call to coming onto the map, the drive from the edge to the nest, the call to the arrival; and, alone on the same
 * map, the same hull driven the same way from the same entry point to the same spot (the drive time to expect).
 * Acceptance: the call to the arrival within the delay plus that drive time, +-10 %. Also: men aboard at most what its
 * layouts allow (lying and sitting), and its places after it left.
 */
import { buildCatalog, type DataSet } from "@tcs/data";
import { buildForce, freeSpot, generateMap, withoutVehicles } from "@tcs/scenario";
import {
  createSim, DEFAULT_COMMS, hypot2, newVehicleRecord, placesFit, placesUsed, step, submitOrder,
  type BattleInput, type Catalog, type EntityId, type SimEvent, type UnitInput, type Wound,
} from "@tcs/sim";

export interface MedevacRow {
  faction: string; seed: number; map: string; dueS: number; toEdgeS: number; driveS: number; refDriveS: number;
  callToArriveS: number; expectedS: number; errPct: number; driveErrPct: number; loaded: number; lying: number; sitting: number; fits: boolean; away: boolean;
}

const brokenLeg = (): Wound => ({
  id: 1, zone: "legL", mechanism: "bullet", severity: 0.3, bleedingLps: 0, compressible: false, airway: false, breathing: false,
  consciousness: false, tickInflicted: 0, treatments: [], fracture: true,
});

const rules = (seconds: number): BattleInput["rules"] => ({
  timeLimitSeconds: seconds, commsModel: "simple", comms: { ...DEFAULT_COMMS }, physiologyModel: "medical", physiologyParams: {}, objectives: [],
});

/** One run: the platoon, its casualties, the ambulances off the map; returns the row (null: no ambulance came). */
function run(data: DataSet, catalog: Catalog, faction: string, seed: number, casualties: number): MedevacRow | null {
  const pack = data.factions[faction]!;
  const amb = pack.manifest.ambulance!;
  const kind = seed % 2 === 0 ? "village" : "farmland";
  const W = 1200, H = 900;
  const map = generateMap(catalog.terrain, { kind, seed, widthM: W, heightM: H });
  const plat = withoutVehicles(buildForce(data, { faction, template: pack.manifest.platoonTemplate!, seed: seed * 7, keyPrefix: "p", number: 1 }));
  const squad = plat.subunits[0]!;
  for (let i = 0; i < casualties; i++) { const m = squad.members[squad.members.length - 1 - i]!; m.wounds = [brokenLeg()]; m.status = "wounded"; }
  const crews: UnitInput[] = Array.from({ length: amb.count }, (_, k) => { const u = buildForce(data, { faction, template: amb.template, seed: seed * 11 + k, keyPrefix: `amb${k + 1}`, number: k + 1 }); u.vehicleId = u.key; return u; });
  const vtype = pack.units[amb.template]!.vehicle!;
  const placements: BattleInput["forces"][number]["placements"] = [];
  const all = (u: UnitInput): UnitInput["members"] => [...u.members, ...u.subunits.flatMap(all)];
  all(plat).forEach((m, i) => { const p = freeSpot(map, catalog, W / 2 + (i % 6) * 4, H / 2 + Math.floor(i / 6) * 4); placements.push({ personId: m.personId, x: p.x, y: p.y, heading: 0 }); });
  const input: BattleInput = {
    map, catalog, seed, orders: [], rules: rules(3600),
    forces: [{ side: "blue", faction, units: [plat, ...crews], placements, vehicles: crews.map((c) => newVehicleRecord(catalog, vtype, c.key)), offMap: crews.map((c) => ({ vehicleId: c.key, kind: "ambulance" as const })) }],
  };
  const sim = createSim(input);
  const st = sim.state;
  const ev: SimEvent[] = [];
  let vid: EntityId | null = null, entry: { x: number; y: number; heading: number } | null = null, goal: { x: number; y: number } | null = null, nest: { x: number; y: number } | null = null;
  let maxLying = 0, maxSitting = 0;
  const def = catalog.vehicles[vtype]!;
  for (let t = 0; t < 3600 * 60; t++) {
    const e = step(sim);
    ev.push(...e.filter((x) => x.kind === "medical.ambulance"));
    for (const x of e) if (x.kind === "medical.ambulance" && x.phase === "called" && vid === null) vid = x.vehicle;
    if (vid !== null) {
      const v = st.vehicle.req(vid), o = v.offMap!;
      if (o.phase === "inbound" && o.goal && goal === null) { entry = o.entry!; goal = { x: o.goal.x, y: o.goal.y }; nest = { x: o.goal.px, y: o.goal.py }; }
      const u = placesUsed(st, v, def);
      maxLying = Math.max(maxLying, u.lying); maxSitting = Math.max(maxSitting, u.sitting);
      if (o.phase === "away" || o.phase === "lost") break;
    }
  }
  const mine = ev.filter((x): x is Extract<SimEvent, { kind: "medical.ambulance" }> => x.kind === "medical.ambulance" && x.vehicle === vid);
  const at = (p: string) => mine.find((x) => x.phase === p);
  const called = at("called"), entered = at("entered"), arrived = at("arrived");
  if (!called || !entered || !arrived || !entry || !goal || !nest) return null;
  const refDriveS = referenceDrive(data, catalog, faction, amb.template, vtype, map, entry, goal, nest);
  const dueS = called.dueS ?? 0, driveS = (arrived.tick - entered.tick) / 60, callToArriveS = (arrived.tick - called.tick) / 60;
  const expectedS = dueS + refDriveS;
  return {
    faction, seed, map: kind, dueS, toEdgeS: (entered.tick - called.tick) / 60, driveS, refDriveS, callToArriveS, expectedS,
    errPct: Number.isFinite(expectedS) ? (100 * (callToArriveS - expectedS)) / expectedS : NaN, driveErrPct: refDriveS > 0 ? (100 * (driveS - refDriveS)) / refDriveS : NaN,
    loaded: mine.filter((x) => x.phase === "loaded").length, lying: maxLying, sitting: maxSitting, fits: placesFit(sim.ctx, def, maxLying, maxSitting),
    away: mine.some((x) => x.phase === "away"),
  };
}

/** The same hull alone on the same map, from the entry point to the stand spot, the way the run drives it. */
function referenceDrive(data: DataSet, catalog: Catalog, faction: string, template: string, vtype: string, map: BattleInput["map"], entry: { x: number; y: number; heading: number }, goal: { x: number; y: number }, nest: { x: number; y: number }): number {
  const E = catalog.medical!.evacuation!;
  const crew = buildForce(data, { faction, template, seed: 1, keyPrefix: "ref", number: 1 });
  crew.vehicleId = crew.key;
  const input: BattleInput = {
    map, catalog, seed: 1, orders: [], rules: { ...rules(3600), comms: { ...DEFAULT_COMMS, orderDelaySeconds: 0, orderDelayJitterSeconds: 0 } },
    forces: [{ side: "blue", faction, units: [crew], placements: [], vehicles: [newVehicleRecord(catalog, vtype, crew.key)], vehiclePlacements: [{ vehicleId: crew.key, x: entry.x, y: entry.y, heading: entry.heading }] }],
  };
  const sim = createSim(input);
  const st = sim.state;
  const uid = [...st.unit.keys()][0]!, vid = [...st.vehicle.keys()][0]!;
  // As the run: at `pace`, the last 30 m at `nearPace`.
  const L = hypot2(goal.x - entry.x, goal.y - entry.y), k = L > 60 ? (L - 30) / L : 0;
  const wps = k > 0 ? [{ x: entry.x + (goal.x - entry.x) * k, y: entry.y + (goal.y - entry.y) * k, mode: E.pace }, { x: goal.x, y: goal.y, mode: E.nearPace }] : [{ x: goal.x, y: goal.y, mode: E.nearPace }];
  submitOrder(sim, { tick: 0, issuer: "blue", target: uid, kind: "move", waypoints: wps });
  // (The order reaches the crew: from then on, checked once a second as the run is.)
  let start = -1;
  for (let t = 0; t < 1800 * 60; t++) {
    step(sim);
    const v = st.vehicle.req(vid), tt = st.transform.req(vid);
    if (start < 0 && !v.drive.arrived) start = st.tick;
    if (start >= 0 && st.tick % 60 === 0 && (hypot2(tt.x - nest.x, tt.y - nest.y) <= E.standM + 10 || hypot2(tt.x - goal.x, tt.y - goal.y) <= 6)) return (st.tick - start) / 60;
  }
  return NaN;
}

export function medevacLab(data: DataSet, seeds = 10, casualties = 2): MedevacRow[] {
  const out: MedevacRow[] = [];
  for (const faction of ["de", "ru"]) {
    const catalog = buildCatalog(data, [faction]);
    for (let seed = 1; seed <= seeds; seed++) { const r = run(data, catalog, faction, seed, casualties); if (r) out.push(r); }
  }
  return out;
}

export function medevacLabMarkdown(rows: readonly MedevacRow[], seeds: number): string {
  const f1 = (x: number) => (Number.isFinite(x) ? x.toFixed(0) : "-");
  const lines = [
    `Per faction, ${seeds} seeds (village for even seeds, farmland for odd), the faction's platoon alone with two men down with a broken leg; its ambulances off the map. The delay is drawn per call (10-15 min, owner Q-6); "alone" is the same hull driven the same way from the same entry point with nothing else on the map. Acceptance: call to arrival within delay + drive alone, +-10 %; places never exceeded.`,
    "",
    "| faction | seed | map | delay s | call to edge s | drive s | drive alone s | drive error | call to arrival s | expected s | error | aboard (lying/sitting) | fits | left the map |",
    "|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---|---|---|",
    ...rows.map((r) => `| ${r.faction} | ${r.seed} | ${r.map} | ${f1(r.dueS)} | ${f1(r.toEdgeS)} | ${f1(r.driveS)} | ${f1(r.refDriveS)} | ${Number.isFinite(r.driveErrPct) ? `${r.driveErrPct.toFixed(1)} %` : "-"} | ${f1(r.callToArriveS)} | ${f1(r.expectedS)} | ${Number.isFinite(r.errPct) ? `${r.errPct.toFixed(1)} %` : "-"} | ${r.loaded} (${r.lying}/${r.sitting}) | ${r.fits ? "yes" : "NO"} | ${r.away ? "yes" : "no"} |`),
    "",
    `Within +-10 %: ${rows.filter((r) => Math.abs(r.errPct) <= 10).length} of ${rows.length}; drive alone within +-10 %: ${rows.filter((r) => Math.abs(r.driveErrPct) <= 10).length} of ${rows.length}; held up on the way (it stopped where the ground held it up near the nest; the hull alone did not get there either): ${rows.filter((r) => !Number.isFinite(r.refDriveS)).length}; places exceeded: ${rows.filter((r) => !r.fits).length}; runs where no ambulance reached the nest within an hour (no casualty there, or none called): ${2 * seeds - rows.length}.`,
  ];
  return lines.join("\n");
}
