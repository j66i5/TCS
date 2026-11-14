/**
 * Missile team lab (M9.3b): a Russian Metis-M team (9P151, 9M131) on a flat, open field, ordered to fire at a German
 * Puma east of it; everyone else holds fire unless a row says otherwise.
 *   - set-up: seconds from the order to "ready" with 3, 2 and 1 men at the post (the others 60 m away);
 *   - hit rate against a halted Puma (side-on) and one crossing (its slow drive, about 6 m/s, and its drive, about
 *     12 m/s; the plan asked for 8 m/s, between the two), at 500 / 1000 / 1500 / 2000 m:
 *     fired, hit, penetrated, mean flight time of the hits, lost (and why);
 *   - the launch noticed by the target's crew (smoke at it), by day and at night (23:00, no moon), with the time
 *     from the launch until its turret is laid toward the post (within 5 deg);
 *   - survival over 60 s after a launch that misses a Puma 800 m away (fired at a point beside it) which fires back
 *     (its crew free to fire): the team stays at its post, or moves 60 m aside as soon as the missile's flight ends.
 */
import { buildForce, allMembers } from "@tcs/scenario";
import { atan2, createSim, environmentAt, isOut, parseTimeOfDay, step, submitOrder, wrapAngle, type BattleInput, type Sim, type SimEvent } from "@tcs/sim";
import type { DataSet } from "@tcs/data";
import { duel } from "./gunnery";

interface Opts { crew?: 1 | 2 | 3; crossing?: boolean; fast?: boolean; night?: boolean; free?: boolean; aspect?: "front" | "side"; faction?: "ru" | "xf" }

/** The team at (200, 600) facing east; the blue Puma `rangeM` east of it; the red hull far away in a corner. */
export function teamSetup(data: DataSet, rangeM: number, seed: number, o: Opts = {}): { input: BattleInput } {
  const fac = o.faction ?? "ru";
  const W = rangeM + 600;
  const tgt = { x: 200 + rangeM, y: o.crossing ? 440 : 600, heading: o.crossing ? Math.PI / 2 : o.aspect === "front" ? Math.PI : Math.PI / 2 };
  const input = duel(data, ["de", fac], { blue: tgt, red: { x: W - 30, y: 1150, heading: Math.PI } }, fac === "xf" ? ["pzgren-schuetzentrupp", "porter-gang"] : undefined, W, fac === "xf" ? ["puma-besatzung", "wagon-crew"] : undefined);
  input.seed = seed;
  if (!o.crossing && !o.free) for (const rec of input.forces[0]!.vehicles ?? []) rec.status = "immobilised";
  const red = input.forces[1]!;
  const tpl = data.factions[fac]!.manifest.missileTeamTemplate!;
  const team = buildForce(data, { faction: fac, template: tpl, seed: seed * 7 + 1, keyPrefix: "red-a", number: 1 });
  red.units.push(team);
  const men = allMembers(team);
  const crew = o.crew ?? men.length;
  // The post's carrier first (he is the gunner), the others beside him (never behind: the danger zone).
  const carrier = men.findIndex((m) => m.load.some((l) => input.catalog.items[l.type]?.crewServed !== undefined));
  const order = [carrier, ...men.map((_, i) => i).filter((i) => i !== carrier)];
  order.forEach((mi, k) => {
    const away = k >= crew;
    red.placements.push({ personId: men[mi]!.personId, x: away ? 140 : 200, y: away ? 600 + k * 3 : 600 + (k === 0 ? 0 : k % 2 === 1 ? 4 : -4) * Math.ceil(k / 2), heading: 0 });
  });
  if (o.night) input.environment = environmentAt(input.catalog, parseTimeOfDay("23:00")!, 0);
  return { input };
}

function rules(sim: Sim, free: boolean): void {
  for (const [uid, u] of sim.state.unit.entries()) if (u.parent === null) submitOrder(sim, { tick: sim.state.tick, issuer: u.side, target: uid, kind: "rules", fire: free && u.side === "blue" ? "free" : "hold" });
  step(sim);
}

export interface TeamTrial {
  setupS: number; fired: boolean; hit: boolean; penetrated: boolean; flightS: number; lost: string | null; warned: boolean; layS: number;
  /** Mean speed of the target over the flight (m/s). */
  speed: number; teamFit: number; pumaFighting: boolean;
}

