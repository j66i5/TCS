/**
 * THE OPPOSING COMMANDER (M6.3, owner decision 2026-11-12: "doctrinal and cautious").
 *
 * A Controller like a human player: it sees what its OWN men know (their contacts, the objective holders)
 * and acts only through orders, every few seconds. Squads (the platoon's sub-units) fight with the M4 drills
 * and decisions; the commander decides what each squad does.
 *
 * Defence: everyone down in his position, fire at will out to `defenceRangeM`; a squad that has lost half its
 *   men pulls back behind the main objective; if the main objective is lost while two squads are still fit (or
 *   one nearly whole), the strongest counterattacks it.
 * Attack: the platoon moves up to a support line about `supportM` from the main objective (going to ground on
 *   contact) and looks for the enemy there (up to `reconSeconds`); then the first squad fires on the objective
 *   from the support line while the others assault it; once it is taken, the base of fire comes up and the
 *   strongest squad assaults the second objective, supported by the rest. Losses beyond the faction's doctrine
 *   (`casualtyToleranceBeforeWithdrawal`) make it break off and withdraw to the start.
 *
 * Its memory is plain data (saved with the game). Values not from data are listed in COMMANDER.
 */
import { atan2, hypot2, type BattleInput, type Controller, type EntityId, type ObjectiveDef, type Order, type SideId, type SimView, type SoldierState } from "@tcs/sim";

export const COMMANDER = { stepSeconds: 5, supportM: 300, reconSeconds: 60, defenceRangeM: 300, refireSeconds: 20, reassaultSeconds: 30, fallBackM: 100 } as const;

type Phase = "start" | "advance" | "recon" | "assault" | "second" | "hold" | "withdraw";
interface Memory { phase: Phase; phaseTick: number; target: number; lastFire: number; lastAssault: Record<string, number>; pulledBack: number[]; counterTick: number }

const able = (s: SoldierState | undefined) => s !== undefined && s.casualty === "none" && s.mental.behaviour !== "routed";

function members(view: SimView, uid: EntityId): EntityId[] {
  const u = view.unit.get(uid);
  if (!u) return [];
  return [...u.members, ...u.children.flatMap((c) => members(view, c))];
}

