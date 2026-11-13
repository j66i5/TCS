/** Every thing in the world (soldier, unit, vehicle, crate, casualty, ...) is a numeric entity ID. */
export type EntityId = number;
/** Sides in a battle are identified by short strings from the scenario, e.g. "blue" / "red". */
export type SideId = string;
/** Identifiers of data definitions (item types, factions, roles ...). Always data, never code branches. */
export type DefId = string;

/** Fixed simulation rate. Decision recorded in docs/DECISIONS.md (2026-11-11). */
export const TICK_HZ = 60;
/** Seconds per tick. */
export const DT = 1 / TICK_HZ;

export const secondsToTicks = (s: number): number => Math.round(s * TICK_HZ);
export const ticksToSeconds = (t: number): number => t / TICK_HZ;

/**
 * The smallest ID >= 0 with (id + tick) % every === 0 (`every` a whole number of ticks >= 1). A staggered
 * per-tick loop steps from it by `every` up to `state.nextEntityId` and looks each ID up: the same entities in
 * the same (ascending ID) order as iterating a store and skipping the others, without visiting those
 * (performance 2026-11-13).
 */
export function staggerFirst(tick: number, every: number): number {
  return (every - (tick % every)) % every;
}
