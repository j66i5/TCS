/**
 * SQUAD DRILLS (M4.3, SPEC 8): what a unit does as a body.
 *
 *   react to contact  A unit on the move that comes under fire anew (after a quiet spell) halts; its men take
 *                     cover and fire back on their own (M4.2 decisions, fire rules).
 *   assault           (order) The unit splits into two halves (its two teams, else alternate men). One half runs
 *                     a bound toward the objective and goes down while the other fires at it; then they swap.
 *                     Within the last stretch all rush in together and take up positions on the objective.
 *   withdraw          (order) The same, backwards: one half covers toward the enemy it knows while the other
 *                     runs back a bound; the last leg to the rally point together (a remnant of
 *                     `withdrawTogetherMen` or fewer goes back in one leg, all together).
 *   clear             (an assault on a building, M7.5e) Bounds as an assault onto a door of the house, then stacks
 *                     beside it and clears the rooms one by one with grenades (systems/clear.ts).
 *   break and rally   When half a unit's able men panic, it breaks: they run back, away from the enemy they know,
 *                     and do not obey orders or fire. Once nothing has been fired at them for a while and they
 *                     have reached the rally point they rally, shaken but steadier.
 *
 * Runs every `drills.stepSeconds`; values are data (core/behaviour.json `drills`). Doctrine profiles (M4.4)
 * will vary them by faction.
 */
import type { Drill, SoldierState, Unit } from "../components";
import type { Posture } from "../orders";
import type { SimContext } from "../context";
import { indoorAt, routeBetween, routeWaypoints } from "../interior-nav";
import type { EventSink } from "../events";
import { secondsToTicks, type EntityId } from "../ids";
import { canReport, isAble, isCaptive } from "../impair";
import { atan2, cos, hypot2, PI, sin } from "../math";

import { navFor } from "../navctx";
import { navCostAt } from "../nav";
import type { SimState } from "../state";
import { requestPosture } from "./body";
import { isCowering } from "./morale";
import { aimHeightAt, assignFireTask, friendInLine, lineOfFireTo, spareMagazines } from "./fire";
import { freeSpotNear } from "./decisions";
import { unitSoldiers } from "./orders";
import { footSoldiers } from "../mount";
import { beginStack, houseCentre, stepClear } from "./clear";
import { buildingIndex, windowPlaces } from "./occupy";

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
 * Send a man along a path to (x, y) at a run (or `mode`); he lies down facing `face` at the end. `gz`: the goal's height above
 * the ground (M7.5 review fix: a bound inside the house he is in keeps his floor; elsewhere the ground).
 */
function sendTo(ctx: SimContext, state: SimState, id: EntityId, x: number, y: number, face: { x: number; y: number } | null, gz = 0, mode = "run"): boolean {
  const t = state.transform.req(id), m = state.mover.get(id);
  if (!m) return false;
  const gx = Math.min(Math.max(x, 1), ctx.map.widthM - 1), gy = Math.min(Math.max(y, 1), ctx.map.heightM - 1);
  const leg = routeBetween(ctx, navFor(ctx, "foot").search, t.x, t.y, gx, gy, { maxExpansions: 8000, snapCells: 3 }, { sz: t.z, gz });
  if (!leg) return false;
  m.waypoints = routeWaypoints(leg, { x: 0, y: 0, mode });
  m.formation = null;
  m.endPosture = "prone";
  m.endHeading = face ? atan2(face.y - leg.goalY, face.x - leg.goalX) : null;
  return true;
}

/** An assault or a house clearing (M7.5e): bounds forward, fires at the objective. */
const forward = (d: Drill) => d.kind === "assault" || d.kind === "clear";

