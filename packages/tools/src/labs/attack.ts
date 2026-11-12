/**
 * ATTACK LAB (M4.4, ROADMAP M4 acceptance): one squad attacks another across open ground. The attacker (blue,
 * west) starts 300 m from the defender (red, east), who lies behind a 0.7 m wall (prone: covered; kneeling: he
 * fires over it) with the fire rule "free". The attacker is ordered to assault the defender's position at once.
 * Each run ends when one side is finished — broken, or down to under half its men — or the attacker holds the
 * objective with the defender gone, or after the time limit (a failed attack). Half the runs Germany attacks,
 * half Russia. Acceptance: the attack in the open against a prepared defence fails most of the time.
 */
import type { DataSet } from "@tcs/data";
import { demoBattle } from "@tcs/scenario";
import { createSim, step, submitOrder, type Sim } from "@tcs/sim";

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
  const fit = (ids: number[]) => ids.filter((m) => sim.state.soldier.req(m).casualty === "none").length;
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
    const routedOrDown = (ids: number[]) => ids.filter((m) => { const s = sim.state.soldier.req(m); return s.casualty !== "none" || s.mental.behaviour === "routed"; }).length;
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
