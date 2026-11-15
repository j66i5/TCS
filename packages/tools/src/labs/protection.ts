/**
 * PROTECTION LAB (M10.7a, roadmap-detail slice 15): from how far does a man tell that an enemy is protected?
 *
 * Part 1, the data: the recognition range for each kind (an armband, a marked ambulance, a carrying party, a man at a
 * marked Verwundetennest) by eye and with optics, in daylight, at night (light 0) and through smoke that lets half
 * the light through, for a calm man (`recognitionRanges`, `smokeRecognitionFactor`).
 *
 * Part 2, the sim: one observer (blue, standing, fire rule "hold") and one enemy medic wearing the red cross armband
 * (red, standing still, "hold") on a flat strip; per case and range, `seeds` runs of `seconds`. Counted: runs in which
 * the observer saw him, and runs in which his contact carries the flag `marked` at the end. Acceptance: a man seen
 * within the predicted range is recognised; one seen beyond it is not.
 *
 * Part 3 (M10.7b, breaches): the same pair with the observer free to fire (AK, iron sights): runs in which he fired at
 * the medic and a "misidentified" breach was recorded, by light and range — more at night and in smoke. Part 4: the
 * chance of a deliberate breach per decision (once a minute at most) from the data, by losses, discipline and panic.
 */
import { buildCatalog, type DataSet } from "@tcs/data";
import {
  breachChance, createSim, DEFAULT_COMMS, environmentAt, flatMap, recognitionRanges, smokePhysics, smokeRecognitionFactor, smokeTransmission, step,
  type BattleInput, type Catalog, type MapDef, type SoldierRecord,
} from "@tcs/sim";

export type Light = "day" | "night" | "smoke";
export interface RangeRow { kind: string; light: Light; eye: number; optics: number }
export interface SimRow { light: Light; optics: boolean; rangeM: number; predictedM: number; runs: number; seen: number; recognised: number; transmission: number }

/** Part 2's cloud: its radius (m), a thin wisp across the line. */
const SMOKE_RADIUS_M = 2;

/** Smoke for the tables of part 1: half the light gets through. */
const SMOKE_T = 0.5;

/** Part 1: the recognition ranges the data gives, per kind and condition (a calm observer). */
export function rangeTable(catalog: Catalog): RangeRow[] {
  const out: RangeRow[] = [];
  const kinds: [string, (r: ReturnType<typeof recognitionRanges>) => number, boolean][] = [
    ["armband (medic)", (r) => r.marked, false], ["marked ambulance", (r) => r.marked, true], ["carrying party", (r) => r.carrying, false], ["at the Verwundetennest", (r) => r.point, false],
  ];
  for (const [kind, pick, veh] of kinds) {
    for (const light of ["day", "night", "smoke"] as const) {
      const lv = light === "night" ? 0 : 1, f = light === "smoke" ? smokeRecognitionFactor(catalog, SMOKE_T) : 1;
      out.push({ kind, light, eye: Math.round(pick(recognitionRanges(catalog, lv, false, 0, veh)) * f), optics: Math.round(pick(recognitionRanges(catalog, lv, true, 0, veh)) * f) });
    }
  }
  return out;
}

function man(personId: string, weapon: string, mag: string, catalog: Catalog): SoldierRecord {
  return { personId, given: "Lab", family: personId, rank: "r", role: "rifleman", skills: { marksmanship: 0.5 }, weapon, fatigue: 0, stress: 0, wounds: [], status: "fit", load: [{ type: mag, count: 4, charge: catalog.items[mag]?.chargeCapacity ?? 30 }] };
}