/** What a forward drill's covering fire is aimed at: the objective, or the middle of the house being cleared. */
function aimOf(ctx: SimContext, d: Drill): { x: number; y: number } {
  if (d.kind === "clear" && d.building !== undefined) { const bi = buildingIndex(ctx, d.building); if (bi >= 0) return houseCentre(ctx, bi); }
  return { x: d.x, y: d.y };
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
  delete d.waitFire;
  delete d.stepped;
  let groups = d.groups.map((g) => g.filter((m) => able(state.soldier.get(m))));
  // One half gone (casualties, routed men): the survivors split again and go on bounding.
  if (groups.filter((g) => g.length > 0).length < 2 && groups.flat().length >= 2) {
    const all0 = groups.flat().sort((a, b) => a - b);
    groups = [all0.filter((_, i) => i % 2 === 0), all0.filter((_, i) => i % 2 === 1)];
    d.groups = groups.map((g) => [...g]);
    d.mover = d.mover % 2;
  }
  const { movers, cover, all } = phaseMen(state, d);
  if (all.length === 0) { state.unit.req(uid).drill = null; return; }
  const enemy = knownEnemy(state, all);
  const c = movers.length > 0 ? centroid(state, movers) : centroid(state, all);
  const dist = hypot2(d.x - c.x, d.y - c.y);
  // (A remnant withdrawing, `withdrawTogetherMen` or fewer, goes back in one leg: overnight pick "defence-fallback".)
  const last = dist <= (forward(d) ? finalM : boundM) || (d.kind === "withdraw" && all.length <= D.withdrawTogetherMen);
  if (last && d.kind === "clear") {
    // A house: the men stack up beside its door instead (M7.5e), firing at it as they go.
    const aim = aimOf(ctx, d);
    beginStack(ctx, state, d, all.filter((m) => !throwing(state, m)), (key) => radio(state, uid, key, events));
    for (const m of all) if (!throwing(state, m)) fireOnPosition(ctx, state, m, aim, true, true);
    return;
  }
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
  // A bound: the others stop and fire (covering fire first: the runners' lanes keep out of its lines).
  const at = forward(d) ? aimOf(ctx, d) : enemy;
  const house = d.kind === "clear" && d.building !== undefined ? buildingIndex(ctx, d.building) : -1;
  cover.forEach((m, i) => {
    // (A runner of the last bound still on his way finishes it, unless the bound timed out; he fires from there.)
    if (!keepRunners || (state.mover.get(m)?.waypoints.length ?? 0) === 0) halt(state, m);
    if (at) coverFire(ctx, state, m, at, forward(d), i, house);
  });
  // No move without fire (overnight pick "covering-fire"): the runners go once a covering man has fired within
  // `coverFiredS`, or after `coverWaitS` (assault only; a lone man has nobody to cover him). Meanwhile they keep
  // firing from where they are.
  if (forward(d) && D.coverWaitS > 0 && cover.length > 0 && movers.length > 0 && !coverFiring(ctx, state, cover)) {
    d.waitFire = true;
    return;
  }
  runBound(ctx, state, uid, d, boundM, finalM);
  void events;
}

/** The runners and the covering men of the current phase (able men; a lone half runs with nobody covering). */
function phaseMen(state: SimState, d: Drill): { movers: EntityId[]; cover: EntityId[]; all: EntityId[] } {
  const groups = d.groups.map((g) => g.filter((m) => able(state.soldier.get(m))));
  const movers = groups.filter((g) => g.length > 0).length === 1 ? groups.flat() : groups[d.mover] ?? [];
  const cover = groups.filter((_, i) => i !== d.mover).flat().filter((m) => !movers.includes(m));
  return { movers, cover, all: groups.flat() };
}

/** Has a covering man fired within `drills.coverFiredS`? */
function coverFiring(ctx: SimContext, state: SimState, cover: EntityId[]): boolean {
  const within = secondsToTicks(ctx.catalog.behaviour.drills.coverFiredS);
  return cover.some((m) => state.tick - (state.weapon.get(m)?.lastShotTick ?? -1e9) <= within);
}

/**
 * The runners of a bound go: each from where he is, a bound toward the objective (or back), the end moved aside
 * out of the covering men's lines of fire (their safety cone and `drills.laneClearM`, on the side he starts from,
 * at most `laneShiftMaxM`: overnight pick "covering-fire").
 */
