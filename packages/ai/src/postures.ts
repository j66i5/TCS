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
 *   walk), fire free and pushing on through contact (rule "push": the contact drill first, then on); a unit standing
 *   still, or on its way without moving, is sent on again (the drill against an ambush: keep going), but not while
 *   it is in its contact drill or an assault or withdrawal drill (review 2026-11-24 problem 2).
 * - "withdraw": the platoon commander's defence (fire at will out to `delayRangeM`) until `untilS` AND until it has fought: a delay makes the enemy deploy,
 *   so the side goes only once it has been in contact for `delayContactS` (fired on, an enemy seen near, or one
 *   placed within `delayKnownM` by a comrade or its drone), or the
 *   enemy is within `withdrawCloseM`, or at the latest when it would only just get out before the time limit
 *   (review 2026-11-24 problem 2: it left unseen and the pursuer never closed). Then squads near their carriers
 *   mount, the hulls wait for them a little, squads in contact break it by bounds under covering fire (the withdraw
 *   drill, `rearGuardM` toward the exit: the rear guard), and everyone makes for the exit zone at its own edge.
 * - "follow": the platoon commander's attack until `untilS`, and on while it is in contact; once the enemy is out of
 *   sight for `followQuietS` (it has broken contact), or `followLateS` after `untilS` without contact, every unit
 *   follows him up at once: squads near their carriers mount, everyone goes for the nearest enemy its side knows
 *   within `followNearM` (else on toward his exit zone, stopping short of it), at a run while the contact is hot
 *   (`followRunS`), fire free under rule "push" (the contact drill, then on); the goals are kept up to date.
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
  /** Review 2026-11-24 problem 2 (the pursuit). The withdrawing side holds until it has been in contact this long (s),
   *  or the enemy is this close (m); at the latest it goes when the time left would only just get its farthest man out
   *  at `withdrawPaceMps` plus `withdrawMarginS`. Squads in contact at the start break it by the withdraw drill this
   *  far toward the exit (the rear guard), then run on. */
  delayContactS: 60, withdrawCloseM: 150, delayKnownM: 400,
  /** The delaying side's range of fire at will (m; the defence's own is `COMMANDER.defenceRangeM`). */
  delayRangeM: 600, withdrawPaceMps: 2, withdrawMarginS: 60, rearGuardM: 150,
  /** The follower takes up the pursuit once no man of its side has seen an enemy (nor been fired on) for this long
   *  after `untilS`, or this long after `untilS` without any contact yet; it runs while its last contact is this
   *  recent (s), else walks; a unit's goal is re-sent when it moves this far (m), at most every `followResendS`. */
  followQuietS: 30, followLateS: 120, followRunS: 90, followRetargetM: 60, followResendS: 10,
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
  /** Review 2026-11-24 problem 2: the side's first and latest tick in contact (fired on, or an enemy seen near), the
   *  latest an own man saw an enemy, the withdrawal's latest start, each follower's last goal (x, y, tick). */
  contact?: number; lastContact?: number; lastSeen?: number; latest?: number; goals?: Record<string, [number, number, number]>;
  /** Break-off: when the commander was first seen withdrawing, and whether the side is leaving. */
  brokeOff?: number; leaving?: true;
  /** Where each unit was when last looked at (x, y, tick): one on its way that has not moved is sent on again. */
  pos?: Record<string, [number, number, number]>;
  /** Crews of hulls that got stuck and were told to let their riders out (once each). */
  dismounted?: EntityId[] }

/** Is the unit (or one above it) in its contact drill or a drill (assault, withdrawal; review 2026-11-24 problem 2)?
 *  Its leader is fighting it out; it is not sent on meanwhile (rule "push" goes on by itself once the fire slackens). */
function inContactDrill(view: SimView, id: EntityId): boolean {
  for (let u: EntityId | null = id; u !== null; u = view.unit.get(u)?.parent ?? null) {
    const x = view.unit.get(u);
    if (x?.contactDrill !== undefined || (x?.drill !== null && x?.drill !== undefined && x.drill.kind !== "rout")) return true;
  }
  return false;
}

