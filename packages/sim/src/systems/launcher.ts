/**
 * SHOULDER-FIRED ANTI-TANK WEAPONS (M7.4a, plan §9; owner Q19, Q20): Panzerfaust 3 and RPG-7.
 *
 * A round with `delivery.method "direct"` is fired from a launcher item the man carries (the RPG-7; the
 * Panzerfaust's firing unit, the round being the throw-away tube). It is AIMED at what he sees: the action
 * `fireLauncher` takes `aimSeconds`; at its end he lays on the target's position as he knows it, leads a moving
 * vehicle by the round's time of flight and sets the elevation from the round's own flight (flight.ts, the same
 * arithmetic as the projectile loop: motor, drag, gravity; still air assumed). Errors: the round's dispersion
 * plus his aiming error (skill), and his error in judging the range. The round leaves his load (rule 9).
 *
 * Who fires:
 *   - an order: a fire order with nature "at" (the best-placed man with a loaded launcher fires once at the
 *     point or the named enemy — a vehicle, a house, a machine gun: anything the player chooses);
 *   - on his own, within his unit's fire rule, as its anti-tank rule allows (Unit.atRule, cascading from the
 *     platoon; default from core/behaviour.json `antitank.atRuleDefault`, owner Q19: "vehicles"):
 *       vehicles               enemy vehicles he saw in the last seconds, within the round's range;
 *       vehiclesAndPositions   also enemies in houses and machine guns;
 *       hold                   only on an order.
 * Not from inside a house unless it is breached or large (owner Q20), nor with a wall right behind him or a
 * comrade in the danger zone behind the tube. A comrade nearby hands over a round when he has none left.
 */
import { registerActionHandler, startAction } from "../actions";
import { lineBlocked, type AmmoRT } from "../ballistics";
import type { SoldierState, Unit } from "../components";
import type { SimContext } from "../context";
import type { EventSink } from "../events";
import { flightStep, type FlightState } from "../flight";
import { secondsToTicks, type EntityId } from "../ids";
import { isAble } from "../impair";
import { countItems, removeItems } from "../items";
import { sight } from "../los";
import { atan2, cos, hypot2, sin } from "../math";
import { nextNormal, Streams } from "../rng";
import type { SimState } from "../state";
import { heightAt, pointInPolygon } from "../terrain";
import { launchProjectile } from "./ballistics";
import { skillFactor } from "./fire";
import { footSoldiers } from "../mount";

export type AtRule = "vehicles" | "vehiclesAndPositions" | "hold";

/** The anti-tank rule a unit works under: its own, else the nearest unit above it that has one, else the default. */
export function atRuleOf(ctx: SimContext, state: SimState, unitId: EntityId): AtRule {
  let u: Unit | undefined = state.unit.get(unitId);
  while (u) {
    if (u.atRule !== undefined) return u.atRule;
    if (u.parent === null) break;
    u = state.unit.get(u.parent);
  }
  return ctx.catalog.behaviour.antitank.atRuleDefault;
}

/** The anti-tank round he can fire now (with its launcher in his load), or null; `launcherOnly`: he has a launcher but no round. */
export function launcherRound(ctx: SimContext, state: SimState, id: EntityId): { ammo: string; launcher: string } | null {
  const c = state.container.get(id);
  if (!c) return null;
  for (const st of c.stacks) {
    if (st.count <= 0) continue;
    const d = ctx.catalog.ammo[st.type]?.delivery;
    if (d?.method !== "direct" || d.launcher === undefined) continue;
    if (countItems(c, d.launcher) > 0) return { ammo: st.type, launcher: d.launcher };
  }
  return null;
}

/** A launcher in his load whose rounds he has run out of (for the hand-over): the round type it wants. */
function emptyLauncherWants(ctx: SimContext, state: SimState, id: EntityId): string | null {
  const c = state.container.get(id);
  if (!c) return null;
  for (const a of ctx.catalog.ammoIds) {
    const d = ctx.catalog.ammo[a]!.delivery;
    if (d?.method !== "direct" || d.launcher === undefined) continue;
    if (countItems(c, d.launcher) > 0 && countItems(c, a) === 0) return a;
  }
  return null;
}

