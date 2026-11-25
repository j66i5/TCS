/**
 * SCENARIO KINDS LAB (M12.0b, plan m12-roster 4.2 acceptance): every kind of battle the generator makes, AI against AI
 * (each side's commander by its plan, `planControllers`), on every map kind for a set of seeds, with the template build
 * and (`roster`) with each side's force fed in as roster records (`ScenarioDef.forces`: the template build's units and
 * vehicles as records). Per battle: how it ended, the winner, men able at the end, down and saved, when each side last
 * fired, and the STALEMATE flag: the battle ran to its time limit, no side fired in its last third, and both sides still
 * had more than half their men able on the map.
 *
 * Review 2026-11-24 problem 2 (part 2): only DIRECT fire counts as fighting (a shot by a man or an on-map hull, a
 * launched grenade; never an off-map or a mortar round). Per side: direct rounds out (of them by men), the first enemy
 * direct round, men hit, the closest man-to-man distance between the sides, and the longest QUIET stretch (no direct
 * round and no man hit while both sides have able men on the map, counted from the first time a man of either side saw
 * an enemy man: the approach march before is no quiet fight; review 2026-11-24 verification). Fail flags: NO RETURN FIRE
 * (a side took at least `minIncoming` enemy direct rounds or had a man hit, and fired fewer than `minReturn` direct
 * rounds), QUIET (a quiet stretch of at least `quietS`) and NO FIRE (not one direct round by either side).
 * `lab -- kinds --strict` exits non-zero on any flag.
 *
 * Review 2026-11-24 problem 3 (the end of a decided battle): per battle also when an early end was first announced
 * (`battle.ending`, s, -1 none) and why, how many were called off, and the TAIL: seconds from the last direct round or
 * man hit to the end (a battle that runs on after it is decided). `noDecided` (`--no-decided`): the decided ends off
 * (`rules.victory.decided` false), for the before/after comparison.
 */
import { planControllers } from "@tcs/ai";
import type { DataSet } from "@tcs/data";
import { buildScenario, type MapKind, type ScenarioDef, type ScenarioForces } from "@tcs/scenario";
import { hasExited, isAble, isAssetUnit, isOffMap, isOffMapMan, runBattle, TICK_HZ, type BattleInput, type BattleResult, type Sim, type SimEvent, type UnitInput } from "@tcs/sim";
import { ON_POSTS } from "../scenarios";

export const KIND_MAPS: readonly MapKind[] = ["village", "farmland", "woodland", "industrial"];

export interface KindRow {
  kind: string; map: string; seed: number; roster: boolean; vehicles: boolean;
  endReason: string; endS: number; winner: string | null;
  men: [number, number]; ableEnd: [number, number]; saved: [number, number];
  lastFireS: [number, number]; stalemate: boolean; wallS: number; speed: number;
  /** Men out by an exit whose roster status is not "fit" or "wounded" (must be 0), and of them how many came out fit. */
  savedBad?: number; savedFit?: number;
  /** Direct rounds fired (men and on-map hulls, grenades), of them by men; the first enemy direct round at the side (s,
   *  -1 none); men hit (wounded or worse, each once); the closest distance between able men of the two sides on the map
   *  (m, -1 never both); the longest quiet stretch (s) and when it began; the fail flags. */
  direct: [number, number]; menDirect: [number, number]; firstInS: [number, number]; hit: [number, number];
  closestM: number; quietS: number; quietFromS: number; noReturn: [boolean, boolean]; quiet: boolean;
  /** When a man of either side first saw an enemy man (s, -1 never); no direct round by either side at all. */
  firstSeenS: number; noFire: boolean;
  /** Review 2026-11-24 problem 3: the first decided end announced (s, -1 none) and its reason, ends called off, and
   *  seconds from the last direct round or man hit to the end. */
  endingS: number; endingReason: string; endingsCancelled: number; tailS: number;
}

