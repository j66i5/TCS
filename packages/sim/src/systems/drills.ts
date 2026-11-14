/**
 * SQUAD DRILLS (M4.3, SPEC 8): what a unit does as a body.
 *
 *   react to contact  A unit on the move that comes under fire anew (after a quiet spell) halts; its men take
 *                     cover and fire back on their own (M4.2 decisions, fire rules).
 *   assault           (order) The unit splits into two halves (its two teams, else alternate men). One half runs
 *                     a bound toward the objective and goes down while the other fires at it; then they swap.
 *                     Within the last stretch all rush in together and take up positions on the objective.
 *   withdraw          (order) The same, backwards: one half covers toward the enemy it knows while the other
 *                     runs back a bound; the last leg to the rally point together.
 *   break and rally   When half a unit's able men panic, it breaks: they run back, away from the enemy they know,
 *                     and do not obey orders or fire. Once nothing has been fired at them for a while and they
 *                     have reached the rally point they rally, shaken but steadier.
 *
 * Runs every `drills.stepSeconds`; values are data (core/behaviour.json `drills`). Doctrine profiles (M4.4)
 * will vary them by faction.
 */
import type { Drill, SoldierState, Unit } from "../components";
import type { SimContext } from "../context";
import { indoorAt, routeBetween, routeWaypoints } from "../interior-nav";
import type { EventSink } from "../events";
import { secondsToTicks, type EntityId } from "../ids";
import { canReport, isAble, isCaptive } from "../impair";
import { atan2, cos, hypot2, PI, sin } from "../math";

import { navFor } from "../navctx";
import type { SimState } from "../state";
import { requestPosture } from "./body";
import { isCowering } from "./morale";
import { aimHeightAt, assignFireTask } from "./fire";
import { freeSpotNear } from "./decisions";
import { unitSoldiers } from "./orders";
import { footSoldiers } from "../mount";

const able = (s: SoldierState | undefined) => isAble(s) && s!.mental.behaviour !== "routed";

function radio(state: SimState, uid: EntityId, key: string, events: EventSink): void {
  const u = state.unit.req(uid);
  // mounted: ok the radio reaches every man
  const from = u.leader !== null && canReport(state.soldier.get(u.leader)) ? u.leader : unitSoldiers(state, uid).find((m) => canReport(state.soldier.get(m)));
  if (from !== undefined) events.emit({ kind: "radio", tick: state.tick, side: u.side, from, key, params: { callsign: u.callsign } });
}

function topOf(state: SimState, uid: EntityId): EntityId {
  let u = uid;
  for (let p = state.unit.get(u)?.parent ?? null; p !== null; p = state.unit.get(u)?.parent ?? null) u = p;
  return u;
}

/**
 * Send a man along a path to (x, y) at a run; he lies down facing `face` at the end. `gz`: the goal's height above
 * the ground (M7.5 review fix: a bound inside the house he is in keeps his floor; elsewhere the ground).
 */
function sendTo(ctx: SimContext, state: SimState, id: EntityId, x: number, y: number, face: { x: number; y: number } | null, gz = 0): boolean {
  const t = state.transform.req(id), m = state.mover.get(id);
  if (!m) return false;
  const gx = Math.min(Math.max(x, 1), ctx.map.widthM - 1), gy = Math.min(Math.max(y, 1), ctx.map.heightM - 1);
  const leg = routeBetween(ctx, navFor(ctx, "foot").search, t.x, t.y, gx, gy, { maxExpansions: 8000, snapCells: 3 }, { sz: t.z, gz });
  if (!leg) return false;
  m.waypoints = routeWaypoints(leg, { x: 0, y: 0, mode: "run" });
  m.formation = null;
  m.endPosture = "prone";
  m.endHeading = face ? atan2(face.y - leg.goalY, face.x - leg.goalX) : null;
  return true;
}

/** Is he in the middle of throwing a grenade (the drill does not move him off it)? */
function throwing(state: SimState, id: EntityId): boolean {
  return state.action.get(id)?.kind === "grenade";
}

function halt(state: SimState, id: EntityId): void {
  const m = state.mover.get(id);
  if (m) { m.waypoints = []; m.speedMps = 0; m.formation = null; m.endPosture = null; m.endHeading = null; }
}

