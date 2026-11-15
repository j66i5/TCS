/**
 * MEDICAL STATISTICS (M10.8): what the after-action review's Medical tab and the batch tool's medical block show,
 * computed from the battle record alone (record.ts; rule 5: events, never internals), so both say the same thing and
 * the numbers are deterministic per seed. Pure: no text (the app words it from the string table), no state.
 *
 * Per side, of the side's own wounded: men wounded, killed outright (dead within `KILLED_OUTRIGHT_S` of a wound: no
 * care could reach them), seconds from the first wound to the first finished treatment, to a Verwundetennest and to
 * leaving the map (ambulance or rear run); deaths of wounds in the battle and after it (Role 1), each with its
 * timing; and the potentially preventable deaths with the first step of the chain that was missing for them:
 * - `firstAid`: died of his wounds in the battle without any finished treatment;
 * - `collection`: treated, but never reached the Verwundetennest;
 * - `evacuation`: at the nest, but not taken off the map before he died;
 * - `role1Late`: died of wounds after the battle having reached Role 1 later than `chain.role1S` after his wound.
 * A man who reached Role 1 in time and still died is counted as a death of wounds without a missing step. "Potentially
 * preventable" follows the military-medicine usage (a death of wounds where care was missing or late); it says
 * nothing of whether this wound was survivable, which the record does not know.
 */
import { ticksToSeconds } from "./ids";
import type { BattleRecord, CareTrack } from "./record";

/** Dead within this many seconds of a wound: killed outright (as the batch's M10.3b count). */
export const KILLED_OUTRIGHT_S = 30;

export type MissingStep = "firstAid" | "collection" | "evacuation" | "role1Late";
export const MISSING_STEPS: readonly MissingStep[] = ["firstAid", "collection", "evacuation", "role1Late"];

/** One death of wounds: who, when wounded (game s), seconds from his first wound to death, where (battle or after it,
 *  at Role 1 or the captor's aid post), the missing step (null: none, he had every step in time). */
export interface WoundDeath {
  id: number; name: string; callsign: string; woundS: number; afterS: number; after: boolean; step: MissingStep | null;
}

export interface MedicalSideSummary {
  wounded: number;
  killedOutright: number;
  /** Went down (incapacitated) and lived for longer than `KILLED_OUTRIGHT_S`. */
  down: number;
  /** Sorted seconds from the first wound: to the first finished treatment, to the nest, to leaving the map. */
  firstCareS: number[];
  nestS: number[];
  evacS: number[];
  /** Deaths of wounds, in the battle and after it, in order of death. */
  deaths: WoundDeath[];
  /** Potentially preventable deaths by the missing step. */
  steps: Record<MissingStep, number>;
}

const SEC = (ticks: number) => Math.round(ticksToSeconds(ticks));

/** The Medical tab's and the batch's numbers per side, from the record. */
export function medicalSummary(rec: BattleRecord): Record<string, MedicalSideSummary> {
  const out: Record<string, MedicalSideSummary> = {};
  for (const side of Object.keys(rec.sides)) out[side] = { wounded: 0, killedOutright: 0, down: 0, firstCareS: [], nestS: [], evacS: [], deaths: [], steps: { firstAid: 0, collection: 0, evacuation: 0, role1Late: 0 } };
  // (Ids in number order: the record's keys are strings, so sort them as numbers for a stable order.)
  const ids = Object.keys(rec.track).map(Number).sort((a, b) => a - b);
  for (const id of ids) {
    const k = String(id), t: CareTrack = rec.track[k]!, m = out[t.side];
    if (!m) continue;
    m.wounded++;
    const outright = t.dead !== null && t.dead - t.wl <= KILLED_OUTRIGHT_S * 60;
    if (outright) { m.killedOutright++; continue; }
    if (t.down !== null) m.down++;
    const care = rec.firstTreated[k], nest = rec.atNest[k], evac = rec.evacuated[k];
    if (care !== undefined) m.firstCareS.push(SEC(care - t.w0));
    if (nest !== undefined) m.nestS.push(SEC(nest - t.w0));
    if (evac !== undefined) m.evacS.push(SEC(evac - t.w0));
    let death: number | null = null, after = false, step: MissingStep | null = null;
    if (t.dead !== null) {
      death = t.dead;
      step = care === undefined ? "firstAid" : nest === undefined && evac === undefined ? "collection" : evac === undefined ? "evacuation" : null;
    } else if (t.role1 !== null && t.role1.dow !== null) {
      death = t.role1.dow; after = true;
      step = t.role1.inTime ? null : "role1Late";
    }
    if (death === null) continue;
    m.deaths.push({ id, name: t.name, callsign: t.callsign, woundS: SEC(t.w0), afterS: SEC(death - t.w0), after, step });
    if (step !== null) m.steps[step]++;
  }
  for (const m of Object.values(out)) {
    m.firstCareS.sort((a, b) => a - b); m.nestS.sort((a, b) => a - b); m.evacS.sort((a, b) => a - b);
    m.deaths.sort((a, b) => a.woundS + a.afterS - (b.woundS + b.afterS) || a.id - b.id);
  }
  return out;
}

/** The median of sorted numbers (null for none). */
export function medianOf(sorted: readonly number[]): number | null {
  if (sorted.length === 0) return null;
  const h = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[h]! : Math.round((sorted[h - 1]! + sorted[h]!) / 2);
}
