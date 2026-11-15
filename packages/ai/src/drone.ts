/**
 * THE AI'S RECONNAISSANCE DRONE (M9.4b). The commander keeps each platoon's quadcopter up (relaunching it with a
 * fresh battery once it has landed) and sends it, every `DRONE.everySeconds`, over where it wants to look: the enemy
 * its men know of (their mean position), or, knowing none, ahead of its objective — the attacker over the main
 * objective, the defender out toward where the attack comes from (the briefing: the side the enemy starts on). Its
 * feed reaches the side's men as for the player (contacts), so the rest of the commander profits on its own. Over
 * the enemy it keeps `standoffM` short of him, toward its own men, at `altitudeM`: out of his rifles' easy reach.
 */
import type { BattleInput, Controller, EntityId, Order, SideId, SimView } from "@tcs/sim";
import { hypot2 } from "@tcs/sim";

export const DRONE = {
  /** How often the commander sends its drones somewhere new, s. */
  everySeconds: 60,
  /** The defender's drone goes this far out from the main objective toward the enemy's side, m. */
  defenderOutM: 450,
  /** A new point closer than this to the drone's goal is not sent (no order traffic for nothing), m. */
  sameGoalM: 60,
  /** It watches the enemy from this far short of him, toward its own side (out of his rifles' reach overhead, his
   *  position still within its cameras' footprint), m; and from this height, m. */
  standoffM: 220,
  altitudeM: 120,
} as const;

/** The top units of `side` that have a drone (in the air, or carried by one of their own members). */
function droneUnits(view: SimView, input: BattleInput, side: SideId): { unit: EntityId; up: EntityId | null }[] {
  const out: { unit: EntityId; up: EntityId | null }[] = [];
  for (const [uid, u] of view.unit.entries()) {
    if (u.side !== side || u.parent !== null) continue;
    let up: EntityId | null = null;
    for (const [did, d] of view.drone.entries()) if (d.unit === uid) { up = did; break; }
    const carried = u.members.some((m) => view.container.get(m)?.stacks.some((st) => st.count > 0 && input.catalog.items[st.type]?.drone !== undefined));
    if (up !== null || carried) out.push({ unit: uid, up });
  }
  return out;
}

/** The drone orders for this tick (none between the commander's drone steps). */
export function droneUse(view: SimView, input: BattleInput, side: SideId, tick: number): Order[] {
  if (view.ended || tick % (DRONE.everySeconds * 60) !== 0 || input.rules.objectives.length === 0) return [];
  const units = droneUnits(view, input, side);
  if (units.length === 0) return [];
  // Where its men know the enemy to be (men and vehicles; recent).
  let ex = 0, ey = 0, n = 0;
  const seen = new Set<EntityId>();
  for (const [id, s] of view.soldier.entries()) {
    if (view.identity.get(id)?.side !== side) continue;
    for (const c of s.contacts) {
      if (seen.has(c.target) || c.surrendered === true || c.down === true || tick - c.tick > 120 * 60) continue;
      seen.add(c.target); ex += c.x; ey += c.y; n++;
    }
  }
  const main = input.rules.objectives[0]!;
  let gx: number, gy: number;
  if (n > 0) { gx = ex / n; gy = ey / n; }
  else if (main.holder !== side) { gx = main.x; gy = main.y; }
  else {
    // Out toward the side the enemy starts on.
    const enemy = input.forces.find((f) => f.side !== side);
    const px = enemy && enemy.placements.length > 0 ? enemy.placements.reduce((a, p) => a + p.x, 0) / enemy.placements.length : input.map.widthM / 2;
    const py = enemy && enemy.placements.length > 0 ? enemy.placements.reduce((a, p) => a + p.y, 0) / enemy.placements.length : input.map.heightM / 2;
    const d = Math.max(1, hypot2(px - main.x, py - main.y)), k = Math.min(1, DRONE.defenderOutM / d);
    gx = main.x + (px - main.x) * k; gy = main.y + (py - main.y) * k;
  }
  // Short of that point, toward its own men (out of the enemy's rifles' easy reach).
  let ox = 0, oy = 0, k = 0;
  for (const [id, i] of view.identity.entries()) { if (i.side !== side) continue; const t = view.transform.get(id); if (t) { ox += t.x; oy += t.y; k++; } }
  if (k > 0) { ox /= k; oy /= k; const d = hypot2(ox - gx, oy - gy); if (d > 1) { const m = Math.min(DRONE.standoffM, d) / d; gx += (ox - gx) * m; gy += (oy - gy) * m; } }
  gx = Math.min(Math.max(gx, 5), input.map.widthM - 5); gy = Math.min(Math.max(gy, 5), input.map.heightM - 5);
  const out: Order[] = [];
  for (const { unit, up } of units) {
    const d = up === null ? undefined : view.drone.get(up);
    if (d && (d.low === true || (d.goal && hypot2(d.goal.x - gx, d.goal.y - gy) < DRONE.sameGoalM))) continue;
    out.push({ tick, issuer: side, target: unit, kind: "drone", op: "fly", x: gx, y: gy, altM: DRONE.altitudeM });
  }
  return out;
}

/** A controller that also flies its side's drones (M9.4b). */
export function withDrones(c: Controller, input: BattleInput): Controller {
  return { ...c, think: (view, tick) => [...c.think(view, tick), ...droneUse(view, input, c.side, tick)] };
}