/** Where the enemy is, as these men know him: the mean of their freshest contacts (null if none). */
function knownEnemy(state: SimState, men: EntityId[]): { x: number; y: number } | null {
  let sx = 0, sy = 0, n = 0;
  for (const id of men) {
    const s = state.soldier.get(id);
    if (!s) continue;
    for (const c of s.contacts) { if (c.surrendered || c.down) continue; sx += c.x; sy += c.y; n++; }
  }
  return n > 0 ? { x: sx / n, y: sy / n } : null;
}

function centroid(state: SimState, men: EntityId[]): { x: number; y: number } {
  let sx = 0, sy = 0;
  for (const id of men) { const t = state.transform.req(id); sx += t.x; sy += t.y; }
  return { x: sx / men.length, y: sy / men.length };
}

/** The two halves for a bounding drill: its first two sub-units if it has them, else alternate men. */
export function drillGroups(state: SimState, uid: EntityId): EntityId[][] {
  const u = state.unit.req(uid);
  const kids = u.children.map((c) => footSoldiers(state, c).filter((m) => able(state.soldier.get(m)))).filter((g) => g.length > 0);
  if (kids.length >= 2) {
    const own = u.members.filter((m) => able(state.soldier.get(m)));
    const rest = kids.slice(2).flat();
    return [[...own, ...kids[0]!].sort((a, b) => a - b), [...kids[1]!, ...rest].sort((a, b) => a - b)];
  }
  const all = footSoldiers(state, uid).filter((m) => able(state.soldier.get(m)));
  return [all.filter((_, i) => i % 2 === 0), all.filter((_, i) => i % 2 === 1)].filter((g) => g.length > 0);
}

/** Take these men out of any drill held by a unit above `uid` (an order to a sub-unit or a man comes first). */
export function releaseFromParentDrills(state: SimState, uid: EntityId, men: EntityId[]): void {
  const set = new Set(men);
  for (let p = state.unit.get(uid)?.parent ?? null; p !== null; p = state.unit.get(p)?.parent ?? null) {
    const d = state.unit.get(p)?.drill;
    if (!d || d.kind === "rout") continue;
    d.groups = d.groups.map((g) => g.filter((m) => !set.has(m)));
    if (d.groups.every((g) => g.length === 0)) state.unit.req(p).drill = null;
  }
}

/** Clear the drill of a unit and its sub-units (an order replaces it). */
export function clearDrills(state: SimState, uid: EntityId): void {
  const u = state.unit.get(uid);
  if (!u) return;
  if (u.drill?.kind !== "rout") u.drill = null;
  // Getting in or out (M7.2) is replaced by the new order too (bailing out is not).
  if (u.boarding && u.boarding.kind !== "bailOut") delete u.boarding;
  u.children.forEach((c) => clearDrills(state, c));
}

/** A drill value from the unit's doctrine (faction data), else the general default. */
function doctrine(ctx: SimContext, state: SimState, uid: EntityId, key: string, fallback: number): number {
  const v = ctx.catalog.factions[state.unit.req(uid).faction]?.doctrine[key];
  return v !== undefined && Number.isFinite(v) ? v : fallback;
}

