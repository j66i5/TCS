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
 * M9.3b: a missile guided from a dismounted team's tripod (systems/missile-team.ts) is steered the same way from the
 * sight's stored place; its gunner loses it if he is hit, stunned, panics, mounts or moves off the post.
 *
 * Randomness: the "missile" stream (created on first use: battles without missiles never draw).
 */
import type { AmmoDef, VehicleDef } from "../catalog";
import type { MissileGuide, VehicleState } from "../components";
import type { SimContext } from "../context";
import type { EventSink } from "../events";
import { DT, secondsToTicks, type EntityId } from "../ids";
import { isAble } from "../impair";
import { emptyContainer, transferItems } from "../items";
import { registerActionHandler, startAction } from "../actions";
import { ROOF_ACTION } from "../mount";
import { atan2, exp, sin, sqrt, wrapAngle } from "../math";
import { vehicleItems } from "../mount";
import { nextFloat, nextNormal, Streams } from "../rng";
import type { SimState } from "../state";
import { skillFactor } from "./fire";
import { canFight, dischargeSmoke, fireAndForget, guidedRound, missileAimPoint, missileSees, muzzleWorld, stationOperator } from "./gunnery";
import { radioFromTarget } from "./orders";
import { smokePhysics, smokeTransmission } from "../smoke";
import { sight } from "../los";
import { heightAt } from "../terrain";

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
const FROM = { x: 0, y: 0, z: 0, own: -1 as EntityId };

