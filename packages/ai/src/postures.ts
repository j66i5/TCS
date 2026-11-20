/**
 * POSTURES OF THE SCENARIO KINDS (M12.0b, SPEC 6.9; plan m12-roster 4.2): the commander of a side whose battle is not
 * a plain attack or defence (`ForceInput.plan`), through orders only, as a player would give them.
 *
 * - "attack", "defend", "meeting": the platoon commander (commander.ts; in a meeting nobody holds the objectives, so
 *   both sides attack them).
 * - reserve (`plan.reserve`, units arriving late): each such unit gets a commander of its own that attacks the
 *   objectives when it comes (the counter-attack; reinforcements); the main commander leads the rest.
 * - "ambush": every unit lays an ambush (D4b `ambush` order) where it stands and holds; once it is sprung and
 *   `AMBUSH_AI.pursueAfterS` have passed with the enemy still near, its squads close on the enemy they know.
 * - "transit": every unit makes for the side's exit zone across the map (crews drive, squads aboard ride, the rest
 *   walk), fire free and pushing on through contact; a unit standing still, or on its way without moving, is sent on
 *   again (the drill against an ambush: keep going).
 * - "withdraw": the platoon commander's defence until `untilS`; then squads near their carriers mount, the hulls wait
 *   for them a little, and everyone makes for the exit zone at its own edge.
 * - "follow": the platoon commander's attack until `untilS`; then every unit follows the enemy up toward his exit
 *   (the nearest enemy its side knows within `followNearM`, else the exit zone, stopping short of it).
 * - break-off (`plan.breakOff`): once the platoon commander has broken its attack off (`phase()` "withdraw") for
 *   `breakOffAfterS`, the side leaves by its own map edge (the break-off exit zone), and the battle ends when it is out.
 *
 * Game values in POSTURES_AI (confidence low).
 */
import { hypot2, isOffMap, isOut, secondsToTicks, type BattleInput, type Controller, type EntityId, type ForceInput, type Order, type SideId, type SimView, type SoldierState } from "@tcs/sim";
import { commanderController } from "./commander";

export const POSTURES_AI = {
  /** How often the posture commanders look (s), and how long a unit stands still before it is sent on again. */
  stepS: 5, idleS: 20, stuckS: 60, stuckM: 10,
  /** Withdrawal: squads within this distance of their carrier mount it; the hulls wait at most this long. */
  mountWithinM: 250, mountWaitS: 60,
  /** Follow-up: the nearest known enemy within this distance is followed, else the exit; units stop this far short of it. */
  followNearM: 500, followShortM: 80,
  /** Ambush: once sprung and this long after, squads close on the enemy they know within `pursueM` of the ambush. */
  pursueAfterS: 120, pursueM: 350,
  /** Break-off: once the platoon commander has broken the attack off this long (its men remounting), the side leaves by
   *  its break-off exit. */
  breakOffAfterS: 60,
} as const;

interface Zone { x0: number; y0: number; x1: number; y1: number }

const clampTo = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

/** Where a unit at (x, y) makes for in the zone: 2 m from its outer side (the map edge) for a strip along an edge, else
 *  its middle across; level with the unit along it; inside the map. */
function zonePoint(z: Zone, _x: number, y: number, W: number, H: number): { x: number; y: number } {
  const x0 = Math.min(z.x0, z.x1), x1 = Math.max(z.x0, z.x1), y0 = Math.min(z.y0, z.y1), y1 = Math.max(z.y0, z.y1);
  const x = x0 <= 0 ? 2 : x1 >= W ? W - 2 : (x0 + x1) / 2;
  return { x: clampTo(x, 1, W - 1), y: clampTo(clampTo(y, y0 + 5, y1 - 5), 1, H - 1) };
}

const able = (s: SoldierState | undefined) => s !== undefined && !isOut(s) && s.mental.behaviour !== "routed";

/** The units a posture commander moves: vehicle crews (their hull still drivable and on the map) and units with men of
 *  their own on foot (riders aboard are moved by their hull). In ID order. */