function startPhase(ctx: SimContext, state: SimState, uid: EntityId, d: Drill, events: EventSink, keepRunners = false): void {
  const D = ctx.catalog.behaviour.drills;
  const boundM = doctrine(ctx, state, uid, "boundM", D.boundM), finalM = doctrine(ctx, state, uid, "finalAssaultM", D.finalM);
  d.phaseTick = state.tick;
  let groups = d.groups.map((g) => g.filter((m) => able(state.soldier.get(m))));
  // One half gone (casualties, routed men): the survivors split again and go on bounding.
  if (groups.filter((g) => g.length > 0).length < 2 && groups.flat().length >= 2) {
    const all0 = groups.flat().sort((a, b) => a - b);
    groups = [all0.filter((_, i) => i % 2 === 0), all0.filter((_, i) => i % 2 === 1)];
    d.groups = groups.map((g) => [...g]);
    d.mover = d.mover % 2;
  }
  // A lone man bounds on his own (nobody to cover him).
  const movers = groups.filter((g) => g.length > 0).length === 1 ? groups.flat() : groups[d.mover] ?? [];
  const cover = groups.filter((_, i) => i !== d.mover).flat();
  const all = groups.flat();
  if (all.length === 0) { state.unit.req(uid).drill = null; return; }
  const enemy = knownEnemy(state, all);
  const c = movers.length > 0 ? centroid(state, movers) : centroid(state, all);
  const dist = hypot2(d.x - c.x, d.y - c.y);
  const last = dist <= (d.kind === "assault" ? finalM : boundM);
  if (last) {
    // The last rush onto the objective (or the last leg back): everyone together, spread around the point.
    d.final = true;
    d.phaseTick = state.tick;
    const face = d.kind === "assault" ? enemy ?? { x: d.x + (d.x - c.x), y: d.y + (d.y - c.y) } : enemy;
    // (Spread so that neighbours keep soldier.minSpacingM apart, package B.)
    const spread = Math.max(D.spreadM, (ctx.catalog.behaviour.soldier.minSpacingM * all.length) / (2 * PI));
    all.forEach((m, i) => {
      // (A man throwing a grenade finishes the throw first, package D: before, the drill's next rush broke off
      // nearly every grenade the AI ordered.)
      if (throwing(state, m)) return;
      state.fire.delete(m);
      const a = (i * 2 * PI) / all.length, r = all.length > 1 ? spread : 0;
      const p = freeSpotNear(ctx, state, m, d.x + r * cos(a), d.y + r * sin(a));
      sendTo(ctx, state, m, p.x, p.y, face);
      // (The last rush fires as it goes, package D: fight through the position.)
      if (d.kind === "assault") fireOnPosition(ctx, state, m, { x: d.x, y: d.y }, true, true);
    });
    return;
  }
  // A bound: the movers run on (each from where he is), the others stop and fire.
  const ux = (d.x - c.x) / dist, uy = (d.y - c.y) / dist;
  // Never past the start of the last rush (assault) or the rally point (withdraw).
  const step = Math.max(1, Math.min(boundM, dist - (d.kind === "assault" ? finalM : 0)));
  const face = d.kind === "assault" ? { x: d.x, y: d.y } : enemy;
  for (const m of movers) {
    if (throwing(state, m)) continue; // he goes with the next bound
    state.fire.delete(m);
    const t = state.transform.req(m);
    const bx = t.x + ux * step, by = t.y + uy * step, bi = t.z > 0 ? indoorAt(ctx, t.x, t.y) : -1;
    sendTo(ctx, state, m, bx, by, face, bi >= 0 && indoorAt(ctx, bx, by) === bi ? t.z : 0);
  }
  const at = d.kind === "assault" ? { x: d.x, y: d.y } : enemy;
  for (const m of cover) {
    // (A runner of the last bound still on his way finishes it, unless the bound timed out; he fires from there.)
    if (!keepRunners || (state.mover.get(m)?.waypoints.length ?? 0) === 0) halt(state, m);
    if (at) fireOnPosition(ctx, state, m, at, d.kind === "assault");
  }
  // Assault fire (package D): within assaultFireM of the objective the men bounding forward fire as they go.
  if (d.kind === "assault" && dist <= ctx.catalog.behaviour.soldier.assaultFireM) for (const m of movers) fireOnPosition(ctx, state, m, at!, true, true);
  void events;
}

/**
 * Each man fires at an enemy he knows near the position `at` (the nearest to it), else at the point itself: the fire
 * spreads over the position instead of all striking its middle. `onTheMove`: assault fire while he moves (package D).
 */
function fireOnPosition(ctx: SimContext, state: SimState, m: EntityId, at: { x: number; y: number }, assault: boolean, onTheMove = false): void {
  const s = state.soldier.req(m);
  let best: { target: EntityId; x: number; y: number; z?: number } | null = null, bestD = 40;
  for (const c of s.contacts) {
    if (c.surrendered || c.down || c.cls === "vehicle") continue; // a man he knows has given up (M6.6) or is down (package A) is not fired at
    const dd = hypot2(c.x - at.x, c.y - at.y);
    if (dd < bestD) { bestD = dd; best = c; }
  }
  if (best) {
    if (assignFireTask(ctx, state, m, best.x, best.y, aimHeightAt(ctx, best))) { const ft = state.fire.req(m); ft.contact = best.target; ft.aimAuto = true; if (onTheMove) ft.onTheMove = true; }
  } else if (assignFireTask(ctx, state, m, at.x, at.y, assault ? 0.5 : ctx.catalog.shooting.fire.aimPointHeightM) && onTheMove) state.fire.req(m).onTheMove = true;
}

