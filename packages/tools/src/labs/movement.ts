/**
 * MOVEMENT & FATIGUE LAB (SPEC 5.4): one soldier, controlled conditions, measured outcomes.
 * Each case builds a tiny battle (flat or sloped strip of ground), gives one order and measures speed,
 * fatigue and heart rate. The table goes to the session report; the test asserts plausible bands.
 */
import { buildCatalog, type DataSet } from "@tcs/data";
import {
  createSim, DEFAULT_COMMS, flatMap, postureChangeSeconds, secondsToTicks, step, submitOrder, ticksToSeconds,
  type BattleInput, type MapDef, type Posture, type Sim,
} from "@tcs/sim";

export interface MoveRow {
  case: string;
  loadKg: number;
  mode: string;
  distanceM: number;
  seconds: number;
  speedMps: number;
  fatigueEnd: number;
  hrMax: number;
}

function strip(data: DataSet, opts: { grade?: number; woods?: boolean }): MapDef {
  const m = flatMap("lab", 1600, 40, 4);
  const cat = buildCatalog(data, ["de"]);
  void cat;
  if (opts.grade) for (let r = 0; r <= m.rows; r++) for (let c = 0; c <= m.cols; c++) m.heights[r * (m.cols + 1) + c] = 100 + c * m.cellSizeM * opts.grade;
  if (opts.woods) {
    m.vegetationPalette = ["woodland"];
    m.vegetation.fill(1);
  }
  return m;
}

function oneSoldier(data: DataSet, map: MapDef, loadUnits: number, startX: number): { sim: Sim; id: number; input: BattleInput } {
  const catalog = buildCatalog(data, ["de"]);
  const load = loadUnits > 0 ? [{ type: "de-basic-load", count: loadUnits * 3 }] : [];
  const input: BattleInput = {
    map, catalog, seed: 1, orders: [],
    rules: { timeLimitSeconds: 3600, commsModel: "simple", comms: { ...DEFAULT_COMMS, orderDelaySeconds: 0, orderDelayJitterSeconds: 0 }, physiologyModel: "none", physiologyParams: {}, objectives: [] },
    forces: [
      { side: "blue", faction: "de", units: [{ key: "lab", callsign: "Lab", echelon: "team", leaderIndex: 0, subunits: [],
        members: [{ personId: "lab#0", given: "Lab", family: "Rat", rank: "gefreiter", role: "rifleman", skills: {}, fatigue: 0, stress: 0, wounds: [], load, status: "fit" }] }],
        placements: [{ personId: "lab#0", x: startX, y: 20, heading: 0 }] },
    ],
  };
  const sim = createSim(input);
  const id = [...sim.state.identity.keys()][0]!;
  return { sim, id, input };
}

const LOAD_UNIT_KG = 24; // three "de-basic-load" items of 8 kg

/** Move `distance` metres east and measure; stops early at `maxSeconds`. */
function run(data: DataSet, name: string, mode: string, loadUnits: number, distance: number, map: MapDef, maxSeconds = 1800): MoveRow {
  const { sim, id } = oneSoldier(data, map, loadUnits, 10);
  submitOrder(sim, { tick: 0, issuer: "blue", target: id, kind: "move", waypoints: [{ x: 10 + distance, y: 20, mode }] });
  let hrMax = 0, done = false, ticks = 0;
  const start = sim.state.transform.req(id).x;
  for (; ticks < secondsToTicks(maxSeconds) && !done; ticks++) {
    for (const e of step(sim)) if (e.kind === "unit.arrived") done = true;
    hrMax = Math.max(hrMax, sim.state.soldier.req(id).physical.heartRateBpm);
  }
  const moved = sim.state.transform.req(id).x - start;
  const s = sim.state.soldier.req(id);
  return { case: name, loadKg: loadUnits * LOAD_UNIT_KG, mode, distanceM: Math.round(moved), seconds: ticksToSeconds(ticks), speedMps: moved / ticksToSeconds(ticks), fatigueEnd: s.physical.fatigue, hrMax };
}

