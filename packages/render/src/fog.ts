/**
 * Fog of war, what is drawn of the enemy (owner, 2026-11-14): an enemy man the player's side has in sight NOW is
 * drawn as a real figure (or dot), like the player's own men; everything else of the enemy only as its contact
 * symbol or pin. Pure: from the side's knowledge (`Overlay.known`) only.
 */
import type { EntityId } from "@tcs/sim";

/** A "seen" contact younger than this (s) is in sight now (the solid diamond / solid hull rule). */
export const IN_SIGHT_S = 2;

/** One entry of the side's knowledge, as far as this rule needs it. */
export interface KnownLike { target: EntityId; kind: "seen" | "heard" | "reported"; ageS: number; cls?: "vehicle" }

/** Is this contact in sight now (seen within the last `IN_SIGHT_S`)? */
export function inSightNow(k: KnownLike): boolean {
  return k.kind === "seen" && k.ageS < IN_SIGHT_S;
}

/** The enemy men (not vehicles) in sight now: these are drawn as figures, not as contact symbols. */
export function enemyMenInSight(known: readonly KnownLike[] | null | undefined): Set<EntityId> {
  const out = new Set<EntityId>();
  for (const k of known ?? []) if (k.cls !== "vehicle" && inSightNow(k)) out.add(k.target);
  return out;
}
