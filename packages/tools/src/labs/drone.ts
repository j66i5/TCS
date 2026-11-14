/**
 * DRONE LAB (M9.4a, roadmap-detail slice 34): how long a reconnaissance quadcopter's operator takes to pick out one
 * enemy below it. A German Funker with the platoon's quadcopter sends it over a Russian rifleman 300 m away; each
 * row is timed from the moment the man is within the cameras' footprint at the drone's height (launch and climb excluded) to the first sighting by
 * its cameras, over many seeds. Rows by flying height, the man's posture and cover (open, crops, woodland), by day
 * and on a moonless night (the thermal camera); then the battery: how long one battery keeps it up.
 */
import { buildCatalog, type DataSet } from "@tcs/data";
import {
  createSim, DEFAULT_COMMS, environmentAt, flatMap, step, submitOrder, type BattleInput, type Catalog, type MapDef, type Posture, type SoldierRecord,
} from "@tcs/sim";

export interface DroneCase { name: string; altM: number; posture: Posture; cover?: "crops" | "woodland"; night?: boolean; blanket?: boolean; walk?: boolean }
export interface DroneRow extends DroneCase { runs: number; spotted: number; medianS: number | null; within10: number; within60: number }

const NOON = 12 * 3600, NIGHT = 0;
const MAX_S = 120;

function man(personId: string, weapon: string, mag: string, catalog: Catalog, extra: SoldierRecord["load"] = []): SoldierRecord {
  return { personId, given: "Lab", family: personId, rank: "r", role: "rifleman", skills: { marksmanship: 0.5 }, weapon, fatigue: 0, stress: 0, wounds: [], status: "fit", load: [{ type: mag, count: 4, charge: catalog.items[mag]?.chargeCapacity ?? 30 }, ...extra] };
}

/** The lab's battle: a Funker with the quadcopter at (60, 200), one Russian rifleman at (400, 200). */
export function droneLabBattle(cat: Catalog, c: DroneCase, seed: number, limitS: number): BattleInput {
  const map: MapDef = flatMap("drone", 600, 400, 4);
  if (c.cover) {
    map.vegetationPalette.push(c.cover);
    for (let r = 0; r < map.rows; r++) for (let col = Math.floor(300 / map.cellSizeM); col < map.cols; col++) map.vegetation[r * map.cols + col] = 1;
  }
  const op = man("op", "de-g36", "de-g36-mag", cat, [{ type: "de-quadcopter", count: 1 }, { type: "de-drone-battery", count: 1, charge: cat.items["de-drone-battery"]!.chargeCapacity! }]);
  const tgt = man("tgt", "ru-ak74m", "ru-ak74-mag", cat, c.blanket ? [{ type: "ru-thermal-blanket", count: 1 }] : []);
  return {
    map, catalog: cat, seed, orders: [],
    environment: environmentAt(cat, c.night ? NIGHT : NOON, 0),
    rules: { timeLimitSeconds: limitS, commsModel: "simple", comms: { ...DEFAULT_COMMS, orderDelaySeconds: 0, orderDelayJitterSeconds: 0 }, physiologyModel: "none", physiologyParams: {}, objectives: [] },
    forces: [
      { side: "blue", faction: "de", units: [{ key: "o", callsign: "O", echelon: "team", leaderIndex: 0, subunits: [], members: [op] }], placements: [{ personId: "op", x: 60, y: 200, heading: 0 }] },
      { side: "red", faction: "ru", units: [{ key: "t", callsign: "T", echelon: "team", leaderIndex: 0, subunits: [], members: [tgt] }], placements: [{ personId: "tgt", x: 400, y: 200, heading: Math.PI }] },
    ],
  };
}

export function droneCase(cat: Catalog, c: DroneCase, seeds: number, seedBase: number): DroneRow {
  const times: number[] = [];
  for (let seed = seedBase + 1; seed <= seedBase + seeds; seed++) {
    const sim = createSim(droneLabBattle(cat, c, seed, 400));
    const ids = [...sim.state.identity.entries()];
    const op = ids.find(([, i]) => i.side === "blue")![0], tid = ids.find(([, i]) => i.side === "red")![0];
    sim.state.soldier.req(tid).posture = c.posture;
    // (The target holds fire: a shot would show him at once.)
    submitOrder(sim, { tick: 0, issuer: "red", target: tid, kind: "rules", fire: "hold" });
    if (c.walk) submitOrder(sim, { tick: 0, issuer: "red", target: tid, kind: "move", waypoints: [{ x: 400, y: 390, mode: "walk" }] });
    submitOrder(sim, { tick: 0, issuer: "blue", target: op, kind: "drone", op: "fly", x: 400, y: 200, altM: c.altM });
    let over: number | null = null, at: number | null = null;
    for (let k = 0; k < 400 * 60 && at === null; k++) {
      const ev = step(sim);
      if (over === null) {
        // (In view from the moment he is within its cameras' footprint at its height.)
        for (const [did, d] of sim.state.drone.entries()) {
          const t = sim.state.transform.req(did), tt = sim.state.transform.req(tid), fp = sim.ctx.catalog.items[d.item]!.drone!.footprintM;
          if (t.z >= c.altM - 1 && (t.x - tt.x) * (t.x - tt.x) + (t.y - tt.y) * (t.y - tt.y) <= fp * fp) over = sim.state.tick;
        }
      }
      for (const e of ev) if (over === null && e.kind === "spotted" && e.drone === true && e.target === tid) over = e.tick; // seen while still climbing
      if (over === null) continue;
      for (const e of ev) if (e.kind === "spotted" && e.drone === true && e.target === tid) at = (e.tick - over) / 60;
      if (sim.state.tick - over > MAX_S * 60) break;
    }
    if (at !== null) times.push(at);
  }
  times.sort((a, b) => a - b);
  const median = times.length * 2 > seeds ? times[Math.floor(seeds / 2)]! : null;
  return { ...c, runs: seeds, spotted: times.length, medianS: median, within10: times.filter((t) => t <= 10).length, within60: times.filter((t) => t <= 60).length };
}