/** Notes the side's contact this look (review 2026-11-24 problem 2): a unit of it fired on, or a man of it seeing an
 *  enemy near (`seenContactTick`, on top units) within the last look; the latest tick an own man saw an enemy. */
function noteContact(view: SimView, side: SideId, tick: number, mem: PostureMemory, every: number, knownM = 0): void {
  let hit = false;
  for (const [, u] of view.unit.entries()) {
    if (u.side !== side || u.parent !== null || u.asset !== undefined) continue;
    const fired = u.underFireTick > 0 && tick - u.underFireTick <= every;
    const seen = u.seenContactTick !== undefined && tick - u.seenContactTick <= every;
    if (fired || seen) hit = true;
  }
  for (const [id, idn] of view.identity.entries()) {
    if (idn.side !== side) continue;
    const s = view.soldier.get(id) as SoldierState | undefined;
    if (!s || isOut(s)) continue;
    const t = knownM > 0 ? view.transform.get(id) : undefined;
    for (const c of s.contacts) {
      if (c.surrendered === true || c.down === true || tick - c.tick > every) continue;
      if (c.kind === "seen" && (mem.lastSeen ?? -1) < c.tick) mem.lastSeen = c.tick;
      // (`knownM`: an enemy placed — seen, or reported by a comrade or a drone — this close counts as contact too.)
      if (t !== undefined && c.kind !== "heard" && hypot2(c.x - t.x, c.y - t.y) <= knownM) hit = true;
    }
  }
  if (hit) { mem.contact ??= tick; mem.lastContact = tick; }
}

