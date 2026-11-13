/**
 * WIRE-GUIDED MISSILES (owner 2026-11-13: "Yes, add the ATGM"; a simple model, full guided weapons are M9).
 *
 * A station fires its missile in `gunnery.ts` (`fireMissile`): halted, laid, the line clear. From then on, every
 * tick after the projectile loop, this system:
 *   - finds the missile (the pool row of the gunner's round with that launch tick); gone: it struck its target
 *     ("hit", from this tick's `vehicle.hit` events) or burst or flew elsewhere ("miss");
 *   - keeps the gunner on it: he must stay able, in his seat and not stunned, the vehicle must still fight, the
 *     wire must not run out, and every `missileSightSeconds` his sight line to the target must be open (ground,
 *     walls, roofs, hulls block; woods and smoke thin it below `missileSeenFloor`: a day sight sees nothing
 *     through smoke); a hit on his own hull by an enemy round of 12.7 mm and up or a burst throws him off with a
 *     chance. Otherwise the missile is "lost": it flies on unguided, thrown off its line, and falls;
 *   - steers it (semi-automatic command to line of sight): toward the point a little ahead of it on the line from
 *     the gunner's sight to his aim point, at most `turnRateDegS`, speeding up to its cruise speed. His aim point is
 *     the target's aim point plus his tracking error, which wanders (skill, wounds) and grows threefold when his
 *     own vehicle moves.
 * It also puts the next missile on an empty launcher from stowage (the weapon's `reloadSeconds`, only while
 * halted; counted items, rule 9).
 *
 * Randomness: the "missile" stream (created on first use: battles without missiles never draw).
 */
import type { AmmoDef, VehicleDef } from "../catalog";
import type { VehicleState } from "../components";
import type { SimContext } from "../context";
import type { EventSink } from "../events";
import { DT, secondsToTicks, type EntityId } from "../ids";
import { isAble } from "../impair";
import { emptyContainer, transferItems } from "../items";
import { atan2, exp, sin, sqrt } from "../math";
import { vehicleItems } from "../mount";
import { nextFloat, nextNormal, Streams } from "../rng";
import type { SimState } from "../state";
import { skillFactor } from "./fire";
import { canFight, guidedRound, missileAimPoint, missileSees, muzzleWorld, stationOperator } from "./gunnery";

/** Guided launchers of each vehicle type: [station, weapon] (derived from the catalog, never saved). */
const LAUNCHERS = new WeakMap<VehicleDef, [number, number][]>();
function launchersOf(ctx: SimContext, def: VehicleDef): [number, number][] {
  let l = LAUNCHERS.get(def);
  if (!l) {
    l = [];
    for (let si = 0; si < def.stations.length; si++) for (let wi = 0; wi < def.stations[si]!.weapons.length; wi++) if (guidedRound(ctx.catalog, def.stations[si]!.weapons[wi])) l.push([si, wi]);
    LAUNCHERS.set(def, l);
  }
  return l;
}

const AIM = { x: 0, y: 0, z: 0 };

export function missileSystem(ctx: SimContext, state: SimState, events: EventSink): void {
  if (state.vehicle.size === 0) return;
  for (const [vid, v] of state.vehicle.entries()) {
    if (v.stations.length === 0) continue;
    const def = ctx.catalog.vehicles[v.def];
    if (!def) continue;
    const launchers = launchersOf(ctx, def);
    if (launchers.length === 0) continue;
    for (let si = 0; si < v.stations.length; si++) if (v.stations[si]!.guide) guideStep(ctx, state, events, vid, v, def, si);
    for (const [si, wi] of launchers) reloadStep(ctx, state, events, vid, v, def, si, wi);
  }
}