function stepDrill(ctx: SimContext, state: SimState, uid: EntityId, u: Unit, events: EventSink): void {
  const D = ctx.catalog.behaviour.drills, d = u.drill!;
  const moving = (m: EntityId) => (state.mover.get(m)?.waypoints.length ?? 0) > 0;
  if (d.kind === "rout") {
    const men = footSoldiers(state, uid).filter((m) => isAble(state.soldier.get(m)) && state.soldier.req(m).mental.behaviour === "routed");
    // Every runner gave up (M6.6): the unit stays broken, nobody rallies.
    // mounted: ok a prisoner is never aboard
    if (men.length === 0 && unitSoldiers(state, uid).some((m) => isCaptive(state.soldier.get(m)))) { u.drill = null; return; }
    if (men.length === 0 || (!men.some(moving) && state.tick - u.underFireTick >= secondsToTicks(D.rallyQuietSeconds))) {
      for (const m of men) {
        const s = state.soldier.req(m);
        events.emit({ kind: "behaviour.changed", tick: state.tick, soldier: m, from: "routed", to: "cautious" });
        s.mental.behaviour = "cautious";
        s.mental.stress *= D.rallyStressFactor;
        s.mental.suppression = 0;
        requestPosture(ctx, state, m, "prone");
      }
      u.broken = false; u.drill = null;
      radio(state, uid, "radio.rallied", events);
    }
    return;
  }
  if (d.phaseTick < 0) { startPhase(ctx, state, uid, d, events); return; }
  const all = d.groups.flat().filter((m) => able(state.soldier.get(m)));
  if (all.length === 0) { u.drill = null; return; }
  if (d.final) {
    // (Men pinned on the way keep their paths: the drill ends anyway after twice the bound time.)
    if (!all.some(moving) || state.tick - d.phaseTick >= 2 * secondsToTicks(D.phaseTimeoutSeconds)) {
      u.drill = null;
      radio(state, uid, d.kind === "assault" ? "radio.objectiveTaken" : "radio.withdrawn", events);
    }
    return;
  }
  // A mover pinned or panicked on the way has gone down where he is: the others do not wait for him (balance
  // pass 2026-11-13: one pinned man held his whole squad's next rush for the full phase timeout).
  const movers = (d.groups[d.mover] ?? []).filter((m) => able(state.soldier.get(m)) && !isCowering(state.soldier.req(m)));
  // (Overnight pick "assault-tempo" 2026-11-14: the halves swap once `boundDoneShare` of the runners are down (1 =
  // all; 2/3 cost the attack lab), or when the last one has trailed the others by `stragglerS`: one slow man held
  // three rushes in a row to the timeout. He finishes his rush.)
  const going = movers.filter(moving).length;
  if (going === 1 && movers.length > 1) d.trailTick ??= state.tick; else delete d.trailTick;
  const done = movers.length - going >= Math.ceil(D.boundDoneShare * movers.length - 0.01) || (d.trailTick !== undefined && state.tick - d.trailTick >= secondsToTicks(D.stragglerS));
  const timedOut = state.tick - d.phaseTick >= secondsToTicks(D.phaseTimeoutSeconds);
  // (Every man left pinned or panicked: nobody can run the next bound; the drill waits instead of starting a new
  // phase, and a new route search for each man, every half second.)
  if (!timedOut && movers.length === 0 && all.every((m) => isCowering(state.soldier.req(m)))) return;
  if (going === 0 || done || timedOut) {
    delete d.trailTick;
    d.mover = (d.mover + 1) % d.groups.length;
    startPhase(ctx, state, uid, d, events, !timedOut);
  }
}

