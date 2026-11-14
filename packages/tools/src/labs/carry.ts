/**
 * CARRY LAB (M10.4a, roadmap-detail slice 8): do carrying parties move at the data's speeds?
 *
 * Every carry method of core/medical.json on four courses: flat open ground (30 m), a 10 % slope uphill (30 m),
 * through a house (in at the door, through the inner door, ground floor) and up its stairs to the room above. The
 * casualty (a German soldier in kit: body and load, so the data's reference mass) lies unconscious with a head wound,
 * or — for the walking methods — is awake with a light arm wound; the carriers stand beside him, the Sanitaeter's
 * folding litter with them for the stretcher. The party is started as the game does (`startCarry`), with the
 * method forced; the speed is the route length over the time spent moving (setting up a litter, rests apart).
 * Expected = the data's speed x the mass factor x the course factor, where the course factor is a lone walker's
 * speed on that course over his speed on flat ground (ground, slope and stairs slow a party as they slow any man).
 * Acceptance: within 10 %. Also: the casualty's greatest distance from the nearest carrier (at most 1.5 m), the
 * litter's set-up time, and over 150 m on flat ground the rests and the mean speed with them.
 */
import { buildCatalog, type DataSet } from "@tcs/data";
import {
  createSim, DEFAULT_COMMS, flatMap, healthyPhysiology, startCarry, EventSink, step, submitOrder,
  type BattleInput, type Building, type Catalog, type EntityId, type MapDef, type Sim, type SoldierRecord, type Wound,
} from "@tcs/sim";

export type CarryCourse = "flat" | "slope" | "house" | "stairs";
export const COURSES: readonly CarryCourse[] = ["flat", "slope", "house", "stairs"];

export interface CarryRow {
  method: string; course: CarryCourse; carriers: number; routeM: number; movingS: number; setupS: number;
  speed: number; expected: number; errPct: number; maxGapM: number; arrived: boolean;
}
export interface EnduranceRow { method: string; distanceM: number; totalS: number; rests: number; meanSpeed: number }

const wound = (extra: Partial<Wound>): Wound => ({
  id: 1, zone: "head", mechanism: "bullet", severity: 0.2, bleedingLps: 0, compressible: false, airway: false, breathing: false,
  consciousness: true, tickInflicted: 0, treatments: [], ...extra,
});

/** The M7.5c test house (12 x 10 m, two storeys, two rooms each floor, stairs in the west room). */
function house(): Building {
  const fp = [100, 80, 112, 80, 112, 90, 100, 90];
  const west = [100, 80, 106, 80, 106, 90, 100, 90], east = [106, 80, 112, 80, 112, 90, 106, 90];
  return {
    id: 1, kind: "house", footprint: fp, storeys: 2, storeyHeightM: 2.8, wallMaterial: "brick", wallThicknessM: 0.3, roofColour: "#8c4a3b",
    openings: [{ wall: 3, offsetM: 3, widthM: 1.0, kind: "door", sillM: 0, headM: 2.1 }],
    interior: {
      rooms: [0, 1].flatMap((fl) => [{ id: fl * 2, floor: fl, poly: west, kind: "hall" as const }, { id: fl * 2 + 1, floor: fl, poly: east, kind: "room" as const }]),
      walls: [0, 1].map((fl) => ({ id: fl, floor: fl, ax: 106, ay: 80, bx: 106, by: 90, thicknessM: 0.12, material: "brick", doors: [{ offsetM: 5, widthM: 0.9, headM: 2 }] })),
      stairs: [{ id: 0, floor: 0, room: 0, x0: 101, y0: 81, x1: 104.5, y1: 81, widthM: 1 }],
    },
  };
}

interface Course { map: MapDef; from: { x: number; y: number }; to: { x: number; y: number; z: number } }
function course(kind: CarryCourse): Course {
  const m = flatMap("carry-lab", 200, 120, 4, "grass");
  if (kind === "slope") for (let r = 0; r <= m.rows; r++) for (let c = 0; c <= m.cols; c++) m.heights[r * (m.cols + 1) + c] = 100 + c * m.cellSizeM * 0.1;
  if (kind === "house" || kind === "stairs") {
    m.buildings = [house()];
    return { map: m, from: { x: 88, y: 87 }, to: { x: 109, y: 85, z: kind === "stairs" ? 2.8 : 0 } };
  }
  return { map: m, from: { x: 40, y: 60 }, to: { x: 70, y: 60, z: 0 } };
}

const DE_LOAD = [
  { type: "de-basic-load", count: 3 }, { type: "de-tourniquet-cat", count: 1 }, { type: "de-pressure-dressing", count: 2 },
];

