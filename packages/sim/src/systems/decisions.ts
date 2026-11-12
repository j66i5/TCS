/**
 * SOLDIER DECISIONS (M4.2, SPEC 8): what a man does on his own, between his orders.
 *
 *   engage     He fires at an enemy he can see, within the range his weapon is used at, if his unit's fire rule
 *              allows: "free" any time, "return" once his unit has been fired upon (in the last 30 s), "hold"
 *              never. A cease-fire order holds until the unit is fired upon again. He picks the enemy who
 *              matters most: near, firing, standing. He stops when he has lost sight of him for a while.
 *              An order always comes first: he never replaces a fire task he was ordered to carry out.
 *   cover      Halted and under fire, and the enemy he knows of can see him where he lies: he runs to the
 *              nearest spot within 15 m where that enemy cannot, preferring one he can fire from on his knees.
 *   bringAmmo  A comrade has run out of spare magazines or belts: the nearest man within 30 m who has spare
 *              (more than he keeps for himself) or carries them for him runs over and hands one over.
 *
 * He never fires on his own at, nor takes cover from, an enemy he KNOWS has given up (the `surrendered` flag on
 * his own contact, M6.6) — the enemy's real state is not read for that.
 *
 * Every man decides once per `decisions.stepSeconds`, staggered by ID; values are data (core/behaviour.json).
 * Casualty care (dragging, first aid) comes with the medical system.
 */
import { startAction } from "../actions";
import type { Intent, SoldierState, Unit } from "../components";
import type { Container } from "../items";
import type { SimContext } from "../context";
import type { EventSink } from "../events";
import { secondsToTicks, TICK_HZ, type EntityId } from "../ids";
import { isAble } from "../impair";
import { sight } from "../los";
import { atan2, cos, hypot2, PI, sin } from "../math";
import { findPath } from "../nav";
import { navFor } from "../navctx";
import type { SimState } from "../state";
import { heightAt } from "../terrain";
import { assignFireTask } from "./fire";
import { isCowering } from "./morale";
import { unitSoldiers } from "./orders";

function topUnit(state: SimState, unitId: EntityId): Unit | undefined {
  let u = state.unit.get(unitId);
  while (u && u.parent !== null) { const p = state.unit.get(u.parent); if (!p) break; u = p; }
  return u;
}

function spareCount(c: Container | undefined, type: string): number {
  let n = 0;
  if (c) for (const s of c.stacks) if (s.type === type && (s.charge ?? 0) > 0) n += s.count;
  return n;
}

/** May he open fire on his own now? */
function fireAllowed(state: SimState, ctx: SimContext, unit: Unit, top: Unit): boolean {
  if (unit.fireRule === "hold") return false;
  const D = ctx.catalog.behaviour.decisions;
  const firedOnSinceCease = top.underFireTick > top.ceaseFireTick;
  if (top.ceaseFireTick > -1e9 && !firedOnSinceCease) return false;
  if (unit.fireRule === "free") return true;
  return firedOnSinceCease && state.tick - top.underFireTick <= secondsToTicks(D.underFireMemorySeconds);
}

/** The range out to which he engages on his own, by his weapon. */
function engageRange(ctx: SimContext, state: SimState, id: EntityId): number {
  const R = ctx.catalog.behaviour.decisions.engageRangeM;
  const w = state.weapon.get(id), wd = w ? ctx.catalog.weapons[w.weapon] : undefined;
  if (!wd) return 0;
  if (wd.sustained) return R.sustained;
  return wd.sights.some((s) => s.magnification >= 4) ? R.magnified : R.rifle;
}

/** The enemy that matters most to him among those he sees now: near, firing, standing up. */
function pickTarget(ctx: SimContext, state: SimState, id: EntityId, s: SoldierState, rangeM: number): { target: EntityId; x: number; y: number } | null {
  const D = ctx.catalog.behaviour.decisions;
  const me = state.transform.req(id);
  let best: { target: EntityId; x: number; y: number } | null = null, bestScore = Infinity;
  for (const c of s.contacts) {
    if (c.kind !== "seen" || state.tick - c.tick > secondsToTicks(D.seenWithinSeconds)) continue;
    if (c.surrendered) continue; // he knows this man has given up (M6.6)
    const d = hypot2(c.x - me.x, c.y - me.y);
    if (d > rangeM) continue;
    const ew = state.weapon.get(c.target), es = state.soldier.get(c.target);
    if (!es || !es.physiology.alive || es.casualty !== "none") continue;
    let score = d;
    if (ew && state.tick - ew.lastShotTick <= 3 * TICK_HZ) score *= ctx.catalog.weapons[ew.weapon]?.sustained ? 0.35 : 0.6;
    if (es.posture === "prone") score *= 1.3;
    if (score < bestScore) { bestScore = score; best = { target: c.target, x: c.x, y: c.y }; }
  }
  return best;
}