function runBound(ctx: SimContext, state: SimState, uid: EntityId, d: Drill, boundM: number, finalM: number): void {
  const D = ctx.catalog.behaviour.drills;
  const { movers, cover, all } = phaseMen(state, d);
  if (all.length === 0) return;
  const enemy = knownEnemy(state, all);
  const c = movers.length > 0 ? centroid(state, movers) : centroid(state, all);
  const dist = Math.max(1e-6, hypot2(d.x - c.x, d.y - c.y));
  const ux = (d.x - c.x) / dist, uy = (d.y - c.y) / dist;
  // Never past the start of the last rush (assault) or the rally point (withdraw).
  const step = Math.max(1, Math.min(boundM, dist - (forward(d) ? finalM : 0)));
  const face = forward(d) ? aimOf(ctx, d) : enemy;
  // The covering men's lines of fire: from each to the point he fires at.
  const lines: { x: number; y: number; ux: number; uy: number; len: number }[] = [];
  for (const m of cover) {
    const f = state.fire.get(m);
    if (!f) continue;
    const t = state.transform.req(m), len = hypot2(f.x - t.x, f.y - t.y);
    if (len > 1) lines.push({ x: t.x, y: t.y, ux: (f.x - t.x) / len, uy: (f.y - t.y) / len, len });
  }
  const sinCone = sin((ctx.catalog.shooting.fire.safetyConeDeg * PI) / 180), reach = Math.max(0.7, ctx.ballistics.bodyReachM);
  for (const m of movers) {
    if (throwing(state, m)) continue; // he goes with the next bound
    state.fire.delete(m);
    const t = state.transform.req(m);
    let bx = t.x + ux * step, by = t.y + uy * step;
    if (lines.length > 0 && D.laneShiftMaxM > 0) {
      const x0 = bx, y0 = by;
      for (let pass = 0; pass < 2; pass++) for (const l of lines) {
        const along = (bx - l.x) * l.ux + (by - l.y) * l.uy;
        if (along <= 0 || along >= l.len) continue;
        const across = -(bx - l.x) * l.uy + (by - l.y) * l.ux, need = reach + along * sinCone + D.laneClearM;
        if (Math.abs(across) >= need) continue;
        // (To the side of the line he starts from: he does not cross it.)
        const from = -(t.x - l.x) * l.uy + (t.y - l.y) * l.ux;
        const side = from > 0.5 ? 1 : from < -0.5 ? -1 : across >= 0 ? 1 : -1;
        const shift = side * need - across;
        bx += -l.uy * shift; by += l.ux * shift;
      }
      if (hypot2(bx - x0, by - y0) > D.laneShiftMaxM) { bx = x0; by = y0; }
    }
    const bi = t.z > 0 ? indoorAt(ctx, t.x, t.y) : -1;
    sendTo(ctx, state, m, bx, by, face, bi >= 0 && indoorAt(ctx, bx, by) === bi ? t.z : 0);
  }
  // Assault fire (package D): within assaultFireM of the objective the men bounding forward fire as they go.
  if (forward(d) && dist <= ctx.catalog.behaviour.soldier.assaultFireM) { const aim = aimOf(ctx, d); for (const m of movers) fireOnPosition(ctx, state, m, aim, true, true); }
}

/**
 * A covering man's fire (overnight pick "covering-fire"): an enemy he knows within `drills.coverTargetM` of the
 * position `at` that he has a line of fire to (from any posture he may take); else one whose cover he can fire into
 * (`suppressShortM`); else the position itself if he can reach it so; else as before (`fireOnPosition`). The `k`th
 * covering man starts his search at the `k`th enemy, so the fire spreads over the position.
 */
function coverFire(ctx: SimContext, state: SimState, m: EntityId, at: { x: number; y: number }, assault: boolean, k: number, house = -1): boolean {
  const s = state.soldier.req(m);
  const cands = coverTargets(ctx, s, at);
  const postures: Posture[] = isCowering(s) ? ["prone"] : ["prone", "crouching", "standing"];
  let pick: (typeof cands)[number] | null = null, pickQ = 0;
  for (let j = 0; j < cands.length && pickQ < 2; j++) {
    const c = cands[(k + j) % cands.length]!, q = lineFor(ctx, state, m, c.x, c.y, aimHeightAt(ctx, c), postures);
    if (q > pickQ) { pick = c; pickQ = q; }
  }
  const h = assault ? 0.5 : ctx.catalog.shooting.fire.aimPointHeightM;
  const win = !pick && house >= 0 ? windowAim(ctx, state, m, house, postures) : null;
  if (pick) {
    if (assignFireTask(ctx, state, m, pick.x, pick.y, aimHeightAt(ctx, pick))) { const ft = state.fire.req(m); ft.contact = pick.target; ft.aimAuto = true; }
  } else if (win) assignFireTask(ctx, state, m, win.x, win.y, win.h);
  else if (lineFor(ctx, state, m, at.x, at.y, h, postures) > 0) assignFireTask(ctx, state, m, at.x, at.y, h);
  else { fireOnPosition(ctx, state, m, at, assault); return false; }
  const ft = state.fire.get(m);
  if (ft) ft.suppress = "drill";
  return ft !== undefined;
}

