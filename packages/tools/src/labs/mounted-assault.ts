/**
 * Mounted-assault lab (balance pass 5, owner 2026-11-20): the mounted platoon battles with the attacker's platoons
 * given the player's Assault on the main objective while they still ride (mode "player"; the defender's commander as
 * usual), and the same battles AI against AI (mode "ai": the commander's own ride, dismount and support posts).
 * Per battle: where each carrier let its squads out (distance to the objective), how many got out early, men hit
 * while aboard, the support posts (distance to the objective; how far the hull fell back after the dismount), rounds
 * the hulls fired from them, hits by the attacker's hulls on its own men (must be 0), and whether the objective fell.
 */
import { commanderController } from "@tcs/ai";
import { createSim, hypot2, step, submitOrder, type BattleInput, type Controller, type EntityId, type SimEvent } from "@tcs/sim";
import { getScenario } from "../scenarios";
import type { DataSet } from "@tcs/data";
type LoadedData = DataSet;

export interface MountedAssaultRow {
  scenario: string; mode: "player" | "ai"; seed: number; attacker: string; doctrineM: number;
  carriers: number; dismountM: number[]; early: number; hitAboard: number; posts: number; postM: number[]; fellBackM: number[];
  rounds: number; ownHits: number; taken: boolean; takenS: number | null;
}

/** The scenario's attacking side: the one not holding the main objective's ground at the start (its defender stands
 *  nearer the objective). */
function attackerOf(input: BattleInput): string {
  const obj = input.rules.objectives[0]!;
  let best = "", bestD = -1;
  for (const f of input.forces) {
    const ps = f.vehiclePlacements ?? [];
    const d = ps.length > 0 ? ps.reduce((s, p) => s + hypot2(p.x - obj.x, p.y - obj.y), 0) / ps.length : 0;
    if (d > bestD) { bestD = d; best = f.side; }
  }
  return best;
}

export function mountedAssaultBattle(data: LoadedData, scenario: string, mode: "player" | "ai", seed: number, seconds: number): MountedAssaultRow {
  const input = getScenario(scenario).build(data, seed, seconds);
  const sim = createSim(input);
  const atk = attackerOf(input), def = input.forces.find((f) => f.side !== atk)!.side;
  const obj = input.rules.objectives[0]!;
  const faction = input.forces.find((f) => f.side === atk)!.faction;
  const doctrineM = input.catalog.factions[faction]?.dismountM ?? 0;
  const ctrls: Controller[] = mode === "ai" ? [commanderController(atk, input), commanderController(def, input)] : [commanderController(def, input)];
  if (mode === "player") {
    for (const [id, u] of sim.state.unit.entries()) {
      if (u.side !== atk || u.parent !== null || u.asset !== undefined || u.missileTeam !== undefined || u.mortar !== undefined) continue;
      submitOrder(sim, { tick: 0, issuer: atk, target: id, kind: "assault", x: obj.x, y: obj.y } as never);
    }
  }
  const row: MountedAssaultRow = { scenario, mode, seed, attacker: atk, doctrineM, carriers: 0, dismountM: [], early: 0, hitAboard: 0, posts: 0, postM: [], fellBackM: [], rounds: 0, ownHits: 0, taken: false, takenS: null };
  const supporting = new Set<EntityId>();
  const watch: { vid: EntityId; tick: number; d0: number }[] = [];
  const hulls = new Set<EntityId>();
  for (const [vid, v] of sim.state.vehicle.entries()) if (v.side === atk) hulls.add(vid);
  const crewOf = (id: EntityId): boolean => { const u = sim.state.identity.get(id)?.unit; return u !== undefined && sim.state.unit.get(u)?.vehicle !== undefined; };
  const seenVid = new Set<EntityId>();
  const end = seconds * 60;
  while (sim.state.tick < end && !sim.state.ended) {
    for (const c of ctrls) for (const o of c.think(sim.state, sim.state.tick)) submitOrder(sim, o);
    const aboard = new Map<EntityId, boolean>();
    for (const [id, s] of sim.state.soldier.entries()) if (s.mount !== undefined) aboard.set(id, true);
    const ev: SimEvent[] = step(sim);
    for (const e of ev) {
      if (e.kind === "assault.dismounted") { row.dismountM.push(e.distM); if (e.distM > doctrineM + 50) row.early++; seenVid.add(e.vehicle); supporting.add(e.vehicle); watch.push({ vid: e.vehicle, tick: e.tick, d0: e.distM }); }
      else if (e.kind === "assault.supportPost") { row.posts++; row.postM.push(Math.round(hypot2(e.x - obj.x, e.y - obj.y))); supporting.add(e.vehicle); }
      else if (e.kind === "unit.dismounted" && mode === "ai" && sim.state.unit.get(e.unit)?.side === atk && !seenVid.has(e.vehicle)) {
        const t = sim.state.transform.get(e.vehicle);
        if (t) { const d = Math.round(hypot2(t.x - obj.x, t.y - obj.y)); seenVid.add(e.vehicle); row.dismountM.push(d); if (d > doctrineM + 50) row.early++; watch.push({ vid: e.vehicle, tick: e.tick, d0: d }); supporting.add(e.vehicle); }
      } else if (e.kind === "shot.fired" && e.vehicle !== undefined && supporting.has(e.vehicle)) row.rounds++;
      else if (e.kind === "hit" && sim.state.identity.get(e.target)?.side === atk && (hulls.has(e.owner) || (sim.state.identity.get(e.owner)?.side === atk && crewOf(e.owner)))) row.ownHits++;
      else if (e.kind === "casualty" && aboard.get(e.soldier) === true && sim.state.identity.get(e.soldier)?.side === atk) row.hitAboard++;
    }
    for (let i = watch.length - 1; i >= 0; i--) {
      const w = watch[i]!;
      if (sim.state.tick - w.tick < 90 * 60) continue;
      const t = sim.state.transform.get(w.vid), v = sim.state.vehicle.get(w.vid);
      if (t && v && v.status === "ok") row.fellBackM.push(Math.round(hypot2(t.x - obj.x, t.y - obj.y) - w.d0));
      watch.splice(i, 1);
    }
    if (!row.taken && sim.state.objectives[0]?.holder === atk) { row.taken = true; row.takenS = Math.round(sim.state.tick / 60); }
  }
  row.carriers = seenVid.size;
  return row;
}

