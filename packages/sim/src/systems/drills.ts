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
import type { EventSink } from "../events";
import { secondsToTicks, type EntityId } from "../ids";
import { canReport, isAble } from "../impair";
import { atan2, cos, hypot2, PI, sin } from "../math";
import { findPath } from "../nav";
import { navFor } from "../navctx";
import type { SimState } from "../state";
import { requestPosture } from "./body";
import { assignFireTask } from "./fire";
import { unitSoldiers } from "./orders";

const able = (s: SoldierState | undefined) => isAble(s) && s!.mental.behaviour !== "routed";

function radio(state: SimState, uid: EntityId, key: string, events: EventSink): void {
  const u = state.unit.req(uid);
  const from = u.leader !== null && canReport(state.soldier.get(u.leader)) ? u.leader : unitSoldiers(state, uid).find((m) => canReport(state.soldier.get(m)));
  if (from !== undefined) events.emit({ kind: "radio", tick: state.tick, side: u.side, from, key, params: { callsign: u.callsign } });
}

function topOf(state: SimState, uid: EntityId): EntityId {
  let u = uid;
  for (let p = state.unit.get(u)?.parent ?? null; p !== null; p = state.unit.get(u)?.parent ?? null) u = p;
  return u;
}

/** Send a man along a path to (x, y) at a run; he lies down facing `face` at the end. */
function sendTo(ctx: SimContext, state: SimState, id: EntityId, x: number, y: number, face: { x: number; y: number } | null): boolean {
  const t = state.transform.req(id), m = state.mover.get(id);
  if (!m) return false;
  const gx = Math.min(Math.max(x, 1), ctx.map.widthM - 1), gy = Math.min(Math.max(y, 1), ctx.map.heightM - 1);
  const leg = findPath(navFor(ctx, "foot").search, t.x, t.y, gx, gy, { maxExpansions: 8000, snapCells: 3 });
  if (!leg) return false;
  m.waypoints = [];
  for (let i = 0; i < leg.points.length; i += 2) m.waypoints.push({ x: leg.points[i]!, y: leg.points[i + 1]!, mode: "run" });
  m.formation = null;
  m.endPosture = "prone";
  m.endHeading = face ? atan2(face.y - leg.goalY, face.x - leg.goalX) : null;
  return true;
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
    for (const c of s.contacts) { sx += c.x; sy += c.y; n++; }
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
  const kids = u.children.map((c) => unitSoldiers(state, c).filter((m) => able(state.soldier.get(m)))).filter((g) => g.length > 0);
  if (kids.length >= 2) {
    const own = u.members.filter((m) => able(state.soldier.get(m)));
    const rest = kids.slice(2).flat();
    return [[...own, ...kids[0]!].sort((a, b) => a - b), [...kids[1]!, ...rest].sort((a, b) => a - b)];
  }
  const all = unitSoldiers(state, uid).filter((m) => able(state.soldier.get(m)));
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
  u.children.forEach((c) => clearDrills(state, c));
}

/** A drill value from the unit's doctrine (faction data), else the general default. */
function doctrine(ctx: SimContext, state: SimState, uid: EntityId, key: string, fallback: number): number {
  const v = ctx.catalog.factions[state.unit.req(uid).faction]?.doctrine[key];
  return v !== undefined && Number.isFinite(v) ? v : fallback;
}

