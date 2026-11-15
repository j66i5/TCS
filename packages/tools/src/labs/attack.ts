/**
 * ATTACK LAB (M4.4, ROADMAP M4 acceptance): one squad attacks another across open ground. The attacker (blue,
 * west) starts 300 m from the defender (red, east), who lies behind a 0.7 m wall (prone: covered; kneeling: he
 * fires over it) with the fire rule "free". The attacker is ordered to assault the defender's position at once.
 * Each run ends when one side is finished — broken, or down to under half its men — or the attacker holds the
 * objective with the defender gone, or after the time limit (a failed attack). Half the runs Germany attacks,
 * half Russia. Acceptance: the attack in the open against a prepared defence fails most of the time.
 *
 * AMBUSH (D4b, `npm run lab -- ambush [trials]`): the same ground, the defender lying in the open (no wall), the
 * attacker walking in on it from 300 m (a move, not an assault: its covering fire would spring the ambush at once; he
 * returns fire only, not knowing where the defence lies). The defender is under an `ambush` order (fire held until the
 * attacker is within `AMBUSH_LAB_M`) or, for comparison, fires at will. From the events: the distance of the defender's first shot to the nearest attacker (the first volley),
 * which side fired first, and the attacker's men down in the 30 s after that volley.
 */
import type { DataSet } from "@tcs/data";
import { demoBattle } from "@tcs/scenario";
import { createSim, isOut, step, submitOrder, type Sim } from "@tcs/sim";

export interface AttackRun { seed: number; attacker: string; wall: boolean; support: boolean; winner: "attacker" | "defender"; how: string; durationS: number; attackerDown: number; defenderDown: number; attackerMen: number; defenderMen: number; attackerBroke: boolean; defenderBroke: boolean; shots: number }

const WALL_H = 0.7;

