/**
 * The player's own order (a map gesture, a button or a `__tcs` debug hook) before it goes to the sim. The AI
 * commander's orders never pass through here: the app sends them unchanged, as headless, batch and golden runs do.
 */
import type { Order } from "@tcs/sim";

/**
 * Marks the order as the player's (a vehicle then holds its move or halt against close enemy men, owner 2026-11-13)
 * and sends a move into a building to the floor shown on screen (M7.5d). `topFloorAt` gives the top floor index of
 * the building at a point, or -1 outdoors.
 */
export function playerOrder(order: Order, shownFloor: number, topFloorAt: (x: number, y: number) => number): Order {
  let o: Order = { ...order, player: true };
  if (o.kind === "move" && o.floor === undefined && shownFloor > 0) {
    const last = o.waypoints[o.waypoints.length - 1];
    const top = last ? topFloorAt(last.x, last.y) : -1;
    if (top >= 0) o = { ...o, floor: Math.min(shownFloor, top) };
  }
  return o;
}