export interface FatigueRow { case: string; loadKg: number; seconds: number; fatigue: number; hr: number }

export interface PostureRow { from: Posture; to: Posture; loadKg: number; seconds: number }

export function movementLab(data: DataSet): { moves: MoveRow[]; fatigue: FatigueRow[]; postures: PostureRow[] } {
  const flat = strip(data, {});
  const moves: MoveRow[] = [
    run(data, "flat", "walk", 0, 300, flat),
    run(data, "flat", "walk", 1, 300, flat),
    run(data, "flat", "walk", 2, 300, flat),
    run(data, "flat", "run", 0, 300, flat),
    run(data, "flat", "run", 1, 300, flat),
    run(data, "flat", "sneak", 1, 100, flat),
    run(data, "flat", "crawl", 1, 30, flat),
    run(data, "uphill 10 %", "walk", 1, 300, strip(data, { grade: 0.1 })),
    run(data, "downhill 10 %", "walk", 1, 300, strip(data, { grade: -0.1 })),
    run(data, "uphill 20 %", "walk", 1, 300, strip(data, { grade: 0.2 })),
    run(data, "woodland", "walk", 1, 300, strip(data, { woods: true })),
  ];

  // Fatigue: run loaded for 150 s, then rest 300 s.
  const fatigue: FatigueRow[] = [];
  for (const units of [0, 1]) {
    const { sim, id } = oneSoldier(data, flat, units, 10);
    submitOrder(sim, { tick: 0, issuer: "blue", target: id, kind: "move", waypoints: [{ x: 1590, y: 20, mode: "run" }] });
    const at = (sec: number) => { while (sim.state.tick < secondsToTicks(sec)) step(sim); const s = sim.state.soldier.req(id).physical; return { f: s.fatigue, hr: s.heartRateBpm }; };
    for (const sec of [60, 150]) { const r = at(sec); fatigue.push({ case: `running ${sec} s`, loadKg: units * LOAD_UNIT_KG, seconds: sec, fatigue: r.f, hr: r.hr }); }
    submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: id, kind: "halt" });
    for (const sec of [150 + 60, 150 + 300]) { const r = at(sec); fatigue.push({ case: `resting ${sec - 150} s`, loadKg: units * LOAD_UNIT_KG, seconds: sec, fatigue: r.f, hr: r.hr }); }
  }

  const { sim } = oneSoldier(data, flat, 0, 10);
  const postures: PostureRow[] = [];
  for (const kg of [0, 24, 48]) {
    for (const [from, to] of [["standing", "prone"], ["prone", "standing"], ["standing", "crouching"]] as [Posture, Posture][]) {
      postures.push({ from, to, loadKg: kg, seconds: postureChangeSeconds(sim.ctx, from, to, kg) });
    }
  }
  return { moves, fatigue, postures };
}

export function movementLabMarkdown(r: ReturnType<typeof movementLab>): string {
  const f = (v: number, d = 2) => v.toFixed(d);
  return [
    "### Movement", "", "| case | load kg | mode | metres | seconds | m/s | fatigue at end | max heart rate |", "|---|---:|---|---:|---:|---:|---:|---:|",
    ...r.moves.map((m) => `| ${m.case} | ${m.loadKg} | ${m.mode} | ${m.distanceM} | ${f(m.seconds, 1)} | ${f(m.speedMps)} | ${f(m.fatigueEnd)} | ${f(m.hrMax, 0)} |`),
    "", "### Fatigue (running, then resting)", "", "| phase | load kg | fatigue | heart rate |", "|---|---:|---:|---:|",
    ...r.fatigue.map((x) => `| ${x.case} | ${x.loadKg} | ${f(x.fatigue)} | ${f(x.hr, 0)} |`),
    "", "### Posture changes", "", "| from | to | load kg | seconds |", "|---|---|---:|---:|",
    ...r.postures.map((p) => `| ${p.from} | ${p.to} | ${p.loadKg} | ${f(p.seconds)} |`),
  ].join("\n");
}