export function attackRun(data: DataSet, seed: number, attacker: "de" | "ru", wall = true, support = false, seconds = 420): AttackRun {
  const defender = attacker === "de" ? "ru" : "de";
  const input = demoBattle(data, { seed, factions: [attacker, defender], mapWidthM: 800, mapHeightM: 400, frontM: 300, timeLimitSeconds: seconds });
  // With support: a second attacking squad that fires on the position from the start line throughout.
  if (support) input.forces[0] = demoBattle(data, { seed, factions: [attacker, defender], unitsPerSide: 2, mapWidthM: 800, mapHeightM: 400, frontM: 300, timeLimitSeconds: seconds }).forces[0]!;
  const red = input.forces[1]!.placements;
  const ox = red.reduce((a, p) => a + p.x, 0) / red.length, oy = red.reduce((a, p) => a + p.y, 0) / red.length;
  const ys = red.map((p) => p.y);
  if (wall) input.map.obstacles.push({ id: 9001, kind: "stone-wall", points: [ox - 3, Math.min(...ys) - 8, ox - 3, Math.max(...ys) + 8], heightM: WALL_H, thicknessM: 0.5, material: "stone" });
  const sim: Sim = createSim(input);
  const tops = (side: string) => [...sim.state.unit.entries()].filter(([, u]) => u.side === side && u.parent === null).map(([id]) => id);
  const blueTops = tops("blue");
  const aid = blueTops[blueTops.length - 1]!, sid = blueTops.length > 1 ? blueTops[0]! : null, did = tops("red")[0]!;
  submitOrder(sim, { tick: 0, issuer: "red", target: did, kind: "posture", posture: "prone" });
  submitOrder(sim, { tick: 0, issuer: "red", target: did, kind: "rules", fire: "free" });
  for (const b of blueTops) submitOrder(sim, { tick: 0, issuer: "blue", target: b, kind: "rules", fire: "free" });
  if (sid !== null) submitOrder(sim, { tick: 0, issuer: "blue", target: sid, kind: "posture", posture: "prone" });
  const men = (side: string) => [...sim.state.identity.entries()].filter(([, i]) => i.side === side).map(([id]) => id);
  // The assaulting squad is what counts for the attacker (the supporting squad stays on the start line).
  const blue = men("blue").filter((m) => { let u = sim.state.identity.req(m).unit; for (let p = sim.state.unit.get(u)?.parent ?? null; p !== null; p = sim.state.unit.get(u)?.parent ?? null) u = p; return u === aid; }), redMen = men("red");
  const fit = (ids: number[]) => ids.filter((m) => !isOut(sim.state.soldier.req(m))).length; // (prisoners are lost too)
  let shots = 0, winner: AttackRun["winner"] = "defender", how = "time", aBroke = false, dBroke = false, taken = false;
  for (let k = 0; k < seconds * 60; k++) {
    if (k === 120) submitOrder(sim, { tick: k, issuer: "blue", target: aid, kind: "assault", x: ox, y: oy });
    if (sid !== null && k >= 120 && (k - 120) % 1200 === 0) submitOrder(sim, { tick: k, issuer: "blue", target: sid, kind: "fire", x: ox, y: oy, heightM: 0.5 });
    for (const e of step(sim)) {
      if (e.kind === "shot.fired") shots++;
      if (e.kind === "radio" && e.key === "radio.broken") { if (e.side === "blue") aBroke = true; else dBroke = true; }
      if (e.kind === "radio" && e.key === "radio.objectiveTaken" && e.side === "blue") taken = true;
    }
    if (k % 30 !== 0) continue;
    const routedOrDown = (ids: number[]) => ids.filter((m) => { const s = sim.state.soldier.req(m); return isOut(s) || s.mental.behaviour === "routed"; }).length;
    if (aBroke || fit(blue) * 2 < blue.length) { winner = "defender"; how = aBroke ? "attacker broke" : "attacker lost half"; break; }
    if (dBroke || routedOrDown(redMen) === redMen.length || fit(redMen) * 2 < redMen.length) { winner = "attacker"; how = dBroke ? "defender broke" : "defender lost half"; break; }
    if (taken) { winner = "attacker"; how = "objective taken"; break; }
  }
  return {
    seed, attacker, wall, support, winner, how, durationS: sim.state.tick / 60, shots,
    attackerDown: blue.length - fit(blue), defenderDown: redMen.length - fit(redMen), attackerMen: blue.length, defenderMen: redMen.length,
    attackerBroke: aBroke, defenderBroke: dBroke,
  };
}

/** `runs` attacks on the wall; as many on the same defenders lying in the open, and on the wall with a second squad supporting by fire (for comparison). */
export function attackLab(data: DataSet, runs = 20): AttackRun[] {
  const out: AttackRun[] = [];
  for (const [wall, support] of [[true, false], [false, false], [true, true]] as const) {
    for (let i = 0; i < runs; i++) out.push(attackRun(data, i + 1, i % 2 === 0 ? "de" : "ru", wall, support));
  }
  return out;
}

export function attackLabMarkdown(all: AttackRun[]): string {
  const cases: [string, (r: AttackRun) => boolean][] = [
    [`One squad attacks; defender behind a ${WALL_H} m field-stone wall`, (r) => r.wall && !r.support],
    ["One squad attacks; defender lying in the open (comparison)", (r) => !r.wall && !r.support],
    [`Two squads: one fires on the position from the start line, the other assaults; defender behind the wall`, (r) => r.wall && r.support],
  ];
  return cases.map(([h, f]) => `## ${h}\n\n${attackTable(all.filter(f))}`).join("\n\n");
}

