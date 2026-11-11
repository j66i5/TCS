/** What a soldier's wounds and condition let him do (owner decision: the wounded carry on, impaired). */
import type { Catalog } from "./catalog";
import type { SoldierState } from "./components";

export function updateImpairment(catalog: Catalog, s: SoldierState): void {
  const e = catalog.wounds.effects;
  let leg = 0, arm = 0;
  for (const w of s.wounds) {
    if (w.zone === "legL" || w.zone === "legR") leg = Math.max(leg, w.severity);
    else if (w.zone === "armL" || w.zone === "armR") arm = Math.max(arm, w.severity);
  }
  const p = s.physiology;
  const conscious = p.alive && p.consciousness >= 0.5;
  s.impair.canWalk = conscious && leg < e.legNoWalkSeverity;
  s.impair.canFight = conscious && arm < e.armNoFightSeverity && p.pain < e.painNoFightAt;
  s.impair.move = !conscious ? 0 : Math.max(e.minMoveFactor, (1 - e.moveSeverityK * leg) * (1 - 0.5 * p.shock));
  s.impair.aim = 1 + e.aimSeverityK * arm + e.aimPainK * p.pain;
}

/** Alive and conscious: can take orders and act. */
export function isAble(s: SoldierState | undefined): boolean {
  return s !== undefined && s.physiology.alive && s.physiology.consciousness >= 0.5;
}
