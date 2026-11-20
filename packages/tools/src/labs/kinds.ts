/**
 * SCENARIO KINDS LAB (M12.0b, plan m12-roster 4.2 acceptance): every kind of battle the generator makes, AI against AI
 * (each side's commander by its plan, `planControllers`), on every map kind for a set of seeds, with the template build
 * and (`roster`) with each side's force fed in as roster records (`ScenarioDef.forces`: the template build's units and
 * vehicles as records). Per battle: how it ended, the winner, men able at the end, down and saved, when each side last
 * fired, and the STALEMATE flag: the battle ran to its time limit, no side fired in its last third, and both sides still
 * had more than half their men able on the map.
 */
import { planControllers } from "@tcs/ai";
import type { DataSet } from "@tcs/data";
import { buildScenario, type MapKind, type ScenarioDef, type ScenarioForces } from "@tcs/scenario";
import { hasExited, isAble, isAssetUnit, runBattle, TICK_HZ, type BattleInput, type BattleResult, type Sim, type SimEvent, type UnitInput } from "@tcs/sim";
import { ON_POSTS } from "../scenarios";

export const KIND_MAPS: readonly MapKind[] = ["village", "farmland", "woodland", "industrial"];

export interface KindRow {
  kind: string; map: string; seed: number; roster: boolean; vehicles: boolean;
  endReason: string; endS: number; winner: string | null;
  men: [number, number]; ableEnd: [number, number]; saved: [number, number];
  lastFireS: [number, number]; stalemate: boolean; wallS: number; speed: number;
  /** Men out by an exit whose roster status is not "fit" or "wounded" (must be 0), and of them how many came out fit. */
  savedBad?: number; savedFit?: number;
}

const FIRE = new Set(["shot.fired", "grenade.launched", "mortar.fired", "support.round"]);

/** The scenario of one cell of the matrix (attacker by the seed: odd blue, even red). */
export function kindScenario(kind: string, map: MapKind, seed: number, seconds: number, o: { vehicles?: boolean; size?: "platoon" | "company"; factions?: [string, string]; forces?: [ScenarioForces, ScenarioForces] } = {}): ScenarioDef {
  return {
    kind: kind as ScenarioDef["kind"], seed, mapKind: map, factions: o.factions ?? ["de", "ru"], attacker: seed % 2 === 0 ? "red" : "blue",
    timeLimitSeconds: seconds, vehicles: o.vehicles === true, ...(o.size ? { size: o.size } : {}), ...(o.forces ? { forces: o.forces } : {}),
  };
}

/** The template build of a scenario as roster forces (units with their records, the hulls), late units included. */
export function rosterForcesOf(input: BattleInput): [ScenarioForces, ScenarioForces] {
  const strip = (u: UnitInput): UnitInput => { const c = JSON.parse(JSON.stringify(u)) as UnitInput; delete c.arriveS; return c; };
  return (["blue", "red"] as const).map((side) => {
    const f = input.forces.find((x) => x.side === side)!;
    const off = new Set((f.offMap ?? []).map((a) => a.vehicleId));
    const units = f.units.filter((u) => u.vehicleId === undefined || !off.has(u.vehicleId)).map(strip);
    const vehicles = (f.vehicles ?? []).filter((v) => !off.has(v.vehicleId)).map((v) => JSON.parse(JSON.stringify(v)) as NonNullable<ScenarioForces["vehicles"]>[number]);
    return { units, ...(vehicles.length > 0 ? { vehicles } : {}) };
  }) as [ScenarioForces, ScenarioForces];
}