/**
 * May he fire a launcher from where he stands, toward azimuth `az` (owner Q20 and the danger zone behind)?
 * Returns null if so, else the reason (a key).
 */
export function backblastBlocked(ctx: SimContext, state: SimState, id: EntityId, ammo: string, az: number): string | null {
  const t = state.transform.req(id), s = state.soldier.req(id);
  const AT = ctx.catalog.behaviour.antitank;
  // Inside a house: only a large room or one with a hole blown in it (Q20).
  for (const b of ctx.map.buildings) {
    if (!pointInPolygon(b.footprint, t.x, t.y)) continue;
    let area = 0;
    const f = b.footprint;
    for (let k = 0; k < f.length; k += 2) { const j = (k + 2) % f.length; area += f[k]! * f[j + 1]! - f[j]! * f[k + 1]!; }
    area = Math.abs(area) / 2;
    const breached = state.terrain.breaches.some((br) => br.owner === "building" && br.id === b.id);
    if (!breached && area < AT.largeRoomM2) return "at.room";
  }
  const z = heightAt(ctx.map, t.x, t.y) + ctx.catalog.body.postures[s.posture].muzzleHeightM;
  // A wall right behind the tube.
  const bx = t.x - cos(az) * AT.wallBehindM, by = t.y - sin(az) * AT.wallBehindM;
  if (bx > 0 && by > 0 && bx < ctx.map.widthM && by < ctx.map.heightM && lineBlocked(ctx.ballistics, ctx.map, ctx.mapIndex, t.x, t.y, z, bx, by, z)) return "at.wallBehind";
  // A comrade in the danger zone behind (a 60-degree cone).
  const R = ctx.catalog.ammo[ammo]?.delivery?.backblastM ?? 0;
  if (R > 0) {
    const side = state.identity.get(id)?.side;
    const ux = -cos(az), uy = -sin(az);
    // mounted: ok men aboard are skipped (behind armour)
    for (const [m, ms] of state.soldier.entries()) {
      if (m === id || ms.mount !== undefined || !ms.physiology.alive || state.identity.get(m)?.side !== side) continue;
      const mt = state.transform.get(m);
      if (!mt) continue;
      const rx = mt.x - t.x, ry = mt.y - t.y, d = hypot2(rx, ry);
      if (d > R || d < 0.3) continue;
      if ((rx * ux + ry * uy) / d > 0.866) return "at.backblast";
    }
  }
  return null;
}

/**
 * Elevation (rad) at which the round, fired at speed v0 from height 0, passes `dz` metres above its start at
 * horizontal distance d, and its time of flight there; null if out of its reach. Still standard air.
 */
export function aimSolution(ctx: SimContext, am: AmmoRT, v0: number, d: number, dz: number): { el: number; tof: number } | null {
  const bal = ctx.catalog.ballistics;
  const heightAtD = (el: number): { h: number; tof: number } | null => {
    const f: FlightState = { x: 0, y: 0, z: 0, vx: v0 * cos(el), vy: 0, vz: v0 * sin(el), age: 0 };
    for (let k = 0; k < 60 * 20; k++) {
      const px = f.x, pz = f.z;
      flightStep(f, am, bal.airDensityKgM3, 0, 0, bal.gravityMps2);
      if (f.x >= d) { const w = (d - px) / Math.max(1e-9, f.x - px); return { h: pz + (f.z - pz) * w, tof: (k + w) / 60 }; }
      if (am.selfDestructTicks > 0 && f.age >= am.selfDestructTicks) return null;
      if (f.vx <= 0) return null;
    }
    return null;
  };
  let lo = -0.2, hi = 0.35;
  const top = heightAtD(hi);
  if (!top || top.h < dz) return null;
  for (let k = 0; k < 20; k++) {
    const mid = (lo + hi) / 2;
    const r = heightAtD(mid);
    if (!r || r.h < dz) lo = mid; else hi = mid;
  }
  const r = heightAtD(hi);
  return r ? { el: hi, tof: r.tof } : null;
}