/** Part 2: one case (light, eye or optics, range) over `seeds` runs of `seconds`. */
export function simCase(catalog: Catalog, light: Light, optics: boolean, rangeM: number, seeds: number, seconds: number, free = false): SimRow & { breached: number } {
  let seen = 0, recognised = 0, transmission = 1, predictedM = 0, breached = 0;
  for (let seed = 1; seed <= seeds; seed++) {
    const map: MapDef = flatMap("protection", Math.max(200, rangeM + 80), 200, 4);
    const ox = 20, y = 100, tx = 20 + rangeM;
    const obs = optics ? man("obs", "de-g36", "de-g36-mag", catalog) : man("obs", "ru-ak74m", "ru-ak74-mag", catalog);
    const med = man("med", "de-g36", "de-g36-mag", catalog);
    med.load.push({ type: "de-armband", count: 1 });
    const input: BattleInput = {
      map, catalog, seed, orders: [],
      // Night: 01:00 without a moon.
      ...(light === "night" ? { environment: environmentAt(catalog, 3600, 0) } : {}),
      rules: { timeLimitSeconds: seconds + 10, commsModel: "simple", comms: { ...DEFAULT_COMMS, orderDelaySeconds: 0, orderDelayJitterSeconds: 0 }, physiologyModel: "none", physiologyParams: {}, objectives: [] },
      forces: [
        { side: "blue", faction: "de", units: [{ key: "o", callsign: "O", echelon: "team", leaderIndex: 0, subunits: [], members: [obs] }], placements: [{ personId: "obs", x: ox, y, heading: 0 }] },
        { side: "red", faction: "de", units: [{ key: "m", callsign: "M", echelon: "team", leaderIndex: 0, subunits: [], members: [med] }], placements: [{ personId: "med", x: tx, y, heading: Math.PI }] },
      ],
    };
    const sim = createSim(input);
    for (const u of sim.state.unit.values()) u.fireRule = "hold";
    if (free) sim.state.unit.req(sim.state.identity.req([...sim.state.identity.entries()].find(([, i]) => i.side === "blue")![0]).unit).fireRule = "free";
    const ids = [...sim.state.identity.entries()];
    const oid = ids.find(([, i]) => i.side === "blue")![0], mid = ids.find(([, i]) => i.side === "red")![0];
    for (const [id] of ids) sim.state.soldier.req(id).posture = "standing";
    // Smoke: a thin cloud halfway, standing for the whole case (about half the light through).
    if (light === "smoke") sim.state.smoke.push({ x: (ox + tx) / 2, y, radiusM: SMOKE_RADIUS_M, startTick: -1200, untilTick: (seconds + 60) * 60, gz: 0, topM: 6, burnS: 0 });
    let wasSeen = false, wasBreached = false;
    for (let k = 0; k < seconds * 60; k++) for (const e of step(sim)) {
      if (e.kind === "spotted" && e.observer === oid && e.target === mid) wasSeen = true;
      if (e.kind === "law.breach" && e.by === oid && e.cause === "misidentified") wasBreached = true;
    }
    if (wasBreached) breached++;
    const c = sim.state.soldier.req(oid).contacts.find((q) => q.target === mid);
    if (wasSeen) seen++;
    if (c?.marked === true) recognised++;
    if (seed === 1) {
      const lv = Math.min(1, Math.max(0, sim.state.environment.light));
      if (light === "smoke") transmission = smokeTransmission(sim.state, smokePhysics(catalog), ox, y, 1.6, tx, y, 1);
      predictedM = recognitionRanges(catalog, lv, optics, 0, false).marked * (light === "smoke" ? smokeRecognitionFactor(catalog, transmission) : 1);
    }
  }
  return { light, optics, rangeM, predictedM, runs: seeds, seen, recognised, transmission, breached };
}

/** Part 3 (M10.7b): misidentification — the observer free to fire, by eye. */
export const BREACH_RANGES = [15, 30, 40, 60];
export interface BreachRow { light: Light; rangeM: number; predictedM: number; runs: number; seen: number; breached: number }
export function breachLab(data: DataSet, seeds = 3, seconds = 60): BreachRow[] {
  const cat = buildCatalog(data, ["de", "ru"]);
  const out: BreachRow[] = [];
  for (const light of ["day", "night", "smoke"] as const) for (const r of BREACH_RANGES) {
    const c = simCase(cat, light, false, r, seeds, seconds, true);
    out.push({ light, rangeM: r, predictedM: c.predictedM, runs: c.runs, seen: c.seen, breached: c.breached });
  }
  return out;
}

