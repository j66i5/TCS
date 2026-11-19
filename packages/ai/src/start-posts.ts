/**
 * Balance pass 4 (owner 2026-11-19, decision E): a defence's hulls start the battle on their hull-down posts.
 *
 * The defending side's tank sections and its carriers whose squads are out (tanks.ts `tankSections`) would drive to
 * their posts at the start, across the attacker's view. Instead the scenario places them there: this runs the
 * defending side's own commander (`commanderController`) on a throw-away simulation of the defence alone until it
 * has sited every such hull, and writes each hull's first post (place and facing) into the force's
 * `vehiclePlacements`, flagged `onPost`. In the battle the commander's first siting keeps each such hull on its spot
 * (tanks.ts `startPosts`). Deterministic (the battle input and the commander only), no faction named.
 */
import { createSim, step, submitOrder, type BattleInput, type ForceInput, type SideId } from "@tcs/sim";
import { commanderController } from "./commander";
import type { TanksMemory } from "./tanks";

/** The longest the throw-away simulation runs before the posts must be there (s). */
const START_POSTS_MAX_S = 10;

/**
 * Move the defending side's sited hulls to their first posts in `input` (in place) and flag them `onPost`. The
 * input needs only the map, the catalog, the rules' objectives and the defending force (`side`), already built.
 * Returns the vehicle ids moved.
 */
export function defenceStartPosts(input: BattleInput, side: SideId): string[] {
  const force = input.forces.find((f) => f.side === side);
  if (!force || (force.vehiclePlacements?.length ?? 0) === 0) return [];
  const alone: BattleInput = { ...input, forces: [stripForce(force)], orders: [] };
  const sim = createSim(alone);
  const ctrl = commanderController(side, alone);
  const crews = [...sim.state.unit.entries()].filter(([, u]) => u.side === side && u.vehicle !== undefined && u.asset === undefined).map(([id]) => id).sort((a, b) => a - b);
  let mem: TanksMemory = {};
  for (let i = 0; i <= START_POSTS_MAX_S * 60; i++) {
    const tick = sim.state.tick;
    for (const o of ctrl.think(sim.state, tick)) submitOrder(sim, o);
    mem = (ctrl.saveState?.() ?? {}) as TanksMemory;
    // Sited: every section the commander keeps has its posts (crews it does not site, e.g. a carrier with men
    // aboard, have no entry).
    const sited = Object.values(mem.tk ?? {});
    if (sited.length > 0 && sited.every((m) => m.posts.length > 0)) break;
    step(sim);
  }
  const moved: string[] = [];
  for (const c of crews) {
    const m = mem.tk?.[String(c)];
    const p = m?.posts[m.post];
    const vid = sim.state.unit.get(c)?.vehicle;
    const v = vid === undefined ? undefined : sim.state.vehicle.get(vid);
    if (!p || !v) continue;
    const pl = force.vehiclePlacements!.find((q) => q.vehicleId === v.vehicleId);
    if (!pl) continue;
    pl.x = p[0]; pl.y = p[1]; pl.heading = p[2]; pl.onPost = true;
    moved.push(v.vehicleId);
  }
  return moved;
}

/** A copy of the force for the throw-away run (its placements copied: the run must not move the real ones). */
function stripForce(f: ForceInput): ForceInput {
  return { ...f, placements: f.placements.map((p) => ({ ...p })), ...(f.vehiclePlacements ? { vehiclePlacements: f.vehiclePlacements.map((p) => ({ ...p })) } : {}) };
}
