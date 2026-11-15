/**
 * SPOTTING LAB (SPEC 5.4, 6.5, M3.2): how long a regular soldier takes to spot one enemy, by situation.
 * One observer (German, G36 with its 3x optic, or an iron-sighted comparison), one target (Russian) on a flat
 * strip; each case is run over many seeds and stops at the first "spotted" event. Owner anchors (2026-11-11):
 * a man standing still in the open at 300 m in about 5-15 s; a man lying still in crops at 100 m very hard
 * to spot until he moves or fires.
 */
import { buildCatalog, type DataSet } from "@tcs/data";
import {
  createSim, DEFAULT_COMMS, environmentAt, flatMap, occupyPlaces, step, submitOrder, type BattleInput, type Building, type Catalog, type MapDef, type Posture, type SoldierRecord,
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
  /** First seed (so that two rows do not share their random draws). */
  seedBase?: number;
  maxSeconds?: number;
  /** Night and light (M9.1): local time (s since midnight) and moon (0..1); absent = daylight as before. */
  timeOfDay?: number;
  moon?: number;
  /** The observer wears night-vision goggles (his faction's item with `sensor: "night"`). */
  nvg?: boolean;
  /** M9.2: the observer has a thermal weapon sight; the target carries a thermal blanket; the target stands this
   *  many degrees off where the observer looks. */
  thermal?: boolean;
  blanket?: boolean;
  offAxisDeg?: number;
  /** M9.6: an illumination flare of `candela` burning steadily (no descent, for the whole case) `heightM` above the
   *  ground at a point `beyondM` beyond the target (on the line from the observer); injected into the state. */
  flare?: { candela: number; heightM: number; beyondM: number };
}
export interface SpotRow extends SpotCase { runs: number; spotted: number; medianS: number | null; within10: number; within30: number }

function man(personId: string, weapon: string, mag: string, catalog: Catalog): SoldierRecord {
  return { personId, given: "Lab", family: personId, rank: "r", role: "rifleman", skills: { marksmanship: 0.5 }, weapon, fatigue: 0, stress: 0, wounds: [], status: "fit", load: [{ type: mag, count: 4, charge: catalog.items[mag]?.chargeCapacity ?? 30 }] };
}

