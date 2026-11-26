/**
 * The radio log's filter (review 2026-11-24 step 5, item 6). The simulation reports "enemy drone overhead" again
 * every few seconds while a squad's men keep seeing the drone; the player's four-line log needs it once. This is
 * presentation only (rule 5): the events, the battle record and the review still get every call.
 *
 * A unit's sighting stays open while that unit keeps reporting; it closes when the unit has been quiet for
 * `DRONE_QUIET_S`. One line per top unit per sighting, and no more than one drone line per `DRONE_SIDE_GAP_S` for
 * the whole side (ten squads under the same drone do not fill the log). Every other key passes.
 */
export const DRONE_QUIET_S = 60;
export const DRONE_SIDE_GAP_S = 20;
/** The radio keys the filter thins (the others pass). */
export const THINNED_RADIO_KEYS: readonly string[] = ["radio.droneOverhead"];

const TICKS_PER_S = 60;

export class RadioFilter {
  /** Per top unit: the tick of its last report (shown or not). */
  private last = new Map<number, number>();
  /** Units whose open sighting has been shown already. */
  private shown = new Set<number>();
  private sideShown = -Infinity;

  /** Is this radio line shown in the log? `topUnit`: the reporting man's top-level unit. */
  accept(key: string, topUnit: number, tick: number): boolean {
    if (!THINNED_RADIO_KEYS.includes(key)) return true;
    const was = this.last.get(topUnit);
    if (was !== undefined && tick - was > DRONE_QUIET_S * TICKS_PER_S) this.shown.delete(topUnit); // the sighting closed
    this.last.set(topUnit, tick);
    if (this.shown.has(topUnit)) return false;
    if (tick - this.sideShown < DRONE_SIDE_GAP_S * TICKS_PER_S) return false; // (asked again at the unit's next report)
    this.shown.add(topUnit);
    this.sideShown = tick;
    return true;
  }
}