/** The aim point height above the ground: a vehicle's hull middle, a man's chest. */
function aimHeight(ctx: SimContext, state: SimState, target: EntityId | undefined): number {
  const v = target !== undefined ? state.vehicle.get(target) : undefined;
  if (v) { const h = ctx.catalog.vehicles[v.def]?.body.hull; if (h) return (h.u[0] + h.u[1]) / 2; }
  return 1.0;
}

/** Is this contact one his anti-tank rule lets him fire at on his own? */
function atTarget(ctx: SimContext, state: SimState, rule: AtRule, target: EntityId, isVehicle: boolean): boolean {
  if (rule === "hold") return false;
  if (isVehicle) return true;
  if (rule !== "vehiclesAndPositions") return false;
  // A position: an enemy in a house, or a machine gun.
  const t = state.transform.get(target);
  if (t && ctx.map.buildings.some((b) => pointInPolygon(b.footprint, t.x, t.y))) return true;
  const w = state.weapon.get(target);
  return w !== undefined && ctx.catalog.weapons[w.weapon]?.sustained !== undefined;
}

/**
 * His own anti-tank shot (called from the decision system for a halted, able man whose unit's fire rule allows
 * him to fire). Returns true if he started one (or is getting a round handed over).
 */
export function launcherDecision(ctx: SimContext, state: SimState, events: EventSink, id: EntityId, s: SoldierState, unitId: EntityId): boolean {
  if (state.action.has(id)) return false;
  const AT = ctx.catalog.behaviour.antitank;
  const rule = atRuleOf(ctx, state, unitId);
  if (rule === "hold") return false;
  const rd = launcherRound(ctx, state, id);
  if (!rd) { askForRound(ctx, state, events, id, unitId); return false; }
  const am = ctx.catalog.ammo[rd.ammo]!;
  const range = am.delivery?.maxRangeM ?? 300;
  const me = state.transform.req(id);
  const seen = secondsToTicks(AT.seenWithinSeconds);
  let best: { target: EntityId; x: number; y: number } | null = null, bestScore = Infinity;
  for (const c of s.contacts) {
    if (c.kind !== "seen" || state.tick - c.tick > seen || c.surrendered || c.wreck) continue;
    const d = hypot2(c.x - me.x, c.y - me.y);
    if (d > range || d < 15) continue;
    const isV = c.cls === "vehicle";
    if (isV) { const v = state.vehicle.get(c.target); if (!v || v.status === "destroyed" || v.status === "abandoned") continue; }
    else { const es = state.soldier.get(c.target); if (!es || es.casualty !== "none") continue; }
    if (!atTarget(ctx, state, rule, c.target, isV)) continue;
    const score = d * (isV ? 0.5 : 1);
    if (score < bestScore) { bestScore = score; best = { target: c.target, x: c.x, y: c.y }; }
  }
  if (!best) return false;
  const az = atan2(best.y - me.y, best.x - me.x);
  if (backblastBlocked(ctx, state, id, rd.ammo, az) !== null) return false;
  // A clear line from his shoulder to the aim point (the target's own hull ignored).
  const z0 = heightAt(ctx.map, me.x, me.y) + ctx.catalog.body.postures[s.posture].muzzleHeightM;
  const z1 = heightAt(ctx.map, best.x, best.y) + aimHeight(ctx, state, best.target);
  const r = sight(ctx, me.x, me.y, z0, best.x, best.y, z1, -1, best.target);
  if (r.blockedBy !== null) return false;
  startAction(state, events, id, "fireLauncher", secondsToTicks(am.delivery?.aimSeconds ?? 3), { ammo: rd.ammo, x: best.x, y: best.y, target: best.target });
  s.intent = { kind: "engage", tick: state.tick, target: best.target };
  return true;
}

