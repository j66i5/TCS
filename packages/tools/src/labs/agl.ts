/**
 * Automatic grenade launcher lab (M7.6d): an AGS-30 team (Russian, crew of 2) and a GMW team on its tripod (German,
 * crew of 3) on a flat, open field, each set up and then ordered to fire at six enemy men east of it (a line across,
 * 3 m apart, standing or ordered prone; everyone holds fire). The order is given again every 20 s (an ordered series
 * is six bursts).
 *   - set-up: seconds from the deploy order to "ready", the whole crew at the post;
 *   - at 400 / 800 / 1200 m: men hit and men down (incapacitated or killed) within 60 s of the first round, rounds
 *     fired in those 60 s and boxes used.
 */
import { allMembers, buildForce } from "@tcs/scenario";
import { createSim, step, submitOrder, type BattleInput, type EntityId, type Sim, type SimEvent } from "@tcs/sim";
import type { DataSet } from "@tcs/data";
import { duel } from "./gunnery";

export type AglTeamFaction = "ru" | "de";
const TEAM_X = 200, TEAM_Y = 600;

/** The team (of `fac`) at (200, 600) facing east, six men of the other side `rangeM` east of it. */
export function aglSetup(data: DataSet, fac: AglTeamFaction, rangeM: number, seed: number): BattleInput {
  const W = rangeM + 600;
  const input = duel(data, ["de", "ru"], { blue: { x: 30, y: 30, heading: 0 }, red: { x: W - 30, y: 1150, heading: Math.PI } }, undefined, W);
  input.seed = seed;
  for (const f of input.forces) for (const rec of f.vehicles ?? []) rec.status = "immobilised";
  input.rules.repair = false; // (M11.7a: the frozen hulls stay as they are: no crew out repairing)
  const own = input.forces[fac === "de" ? 0 : 1]!, enemy = input.forces[fac === "de" ? 1 : 0]!;
  const crewIds = new Set(enemy.units.flatMap((u) => u.subunits).filter((u) => u.vehicleId !== undefined).flatMap((u) => u.members.map((m) => m.personId)));
  let k = 0;
  for (const pl of enemy.placements) {
    if (crewIds.has(pl.personId)) continue;
    if (k < 6) { pl.x = TEAM_X + rangeM; pl.y = TEAM_Y + (k - 2.5) * 3; pl.heading = Math.PI; }
    else { pl.x = W - 20; pl.y = 20 + 3 * k; }
    k++;
  }
  const tpl = data.factions[fac]!.manifest.aglTeamTemplate!;
  const team = buildForce(data, { faction: fac, template: tpl, seed: seed * 7 + 1, keyPrefix: `${fac}-agl`, number: 1 });
  own.units.push(team);
  allMembers(team).forEach((m, i) => own.placements.push({ personId: m.personId, x: TEAM_X, y: TEAM_Y + (i === 0 ? 0 : i % 2 === 1 ? 3 : -3) * Math.ceil(i / 2), heading: 0 }));
  return input;
}

function teamOf(sim: Sim): EntityId {
  return [...sim.state.unit.entries()].find(([, u]) => u.missileTeam?.kind === "agl")![0];
}

export interface AglTrial { setupS: number; hit: number; down: number; rounds: number; boxes: number }

