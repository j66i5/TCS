/**
 * RECOVERY CALLS (M11.7b, plan §5): the commander asks for a recovery vehicle for a hull that is out of the fight for
 * good and can be got away: abandoned, or immobilised with nothing its crew can repair (beyond the crew, no parts, or
 * nothing left to fix on a hull that still cannot move). Only when it is quiet there (not hit for `quietS`, no enemy
 * its men know within `enemyNearM`), a recovery vehicle that can tow it waits, and the battle has time left for it to
 * come. Never for an immobilised hull whose gun still works while the enemy is known within `pillboxM`: it fights on
 * where it stands. One call per hull; as `callRecovery` orders (rule 3). Values not from data are listed here.
 */
import { hypot2, isOffMap, repairTaskFor, type Contact, type EntityId, type Order, type SideId, type SimContext, type SimView } from "@tcs/sim";

export const RECOVERY_AI = { lookSeconds: 10, quietS: 120, enemyNearM: 500, pillboxM: 1000, spareS: 120 } as const;

export interface RecoveryMemory { recoveryCalled?: number[]; lastRecoveryLook?: number }

/** The `callRecovery` orders this look gives (at most one per hull per battle). */
export function recoveryCalls(view: SimView, ctx: SimContext, side: SideId, tick: number, mem: RecoveryMemory, contacts: readonly Contact[], caller: EntityId): Order[] {
  const R = ctx.catalog.recovery;
  if (!R || ctx.rules.recovery === false) return [];
  if (tick - (mem.lastRecoveryLook ?? -1e9) < RECOVERY_AI.lookSeconds * 60) return [];
  mem.lastRecoveryLook = tick;
  if ((ctx.rules.timeLimitSeconds - RECOVERY_AI.spareS - R.delayMinS) * 60 < tick) return [];
  // The heaviest hull a waiting recovery vehicle of the side can tow (none waits: nothing to call).
  let maxKg = -1;
  for (const [, v] of view.vehicle.entries()) {
    if (v.side !== side || v.offMap?.kind !== "recovery" || v.offMap.phase !== "ready") continue;
    maxKg = Math.max(maxKg, ctx.catalog.vehicles[v.def]?.recovery?.towMaxKg ?? -1);
  }
  if (maxKg < 0) return [];
  const out: Order[] = [];
  const called = (mem.recoveryCalled ??= []);
  for (const [vid, v] of view.vehicle.entries()) {
    if (v.side !== side || v.offMap !== undefined || isOffMap(v) || v.recoveryBy !== undefined || called.includes(vid)) continue;
    if (v.fire !== null || (v.status !== "abandoned" && v.status !== "immobilised")) continue;
    const def = ctx.catalog.vehicles[v.def];
    if (!def || def.massKg > maxKg) continue;
    if (tick - v.lastHitTick < RECOVERY_AI.quietS * 60) continue;
    const t = view.transform.get(vid);
    if (!t) continue;
    let nearest = Infinity;
    for (const c of contacts) nearest = Math.min(nearest, hypot2(c.x - t.x, c.y - t.y));
    if (nearest < RECOVERY_AI.enemyNearM) continue;
    if (v.status === "immobilised") {
      // Something its crew can still fix: they will (the sim's drill).
      const pick = repairTaskFor(ctx.catalog, view, vid, v, def);
      if (typeof pick !== "string") continue;
      // A pillbox: its gun works and the enemy is in reach.
      const gun = def.components?.findIndex((c) => c.kind === "gun") ?? -1;
      const gunWorks = def.stations.length > 0 && (gun < 0 || (v.comp[gun] ?? 1) > 0);
      if (v.unit !== null && gunWorks && nearest < RECOVERY_AI.pillboxM) continue;
    }
    // The crew calls (or the one that left it, or the platoon's caller).
    let target: EntityId | null = v.unit;
    if (target === null) for (const [uid, u] of view.unit.entries()) if (u.exVehicle === vid) { target = uid; break; }
    out.push({ tick, issuer: side, target: target ?? caller, kind: "callRecovery", vehicle: vid });
    called.push(vid);
    break; // (one call per look: the next hull, if a recovery vehicle is left, at the next look)
  }
  return out;
}
