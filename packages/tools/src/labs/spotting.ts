/**
 * SPOTTING LAB (SPEC 5.4, 6.5, M3.2): how long a regular soldier takes to spot one enemy, by situation.
 * One observer (German, G36 with its 3x optic, or an iron-sighted comparison), one target (Russian) on a flat
 * strip; each case is run over many seeds and stops at the first "spotted" event. Owner anchors (2026-11-11):
 * a man standing still in the open at 300 m in about 5-15 s; a man lying still in crops at 100 m very hard
 * to spot until he moves or fires.
 */
import { buildCatalog, type DataSet } from "@tcs/data";
import {
  createSim, DEFAULT_COMMS, flatMap, step, submitOrder, type BattleInput, type Catalog, type MapDef, type Posture, type SoldierRecord,
} from "@tcs/sim";

export interface SpotCase {
  name: string;
  rangeM: number;
  posture: Posture;
  /** What the target does: stay still, walk or crawl across the line of view, or fire toward the observer. */
  action: "still" | "walk" | "crawl" | "fire";
  /** Vegetation all along the target's end of the strip (from 40 m in front of the observer). */
  cover?: "crops" | "tall-grass";
  /** Observer looks away from the target (back turned). */
  away?: boolean;
  /** Observer without an optic. */
  ironSights?: boolean;
  seeds?: number;
  maxSeconds?: number;
}
export interface SpotRow extends SpotCase { runs: number; spotted: number; medianS: number | null; within10: number; within30: number }

function man(personId: string, weapon: string, mag: string, catalog: Catalog): SoldierRecord {
  return { personId, given: "Lab", family: personId, rank: "r", role: "rifleman", skills: { marksmanship: 0.5 }, weapon, fatigue: 0, stress: 0, wounds: [], status: "fit", load: [{ type: mag, count: 4, charge: catalog.items[mag]?.chargeCapacity ?? 30 }] };
}

export function spotCase(catalog: Catalog, c: SpotCase): SpotRow {
  const times: number[] = [];
  const seeds = c.seeds ?? 40, max = c.maxSeconds ?? 120;
  for (let seed = 1; seed <= seeds; seed++) {
    const map: MapDef = flatMap("spot", Math.max(200, c.rangeM + 80), 200, 4);
    if (c.cover) {
      map.vegetationPalette.push(c.cover);
      for (let r = 0; r < map.rows; r++) for (let col = Math.floor(60 / map.cellSizeM); col < map.cols; col++) map.vegetation[r * map.cols + col] = 1;
    }
    const ox = 20, ty = 100, tx = 20 + c.rangeM;
    const obs = man("obs", c.ironSights ? "ru-ak74m" : "de-g36", c.ironSights ? "ru-ak74-mag" : "de-g36-mag", catalog);
    const tgt = man("tgt", "ru-ak74m", "ru-ak74-mag", catalog);
    const input: BattleInput = {
      map, catalog, seed, orders: [],
      rules: { timeLimitSeconds: max + 10, commsModel: "simple", comms: { ...DEFAULT_COMMS, orderDelaySeconds: 0, orderDelayJitterSeconds: 0 }, physiologyModel: "none", physiologyParams: {}, objectives: [] },
      forces: [
        { side: "blue", faction: "de", units: [{ key: "o", callsign: "O", echelon: "team", leaderIndex: 0, subunits: [], members: [obs] }], placements: [{ personId: "obs", x: ox, y: ty, heading: c.away ? Math.PI : 0 }] },
        { side: "red", faction: "ru", units: [{ key: "t", callsign: "T", echelon: "team", leaderIndex: 0, subunits: [], members: [tgt] }], placements: [{ personId: "tgt", x: tx, y: ty, heading: Math.PI }] },
      ],
    };
    const sim = createSim(input);
    const ids = [...sim.state.identity.entries()];
    const tid = ids.find(([, i]) => i.side === "red")![0];
    for (const [id] of ids) sim.state.soldier.req(id).posture = id === tid ? c.posture : "standing";
    if (c.action === "walk" || c.action === "crawl") submitOrder(sim, { tick: 0, issuer: "red", target: tid, kind: "move", waypoints: [{ x: tx, y: 190, mode: c.action === "walk" ? "walk" : "crawl" }] });
    if (c.action === "fire") submitOrder(sim, { tick: 0, issuer: "red", target: tid, kind: "fire", x: ox, y: ty + 30, heightM: 1 });
    let at: number | null = null;
    for (let k = 0; k < max * 60 && at === null; k++) for (const e of step(sim)) if (e.kind === "spotted" && e.target === tid) at = e.tick / 60;
    if (at !== null) times.push(at);
  }
  times.sort((a, b) => a - b);
  const median = times.length * 2 > seeds ? times[Math.floor(seeds / 2)]! : null;
  return { ...c, runs: seeds, spotted: times.length, medianS: median, within10: times.filter((t) => t <= 10).length, within30: times.filter((t) => t <= 30).length };
}

export const SPOT_CASES: SpotCase[] = [
  { name: "standing, still, open", rangeM: 100, posture: "standing", action: "still" },
  { name: "standing, still, open", rangeM: 300, posture: "standing", action: "still" },
  { name: "standing, still, open, observer with iron sights", rangeM: 300, posture: "standing", action: "still", ironSights: true },
  { name: "standing, still, open", rangeM: 600, posture: "standing", action: "still" },
  { name: "walking across, open", rangeM: 300, posture: "standing", action: "walk" },
  { name: "kneeling, still, open", rangeM: 300, posture: "crouching", action: "still" },
  { name: "prone, still, open", rangeM: 100, posture: "prone", action: "still" },
  { name: "prone, still, open", rangeM: 300, posture: "prone", action: "still" },
  { name: "standing, still, open, observer looking away", rangeM: 300, posture: "standing", action: "still", away: true },
  { name: "prone, still, in crops", rangeM: 100, posture: "prone", action: "still", cover: "crops" },
  { name: "crawling, in crops", rangeM: 100, posture: "prone", action: "crawl", cover: "crops" },
  { name: "prone, firing, in crops", rangeM: 100, posture: "prone", action: "fire", cover: "crops" },
  { name: "prone, still, in tall grass", rangeM: 100, posture: "prone", action: "still", cover: "tall-grass" },
];

export function spottingLab(data: DataSet): SpotRow[] {
  const cat = buildCatalog(data, ["de", "ru"]);
  return SPOT_CASES.map((c) => spotCase(cat, c));
}

export function spottingLabMarkdown(rows: SpotRow[]): string {
  const out = ["One regular observer (standing, G36 with its 3x optic unless stated), one enemy; each row 40 runs of up to 120 s.", "",
    "| target | range m | spotted in 120 s | median s | within 10 s | within 30 s |", "|---|---:|---:|---:|---:|---:|"];
  const pct = (a: number, b: number) => `${Math.round((100 * a) / b)} %`;
  for (const r of rows) out.push(`| ${r.name} | ${r.rangeM} | ${pct(r.spotted, r.runs)} | ${r.medianS === null ? "–" : r.medianS.toFixed(1)} | ${pct(r.within10, r.runs)} | ${pct(r.within30, r.runs)} |`);
  return out.join("\n");
}