function guideStep(ctx: SimContext, state: SimState, events: EventSink, vid: EntityId, v: VehicleState, def: VehicleDef, si: number): void {
  const st = v.stations[si]!, g = st.guide!, tick = state.tick;
  const am: AmmoDef | undefined = ctx.catalog.ammo[g.ammo];
  const G = ctx.catalog.behaviour.gunnery;
  const end = (result: "hit" | "miss" | "lost", reason?: string): void => {
    st.guide = null;
    events.emit(reason === undefined
      ? { kind: "missile.ended", tick, vehicle: vid, station: si, ammo: g.ammo, target: g.target, result }
      : { kind: "missile.ended", tick, vehicle: vid, station: si, ammo: g.ammo, target: g.target, result, reason });
  };
  const gd = am?.guided;
  const idx = ctx.catalog.ammoIds.indexOf(g.ammo);
  const P = state.projectiles;
  let row = -1;
  for (let i = 0; i < P.count; i++) if (P.owner[i] === g.gunner && P.bornTick[i] === g.launchTick && P.ammo[i] === idx) { row = i; break; }
  if (row < 0 || !gd) {
    let hit = false;
    for (const e of events.events) if (e.kind === "vehicle.hit" && e.owner === g.gunner && e.ammo === g.ammo && (g.target < 0 || e.vehicle === g.target)) { hit = true; break; }
    end(hit ? "hit" : "miss");
    return;
  }
  // ---- can the gunner still guide it?
  const lose = (reason: string): void => {
    // Thrown off its line: a kick across and up or down, then it flies on unguided (drag and gravity).
    const k = gd.lostKickMrad / 1000;
    const vx = P.vx[row]!, vy = P.vy[row]!, sp = sqrt(vx * vx + vy * vy + P.vz[row]! * P.vz[row]!);
    const h = sqrt(vx * vx + vy * vy) || 1;
    const a = k * nextNormal(state.rng, Streams.missile), b = k * nextNormal(state.rng, Streams.missile);
    P.vx[row] = vx - (vy / h) * a * sp; P.vy[row] = vy + (vx / h) * a * sp; P.vz[row] = P.vz[row]! + b * sp;
    end("lost", reason);
  };
  const s = state.soldier.get(g.gunner);
  if (!canFight(v)) { lose("missile.lost.launcher"); return; }
  if (!s || !isAble(s) || !s.impair.canFight || s.mount?.vehicle !== vid || tick < s.stunnedUntilTick) { lose("missile.lost.gunner"); return; }
  // His own hull struck this tick by an enemy round of 12.7 mm and up or a burst: one chance to lose it.
  let struck = false;
  for (const e of events.events) {
    if (e.kind !== "vehicle.hit" || e.vehicle !== vid) continue;
    const ea = ctx.catalog.ammo[e.ammo];
    if (state.identity.get(e.owner)?.side === v.side || !ea || (ea.diameterM < 0.0125 && ea.explosive === undefined)) continue;
    struck = true;
    break;
  }
  if (struck && nextFloat(state.rng, Streams.missile) < (G.missileHitLoseChance ?? 0.5)) { lose("missile.lost.struck"); return; }
  const t = state.transform.req(vid);
  const [sx, sy, sz] = muzzleWorld(ctx, def, si, g.weapon, t.x, t.y, t.heading, st.azimuth);
  const mx = P.x[row]!, my = P.y[row]!, mz = P.z[row]!;
  if ((mx - sx) * (mx - sx) + (my - sy) * (my - sy) > gd.maxRangeM * gd.maxRangeM) { lose("missile.lost.wire"); return; }
  if (g.target >= 0) { if (!missileAimPoint(ctx, state, g.target, AIM)) { lose("missile.lost.unseen"); return; } g.ax = AIM.x; g.ay = AIM.y; g.az = AIM.z; }
  const ax = g.ax, ay = g.ay, az = g.az;
  // His sight line to the target, every missileSightSeconds.
  const every = Math.max(1, secondsToTicks(G.missileSightSeconds ?? 0.1));
  if (g.checkTick < 0 || tick - g.checkTick >= every) {
    const first = g.checkTick < 0;
    g.checkTick = tick;
    if (!missileSees(ctx, state, vid, g.target, sx, sy, sz, ax, ay, az)) { lose("missile.lost.unseen"); return; }
    if (first) {
      // His error when the missile leaves (then it wanders).
      const sd = trackSd(ctx, v, s.skills["marksmanship"] ?? 0.5, s.impair.aim, gd.trackErrorMrad);
      g.errH = sd * nextNormal(state.rng, Streams.missile); g.errV = sd * nextNormal(state.rng, Streams.missile);
    }
  }
  // ---- his tracking error wanders (Ornstein-Uhlenbeck, time constant trackTauS)
  const sd = trackSd(ctx, v, s.skills["marksmanship"] ?? 0.5, s.impair.aim, gd.trackErrorMrad);
  const a = exp(-DT / gd.trackTauS), b = sd * sqrt(1 - a * a);
  g.errH = a * g.errH + b * nextNormal(state.rng, Streams.missile);
  g.errV = a * g.errV + b * nextNormal(state.rng, Streams.missile);
  // ---- steer toward the sight line, a little ahead of the missile
  let lx = ax - sx, ly = ay - sy;
  const hr = sqrt(lx * lx + ly * ly) || 1;
  const px = -ly / hr, py = lx / hr; // across the line, horizontal
  lx += px * g.errH * hr; ly += py * g.errH * hr;
  const lz = az - sz + g.errV * hr;
  const L = sqrt(lx * lx + ly * ly + lz * lz) || 1;
  const ux = lx / L, uy = ly / L, uz = lz / L;
  const vx = P.vx[row]!, vy = P.vy[row]!, vz = P.vz[row]!;
  const sp = sqrt(vx * vx + vy * vy + vz * vz) || 1;
  const along = (mx - sx) * ux + (my - sy) * uy + (mz - sz) * uz + Math.max(5, gd.lookaheadS * sp);
  let dx = sx + ux * along - mx, dy = sy + uy * along - my, dz = sz + uz * along - mz;
  const dl = sqrt(dx * dx + dy * dy + dz * dz) || 1;
  dx /= dl; dy /= dl; dz /= dl;
  const cx = vx / sp, cy = vy / sp, cz = vz / sp;
  // Turn at most turnRate x dt toward the wanted direction (along the great circle between the two).
  const dot = Math.min(1, Math.max(-1, cx * dx + cy * dy + cz * dz));
  const qx = cy * dz - cz * dy, qy = cz * dx - cx * dz, qz = cx * dy - cy * dx;
  const ang = atan2(sqrt(qx * qx + qy * qy + qz * qz), dot), maxT = (gd.turnRateDegS * Math.PI / 180) * DT;
  let nx = dx, ny = dy, nz = dz;
  if (ang > maxT && ang > 1e-9) {
    const sa = sin(ang), k0 = sin(ang - maxT) / sa, k1 = sin(maxT) / sa;
    nx = cx * k0 + dx * k1; ny = cy * k0 + dy * k1; nz = cz * k0 + dz * k1;
    const nl = sqrt(nx * nx + ny * ny + nz * nz) || 1;
    nx /= nl; ny /= nl; nz /= nl;
  }
  const speed = sp >= gd.cruiseMps ? gd.cruiseMps : Math.min(gd.cruiseMps, sp + gd.accelMps2 * DT);
  P.vx[row] = nx * speed; P.vy[row] = ny * speed; P.vz[row] = nz * speed;
}