export function teamTrial(data: DataSet, rangeM: number, seed: number, o: Opts = {}, after?: "stay" | "move"): TeamTrial {
  const { input } = teamSetup(data, rangeM, seed, o);
  const sim = createSim(input);
  rules(sim, o.free === true);
  const tid = [...sim.state.unit.entries()].find(([, u]) => u.missileTeam !== undefined)![0];
  const [pid, pv] = [...sim.state.vehicle.entries()].find(([, v]) => v.side === "blue")!;
  const pt = sim.state.transform.req(pid);
  // The team sets up at once; the order comes once it is ready (20 s). A crossing Puma starts 160 m short of the
  // line of fire 4 s before the order and drives across it.
  submitOrder(sim, { tick: sim.state.tick, issuer: "red", target: tid, kind: "deploy" });
  const start = sim.state.tick + 20 * 60;
  const r: TeamTrial = { setupS: -1, fired: false, hit: false, penetrated: false, flightS: 0, lost: null, warned: false, layS: -1, speed: 0, teamFit: 0, pumaFighting: true };
  let launch = -1, end = -1, ended = -1, x0 = 0, y0 = 0, sx = 0, sy = 0, setupFrom = sim.state.tick;
  const on = (e: SimEvent) => {
    if (e.kind === "missileTeam.setup") setupFrom = e.tick;
    if (e.kind === "missileTeam.ready" && r.setupS < 0) r.setupS = (e.tick - setupFrom) / 60;
    if (e.kind === "shot.fired" && e.vehicle === undefined && input.catalog.ammo[e.ammo]?.guided && launch < 0) { launch = e.tick; r.fired = true; x0 = pt.x; y0 = pt.y; sx = e.x; sy = e.y; end = e.tick + (after ? 60 * 60 : 25 * 60); }
    if (e.kind === "vehicle.hit" && e.vehicle === pid && input.catalog.ammo[e.ammo]?.guided && !r.hit) { r.hit = true; r.flightS = (e.tick - launch) / 60; r.penetrated = e.result === "penetrated"; }
    if (e.kind === "missile.ended" && e.team !== undefined) { ended = e.tick; if (e.result === "lost") r.lost = e.reason ?? "?"; if (launch >= 0 && r.speed === 0) r.speed = Math.hypot(pt.x - x0, pt.y - y0) / Math.max(1e-9, (e.tick - launch) / 60); }
    if (e.kind === "radio" && e.key === "radio.launchWarning") r.warned = true;
  };
  for (let i = 0; i < 90 * 60 && (end < 0 || sim.state.tick < end); i++) {
    if (o.crossing && sim.state.tick === start - 4 * 60) submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: pv.unit!, kind: "move", waypoints: [{ x: pt.x, y: 1150, mode: o.fast ? "drive" : "drive-slow" }] });
    // (Survival rows: at a point 40 m beside the Puma, a miss: the Puma lives to fire back.)
    if (sim.state.tick === start) submitOrder(sim, after ? { tick: sim.state.tick, issuer: "red", target: tid, kind: "fire", x: pt.x, y: pt.y + 40, nature: "at" } : { tick: sim.state.tick, issuer: "red", target: tid, kind: "fire", x: pt.x, y: pt.y, contact: pid, nature: "at" });
    if (after === "move" && ended >= 0 && sim.state.tick === ended + 1) submitOrder(sim, { tick: sim.state.tick, issuer: "red", target: tid, kind: "move", waypoints: [{ x: sx, y: sy + 60, mode: "run" }] });
    for (const e of step(sim)) on(e);
    if (launch >= 0 && r.warned && r.layS < 0) {
      const v = sim.state.vehicle.get(pid), t = sim.state.transform.get(pid);
      if (v && t) { const az = t.heading + v.stations[0]!.azimuth; if (Math.abs(wrapAngle(az - atan2(sy - t.y, sx - t.x))) < (5 * Math.PI) / 180) r.layS = (sim.state.tick - launch) / 60; }
    }
  }
  const u = sim.state.unit.req(tid);
  r.teamFit = u.members.filter((m) => !isOut(sim.state.soldier.req(m))).length;
  const v = sim.state.vehicle.req(pid);
  r.pumaFighting = v.status === "ok" || v.status === "immobilised" ? !v.comp.some((c) => c <= 0) : false;
  return r;
}

export interface TeamLabResult {
  setup: { crew: number; seconds: number }[];
  hits: { target: "halted" | "crossing" | "crossing fast"; rangeM: number; trials: number; fired: number; hits: number; penetrated: number; flightS: number; speed: number; lost: Record<string, number> }[];
  warning: { light: "day" | "night"; rangeM: number; trials: number; fired: number; warned: number; layS: number }[];
  survival: { after: "stay" | "move"; trials: number; teamFit: number; pumaFighting: number }[];
}

