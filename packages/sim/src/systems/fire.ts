/**
 * THE SHOOTER (SPEC 6.3): soldiers carrying out a fire order.
 *
 * Each man with a fire task and a working, loaded weapon fires at the rate the range calls for (data:
 * shooting.json bands). Every round is drawn from the magazine in his weapon; an empty magazine means a reload
 * (a timed action) from the magazines he carries; a stoppage means clearing it. Where the round goes follows
 * from his aiming error — skill, posture, fatigue, heart rate, suppression, rate of fire, recoil in a burst,
 * his sight — combined with the weapon's own dispersion and his error in judging the range. No hit tables.
 *
 * Ammunition management (owner decision 2026-11-11): the unit fires at the full rate while it has reason to
 * (the order, incoming fire near it), then slows to a trickle, then ceases fire and reports. A man stops when
 * only the magazine in his weapon is left. In lulls men swap a partly used magazine for a fuller one.
 */
import { startAction } from "../actions";
import { dropAt } from "../ballistics";
import type { FireTask, WeaponState } from "../components";
import type { SimContext } from "../context";
import type { EventSink, SimEvent } from "../events";
import { secondsToTicks, TICK_HZ, type EntityId } from "../ids";
import { isAble } from "../impair";
import type { Container } from "../items";
import { atan2, cos, hypot2, PI, sin, sqrt } from "../math";
import { nextFloat, nextNormal, Streams } from "../rng";
import type { SimState } from "../state";
import { heightAt } from "../terrain";
import { launchProjectile } from "./ballistics";
import { radioFromTarget, unitSoldiers } from "./orders";

/** Rounds in the fullest spare magazine of a type (0 if none). */
function fullestSpare(c: Container | undefined, magazine: string): number {
  let best = 0;
  if (c) for (const s of c.stacks) if (s.type === magazine && (s.charge ?? 0) > best) best = s.charge ?? 0;
  return best;
}

/** How far a man's marksmanship moves his errors from the average soldier's (1 = skill 0.5). */
export function skillFactor(ctx: SimContext, marksmanship: number): number {
  const a = ctx.catalog.shooting.aim;
  return Math.max(a.minSkillFactor, 1 + a.skillSlope * (0.5 - marksmanship));
}

/** Aiming error (one standard deviation, mrad) of this shooter right now, before the weapon's own dispersion. */
export function aimErrorMrad(ctx: SimContext, state: SimState, id: EntityId, w: WeaponState, aimed: boolean): number {
  const a = ctx.catalog.shooting.aim, s = state.soldier.req(id);
  const hrMax = ctx.catalog.body.physiology.hrMaxBpm;
  const hr = Math.max(0, (s.physical.heartRateBpm - a.heartRateCalmBpm) / Math.max(1, hrMax - a.heartRateCalmBpm));
  const sight = ctx.catalog.weapons[w.weapon]?.sights[0]?.kind ?? "iron";
  return a.baseMrad * skillFactor(ctx, s.skills["marksmanship"] ?? 0.5) * a.postureFactor[s.posture]
    * (1 + a.fatigueK * s.physical.fatigue) * (1 + a.heartRateK * hr) * (1 + a.suppressionK * s.mental.suppression)
    * (a.sightFactor[sight] ?? 1) * (aimed ? 1 : a.rapidFactor) * (1 + a.burstGrowth * w.burstIndex) * s.impair.aim;
}

/** Give a soldier a fire task (from a fire order). */
export function assignFireTask(ctx: SimContext, state: SimState, id: EntityId, x: number, y: number, heightM: number): boolean {
  const w = state.weapon.get(id), s = state.soldier.get(id), t = state.transform.get(id);
  if (!w || !s || !t || !isAble(s) || !s.impair.canFight) return false;
  const a = ctx.catalog.shooting.aim;
  state.fire.set(id, {
    x, y, heightM, reasonTick: state.tick,
    rangeError: a.rangeErrorFraction * skillFactor(ctx, s.skills["marksmanship"] ?? 0.5) * nextNormal(state.rng, Streams.fire),
  });
  // Men do not all fire on the same tick.
  w.nextShotTick = state.tick + Math.floor(nextFloat(state.rng, Streams.fire) * TICK_HZ);
  w.burstLeft = 0; w.burstIndex = 0;
  t.heading = atan2(y - t.y, x - t.x);
  return true;
}