export function aglTrial(data: DataSet, fac: AglTeamFaction, rangeM: number, seed: number, prone: boolean): AglTrial {
  const input = aglSetup(data, fac, rangeM, seed);
  const sim = createSim(input);
  const ownSide = fac === "de" ? "blue" : "red", enemySide = fac === "de" ? "red" : "blue";
  for (const [uid, u] of sim.state.unit.entries()) if (u.parent === null) {
    submitOrder(sim, { tick: sim.state.tick, issuer: u.side, target: uid, kind: "rules", fire: "hold" });
    if (prone && u.side === enemySide) submitOrder(sim, { tick: sim.state.tick, issuer: u.side, target: uid, kind: "posture", posture: "prone" });
  }
  step(sim);
  const tid = teamOf(sim);
  const boxItem = Object.values(input.catalog.items).find((it) => it.crewServed?.kind === "agl" && sim.state.unit.req(tid).members.some((m) => sim.state.container.get(m)?.stacks.some((s) => s.type === it.id)))!.crewServed!.round;
  const boxes = () => sim.state.unit.req(tid).members.reduce((n, m) => n + (sim.state.container.get(m)?.stacks.filter((s) => s.type === boxItem).reduce((a, s) => a + s.count, 0) ?? 0), 0);
  const boxes0 = boxes();
  submitOrder(sim, { tick: sim.state.tick, issuer: ownSide, target: tid, kind: "deploy" });
  const r: AglTrial = { setupS: -1, hit: 0, down: 0, rounds: 0, boxes: 0 };
  const hit = new Set<EntityId>(), down = new Set<EntityId>();
  let setupFrom = sim.state.tick, first = -1;
  const tx = TEAM_X + rangeM, ty = TEAM_Y;
  const on = (e: SimEvent) => {
    if (e.kind === "missileTeam.setup") setupFrom = e.tick;
    if (e.kind === "missileTeam.ready" && r.setupS < 0) r.setupS = (e.tick - setupFrom) / 60;
    if (e.kind === "shot.fired" && e.vehicle === undefined && input.catalog.weapons[e.weapon]?.type === "grenade-machine-gun") { if (first < 0) first = e.tick; if (e.tick - first < 60 * 60) r.rounds++; }
    if (first >= 0 && e.tick - first < 60 * 60) {
      if (e.kind === "wound" && sim.state.identity.get(e.soldier)?.side === enemySide) hit.add(e.soldier);
      if (e.kind === "casualty" && sim.state.identity.get(e.soldier)?.side === enemySide) down.add(e.soldier);
    }
  };
  for (let i = 0; i < 180 * 60 && (first < 0 || sim.state.tick - first < 60 * 60); i++) {
    const mt = sim.state.unit.req(tid).missileTeam!;
    if (mt.state === "ready" && sim.state.tick % (20 * 60) === 0) submitOrder(sim, { tick: sim.state.tick, issuer: ownSide, target: tid, kind: "fire", x: tx, y: ty });
    if (mt.state === "ready" && first < 0 && mt.queued === undefined && !mt.burst && sim.state.tick % 60 === 0) submitOrder(sim, { tick: sim.state.tick, issuer: ownSide, target: tid, kind: "fire", x: tx, y: ty });
    for (const e of step(sim)) on(e);
  }
  r.hit = hit.size; r.down = down.size; r.boxes = boxes0 - boxes();
  return r;
}

export interface AglLabRow { team: AglTeamFaction; weapon: string; rangeM: number; posture: "standing" | "prone"; trials: number; setupS: number; hit: number; down: number; rounds: number; boxes: number }

export function aglLab(data: DataSet, trials = 20): AglLabRow[] {
  const rows: AglLabRow[] = [];
  for (const fac of ["ru", "de"] as const) {
    const tpl = data.factions[fac]!.units[data.factions[fac]!.manifest.aglTeamTemplate!]!;
    const post = tpl.members.flatMap((m) => m.load).map((l) => data.factions[fac]!.items[l.item]).find((it) => it?.crewServed?.kind === "agl")!;
    for (const posture of ["standing", "prone"] as const) for (const rangeM of [400, 800, 1200]) {
      const row: AglLabRow = { team: fac, weapon: post.crewServed!.weapon, rangeM, posture, trials, setupS: 0, hit: 0, down: 0, rounds: 0, boxes: 0 };
      for (let k = 0; k < trials; k++) {
        const t = aglTrial(data, fac, rangeM, 7000 + k, posture === "prone");
        row.setupS += t.setupS / trials; row.hit += t.hit / trials; row.down += t.down / trials; row.rounds += t.rounds / trials; row.boxes += t.boxes / trials;
      }
      rows.push(row);
    }
  }
  return rows;
}

export function aglLabMarkdown(rows: AglLabRow[]): string {
  return [
    "An AGS-30 team (2 men) and a GMW team on its tripod (3 men) on a flat, open field, set up and then ordered to fire at six enemy men east of it (3 m apart, standing or prone; everyone holds fire; the order again every 20 s). Means over the trials; 60 s from the first round. Game values (low): see docs/DECISIONS.md M7.6d.",
    "", "| Team | Weapon | Range | Targets | Trials | Set-up s | Men hit | Men down | Rounds in 60 s | Boxes used |", "|---|---|---:|---|---:|---:|---:|---:|---:|---:|",
    ...rows.map((r) => `| ${r.team} | ${r.weapon} | ${r.rangeM} m | ${r.posture} | ${r.trials} | ${r.setupS.toFixed(1)} | ${r.hit.toFixed(1)} | ${r.down.toFixed(1)} | ${r.rounds.toFixed(0)} | ${r.boxes.toFixed(1)} |`),
  ].join("\n");
}
