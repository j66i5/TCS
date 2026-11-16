/**
 * ENGAGE LAB (sight realism, 2026-11-15; DECISIONS "Sight realism: baseline"): does a man shoot at an enemy who is
 * right in front of him? One regular German rifleman (G36), one Russian rifleman standing or lying still in the open
 * straight ahead at 30, 60 or 100 m (his own rule: hold fire, so he never shoots first). The observer's situation:
 * halted under rule return, free or hold; walking toward the enemy or across his front under rule free; or forced
 * pinned under rule free. Each case 12 seeds (1-12) of up to 60 s; the time is to the observer's first shot.
 * Ported from the audit's scratch script no-engage/engage.ts.
 */
import { buildCatalog, type DataSet } from "@tcs/data";
import { createSim, DEFAULT_COMMS, flatMap, step, submitOrder, type BattleInput, type Catalog, type SoldierRecord } from "@tcs/sim";

export type EngageSituation = "rule return" | "rule free" | "rule hold" | "walking toward (free)" | "walking across (free)" | "pinned (free)";
export const ENGAGE_SITUATIONS: EngageSituation[] = ["rule return", "rule free", "rule hold", "walking toward (free)", "walking across (free)", "pinned (free)"];
export const ENGAGE_RANGES = [30, 60, 100];
export const ENGAGE_POSTURES = ["standing", "prone"] as const;

export interface EngageRow {
  situation: EngageSituation; posture: "standing" | "prone"; rangeM: number; runs: number;
  /** Times to the first shot (s), sorted, for the runs that fired within the case's time. */
  times: number[];
  /** Runs where the enemy was never even spotted. */
  neverSeen: number;
}

function man(id: string, w: string, mag: string, c: Catalog): SoldierRecord {
  return { personId: id, given: "Lab", family: id, rank: "r", role: "rifleman", skills: { marksmanship: 0.5 }, weapon: w, fatigue: 0, stress: 0, wounds: [], status: "fit", load: [{ type: mag, count: 4, charge: c.items[mag]?.chargeCapacity ?? 30 }] };
}

/** One run: the observer's first shot in s, or -1 (seen, never fired) or -2 (never seen). */
export function engageRun(cat: Catalog, sit: EngageSituation, rangeM: number, posture: "standing" | "prone", seed: number, maxSeconds = 60): number {
  const map = flatMap("e", rangeM + 100, 200, 4);
  const ox = 20, ty = 100, tx = 20 + rangeM;
  const input: BattleInput = {
    map, catalog: cat, seed, orders: [],
    rules: { timeLimitSeconds: maxSeconds + 5, commsModel: "simple", comms: { ...DEFAULT_COMMS, orderDelaySeconds: 0, orderDelayJitterSeconds: 0 }, physiologyModel: "none", physiologyParams: {}, objectives: [] },
    forces: [
      { side: "blue", faction: "de", units: [{ key: "o", callsign: "O", echelon: "team", leaderIndex: 0, subunits: [], members: [man("obs", "de-g36", "de-g36-mag", cat)] }], placements: [{ personId: "obs", x: ox, y: ty, heading: 0 }] },
      { side: "red", faction: "ru", units: [{ key: "t", callsign: "T", echelon: "team", leaderIndex: 0, subunits: [], members: [man("tgt", "ru-ak74m", "ru-ak74-mag", cat)] }], placements: [{ personId: "tgt", x: tx, y: ty, heading: Math.PI }] },
    ],
  };
  const sim = createSim(input);
  const ids = [...sim.state.identity.entries()];
  const oid = ids.find(([, i]) => i.side === "blue")![0], tid = ids.find(([, i]) => i.side === "red")![0];
  sim.state.soldier.req(tid).posture = posture;
  const ou = sim.state.identity.req(oid).unit;
  submitOrder(sim, { tick: 0, issuer: "red", target: sim.state.identity.req(tid).unit, kind: "rules", fire: "hold" });
  if (sit === "rule hold") submitOrder(sim, { tick: 0, issuer: "blue", target: ou, kind: "rules", fire: "hold" });
  // Rule return is the data's default (`behaviour.decisions.defaultFireRule`): no order, as in the audit.
  else if (sit !== "rule return") submitOrder(sim, { tick: 0, issuer: "blue", target: ou, kind: "rules", fire: "free" });
  if (sit === "walking toward (free)") submitOrder(sim, { tick: 0, issuer: "blue", target: oid, kind: "move", waypoints: [{ x: tx - 5, y: ty, mode: "walk" }] });
  if (sit === "walking across (free)") submitOrder(sim, { tick: 0, issuer: "blue", target: oid, kind: "move", waypoints: [{ x: ox, y: 195, mode: "walk" }] });
  let seen = false;
  for (let k = 0; k < maxSeconds * 60; k++) {
    if (sit === "pinned (free)") { const m = sim.state.soldier.req(oid).mental; m.behaviour = "pinned"; m.suppression = Math.max(m.suppression, 0.6); }
    for (const e of step(sim)) {
      if (e.kind === "spotted" && e.target === tid) seen = true;
      if (e.kind === "shot.fired" && e.shooter === oid) return e.tick / 60;
    }
  }
  return seen ? -1 : -2;
}