/** Is a man lying at (x, y) out of sight of an enemy at (tx, ty)? */
function coveredFrom(ctx: SimContext, x: number, y: number, tx: number, ty: number, heightM: number): boolean {
  const D = ctx.catalog.behaviour.decisions;
  const r = sight(ctx, tx, ty, heightAt(ctx.map, tx, ty) + D.threatEyeHeightM, x, y, heightAt(ctx.map, x, y) + heightM);
  return r.blockedBy !== null || r.visibility < 0.1;
}

/** The threat he takes cover from: the nearest enemy he knows to be firing, else the nearest he knows. */
function threatOf(state: SimState, id: EntityId, s: SoldierState): { x: number; y: number } | null {
  const me = state.transform.req(id);
  let best: { x: number; y: number } | null = null, bestD = Infinity;
  for (const c of s.contacts) {
    if (c.surrendered) continue; // a man he knows has given up is no threat to take cover from
    const ew = state.weapon.get(c.target);
    const firing = ew !== undefined && state.tick - ew.lastShotTick <= 5 * TICK_HZ && c.kind !== "reported";
    const d = hypot2(c.x - me.x, c.y - me.y) * (firing ? 0.5 : 1);
    if (d < bestD) { bestD = d; best = { x: c.x, y: c.y }; }
  }
  return best;
}

function seekCover(ctx: SimContext, state: SimState, id: EntityId, s: SoldierState, threat: { x: number; y: number }): boolean {
  const D = ctx.catalog.behaviour.decisions, body = ctx.catalog.body.postures;
  const me = state.transform.req(id);
  const lie = body.prone.heightM * 0.6, kneel = body.crouching.muzzleHeightM;
  if (coveredFrom(ctx, me.x, me.y, threat.x, threat.y, lie)) return false;
  const { grid, search } = navFor(ctx, "foot");
  const cands: { x: number; y: number; score: number }[] = [];
  for (let ring = 1; ring <= 5; ring++) {
    const r = (D.coverSearchM * ring) / 5;
    for (let k = 0; k < 12; k++) {
      const a = (k * PI) / 6 + (ring % 2) * (PI / 12);
      const x = me.x + cos(a) * r, y = me.y + sin(a) * r;
      if (x < 1 || y < 1 || x > ctx.map.widthM - 1 || y > ctx.map.heightM - 1) continue;
      const c = Math.floor(x / grid.cellM), rr = Math.floor(y / grid.cellM), i = rr * grid.cols + c;
      if (grid.cost[i]! <= 0 || grid.wall[i] === 1) continue;
      if (!coveredFrom(ctx, x, y, threat.x, threat.y, lie)) continue;
      // Better: a spot he can fire from on his knees over the cover (a bank, a low wall).
      const firing = !coveredFrom(ctx, x, y, threat.x, threat.y, kneel);
      cands.push({ x, y, score: r + (firing ? 0 : 8) });
    }
  }
  // The best first; one he cannot reach without a long detour is passed over for the next (at most 6 tried).
  cands.sort((p, q) => p.score - q.score || p.x - q.x || p.y - q.y);
  let best: { x: number; y: number } | null = null, leg = null as ReturnType<typeof findPath>;
  for (const cnd of cands.slice(0, 6)) {
    const l = findPath(search, me.x, me.y, cnd.x, cnd.y, { maxExpansions: 3000, snapCells: 1 });
    if (l && l.cost <= D.coverSearchM * 2.5) { best = cnd; leg = l; break; }
  }
  if (!best || !leg) return false;
  const m = state.mover.get(id);
  if (!m) return false;
  m.waypoints = [];
  for (let i = 0; i < leg.points.length; i += 2) m.waypoints.push({ x: leg.points[i]!, y: leg.points[i + 1]!, mode: "run" });
  m.formation = null;
  m.endPosture = "prone";
  m.endHeading = atan2(threat.y - best.y, threat.x - best.x);
  const task = state.fire.get(id);
  if (task) task.basePosture = "prone";
  s.intent = { kind: "cover", tick: state.tick, x: best.x, y: best.y };
  return true;
}