function topUnit(state: SimState, soldier: EntityId): EntityId | null {
  let u: EntityId | null = state.identity.get(soldier)?.unit ?? null;
  for (;;) {
    if (u === null) return null;
    const p: EntityId | null = state.unit.get(u)?.parent ?? null;
    if (p === null) return u;
    u = p;
  }
}

/** Is a man of the same unit in front of the muzzle, inside the safety cone and nearer than the target? */
function friendInLine(ctx: SimContext, state: SimState, id: EntityId, tx: number, ty: number): boolean {
  const top = topUnit(state, id);
  if (top === null) return false;
  const me = state.transform.req(id);
  const dx = tx - me.x, dy = ty - me.y;
  const range = hypot2(dx, dy);
  if (range < 1e-6) return false;
  const ux = dx / range, uy = dy / range;
  const sinCone = sin((ctx.catalog.shooting.fire.safetyConeDeg * PI) / 180);
  for (const other of unitSoldiers(state, top)) {
    if (other === id) continue;
    const o = state.transform.req(other);
    const along = (o.x - me.x) * ux + (o.y - me.y) * uy;
    if (along <= 0.5 || along >= range) continue;
    const across = Math.abs((o.x - me.x) * -uy + (o.y - me.y) * ux);
    if (across < 0.7 + along * sinCone) return true;
  }
  return false;
}

function shoot(ctx: SimContext, state: SimState, events: EventSink, id: EntityId, w: WeaponState, task: FireTask, aimed: boolean): void {
  const wd = ctx.catalog.weapons[w.weapon]!;
  const s = state.soldier.req(id), t = state.transform.req(id);
  const ammoId = ctx.catalog.items[w.magazine!.item]?.chargeItem ?? "";
  const v0 = wd.ammo[ammoId];
  if (v0 === undefined) return;
  const a0 = atan2(task.y - t.y, task.x - t.x);
  t.heading = a0;
  const mx = t.x + cos(a0) * 0.4, my = t.y + sin(a0) * 0.4;
  const mz = heightAt(ctx.map, mx, my) + ctx.catalog.body.postures[s.posture].muzzleHeightM;
  const range = hypot2(task.x - mx, task.y - my);
  if (range < 0.5) return;
  const tz = heightAt(ctx.map, task.x, task.y) + task.heightM;
  // He sets his point of aim for the range he believes it is.
  const believed = range * (1 + task.rangeError);
  const e0 = atan2(tz - mz, range) + atan2(dropAt(ctx, ammoId, v0, believed), believed);
  const sd = aimErrorMrad(ctx, state, id, w, aimed);
  const total = sqrt(sd * sd + wd.dispersionMrad * wd.dispersionMrad) / 1000;
  const az = a0 + total * nextNormal(state.rng, Streams.fire);
  const el = e0 + total * nextNormal(state.rng, Streams.fire);
  const ce = cos(el);
  launchProjectile(ctx, state, ammoId, mx, my, mz, v0 * cos(az) * ce, v0 * sin(az) * ce, v0 * sin(el), id);
  w.magazine!.rounds--;
  w.lastShotTick = state.tick;
  events.emit({ kind: "shot.fired", tick: state.tick, shooter: id, x: mx, y: my, z: mz, dirX: cos(az), dirY: sin(az), weapon: w.weapon, ammo: ammoId });
  if (wd.jamProbability > 0 && nextFloat(state.rng, Streams.fire) < wd.jamProbability) {
    w.jammed = true;
    w.burstLeft = 0;
    events.emit({ kind: "weapon.jammed", tick: state.tick, soldier: id });
  }
}

