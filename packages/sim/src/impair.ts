/** What a soldier's wounds and condition let him do (owner decision: the wounded carry on, impaired). */
import type { Catalog } from "./catalog";
import type { SoldierState } from "./components";
import type { DeepReadonly } from "./state";

/** A soldier as these questions may be asked of him: the live state, or the read-only view of it. */
type Man = DeepReadonly<SoldierState>;

export function updateImpairment(catalog: Catalog, s: SoldierState): void {
  const e = catalog.wounds.effects;
  let leg = 0, arm = 0;
  for (const w of s.wounds) {
    // A broken bone (medical model, M10.1) counts as a limb he cannot use: no walking on a broken leg, no rifle
    // with a broken arm.
    if (w.zone === "legL" || w.zone === "legR") leg = Math.max(leg, w.fracture ? e.legNoWalkSeverity : w.severity);
    else if (w.zone === "armL" || w.zone === "armR") arm = Math.max(arm, w.fracture ? e.armNoFightSeverity : w.severity);
  }
  const p = s.physiology;
  const conscious = p.alive && p.consciousness >= 0.5;
  s.impair.canWalk = conscious && leg < e.legNoWalkSeverity;
  s.impair.canUseArms = conscious && arm < e.armNoFightSeverity;
  s.impair.canFight = s.impair.canUseArms && p.pain < e.painNoFightAt;
  // A man whose airway is wounded cannot report.
  s.impair.canSpeak = conscious && !s.wounds.some((w) => w.airway);
  s.impair.move = !conscious ? 0 : Math.max(e.minMoveFactor, (1 - e.moveSeverityK * leg) * (1 - 0.5 * p.shock));
  s.impair.aim = 1 + e.aimSeverityK * arm + e.aimPainK * p.pain;
}

/** Alive and conscious (a prisoner too). Code that needs "conscious" only — medical care, a prisoner coming round — asks this. */
export function isConscious(s: Man | undefined): boolean {
  return s !== undefined && s.physiology.alive && s.physiology.consciousness >= 0.5;
}

/** He has given up (surrendered or taken prisoner, M6.6), alive or not. */
export function isCaptive(s: Man | undefined): boolean {
  return s !== undefined && s.captive !== null;
}

/** Does an enemy who sees him now see a man giving up (the contact's `surrendered` flag)? A prisoner escaping (M11.9c)
 *  only until `escape.openTick`. */
export function showsSurrender(s: Man | undefined, tick: number): boolean {
  return s !== undefined && s.captive !== null && (s.captive.escape === undefined || tick < s.captive.escape.openTick);
}

/** A prisoner escaping (M11.9c), held still or not. */
export function isEscaping(s: Man | undefined): boolean {
  return s !== undefined && s.captive?.escape !== undefined;
}

/** Alive, conscious and still in the fight (not a prisoner): can take orders and act for his side. */
export function isAble(s: Man | undefined): boolean {
  // (Review fix: an evacuated man is in the rear, whether or not he still sits in the hull that took him back.)
  return isConscious(s) && s!.captive === null && s!.evacuated === undefined;
}

/** Able and can talk: may send a radio message. */
export function canReport(s: Man | undefined): boolean {
  return isAble(s) && s!.impair.canSpeak;
}

/** A fit man: able, can walk and fight, not panicked or routed. A fit comrade; a man who can take a prisoner. */
export function isFit(s: Man | undefined): boolean {
  return isAble(s) && s!.impair.canWalk && s!.impair.canFight && s!.mental.behaviour !== "panicked" && s!.mental.behaviour !== "routed";
}

/** A man lost to his side: a casualty (killed or incapacitated) or a prisoner. Counted once per man. */
export function isOut(s: Man): boolean {
  return s.casualty !== "none" || s.captive !== null || s.evacuated !== undefined;
}

/** His status for the roster, the review and the result: killed > captured > surrendered > incapacitated > wounded > fit. */
export function rosterStatus(s: Man): "fit" | "wounded" | "incapacitated" | "surrendered" | "captured" | "killed" | "evacuated" {
  if (!s.physiology.alive) return "killed";
  // (M11.9: a prisoner taken back by his captors' ambulance stays "captured".)
  if (s.captive !== null && s.evacuated !== undefined) return s.captive.state;
  // (M10.6a: taken off the map by ambulance; the aid station's outcome comes in M10.6b.)
  if (s.evacuated !== undefined) return "evacuated";
  if (s.captive !== null) return s.captive.state;
  if (s.casualty === "incapacitated") return "incapacitated";
  return s.wounds.length > 0 ? "wounded" : "fit";
}