/** A comrade who has run out of spare: the nearest man able to bring him one goes. */
function shareAmmo(ctx: SimContext, state: SimState, events: EventSink, id: EntityId, top: EntityId): void {
  const D = ctx.catalog.behaviour.decisions;
  const w = state.weapon.get(id), wd = w ? ctx.catalog.weapons[w.weapon] : undefined;
  if (!w || !wd) return;
  const type = wd.feed.magazine;
  if (spareCount(state.container.get(id), type) > 0) return;
  // Already someone on his way?
  const men = unitSoldiers(state, top);
  for (const g of men) {
    const it = state.soldier.get(g)?.intent, act = state.action.get(g);
    if (it?.kind === "bringAmmo" && it.target === id) return;
    if (act?.kind === "transferItems" && Number(act.params["to"]) === id) return; // being handed over now
  }
  const me = state.transform.req(id);
  let giver: EntityId | null = null, bestD = D.shareRangeM;
  for (const g of men) {
    if (g === id) continue;
    const gs = state.soldier.get(g);
    if (!gs || !isAble(gs) || isCowering(gs) || state.action.has(g) || gs.intent?.kind === "bringAmmo") continue;
    const n = spareCount(state.container.get(g), type);
    const gw = state.weapon.get(g), own = gw ? ctx.catalog.weapons[gw.weapon]?.feed.magazine === type : false;
    if (n <= (own ? D.keepSpare : 0)) continue;
    const t = state.transform.req(g);
    const d = hypot2(t.x - me.x, t.y - me.y);
    if (d < bestD) { bestD = d; giver = g; }
  }
  if (giver === null) return;
  state.soldier.req(giver).intent = { kind: "bringAmmo", tick: state.tick, target: id };
  stepBringAmmo(ctx, state, events, giver);
}

/** The giver: walk over, then hand the magazine or belt over. */
function stepBringAmmo(ctx: SimContext, state: SimState, events: EventSink, g: EntityId): void {
  const gs = state.soldier.req(g), it = gs.intent!;
  const to = it.target!;
  const rs = state.soldier.get(to), rw = state.weapon.get(to), wd = rw ? ctx.catalog.weapons[rw.weapon] : undefined;
  if (!rs || !isAble(rs) || !wd || state.tick - it.tick > 60 * TICK_HZ || spareCount(state.container.get(to), wd.feed.magazine) > 0) { gs.intent = null; return; }
  if (state.action.has(g)) return;
  const a = state.transform.req(g), b = state.transform.req(to);
  const d = hypot2(a.x - b.x, a.y - b.y);
  if (d <= 2.4) {
    startAction(state, events, g, "transferItems", secondsToTicks(ctx.catalog.behaviour.decisions.passSeconds), { to, item: wd.feed.magazine, count: 1 });
    gs.intent = null;
    return;
  }
  const m = state.mover.get(g);
  if (!m) { gs.intent = null; return; }
  const last = m.waypoints[m.waypoints.length - 1];
  if (last && hypot2(last.x - b.x, last.y - b.y) < 2.5) return; // already on his way
  const { search } = navFor(ctx, "foot");
  // He comes up behind him (not into his line of fire).
  const bx = b.x - cos(b.heading) * 1.5, by = b.y - sin(b.heading) * 1.5;
  const leg = findPath(search, a.x, a.y, bx, by, { maxExpansions: 4000, snapCells: 2 });
  if (!leg) { gs.intent = null; return; }
  m.waypoints = [];
  for (let i = 0; i < leg.points.length; i += 2) m.waypoints.push({ x: leg.points[i]!, y: leg.points[i + 1]!, mode: "run" });
  m.formation = null; m.endPosture = "prone"; m.endHeading = null;
}