export function missileTeamLab(data: DataSet, trials = 50): TeamLabResult {
  const out: TeamLabResult = { setup: [], hits: [], warning: [], survival: [] };
  for (const crew of [3, 2, 1] as const) out.setup.push({ crew, seconds: teamTrial(data, 1000, 1, { crew }).setupS });
  for (const target of ["halted", "crossing", "crossing fast"] as const) for (const rangeM of [500, 1000, 1500, 2000]) {
    const row = { target, rangeM, trials, fired: 0, hits: 0, penetrated: 0, flightS: 0, speed: 0, lost: {} as Record<string, number> };
    for (let k = 0; k < trials; k++) {
      const r = teamTrial(data, rangeM, 3000 + k, { crossing: target !== "halted", fast: target === "crossing fast" });
      if (r.fired) row.fired++;
      if (r.hit) { row.hits++; row.flightS += r.flightS; }
      if (r.penetrated) row.penetrated++;
      if (r.lost) row.lost[r.lost] = (row.lost[r.lost] ?? 0) + 1;
      row.speed += r.speed / trials;
    }
    if (row.hits > 0) row.flightS /= row.hits;
    out.hits.push(row);
  }
  const wt = Math.max(1, Math.round(trials / 5));
  for (const light of ["day", "night"] as const) for (const rangeM of [500, 1000, 1500, 2000]) {
    const row = { light, rangeM, trials: wt, fired: 0, warned: 0, layS: 0 };
    let laid = 0;
    for (let k = 0; k < wt; k++) {
      const r = teamTrial(data, rangeM, 4000 + k, { night: light === "night", aspect: "front" });
      if (r.fired) row.fired++;
      if (r.warned) row.warned++;
      if (r.layS >= 0) { laid++; row.layS += r.layS; }
    }
    row.layS = laid > 0 ? row.layS / laid : -1;
    out.warning.push(row);
  }
  for (const after of ["stay", "move"] as const) {
    const row = { after, trials: wt, teamFit: 0, pumaFighting: 0 };
    for (let k = 0; k < wt; k++) {
      const r = teamTrial(data, 800, 5000 + k, { free: true, aspect: "front" }, after);
      row.teamFit += r.teamFit / wt;
      if (r.pumaFighting) row.pumaFighting++;
    }
    out.survival.push(row);
  }
  return out;
}

export function missileTeamLabMarkdown(r: TeamLabResult): string {
  const pct = (n: number, t: number) => `${Math.round((100 * n) / Math.max(1, t))} %`;
  const out = [
    "A Russian Metis-M team (9P151, 9M131; crew of 3) on a flat, open field, set up and then ordered to fire at a German Puma east of it. Everyone else holds fire unless said otherwise. Game values (low): see docs/DECISIONS.md M9.3b.",
    "", "## Set-up by crew at the post (deploy order to ready)", "", "| Men at the post | Seconds |", "|---:|---:|",
    ...r.setup.map((s) => `| ${s.crew} | ${s.seconds >= 0 ? s.seconds.toFixed(1) : "never"} |`),
    "", "## Hits (Puma side-on, halted or crossing; one missile per trial)", "",
    "| Target | Range | Trials | Fired | Hits | Penetrated | Flight (hits) | Target speed (flight) | Lost by the gunner |", "|---|---:|---:|---:|---:|---:|---:|---:|---|",
    ...r.hits.map((h) => `| ${h.target} | ${h.rangeM} m | ${h.trials} | ${pct(h.fired, h.trials)} | ${pct(h.hits, h.trials)} | ${pct(h.penetrated, h.trials)} | ${h.hits > 0 ? `${h.flightS.toFixed(1)} s` : "-"} | ${h.speed.toFixed(1)} m/s | ${Object.entries(h.lost).map(([k, n]) => `${k.replace("missile.lost.", "")} ${n}`).join(", ") || "-"} |`),
    "", "## Launch noticed by the target's crew (Puma head-on, its crew holding fire)", "",
    "| Light | Range | Trials | Fired | Warned (smoke) | Turret laid on the post after |", "|---|---:|---:|---:|---:|---:|",
    ...r.warning.map((w) => `| ${w.light} | ${w.rangeM} m | ${w.trials} | ${pct(w.fired, w.trials)} | ${pct(w.warned, w.trials)} | ${w.layS >= 0 ? `${w.layS.toFixed(1)} s` : "-"} |`),
    "", "## Survival over 60 s after a launch that misses (Puma head-on at 800 m, free to fire back)", "",
    "| After the shot | Trials | Team men fit (of 3) | Puma still fighting |", "|---|---:|---:|---:|",
    ...r.survival.map((s) => `| ${s.after === "stay" ? "stays at the post" : "moves 60 m aside"} | ${s.trials} | ${s.teamFit.toFixed(2)} | ${pct(s.pumaFighting, s.trials)} |`),
  ];
  return out.join("\n");
}