export function missileSystem(ctx: SimContext, state: SimState, events: EventSink): void {
  if (state.vehicle.size > 0) {
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
  // M9.3b: missiles guided from a team's tripod (ID order; the same "missile" stream).
  for (const [uid, u] of state.unit.entries()) if (u.missileTeam?.guide) teamGuideStep(ctx, state, events, uid);
}

/**
 * Where a guided missile is guided from (M9.3b): a vehicle station or a team's tripod. `ignore`: the launcher's own
 * id for sight lines (the hull; the gunner on foot); `lost()`: why the gunner can no longer guide it, or null (for
 * a vehicle: the vehicle out of the fight, the gunner, a hit on the hull — in that order, as before M9.3b);
 * `origin`: his sight; `moving`: the launcher is moving (his error triples).
 */
interface GuideHost {
  ignore: EntityId;
  end(result: "hit" | "miss" | "lost", reason?: string): void;
  lost(): string | null;
  origin(): [number, number, number];
  moving: boolean;
}

function guideStep(ctx: SimContext, state: SimState, events: EventSink, vid: EntityId, v: VehicleState, def: VehicleDef, si: number): void {
  const st = v.stations[si]!, g = st.guide!, tick = state.tick;
  const G = ctx.catalog.behaviour.gunnery;
  guideCore(ctx, state, events, g, {
    ignore: vid,
    end(result, reason) {
      st.guide = null;
      events.emit(reason === undefined
        ? { kind: "missile.ended", tick, vehicle: vid, station: si, ammo: g.ammo, target: g.target, result }
        : { kind: "missile.ended", tick, vehicle: vid, station: si, ammo: g.ammo, target: g.target, result, reason });
    },
    lost() {
      const s = state.soldier.get(g.gunner);
      if (!canFight(v)) return "missile.lost.launcher";
      if (!s || !isAble(s) || !s.impair.canFight || s.mount?.vehicle !== vid || tick < s.stunnedUntilTick) return "missile.lost.gunner";
      // His own hull struck this tick by an enemy round of 12.7 mm and up or a burst: one chance to lose it.
      let struck = false;
      for (const e of events.events) {
        if (e.kind !== "vehicle.hit" || e.vehicle !== vid) continue;
        const ea = ctx.catalog.ammo[e.ammo];
        if (state.identity.get(e.owner)?.side === v.side || !ea || (ea.diameterM < 0.0125 && ea.explosive === undefined)) continue;
        struck = true;
        break;
      }
      if (struck && nextFloat(state.rng, Streams.missile) < (G.missileHitLoseChance ?? 0.5)) return "missile.lost.struck";
      return null;
    },
    origin() {
      const t = state.transform.req(vid);
      return muzzleWorld(ctx, def, si, g.weapon, t.x, t.y, t.heading, st.azimuth);
    },
    moving: Math.abs(v.drive.speed) > (G.missileHaltedMps ?? 0.3),
  });
}

/** How far the gunner on foot may shift from his sight's place before he loses the missile (M9.3b), m. */
const TEAM_SHIFT_M = 1;

/**
 * A missile guided from a team's tripod (M9.3b): its gunner must stay at the post (able, not stunned, panicked or
 * routed, not aboard, within `TEAM_SHIFT_M` of where his sight stood) and the team set up; meanwhile its men's moves
 * wait. No hit on a hull to throw him off (he is on foot).
 */
function teamGuideStep(ctx: SimContext, state: SimState, events: EventSink, uid: EntityId): void {
  const u = state.unit.get(uid)!, mt = u.missileTeam!, g = mt.guide!, tick = state.tick;
  // Nobody of the team walks off while the missile flies (their moves wait for it).
  for (const m of u.members) { const mv = state.mover.get(m); if (mv && mv.waypoints.length > 0) mv.holdUntilTick = Math.max(mv.holdUntilTick ?? 0, tick + 2); }
  guideCore(ctx, state, events, g, {
    ignore: g.gunner,
    end(result, reason) {
      mt.guide = null;
      events.emit(reason === undefined
        ? { kind: "missile.ended", tick, team: uid, gunner: g.gunner, ammo: g.ammo, target: g.target, result }
        : { kind: "missile.ended", tick, team: uid, gunner: g.gunner, ammo: g.ammo, target: g.target, result, reason });
    },
    lost() {
      const s = state.soldier.get(g.gunner), t = state.transform.get(g.gunner);
      if (!s || !t || !isAble(s) || !s.impair.canFight || s.mount !== undefined || tick < s.stunnedUntilTick) return "missile.lost.gunner";
      if (s.mental.behaviour === "panicked" || s.mental.behaviour === "routed") return "missile.lost.gunner";
      if (mt.state === "packed" || (t.x - g.ox) * (t.x - g.ox) + (t.y - g.oy) * (t.y - g.oy) > TEAM_SHIFT_M * TEAM_SHIFT_M) return "missile.lost.moved";
      return null;
    },
    origin() { return [g.ox, g.oy, g.oz]; },
    moving: false,
  });
}

/** One tick of a guided missile's flight (any host): see the file header. */
function guideCore(ctx: SimContext, state: SimState, events: EventSink, g: MissileGuide, h: GuideHost): void {
  const tick = state.tick;
  const am: AmmoDef | undefined = ctx.catalog.ammo[g.ammo];
  const G = ctx.catalog.behaviour.gunnery;
  const end = h.end;
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
  // ---- launch warning (M9.3a): the target's crew fires its smoke toward the launcher
  if (g.warnTick !== undefined && tick >= g.warnTick) { delete g.warnTick; smokeAgainst(ctx, state, events, g.target, h.ignore); }
  // ---- fire-and-forget (M9.3a): its own seeker, no gunner, no wire
  if (fireAndForget(g.kind)) { seekStep(ctx, state, g, gd, row, h.ignore); return; }
  // ---- can the gunner still guide it?
  const lose = (reason: string): void => {
    // Thrown off its line: a kick across and up or down, then it flies on unguided (drag and gravity).
    const k = gd.lostKickMrad / 1000;
    const vx = P.vx[row]!, vy = P.vy[row]!, sp = sqrt(vx * vx + vy * vy + P.vz[row]! * P.vz[row]!);
    const hh = sqrt(vx * vx + vy * vy) || 1;
    const a = k * nextNormal(state.rng, Streams.missile), b = k * nextNormal(state.rng, Streams.missile);
    P.vx[row] = vx - (vy / hh) * a * sp; P.vy[row] = vy + (vx / hh) * a * sp; P.vz[row] = P.vz[row]! + b * sp;
    end("lost", reason);
  };
  const why = h.lost();
  if (why !== null) { lose(why); return; }
  const s = state.soldier.get(g.gunner)!;
  const [sx, sy, sz] = h.origin();
  const mx = P.x[row]!, my = P.y[row]!, mz = P.z[row]!;
  if ((mx - sx) * (mx - sx) + (my - sy) * (my - sy) > gd.maxRangeM * gd.maxRangeM) { lose(g.kind === "command-beam" ? "missile.lost.range" : "missile.lost.wire"); return; }
  // (M7.6b: the lowest aim point the gunner sees from his sight: the turret of a hull-down vehicle.)
  FROM.x = sx; FROM.y = sy; FROM.z = sz; FROM.own = h.ignore;
  if (g.target >= 0) { if (!missileAimPoint(ctx, state, g.target, AIM, FROM)) { lose("missile.lost.unseen"); return; } g.ax = AIM.x; g.ay = AIM.y; g.az = AIM.z; }
  const ax = g.ax, ay = g.ay, az = g.az;
  // His sight line to the target, every missileSightSeconds.
  const every = Math.max(1, secondsToTicks(G.missileSightSeconds ?? 0.1));
  if (g.checkTick < 0 || tick - g.checkTick >= every) {
    const first = g.checkTick < 0;
    g.checkTick = tick;
    if (!missileSees(ctx, state, h.ignore, g.target, sx, sy, sz, ax, ay, az)) { lose("missile.lost.unseen"); return; }
    if (first) {
      // His error when the missile leaves (then it wanders).
      const sd = trackSd(ctx, h.moving, s.skills["marksmanship"] ?? 0.5, s.impair.aim, gd.trackErrorMrad);
      g.errH = sd * nextNormal(state.rng, Streams.missile); g.errV = sd * nextNormal(state.rng, Streams.missile);
    }
  }
  // ---- his tracking error wanders (Ornstein-Uhlenbeck, time constant trackTauS)
  const sd = trackSd(ctx, h.moving, s.skills["marksmanship"] ?? 0.5, s.impair.aim, gd.trackErrorMrad);
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
  turnToward(P, row, dx, dy, dz, gd);
}

/** Turn the missile in row `row` at most turnRate x dt toward the unit direction (dx, dy, dz) and speed it up. */
function turnToward(P: SimState["projectiles"], row: number, dx: number, dy: number, dz: number, gd: NonNullable<AmmoDef["guided"]>): void {
  const vx = P.vx[row]!, vy = P.vy[row]!, vz = P.vz[row]!;
  const sp = sqrt(vx * vx + vy * vy + vz * vz) || 1;
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

const SEEK = { x: 0, y: 0, z: 0 };

/**
 * Fire-and-forget (M9.3a): every missileSightSeconds its seeker looks at the target from where the missile is; while
 * it sees it (the line clear, smoke thinning it to no less than missileSeenFloor; ordinary smoke kept at
 * seekerSmokeFactor), the aim point follows the target's top; when it does not, the missile flies on to the last
 * point seen (owner, M9 round). It pursues the aim point; a top-attack missile first climbs `climbM` above it and
 * dives on it within `diveAtM`.
 */
function seekStep(ctx: SimContext, state: SimState, g: MissileGuide, gd: NonNullable<AmmoDef["guided"]>, row: number, vid: EntityId): void {
  const P = state.projectiles, tick = state.tick, G = ctx.catalog.behaviour.gunnery;
  const mx = P.x[row]!, my = P.y[row]!, mz = P.z[row]!;
  const every = Math.max(1, secondsToTicks(G.missileSightSeconds ?? 0.1));
  if (g.target >= 0 && (g.checkTick < 0 || tick - g.checkTick >= every)) {
    g.checkTick = tick;
    if (missileAimPoint(ctx, state, g.target, SEEK)) {
      const tv = state.vehicle.get(g.target), tdef = tv ? ctx.catalog.vehicles[tv.def] : undefined, tt = state.transform.get(g.target);
      // (A top-attack seeker aims at the roof.)
      if (gd.topAttack && tdef && tt) SEEK.z = heightAt(ctx.map, tt.x, tt.y) + tdef.body.hull.u[1] - 0.2; // ground: ok (a hull)
      if (seekerSees(ctx, state, gd, vid, g.target, mx, my, mz, SEEK.x, SEEK.y, SEEK.z)) { g.ax = SEEK.x; g.ay = SEEK.y; g.az = SEEK.z; }
    }
  }
  let wx = g.ax - mx, wy = g.ay - my, wz = g.az - mz;
  const hr = sqrt(wx * wx + wy * wy);
  if (gd.topAttack && hr > gd.topAttack.diveAtM) wz = Math.max(g.az + gd.topAttack.climbM - mz, 0);
  const L = sqrt(wx * wx + wy * wy + wz * wz) || 1;
  wx /= L; wy /= L; wz /= L;
  turnToward(P, row, wx, wy, wz, gd);
}

/** Does a missile's seeker at (sx, sy, sz) see the target (M9.3a)? The sight line, and smoke as its seeker sees it. */
function seekerSees(ctx: SimContext, state: SimState, gd: NonNullable<AmmoDef["guided"]>, launcher: EntityId, target: EntityId, sx: number, sy: number, sz: number, ax: number, ay: number, az: number): boolean {
  const r = sight(ctx, sx, sy, sz, ax, ay, az, launcher, target);
  const range = sqrt((ax - sx) * (ax - sx) + (ay - sy) * (ay - sy));
  if (r.blockedBy !== null && (1 - r.blockedAt) * range > 5) return false;
  let seen = r.visibility;
  if (state.smoke.length > 0) {
    const SP = smokePhysics(ctx.catalog);
    const conv = smokeTransmission(state, SP, sx, sy, sz, ax, ay, az, "conventional");
    const ms = smokeTransmission(state, SP, sx, sy, sz, ax, ay, az, "multispectral");
    seen *= ms * (conv + (1 - conv) * (gd.seekerSmokeFactor ?? 0));
  }
  return seen >= (ctx.catalog.behaviour.gunnery.missileSeenFloor ?? 0.2);
}

/** Launch warning (M9.3a): vehicle `tv` lays its turret toward `from` (if it has no target) and fires its smoke. */
function smokeAgainst(ctx: SimContext, state: SimState, events: EventSink, tv: EntityId, from: EntityId): void {
  const v = state.vehicle.get(tv), t = state.transform.get(tv), f = state.transform.get(from);
  if (!v || !t || !f || v.status === "destroyed" || v.status === "abandoned" || v.unit === null) return;
  const st = v.stations[0];
  if (st && st.task === null) st.azCmd = wrapAngle(atan2(f.y - t.y, f.x - t.x) - t.heading);
  if (dischargeSmoke(ctx, state, tv) === true) radioFromTarget(state, v.unit, "radio.launchWarning", events);
}

/** The gunner's tracking error (one standard deviation, rad): the missile's, his skill and wounds, x3 on the move. */
function trackSd(ctx: SimContext, moving: boolean, skill: number, impairAim: number, mrad: number): number {
  return (mrad / 1000) * skillFactor(ctx, skill) * impairAim * (moving ? 3 : 1);
}

/**
 * Put the next missile on the launcher from stowage, up to its ready count (M9.3a: MELLS holds 2): the weapon's
 * reload time, counted only while halted. A launcher reloaded from outside (`reloadOutside`, M9.3a, owner: "with
 * a man exposed") is reloaded by a crewman with a hatch, out on the roof: an action ("reloadOutside") during which
 * he can be seen, shot at and hit (mount.ts `onRoof`); it breaks off if the vehicle moves, he is hit or it is lost.
 */
function reloadStep(ctx: SimContext, state: SimState, events: EventSink, vid: EntityId, v: VehicleState, def: VehicleDef, si: number, wi: number): void {
  const st = v.stations[si]!, w = st.weapons[wi]!, feed = w.feeds[0], wdef = def.stations[si]!.weapons[wi]!;
  if (!feed) return;
  const fd = wdef.feeds[0];
  const cap = fd ? fd.ready.count * Math.max(1, fd.ready.charge) : 1;
  if (feed.rounds >= cap) { if (w.reloadDoneTick !== undefined) delete w.reloadDoneTick; return; }
  if (v.status === "destroyed" || v.status === "abandoned" || vehicleItems(state, vid, feed.item) <= 0) return;
  const tick = state.tick;
  const halted = Math.abs(v.drive.speed) <= (ctx.catalog.behaviour.gunnery.missileHaltedMps ?? 0.3);
  const wd = ctx.catalog.weapons[wdef.weapon];
  if (wd?.reloadOutside === true) {
    // Outside: one man at a time, not while a missile is being guided by wire or beam from this station.
    if (!halted || !canFight(v) || (st.guide && !fireAndForget(st.guide.kind))) return;
    for (const m of v.seats) if (m !== null && m !== undefined && state.action.get(m)?.kind === ROOF_ACTION) return;
    const man = roofMan(state, v, def, si);
    if (man === null) return;
    startAction(state, events, man, ROOF_ACTION, secondsToTicks(wd.reloadSeconds), { vehicle: vid, station: si, weapon: wi });
    // He stands up there (every system sees a standing man: spotting, blast, bullets, contacts).
    const ms = state.soldier.get(man);
    if (ms && ms.posture !== "standing") { ms.posture = "standing"; ms.postureTo = null; events.emit({ kind: "posture.changed", tick, soldier: man, posture: "standing" }); }
    radioFromTarget(state, v.unit ?? vid, "radio.reloadOutside", events);
    return;
  }
  const busy = st.guide || !canFight(v) || stationOperator(state, v, def, si) === null || !halted;
  if (w.reloadDoneTick === undefined) { if (!busy) w.reloadDoneTick = tick + secondsToTicks(wd?.reloadSeconds ?? 30); return; }
  if (busy) { w.reloadDoneTick++; return; } // paused
  if (tick < w.reloadDoneTick) return;
  delete w.reloadDoneTick;
  loadOne(ctx, state, events, vid, v, def, si, wi);
}

/** One missile from the vehicle's stowage onto the launcher (counted items, rule 9). */
function loadOne(ctx: SimContext, state: SimState, events: EventSink, vid: EntityId, v: VehicleState, def: VehicleDef, si: number, wi: number): void {
  const w = v.stations[si]!.weapons[wi]!, feed = w.feeds[0];
  const c = state.container.get(vid);
  if (!feed || !c) return;
  const sink = emptyContainer();
  const r = transferItems(ctx.catalog, { get: (id: EntityId) => (id === vid ? c : id === -1 ? sink : undefined) }, { from: vid, to: -1, type: feed.item, count: 1 });
  if (r.moved === 0) return;
  for (const s2 of sink.stacks) feed.rounds += (s2.charge ?? 1) * s2.count;
  w.lowAmmoReported[0] = false;
  events.emit({ kind: "items.transferred", tick: state.tick, from: vid, to: stationOperator(state, v, def, si) ?? vid, item: feed.item, count: 1 });
}

/** The crewman who goes out on the roof to reload: an able crewman in a seat with a hatch, not the station's
 *  operator if another can go (the gun stays manned), commander first. */
function roofMan(state: SimState, v: VehicleState, def: VehicleDef, si: number): EntityId | null {
  const op = stationOperator(state, v, def, si);
  let fallback: EntityId | null = null;
  for (const kind of ["loader", "commander", "gunner"] as const) {
    for (let k = 0; k < def.seats.length; k++) {
      const seat = def.seats[k]!;
      if (seat.station !== kind || !seat.hatch) continue;
      const m = v.seats[k];
      if (m === null || m === undefined || !isAble(state.soldier.get(m)) || state.action.has(m)) continue;
      if (m === op) { fallback ??= m; continue; }
      return m;
    }
  }
  return fallback;
}

/** Action "reloadOutside" (M9.3a): params { vehicle, station, weapon }. */
registerActionHandler(ROOF_ACTION, {
  check(ctx, state, actor, a) {
    const vid = Number(a.params["vehicle"]), v = state.vehicle.get(vid), s = state.soldier.get(actor);
    if (!v || v.status === "destroyed" || v.status === "abandoned" || v.fire !== null) return "left-vehicle";
    if (!s || !isAble(s) || s.mount?.vehicle !== vid) return "left-vehicle";
    if (Math.abs(v.drive.speed) > (ctx.catalog.behaviour.gunnery.missileHaltedMps ?? 0.3)) return "moving";
    return null;
  },
  complete(ctx, state, actor, a, events) {
    const vid = Number(a.params["vehicle"]), v = state.vehicle.get(vid);
    const def = v ? ctx.catalog.vehicles[v.def] : undefined;
    if (!v || !def) return;
    loadOne(ctx, state, events, vid, v, def, Number(a.params["station"]), Number(a.params["weapon"]));
    void actor;
  },
});