/** Break a unit: its men run back from the enemy they know. */
function breakUnit(ctx: SimContext, state: SimState, uid: EntityId, events: EventSink): void {
  const D = ctx.catalog.behaviour.drills, u = state.unit.req(uid);
  const men = footSoldiers(state, uid).filter((m) => isAble(state.soldier.get(m)));
  const c = centroid(state, men);
  const enemy = knownEnemy(state, men);
  let ax = 0, ay = 0;
  if (enemy) { const L = hypot2(c.x - enemy.x, c.y - enemy.y) || 1; ax = (c.x - enemy.x) / L; ay = (c.y - enemy.y) / L; }
  const rx = Math.min(Math.max(c.x + ax * D.rallyDistanceM, 5), ctx.map.widthM - 5), ry = Math.min(Math.max(c.y + ay * D.rallyDistanceM, 5), ctx.map.heightM - 5);
  u.broken = true;
  for (const k of u.children) clearDrills(state, k);
  u.drill = { kind: "rout", x: rx, y: ry, groups: [], mover: 0, phaseTick: state.tick, final: true };
  for (const m of men) rout(ctx, state, m, u.drill, events, enemy);
  radio(state, uid, "radio.broken", events);
}

function rout(ctx: SimContext, state: SimState, m: EntityId, d: Drill, events: EventSink, enemy: { x: number; y: number } | null): void {
  const s = state.soldier.req(m);
  const from = s.mental.behaviour;
  s.mental.behaviour = "routed";
  events.emit({ kind: "behaviour.changed", tick: state.tick, soldier: m, from, to: "routed" });
  state.fire.delete(m);
  s.intent = null;
  const t = state.transform.req(m);
  // Each runs to his own spot near the rally point (kept apart as they were), not on another man's place (package B).
  const c = freeSpotNear(ctx, state, m, d.x + (t.x - d.x) * 0.05, d.y + (t.y - d.y) * 0.05);
  sendTo(ctx, state, m, c.x, c.y, enemy);
}

/**
 * Is this unit on its way into a house (an occupy, or a move that ends indoors)? Contact does not stop it: the men
 * finish going in, where the walls are their cover (package C).
 */
function enteringHouse(ctx: SimContext, state: SimState, uid: EntityId): boolean {
  for (const m of footSoldiers(state, uid)) {
    const w = state.mover.get(m)?.waypoints;
    const last = w && w.length > 0 ? w[w.length - 1]! : null;
    if (last && isAble(state.soldier.get(m)) && indoorAt(ctx, last.x, last.y) >= 0) return true;
  }
  return false;
}

/**
 * The men on foot carrying this unit's move into `out`: its own men, and the men on their way (with waypoints) of
 * sub-units without a move or drill of their own (a move given to the whole platoon); returns when they last came
 * under fire anew (`Unit.ownContactTick`; a crew also by hits on its own hull, `contactTick`). A halted squad under
 * the platoon is not part of its headquarters' move.
 */
function moveGroup(state: SimState, uid: EntityId, out: EntityId[], sub = false): number {
  const u = state.unit.get(uid);
  if (!u) return -1e9;
  const n0 = out.length;
  for (const m of u.members) if (state.soldier.get(m)?.mount === undefined && (!sub || (state.mover.get(m)?.waypoints.length ?? 0) > 0)) out.push(m);
  let t = out.length > n0 || !sub ? (u.ownContactTick ?? -1e9) : -1e9;
  if (u.vehicle !== undefined && u.contactTick > t) t = u.contactTick;
  for (const c of u.children) {
    const cu = state.unit.get(c);
    if (!cu || cu.moving || cu.drill) continue;
    const ct = moveGroup(state, c, out, true);
    if (ct > t) t = ct;
  }
  return t;
}