/** Out of rounds with his launcher still on him: the nearest comrade within reach who carries one brings it. */
function askForRound(ctx: SimContext, state: SimState, events: EventSink, id: EntityId, unitId: EntityId): void {
  const want = emptyLauncherWants(ctx, state, id);
  if (want === null) return;
  const AT = ctx.catalog.behaviour.antitank;
  const me = state.transform.req(id);
  let top = unitId;
  for (let p = state.unit.get(top)?.parent ?? null; p !== null; p = state.unit.get(top)?.parent ?? null) top = p;
  const men = footSoldiers(state, top);
  for (const g of men) {
    const it = state.soldier.get(g)?.intent;
    if (it?.kind === "bringAmmo" && it.target === id) return;
    const act = state.action.get(g);
    if (act?.kind === "transferItems" && Number(act.params["to"]) === id) return;
  }
  let giver: EntityId | null = null, bestD = AT.handOverM;
  for (const g of men) {
    if (g === id) continue;
    const gs = state.soldier.get(g);
    if (!gs || !isAble(gs) || state.action.has(g) || gs.intent?.kind === "bringAmmo" || gs.evade !== null) continue;
    if (countItems(state.container.get(g)!, want) === 0) continue;
    // A comrade with a launcher of his own keeps his rounds for it.
    if (launcherRound(ctx, state, g) !== null) continue;
    const t = state.transform.req(g);
    const d = hypot2(t.x - me.x, t.y - me.y);
    if (d < bestD) { bestD = d; giver = g; }
  }
  if (giver === null) return;
  state.soldier.req(giver).intent = { kind: "bringAmmo", tick: state.tick, target: id, item: want };
  void events;
}

/**
 * Order: fire a launcher at (x, y) (or at the named enemy as each man knows him). The best-placed man — a loaded
 * launcher, in range, clear behind, nearest — fires once. Returns false if nobody can.
 */
export function orderLauncherShot(ctx: SimContext, state: SimState, events: EventSink, men: readonly EntityId[], x: number, y: number, contact: EntityId | undefined): boolean {
  let best: { id: EntityId; ammo: string; d: number; x: number; y: number } | null = null;
  for (const m of men) {
    const s = state.soldier.get(m);
    if (!isAble(s) || !s!.impair.canUseArms || state.action.has(m) || s!.evade !== null) continue;
    const rd = launcherRound(ctx, state, m);
    if (!rd) continue;
    let tx = x, ty = y;
    if (contact !== undefined) { const c = s!.contacts.find((k) => k.target === contact); if (c) { tx = c.x; ty = c.y; } }
    const t = state.transform.req(m);
    const d = hypot2(tx - t.x, ty - t.y);
    if (d > (ctx.catalog.ammo[rd.ammo]!.delivery?.maxRangeM ?? 300) * 1.5 || d < 15) continue;
    if (backblastBlocked(ctx, state, m, rd.ammo, atan2(ty - t.y, tx - t.x)) !== null) continue;
    if (!best || d < best.d || (d === best.d && m < best.id)) best = { id: m, ammo: rd.ammo, d, x: tx, y: ty };
  }
  if (!best) return false;
  const m = state.mover.get(best.id);
  if (m) { m.waypoints = []; m.speedMps = 0; m.formation = null; }
  startAction(state, events, best.id, "fireLauncher", secondsToTicks(ctx.catalog.ammo[best.ammo]!.delivery?.aimSeconds ?? 3), { ammo: best.ammo, x: best.x, y: best.y, ...(contact !== undefined ? { target: contact } : {}) });
  return true;
}