export function mountedAssaultLab(data: LoadedData, seeds: number, seconds = 600, scenarios = ["platoon-vehicles", "platoon-ru-vehicles"], modes: ("player" | "ai")[] = ["player", "ai"]): MountedAssaultRow[] {
  const rows: MountedAssaultRow[] = [];
  for (const sc of scenarios) for (const mode of modes) for (let s = 1; s <= seeds; s++) {
    const r = mountedAssaultBattle(data, sc, mode, s, seconds);
    rows.push(r);
    process.stderr.write(`${sc} ${mode} seed ${s}: dismount ${r.dismountM.join("/")} m, posts ${r.postM.join("/")} m, fell back ${r.fellBackM.join("/")} m, rounds ${r.rounds}, own hits ${r.ownHits}, taken ${r.taken}\n`);
  }
  return rows;
}

const mean = (a: number[]) => (a.length === 0 ? NaN : a.reduce((s, x) => s + x, 0) / a.length);
const fmt = (x: number) => (Number.isFinite(x) ? x.toFixed(0) : "-");

export function mountedAssaultLabMarkdown(rows: MountedAssaultRow[]): string {
  const groups = new Map<string, MountedAssaultRow[]>();
  for (const r of rows) { const k = `${r.scenario}|${r.mode}`; groups.set(k, [...(groups.get(k) ?? []), r]); }
  const lines = [
    "The attacker's platoons riding in to the main objective: \"player\" = the player's Assault order to each of its top units at the start (the mounted assault drill), the defender's commander as usual; \"ai\" = both commanders. Dismount = the carrier's distance to the objective when its squads got out (doctrine distance in brackets; early = more than 50 m beyond it); posts = support-by-fire posts sited (their distance to the objective); fell back = the hull's distance to the objective 90 s after the dismount minus at the dismount (+ = farther back); rounds = shots by those hulls after the dismount; own hits = hits by the attacker's hulls and crews on its own men. Game values (low): docs/DECISIONS.md, balance pass 5, mounted assault.",
    "", "| Scenario | Mode | Battles | Carriers | Dismount m (mean, min-max) | Early | Hit aboard | Posts | Post m (mean) | Fell back m (mean) | Rounds | Own hits | Taken |", "|---|---|---:|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|",
  ];
  for (const [k, rs] of groups) {
    const [sc, mode] = k.split("|");
    const d = rs.flatMap((r) => r.dismountM), p = rs.flatMap((r) => r.postM), f = rs.flatMap((r) => r.fellBackM);
    lines.push(`| ${sc} | ${mode} | ${rs.length} | ${rs.reduce((s, r) => s + r.carriers, 0)} | ${fmt(mean(d))} (${d.length > 0 ? Math.min(...d) : "-"}-${d.length > 0 ? Math.max(...d) : "-"}; doctrine ${rs[0]!.doctrineM}) | ${rs.reduce((s, r) => s + r.early, 0)} | ${rs.reduce((s, r) => s + r.hitAboard, 0)} | ${rs.reduce((s, r) => s + r.posts, 0)} | ${fmt(mean(p))} | ${fmt(mean(f))} | ${rs.reduce((s, r) => s + r.rounds, 0)} | ${rs.reduce((s, r) => s + r.ownHits, 0)} | ${rs.filter((r) => r.taken).length} |`);
  }
  return lines.join("\n");
}
