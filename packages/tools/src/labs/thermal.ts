/**
 * THERMAL LAB (M9.2, roadmap-detail slice 31): sensor physics. The spotting lab's observer (G36 with its optic) with
 * and without a thermal weapon sight, by day and on a moonless night: a man standing still in the open, lying in
 * crops (heat comes through vegetation better), under a thermal blanket, and off the sight's arc; then hulls seen
 * through a thermal sight, just driven (hot) against halted for a while (cooled), from a man on foot at night.
 */
import { buildCatalog, type DataSet } from "@tcs/data";
import { buildForce } from "@tcs/scenario";
import {
  createSim, DEFAULT_COMMS, environmentAt, flatMap, newVehicleRecord, step, submitOrder, type BattleInput, type Catalog, type SoldierRecord,
} from "@tcs/sim";
import { spotCase, type SpotCase, type SpotRow } from "./spotting";

export interface ThermalRow extends SpotRow { time: string; sensor: string }
export interface HullRow { time: string; hull: string; rangeM: number; runs: number; spotted: number; medianS: number | null; within30: number }

const NOON = 12 * 3600, NIGHT = 0;
const CASES: (Omit<SpotCase, "name"> & { name: string })[] = [
  { name: "standing, still, open", rangeM: 300, posture: "standing", action: "still" },
  { name: "standing, still, open", rangeM: 600, posture: "standing", action: "still" },
  { name: "prone, still, in crops", rangeM: 100, posture: "prone", action: "still", cover: "crops" },
  { name: "prone, still, open, under a thermal blanket", rangeM: 300, posture: "prone", action: "still", blanket: true },
  { name: "prone, still, open, no blanket", rangeM: 300, posture: "prone", action: "still" },
  { name: "standing, still, open, 40 degrees off where he looks", rangeM: 300, posture: "standing", action: "still", offAxisDeg: 40 },
];

function hullCase(data: DataSet, cat: Catalog, hot: boolean, time: number, rangeM: number, seeds: number): HullRow {
  const times: number[] = [];
  const max = 120;
  for (let seed = 1; seed <= seeds; seed++) {
    const obs: SoldierRecord = { personId: "obs", given: "Lab", family: "obs", rank: "r", role: "rifleman", skills: { marksmanship: 0.5 }, weapon: "de-g36", fatigue: 0, stress: 0, wounds: [], status: "fit", load: [{ type: "de-g36-mag", count: 4, charge: 30 }, { type: "de-thermal-sight", count: 1 }] };
    const crew = buildForce(data, { faction: "ru", template: "bmp2-ekipazh", seed, keyPrefix: "c" });
    crew.vehicleId = "v1";
    const input: BattleInput = {
      map: flatMap("hull", rangeM + 200, 200, 4), catalog: cat, seed: 9000 + seed, orders: [],
      environment: environmentAt(cat, time, 0),
      rules: { timeLimitSeconds: max + 10, commsModel: "simple", comms: { ...DEFAULT_COMMS }, physiologyModel: "none", physiologyParams: {}, objectives: [] },
      forces: [
        { side: "blue", faction: "de", units: [{ key: "o", callsign: "O", echelon: "team", leaderIndex: 0, subunits: [], members: [obs] }], placements: [{ personId: "obs", x: 20, y: 100, heading: 0 }] },
        { side: "red", faction: "ru", units: [crew], placements: [], vehicles: [newVehicleRecord(cat, "ru-bmp2", "v1")], vehiclePlacements: [{ vehicleId: "v1", x: 20 + rangeM, y: 100, heading: Math.PI / 2 }] },
      ],
    };
    const sim = createSim(input);
    const vid = [...sim.state.vehicle.keys()][0]!;
    // (A hull just driven is hot; one that has stood longer than thermal.hotSeconds has cooled. The crew holds fire.)
    if (hot) sim.state.vehicle.req(vid).movedTick = 0;
    const cu = sim.state.vehicle.req(vid).unit;
    if (cu !== null) submitOrder(sim, { tick: 0, issuer: "red", target: cu, kind: "rules", fire: "hold" });
    let at: number | null = null;
    for (let k = 0; k < max * 60 && at === null; k++) for (const e of step(sim)) if (e.kind === "spotted" && e.target === vid) at = e.tick / 60;
    if (at !== null) times.push(at);
  }
  times.sort((a, b) => a - b);
  return { time: time === NOON ? "noon" : "night, no moon", hull: hot ? "BMP-2, halted, just driven (hot)" : "BMP-2, halted over 10 minutes (cooled)", rangeM, runs: seeds, spotted: times.length, medianS: times.length * 2 > seeds ? times[Math.floor(seeds / 2)]! : null, within30: times.filter((t) => t <= 30).length };
}

export function thermalLab(data: DataSet, seeds = 30): { rows: ThermalRow[]; hulls: HullRow[] } {
  const cat = buildCatalog(data, ["de", "ru"]);
  const rows: ThermalRow[] = [];
  let base = 7000;
  for (const [time, label] of [[NOON, "noon"], [NIGHT, "night, no moon"]] as const) {
    for (const thermal of [false, true]) {
      for (const c of CASES) {
        if ((c.blanket || c.name.includes("no blanket")) && !thermal) continue;
        const r = spotCase(cat, { ...c, timeOfDay: time, moon: 0, thermal, seeds, seedBase: base });
        base += 100;
        rows.push({ ...r, time: label, sensor: thermal ? "optic + thermal sight" : "optic" });
      }
    }
  }
  const hulls: HullRow[] = [];
  for (const hot of [true, false]) hulls.push(hullCase(data, cat, hot, NIGHT, 1000, Math.max(10, Math.floor(seeds / 2))));
  return { rows, hulls };
}

export function thermalLabMarkdown(r: ReturnType<typeof thermalLab>): string {
  const pct = (a: number, b: number) => `${Math.round((100 * a) / b)} %`;
  const med = (m: number | null) => (m === null ? "–" : m >= 120 ? "over 120" : m.toFixed(1));
  const out = ["Time to spot one enemy (observer standing; each row up to 120 s):", "",
    "| time | observer | target | range m | spotted in 120 s | median s | within 30 s |", "|---|---|---|---:|---:|---:|---:|"];
  for (const x of r.rows) out.push(`| ${x.time} | ${x.sensor} | ${x.name} | ${x.rangeM} | ${pct(x.spotted, x.runs)} | ${med(x.medianS)} | ${pct(x.within30, x.runs)} |`);
  out.push("", "Hulls through a thermal weapon sight, from a man on foot:", "", "| time | hull | range m | spotted in 120 s | median s | within 30 s |", "|---|---|---:|---:|---:|---:|");
  for (const h of r.hulls) out.push(`| ${h.time} | ${h.hull} | ${h.rangeM} | ${pct(h.spotted, h.runs)} | ${med(h.medianS)} | ${pct(h.within30, h.runs)} |`);
  return out.join("\n");
}