/** One battle of the matrix, measured. */
export function runKind(data: DataSet, def: ScenarioDef, roster: boolean): { row: KindRow; input: BattleInput; result: BattleResult } {
  const input = buildScenario(data, def, ON_POSTS);
  const lastFire: [number, number] = [-1, -1];
  let able: [number, number] = [0, 0];
  let pending: SimEvent[] = [];
  let simRef: Sim | null = null;
  const t0 = performance.now();
  const result = runBattle(input, {
    controllers: planControllers(input),
    onEvents: (ev) => { for (const e of ev) if (FIRE.has(e.kind)) pending.push(e); },
    onTick: (sim: Sim) => {
      simRef = sim;
      const st = sim.state;
      for (const e of pending) {
        let side: string | undefined;
        if (e.kind === "shot.fired") side = e.vehicle !== undefined ? st.vehicle.get(e.vehicle)?.side : st.identity.get(e.shooter)?.side;
        else if (e.kind === "grenade.launched") side = st.identity.get(e.soldier)?.side;
        else if (e.kind === "mortar.fired") side = e.side;
        else if (e.kind === "support.round") side = (e as { side?: string }).side;
        if (side === "blue") lastFire[0] = e.tick; else if (side === "red") lastFire[1] = e.tick;
      }
      pending = [];
      if (st.ended === null && st.tick % TICK_HZ !== 0) return;
      const a: [number, number] = [0, 0];
      // mounted: ok (the men on the map, aboard or not)
      for (const [id, ident] of st.identity.entries()) {
        if (isAssetUnit(st, ident.unit)) continue;
        const s = st.soldier.get(id);
        if (s && isAble(s)) a[ident.side === "blue" ? 0 : 1]++;
      }
      able = a;
    },
  });
  const wallS = (performance.now() - t0) / 1000;
  const sides = ["blue", "red"] as const;
  const men = sides.map((s) => result.sides.find((x) => x.side === s)!.soldiersStart) as [number, number];
  const saved = sides.map((s) => result.sides.find((x) => x.side === s)!.saved ?? 0) as [number, number];
  const T = input.rules.timeLimitSeconds * TICK_HZ;
  const quietFrom = T - T / 3;
  const ranOut = result.endReason === "time-limit";
  const quiet = lastFire[0] < quietFrom && lastFire[1] < quietFrom;
  const strong = able[0] * 2 > men[0] && able[1] * 2 > men[1];
  const row: KindRow = {
    kind: def.kind, map: def.mapKind, seed: def.seed, roster, vehicles: def.vehicles === true, endReason: result.endReason, endS: Math.round(result.durationSeconds), winner: result.winner,
    men, ableEnd: able, saved, lastFireS: lastFire.map((t) => (t < 0 ? -1 : Math.round(t / TICK_HZ))) as [number, number],
    stalemate: ranOut && quiet && strong, wallS: Math.round(wallS * 10) / 10, speed: Math.round(result.durationSeconds / Math.max(wallS, 1e-3)),
  };
  if ((input.rules.exits ?? []).length > 0 && simRef) {
    // Every man out by an exit, as the roster gives him back: "fit" or "wounded", nothing else.
    const status = new Map<string, string>();
    const walk = (u: UnitInput) => { for (const m of u.members) status.set(m.personId, m.status ?? "fit"); u.subunits.forEach(walk); };
    for (const f of result.forcesOut) f.units.forEach(walk);
    let bad = 0, fit = 0;
    const st = (simRef as Sim).state;
    // mounted: ok (a man out aboard his hull counts too)
    for (const [id, ident] of st.identity.entries()) {
      const s = st.soldier.get(id);
      if (!hasExited(s)) continue;
      const rs = status.get(ident.personId);
      if (rs === "fit") fit++; else if (rs !== "wounded") bad++;
    }
    row.savedBad = bad; row.savedFit = fit;
  }
  return { row, input, result };
}

/** The matrix (kinds x maps x seeds), with or without roster forces. */
export function kindsLab(data: DataSet, o: { kinds: readonly string[]; maps: readonly MapKind[]; seeds: readonly number[]; seconds: number; vehicles?: boolean; roster?: boolean; size?: "platoon" | "company"; onRow?: (r: KindRow) => void }): KindRow[] {
  const rows: KindRow[] = [];
  for (const kind of o.kinds) for (const map of o.maps) for (const seed of o.seeds) {
    let def = kindScenario(kind, map, seed, o.seconds, { vehicles: o.vehicles === true, ...(o.size ? { size: o.size } : {}) });
    if (o.roster === true) def = { ...def, forces: rosterForcesOf(buildScenario(data, def, ON_POSTS)) };
    const { row } = runKind(data, def, o.roster === true);
    rows.push(row);
    o.onRow?.(row);
  }
  return rows;
}

export function kindsMarkdown(rows: readonly KindRow[]): string {
  const out = ["| kind | map | seed | roster | end | s | winner | men b/r | able at end | saved | last fire s | stalemate | x real time |", "|---|---|---|---|---|---|---|---|---|---|---|---|---|"];
  for (const r of rows) out.push(`| ${r.kind} | ${r.map} | ${r.seed} | ${r.roster ? "yes" : ""} | ${r.endReason} | ${r.endS} | ${r.winner ?? "draw"} | ${r.men[0]}/${r.men[1]} | ${r.ableEnd[0]}/${r.ableEnd[1]} | ${r.saved[0]}/${r.saved[1]} | ${r.lastFireS[0]}/${r.lastFireS[1]} | ${r.stalemate ? "**yes**" : ""} | ${r.speed} |`);
  const n = rows.length, st = rows.filter((r) => r.stalemate).length;
  out.push("", `${n} battles, ${st} stalemates.`);
  return out.join("\n");
}
