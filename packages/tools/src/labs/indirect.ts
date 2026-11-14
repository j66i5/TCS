/**
 * INDIRECT FIRE LAB (M8.2b): how ranging rounds walk onto the target with observers of different skill.
 * - **Adjustment:** the model alone (the sim's own functions, a seeded stream): the first round's error by how the
 *   point was located, then 1-3 seen ranging rounds each corrected by an observer of skill 0.2 / 0.5 / 0.8, by eye or
 *   with a laser, 300 and 600 m from the fall; mean miss (m, radial) after each.
 * - **Missions:** the real chain on the open demo ground: a squad leader calls HE 300 / 500 m ahead over many seeds:
 *   the share of ranging rounds seen, the first round's and the effect's mean aiming miss (before dispersion).
 */
import { demoBattle } from "@tcs/scenario";
import { adjustSkillFactor, createRng, createSim, firstRoundErrorM, nextNormal, readErrorM, step, submitOrder, type SimEvent } from "@tcs/sim";
import type { DataSet } from "@tcs/data";

export interface AdjustRow { faction: string; observer: string; skill: number; distM: number; miss: number[] }
export interface MissionRow { faction: string; distM: number; seeds: number; seenShare: number; firstMiss: number; effectMiss: number }
export interface IndirectLab { adjust: AdjustRow[]; missions: MissionRow[] }

function adjustRows(data: DataSet, trials: number): AdjustRow[] {
  const out: AdjustRow[] = [];
  const cat = demoBattle(data, { seed: 1, factions: ["de", "ru"] }).catalog;
  for (const faction of ["de", "ru"]) {
    const fs = cat.factions[faction]!.fireSupport!;
    for (const laser of [false, true]) for (const skill of [0.2, 0.5, 0.8]) for (const distM of [300, 600]) {
      const rng = createRng(17);
      const miss = [0, 0, 0, 0];
      const sd0 = firstRoundErrorM(fs, laser ? "laser" : "estimate", distM);
      const c = Math.min(1, fs.rangingCorrection * adjustSkillFactor(fs, skill)), read = readErrorM(fs, { skill, laser }, distM);
      for (let k = 0; k < trials; k++) {
        let ex = sd0 * nextNormal(rng, "lab"), ey = sd0 * nextNormal(rng, "lab");
        miss[0]! += Math.hypot(ex, ey);
        for (let r = 1; r <= 3; r++) {
          ex = ex * c + read * nextNormal(rng, "lab"); ey = ey * c + read * nextNormal(rng, "lab");
          miss[r]! += Math.hypot(ex, ey);
        }
      }
      out.push({ faction, observer: laser ? "laser" : "eye", skill, distM, miss: miss.map((m) => m / trials) });
    }
  }
  return out;
}

function missionRows(data: DataSet, seeds: number): MissionRow[] {
  const out: MissionRow[] = [];
  for (const [side, faction] of [["blue", "de"], ["red", "ru"]] as const) for (const distM of [300, 500]) {
    let ranging = 0, seen = 0, first = 0, effect = 0, n = 0;
    for (let seed = 1; seed <= seeds; seed++) {
      const input = demoBattle(data, { seed, factions: ["de", "ru"], mapWidthM: 1400, mapHeightM: 400, frontM: 1000, timeLimitSeconds: 600 });
      input.rules.support = [{ side: "blue", he: 12, smoke: 0 }, { side: "red", he: 12, smoke: 0 }];
      const sim = createSim(input);
      const top = [...sim.state.unit.entries()].find(([, u]) => u.side === side && u.parent === null)![0];
      const lt = sim.state.transform.get(sim.state.unit.get(top)!.leader!)!;
      const x = side === "blue" ? lt.x + distM : lt.x - distM;
      submitOrder(sim, { tick: 0, issuer: side, target: top, kind: "callFire", x, y: lt.y, ammo: "he", rounds: 2 });
      let e0 = -1;
      for (let k = 0; k < 60 * 200; k++) {
        const ev: SimEvent[] = step(sim);
        const m = sim.state.fireMissions[0];
        if (e0 < 0 && m) e0 = Math.hypot(m.ex ?? 0, m.ey ?? 0);
        for (const e of ev) if (e.kind === "support.ranging") { ranging++; if (e.seen) seen++; }
        if (m && m.ranging === undefined && m.volley === undefined && e0 >= 0 && sim.state.tick > 60) { effect += Math.hypot(m.ex ?? 0, m.ey ?? 0); first += e0; n++; break; }
      }
    }
    out.push({ faction, distM, seeds: n, seenShare: ranging > 0 ? seen / ranging : 0, firstMiss: n > 0 ? first / n : 0, effectMiss: n > 0 ? effect / n : 0 });
  }
  return out;
}

export function indirectLab(data: DataSet, seeds = 12, trials = 4000): IndirectLab {
  return { adjust: adjustRows(data, trials), missions: missionRows(data, seeds) };
}

export function indirectLabMarkdown(lab: IndirectLab): string {
  const f = (x: number) => x.toFixed(1);
  return [
    "## Adjustment: mean miss (m) of the aim after 0-3 seen ranging rounds", "",
    "| faction | observer | skill | to the fall (m) | first round | after 1 | after 2 | after 3 |", "|---|---|---:|---:|---:|---:|---:|---:|",
    ...lab.adjust.map((r) => `| ${r.faction} | ${r.observer} | ${r.skill} | ${r.distM} | ${r.miss.map(f).join(" | ")} |`),
    "", "## Missions: a squad leader calls HE on the open demo ground", "",
    "| faction | point ahead (m) | missions | ranging rounds seen | first-round aim miss (m) | effect aim miss (m) |", "|---|---:|---:|---:|---:|---:|",
    ...lab.missions.map((r) => `| ${r.faction} | ${r.distM} | ${r.seeds} | ${(r.seenShare * 100).toFixed(0)} % | ${f(r.firstMiss)} | ${f(r.effectMiss)} |`),
  ].join("\n");
}