/** The gunner's tracking error (one standard deviation, rad): the missile's, his skill and wounds, x3 on the move. */
function trackSd(ctx: SimContext, v: VehicleState, skill: number, impairAim: number, mrad: number): number {
  const moving = Math.abs(v.drive.speed) > (ctx.catalog.behaviour.gunnery.missileHaltedMps ?? 0.3) ? 3 : 1;
  return (mrad / 1000) * skillFactor(ctx, skill) * impairAim * moving;
}

/** Put the next missile on an empty launcher from stowage: the weapon's reload time, counted only while halted. */
function reloadStep(ctx: SimContext, state: SimState, events: EventSink, vid: EntityId, v: VehicleState, def: VehicleDef, si: number, wi: number): void {
  const st = v.stations[si]!, w = st.weapons[wi]!, feed = w.feeds[0], wdef = def.stations[si]!.weapons[wi]!;
  if (!feed) return;
  if (feed.rounds > 0) { if (w.reloadDoneTick !== undefined) delete w.reloadDoneTick; return; }
  if (v.status === "destroyed" || v.status === "abandoned" || vehicleItems(state, vid, feed.item) <= 0) return;
  const tick = state.tick;
  const busy = st.guide || !canFight(v) || stationOperator(state, v, def, si) === null || Math.abs(v.drive.speed) > (ctx.catalog.behaviour.gunnery.missileHaltedMps ?? 0.3);
  if (w.reloadDoneTick === undefined) { if (!busy) w.reloadDoneTick = tick + secondsToTicks(ctx.catalog.weapons[wdef.weapon]?.reloadSeconds ?? 30); return; }
  if (busy) { w.reloadDoneTick++; return; } // paused
  if (tick < w.reloadDoneTick) return;
  delete w.reloadDoneTick;
  const c = state.container.get(vid);
  if (!c) return;
  const sink = emptyContainer();
  const r = transferItems(ctx.catalog, { get: (id: EntityId) => (id === vid ? c : id === -1 ? sink : undefined) }, { from: vid, to: -1, type: feed.item, count: 1 });
  if (r.moved === 0) return;
  for (const s2 of sink.stacks) feed.rounds += (s2.charge ?? 1) * s2.count;
  w.lowAmmoReported[0] = false;
  events.emit({ kind: "items.transferred", tick, from: vid, to: stationOperator(state, v, def, si) ?? vid, item: feed.item, count: 1 });
}