export function spotCase(catalog: Catalog, c: SpotCase): SpotRow {
  const times: number[] = [];
  const seeds = c.seeds ?? 40, max = c.maxSeconds ?? 120;
  for (let seed = (c.seedBase ?? 0) + 1; seed <= (c.seedBase ?? 0) + seeds; seed++) {
    const map: MapDef = flatMap("spot", Math.max(200, c.rangeM + 80), 200, 4);
    if (c.cover) {
      map.vegetationPalette.push(c.cover);
      for (let r = 0; r < map.rows; r++) for (let col = Math.floor(60 / map.cellSizeM); col < map.cols; col++) map.vegetation[r * map.cols + col] = 1;
    }
    const ox = 20, ty = 100, tx = 20 + c.rangeM;
    const obs = man("obs", c.ironSights ? "ru-ak74m" : "de-g36", c.ironSights ? "ru-ak74-mag" : "de-g36-mag", catalog);
    if (c.nvg) obs.load.push({ type: "de-nvg", count: 1 });
    if (c.thermal) obs.load.push({ type: "de-thermal-sight", count: 1 });
    const tgt = man("tgt", "ru-ak74m", "ru-ak74-mag", catalog);
    if (c.blanket) tgt.load.push({ type: "ru-thermal-blanket", count: 1 });
    const input: BattleInput = {
      map, catalog, seed, orders: [],
      ...(c.timeOfDay !== undefined ? { environment: environmentAt(catalog, c.timeOfDay, c.moon ?? 0.5) } : {}),
      rules: { timeLimitSeconds: max + 10, commsModel: "simple", comms: { ...DEFAULT_COMMS, orderDelaySeconds: 0, orderDelayJitterSeconds: 0 }, physiologyModel: "none", physiologyParams: {}, objectives: [] },
      forces: [
        { side: "blue", faction: "de", units: [{ key: "o", callsign: "O", echelon: "team", leaderIndex: 0, subunits: [], members: [obs] }], placements: [{ personId: "obs", x: ox, y: ty, heading: c.away ? Math.PI : -((c.offAxisDeg ?? 0) * Math.PI) / 180 }] },
        { side: "red", faction: "ru", units: [{ key: "t", callsign: "T", echelon: "team", leaderIndex: 0, subunits: [], members: [tgt] }], placements: [{ personId: "tgt", x: tx, y: ty, heading: Math.PI }] },
      ],
    };
    const sim = createSim(input);
    if (c.flare) sim.state.flares = [{ x: tx + c.flare.beyondM, y: ty, z: c.flare.heightM, startTick: 0, untilTick: (max + 20) * 60, descentMps: 0, candela: c.flare.candela, side: "blue" }];
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
  const median = times.length * 2 > seeds ? times[Math.floor(seeds / 2)]! : times.length * 2 === seeds ? max : null;
  return { ...c, runs: seeds, spotted: times.length, medianS: median, within10: times.filter((t) => t <= 10).length, within30: times.filter((t) => t <= 30).length };
}

export const SPOT_CASES: SpotCase[] = [
  { name: "standing, still, open", rangeM: 100, posture: "standing", action: "still" },
  { name: "standing, still, open", rangeM: 300, posture: "standing", action: "still" },
  { name: "standing, still, open, observer with iron sights", rangeM: 300, posture: "standing", action: "still", ironSights: true, seedBase: 1000 },
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
  for (const r of rows) out.push(`| ${r.name} | ${r.rangeM} | ${pct(r.spotted, r.runs)} | ${r.medianS === null ? "–" : r.medianS >= (r.maxSeconds ?? 120) ? "over 120" : r.medianS.toFixed(1)} | ${pct(r.within10, r.runs)} | ${pct(r.within30, r.runs)} |`);
  return out.join("\n");
}

// ---------------------------------------------------------------- sight realism rows (2026-11-15)

/**
 * SIGHT REALISM ROWS (owner request 2026-11-15, "make the line of sight more realistic"; DECISIONS "Sight realism:
 * baseline"). Ported from the audit's scratch scripts so that every later step is judged by the same cases. One or
 * more regular observers (standing, facing the target, G36 with its 3x optic unless stated), one target; the target's
 * posture and the observers' posture and heading are held every tick. Vegetation is a patch round the target: from
 * `depthM` in front of him (towards the observers) to 8 m behind him, 24 m wide; `field` covers everything from 60 m
 * on instead. 20 seeds (7001-7020) of up to 120 s each, stopping at the first "spotted" event.
 */
export interface SightCase {
  name: string;
  rangeM: number;
  posture: Posture;
  action: "still" | "walk" | "crawl" | "fire";
  veg?: string;
  depthM?: number;
  /** The whole strip from 60 m on is `veg` (a crop field) instead of a patch. */
  field?: boolean;
  /** Number of observers, 5 m apart across the line of view. */
  observers?: number;
  ironSights?: boolean;
  /** The target stands at a ground-floor window of a one-storey house (placed with `occupyPlaces`). */
  window?: boolean;
  seeds?: number;
  maxSeconds?: number;
}
export interface SightRow extends SightCase { runs: number; found: number; medianS: number | null; within10: number }

const SIGHT_SEED_BASE = 7000;

/** A one-storey house (10 x 10 m, one room) whose west wall (x = `wx`) faces the observers, one window in it. */
function windowHouse(wx: number, cy: number): Building {
  const fp = [wx, cy - 5, wx + 10, cy - 5, wx + 10, cy + 5, wx, cy + 5];
  return {
    id: 1, kind: "house", footprint: fp, storeys: 1, storeyHeightM: 2.8, wallMaterial: "brick", wallThicknessM: 0.3, roofColour: "#8c4a3b",
    openings: [
      { wall: 1, offsetM: 5, widthM: 1.0, kind: "door", sillM: 0, headM: 2.1 },
      { wall: 3, offsetM: 4.4, widthM: 1.2, kind: "window", sillM: 0.9, headM: 2.1 },
    ],
    interior: { rooms: [{ id: 0, floor: 0, poly: fp.slice(), kind: "room" }], walls: [], stairs: [] },
  };
}

export function sightCase(catalog: Catalog, c: SightCase): SightRow {
  const seeds = c.seeds ?? 20, max = c.maxSeconds ?? 120, times: number[] = [];
  const moving = c.action === "walk" || c.action === "crawl";
  for (let seed = 1; seed <= seeds; seed++) {
    const map: MapDef = flatMap("spot", Math.max(200, c.rangeM + 80), 200, 2);
    const ox = 20, ty = 100, tx = 20 + c.rangeM;
    if (c.veg) {
      map.vegetationPalette.push(c.veg);
      const cs = map.cellSizeM;
      for (let r = 0; r < map.rows; r++) for (let col = 0; col < map.cols; col++) {
        const x = (col + 0.5) * cs, y = (r + 0.5) * cs;
        if (c.field ? x >= 60 : (x >= tx - (c.depthM ?? 4) && x <= tx + 8 && Math.abs(y - ty) <= 12)) map.vegetation[r * map.cols + col] = 1;
      }
    }
    if (c.window) map.buildings = [windowHouse(tx, ty)];
    const nObs = c.observers ?? 1;
    const obsMen = Array.from({ length: nObs }, (_, i) => man(`obs${i}`, c.ironSights ? "ru-ak74m" : "de-g36", c.ironSights ? "ru-ak74-mag" : "de-g36-mag", catalog));
    const tgt = man("tgt", "ru-ak74m", "ru-ak74-mag", catalog);
    const input: BattleInput = {
      map, catalog, seed: seed + SIGHT_SEED_BASE, orders: [],
      rules: { timeLimitSeconds: max + 10, commsModel: "simple", comms: { ...DEFAULT_COMMS, orderDelaySeconds: 0, orderDelayJitterSeconds: 0 }, physiologyModel: "none", physiologyParams: {}, objectives: [] },
      forces: [
        { side: "blue", faction: "de", units: [{ key: "o", callsign: "O", echelon: "team", leaderIndex: 0, subunits: [], members: obsMen }], placements: obsMen.map((m, i) => ({ personId: m.personId, x: ox, y: ty + (i - (nObs - 1) / 2) * 5, heading: 0 })) },
        { side: "red", faction: "ru", units: [{ key: "t", callsign: "T", echelon: "team", leaderIndex: 0, subunits: [], members: [tgt] }], placements: [{ personId: "tgt", x: tx, y: ty - (moving ? 8 : 0), heading: Math.PI }] },
      ],
    };
    const sim = createSim(input);
    const ids = [...sim.state.identity.entries()];
    const tid = ids.find(([, i]) => i.side === "red")![0], oids = ids.filter(([, i]) => i.side === "blue").map(([id]) => id);
    let posture = c.posture;
    if (c.window) {
      const place = occupyPlaces(sim.ctx, 0, 1, 0, Math.PI)[0]!;
      const t = sim.state.transform.req(tid);
      t.x = place.x; t.y = place.y; t.z = place.z; t.heading = place.heading;
      if (place.posture) posture = place.posture;
    }
    if (moving) {
      const mode = c.action === "walk" ? "walk" : "crawl";
      submitOrder(sim, { tick: 0, issuer: "red", target: tid, kind: "move", waypoints: [10, -10, 10, -10, 10].map((d) => ({ x: tx, y: ty + d, mode })) });
    }
    if (c.action === "fire") submitOrder(sim, { tick: 0, issuer: "red", target: tid, kind: "fire", x: ox, y: ty + 40, heightM: 1 });
    let at: number | null = null;
    for (let k = 0; k < max * 60 && at === null; k++) {
      sim.state.soldier.req(tid).posture = posture;
      for (const oid of oids) { sim.state.soldier.req(oid).posture = "standing"; const t = sim.state.transform.get(oid); if (t) t.heading = 0; }
      for (const e of step(sim)) if (e.kind === "spotted" && e.target === tid) at = e.tick / 60;
    }
    if (at !== null) times.push(at);
  }
  times.sort((a, b) => a - b);
  // The median of all runs (a run not found counts as never): found in more than half, else "over max".
  const medianS = times.length * 2 > seeds ? times[Math.floor(seeds / 2)]! : null;
  return { ...c, runs: seeds, found: times.length, medianS, within10: times.filter((t) => t <= 10).length };
}

const P = (posture: Posture, action: SightCase["action"]) => ({ posture, action });
export const SIGHT_CASES: SightCase[] = [
  ...[50, 100, 200].map((r) => ({ name: "standing, still, open", rangeM: r, ...P("standing", "still") })),
  { name: "prone, still, open", rangeM: 50, ...P("prone", "still") },
  ...["crops", "tall-grass", "scrub"].flatMap((v) => [100, 200, 400].map((r) => ({ name: `prone, still, behind 4 m of ${v}`, rangeM: r, ...P("prone", "still"), veg: v, depthM: 4 }))),
  ...[100, 200].map((r) => ({ name: "prone, still, in a whole crop field", rangeM: r, ...P("prone", "still"), veg: "crops", field: true })),
  ...[100, 400].map((r) => ({ name: "standing, still, 2 m inside a treeline", rangeM: r, ...P("standing", "still"), veg: "treeline", depthM: 2 })),
  { name: "standing, still, 5 m inside woodland", rangeM: 400, ...P("standing", "still"), veg: "woodland", depthM: 5 },
  ...[100, 400].map((r) => ({ name: "crouching, still, in tall grass (4 m)", rangeM: r, ...P("crouching", "still"), veg: "tall-grass", depthM: 4 })),
  ...[200, 400].map((r) => ({ name: "prone, firing, behind 4 m of crops", rangeM: r, ...P("prone", "fire"), veg: "crops", depthM: 4 })),
  ...[400, 600].map((r) => ({ name: "prone, firing, open", rangeM: r, ...P("prone", "fire") })),
  ...[400, 600].map((r) => ({ name: "crawling, open", rangeM: r, ...P("prone", "crawl") })),
  { name: "crawling, behind 4 m of crops", rangeM: 200, ...P("prone", "crawl"), veg: "crops", depthM: 4 },
  ...[1, 3, 9].flatMap((o) => [200, 400].map((r) => ({ name: `prone, still, behind 4 m of crops, ${o} observer${o > 1 ? "s" : ""}`, rangeM: r, ...P("prone", "still"), veg: "crops", depthM: 4, observers: o }))),
  ...[400, 600].flatMap((r) => [false, true].map((iron) => ({ name: `standing, still, open, ${iron ? "iron sights" : "G36 optic"}`, rangeM: r, ...P("standing", "still"), ironSights: iron }))),
  { name: "standing, still, at a house window", rangeM: 300, ...P("standing", "still"), window: true },
];

/**
 * RETENTION: once seen, how long is a man kept in the observer's `seen` after he lies down still? The target walks
 * 12 m into place in view (standing, open; both sides hold fire), then lies prone still with `veg` in front of him
 * (a 4 m patch as above) or open ground. 20 seeds (101-120), 90 s each; only runs where he was seen when he stopped.
 */
export interface RetainRow { veg: string | null; rangeM: number; runs: number; seenAtStop: number; kept60: number; lost20: number; meanKeptS: number }

export function retainCase(catalog: Catalog, veg: string | null, rangeM: number, seeds = 20): RetainRow {
  let n = 0, kept60 = 0, lost20 = 0, keptSum = 0;
  for (let seed = 1; seed <= seeds; seed++) {
    const map: MapDef = flatMap("r", rangeM + 100, 200, 2);
    const ox = 20, ty = 100, tx = 20 + rangeM;
    if (veg) {
      map.vegetationPalette.push(veg);
      for (let r = 0; r < map.rows; r++) for (let col = 0; col < map.cols; col++) {
        const x = (col + 0.5) * 2, y = (r + 0.5) * 2;
        if (x >= tx - 4 && x <= tx + 8 && Math.abs(y - ty) <= 12) map.vegetation[r * map.cols + col] = 1;
      }
    }
    const input: BattleInput = {
      map, catalog, seed: seed + 100, orders: [],
      rules: { timeLimitSeconds: 200, commsModel: "simple", comms: { ...DEFAULT_COMMS, orderDelaySeconds: 0, orderDelayJitterSeconds: 0 }, physiologyModel: "none", physiologyParams: {}, objectives: [] },
      forces: [
        { side: "blue", faction: "de", units: [{ key: "o", callsign: "O", echelon: "team", leaderIndex: 0, subunits: [], members: [man("obs", "de-g36", "de-g36-mag", catalog)] }], placements: [{ personId: "obs", x: ox, y: ty, heading: 0 }] },
        { side: "red", faction: "ru", units: [{ key: "t", callsign: "T", echelon: "team", leaderIndex: 0, subunits: [], members: [man("tgt", "ru-ak74m", "ru-ak74-mag", catalog)] }], placements: [{ personId: "tgt", x: tx, y: ty - 12, heading: Math.PI }] },
      ],
    };
    const sim = createSim(input);
    const ids = [...sim.state.identity.entries()];
    const tid = ids.find(([, i]) => i.side === "red")![0], oid = ids.find(([, i]) => i.side === "blue")![0];
    submitOrder(sim, { tick: 0, issuer: "blue", target: oid, kind: "rules", fire: "hold" });
    submitOrder(sim, { tick: 0, issuer: "red", target: tid, kind: "rules", fire: "hold" });
    submitOrder(sim, { tick: 0, issuer: "red", target: tid, kind: "move", waypoints: [{ x: tx, y: ty, mode: "walk" }] });
    let seenAtStop = false, lastSeen = -1, stopTick = -1;
    for (let k = 0; k < 90 * 60; k++) {
      const ts = sim.state.soldier.req(tid), os = sim.state.soldier.req(oid);
      os.posture = "standing"; sim.state.transform.req(oid).heading = 0;
      const sp = sim.state.mover.get(tid)?.speedMps ?? 0;
      if (stopTick < 0 && k > 60 && sp < 0.05) { stopTick = k; seenAtStop = os.seen.some((e) => e.target === tid); }
      if (stopTick >= 0) ts.posture = "prone";
      step(sim);
      if (stopTick >= 0 && os.seen.some((e) => e.target === tid)) lastSeen = k;
    }
    if (!seenAtStop) continue;
    n++;
    const kept = Math.max(0, (lastSeen - stopTick) / 60);
    keptSum += kept;
    if (kept >= 60) kept60++;
    if (kept < 20) lost20++;
  }
  return { veg, rangeM, runs: seeds, seenAtStop: n, kept60, lost20, meanKeptS: n > 0 ? keptSum / n : 0 };
}

export interface SightRealism { rows: SightRow[]; retain: RetainRow[] }

export function sightRealismLab(data: DataSet, seeds = 20): SightRealism {
  const cat = buildCatalog(data, ["de", "ru"]);
  const rows = SIGHT_CASES.map((c) => sightCase(cat, { ...c, seeds }));
  const retain: RetainRow[] = [];
  for (const veg of [null, "crops", "scrub"]) for (const r of [100, 200, 300]) retain.push(retainCase(cat, veg, r, seeds));
  return { rows, retain };
}

export function sightRealismMarkdown(res: SightRealism): string {
  const pct = (a: number, b: number) => (b > 0 ? `${Math.round((100 * a) / b)} %` : "–");
  const out = [
    "## Sight realism rows",
    "",
    "Regular observers standing and facing the target (G36 with its 3x optic unless stated); vegetation is a patch from the stated depth in front of the target to 8 m behind him; postures held every tick. Each row: seeds 7001-7020, up to 120 s.",
    "",
    "| target | range m | runs | median s | found within 10 s | never found in 120 s |",
    "|---|---:|---:|---:|---:|---:|",
  ];
  for (const r of res.rows) out.push(`| ${r.name} | ${r.rangeM} | ${r.runs} | ${r.medianS === null ? `over ${r.maxSeconds ?? 120}` : r.medianS.toFixed(1)} | ${pct(r.within10, r.runs)} | ${pct(r.runs - r.found, r.runs)} |`);
  out.push("", "## Retention", "", "Seen walking into place, then prone and still (both sides hold fire); 90 s, seeds 101-120. Only runs where he was seen as he stopped count.", "",
    "| in front of him | range m | seen as he stopped | still kept at 60 s | lost within 20 s | mean time kept s |", "|---|---:|---:|---:|---:|---:|");
  for (const r of res.retain) out.push(`| ${r.veg === null ? "open ground" : `4 m of ${r.veg}`} | ${r.rangeM} | ${r.seenAtStop}/${r.runs} | ${pct(r.kept60, r.seenAtStop)} | ${pct(r.lost20, r.seenAtStop)} | ${r.meanKeptS.toFixed(0)} |`);
  return out.join("\n");
}
