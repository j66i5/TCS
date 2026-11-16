/**
 * Missile lab (owner 2026-11-13; M9.3a: one block per guidance kind): a BMP-2 ordered to fire its 9M113M at a halted Puma ("Anti-tank"), head-on and
 * side-on, at 1000 / 2000 / 3000 m on a flat, open field; everyone else holds fire, the target cannot move. Per
 * trial: was the missile fired, did it strike the Puma, get through, was the Puma knocked out (no longer ok) 20 s
 * after the launch; mean flight time of the hits. Also one row with a smoke screen fired by the target 3 s
 * after the launch, ordered at the launch (the gunner loses sight: the missile must miss).
 */
import { createSim, step, submitOrder, type BattleInput, type EntityId, type Sim } from "@tcs/sim";
import type { DataSet } from "@tcs/data";
import { duel } from "./gunnery";

export type MissileKind = "wire" | "f&f" | "beam" | "refleks";
/** The three guidance kinds (M9.3a): the BMP-2's Konkurs (wire, at a Puma), the Puma's MELLS Spike LR (fire-and-
 *  forget top attack, at a BMP-2), the xf wagon's dart (beam riding, at a Puma; fixture data). */
const KINDS: Record<MissileKind, { factions: [string, string]; shooter: "blue" | "red"; crews?: [string, string]; squads?: [string, string]; label: string }> = {
  "wire": { factions: ["de", "ru"], shooter: "red", label: "BMP-2 9M113M Konkurs-M (command by wire) at a Puma" },
  "f&f": { factions: ["de", "ru"], shooter: "blue", label: "Puma MELLS Spike LR (fire-and-forget, top attack) at a BMP-2" },
  "beam": { factions: ["de", "xf"], shooter: "red", crews: ["puma-besatzung", "wagon-crew"], squads: ["pzgren-schuetzentrupp", "porter-gang"], label: "xf wagon dart (beam riding, fixture) at a Puma" },
  "refleks": { factions: ["de", "ru"], shooter: "red", crews: ["leopard2a7v-besatzung", "t90m-ekipazh"], label: "T-90M 9M119M Refleks-M (beam riding, through the gun; M7.6a) at a Leopard 2A7V" },
};

export interface MissileRow { kind: MissileKind; aspect: "front" | "side"; rangeM: number; smoke: boolean; trials: number; fired: number; hits: number; penetrated: number; knockedOut: number; lost: number; warned: number; flightS: number }

function holdAll(sim: Sim): void {
  for (const [uid, u] of sim.state.unit.entries()) if (u.parent === null) submitOrder(sim, { tick: sim.state.tick, issuer: u.side, target: uid, kind: "rules", fire: "hold", at: "hold" });
  step(sim);
}

/** The shooter in the west facing east; the target `rangeM` east of it, head-on (facing west) or side-on (facing
 *  south), immobilised. Default: the BMP-2 at a Puma. */
export function missileSetup(data: DataSet, rangeM: number, aspect: "front" | "side", seed: number, kind: MissileKind = "wire"): { input: BattleInput; shooter: EntityId; target: EntityId } {
  const K = KINDS[kind];
  const W = rangeM + 400;
  const tgt = { x: 200 + rangeM, y: 600, heading: aspect === "side" ? Math.PI / 2 : Math.PI }, sh = { x: 200, y: 600, heading: 0 };
  const input = duel(data, K.factions, K.shooter === "red" ? { blue: tgt, red: sh } : { blue: sh, red: tgt }, K.squads, W, K.crews);
  input.seed = seed;
  const ti = K.shooter === "red" ? 0 : 1;
  for (const rec of input.forces[ti]!.vehicles ?? []) rec.status = "immobilised"; // the target stays where it is
  input.rules.repair = false; // (M11.7a: and is not repaired)
  const sim = createSim(input);
  const shooter = [...sim.state.vehicle.entries()].find(([, v]) => v.side === K.shooter)![0];
  const target = [...sim.state.vehicle.entries()].find(([, v]) => v.side !== K.shooter)![0];
  return { input, shooter, target };
}