/** Part 4 (M10.7b): the chance of a deliberate breach at one decision, from the data. */
export interface ChanceRow { losses: number; experience: number; stress: number; chance: number }
export function chanceTable(catalog: Catalog): ChanceRow[] {
  const ctx = { catalog } as Parameters<typeof breachChance>[0];
  const out: ChanceRow[] = [];
  for (const losses of [0, 0.1, 0.25]) for (const experience of [1, 0.5, 0]) for (const stress of [0, 0.5, 1]) out.push({ losses, experience, stress, chance: breachChance(ctx, losses, experience, stress) });
  return out;
}

export function breachLabMarkdown(rows: BreachRow[], chance: ChanceRow[]): string {
  const out = ["## Misidentification (M10.7b): the observer free to fire, by eye (AK iron sights)", "",
    `Runs of 60 s per row (${rows[0]?.runs ?? 0}); "breach": he fired at the medic without having recognised him.`, "",
    "| light | range m | recognised to m | seen | misidentified breach |", "|---|---:|---:|---:|---:|"];
  for (const r of rows) out.push(`| ${r.light} | ${r.rangeM} | ${Math.round(r.predictedM)} | ${r.seen}/${r.runs} | ${r.breached}/${r.runs} |`);
  out.push("", "## Deliberate breach: chance per decision (at most once a minute per man; data `protection`)", "",
    "| platoon losses | experience | stress | chance |", "|---:|---:|---:|---:|");
  for (const c of chance) out.push(`| ${Math.round(c.losses * 100)} % | ${c.experience} | ${c.stress} | ${(c.chance * 100).toFixed(1)} % |`);
  return out.join("\n");
}

export const SIM_RANGES: Record<Light, number[]> = { day: [30, 45, 55, 100, 140, 160, 250], night: [10, 14, 20, 40, 50], smoke: [20, 30, 40, 80, 95, 115] };

export function protectionLab(data: DataSet, seeds = 3, seconds = 60): { ranges: RangeRow[]; sim: SimRow[] } {
  const cat = buildCatalog(data, ["de", "ru"]);
  const sim: SimRow[] = [];
  for (const light of ["day", "night", "smoke"] as const) for (const optics of [false, true]) for (const r of SIM_RANGES[light]) sim.push(simCase(cat, light, optics, r, seeds, seconds));
  return { ranges: rangeTable(cat), sim };
}

export function protectionLabMarkdown(lab: { ranges: RangeRow[]; sim: SimRow[] }): string {
  const out = ["## Recognition ranges in the data (m, a calm observer)", "", `Night: light 0; smoke: ${Math.round(SMOKE_T * 100)} % of the light through.`, "",
    "| protected | light | by eye | with optics |", "|---|---|---:|---:|"];
  for (const r of lab.ranges) out.push(`| ${r.kind} | ${r.light} | ${r.eye} | ${r.optics} |`);
  out.push("", "## In the sim: an enemy medic with the red cross armband, standing still", "",
    `Observer blue (G36 3x optic, or an AK with iron sights for "eye"), both sides on fire rule "hold"; ${lab.sim[0]?.runs ?? 0} runs of 60 s per row. Predicted: the range in the data at that light (and smoke on the line).`, "",
    "| light | sight | range m | predicted m | seen | recognised | as predicted |", "|---|---|---:|---:|---:|---:|---|");
  for (const r of lab.sim) {
    const ok = r.seen === 0 ? "not seen" : (r.rangeM <= r.predictedM ? r.recognised === r.seen : r.recognised === 0) ? "yes" : "NO";
    out.push(`| ${r.light}${r.light === "smoke" ? ` (${Math.round(r.transmission * 100)} % through)` : ""} | ${r.optics ? "optics" : "eye"} | ${r.rangeM} | ${Math.round(r.predictedM)} | ${r.seen}/${r.runs} | ${r.recognised}/${r.runs} | ${ok} |`);
  }
  return out.join("\n");
}