/** Action "fireLauncher": params { ammo, x, y, target? }. */
registerActionHandler("fireLauncher", {
  check(ctx, state, actor, a) {
    const s = state.soldier.get(actor);
    if (!isAble(s) || !s!.impair.canUseArms || s!.mount !== undefined) return "unable";
    if ((state.mover.get(actor)?.waypoints.length ?? 0) > 0) return "moved";
    const c = state.container.get(actor), ammo = String(a.params["ammo"]);
    const d = ctx.catalog.ammo[ammo]?.delivery;
    if (!c || !d?.launcher || countItems(c, ammo) === 0 || countItems(c, d.launcher) === 0) return "no-round";
    // Turn toward the target while aiming.
    const t = state.transform.req(actor);
    t.heading = atan2(Number(a.params["y"]) - t.y, Number(a.params["x"]) - t.x);
    return null;
  },
  complete(ctx, state, actor, a, events) {
    fireRound(ctx, state, actor, String(a.params["ammo"]), Number(a.params["x"]), Number(a.params["y"]), a.params["target"] !== undefined ? Number(a.params["target"]) : undefined, events);
  },
});

/** Lay, lead and fire one round. */
function fireRound(ctx: SimContext, state: SimState, id: EntityId, ammo: string, x0: number, y0: number, target: EntityId | undefined, events: EventSink): void {
  const s = state.soldier.req(id), t = state.transform.req(id), c = state.container.get(id);
  const def = ctx.catalog.ammo[ammo], d = def?.delivery;
  if (!def || !d || !c || d.method !== "direct") return;
  const AT = ctx.catalog.behaviour.antitank;
  const am = ctx.ballistics.ammo[ctx.catalog.ammoIds.indexOf(ammo)]!;
  // Where he believes the target is now, and how it moves.
  let tx = x0, ty = y0, vx = 0, vy = 0;
  if (target !== undefined) {
    const k = s.contacts.find((q) => q.target === target);
    if (k) { tx = k.x; ty = k.y; vx = k.vx ?? 0; vy = k.vy ?? 0; }
  }
  const az0 = atan2(ty - t.y, tx - t.x);
  if (backblastBlocked(ctx, state, id, ammo, az0) !== null) return; // someone stepped behind him: no shot
  const ox = t.x + cos(az0) * 0.3, oy = t.y + sin(az0) * 0.3;
  const oz = heightAt(ctx.map, ox, oy) + ctx.catalog.body.postures[s.posture].muzzleHeightM;
  const v0 = d.velocityMps ?? 100;
  const rng = state.rng;
  // His estimate of the range is off by a few per cent; the lead follows from the flight time.
  const rangeErr = 1 + AT.rangeErrorFraction * nextNormal(rng, Streams.antitank);
  const aimH = aimHeight(ctx, state, target);
  let ax = tx, ay = ty, sol: { el: number; tof: number } | null = null;
  for (let it = 0; it < 2; it++) {
    const dist = Math.max(1, hypot2(ax - ox, ay - oy));
    const dz = heightAt(ctx.map, Math.min(Math.max(ax, 0), ctx.map.widthM - 0.01), Math.min(Math.max(ay, 0), ctx.map.heightM - 0.01)) + aimH - oz;
    sol = aimSolution(ctx, am, v0, dist * rangeErr, dz);
    if (!sol) break;
    ax = tx + vx * sol.tof; ay = ty + vy * sol.tof;
  }
  const el0 = sol ? sol.el : 0.05;
  const sigma = ((d.dispersionMrad ?? 1) + AT.skillMrad * skillFactor(ctx, s.skills["marksmanship"] ?? 0.5)) / 1000;
  const az = atan2(ay - oy, ax - ox) + sigma * nextNormal(rng, Streams.antitank);
  const el = el0 + sigma * nextNormal(rng, Streams.antitank);
  if (removeItems(c, ammo, 1).length === 0) return;
  t.heading = az;
  const ce = cos(el);
  launchProjectile(ctx, state, ammo, ox, oy, oz, v0 * cos(az) * ce, v0 * sin(az) * ce, v0 * sin(el), id);
  events.emit({ kind: "grenade.launched", tick: state.tick, soldier: id, ammo, method: "direct", x: tx, y: ty });
  // He has fired: it gives him away like a shot (spotting reads his weapon's last shot).
  const w = state.weapon.get(id);
  if (w) w.lastShotTick = state.tick;
}
