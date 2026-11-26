/**
 * The rules the PLAYER's units start a battle with, by his side's role (review 2026-11-24 step 5, owner Q4: "At will"
 * when attacking, "Return" when defending). Pure: the app lays the result on the player's force as
 * `ForceInput.start` (battle input; the enemy's commander gives its own orders as before, and every tool, lab and
 * golden battle has no `start`, so they are unchanged).
 *
 *   attack, meeting (both sides advance to seize), follow (the pursuer of a withdrawal),
 *   transit (the side on the move through an ambush)            -> fire "free" (At will)
 *   defend, withdraw (the delaying defender)                    -> fire "return"
 *   ambush                                                      -> a real ambush at the plan's range (the record
 *                                                                  the `ambush` order lays; the card's Ambush chip)
 *   no role stated (the sandboxes)                              -> undefined: the catalog's default
 */
import type { ForceInput, ForceStart } from "@tcs/sim";
import { SCENARIO_KIND } from "./battle";

/** The role a force plays: its plan's posture (scenario kinds), else its stated posture, else none. */
export function forceRole(force: Pick<ForceInput, "plan" | "posture">): NonNullable<ForceInput["plan"]>["posture"] | null {
  return force.plan?.posture ?? force.posture ?? null;
}

export function startRulesFor(force: Pick<ForceInput, "plan" | "posture">): ForceStart | undefined {
  switch (forceRole(force)) {
    case "attack": case "meeting": case "follow": case "transit": return { fire: "free" };
    case "defend": case "withdraw": return { fire: "return" };
    case "ambush": return { ambushM: force.plan?.ambushRangeM ?? SCENARIO_KIND.ambushRangeM };
    default: return undefined;
  }
}