function attackTable(rows: AttackRun[]): string {
  const pct = (n: number) => `${Math.round((100 * n) / Math.max(1, rows.length))} %`;
  const mean = (f: (r: AttackRun) => number) => (rows.reduce((a, r) => a + f(r), 0) / Math.max(1, rows.length)).toFixed(1);
  const hows = new Map<string, number>();
  for (const r of rows) hows.set(`${r.winner}: ${r.how}`, (hows.get(`${r.winner}: ${r.how}`) ?? 0) + 1);
  return [
    `A squad assaults across 300 m of open ground; ${rows.length} runs, Germany and Russia attacking in turn.`, "",
    `- Attack succeeded: ${pct(rows.filter((r) => r.winner === "attacker").length)} (Germany attacking ${rows.filter((r) => r.attacker === "de" && r.winner === "attacker").length}/${rows.filter((r) => r.attacker === "de").length}, Russia attacking ${rows.filter((r) => r.attacker === "ru" && r.winner === "attacker").length}/${rows.filter((r) => r.attacker === "ru").length})`,
    `- How it ended: ${[...hows.entries()].sort().map(([k, v]) => `${k} ${v}`).join("; ")}`,
    `- Mean men down: attacker ${mean((r) => r.attackerDown)} of ${rows[0]?.attackerMen ?? 0}, defender ${mean((r) => r.defenderDown)} of ${rows[0]?.defenderMen ?? 0}; mean duration ${mean((r) => r.durationS)} s; mean rounds fired ${mean((r) => r.shots)}`,
    "", "| seed | attacker | result | how | s | attacker down | defender down |", "|---:|---|---|---|---:|---:|---:|",
    ...rows.map((r) => `| ${r.seed} | ${r.attacker} | ${r.winner} | ${r.how} | ${r.durationS.toFixed(0)} | ${r.attackerDown} | ${r.defenderDown} |`),
  ].join("\n");
}

// ---- the ambush lab (D4b)

/** The ambush range the lab's defender is given (m). */
export const AMBUSH_LAB_M = 150;
/** The window after the first volley in which the attacker's losses are counted (s). */
const VOLLEY_WINDOW_S = 30;

export interface AmbushRun { seed: number; attacker: string; ambush: boolean; firstVolleyM: number | null; firstFire: "attacker" | "defender" | "none"; blueDown30: number; attackerMen: number; sprungS: number | null }

/** One advance from 300 m on a defender lying in the open, with an ambush laid (`ambush`) or firing at will. */
export function ambushRun(data: DataSet, seed: number, attacker: "de" | "ru", ambush: boolean, seconds = 300): AmbushRun {
  const defender = attacker === "de" ? "ru" : "de";
  const input = demoBattle(data, { seed, factions: [attacker, defender], mapWidthM: 800, mapHeightM: 400, frontM: 300, timeLimitSeconds: seconds });
  const red = input.forces[1]!.placements;
  const ox = red.reduce((a, p) => a + p.x, 0) / red.length, oy = red.reduce((a, p) => a + p.y, 0) / red.length;
  const sim: Sim = createSim(input);
  const tops = (side: string) => [...sim.state.unit.entries()].filter(([, u]) => u.side === side && u.parent === null).map(([id]) => id);
  const aid = tops("blue")[0]!, did = tops("red")[0]!;
  submitOrder(sim, { tick: 0, issuer: "red", target: did, kind: "posture", posture: "prone" });
  submitOrder(sim, ambush ? { tick: 0, issuer: "red", target: did, kind: "ambush", rangeM: AMBUSH_LAB_M } : { tick: 0, issuer: "red", target: did, kind: "rules", fire: "free" });
  // (The attacker returns fire only: he does not know where the defence lies, so the first shot is the defender's choice.)
  submitOrder(sim, { tick: 0, issuer: "blue", target: aid, kind: "rules", fire: "return" });
  const blue = [...sim.state.identity.entries()].filter(([, i]) => i.side === "blue").map(([id]) => id);
  const down = () => blue.filter((m) => isOut(sim.state.soldier.req(m))).length;
  let firstVolleyM: number | null = null, firstFire: AmbushRun["firstFire"] = "none", volleyTick = -1, downAtVolley = 0, sprungS: number | null = null;
  for (let k = 0; k < seconds * 60; k++) {
    // (A move, not an assault: an assault's covering half fires on the position from the start and springs any ambush.)
    if (k === 120) submitOrder(sim, { tick: k, issuer: "blue", target: aid, kind: "move", waypoints: [{ x: ox, y: oy, mode: "walk" }] });
    for (const e of step(sim)) {
      if (e.kind === "radio" && e.key === "radio.ambushSprung" && e.side === "red" && sprungS === null) sprungS = e.tick / 60;
      if (e.kind !== "shot.fired") continue;
      const side = sim.state.identity.get(e.shooter)?.side;
      if (firstFire === "none") firstFire = side === "red" ? "defender" : "attacker";
      if (side !== "red" || firstVolleyM !== null) continue;
      // The first volley: from the shooter to the nearest attacker still in the fight.
      const t = sim.state.transform.req(e.shooter);
      let best = Infinity;
      for (const m of blue) {
        if (isOut(sim.state.soldier.req(m))) continue;
        const b = sim.state.transform.req(m);
        best = Math.min(best, Math.hypot(b.x - t.x, b.y - t.y));
      }
      firstVolleyM = best;
      volleyTick = e.tick; downAtVolley = down();
    }
    if (volleyTick >= 0 && sim.state.tick >= volleyTick + VOLLEY_WINDOW_S * 60) break;
  }
  return { seed, attacker, ambush, firstVolleyM, firstFire, blueDown30: volleyTick >= 0 ? down() - downAtVolley : 0, attackerMen: blue.length, sprungS };
}