export function missileTrial(data: DataSet, rangeM: number, aspect: "front" | "side", seed: number, smoke = false, kind: MissileKind = "wire"): { fired: boolean; hit: boolean; penetrated: boolean; knockedOut: boolean; lost: boolean; warned: boolean; flightS: number } {
  const { input, shooter, target } = missileSetup(data, rangeM, aspect, seed, kind);
  const sim = createSim(input);
  holdAll(sim);
  const sv = sim.state.vehicle.req(shooter);
  const crew = sv.unit!;
  const t = sim.state.transform.req(target);
  submitOrder(sim, { tick: sim.state.tick, issuer: sv.side, target: crew, kind: "fire", x: t.x, y: t.y, contact: target, nature: "at" });
  let fired = -1, ammo = "", hit = false, pen = false, lost = false, warned = false, flight = 0, end = -1;
  for (let i = 0; i < 60 * 60 && (end < 0 || sim.state.tick < end); i++) {
    for (const e of step(sim)) {
      if (e.kind === "shot.fired" && e.vehicle === shooter && fired < 0 && input.catalog.ammo[e.ammo]?.guided) { fired = e.tick; ammo = e.ammo; end = e.tick + 40 * 60; }
      if (e.kind === "vehicle.hit" && e.vehicle === target && e.ammo === ammo && !hit) { hit = true; flight = (e.tick - fired) / 60; if (e.result === "penetrated") pen = true; }
      if (e.kind === "missile.ended" && e.result === "lost") lost = true;
      if (e.kind === "radio" && e.key === "radio.launchWarning") warned = true;
    }
    // (The order to the target's crew, given at the launch, arrives about when the missile is 3 s out.)
    if (smoke && fired >= 0 && sim.state.tick === fired + 1) submitOrder(sim, { tick: sim.state.tick, issuer: sim.state.vehicle.req(target).side, target: sim.state.vehicle.req(target).unit!, kind: "discharge" });
  }
  const v = sim.state.vehicle.req(target);
  return { fired: fired >= 0, hit, penetrated: pen, knockedOut: v.status !== "immobilised" && v.status !== "ok" || v.comp.some((c) => c <= 0), lost, warned, flightS: flight };
}

export function missileLab(data: DataSet, trials = 20): MissileRow[] {
  const rows: MissileRow[] = [];
  const cases: { kind: MissileKind; aspect: "front" | "side"; rangeM: number; smoke: boolean }[] = [];
  for (const aspect of ["front", "side"] as const) for (const rangeM of [1000, 2000, 3000]) cases.push({ kind: "wire", aspect, rangeM, smoke: false });
  cases.push({ kind: "wire", aspect: "front", rangeM: 3000, smoke: true });
  for (const rangeM of [1000, 2000, 3500]) cases.push({ kind: "f&f", aspect: "front", rangeM, smoke: false });
  cases.push({ kind: "f&f", aspect: "side", rangeM: 2000, smoke: false });
  cases.push({ kind: "f&f", aspect: "front", rangeM: 3500, smoke: true });
  for (const rangeM of [1000, 2500]) cases.push({ kind: "beam", aspect: "side", rangeM, smoke: false });
  cases.push({ kind: "beam", aspect: "front", rangeM: 2500, smoke: true });
  // (3500 m, not the plan's 4000: a map is at most 4000 m across, MAX_MAP_SIZE_M.)
  for (const rangeM of [2000, 3500]) cases.push({ kind: "refleks", aspect: "side", rangeM, smoke: false });
  cases.push({ kind: "refleks", aspect: "front", rangeM: 2000, smoke: false });
  for (const c of cases) {
    const row: MissileRow = { ...c, trials, fired: 0, hits: 0, penetrated: 0, knockedOut: 0, lost: 0, warned: 0, flightS: 0 };
    for (let k = 0; k < trials; k++) {
      const r = missileTrial(data, c.rangeM, c.aspect, 2000 + k, c.smoke, c.kind);
      if (r.fired) row.fired++;
      if (r.hit) { row.hits++; row.flightS += r.flightS; }
      if (r.penetrated) row.penetrated++;
      if (r.knockedOut) row.knockedOut++;
      if (r.lost) row.lost++;
      if (r.warned) row.warned++;
    }
    if (row.hits > 0) row.flightS /= row.hits;
    rows.push(row);
  }
  return rows;
}

export function missileLabMarkdown(rows: MissileRow[]): string {
  const out = ["One missile on order at a halted target on a flat open field, regular crews; knocked out = burning, destroyed, abandoned, or a component wrecked, 40 s after the launch. Warned: the target's crew noticed the launch and fired its smoke (M9.3a). Smoke: the target's crew is also ordered to fire its dischargers at the launch.", ""];
  for (const k of Object.keys(KINDS) as MissileKind[]) out.push(`- ${k}: ${KINDS[k].label}`);
  out.push("", "| Kind | Aspect | Range | Smoke | Fired | Hits | Penetrated | Knocked out | Lost by the gunner | Warned | Flight time (hits) |", "|---|---|---:|---|---:|---:|---:|---:|---:|---:|---:|");
  const pct = (n: number, t: number) => `${Math.round((100 * n) / t)} %`;
  for (const r of rows) out.push(`| ${r.kind} | ${r.aspect} | ${r.rangeM} m | ${r.smoke ? "yes" : "-"} | ${pct(r.fired, r.trials)} | ${pct(r.hits, r.trials)} | ${pct(r.penetrated, r.trials)} | ${pct(r.knockedOut, r.trials)} | ${pct(r.lost, r.trials)} | ${pct(r.warned, r.trials)} | ${r.hits > 0 ? `${r.flightS.toFixed(1)} s` : "-"} |`);
  return out.join("\n");
}
