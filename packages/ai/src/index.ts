/**
 * @tcs/ai - soldier, squad and commander decision-making (M4, M6).
 * Depends on @tcs/sim only. AI acts on the world exclusively by issuing orders, like a human player.
 *
 * M0 contains only a trivial scripted controller used by the batch runner and tests.
 */
import { createRng, nextRange, secondsToTicks, type Controller, type EntityId, type Order, type RngState, type SideId, type SimView } from "@tcs/sim";

/** Top-level units (no parent) of a side, ascending ID. */
export function topUnits(state: SimView, side: SideId): EntityId[] {
  const out: EntityId[] = [];
  for (const [id, u] of state.unit.entries()) if (u.side === side && u.parent === null) out.push(id);
  return out;
}

/**
 * Every `intervalSeconds`, sends each top-level unit to a random point in a box around the map centre.
 * Uses its OWN random generator (never the simulation's), so it influences the battle only via orders.
 */
export function wanderController(side: SideId, seed: number, map: { widthM: number; heightM: number }, intervalSeconds = 60): Controller {
  let rng: RngState = createRng(seed);
  const every = secondsToTicks(intervalSeconds);
  return {
    side,
    think(state, tick): Order[] {
      if (tick % every !== 0) return [];
      return topUnits(state, side).map((target) => ({
        tick,
        issuer: side,
        target,
        kind: "move" as const,
        waypoints: [{
          x: nextRange(rng, "wander", map.widthM * 0.3, map.widthM * 0.7),
          y: nextRange(rng, "wander", map.heightM * 0.2, map.heightM * 0.8),
          mode: "walk",
        }],
      }));
    },
    saveState: () => JSON.parse(JSON.stringify(rng)) as unknown,
    loadState: (data) => { rng = JSON.parse(JSON.stringify(data)) as RngState; },
  };
}
