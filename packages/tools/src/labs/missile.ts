/**
 * Missile lab (owner 2026-11-13): a BMP-2 ordered to fire its 9M113M at a halted Puma ("Anti-tank"), head-on and
 * side-on, at 1000 / 2000 / 3000 m on a flat, open field; everyone else holds fire, the target cannot move. Per
 * trial: was the missile fired, did it strike the Puma, get through, was the Puma knocked out (no longer ok) 20 s
 * after the launch; mean flight time of the hits. Also one row with a smoke screen fired by the target 3 s
 * after the launch, ordered at the launch (the gunner loses sight: the missile must miss).
 */
import { createSim, step, submitOrder, type BattleInput, type EntityId, type Sim } from "@tcs/sim";
import type { DataSet } from "@tcs/data";
import { duel } from "./gunnery";

export interface MissileRow { aspect: "front" | "side"; rangeM: number; smoke: boolean; trials: number; fired: number; hits: number; penetrated: number; knockedOut: number; lost: number; flightS: number }

function holdAll(sim: Sim): void {
  for (const [uid, u] of sim.state.unit.entries()) if (u.parent === null) submitOrder(sim, { tick: sim.state.tick, issuer: u.side, target: uid, kind: "rules", fire: "hold", at: "hold" });
  step(sim);
}

/** Red BMP-2 in the west facing east; blue Puma `rangeM` east of it, head-on (facing west) or side-on (facing south), immobilised. */
export function missileSetup(data: DataSet, rangeM: number, aspect: "front" | "side", seed: number): { input: BattleInput; shooter: EntityId; target: EntityId } {
  const W = rangeM + 400;
  const input = duel(data, ["de", "ru"], { blue: { x: 200 + rangeM, y: 600, heading: aspect === "side" ? Math.PI / 2 : Math.PI }, red: { x: 200, y: 600, heading: 0 } }, undefined, W);
  input.seed = seed;
  for (const rec of input.forces[0]!.vehicles ?? []) rec.status = "immobilised"; // the target stays where it is
  const sim = createSim(input);
  const shooter = [...sim.state.vehicle.entries()].find(([, v]) => v.side === "red")![0];
  const target = [...sim.state.vehicle.entries()].find(([, v]) => v.side === "blue")![0];
  return { input, shooter, target };
}

export function missileTrial(data: DataSet, rangeM: number, aspect: "front" | "side", seed: number, smoke = false): { fired: boolean; hit: boolean; penetrated: boolean; knockedOut: boolean; lost: boolean; flightS: number } {
  const { input, shooter, target } = missileSetup(data, rangeM, aspect, seed);
  const sim = createSim(input);
  holdAll(sim);
  const crew = sim.state.vehicle.req(shooter).unit!;
  const t = sim.state.transform.req(target);
  submitOrder(sim, { tick: sim.state.tick, issuer: "red", target: crew, kind: "fire", x: t.x, y: t.y, contact: target, nature: "at" });
  let fired = -1, hit = false, pen = false, lost = false, flight = 0, end = -1;
  for (let i = 0; i < 60 * 60 && (end < 0 || sim.state.tick < end); i++) {
    for (const e of step(sim)) {
      if (e.kind === "shot.fired" && e.vehicle === shooter && fired < 0) { fired = e.tick; end = e.tick + 40 * 60; }
      if (e.kind === "vehicle.hit" && e.vehicle === target && e.ammo === "ru-9m113m") { hit = true; flight = (e.tick - fired) / 60; if (e.result === "penetrated") pen = true; }
      if (e.kind === "missile.ended" && e.result === "lost") lost = true;
    }
    // (The order to the Puma's crew, given at the launch, arrives about when the missile is 3 s out.)
    if (smoke && fired >= 0 && sim.state.tick === fired + 1) submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: sim.state.vehicle.req(target).unit!, kind: "discharge" });
  }
  const v = sim.state.vehicle.req(target);
  return { fired: fired >= 0, hit, penetrated: pen, knockedOut: v.status !== "immobilised" && v.status !== "ok" || v.comp.some((c) => c <= 0), lost, flightS: flight };
}

export function missileLab(data: DataSet, trials = 20): MissileRow[] {
  const rows: MissileRow[] = [];
  const cases: { aspect: "front" | "side"; rangeM: number; smoke: boolean }[] = [];
  for (const aspect of ["front", "side"] as const) for (const rangeM of [1000, 2000, 3000]) cases.push({ aspect, rangeM, smoke: false });
  cases.push({ aspect: "front", rangeM: 3000, smoke: true });
  for (const c of cases) {
    const row: MissileRow = { ...c, trials, fired: 0, hits: 0, penetrated: 0, knockedOut: 0, lost: 0, flightS: 0 };
    for (let k = 0; k < trials; k++) {
      const r = missileTrial(data, c.rangeM, c.aspect, 2000 + k, c.smoke);
      if (r.fired) row.fired++;
      if (r.hit) { row.hits++; row.flightS += r.flightS; }
      if (r.penetrated) row.penetrated++;
      if (r.knockedOut) row.knockedOut++;
      if (r.lost) row.lost++;
    }
    if (row.hits > 0) row.flightS /= row.hits;
    rows.push(row);
  }
  return rows;
}

export function missileLabMarkdown(rows: MissileRow[]): string {
  const out = ["BMP-2 (9M113M Konkurs-M, regular gunner) at a halted Puma on a flat open field, one missile on order; knocked out = burning, destroyed, abandoned, or a component wrecked, 40 s after the launch. Smoke: the Puma's crew is ordered to fire its dischargers at the launch.", "",
    "| Aspect | Range | Smoke | Fired | Hits | Penetrated | Knocked out | Lost by the gunner | Flight time (hits) |", "|---|---:|---|---:|---:|---:|---:|---:|---:|"];
  const pct = (n: number, t: number) => `${Math.round((100 * n) / t)} %`;
  for (const r of rows) out.push(`| ${r.aspect} | ${r.rangeM} m | ${r.smoke ? "yes" : "-"} | ${pct(r.fired, r.trials)} | ${pct(r.hits, r.trials)} | ${pct(r.penetrated, r.trials)} | ${pct(r.knockedOut, r.trials)} | ${pct(r.lost, r.trials)} | ${r.hits > 0 ? `${r.flightS.toFixed(1)} s` : "-"} |`);
  return out.join("\n");
}
