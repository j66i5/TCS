/**
 * DRONE LAB (M9.4a, roadmap-detail slice 34): how long a reconnaissance quadcopter's operator takes to pick out one
 * enemy below it. A German Funker with the platoon's quadcopter sends it over a Russian rifleman 300 m away; each
 * row is timed from the moment the man is within the cameras' footprint at the drone's height (launch and climb excluded) to the first sighting by
 * its cameras, over many seeds. Rows by flying height, the man's posture and cover (open, crops, woodland), by day
 * and on a moonless night (the thermal camera); then the battery: how long one battery keeps it up. M9.6: with a
 * woodland strip 30 m to his side, a man walking past it or standing still in the open, with and without hiding from
 * drones (behaviour.soldier.droneHide; off = its triggerM 0 on a copy of the catalog).
 */
import { buildCatalog, type DataSet } from "@tcs/data";
import {
  createSim, DEFAULT_COMMS, environmentAt, flatMap, step, submitOrder, type BattleInput, type Catalog, type MapDef, type Posture, type SoldierRecord,
} from "@tcs/sim";

export interface DroneCase {
  name: string; altM: number; posture: Posture; cover?: "crops" | "woodland"; night?: boolean; blanket?: boolean; walk?: boolean;
  /** M9.6: a woodland strip 30 m to his side (x 430-460, the whole height of the map). */
  woodSide?: boolean;
  /** M9.6: hiding from drones off (behaviour.soldier.droneHide.triggerM 0 on a copy of the catalog). */
  noHide?: boolean;
}
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
  if (c.woodSide) {
    map.vegetationPalette.push("woodland");
    const v = map.vegetationPalette.length;
    for (let r = 0; r < map.rows; r++) for (let col = Math.floor(430 / map.cellSizeM); col < Math.floor(460 / map.cellSizeM); col++) map.vegetation[r * map.cols + col] = v;
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

/** The catalog with hiding from drones switched off (M9.6: its triggerM 0). */
export function noDroneHide(cat: Catalog): Catalog {
  const S = cat.behaviour.soldier;
  if (!S.droneHide) return cat;
  return { ...cat, behaviour: { ...cat.behaviour, soldier: { ...S, droneHide: { ...S.droneHide, triggerM: 0 } } } };
}

export function droneCase(catalog: Catalog, c: DroneCase, seeds: number, seedBase: number): DroneRow {
  const cat = c.noHide ? noDroneHide(catalog) : catalog;
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
  { name: "walking, open", altM: 200, posture: "standing", walk: true, noHide: true },
  { name: "walking, open, hides (freezes; woodland 30 m to his side)", altM: 200, posture: "standing", walk: true, woodSide: true },
  { name: "standing, still, open, woodland 30 m to his side, no hiding", altM: 100, posture: "standing", woodSide: true, noHide: true },
  { name: "standing, still, open, woodland 30 m to his side, hides", altM: 100, posture: "standing", woodSide: true },
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

/** Counter-drone (M9.4b): Russian men free to fire, the German drone hovering `altM` up and `offsetM` short of them. */
export interface CounterCase { name: string; men: number; mg: boolean; altM: number; offsetM: number }
export interface CounterRow extends CounterCase { runs: number; seen60: number; down: number; medianDownS: number | null; roundsPerRun: number }

export const COUNTER_CASES: CounterCase[] = [
  { name: "one rifleman", men: 1, mg: false, altM: 50, offsetM: 0 },
  { name: "one rifleman", men: 1, mg: false, altM: 100, offsetM: 0 },
  { name: "one rifleman", men: 1, mg: false, altM: 150, offsetM: 0 },
  { name: "one machine gunner (PKP)", men: 1, mg: true, altM: 100, offsetM: 0 },
  { name: "four riflemen", men: 4, mg: false, altM: 100, offsetM: 0 },
  { name: "four riflemen", men: 4, mg: false, altM: 120, offsetM: 150 },
  { name: "four riflemen", men: 4, mg: false, altM: 120, offsetM: 220 },
];
const COUNTER_S = 180;

export function counterCase(cat: Catalog, c: CounterCase, seeds: number, seedBase: number): CounterRow {
  let seen60 = 0, rounds = 0;
  const downs: number[] = [];
  for (let seed = seedBase + 1; seed <= seedBase + seeds; seed++) {
    const input = droneLabBattle(cat, { name: c.name, altM: c.altM, posture: "standing" }, seed, 600);
    const red = input.forces[1]!;
    const tm = red.units[0]!.members[0]!;
    if (c.mg) { tm.weapon = "ru-pkp"; tm.load = [{ type: "ru-pkp-belt", count: 3, charge: cat.items["ru-pkp-belt"]?.chargeCapacity ?? 100 }]; }
    for (let k = 1; k < c.men; k++) {
      red.units[0]!.members.push({ ...tm, personId: `tgt${k}`, load: tm.load.map((x) => ({ ...x })) });
      red.placements.push({ personId: `tgt${k}`, x: 400 + 6 * k, y: 200 + (k % 2 ? 5 : -5), heading: Math.PI });
    }
    const sim = createSim(input);
    const ids = [...sim.state.identity.entries()];
    const op = ids.find(([, i]) => i.side === "blue")![0];
    const reds = new Set(ids.filter(([, i]) => i.side === "red").map(([id]) => id));
    const tm0 = [...reds][0]!;
    const ru = [...sim.state.unit.keys()].find((u) => sim.state.unit.get(u)!.side === "red")!;
    // (Free to fire, but not at the German operator 340 m off: only the drone is in this.)
    submitOrder(sim, { tick: 0, issuer: "red", target: ru, kind: "rules", fire: "free", maxEngageM: 200 });
    submitOrder(sim, { tick: 0, issuer: "blue", target: op, kind: "drone", op: "fly", x: 400 - c.offsetM, y: 200, altM: c.altM });
    // (The German holds his fire: only the drone is in this.)
    submitOrder(sim, { tick: 0, issuer: "blue", target: [...sim.state.unit.keys()].find((u) => sim.state.unit.get(u)!.side === "blue")!, kind: "rules", fire: "hold" });
    let over: number | null = null, seenAt: number | null = null, down: number | null = null;
    for (let k = 0; k < 600 * 60 && down === null; k++) {
      const ev = step(sim);
      // (The clock starts when it comes within 250 m of the men, or hovers, whichever is first.)
      if (over === null) for (const [did, d] of sim.state.drone.entries()) {
        const t = sim.state.transform.req(did), m = sim.state.transform.req(tm0);
        if (d.mode === "hover" || Math.hypot(t.x - m.x, t.y - m.y, t.z) <= 250) over = sim.state.tick;
      }
      for (const e of ev) {
        if (over === null) continue;
        if (e.kind === "spotted" && reds.has(e.observer) && sim.state.drone.has(e.target) && seenAt === null) seenAt = e.tick;
        if (e.kind === "shot.fired" && reds.has(e.shooter)) { const ft = sim.state.fire.get(e.shooter); if (ft?.contact !== undefined && sim.state.drone.has(ft.contact)) rounds++; }
        if (e.kind === "drone.lost" && e.reason === "shot") down = (e.tick - over) / 60;
      }
      // (Already in sight when it got there: seen at once.)
      if (over !== null && seenAt === null && [...reds].some((m) => sim.state.soldier.get(m)!.seen.some((x) => sim.state.drone.has(x.target)))) seenAt = sim.state.tick;
      if (over !== null && sim.state.tick - over > COUNTER_S * 60) break;
    }
    if (over !== null && seenAt !== null && seenAt - over <= 60 * 60) seen60++;
    if (down !== null) downs.push(down);
  }
  downs.sort((a, b) => a - b);
  return { ...c, runs: seeds, seen60, down: downs.length, medianDownS: downs.length * 2 > seeds ? downs[Math.floor(seeds / 2)]! : null, roundsPerRun: Math.round(rounds / seeds) };
}

export function droneLab(data: DataSet, seeds = 20): { rows: DroneRow[]; endurance: ReturnType<typeof droneEndurance>; counter: CounterRow[] } {
  const cat = buildCatalog(data, ["de", "ru"]);
  return {
    rows: DRONE_CASES.map((c, i) => droneCase(cat, c, seeds, 11000 + 100 * i)), endurance: droneEndurance(cat),
    counter: COUNTER_CASES.map((c, i) => counterCase(cat, c, seeds, 13000 + 100 * i)),
  };
}

export function droneLabMarkdown(r: ReturnType<typeof droneLab>): string {
  const out = [`A Funker's quadcopter (de-quadcopter: day and thermal cameras) over one enemy rifleman who holds his fire; timed from the moment he is within its cameras' footprint at its flying height; each row ${r.rows[0]?.runs ?? 0} runs of up to ${MAX_S} s.`, "",
    "| target | height m | light | spotted | median s | within 10 s | within 60 s |", "|---|---:|---|---:|---:|---:|---:|"];
  const pct = (a: number, b: number) => `${Math.round((100 * a) / b)} %`;
  for (const x of r.rows) out.push(`| ${x.name} | ${x.altM} | ${x.night ? "night, no moon" : "noon"} | ${pct(x.spotted, x.runs)} | ${x.medianS === null ? "–" : x.medianS.toFixed(1)} | ${pct(x.within10, x.runs)} | ${pct(x.within60, x.runs)} |`);
  const e = r.endurance;
  out.push("", `Battery: ${e.item}, ${e.capacityWh} Wh at ${e.powerW} W: up ${e.upMinutes.toFixed(1)} min from launch to landing on a low battery (${e.recovered ? "recovered by its operator" : "lost"}).`);
  out.push("", "## Counter-drone (M9.4b)", "", `Russian men free to fire; the German drone (de-quadcopter, 0.25 m^2) flying to hover at the height given and this far short of them; from the moment it comes within 250 m of them (or hovers), ${COUNTER_S} s.`, "",
    "| who fires | height m | short of them m | seen within 60 s | shot down | median s to down | rounds at it per run |", "|---|---:|---:|---:|---:|---:|---:|");
  for (const x of r.counter) out.push(`| ${x.name} | ${x.altM} | ${x.offsetM} | ${pct(x.seen60, x.runs)} | ${pct(x.down, x.runs)} | ${x.medianDownS === null ? "–" : x.medianDownS.toFixed(0)} | ${x.roundsPerRun} |`);
  return out.join("\n");
}