export const DRONE_CASES: DroneCase[] = [
  { name: "standing, still, open", altM: 50, posture: "standing" },
  { name: "standing, still, open", altM: 100, posture: "standing" },
  { name: "standing, still, open", altM: 200, posture: "standing" },
  { name: "prone, still, open", altM: 100, posture: "prone" },
  { name: "prone, still, in crops", altM: 100, posture: "prone", cover: "crops" },
  { name: "prone, still, in woodland", altM: 100, posture: "prone", cover: "woodland" },
  { name: "walking, open", altM: 200, posture: "standing", walk: true },
  { name: "prone, still, open", altM: 100, posture: "prone", night: true },
  { name: "prone, still, in woodland", altM: 100, posture: "prone", cover: "woodland", night: true },
  { name: "prone, still, open, under a thermal blanket", altM: 100, posture: "prone", night: true, blanket: true },
];

/** Battery: minutes from launch until the drone, sent 300 m out to hover, is back and recovered. */
export function droneEndurance(cat: Catalog): { item: string; capacityWh: number; powerW: number; upMinutes: number; recovered: boolean } {
  const sim = createSim(droneLabBattle(cat, { name: "endurance", altM: 100, posture: "standing" }, 1, 4000));
  const op = [...sim.state.identity.entries()].find(([, i]) => i.side === "blue")![0];
  submitOrder(sim, { tick: 0, issuer: "blue", target: op, kind: "drone", op: "fly", x: 400, y: 120 });
  let up: number | null = null, down: number | null = null, recovered = false;
  for (let k = 0; k < 4000 * 60 && down === null; k++) for (const e of step(sim)) {
    if (e.kind === "drone.launched") up = e.tick;
    if (e.kind === "drone.landed" || e.kind === "drone.lost") { down = e.tick; recovered = e.kind === "drone.landed"; }
  }
  const def = cat.items["de-quadcopter"]!.drone!;
  return { item: "de-quadcopter", capacityWh: cat.items[def.battery]!.chargeCapacity!, powerW: def.powerW, upMinutes: up !== null && down !== null ? (down - up) / 3600 : NaN, recovered };
}

export function droneLab(data: DataSet, seeds = 20): { rows: DroneRow[]; endurance: ReturnType<typeof droneEndurance> } {
  const cat = buildCatalog(data, ["de", "ru"]);
  return { rows: DRONE_CASES.map((c, i) => droneCase(cat, c, seeds, 11000 + 100 * i)), endurance: droneEndurance(cat) };
}

export function droneLabMarkdown(r: ReturnType<typeof droneLab>): string {
  const out = [`A Funker's quadcopter (de-quadcopter: day and thermal cameras) over one enemy rifleman who holds his fire; timed from the moment he is within its cameras' footprint at its flying height; each row ${r.rows[0]?.runs ?? 0} runs of up to ${MAX_S} s.`, "",
    "| target | height m | light | spotted | median s | within 10 s | within 60 s |", "|---|---:|---|---:|---:|---:|---:|"];
  const pct = (a: number, b: number) => `${Math.round((100 * a) / b)} %`;
  for (const x of r.rows) out.push(`| ${x.name} | ${x.altM} | ${x.night ? "night, no moon" : "noon"} | ${pct(x.spotted, x.runs)} | ${x.medianS === null ? "–" : x.medianS.toFixed(1)} | ${pct(x.within10, x.runs)} | ${pct(x.within60, x.runs)} |`);
  const e = r.endurance;
  out.push("", `Battery: ${e.item}, ${e.capacityWh} Wh at ${e.powerW} W: up ${e.upMinutes.toFixed(1)} min from launch to landing on a low battery (${e.recovered ? "recovered by its operator" : "lost"}).`);
  return out.join("\n");
}
