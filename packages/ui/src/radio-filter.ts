/**
 * The radio log's filter (review 2026-11-24 step 5, item 6). The simulation reports "enemy drone overhead" again
 * every few seconds while a squad's men keep seeing the drone; the player's four-line log needs it once. This is
 * presentation only (rule 5): the events, the battle record and the review still get every call.
 *
 * A unit's sighting stays open while that unit keeps reporting; it closes when the unit has been quiet for
 * `DRONE_QUIET_S`. One line per top unit per sighting, and no more than one drone line per `DRONE_SIDE_GAP_S` for
 * the whole side (ten squads under the same drone do not fill the log). Every other key passes.
 *
 * Verification fix: a call inside the side's gap is not lost. The simulation calls once per man's new sighting, so a
 * unit may never call again: its line waits (`due`) and is shown when the gap has passed, the oldest first, unless
 * its sighting has closed by then.
 */
export const DRONE_QUIET_S = 60;
export const DRONE_SIDE_GAP_S = 20;
/** The radio keys the filter thins (the others pass). */
export const THINNED_RADIO_KEYS: readonly string[] = ["radio.droneOverhead"];

const TICKS_PER_S = 60;

export class RadioFilter<T = unknown> {
  /** Per top unit: the tick of its last report (shown or not). */
  private last = new Map<number, number>();
  /** Units whose open sighting has been shown already. */
  private shown = new Set<number>();
  /** Units whose open sighting waits for the side's gap: the tick it was first called and what to show. */
  private waiting = new Map<number, { tick: number; payload: T | undefined }>();
  private sideShown = -Infinity;

  /** Is this radio line shown in the log now? `topUnit`: the reporting man's top-level unit. A line held back by
   *  the side's gap keeps `payload` and comes out of `due` later. */
  accept(key: string, topUnit: number, tick: number, payload?: T): boolean {
    if (!THINNED_RADIO_KEYS.includes(key)) return true;
    const was = this.last.get(topUnit);
    if (was !== undefined && tick - was > DRONE_QUIET_S * TICKS_PER_S) { this.shown.delete(topUnit); this.waiting.delete(topUnit); } // the sighting closed
    this.last.set(topUnit, tick);
    if (this.shown.has(topUnit) || this.waiting.has(topUnit)) return false;
    if (tick - this.sideShown < DRONE_SIDE_GAP_S * TICKS_PER_S) { this.waiting.set(topUnit, { tick, payload }); return false; }
    this.shown.add(topUnit);
    this.sideShown = tick;
    return true;
  }

  /** The held-back lines to show now (at most one per call and per side gap, the oldest first). */
  due(tick: number): T[] {
    if (this.waiting.size === 0 || tick - this.sideShown < DRONE_SIDE_GAP_S * TICKS_PER_S) return [];
    let pick: number | null = null;
    for (const [u, w] of [...this.waiting.entries()].sort((a, b) => a[1].tick - b[1].tick || a[0] - b[0])) {
      // (Its sighting closed while it waited: nothing to tell any more.)
      if (tick - (this.last.get(u) ?? w.tick) > DRONE_QUIET_S * TICKS_PER_S) { this.waiting.delete(u); continue; }
      pick = u; break;
    }
    if (pick === null) return [];
    const w = this.waiting.get(pick)!;
    this.waiting.delete(pick);
    this.shown.add(pick);
    this.sideShown = tick;
    return w.payload === undefined ? [] : [w.payload];
  }
}