/** Orders that send units toward `goal(x, y)` (null: leave it), each again once it has stood still `idleS`. */
function sendOn(view: SimView, side: SideId, tick: number, mem: PostureMemory, goal: (x: number, y: number) => { x: number; y: number } | null, footMode: string, hold?: (id: EntityId) => boolean): Order[] {
  const out: Order[] = [];
  const idleT = secondsToTicks(POSTURES_AI.idleS);
  const stuckT = secondsToTicks(POSTURES_AI.stuckS);
  mem.pos ??= {};
  for (const u of movers(view, side)) {
    if (hold?.(u.id) === true || inContactDrill(view, u.id)) continue;
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
  // (A delaying side opens fire at long range, `delayRangeM`: it is there to make the enemy deploy, then go.)
  const scope = { ...(reserve.length > 0 ? { except: reserve } : {}), ...(plan.posture === "withdraw" ? { defenceRangeM: POSTURES_AI.delayRangeM } : {}) };
  const main = plan.posture === "attack" || plan.posture === "defend" || plan.posture === "meeting" || plan.posture === "withdraw" || plan.posture === "follow"
    ? commanderController(side, input, Object.keys(scope).length > 0 ? scope : undefined) : null;
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
  /** The withdrawal's latest start (tick): the time limit less the farthest own man's way to the exit at the
   *  withdrawal's pace and a margin; never before `untilS`. */
  const withdrawLatest = (view: SimView, tick: number): number => {
    const T = secondsToTicks(input.rules.timeLimitSeconds);
    if (!exit || T <= 0) return untilT ?? tick;
    let far = 0;
    for (const u of movers(view, side)) { const g = zonePoint(exit, u.x, u.y, W, H); far = Math.max(far, hypot2(g.x - u.x, g.y - u.y)); }
    return Math.max(untilT ?? 0, T - secondsToTicks(far / POSTURES_AI.withdrawPaceMps + POSTURES_AI.withdrawMarginS));
  };
  /** Does the delaying side go now? After `untilS` once it has fought `delayContactS` or the enemy is close; at the
   *  latest start in any case. */
  const withdrawNow = (view: SimView, tick: number): boolean => {
    if (untilT === null) return true;
    if (tick >= (mem.latest ?? untilT)) return true;
    if (tick < untilT) return false;
    if (mem.contact !== undefined && tick - mem.contact >= secondsToTicks(POSTURES_AI.delayContactS)) return true;
    const near = knownEnemies(view, side);
    for (const u of movers(view, side)) for (const e of near) if (hypot2(e.x - u.x, e.y - u.y) <= POSTURES_AI.withdrawCloseM) return true;
    return false;
  };
  /** Does the follower take up the pursuit now? After `untilS`, once the enemy has broken contact (none seen and not
   *  fired on for `followQuietS`), or `followLateS` after it without any contact. */
  const followNow = (tick: number): boolean => {
    if (untilT === null) return true;
    if (tick < untilT) return false;
    if (mem.contact === undefined) return tick - untilT >= secondsToTicks(POSTURES_AI.followLateS);
    return tick - Math.max(mem.lastContact ?? -1e9, mem.lastSeen ?? -1e9) >= secondsToTicks(POSTURES_AI.followQuietS);
  };
  /** Squads with a man on foot within `mountWithinM` of their carrier mount it (the ids ordered). */
  const mountNear = (view: SimView, tick: number, out: Order[]): Set<EntityId> => {
    const ids = new Set<EntityId>();
    for (const [id, u] of view.unit.entries()) {
      if (u.side !== side || u.carrier === undefined || u.vehicle !== undefined) continue;
      const v = view.vehicle.get(u.carrier), vt = view.transform.get(u.carrier);
      if (!v || !vt || isOffMap(v) || (v.status !== "ok" && v.status !== "disarmed")) continue;
      const near = u.members.some((m) => { const s = view.soldier.get(m) as SoldierState | undefined, t = view.transform.get(m); return able(s) && s!.mount === undefined && t !== undefined && hypot2(t.x - vt.x, t.y - vt.y) <= POSTURES_AI.mountWithinM; });
      if (near) { ids.add(id); out.push({ tick, issuer: side, target: id, kind: "mount", vehicle: u.carrier }); mem.last[String(id)] = tick + secondsToTicks(POSTURES_AI.mountWaitS); }
    }
    return ids;
  };
  /** A hull waits while riders of its squads are still walking to it (until `mountUntil`). */
  const waitingRiders = (view: SimView, tick: number, id: EntityId): boolean => {
    if (tick >= (mem.mountUntil ?? 0)) return false;
    const vid = view.unit.get(id)?.vehicle;
    if (vid === undefined) return false;
    for (const [, u] of view.unit.entries()) if (u.side === side && u.carrier === vid && u.members.some((m) => { const s = view.soldier.get(m) as SoldierState | undefined; return able(s) && s!.mount === undefined; })) return true;
    return false;
  };
  /** The pursuit's orders: every mover (not in a drill, not mounting, no hull waiting for riders) is sent toward
   *  `goal` when it first starts, when it stands idle, and when its goal has moved `followRetargetM`. */
  const followOn = (view: SimView, tick: number, goal: (x: number, y: number) => { x: number; y: number } | null, footMode: string, all: boolean): Order[] => {
    const out: Order[] = [];
    mem.goals ??= {};
    for (const u of movers(view, side)) {
      const key = String(u.id);
      if (inContactDrill(view, u.id) || tick < (mem.last[key] ?? -1e9) || waitingRiders(view, tick, u.id)) continue;
      const g = goal(u.x, u.y);
      if (!g || hypot2(g.x - u.x, g.y - u.y) < 15) continue;
      const was = mem.goals[key];
      const moved = was === undefined || hypot2(g.x - was[0], g.y - was[1]) >= POSTURES_AI.followRetargetM;
      if (!all && !u.idle && was !== undefined && !(moved && tick - was[2] >= secondsToTicks(POSTURES_AI.followResendS))) continue;
      mem.goals[key] = [g.x, g.y, tick]; mem.last[key] = tick;
      out.push({ tick, issuer: side, target: u.id, kind: "move", waypoints: [{ x: g.x, y: g.y, mode: u.vehicle !== undefined ? "run" : footMode }], ...(u.hasKids ? { own: true as const } : {}) } as Order);
    }
    return out;
  };
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
        if (mem.phase === undefined) {
          if (tick % every === 0) noteContact(view, side, tick, mem, every, POSTURES_AI.delayKnownM);
          if (mem.latest === undefined) mem.latest = withdrawLatest(view, tick);
          if (!withdrawNow(view, tick)) { out.push(...main!.think(view, tick)); break; }
        }
        if (tick % every !== 0 || !exit) break;
        if (mem.phase === undefined) {
          // Squads near their carrier mount it; the hulls wait for them a little.
          mem.phase = "mount"; mem.phaseTick = tick; mem.mountUntil = tick + secondsToTicks(POSTURES_AI.mountWaitS);
          out.push(...fireFree(view, side, tick, true));
          const mounting = mountNear(view, tick, out);
          // Squads on foot in contact break it by bounds under covering fire (the rear guard), the rest run.
          const fresh = secondsToTicks(POSTURES_AI.followQuietS);
          for (const u of movers(view, side)) {
            if (u.vehicle !== undefined || mounting.has(u.id)) continue;
            const x = view.unit.get(u.id)!;
            const hot = (x.underFireTick > 0 && tick - x.underFireTick <= fresh) || (x.seenContactTick !== undefined && tick - x.seenContactTick <= fresh);
            if (!hot) continue;
            const g = zonePoint(exit, u.x, u.y, W, H), d = hypot2(g.x - u.x, g.y - u.y);
            if (d < 30) continue;
            const k = Math.min(1, POSTURES_AI.rearGuardM / d);
            out.push({ tick, issuer: side, target: u.id, kind: "withdraw", x: u.x + (g.x - u.x) * k, y: u.y + (g.y - u.y) * k });
            mem.last[String(u.id)] = tick;
          }
        }
        out.push(...sendOn(view, side, tick, mem, (x, y) => zonePoint(exit, x, y, W, H), "run", (id) => waitingRiders(view, tick, id)));
        break;
      }
      case "follow": {
        if (mem.phase === undefined) {
          if (tick % every === 0) noteContact(view, side, tick, mem, every);
          if (!followNow(tick)) { out.push(...main!.think(view, tick)); break; }
        }
        if (tick % every !== 0 || !exit) break;
        noteContact(view, side, tick, mem, every);
        const first = mem.phase === undefined;
        if (first) {
          // The pursuit: fire free, on through contact by the drill; squads near their carriers mount (the hulls wait
          // for them a little); every unit is sent at once, not only the idle ones.
          mem.phase = "follow"; mem.phaseTick = tick; mem.mountUntil = tick + secondsToTicks(POSTURES_AI.mountWaitS);
          out.push(...fireFree(view, side, tick, true));
          mountNear(view, tick, out);
        }
        const enemies = knownEnemies(view, side);
        const zx = (Math.min(exit.x0, exit.x1) + Math.max(exit.x0, exit.x1)) / 2;
        const dir = zx > W / 2 ? 1 : -1;
        const hot = mem.lastContact !== undefined && tick - Math.max(mem.lastContact, mem.lastSeen ?? -1) <= secondsToTicks(POSTURES_AI.followRunS);
        const goal = (x: number, y: number): { x: number; y: number } | null => {
          let best: { x: number; y: number } | null = null, bd: number = POSTURES_AI.followNearM;
          for (const e of enemies) { const d = hypot2(e.x - x, e.y - y); if (d < bd) { bd = d; best = e; } }
          if (best) return { x: clampTo(best.x, 1, W - 1), y: clampTo(best.y, 1, H - 1) };
          const stop = dir > 0 ? Math.min(exit.x0, exit.x1) - POSTURES_AI.followShortM : Math.max(exit.x0, exit.x1) + POSTURES_AI.followShortM;
          const tx = dir > 0 ? Math.max(x, stop) : Math.min(x, stop);
          return Math.abs(tx - x) < 15 ? null : { x: clampTo(tx, 1, W - 1), y: clampTo(y, 1, H - 1) };
        };
        out.push(...followOn(view, tick, goal, hot ? "run" : "walk", first));
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