/** `runs` advances on a defender in ambush, as many on one firing at will (Germany and Russia attacking in turn). */
export function ambushLab(data: DataSet, runs = 10): AmbushRun[] {
  const out: AmbushRun[] = [];
  for (const ambush of [true, false]) for (let i = 0; i < runs; i++) out.push(ambushRun(data, i + 1, i % 2 === 0 ? "de" : "ru", ambush));
  return out;
}

export function ambushLabMarkdown(all: AmbushRun[]): string {
  const table = (rows: AmbushRun[]) => {
    const vs = rows.map((r) => r.firstVolleyM).filter((v): v is number => v !== null);
    const mean = (xs: number[]) => (xs.length > 0 ? (xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(0) : "-");
    return [
      `${rows.length} runs; the attacker (returning fire only) walks in from 300 m across open ground, Germany and Russia attacking in turn.`, "",
      `- First volley (the defender's first shot to the nearest attacker): mean ${mean(vs)} m, min ${vs.length > 0 ? Math.min(...vs).toFixed(0) : "-"} m, max ${vs.length > 0 ? Math.max(...vs).toFixed(0) : "-"} m`,
      `- Fired first: defender ${rows.filter((r) => r.firstFire === "defender").length}, attacker ${rows.filter((r) => r.firstFire === "attacker").length}, nobody ${rows.filter((r) => r.firstFire === "none").length}`,
      `- Attacker's men down in the ${VOLLEY_WINDOW_S} s after the first volley: mean ${mean(rows.map((r) => r.blueDown30))} of ${rows[0]?.attackerMen ?? 0}`,
      "", `| seed | attacker | first volley m | fired first | down in ${VOLLEY_WINDOW_S} s | sprung s |`, "|---:|---|---:|---|---:|---:|",
      ...rows.map((r) => `| ${r.seed} | ${r.attacker} | ${r.firstVolleyM === null ? "-" : r.firstVolleyM.toFixed(0)} | ${r.firstFire} | ${r.blueDown30} | ${r.sprungS === null ? "-" : r.sprungS.toFixed(0)} |`),
    ].join("\n");
  };
  return [
    `## Defender in ambush (fire held to ${AMBUSH_LAB_M} m)\n\n${table(all.filter((r) => r.ambush))}`,
    `## Defender firing at will (comparison)\n\n${table(all.filter((r) => !r.ambush))}`,
  ].join("\n\n");
}