export function engageLab(data: DataSet, seeds = 12, maxSeconds = 60): EngageRow[] {
  const cat = buildCatalog(data, ["de", "ru"]);
  const rows: EngageRow[] = [];
  for (const situation of ENGAGE_SITUATIONS) for (const posture of ENGAGE_POSTURES) for (const rangeM of ENGAGE_RANGES) {
    const times: number[] = [];
    let neverSeen = 0;
    for (let s = 1; s <= seeds; s++) {
      const x = engageRun(cat, situation, rangeM, posture, s, maxSeconds);
      if (x >= 0) times.push(x); else if (x === -2) neverSeen++;
    }
    times.sort((a, b) => a - b);
    rows.push({ situation, posture, rangeM, runs: seeds, times, neverSeen });
  }
  return rows;
}

/** Median time to the first shot of the runs that fired (as the audit counted it); null: none fired. */
export function engageMedian(times: readonly number[]): number | null {
  return times.length > 0 ? times[Math.floor(times.length / 2)]! : null;
}

export function engageLabMarkdown(rows: EngageRow[]): string {
  const within = (r: { times: number[] }, s: number) => r.times.filter((t) => t <= s).length;
  const out = [
    "One G36 rifleman against one enemy still in the open straight ahead (the enemy holds fire); 12 seeds, up to 60 s each. Time to the rifleman's first shot.",
    "",
    "### By situation (both postures, 30, 60 and 100 m together)",
    "",
    "| situation | fired within 10 s | within 15 s | within 60 s | median s of those that fired | never spotted |",
    "|---|---:|---:|---:|---:|---:|",
  ];
  for (const situation of ENGAGE_SITUATIONS) {
    const rs = rows.filter((r) => r.situation === situation);
    const times = rs.flatMap((r) => r.times).sort((a, b) => a - b), runs = rs.reduce((a, r) => a + r.runs, 0);
    const m = engageMedian(times);
    out.push(`| ${situation} | ${within({ times }, 10)}/${runs} | ${within({ times }, 15)}/${runs} | ${times.length}/${runs} | ${m === null ? "–" : m.toFixed(1)} | ${rs.reduce((a, r) => a + r.neverSeen, 0)} |`);
  }
  out.push("", "### Each case", "", "| situation | enemy | range m | fired within 10 s | within 15 s | within 60 s | median s of those that fired |", "|---|---|---:|---:|---:|---:|---:|");
  for (const r of rows) {
    const m = engageMedian(r.times);
    out.push(`| ${r.situation} | ${r.posture} | ${r.rangeM} | ${within(r, 10)}/${r.runs} | ${within(r, 15)}/${r.runs} | ${r.times.length}/${r.runs} | ${m === null ? "–" : m.toFixed(1)} |`);
  }
  return out.join("\n");
}