/** Has a unit of the same top unit, outside this move, come under fire anew with its men within `rangeM`? */
function neighbourInContact(state: SimState, uid: EntityId, group: EntityId[], fresh: (t: number) => boolean, rangeM: number): boolean {
  if (rangeM <= 0) return false;
  const mine = group.filter((m) => able(state.soldier.get(m)));
  if (mine.length === 0) return false;
  let c: { x: number; y: number } | null = null;
  const inGroup = new Set(group);
  const stack: EntityId[] = [topOf(state, uid)];
  while (stack.length > 0) {
    const wid = stack.pop()!, w = state.unit.get(wid);
    if (!w) continue;
    for (let i = w.children.length - 1; i >= 0; i--) stack.push(w.children[i]!);
    if (wid === uid || !fresh(w.ownContactTick ?? -1e9)) continue;
    const theirs = w.members.filter((m) => !inGroup.has(m) && able(state.soldier.get(m)) && state.soldier.get(m)!.mount === undefined);
    if (theirs.length === 0) continue;
    c ??= centroid(state, mine);
    const o = centroid(state, theirs);
    if (hypot2(o.x - c.x, o.y - c.y) <= rangeM) return true;
  }
  return false;
}

export function drillSystem(ctx: SimContext, state: SimState, events: EventSink): void {
  const D = ctx.catalog.behaviour.drills;
  if (state.tick % Math.max(1, secondsToTicks(D.stepSeconds)) !== 0) return;
  for (const [uid, u] of state.unit.entries()) {
    // ---- break: half the able men of a top unit panic
    if (u.parent === null) {
      const men = footSoldiers(state, uid).filter((m) => isAble(state.soldier.get(m)));
      const panicked = men.filter((m) => state.soldier.req(m).mental.behaviour === "panicked");
      if (!u.broken && men.length > 0 && panicked.length > 0 && panicked.length >= D.breakPanickedFraction * men.length) { breakUnit(ctx, state, uid, events); continue; }
      // In a broken unit, a man who panics later runs too.
      if (u.broken && u.drill?.kind === "rout") for (const m of panicked) rout(ctx, state, m, u.drill, events, knownEnemy(state, men));
    }
    // ---- react to contact: on the move, fired upon anew since the move began; only the men carrying this move
    // (its own, and sub-units without a move of their own) or a unit of the platoon close by (reactNeighbourM)
    if (D.reactToContact && u.moving && !u.drill && !u.broken && u.onContact !== "push") {
      const group: EntityId[] = [];
      const fresh = (t: number) => t > u.moveTick && state.tick - t <= secondsToTicks(2 * D.stepSeconds);
      if ((fresh(moveGroup(state, uid, group)) || neighbourInContact(state, uid, group, fresh, D.reactNeighbourM)) && !enteringHouse(ctx, state, uid)) {
        u.moving = false;
        const goals = new Map<EntityId, { x: number; y: number }>();
        for (const m of group) {
          const s = state.soldier.get(m);
          if (!able(s)) continue;
          const w = state.mover.get(m)?.waypoints;
          if (w && w.length > 0) goals.set(m, { x: w[w.length - 1]!.x, y: w[w.length - 1]!.y });
          halt(state, m);
          requestPosture(ctx, state, m, "prone");
          s!.homePosture = "prone"; // (down where he is: his fire position now, package C)
        }
        radio(state, uid, "radio.contactReact", events);
        // Standing rule "fall back" (M5): break contact away from the enemy they know.
        if (u.onContact === "back") {
          const men = footSoldiers(state, uid).filter((m) => able(state.soldier.get(m)));
          let enemy = knownEnemy(state, men);
          // Fired upon by an enemy nobody has placed: fall back the way they came (away from where they were going).
          if (!enemy && men.length > 0) {
            const c = centroid(state, men), lead = u.leader !== null ? goals.get(u.leader) : undefined;
            if (lead) enemy = { x: lead.x, y: lead.y };
            else enemy = { x: c.x, y: c.y - 1 };
          }
          if (enemy && men.length > 0) {
            const c = centroid(state, men), L = hypot2(c.x - enemy.x, c.y - enemy.y) || 1;
            const rx = Math.min(Math.max(c.x + ((c.x - enemy.x) / L) * D.fallBackM, 5), ctx.map.widthM - 5);
            const ry = Math.min(Math.max(c.y + ((c.y - enemy.y) / L) * D.fallBackM, 5), ctx.map.heightM - 5);
            const groups = drillGroups(state, uid);
            if (groups.length > 0) u.drill = { kind: "withdraw", x: rx, y: ry, groups, mover: 0, phaseTick: -1, final: false };
          }
        }
      }
    }
    if (u.drill) stepDrill(ctx, state, uid, u, events);
  }
}