function setup(data: DataSet, catalog: Catalog, map: MapDef, from: { x: number; y: number }, carriers: number, walks: boolean): { sim: Sim; payload: EntityId; men: EntityId[] } {
  const rec = (id: string, w: Wound[], extra: Partial<SoldierRecord> = {}): SoldierRecord => ({
    personId: id, given: "L", family: id, rank: "gefreiter", role: "grenadier", skills: { medical: 0.2 }, fatigue: 0, stress: 0,
    wounds: w, load: DE_LOAD.map((x) => ({ ...x })), status: w.length > 0 ? "wounded" : "fit", ...extra,
  });
  const cas = walks
    ? rec("cas", [wound({ zone: "armL", severity: 0.05, consciousness: false })])
    : rec("cas", [wound({})], { physiology: { ...healthyPhysiology(), consciousness: 0 } });
  const members = [cas];
  for (let i = 0; i < carriers; i++) members.push(rec(`c${i}`, [], i === 0 ? { load: [...DE_LOAD.map((x) => ({ ...x })), { type: "de-litter", count: 1 }] } : {}));
  const input: BattleInput = {
    map, catalog, seed: 3, orders: [],
    rules: {
      timeLimitSeconds: 36000, commsModel: "simple", comms: { ...DEFAULT_COMMS, orderDelaySeconds: 0, orderDelayJitterSeconds: 0 },
      physiologyModel: "none", physiologyParams: {}, objectives: [], medicalCare: false,
    },
    forces: [{
      side: "blue", faction: "de",
      units: [{ key: "lab", callsign: "Lab", echelon: "team" as const, leaderIndex: members.length > 1 ? 1 : 0, subunits: [], members }],
      placements: members.map((m, i) => ({ personId: m.personId, x: from.x - (i === 0 ? 0 : 1 + 0.3 * i), y: from.y + (i % 2 === 0 ? 0.4 : -0.4) * (i === 0 ? 0 : 1), heading: 0 })),
    }],
  };
  void data;
  const sim = createSim(input);
  const id = (p: string): EntityId => [...sim.state.identity.entries()].find(([, i]) => i.personId === p)![0];
  return { sim, payload: id("cas"), men: Array.from({ length: carriers }, (_, i) => id(`c${i}`)) };
}

/** A lone walker's speed (m/s) over the course (the course factor's measure). */
function walkerSpeed(data: DataSet, catalog: Catalog, kind: CarryCourse): number {
  const c = course(kind);
  const { sim, men } = setup(data, catalog, c.map, c.from, 1, true);
  const w = men[0]!;
  // (No load: his pace, not his kit.)
  sim.state.container.req(w).stacks = [];
  submitOrder(sim, { tick: 0, issuer: "blue", target: w, kind: "move", waypoints: [{ x: c.to.x, y: c.to.y, mode: "walk" }], ...(c.to.z > 0 ? { floor: 1 } : {}) });
  let moving = 0, dist = 0;
  const t = sim.state.transform.req(w);
  let px = t.x, py = t.y, pz = t.z;
  for (let k = 0; k < 600 * 60; k++) {
    step(sim);
    const m = sim.state.mover.req(w);
    const d = Math.hypot(t.x - px, t.y - py) + Math.abs(t.z - pz);
    if (d > 0) { moving++; dist += d; }
    px = t.x; py = t.y; pz = t.z;
    if (k > 120 && m.waypoints.length === 0) break;
  }
  return dist / (moving / 60);
}