export function fireSystem(ctx: SimContext, state: SimState, events: EventSink): void {
  const F = ctx.catalog.shooting.fire;
  const tick = state.tick;
  // ---- lulls: swap a partly used magazine for a fuller one (staggered check, twice a second per man)
  // Not while he has a fire task (even a slow one), and only if the magazine is well below full.
  for (const [id, w] of state.weapon.entries()) {
    if ((id + tick) % 30 !== 0 || !w.magazine || state.action.has(id) || state.fire.has(id)) continue;
    if (tick - w.lastShotTick < secondsToTicks(F.topUpAfterSeconds)) continue;
    const sol = state.soldier.get(id);
    if (!isAble(sol) || tick < sol!.stunnedUntilTick || !sol!.impair.canUseArms) continue;
    const wd = ctx.catalog.weapons[w.weapon];
    const capacity = wd ? (ctx.catalog.items[wd.feed.magazine]?.chargeCapacity ?? 0) : 0;
    if (wd && w.magazine.rounds <= capacity * F.topUpBelowFraction && fullestSpare(state.container.get(id), wd.feed.magazine) > w.magazine.rounds) {
      startAction(state, events, id, "reload", secondsToTicks(wd.reloadSeconds), {});
    }
  }
  if (state.fire.size === 0) return;

  const fullTicks = secondsToTicks(F.fullRateSeconds), endTicks = fullTicks + secondsToTicks(F.trickleSeconds);
  const ended = new Map<EntityId, "no-target" | "ammunition" | "unable">(); // top unit -> why a member stopped
  for (const [id, task] of state.fire.toEntries()) {
    const w = state.weapon.get(id), s = state.soldier.get(id), wd = w ? ctx.catalog.weapons[w.weapon] : undefined;
    const stop = (why: "no-target" | "ammunition" | "unable") => {
      state.fire.delete(id);
      const top = topUnit(state, id);
      if (top !== null && ended.get(top) !== "no-target" && !(ended.get(top) === "ammunition" && why === "unable")) ended.set(top, why);
    };
    if (!w || !s || !wd || !isAble(s) || !s.impair.canFight) { stop("unable"); continue; }
    if (tick < s.stunnedUntilTick) continue; // knocked down
    if (s.evade !== null && tick >= s.evade.startTick) continue; // diving away from a grenade
    const since = tick - task.reasonTick;
    if (since > endTicks) { stop("no-target"); continue; }
    if (s.postureTo !== null || state.action.has(id)) continue;
    if ((state.mover.get(id)?.waypoints.length ?? 0) > 0) continue;
    if (w.jammed) { startAction(state, events, id, "clearStoppage", secondsToTicks(F.clearStoppageSeconds), {}); continue; }
    const spare = fullestSpare(state.container.get(id), wd.feed.magazine);
    if (!w.magazine || w.magazine.rounds <= 0) {
      if (spare > 0) startAction(state, events, id, "reload", secondsToTicks(wd.reloadSeconds), {});
      else stop("ammunition");
      continue;
    }
    if (spare <= 0) {
      // Only the magazine in the weapon is left: he keeps it and reports.
      // One report per unit, not one per man.
      const top = topUnit(state, id);
      const already = top !== null && unitSoldiers(state, top).some((m) => m !== id && state.weapon.get(m)?.lowAmmoReported === true);
      if (!w.lowAmmoReported) w.lowAmmoReported = true;
      if (!already && !w.lowAmmoRadioed) {
        w.lowAmmoRadioed = true;
        events.emit({ kind: "radio", tick, side: state.identity.req(id).side, from: id, key: "radio.lowAmmo", params: { callsign: state.unit.get(state.identity.req(id).unit)?.callsign ?? "" } });
      }
      stop("ammunition");
      continue;
    }
    if (tick < w.nextShotTick) continue;
    const me = state.transform.req(id);
    const range = hypot2(task.x - me.x, task.y - me.y);
    const trickle = since > fullTicks;
    const band = F.bands.find((b) => range <= b.maxRangeM) ?? F.bands[F.bands.length - 1]!;
    const canBurst = wd.fireModes.includes("auto") || wd.fireModes.includes("burst");
    const mode = trickle ? "aimed" : band.mode === "burst" && !canBurst ? "rapid" : band.mode;
    if (w.burstLeft <= 0) {
      if (friendInLine(ctx, state, id, task.x, task.y)) { w.nextShotTick = tick + TICK_HZ / 2; continue; }
      w.burstLeft = mode === "burst" ? band.burstRounds : 1;
      w.burstIndex = 0;
    }
    shoot(ctx, state, events, id, w, task, mode === "aimed");
    w.burstLeft--;
    w.burstIndex++;
    if (w.burstLeft > 0 && w.magazine.rounds > 0 && !w.jammed) {
      w.nextShotTick = tick + Math.max(1, Math.round((TICK_HZ * 60) / wd.cyclicRpm));
    } else {
      w.burstLeft = 0;
      const interval = trickle ? F.trickleIntervalS : band.intervalS;
      // +-15 % so men do not fire in step.
      w.nextShotTick = tick + Math.max(1, Math.round(secondsToTicks(interval) * (0.85 + 0.3 * nextFloat(state.rng, Streams.fire))));
    }
  }

  // ---- units whose last firing member has stopped
  for (const [uid, why] of [...ended.entries()].sort((a, b) => a[0] - b[0])) {
    const unit = state.unit.get(uid);
    if (!unit || !unit.firing) continue;
    if (unitSoldiers(state, uid).some((m) => state.fire.has(m))) continue;
    unit.firing = false;
    events.emit({ kind: "fire.ceased", tick, unit: uid, reason: why });
    if (why === "no-target") radioFromTarget(state, uid, "radio.noTarget", events);
  }
}