function movers(view: SimView, side: SideId): { id: EntityId; vehicle?: EntityId; men: EntityId[]; x: number; y: number; idle: boolean; hasKids: boolean }[] {
  const out: { id: EntityId; vehicle?: EntityId; men: EntityId[]; x: number; y: number; idle: boolean; hasKids: boolean }[] = [];
  for (const [id, u] of view.unit.entries()) {
    if (u.side !== side || u.asset !== undefined) continue;
    if (u.vehicle !== undefined) {
      const v = view.vehicle.get(u.vehicle), t = view.transform.get(u.vehicle);
      if (!v || !t || isOffMap(v) || (v.status !== "ok" && v.status !== "disarmed") || v.towedBy !== undefined) continue;
      out.push({ id, vehicle: u.vehicle, men: [], x: t.x, y: t.y, idle: v.drive.arrived, hasKids: false });
      continue;
    }
    const men = u.members.filter((m) => { const s = view.soldier.get(m) as SoldierState | undefined; return able(s) && s!.mount === undefined && s!.carrying === undefined; });
    if (men.length === 0) continue;
    let x = 0, y = 0, idle = true;
    for (const m of men) { const t = view.transform.get(m)!; x += t.x; y += t.y; if ((view.mover.get(m)?.waypoints.length ?? 0) > 0) idle = false; }
    out.push({ id, men, x: x / men.length, y: y / men.length, idle, hasKids: u.children.length > 0 });
  }
  return out;
}

/** Enemies the side's men know (freshest report each), in id order. */
function knownEnemies(view: SimView, side: SideId): { x: number; y: number }[] {
  const best = new Map<EntityId, { x: number; y: number; tick: number }>();
  for (const [id, idn] of view.identity.entries()) {
    if (idn.side !== side) continue;
    const s = view.soldier.get(id) as SoldierState | undefined;
    if (!s || isOut(s)) continue;
    for (const c of s.contacts) {
      if (c.surrendered === true || c.down === true) continue;
      const b = best.get(c.target);
      if (!b || c.tick > b.tick) best.set(c.target, { x: c.x, y: c.y, tick: c.tick });
    }
  }
  return [...best.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => c);
}

interface PostureMemory { last: Record<string, number>; phase?: string; phaseTick?: number; mountUntil?: number; sprung?: number; fireFree?: true;
  /** Break-off: when the commander was first seen withdrawing, and whether the side is leaving. */
  brokeOff?: number; leaving?: true;
  /** Where each unit was when last looked at (x, y, tick): one on its way that has not moved is sent on again. */
  pos?: Record<string, [number, number, number]>;
  /** Crews of hulls that got stuck and were told to let their riders out (once each). */
  dismounted?: EntityId[] }

/** Orders that send units toward `goal(x, y)` (null: leave it), each again once it has stood still `idleS`. */
function sendOn(view: SimView, side: SideId, tick: number, mem: PostureMemory, goal: (x: number, y: number) => { x: number; y: number } | null, footMode: string, hold?: (id: EntityId) => boolean): Order[] {
  const out: Order[] = [];
  const idleT = secondsToTicks(POSTURES_AI.idleS);
  const stuckT = secondsToTicks(POSTURES_AI.stuckS);
  mem.pos ??= {};
  for (const u of movers(view, side)) {
    if (hold?.(u.id) === true) continue;
    const key = String(u.id), last = mem.last[key] ?? -1e9;
    // (On its way but not moved `stuckM` in `stuckS`: sent on again, as if it stood still.)
    const p = mem.pos[key];
    if (!p || hypot2(u.x - p[0], u.y - p[1]) >= POSTURES_AI.stuckM) mem.pos[key] = [u.x, u.y, tick];
    const stuck = p !== undefined && tick - p[2] >= stuckT && hypot2(u.x - p[0], u.y - p[1]) < POSTURES_AI.stuckM;
    if ((!u.idle && !stuck) || tick - last < idleT) continue;
    if (stuck) {
      mem.pos[key] = [u.x, u.y, tick];
      // A hull that does not get on (a broken track the crew cannot mend in time): its riders get out and walk.
      if (u.vehicle !== undefined && !(mem.dismounted ??= []).includes(u.id)) {
        const v = view.vehicle.get(u.vehicle);
        const riders = (v?.seats ?? []).some((m) => m !== null && view.identity.get(m)?.unit !== u.id);
        if (riders) { mem.dismounted.push(u.id); out.push({ tick, issuer: side, target: u.id, kind: "dismount" }); }
      }
    }
    const g = goal(u.x, u.y);
    if (!g || hypot2(g.x - u.x, g.y - u.y) < 15) continue;
    mem.last[key] = tick;
    out.push({ tick, issuer: side, target: u.id, kind: "move", waypoints: [{ x: g.x, y: g.y, mode: u.vehicle !== undefined ? "run" : footMode }], ...(u.hasKids ? { own: true as const } : {}) } as Order);
  }
  return out;
}

/** Fire at will for every top unit of the side (once); `push`: on contact they keep going, firing as they go. */
function fireFree(view: SimView, side: SideId, tick: number, push = false): Order[] {
  const out: Order[] = [];
  for (const [id, u] of view.unit.entries()) if (u.side === side && u.parent === null && u.asset === undefined) out.push({ tick, issuer: side, target: id, kind: "rules", fire: "free", ...(push ? { onContact: "push" as const } : {}) });
  return out;
}