function startPhase(ctx: SimContext, state: SimState, uid: EntityId, d: Drill, events: EventSink): void {
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
    all.forEach((m, i) => {
      state.fire.delete(m);
      const a = (i * 2 * PI) / all.length, r = all.length > 1 ? D.spreadM : 0;
      sendTo(ctx, state, m, d.x + r * cos(a), d.y + r * sin(a), face);
    });
    return;
  }
  // A bound: the movers run on (each from where he is), the others stop and fire.
  const ux = (d.x - c.x) / dist, uy = (d.y - c.y) / dist;
  // Never past the start of the last rush (assault) or the rally point (withdraw).
  const step = Math.max(1, Math.min(boundM, dist - (d.kind === "assault" ? finalM : 0)));
  const face = d.kind === "assault" ? { x: d.x, y: d.y } : enemy;
  for (const m of movers) {
    state.fire.delete(m);
    const t = state.transform.req(m);
    sendTo(ctx, state, m, t.x + ux * step, t.y + uy * step, face);
  }
  const at = d.kind === "assault" ? { x: d.x, y: d.y } : enemy;
  for (const m of cover) {
    halt(state, m);
    if (!at) continue;
    // Each man fires at an enemy he knows near the objective (the nearest to it), else at the point itself:
    // the fire spreads over the position instead of all striking its middle.
    const s = state.soldier.req(m);
    let best: { target: EntityId; x: number; y: number } | null = null, bestD = 40;
    for (const c of s.contacts) {
      const dd = hypot2(c.x - at.x, c.y - at.y);
      if (dd < bestD) { bestD = dd; best = c; }
    }
    if (best) {
      if (assignFireTask(ctx, state, m, best.x, best.y, ctx.catalog.shooting.fire.aimPointHeightM)) state.fire.req(m).contact = best.target;
    } else assignFireTask(ctx, state, m, at.x, at.y, d.kind === "assault" ? 0.5 : ctx.catalog.shooting.fire.aimPointHeightM);
  }
  void events;
}

function stepDrill(ctx: SimContext, state: SimState, uid: EntityId, u: Unit, events: EventSink): void {
  const D = ctx.catalog.behaviour.drills, d = u.drill!;
  const moving = (m: EntityId) => (state.mover.get(m)?.waypoints.length ?? 0) > 0;
  if (d.kind === "rout") {
    const men = unitSoldiers(state, uid).filter((m) => isAble(state.soldier.get(m)) && state.soldier.req(m).mental.behaviour === "routed");
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
  const movers = (d.groups[d.mover] ?? []).filter((m) => able(state.soldier.get(m)));
  if (!movers.some(moving) || state.tick - d.phaseTick >= secondsToTicks(D.phaseTimeoutSeconds)) {
    d.mover = (d.mover + 1) % d.groups.length;
    startPhase(ctx, state, uid, d, events);
  }
}

/** Break a unit: its men run back from the enemy they know. */
function breakUnit(ctx: SimContext, state: SimState, uid: EntityId, events: EventSink): void {
  const D = ctx.catalog.behaviour.drills, u = state.unit.req(uid);
  const men = unitSoldiers(state, uid).filter((m) => isAble(state.soldier.get(m)));
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
  // Each runs to his own spot near the rally point (kept apart as they were).
  const c = { x: d.x + (t.x - d.x) * 0.05, y: d.y + (t.y - d.y) * 0.05 };
  sendTo(ctx, state, m, c.x, c.y, enemy);
}

export function drillSystem(ctx: SimContext, state: SimState, events: EventSink): void {
  const D = ctx.catalog.behaviour.drills;
  if (state.tick % Math.max(1, secondsToTicks(D.stepSeconds)) !== 0) return;
  for (const [uid, u] of state.unit.entries()) {
    // ---- break: half the able men of a top unit panic
    if (u.parent === null) {
      const men = unitSoldiers(state, uid).filter((m) => isAble(state.soldier.get(m)));
      const panicked = men.filter((m) => state.soldier.req(m).mental.behaviour === "panicked");
      if (!u.broken && men.length > 0 && panicked.length > 0 && panicked.length >= D.breakPanickedFraction * men.length) { breakUnit(ctx, state, uid, events); continue; }
      // In a broken unit, a man who panics later runs too.
      if (u.broken && u.drill?.kind === "rout") for (const m of panicked) rout(ctx, state, m, u.drill, events, knownEnemy(state, men));
    }
    // ---- react to contact: on the move, fired upon anew since the move began
    if (D.reactToContact && u.moving && !u.drill && !u.broken) {
      const top = state.unit.req(topOf(state, uid));
      if (u.onContact !== "push" && top.contactTick > u.moveTick && state.tick - top.contactTick <= secondsToTicks(2 * D.stepSeconds)) {
        u.moving = false;
        for (const m of unitSoldiers(state, uid)) {
          const s = state.soldier.get(m);
          if (!able(s)) continue;
          halt(state, m);
          requestPosture(ctx, state, m, "prone");
        }
        radio(state, uid, "radio.contactReact", events);
        // Standing rule "fall back" (M5): break contact away from the enemy they know.
        if (u.onContact === "back") {
          const men = unitSoldiers(state, uid).filter((m) => able(state.soldier.get(m)));
          const enemy = knownEnemy(state, men);
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