/** One carry over a course; null if the method cannot start. */
export function carryRun(data: DataSet, catalog: Catalog, method: string, kind: CarryCourse, distanceOverride?: number): (CarryRow & { rests: number; totalS: number }) | null {
  const def = catalog.medical!.carry[method]!;
  const c = course(kind);
  const to = distanceOverride !== undefined ? { x: c.from.x + distanceOverride, y: c.from.y, z: 0 } : c.to;
  const { sim, payload, men } = setup(data, catalog, c.map, c.from, def.carriers, def.casualtyWalks === true);
  const events = new EventSink();
  const party = startCarry(sim.ctx, sim.state, events, payload, men, to, { method });
  if (!party) return null;
  const st = sim.state;
  let moving = 0, setup0 = -1, maxGap = 0, arrived = false, routeM = 0, ticks = 0;
  const all = [...events.events];
  const lead = men[0] ?? payload, lt = st.transform.req(lead);
  for (; ticks < 1200 * 60; ticks++) {
    const p = st.carry.get(payload);
    const moves = p !== undefined && (p.phase === "move" || p.phase === "cover");
    if (moves) { moving++; if (setup0 < 0) setup0 = ticks; }
    const x0 = lt.x, y0 = lt.y, z0 = lt.z;
    const ev = step(sim);
    if (moves) routeM += Math.hypot(lt.x - x0, lt.y - y0, lt.z - z0);
    all.push(...ev);
    if (def.carriers > 0 && st.carry.has(payload)) {
      const pt = st.transform.req(payload);
      let near = Infinity;
      for (const m of men) { const t = st.transform.req(m); near = Math.min(near, Math.hypot(t.x - pt.x, t.y - pt.y, t.z - pt.z)); }
      if (st.carry.get(payload)!.phase !== "gather") maxGap = Math.max(maxGap, near);
    }
    const done = ev.find((e) => e.kind === "medical.carried" && e.phase === "done");
    if (done && done.kind === "medical.carried") { arrived = done.reason === "arrived"; break; }
  }
  const rests = all.filter((e) => e.kind === "medical.carried" && e.phase === "rest").length;
  const movingS = moving / 60;
  const speed = movingS > 0 ? routeM / movingS : 0;
  return {
    method, course: kind, carriers: def.carriers, routeM, movingS, setupS: Math.max(0, setup0) / 60, speed,
    // (A walking wounded man walks at his own pace: his wounds' factor.)
    expected: party.speedMps * (def.carriers === 0 ? st.soldier.req(payload).impair.move : 1), errPct: 0,
    maxGapM: maxGap, arrived, rests, totalS: ticks / 60,
  };
}

export function carryLab(data: DataSet): { rows: CarryRow[]; endurance: EnduranceRow[] } {
  const catalog = buildCatalog(data, ["de"]);
  const methods = Object.keys(catalog.medical!.carry).sort();
  const flatWalker = walkerSpeed(data, catalog, "flat");
  const factor: Record<CarryCourse, number> = { flat: 1, slope: 1, house: 1, stairs: 1 };
  for (const k of COURSES) factor[k] = walkerSpeed(data, catalog, k) / flatWalker;
  const rows: CarryRow[] = [];
  for (const m of methods) {
    for (const k of COURSES) {
      const r = carryRun(data, catalog, m, k);
      if (!r) continue;
      r.expected *= factor[k];
      r.errPct = r.expected > 0 ? (100 * (r.speed - r.expected)) / r.expected : 0;
      rows.push(r);
    }
  }
  const endurance: EnduranceRow[] = [];
  for (const m of methods) {
    const r = carryRun(data, catalog, m, "flat", 150);
    if (r) endurance.push({ method: m, distanceM: r.routeM, totalS: r.totalS - r.setupS, rests: r.rests, meanSpeed: r.routeM / Math.max(1e-9, r.totalS - r.setupS) });
  }
  return { rows, endurance };
}

export function carryLabMarkdown(lab: { rows: CarryRow[]; endurance: EnduranceRow[] }): string {
  const out = [
    "Every carry method on four courses (30 m flat, 30 m up a 10 % slope, into a house through two doors, up its stairs). Speed = route metres / seconds moving; expected = data speed x mass factor x the course factor (a lone walker's speed there over his speed on flat ground). Acceptance: within 10 %; the casualty never more than 1.5 m from a carrier.", "",
    "| method | carriers | course | route (m) | moving (s) | speed (m/s) | expected (m/s) | error | casualty to carrier, max (m) | litter set-up (s) | arrived |",
    "|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---|",
  ];
  for (const r of lab.rows) {
    out.push(`| ${r.method} | ${r.carriers} | ${r.course} | ${r.routeM.toFixed(1)} | ${r.movingS.toFixed(1)} | ${r.speed.toFixed(2)} | ${r.expected.toFixed(2)} | ${r.errPct >= 0 ? "+" : ""}${r.errPct.toFixed(1)} % | ${r.carriers > 0 ? r.maxGapM.toFixed(2) : "–"} | ${r.setupS.toFixed(0)} | ${r.arrived ? "yes" : "NO"} |`);
  }
  out.push("", "Endurance: 150 m on flat ground, rests included (the data's `enduranceM` and `restS`).", "",
    "| method | route (m) | time (s) | rests | mean speed (m/s) |", "|---|---:|---:|---:|---:|");
  for (const e of lab.endurance) out.push(`| ${e.method} | ${e.distanceM.toFixed(0)} | ${e.totalS.toFixed(0)} | ${e.rests} | ${e.meanSpeed.toFixed(2)} |`);
  return out.join("\n");
}