/**
 * A house being cleared (M7.5e): the window of house `bi` facing him, nearest first, that he has a line of fire into
 * (the window place just inside it, at a man's chest height on its floor; at most four tried), or null.
 */
function windowAim(ctx: SimContext, state: SimState, m: EntityId, bi: number, postures: Posture[]): { x: number; y: number; h: number } | null {
  const t = state.transform.req(m);
  const wins = windowPlaces(ctx, bi)
    .filter((w) => (t.x - w.x) * w.normalX + (t.y - w.y) * w.normalY > 2)
    .sort((a, b) => hypot2(a.x - t.x, a.y - t.y) - hypot2(b.x - t.x, b.y - t.y) || a.z - b.z);
  for (const w of wins.slice(0, 4)) {
    const h = w.z + 1.2;
    if (lineFor(ctx, state, m, w.x, w.y, h, postures) > 0) return { x: w.x, y: w.y, h };
  }
  return null;
}

/** The enemies a covering man knows within `drills.coverTargetM` of the position, nearest to it first (a few). */
function coverTargets(ctx: SimContext, s: SoldierState, at: { x: number; y: number }): SoldierState["contacts"] {
  const D = ctx.catalog.behaviour.drills;
  return s.contacts
    .filter((c) => !c.surrendered && !c.down && c.cls !== "vehicle" && hypot2(c.x - at.x, c.y - at.y) <= D.coverTargetM)
    .sort((a, b) => hypot2(a.x - at.x, a.y - at.y) - hypot2(b.x - at.x, b.y - at.y) || a.target - b.target)
    .slice(0, D.coverCandidates);
}

/**
 * His best line of fire to a point from any of `postures` (2 clear, 1 into cover near it, 0 none), none with a
 * comrade in it (another squad bounding beside his, a man of his own half); `from`: as if he were there.
 */
function lineFor(ctx: SimContext, state: SimState, m: EntityId, x: number, y: number, h: number, postures: Posture[], from?: { x: number; y: number; z: number }): number {
  if (friendInLine(ctx, state, m, x, y, 0, from)) return 0;
  let q = 0;
  for (const p of postures) { q = Math.max(q, lineOfFireTo(ctx, state, m, x, y, h, p, ctx.catalog.behaviour.drills.suppressShortM, from)); if (q === 2) break; }
  return q;
}

/**
 * A covering man with no shot from where he lies dashes a few metres aside to a spot that gives him one (outdoors,
 * on open ground, clear of comrades; overnight pick "covering-fire"). Once per bound. Returns whether he goes.
 */