export function commanderController(side: SideId, input: BattleInput): Controller {
  const objectives: readonly ObjectiveDef[] = input.rules.objectives;
  const W = input.map.widthM, H = input.map.heightM;
  const force = input.forces.find((f) => f.side === side)!;
  const doctrine = input.catalog.factions[force.faction]?.doctrine ?? {};
  const tolerance = doctrine["casualtyToleranceBeforeWithdrawal"] ?? 0.3;
  // Where this side starts (its men's mean position): the way back, and the side the attack comes from.
  const sx = force.placements.reduce((a, p) => a + p.x, 0) / Math.max(1, force.placements.length);
  const sy = force.placements.reduce((a, p) => a + p.y, 0) / Math.max(1, force.placements.length);
  const defending = objectives.length > 0 && objectives[0]!.holder === side;
  let mem: Memory = { phase: "start", phaseTick: 0, target: 0, lastFire: -1e9, lastAssault: {}, pulledBack: [], counterTick: -1e9 };
  const every = COMMANDER.stepSeconds * 60;

  return {
    side,
    think(view, tick): Order[] {
      if (view.ended || tick % every !== 0) return [];
      const out: Order[] = [];
      const order = (target: EntityId, body: Record<string, unknown>) => out.push({ tick, issuer: side, target, ...body } as Order);
      const top = [...view.unit.entries()].find(([, u]) => u.side === side && u.parent === null);
      if (!top) return out;
      const [topId, topUnit] = top;
      const squads = [...topUnit.children].sort((a, b) => a - b);
      const hq = topUnit.members.filter((m) => able(view.soldier.get(m) as SoldierState | undefined));
      const strength = (uid: EntityId) => { const ms = members(view, uid); return ms.length ? ms.filter((m) => able(view.soldier.get(m) as SoldierState | undefined)).length / ms.length : 0; };
      /** Men not killed or out (a man who panicked and ran is not lost: his unit rallies). */
      const fitShare = (uid: EntityId) => { const ms = members(view, uid); return ms.length ? ms.filter((m) => view.soldier.get(m)?.casualty === "none").length / ms.length : 0; };
      const all = members(view, topId);
      const down = all.filter((m) => view.soldier.get(m)?.casualty !== "none").length / Math.max(1, all.length);
      const holds = (i: number) => view.objectives[i]?.holder === side;
      const main = objectives[0];
      if (!main) return out;

      if (defending) {
        if (mem.phase === "start") {
          order(topId, { kind: "rules", fire: "free", maxEngageM: COMMANDER.defenceRangeM });
          order(topId, { kind: "posture", posture: "prone" });
          mem.phase = "hold";
          return out;
        }
        // Away from the attack: from the map's middle through the objective.
        const ax = main.x - W / 2, ay = main.y - H / 2, al = hypot2(ax, ay) || 1;
        for (const sq of squads) {
          if (fitShare(sq) < 0.5 && fitShare(sq) > 0 && !mem.pulledBack.includes(sq)) {
            order(sq, { kind: "withdraw", x: clamp(main.x + (ax / al) * COMMANDER.fallBackM, W), y: clamp(main.y + (ay / al) * COMMANDER.fallBackM, H) });
            mem.pulledBack.push(sq);
          }
        }
        if (!holds(0) && tick - mem.counterTick > 60 * 60) {
          const fit = squads.filter((sq) => !mem.pulledBack.includes(sq) && strength(sq) >= 0.5);
          const best = [...fit].sort((a, b) => strength(b) - strength(a) || a - b)[0];
          if (best !== undefined && (fit.length >= 2 || strength(best) >= 0.7)) {
            order(best, { kind: "assault", x: main.x, y: main.y });
            mem.counterTick = tick;
          }
        }
        return out;
      }

      // ---- attack
      // (Holding what it took, it stays: breaking off would give the objectives back.)
      if (mem.phase !== "withdraw" && mem.phase !== "hold" && down > tolerance) {
        for (const sq of squads) order(sq, { kind: "withdraw", x: sx, y: sy });
        for (const m of hq) order(m, { kind: "move", waypoints: [{ x: sx, y: sy, mode: "run" }] });
        mem.phase = "withdraw"; mem.phaseTick = tick;
        return out;
      }
      const tgt = objectives[mem.target] ?? main;
      const dx = tgt.x - sx, dy = tgt.y - sy, L = hypot2(dx, dy) || 1, ux = dx / L, uy = dy / L;
      const support = { x: clamp(tgt.x - ux * COMMANDER.supportM, W), y: clamp(tgt.y - uy * COMMANDER.supportM, H) };
      const lateral = (k: number) => ({ x: clamp(support.x - uy * k, W), y: clamp(support.y + ux * k, H) });
      switch (mem.phase) {
        case "start":
          order(topId, { kind: "rules", fire: "return", onContact: "ground" });
          squads.forEach((sq, i) => { const p = lateral((i - (squads.length - 1) / 2) * 60); order(sq, { kind: "move", waypoints: [{ x: p.x, y: p.y, mode: "walk" }], facing: atan2(uy, ux) }); });
          for (const m of hq) order(m, { kind: "move", waypoints: [{ x: support.x - ux * 30, y: support.y - uy * 30, mode: "walk" }] });
          mem.phase = "advance"; mem.phaseTick = tick;
          break;
        case "advance": {
          const arrived = squads.every((sq) => !view.unit.get(sq)?.moving);
          if (arrived || tick - mem.phaseTick > 600 * 60) { mem.phase = "recon"; mem.phaseTick = tick; order(topId, { kind: "rules", fire: "free" }); }
          break;
        }
        case "recon": {
          // Look for the enemy around the objective before going in (what the men have seen or heard).
          let known = 0;
          for (const m of all) for (const c of (view.soldier.get(m)?.contacts ?? [])) if (hypot2(c.x - tgt.x, c.y - tgt.y) < 150) known++;
          if (known > 0 || tick - mem.phaseTick >= COMMANDER.reconSeconds * 60) { mem.phase = "assault"; mem.phaseTick = tick; mem.lastAssault = {}; }
          break;
        }
        case "hold":
          // The enemy has taken an objective back: go for it again.
          if (objectives.some((_, i) => !holds(i))) { mem.target = objectives.findIndex((_, i) => !holds(i)); mem.phase = mem.target === 0 ? "assault" : "second"; mem.phaseTick = tick; mem.lastAssault = {}; }
          break;
        case "assault":
        case "second": {
          // In the second phase, the main objective lost again comes first.
          if (mem.phase === "second" && !holds(0)) { mem.target = 0; mem.phase = "assault"; mem.lastAssault = {}; }
          if (holds(mem.target)) {
            if (mem.target + 1 < objectives.length) { mem.target++; mem.phase = "second"; mem.phaseTick = tick; mem.lastAssault = {}; }
            else { mem.phase = "hold"; order(topId, { kind: "posture", posture: "prone" }); }
            break;
          }
          // The base of fire: the first squad still standing (in the second phase the weakest), the rest assault.
          const live = squads.filter((sq) => strength(sq) > 0);
          if (live.length === 0) break;
          const ranked = mem.phase === "second" ? [...live].sort((a, b) => strength(a) - strength(b) || a - b) : live;
          const base = ranked[0]!;
          const assaulters = live.length > 1 ? live.filter((sq) => sq !== base) : [base];
          if (live.length > 1 && tick - mem.lastFire >= COMMANDER.refireSeconds * 60) {
            // At the enemy the base of fire's men know of near the objective (the nearest to it), else the point.
            let best: { target: EntityId; x: number; y: number } | null = null, bestD = 120;
            for (const m of members(view, base)) for (const c of (view.soldier.get(m)?.contacts ?? [])) {
              const d = hypot2(c.x - tgt.x, c.y - tgt.y);
              if (d < bestD) { bestD = d; best = { target: c.target, x: c.x, y: c.y }; }
            }
            order(base, best ? { kind: "fire", x: best.x, y: best.y, contact: best.target } : { kind: "fire", x: tgt.x, y: tgt.y, heightM: 0.5 });
            mem.lastFire = tick;
          }
          assaulters.forEach((sq, i) => {
            const u = view.unit.get(sq);
            const last = mem.lastAssault[String(sq)] ?? -1e9;
            if (u && !u.drill && !u.broken && strength(sq) >= 0.5 && tick - last >= COMMANDER.reassaultSeconds * 60) {
              const off = (i - (assaulters.length - 1) / 2) * 20;
              order(sq, { kind: "assault", x: clamp(tgt.x - uy * off, W), y: clamp(tgt.y + ux * off, H) });
              mem.lastAssault[String(sq)] = tick;
            }
          });
          break;
        }
        default:
          break;
      }
      return out;
    },
    saveState: () => JSON.parse(JSON.stringify(mem)) as unknown,
    loadState: (d) => { mem = JSON.parse(JSON.stringify(d)) as Memory; },
  };
}

function clamp(v: number, max: number): number { return Math.min(Math.max(v, 5), max - 5); }