/** The fail flags' thresholds (lab options). */
export interface KindChecks {
  /** Enemy direct rounds that put a side under fire (a man hit does too). */
  minIncoming: number;
  /** Direct rounds a side under fire must fire back. */
  minReturn: number;
  /** A quiet stretch this long (s) with both sides on the map fails the battle. */
  quietS: number;
}
export const KIND_CHECKS: KindChecks = { minIncoming: 20, minReturn: 10, quietS: 300 };

/** Direct fire: a shot by a man or an on-map hull (not a mortar's high-angle round), a launched or thrown grenade. */
const FIRE = new Set(["shot.fired", "grenade.launched"]);

/** The fail flags of a row's measures (pure: the lab's acceptance logic, tested on synthetic rows). */
export function kindFlags(m: Pick<KindRow, "direct" | "firstInS" | "hit" | "quietS">, c: KindChecks = KIND_CHECKS, incoming?: [number, number]): { noReturn: [boolean, boolean]; quiet: boolean; noFire: boolean } {
  const inc = incoming ?? [m.direct[1], m.direct[0]];
  const noReturn = [0, 1].map((i) => (inc[i]! >= c.minIncoming || m.hit[i]! > 0) && m.direct[i]! < c.minReturn) as [boolean, boolean];
  return { noReturn, quiet: m.quietS >= c.quietS, noFire: m.direct[0] + m.direct[1] === 0 };
}

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
export function runKind(data: DataSet, def: ScenarioDef, roster: boolean, checks: KindChecks = KIND_CHECKS, noDecided = false): { row: KindRow; input: BattleInput; result: BattleResult } {
  const input = buildScenario(data, def, ON_POSTS);
  if (noDecided && input.rules.victory) input.rules.victory.decided = false;
  let endingTick = -1, endingReason = "", cancelled = 0;
  const lastFire: [number, number] = [-1, -1];
  const direct: [number, number] = [0, 0], menDirect: [number, number] = [0, 0], firstIn: [number, number] = [-1, -1];
  const hitMen = [new Set<number>(), new Set<number>()];
  let closest = Infinity, quietStart = 0, quietMax = 0, quietAt = -1, lastActivity = 0, firstSeen = -1;
  let able: [number, number] = [0, 0];
  let pending: SimEvent[] = [];
  let simRef: Sim | null = null;
  const t0 = performance.now();
  const result = runBattle(input, {
    controllers: planControllers(input),
    onEvents: (ev) => {
      for (const e of ev) {
        if (FIRE.has(e.kind) || e.kind === "wound" || e.kind === "casualty") pending.push(e);
        else if (e.kind === "battle.ending") { if (e.cancelled) cancelled++; else if (endingTick < 0) { endingTick = e.tick; endingReason = e.reason; } }
      }
    },
    onTick: (sim: Sim) => {
      simRef = sim;
      const st = sim.state;
      for (const e of pending) {
        if (e.kind === "wound" || e.kind === "casualty") {
          const side = st.identity.get(e.soldier)?.side;
          if (side === "blue" || side === "red") { hitMen[side === "blue" ? 0 : 1]!.add(e.soldier); lastActivity = e.tick; }
          continue;
        }
        let side: string | undefined, man = false;
        if (e.kind === "shot.fired") {
          // (An on-map tube's high-angle round is indirect fire; an off-map round never fires a shot.)
          if (e.indirect === true) continue;
          const v = e.vehicle !== undefined ? st.vehicle.get(e.vehicle) : undefined;
          if (v !== undefined && isOffMap(v)) continue;
          side = v !== undefined ? v.side : st.identity.get(e.shooter)?.side;
          man = e.vehicle === undefined;
        } else if (e.kind === "grenade.launched") { side = st.identity.get(e.soldier)?.side; man = true; }
        if (side !== "blue" && side !== "red") continue;
        const i = side === "blue" ? 0 : 1;
        lastFire[i] = e.tick; direct[i]++; if (man) menDirect[i]++; lastActivity = e.tick;
        if (firstIn[1 - i]! < 0) firstIn[1 - i] = e.tick;
      }
      pending = [];
      if (st.ended === null && st.tick % TICK_HZ !== 0) return;
      const a: [number, number] = [0, 0];
      const pos: [number[], number[]] = [[], []];
      // mounted: ok (the men on the map, aboard or not)
      for (const [id, ident] of st.identity.entries()) {
        if (isAssetUnit(st, ident.unit)) continue;
        const s = st.soldier.get(id);
        if (!s || !isAble(s)) continue;
        const i = ident.side === "blue" ? 0 : 1;
        a[i]++;
        if (isOffMapMan(st, s)) continue;
        if (firstSeen < 0 && s.contacts.some((c) => c.kind === "seen" && st.tick - c.tick < TICK_HZ && c.cls !== "vehicle")) firstSeen = st.tick;
        const t = st.transform.get(id);
        if (t && t.x > -1000) pos[i].push(t.x, t.y);
      }
      able = a;
      // Both sides on the map: the quiet clock runs (once a man of either has seen the enemy, or a round was fired);
      // else it starts again when they are.
      if (firstSeen < 0 && lastActivity > 0) firstSeen = lastActivity;
      if (pos[0].length > 0 && pos[1].length > 0) {
        for (let p = 0; p < pos[0].length; p += 2) for (let q = 0; q < pos[1].length; q += 2) {
          const dx = pos[0][p]! - pos[1][q]!, dy = pos[0][p + 1]! - pos[1][q + 1]!, d2 = dx * dx + dy * dy;
          if (d2 < closest) closest = d2;
        }
        const from = Math.max(quietStart, lastActivity, firstSeen);
        if (firstSeen >= 0 && st.tick - from > quietMax) { quietMax = st.tick - from; quietAt = from; }
      } else quietStart = st.tick;
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
  const m = { direct, firstInS: firstIn.map((t) => (t < 0 ? -1 : Math.round(t / TICK_HZ))) as [number, number], hit: [hitMen[0]!.size, hitMen[1]!.size] as [number, number], quietS: Math.round(quietMax / TICK_HZ) };
  const flags = kindFlags(m, checks);
  const row: KindRow = {
    kind: def.kind, map: def.mapKind, seed: def.seed, roster, vehicles: def.vehicles === true, endReason: result.endReason, endS: Math.round(result.durationSeconds), winner: result.winner,
    men, ableEnd: able, saved, lastFireS: lastFire.map((t) => (t < 0 ? -1 : Math.round(t / TICK_HZ))) as [number, number],
    stalemate: ranOut && quiet && strong, wallS: Math.round(wallS * 10) / 10, speed: Math.round(result.durationSeconds / Math.max(wallS, 1e-3)),
    ...m, menDirect, closestM: closest === Infinity ? -1 : Math.round(Math.sqrt(closest)), quietFromS: quietAt < 0 ? -1 : Math.round(quietAt / TICK_HZ),
    firstSeenS: firstSeen < 0 ? -1 : Math.round(firstSeen / TICK_HZ), ...flags,
    endingS: endingTick < 0 ? -1 : Math.round(endingTick / TICK_HZ), endingReason, endingsCancelled: cancelled,
    tailS: Math.max(0, Math.round(result.durationSeconds - lastActivity / TICK_HZ)),
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
export function kindsLab(data: DataSet, o: { kinds: readonly string[]; maps: readonly MapKind[]; seeds: readonly number[]; seconds: number; vehicles?: boolean; roster?: boolean; size?: "platoon" | "company"; checks?: KindChecks; noDecided?: boolean; onRow?: (r: KindRow) => void }): KindRow[] {
  const rows: KindRow[] = [];
  for (const kind of o.kinds) for (const map of o.maps) for (const seed of o.seeds) {
    let def = kindScenario(kind, map, seed, o.seconds, { vehicles: o.vehicles === true, ...(o.size ? { size: o.size } : {}) });
    if (o.roster === true) def = { ...def, forces: rosterForcesOf(buildScenario(data, def, ON_POSTS)) };
    const { row } = runKind(data, def, o.roster === true, o.checks ?? KIND_CHECKS, o.noDecided === true);
    rows.push(row);
    o.onRow?.(row);
  }
  return rows;
}

/** The row's fail flags as words ("" none). */
export function kindFails(r: Pick<KindRow, "noReturn" | "quiet"> & { noFire?: boolean }): string[] {
  const f: string[] = [];
  if (r.noFire === true) f.push("no fire");
  if (r.noReturn[0]) f.push("blue no return fire");
  if (r.noReturn[1]) f.push("red no return fire");
  if (r.quiet) f.push("quiet");
  return f;
}

export function kindsMarkdown(rows: readonly KindRow[], c: KindChecks = KIND_CHECKS): string {
  const out = [
    "| kind | map | seed | roster | veh | end | s | ending announced s (reason, called off) | tail s | winner | men b/r | able at end | saved | direct rounds b/r (by men) | first fired on s | men hit b/r | last direct s | closest m | longest quiet s (from) | stalemate | fails | x real time |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
  ];
  for (const r of rows) {
    const fails = kindFails(r);
    out.push(`| ${r.kind} | ${r.map} | ${r.seed} | ${r.roster ? "yes" : ""} | ${r.vehicles ? "yes" : ""} | ${r.endReason} | ${r.endS} | ${r.endingS < 0 ? "" : `${r.endingS} (${r.endingReason})`}${r.endingsCancelled > 0 ? ` ${r.endingsCancelled} off` : ""} | ${r.tailS} | ${r.winner ?? "draw"} | ${r.men[0]}/${r.men[1]} | ${r.ableEnd[0]}/${r.ableEnd[1]} | ${r.saved[0]}/${r.saved[1]} | ${r.direct[0]} (${r.menDirect[0]}) / ${r.direct[1]} (${r.menDirect[1]}) | ${r.firstInS[0]}/${r.firstInS[1]} | ${r.hit[0]}/${r.hit[1]} | ${r.lastFireS[0]}/${r.lastFireS[1]} | ${r.closestM} | ${r.quietS} (${r.quietFromS}) | ${r.stalemate ? "**yes**" : ""} | ${fails.length > 0 ? `**${fails.join(", ")}**` : ""} | ${r.speed} |`);
  }
  const n = rows.length, st = rows.filter((r) => r.stalemate).length;
  const nr = rows.filter((r) => r.noReturn[0] || r.noReturn[1]).length, q = rows.filter((r) => r.quiet).length;
  const tail = rows.reduce((a, r) => a + r.tailS, 0), dur = rows.reduce((a, r) => a + r.endS, 0);
  out.push("", `Tail (last direct round or man hit to the end): ${tail} s of ${dur} s battle time (${dur > 0 ? Math.round((100 * tail) / dur) : 0} %); ${rows.filter((r) => r.endReason === "time-limit").length} ran to the time limit; ends by reason: ${[...new Set(rows.map((r) => r.endReason))].sort().map((k) => `${k} ${rows.filter((r) => r.endReason === k).length}`).join(", ")}.`);
  out.push("", `${n} battles, ${st} stalemates, ${nr} with a side that never fired back (took ${c.minIncoming}+ enemy direct rounds or a man hit, fired under ${c.minReturn}), ${q} with a quiet stretch of ${c.quietS} s or more (no direct round, nobody hit, both sides on the map, from the first sighting), ${rows.filter((r) => r.noFire).length} with no direct round at all. Direct fire only: off-map and mortar rounds are not counted.`);
  return out.join("\n");
}
