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
import { atan2, hypot2, isCaptive, isOut, supportLeft, type BattleInput, type Controller, type EntityId, type ObjectiveDef, type Order, type SideId, type SimView, type SoldierState } from "@tcs/sim";

export const COMMANDER = { stepSeconds: 5, supportM: 300, sneakM: 200, reconSeconds: 60, defenceRangeM: 300, refireSeconds: 20, reassaultSeconds: 30, fallBackM: 100, grenadeRangeM: 35, grenadeEverySeconds: 20, heEverySeconds: 90, heRounds: 6, smokeEverySeconds: 120, smokeRounds: 3, smokeAheadM: 45, defenceHeEverySeconds: 120, defenceHeRounds: 4 } as const;

type Phase = "start" | "advance" | "recon" | "assault" | "second" | "hold" | "withdraw";
interface Memory { phase: Phase; phaseTick: number; target: number; lastFire: number; lastAssault: Record<string, number>; pulledBack: number[]; counterTick: number; lastGrenade?: Record<string, number>; lastHe?: number; lastSmoke?: number }

const able = (s: SoldierState | undefined) => s !== undefined && !isOut(s) && s.mental.behaviour !== "routed";

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
  const fireDelayS = input.catalog.factions[force.faction]?.fireSupport?.delaySeconds ?? 0;
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
      // Every platoon of the side (the attacker may have two): their squads and their own men.
      const tops = [...view.unit.entries()].filter(([, u]) => u.side === side && u.parent === null);
      if (tops.length === 0) return out;
      const topIds = tops.map(([id]) => id);
      const squads = tops.flatMap(([, u]) => u.children).sort((a, b) => a - b);
      const hq = tops.flatMap(([, u]) => u.members).filter((m) => able(view.soldier.get(m) as SoldierState | undefined));
      const toAll = (body: Record<string, unknown>) => { for (const id of topIds) order(id, body); };
      // What its men know of the enemy: not what its own prisoners know, and never an enemy they know has
      // given up (M6.6: the commander does not fire, shell or throw at him).
      const known = (m: EntityId) => { const s = view.soldier.get(m); return s === undefined || isCaptive(s) ? [] : s.contacts.filter((c) => c.surrendered !== true); };
      // Fire is called through the first platoon that still has a man who can use the radio.
      const caller = topIds.find((id) => members(view, id).some((m) => { const s = view.soldier.get(m); return able(s as SoldierState | undefined) && s!.impair.canSpeak; })) ?? topIds[0]!;
      const strength = (uid: EntityId) => { const ms = members(view, uid); return ms.length ? ms.filter((m) => able(view.soldier.get(m) as SoldierState | undefined)).length / ms.length : 0; };
      /** Men not killed or out (a man who panicked and ran is not lost: his unit rallies). */
      const fitShare = (uid: EntityId) => { const ms = members(view, uid); return ms.length ? ms.filter((m) => { const s = view.soldier.get(m); return s !== undefined && !isOut(s); }).length / ms.length : 0; };
      const all = topIds.flatMap((id) => members(view, id));
      const down = all.filter((m) => { const s = view.soldier.get(m); return s !== undefined && isOut(s); }).length / Math.max(1, all.length);
      const holds = (i: number) => view.objectives[i]?.holder === side;
      const main = objectives[0];
      if (!main) return out;

      if (defending) {
        if (mem.phase === "start") {
          toAll({ kind: "rules", fire: "free", maxEngageM: COMMANDER.defenceRangeM });
          toAll({ kind: "posture", posture: "prone" });
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
        // Mortars on attackers its men have seen out in the open (not near its own men).
        if (supportLeft(view, side, "he") > 0 && tick - (mem.lastHe ?? -1e9) >= COMMANDER.defenceHeEverySeconds * 60) {
          let sx2 = 0, sy2 = 0, n = 0;
          for (const m of all) for (const c of known(m)) {
            if (c.kind === "reported" || hypot2(c.x - main.x, c.y - main.y) < 120) continue;
            sx2 += c.x; sy2 += c.y; n++;
          }
          if (n >= 3) {
            const px = sx2 / n, py = sy2 / n;
            const nearOwn = all.some((f) => { const ft = view.transform.get(f); return ft !== undefined && hypot2(ft.x - px, ft.y - py) < 100; });
            if (!nearOwn) { order(caller, { kind: "callFire", x: px, y: py, ammo: "he", rounds: COMMANDER.defenceHeRounds }); mem.lastHe = tick; }
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
          toAll({ kind: "rules", fire: "return", onContact: "ground" });
          // Walk most of the way, sneak the last stretch to the support line (M6.5b); routes keep to cover as
          // the faction's doctrine prefers (systems/orders.ts).
          squads.forEach((sq, i) => {
            const lat = (i - (squads.length - 1) / 2) * (squads.length > 3 ? 45 : 60);
            const p = lateral(lat);
            const q = { x: clamp(p.x - ux * COMMANDER.sneakM, W), y: clamp(p.y - uy * COMMANDER.sneakM, H) };
            order(sq, { kind: "move", waypoints: [{ x: q.x, y: q.y, mode: "walk" }, { x: p.x, y: p.y, mode: "sneak" }], facing: atan2(uy, ux) });
          });
          for (const m of hq) order(m, { kind: "move", waypoints: [{ x: support.x - ux * 30, y: support.y - uy * 30, mode: "walk" }] });
          mem.phase = "advance"; mem.phaseTick = tick;
          break;
        case "advance": {
          const arrived = squads.every((sq) => !view.unit.get(sq)?.moving);
          if (arrived || tick - mem.phaseTick > 600 * 60) { mem.phase = "recon"; mem.phaseTick = tick; toAll({ kind: "rules", fire: "free" }); }
          break;
        }
        case "recon": {
          // Look for the enemy around the objective before going in (what the men have seen or heard).
          let nKnown = 0;
          for (const m of all) for (const c of known(m)) if (hypot2(c.x - tgt.x, c.y - tgt.y) < 150) nKnown++;
          // Call the mortars now (they take a minute or more), and go in when their rounds are landing.
          if (supportLeft(view, side, "he") > 0 && mem.lastHe === undefined) {
            let hx = tgt.x, hy = tgt.y, best = 150;
            for (const m of all) for (const c of known(m)) { const d = hypot2(c.x - tgt.x, c.y - tgt.y); if (d < best) { best = d; hx = c.x; hy = c.y; } }
            order(caller, { kind: "callFire", x: hx, y: hy, ammo: "he", rounds: Math.max(COMMANDER.heRounds, Math.floor(supportLeft(view, side, "he") / 4)) });
            mem.lastHe = tick;
          }
          const fireLanding = mem.lastHe === undefined || tick - mem.lastHe >= (fireDelayS + 10) * 60;
          if ((nKnown > 0 && fireLanding) || tick - mem.phaseTick >= Math.max(COMMANDER.reconSeconds, fireDelayS + 30) * 60) { mem.phase = "assault"; mem.phaseTick = tick; mem.lastAssault = {}; }
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
            else { mem.phase = "hold"; toAll({ kind: "posture", posture: "prone" }); }
            break;
          }
          // The base of fire: the first squad still standing (in the second phase the weakest), the rest assault.
          const live = squads.filter((sq) => strength(sq) > 0);
          if (live.length === 0) break;
          const ranked = mem.phase === "second" ? [...live].sort((a, b) => strength(a) - strength(b) || a - b) : live;
          // Mortars (M6.5c): high explosive on the enemies its men know near the objective (else on it), smoke on
          // its near edge to blind them while the assault goes in; repeated while rounds last.
          // (Its own men near the point now, or squads assaulting toward it — they will be there when the rounds land.)
          const ownNear = (px: number, py: number, r: number) => all.some((f) => { const ft = view.transform.get(f); return ft !== undefined && view.soldier.get(f)?.physiology.alive === true && hypot2(ft.x - px, ft.y - py) < r; })
            || squads.some((sq) => { const d = view.unit.get(sq)?.drill; return d !== null && d !== undefined && d.kind === "assault" && hypot2(d.x - px, d.y - py) < 150; });
          if (supportLeft(view, side, "he") > 0 && tick - (mem.lastHe ?? -1e9) >= COMMANDER.heEverySeconds * 60) {
            let hx = tgt.x, hy = tgt.y, best = 150;
            for (const m of all) for (const c of known(m)) { const d = hypot2(c.x - tgt.x, c.y - tgt.y); if (d < best) { best = d; hx = c.x; hy = c.y; } }
            if (!ownNear(hx, hy, 90)) { order(caller, { kind: "callFire", x: hx, y: hy, ammo: "he", rounds: Math.max(COMMANDER.heRounds, Math.floor(supportLeft(view, side, "he") / 4)) }); mem.lastHe = tick; }
          }
          if (supportLeft(view, side, "smoke") > 0 && tick - (mem.lastSmoke ?? -1e9) >= COMMANDER.smokeEverySeconds * 60) {
            const sx3 = clamp(tgt.x - ux * COMMANDER.smokeAheadM, W), sy3 = clamp(tgt.y - uy * COMMANDER.smokeAheadM, H);
            order(caller, { kind: "callFire", x: sx3, y: sy3, ammo: "smoke", rounds: COMMANDER.smokeRounds });
            mem.lastSmoke = tick;
          }
          // Half the squads fire (at least one), the others assault (M6.5b).
          const nBase = live.length > 1 ? Math.max(1, Math.floor(live.length / 2)) : 0;
          const bases = ranked.slice(0, nBase);
          const assaulters = live.length > 1 ? live.filter((sq) => !bases.includes(sq)) : [ranked[0]!];
          if (bases.length > 0 && tick - mem.lastFire >= COMMANDER.refireSeconds * 60) {
            // At the enemies the base of fire's men know near the objective (each base squad another one), else the point.
            const used = new Set<number>();
            for (const base of bases) {
              let best: { target: EntityId; x: number; y: number } | null = null, bestD = 120;
              for (const m of members(view, base)) for (const c of known(m)) {
                const d = hypot2(c.x - tgt.x, c.y - tgt.y) + (used.has(c.target) ? 60 : 0);
                if (d < bestD) { bestD = d; best = { target: c.target, x: c.x, y: c.y }; }
              }
              if (best) used.add(best.target);
              order(base, best ? { kind: "fire", x: best.x, y: best.y, contact: best.target } : { kind: "fire", x: tgt.x, y: tgt.y, heightM: 0.5 });
            }
            mem.lastFire = tick;
          }
          // Close in: grenades at an enemy an assaulting squad knows within throwing range (M6.5b).
          mem.lastGrenade ??= {};
          for (const sq of assaulters) {
            if (tick - (mem.lastGrenade[String(sq)] ?? -1e9) < COMMANDER.grenadeEverySeconds * 60) continue;
            const men = members(view, sq).filter((m) => able(view.soldier.get(m) as SoldierState | undefined));
            let hit: { x: number; y: number } | null = null;
            for (const m of men) {
              const t = view.transform.get(m);
              if (!t) continue;
              for (const c of known(m)) {
                if (hypot2(c.x - t.x, c.y - t.y) > COMMANDER.grenadeRangeM) continue;
                // Never where a friend is close to the burst.
                if (all.some((f) => { const ft = view.transform.get(f); return ft !== undefined && view.soldier.get(f)?.physiology.alive === true && hypot2(ft.x - c.x, ft.y - c.y) < 15; })) continue;
                hit = { x: c.x, y: c.y }; break;
              }
              if (hit) break;
            }
            if (hit) { order(sq, { kind: "grenade", x: hit.x, y: hit.y, count: 2 }); mem.lastGrenade[String(sq)] = tick; }
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