export function decisionSystem(ctx: SimContext, state: SimState, events: EventSink): void {
  const D = ctx.catalog.behaviour.decisions;
  const every = Math.max(1, secondsToTicks(D.stepSeconds));
  // ---- who is under fire: the unit remembers it (for the "return fire" rule)
  for (const [id, s] of state.soldier.entries()) {
    if (s.mental.suppression < D.underFireSuppression || !isAble(s)) continue;
    const u = state.identity.get(id)?.unit;
    const top = u !== undefined ? topUnit(state, u) : undefined;
    if (top) {
      // A new spell under fire (after a quiet spell): the drills react to it (M4.3).
      if (state.tick - top.underFireTick > secondsToTicks(D.underFireMemorySeconds)) top.contactTick = state.tick;
      top.underFireTick = state.tick;
    }
  }
  for (const [id, s] of state.soldier.entries()) {
    if ((id + state.tick) % every !== 0) continue;
    if (!isAble(s)) { s.intent = null; continue; }
    if (state.tick < s.stunnedUntilTick || s.evade !== null) continue;
    const ident = state.identity.get(id);
    const unit = ident ? state.unit.get(ident.unit) : undefined;
    if (!ident || !unit) continue;
    const top = topUnit(state, ident.unit)!;
    if (s.mental.behaviour === "routed") { s.intent = null; continue; } // running back: no decisions of his own
    const topId = (() => { let u = ident.unit; for (let p = state.unit.get(u)?.parent ?? null; p !== null; p = state.unit.get(u)?.parent ?? null) u = p; return u; })();
    if (s.intent?.kind === "bringAmmo") { stepBringAmmo(ctx, state, events, id); continue; }
    // On his way to take a prisoner (systems/surrender.ts runs that errand): nothing else of his own meanwhile.
    if (s.intent?.kind === "takePrisoner") continue;
    const m = state.mover.get(id);
    const halted = !m || m.waypoints.length === 0;
    const task = state.fire.get(id);

    // ---- his own fire: keep it up while he sees the enemy, stop when he has lost him
    if (task?.self) {
      const c = s.contacts.find((k) => k.target === task.contact);
      const es = task.contact !== undefined ? state.soldier.get(task.contact) : undefined;
      const me = state.transform.req(id);
      const beyond = c !== undefined && unit.maxEngageM > 0 && hypot2(c.x - me.x, c.y - me.y) > unit.maxEngageM;
      if (!c || c.surrendered === true || !es || es.casualty !== "none" || beyond || state.tick - c.tick > secondsToTicks(D.contactLostSeconds) || !fireAllowed(state, ctx, unit, top)) {
        state.fire.delete(id);
        if (s.intent?.kind === "engage") s.intent = null;
      } else if (c.kind === "seen" && state.tick - c.tick <= secondsToTicks(D.seenWithinSeconds)) {
        task.reasonTick = state.tick;
      }
    }
    // Stale intents (debug overlay): cover reached, or his own fire replaced by an order.
    if (s.intent?.kind === "cover" && halted) s.intent = null;
    if (s.intent?.kind === "engage" && state.fire.get(id)?.self !== true) s.intent = null;
    if (isCowering(s)) continue;

    // ---- cover from the enemy he knows, when under fire
    if (halted && s.mental.suppression >= D.seekCoverSuppression && state.tick - s.coverTick >= secondsToTicks(D.coverRetrySeconds)) {
      const threat = threatOf(state, id, s);
      s.coverTick = state.tick;
      if (threat && seekCover(ctx, state, id, s, threat)) continue;
    }

    // ---- open fire on his own
    const current = state.fire.get(id);
    if (halted && (!current || current.self) && fireAllowed(state, ctx, unit, top)) {
      // (A unit rule may hold fire to a shorter range, e.g. for an ambush.)
      const range = unit.maxEngageM > 0 ? Math.min(unit.maxEngageM, engageRange(ctx, state, id)) : engageRange(ctx, state, id);
      const pick = pickTarget(ctx, state, id, s, range);
      if (pick && (!current || current.contact !== pick.target)) {
        if (assignFireTask(ctx, state, id, pick.x, pick.y, ctx.catalog.shooting.fire.aimPointHeightM)) {
          const ft = state.fire.get(id)!;
          ft.contact = pick.target; ft.self = true;
          s.intent = { kind: "engage", tick: state.tick, target: pick.target } satisfies Intent;
        }
      }
    }

    // ---- out of spare magazines or belts: a comrade brings one
    if (state.weapon.get(id)?.lowAmmoReported) shareAmmo(ctx, state, events, id, topId);
  }
}