/** The commander of a side by its plan (`ForceInput.plan`; none: the platoon commander). */
export function sideCommander(side: SideId, input: BattleInput): Controller {
  const force = input.forces.find((f) => f.side === side)!;
  const plan = force.plan;
  if (!plan) return commanderController(side, input);
  const reserve = plan.reserve ?? [];
  const W = input.map.widthM, H = input.map.heightM;
  const every = secondsToTicks(POSTURES_AI.stepS);
  // The main commander (all but the reserve) and one per reserve unit (attacking when it comes).
  const main = plan.posture === "attack" || plan.posture === "defend" || plan.posture === "meeting" || plan.posture === "withdraw" || plan.posture === "follow"
    ? commanderController(side, input, reserve.length > 0 ? { except: reserve } : undefined) : null;
  const subs = reserve.map((cs) => ({ cs, c: commanderController(side, input, { callsign: cs, attack: true }) }));
  let mem: PostureMemory = { last: {} };
  const exit = plan.exit;
  const untilT = plan.untilS === undefined ? null : secondsToTicks(plan.untilS);
  /** The ids of a reserve unit's tree and men (its commander's orders go only to them). */
  const treeOf = (view: SimView, cs: string): Set<EntityId> => {
    const ids = new Set<EntityId>();
    for (const [id, u] of view.unit.entries()) {
      if (u.side !== side || u.callsign !== cs || u.parent !== null) continue;
      const walk = (uid: EntityId) => { ids.add(uid); const x = view.unit.get(uid); if (!x) return; for (const m of x.members) ids.add(m); for (const c of x.children) walk(c); };
      walk(id);
    }
    return ids;
  };
  const reserveOrders = (view: SimView, tick: number): Order[] => subs.flatMap(({ cs, c }) => {
    const tree = treeOf(view, cs);
    if (tree.size === 0) return [];
    return c.think(view, tick).filter((o) => tree.has(o.target));
  });
  const think = (view: SimView, tick: number): Order[] => {
    const out: Order[] = [];
    // Break-off: the commander has given the attack up (before any "follow" phase): the side leaves by its own edge.
    if (plan.breakOff && main && (plan.posture !== "follow" || untilT === null || tick < untilT)) {
      if (mem.leaving !== true && main.phase() === "withdraw") {
        mem.brokeOff ??= tick;
        if (tick - mem.brokeOff >= secondsToTicks(POSTURES_AI.breakOffAfterS)) mem.leaving = true;
      }
      if (mem.leaving === true) {
        if (tick % every === 0) {
          if (mem.fireFree !== true) { mem.fireFree = true; out.push(...fireFree(view, side, tick, true)); }
          const z = plan.breakOff;
          out.push(...sendOn(view, side, tick, mem, (x, y) => zonePoint(z, x, y, W, H), "run"));
        }
        out.push(...reserveOrders(view, tick));
        return out;
      }
    }
    switch (plan.posture) {
      case "attack": case "defend": case "meeting":
        out.push(...main!.think(view, tick));
        break;
      case "withdraw": {
        if (untilT === null || tick < untilT) { out.push(...main!.think(view, tick)); break; }
        if (tick % every !== 0 || !exit) break;
        if (mem.phase === undefined) {
          // Squads near their carrier mount it; the hulls wait for them a little.
          mem.phase = "mount"; mem.phaseTick = tick; mem.mountUntil = tick + secondsToTicks(POSTURES_AI.mountWaitS);
          out.push(...fireFree(view, side, tick, true));
          for (const [id, u] of view.unit.entries()) {
            if (u.side !== side || u.carrier === undefined || u.vehicle !== undefined) continue;
            const v = view.vehicle.get(u.carrier), vt = view.transform.get(u.carrier);
            if (!v || !vt || isOffMap(v) || (v.status !== "ok" && v.status !== "disarmed")) continue;
            const near = u.members.some((m) => { const s = view.soldier.get(m) as SoldierState | undefined, t = view.transform.get(m); return able(s) && s!.mount === undefined && t !== undefined && hypot2(t.x - vt.x, t.y - vt.y) <= POSTURES_AI.mountWithinM; });
            if (near) { out.push({ tick, issuer: side, target: id, kind: "mount", vehicle: u.carrier }); mem.last[String(id)] = tick + secondsToTicks(POSTURES_AI.mountWaitS); }
          }
        }
        // A hull waits while riders of its squads are still walking to it (until mountUntil).
        const waiting = (id: EntityId): boolean => {
          if (tick >= (mem.mountUntil ?? 0)) return false;
          const vid = view.unit.get(id)?.vehicle;
          if (vid === undefined) return false;
          for (const [, u] of view.unit.entries()) if (u.side === side && u.carrier === vid && u.members.some((m) => { const s = view.soldier.get(m) as SoldierState | undefined; return able(s) && s!.mount === undefined; })) return true;
          return false;
        };
        out.push(...sendOn(view, side, tick, mem, (x, y) => zonePoint(exit, x, y, W, H), "run", waiting));
        break;
      }
      case "follow": {
        if (untilT === null || tick < untilT) { out.push(...main!.think(view, tick)); break; }
        if (tick % every !== 0 || !exit) break;
        if (mem.fireFree !== true) { mem.fireFree = true; out.push(...fireFree(view, side, tick)); }
        const enemies = knownEnemies(view, side);
        const zx = (Math.min(exit.x0, exit.x1) + Math.max(exit.x0, exit.x1)) / 2;
        const dir = zx > W / 2 ? 1 : -1;
        out.push(...sendOn(view, side, tick, mem, (x, y) => {
          let best: { x: number; y: number } | null = null, bd: number = POSTURES_AI.followNearM;
          for (const e of enemies) { const d = hypot2(e.x - x, e.y - y); if (d < bd) { bd = d; best = e; } }
          if (best) return { x: clampTo(best.x, 1, W - 1), y: clampTo(best.y, 1, H - 1) };
          const stop = dir > 0 ? Math.min(exit.x0, exit.x1) - POSTURES_AI.followShortM : Math.max(exit.x0, exit.x1) + POSTURES_AI.followShortM;
          const tx = dir > 0 ? Math.max(x, stop) : Math.min(x, stop);
          return Math.abs(tx - x) < 15 ? null : { x: clampTo(tx, 1, W - 1), y: clampTo(y, 1, H - 1) };
        }, "walk"));
        break;
      }
      case "transit": {
        if (tick % every !== 0 || !exit) break;
        if (mem.fireFree !== true) { mem.fireFree = true; out.push(...fireFree(view, side, tick, true)); }
        out.push(...sendOn(view, side, tick, mem, (x, y) => zonePoint(exit, x, y, W, H), "walk"));
        break;
      }
      case "ambush": {
        if (tick % every !== 0) break;
        if (mem.phase === undefined) {
          mem.phase = "wait"; mem.phaseTick = tick;
          for (const [id, u] of view.unit.entries()) {
            if (u.side !== side || u.parent !== null || u.asset !== undefined) continue;
            out.push({ tick, issuer: side, target: id, kind: "ambush", rangeM: plan.ambushRangeM ?? 200 });
          }
          break;
        }
        // Sprung: an own man has fired or is under fire (his unit's fire rule left "hold" by the drill).
        if (mem.sprung === undefined) {
          for (const [, u] of view.unit.entries()) if (u.side === side && u.asset === undefined && (u.firing || tick - u.underFireTick < every)) { mem.sprung = tick; break; }
          break;
        }
        if (tick - mem.sprung < secondsToTicks(POSTURES_AI.pursueAfterS)) break;
        const home = force.placements.length > 0 ? { x: force.placements.reduce((a, p) => a + p.x, 0) / force.placements.length, y: force.placements.reduce((a, p) => a + p.y, 0) / force.placements.length } : { x: W / 2, y: H / 2 };
        const enemies = knownEnemies(view, side).filter((e) => hypot2(e.x - home.x, e.y - home.y) <= POSTURES_AI.pursueM);
        if (enemies.length === 0) break;
        out.push(...sendOn(view, side, tick, mem, (x, y) => {
          let best = enemies[0]!, bd = Infinity;
          for (const e of enemies) { const d = hypot2(e.x - x, e.y - y); if (d < bd) { bd = d; best = e; } }
          return { x: clampTo(best.x, 1, W - 1), y: clampTo(best.y, 1, H - 1) };
        }, "walk"));
        break;
      }
    }
    out.push(...reserveOrders(view, tick));
    return out;
  };
  return {
    side,
    think,
    saveState: () => ({ mem: JSON.parse(JSON.stringify(mem)) as PostureMemory, main: main?.saveState?.() ?? null, subs: subs.map(({ c }) => c.saveState?.() ?? null) }),
    loadState: (d) => {
      const x = d as { mem: PostureMemory; main: unknown; subs: unknown[] };
      mem = JSON.parse(JSON.stringify(x.mem)) as PostureMemory;
      if (x.main !== null) main?.loadState?.(x.main);
      x.subs.forEach((y, i) => { if (y !== null) subs[i]?.c.loadState?.(y); });
    },
  };
}

/** The controllers of every side of a battle by their plans (tools, campaign runner). */
export function planControllers(input: BattleInput): Controller[] {
  return input.forces.map((f: ForceInput) => sideCommander(f.side, input));
}