/**
 * Incoming fire: an enemy round fired past a unit (within the incoming radius of any member, out to the reach
 * distance from the muzzle) or striking near it gives its firing members reason to keep up the full rate.
 * A unit that had slowed to a trickle answers at once. (Suppression and fear come in M4; this is only the
 * ammunition-management clock.)
 */
export function incomingFireSystem(ctx: SimContext, state: SimState, events: readonly SimEvent[]): void {
  if (state.fire.size === 0) return;
  const F = ctx.catalog.shooting.fire;
  const r2 = F.incomingRadiusM * F.incomingRadiusM;
  let targets: { id: EntityId; x: number; y: number; side: string }[] | null = null;
  const refresh = new Set<EntityId>(); // top units
  for (const e of events) {
    let side: string | undefined;
    if (e.kind === "shot.fired") side = state.identity.get(e.shooter)?.side;
    else if (e.kind === "impact" && e.owner > 0) side = state.identity.get(e.owner)?.side;
    else continue;
    if (side === undefined) continue;
    if (targets === null) {
      targets = [];
      for (const [id] of state.fire.entries()) {
        const t = state.transform.req(id);
        targets.push({ id, x: t.x, y: t.y, side: state.identity.req(id).side });
      }
    }
    for (const m of targets) {
      if (m.side === side) continue;
      const dx = m.x - e.x, dy = m.y - e.y;
      let near: boolean;
      if (e.kind === "impact") near = dx * dx + dy * dy <= r2;
      else {
        const along = dx * e.dirX + dy * e.dirY;
        const across = dx * -e.dirY + dy * e.dirX;
        near = along > 0 && along <= F.incomingReachM && across * across <= r2;
      }
      if (near) { const top = topUnit(state, m.id); if (top !== null) refresh.add(top); }
    }
  }
  const fullTicks = secondsToTicks(F.fullRateSeconds);
  for (const top of [...refresh].sort((a, b) => a - b)) {
    for (const m of unitSoldiers(state, top)) {
      const task = state.fire.get(m);
      if (!task) continue;
      if (state.tick - task.reasonTick > fullTicks) {
        // He was on the slow rate: answer now, not at the next slow shot.
        const w = state.weapon.get(m);
        if (w) w.nextShotTick = Math.min(w.nextShotTick, state.tick + TICK_HZ / 2);
      }
      task.reasonTick = state.tick;
    }
  }
}