function sidestep(ctx: SimContext, state: SimState, m: EntityId, at: { x: number; y: number }): boolean {
  const t = state.transform.req(m), s = state.soldier.req(m);
  if (t.z > 0 || indoorAt(ctx, t.x, t.y) >= 0) return false;
  const L = hypot2(at.x - t.x, at.y - t.y);
  if (L < 1) return false;
  const px = -(at.y - t.y) / L, py = (at.x - t.x) / L;
  const side = state.identity.req(m).side, grid = navFor(ctx, "foot").grid, minM = ctx.catalog.behaviour.soldier.minSpacingM;
  const cands = coverTargets(ctx, s, at);
  const postures: Posture[] = ["prone", "crouching"];
  for (const off of ctx.catalog.behaviour.drills.sidestepM) {
    const x = t.x + px * off, y = t.y + py * off;
    if (x < 1 || y < 1 || x > ctx.map.widthM - 1 || y > ctx.map.heightM - 1 || navCostAt(grid, x, y) <= 0 || indoorAt(ctx, x, y) >= 0) continue;
    let crowded = false;
    for (const [o, id] of state.identity.entries()) {
      // (Men aboard a vehicle take no room on the ground.)
      if (o === m || id.side !== side || !state.soldier.has(o) || state.soldier.get(o)!.mount !== undefined) continue;
      const ot = state.transform.req(o);
      if (hypot2(ot.x - x, ot.y - y) < minM) { crowded = true; break; }
    }
    if (crowded) continue;
    const from = { x, y, z: 0 };
    const target = cands.find((c) => lineFor(ctx, state, m, c.x, c.y, aimHeightAt(ctx, c), postures, from) > 0);
    if (!target && (cands.length > 0 || lineFor(ctx, state, m, at.x, at.y, 0.5, postures, from) === 0)) continue;
    // (A quick dash of a few metres: crawling there took most of the bound.)
    if (!sendTo(ctx, state, m, x, y, target ?? at, 0, "run")) continue;
    // (His fire task waits for him there; he fires when he is down again.)
    if (target && assignFireTask(ctx, state, m, target.x, target.y, aimHeightAt(ctx, target))) { const ft = state.fire.req(m); ft.contact = target.target; ft.aimAuto = true; ft.suppress = "drill"; }
    return true;
  }
  return false;
}

/**
 * Each man fires at an enemy he knows near the position `at` (the nearest to it), else at the point itself: the fire
 * spreads over the position instead of all striking its middle. `onTheMove`: assault fire while he moves (package D).
 * (A drill's task: covering fire, `suppress`.)
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
  const ft = state.fire.get(m);
  if (ft) ft.suppress = "drill";
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
  // A house clearing past its bounds (M7.5e): stacking, throwing, going in room by room.
  if (d.kind === "clear" && d.stage !== undefined) {
    stepClear(ctx, state, u, d, events, (m, at) => fireOnPosition(ctx, state, m, at, true, true), (key) => radio(state, uid, key, events));
    return;
  }
  // Covering men with no shot (no task left: his man went down; no line; a comrade in it) look for another one
  // every `coverRetaskS` (overnight pick "covering-fire"); not a rifleman down to his last magazine.
  if (!d.final && D.coverRetaskS > 0 && state.tick % secondsToTicks(D.coverRetaskS) === 0) {
    const at = forward(d) ? aimOf(ctx, d) : null;
    const house = d.kind === "clear" && d.building !== undefined ? buildingIndex(ctx, d.building) : -1;
    if (at) phaseMen(state, d).cover.forEach((m, i) => {
      if (moving(m) || state.action.has(m) || isCowering(state.soldier.req(m))) return;
      const f = state.fire.get(m), w = state.weapon.get(m), wd = w ? ctx.catalog.weapons[w.weapon] : undefined;
      if (!w || !wd) return;
      if (f && f.lineClear && !friendInLine(ctx, state, m, f.x, f.y)) return;
      if (!wd.sustained && spareMagazines(state.container.get(m), wd.feed.magazine) <= 0) return;
      if (coverFire(ctx, state, m, at, true, i, house)) return;
      // (No shot from where he lies: a few metres aside, once a bound.)
      if (D.sidestep && !(d.stepped ?? []).includes(m) && sidestep(ctx, state, m, at)) (d.stepped ??= []).push(m);
    });
  }
  if (d.waitFire === true) {
    // The runners wait for their covering fire (overnight pick "covering-fire"); the bound's time starts when they go.
    const { movers, cover } = phaseMen(state, d);
    // (Every runner pinned or panicked: the halves swap, as for a bound whose runners went down; everybody: they wait.)
    if (movers.length > 0 && movers.every((m) => isCowering(state.soldier.req(m)))) {
      if (all.every((m) => isCowering(state.soldier.req(m)))) return;
      d.mover = (d.mover + 1) % d.groups.length;
      startPhase(ctx, state, uid, d, events, true);
      return;
    }
    if (movers.length === 0 || coverFiring(ctx, state, cover) || state.tick - d.phaseTick >= secondsToTicks(D.coverWaitS)) {
      delete d.waitFire;
      d.phaseTick = state.tick;
      runBound(ctx, state, uid, d, doctrine(ctx, state, uid, "boundM", D.boundM), doctrine(ctx, state, uid, "finalAssaultM", D.finalM));
    }
    return;
  }
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
