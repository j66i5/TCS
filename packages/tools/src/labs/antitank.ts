/**
 * Anti-tank lab (M7.4a): one Panzerfaust 3 or RPG-7 gunner, ordered to fire one round at a halted enemy IFV
 * side-on (and head-on) at 100 / 200 / 300 m (400 m for the Panzerfaust), many trials: how often the round hits,
 * penetrates, and what becomes of the vehicle (immobilised, burning, destroyed, abandoned) within 20 s.
 * Everyone else holds fire; the shooter fires only on the order. Flat 2400 x 1200 m field.
 */
import { createSim, launcherRound, step, submitOrder, type BattleInput, type EntityId, type Sim } from "@tcs/sim";
import type { DataSet } from "@tcs/data";
import { duel } from "./gunnery";

export interface AntitankRow { shooter: string; target: string; aspect: "side" | "front"; rangeM: number; trials: number; hits: number; penetrated: number; knockedOut: number; destroyed: number }

function holdAll(sim: Sim): void {
  for (const [uid, u] of sim.state.unit.entries()) if (u.parent === null) submitOrder(sim, { tick: sim.state.tick, issuer: u.side, target: uid, kind: "rules", fire: "hold", at: "hold" });
  step(sim);
}

/** A duel with the blue anti-tank gunner standing `rangeM` west of the red vehicle (which faces south = side-on, or west = head-on). */
export function antitankSetup(data: DataSet, factions: [string, string], rangeM: number, aspect: "side" | "front", seed: number): { input: BattleInput; gunner: EntityId; target: EntityId } {
  const tx = 1400, ty = 600;
  const input = duel(data, factions, { blue: { x: 60, y: 1100, heading: 0 }, red: { x: tx, y: ty, heading: aspect === "side" ? Math.PI / 2 : Math.PI } });
  input.seed = seed;
  // Find the blue man with a launcher, then stand him at the range, facing the target.
  const probe = createSim(input);
  let gunnerPerson: string | null = null;
  for (const [id, ident] of probe.state.identity.entries()) {
    if (ident.side === "blue" && probe.state.soldier.req(id).mount === undefined && launcherRound(probe.ctx, probe.state, id)) { gunnerPerson = ident.personId; break; }
  }
  if (gunnerPerson === null) throw new Error(`no anti-tank gunner in ${factions[0]}`);
  const pl = input.forces[0]!.placements.find((p) => p.personId === gunnerPerson)!;
  pl.x = tx - rangeM; pl.y = ty; pl.heading = 0;
  const sim = createSim(input);
  const gunner = [...sim.state.identity.entries()].find(([, i]) => i.personId === gunnerPerson)![0];
  const target = [...sim.state.vehicle.entries()].find(([, v]) => v.side === "red")![0];
  return { input, gunner, target };
}

/** One trial: the order, then 20 s. */
export function antitankTrial(data: DataSet, factions: [string, string], rangeM: number, aspect: "side" | "front", seed: number): { hit: boolean; penetrated: boolean; knockedOut: boolean; destroyed: boolean; fired: boolean } {
  const { input, gunner, target } = antitankSetup(data, factions, rangeM, aspect, seed);
  const sim = createSim(input);
  holdAll(sim);
  const t = sim.state.transform.req(target);
  submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: gunner, kind: "fire", x: t.x, y: t.y, contact: target, nature: "at" });
  let hit = false, pen = false, fired = false;
  for (let i = 0; i < 20 * 60; i++) {
    for (const e of step(sim)) {
      if (e.kind === "grenade.launched" && e.soldier === gunner) fired = true;
      if (e.kind === "vehicle.hit" && e.vehicle === target && e.owner === gunner) { hit = true; if (e.result === "penetrated") pen = true; }
    }
  }
  const v = sim.state.vehicle.req(target);
  return { hit, penetrated: pen, knockedOut: v.status !== "ok", destroyed: v.status === "destroyed", fired };
}

export function antitankLab(data: DataSet, trials = 20): AntitankRow[] {
  const rows: AntitankRow[] = [];
  const cases: { factions: [string, string]; shooter: string; target: string; ranges: number[] }[] = [
    { factions: ["de", "ru"], shooter: "Panzerfaust 3", target: "BMP-2", ranges: [100, 200, 300, 400] },
    { factions: ["ru", "de"], shooter: "RPG-7 (PG-7VL)", target: "Puma", ranges: [100, 200, 300] },
  ];
  for (const cs of cases) {
    for (const aspect of ["side", "front"] as const) {
      for (const R of cs.ranges) {
        const row: AntitankRow = { shooter: cs.shooter, target: cs.target, aspect, rangeM: R, trials, hits: 0, penetrated: 0, knockedOut: 0, destroyed: 0 };
        for (let k = 0; k < trials; k++) {
          const r = antitankTrial(data, cs.factions, R, aspect, 1000 + k);
          if (r.hit) row.hits++;
          if (r.penetrated) row.penetrated++;
          if (r.knockedOut) row.knockedOut++;
          if (r.destroyed) row.destroyed++;
        }
        rows.push(row);
      }
    }
  }
  return rows;
}

export function antitankLabMarkdown(rows: AntitankRow[]): string {
  const out = ["One gunner, one round on order, halted target; knocked out = no longer ok (immobilised, gun out, burning/abandoned or destroyed) 20 s later.", "",
    "| Shooter | Target | Aspect | Range | Hits | Penetrated | Knocked out | Destroyed |", "|---|---|---|---:|---:|---:|---:|---:|"];
  const pct = (n: number, t: number) => `${Math.round((100 * n) / t)} %`;
  for (const r of rows) out.push(`| ${r.shooter} | ${r.target} | ${r.aspect} | ${r.rangeM} m | ${pct(r.hits, r.trials)} | ${pct(r.penetrated, r.trials)} | ${pct(r.knockedOut, r.trials)} | ${pct(r.destroyed, r.trials)} |`);
  return out.join("\n");
}
