/**
 * GRENADES (SPEC 6.3): thrown by hand or fired from a launcher the soldier carries.
 *
 * A grenade is a counted item (it is also an ammunition entry with an explosive filling and a `delivery`).
 * Throwing or launching is an ACTION that takes time and can be interrupted; when it completes, one item
 * leaves the man's load and one projectile enters the world on an arc toward the point given, with an error
 * that depends on distance and training. From there the projectile engine and the fuse do the rest.
 */
import { interruptAction, registerActionHandler, type ActionHandler } from "../actions";
import type { EventSink } from "../events";
import { findPath, navCostAt } from "../nav";
import { navFor } from "../navctx";
import { requestPosture } from "./body";
import { lineBlocked, roofAt, type AmmoRT } from "../ballistics";
import type { SimContext } from "../context";
import { DT, type EntityId } from "../ids";
import { isAble } from "../impair";
import { removeItems } from "../items";
import { atan2, cos, hypot2, PI, sin, sqrt } from "../math";
import { nextNormal, Streams } from "../rng";
import type { SimState } from "../state";
import { heightAt } from "../terrain";
import { launchProjectile } from "./ballistics";
import { skillFactor } from "./fire";

export interface GrenadeOption { ammo: string; method: "thrown" | "launched"; distanceM: number }

/** How far this man throws from his present posture (owner decision: about 30 m standing for a regular). */
export function throwRangeM(ctx: SimContext, state: SimState, id: EntityId): number {
  const s = state.soldier.req(id);
  return ctx.catalog.shooting.grenades.throwRangeM[s.posture] * (0.8 + 0.4 * (s.skills["marksmanship"] ?? 0.5));
}

/** What, if anything, this man can send to (x, y) right now. Hand grenades first, then the launcher. */
export function grenadeOption(ctx: SimContext, state: SimState, id: EntityId, x: number, y: number): GrenadeOption | null {
  const s = state.soldier.get(id), t = state.transform.get(id), c = state.container.get(id);
  if (!s || !t || !c || !isAble(s) || !s.impair.canUseArms || state.tick < s.stunnedUntilTick || state.action.has(id) || s.evade !== null) return null;
  const G = ctx.catalog.shooting.grenades;
  const d = hypot2(x - t.x, y - t.y);
  if (d < G.minSafeDistanceM) return null;
  let launched: GrenadeOption | null = null;
  for (const st of [...c.stacks].sort((a, b) => (a.type < b.type ? -1 : a.type > b.type ? 1 : 0))) {
    if (st.count <= 0) continue;
    const def = ctx.catalog.ammo[st.type];
    if (!def?.delivery || !def.explosive || def.delivery.method === "direct") continue; // rockets are aimed, not lobbed (M7.4a)
    if (def.delivery.method === "thrown") {
      if (d <= throwRangeM(ctx, state, id)) return { ammo: st.type, method: "thrown", distanceM: d };
    } else if (launched === null) {
      const v = def.delivery.velocityMps ?? 0;
      const has = def.delivery.launcher !== undefined && c.stacks.some((x2) => x2.type === def.delivery!.launcher && x2.count > 0);
      const armM = v * (def.explosive.armingSeconds ?? 0) * 1.2;
      if (has && d >= armM && d <= (def.delivery.maxRangeM ?? 300)) launched = { ammo: st.type, method: "launched", distanceM: d };
    }
  }
  return launched;
}

/**
 * Horizontal distance flown before coming down to `dropM` below the point of release (negative = above),
 * for speed v and elevation el, with the munition's drag in standard air.
 */
export function arcRangeM(ctx: SimContext, am: AmmoRT, v: number, el: number, dropM: number): number {
  const bal = ctx.catalog.ballistics;
  let x = 0, z = 0, vx = v * cos(el), vz = v * sin(el);
  for (let k = 0; k < 60 * 30; k++) {
    const s = sqrt(vx * vx + vz * vz);
    const cdv = am.dragA * s + am.dragB, cap = am.dragMax * s;
    const a = am.kDrag * bal.airDensityKgM3 * (cdv < cap ? cdv : cap) * DT;
    const f = 1 / (1 + a), g = 1 / (1 + 0.5 * a), gdt = bal.gravityMps2 * DT;
    const nx = x + vx * g * DT, nz = z + (vz * g - 0.5 * gdt) * DT;
    vx *= f; vz = vz * f - gdt;
    if (vz < 0 && nz <= -dropM) {
      const f = z - nz > 1e-9 ? (z + dropM) / (z - nz) : 1;
      return x + (nx - x) * (f < 0 ? 0 : f > 1 ? 1 : f);
    }
    x = nx; z = nz;
  }
  return x;
}

/** The speed at which a throw at elevation `el` comes down `d` metres away (at most vMax: then it falls short). */
function speedFor(ctx: SimContext, am: AmmoRT, el: number, drop: number, d: number, vMax: number): number {
  if (arcRangeM(ctx, am, vMax, el, drop) <= d) return vMax;
  let lo = 1, hi = vMax;
  for (let k = 0; k < 16; k++) { const mid = (lo + hi) / 2; if (arcRangeM(ctx, am, mid, el, drop) < d) lo = mid; else hi = mid; }
  return (lo + hi) / 2;
}

/**
 * Where the arc from (ox, oy, oz) toward azimuth `az` comes down (horizontal distance from the start), or -1 if
 * it strikes a wall or a roof first, or would fly longer than the engine keeps a projectile. Doors, windows
 * and breaches let it through, so the same test finds the throw through a window.
 */
export function arcLanding(ctx: SimContext, am: AmmoRT, ox: number, oy: number, oz: number, az: number, v: number, el: number): number {
  const bal = ctx.catalog.ballistics, B = ctx.ballistics, map = ctx.map;
  const ca = cos(az), sa = sin(az);
  let x = 0, z = oz, vx = v * cos(el), vz = v * sin(el);
  const steps = Math.floor((bal.maxFlightSeconds * 0.85) / DT);
  for (let k = 0; k < steps; k++) {
    const s = sqrt(vx * vx + vz * vz);
    const cdv = am.dragA * s + am.dragB, cap = am.dragMax * s;
    const a = am.kDrag * bal.airDensityKgM3 * (cdv < cap ? cdv : cap) * DT;
    const f = 1 / (1 + a), g = 1 / (1 + 0.5 * a), gdt = bal.gravityMps2 * DT;
    const nx = x + vx * g * DT, nz = z + (vz * g - 0.5 * gdt) * DT;
    vx *= f; vz = vz * f - gdt;
    const ax = ox + ca * x, ay = oy + sa * x, bx = ox + ca * nx, by = oy + sa * nx;
    if (bx < 0 || by < 0 || bx >= map.widthM || by >= map.heightM) return nx;
    if (lineBlocked(B, map, ctx.mapIndex, ax, ay, z, bx, by, nz)) return -1;
    for (let q = 0; q < 2; q++) {
      const ri = roofAt(B, ctx.mapIndex, q === 0 ? ax : bx, q === 0 ? ay : by);
      if (ri < 0) continue;
      const top = B.roofs[ri]!.heightM;
      if ((z - heightAt(map, ax, ay) - top > 0) !== (nz - heightAt(map, bx, by) - top > 0)) return -1; // through the roof plane
    }
    if (nz <= heightAt(map, bx, by)) return nx; // it has come down: nothing was in the way
    x = nx; z = nz;
  }
  return -1;
}

/** Send the grenade. Called when the action completes. */
function release(ctx: SimContext, state: SimState, id: EntityId, ammoId: string, tx0: number, ty0: number): "thrown" | "launched" | "blocked" | null {
  const def = ctx.catalog.ammo[ammoId], c = state.container.get(id);
  const s = state.soldier.get(id), t = state.transform.get(id);
  if (!def?.delivery || def.delivery.method === "direct" || !def.explosive || !c || !s || !t) return null;
  if (!c.stacks.some((st) => st.type === ammoId && st.count > 0)) return null; // he no longer has one
  const G = ctx.catalog.shooting.grenades;
  const am = ctx.ballistics.ammo[ctx.catalog.ammoIds.indexOf(ammoId)]!;
  const thrown = def.delivery.method === "thrown";
  // He throws from where and how he is NOW: if the point is out of reach by now, as far as he can toward it.
  let tx = tx0, ty = ty0, d0 = hypot2(tx - t.x, ty - t.y);
  if (thrown) {
    const reach = throwRangeM(ctx, state, id);
    if (d0 > reach) { tx = t.x + ((tx - t.x) * reach) / d0; ty = t.y + ((ty - t.y) * reach) / d0; d0 = reach; }
  }
  // Where it will really go: an error that grows with distance and shrinks with training.
  const sd = ((thrown ? G.throwErrorMinM : G.launchErrorMinM) + (thrown ? G.throwErrorFraction : G.launchErrorFraction) * d0) * skillFactor(ctx, s.skills["marksmanship"] ?? 0.5);
  const ax = tx + sd * nextNormal(state.rng, Streams.fire), ay = ty + sd * nextNormal(state.rng, Streams.fire);
  const az = atan2(ay - t.y, ax - t.x);
  t.heading = az;
  const ox = t.x + cos(az) * 0.4, oy = t.y + sin(az) * 0.4;
  const oz = heightAt(ctx.map, ox, oy) + ctx.catalog.body.postures[s.posture].muzzleHeightM + (thrown ? 0.3 : 0);
  const d = Math.max(1, hypot2(ax - ox, ay - oy));
  const drop = oz - heightAt(ctx.map, Math.min(Math.max(ax, 0), ctx.map.widthM - 0.01), Math.min(Math.max(ay, 0), ctx.map.heightM - 0.01));
  // An arc is good if it comes down unobstructed no more than `short` metres short of the point (and not far
  // beyond it), with no wall between where it comes down and the point.
  const good = (vv: number, e: number, short: number): boolean => {
    const L = arcLanding(ctx, am, ox, oy, oz, az, vv, e);
    if (L < 0 || L < d - short || L > d + 4) return false;
    if (L >= d - 0.3) return true;
    const lx = ox + cos(az) * L, ly = oy + sin(az) * L, px = ox + cos(az) * d, py = oy + sin(az) * d;
    const inMap = (qx: number, qy: number) => qx >= 0 && qy >= 0 && qx < ctx.map.widthM && qy < ctx.map.heightM;
    if (!inMap(lx, ly) || !inMap(px, py)) return true;
    return !lineBlocked(ctx.ballistics, ctx.map, ctx.mapIndex, lx, ly, heightAt(ctx.map, lx, ly) + 0.15, px, py, heightAt(ctx.map, px, py) + 0.15);
  };
  let v = 0, el = 0, found = false;
  if (thrown) {
    // He can throw as hard as a full-range lob needs, and a little harder. He tries his throw angles in order:
    // first aiming a little short (the grenade bounces and rolls on), then, if something stands just in front
    // of the point, straight at it. The first good arc is taken.
    const ref = (G.throwElevationDeg * PI) / 180;
    const vMax = speedFor(ctx, am, ref, 0, throwRangeM(ctx, state, id), 60) * G.throwPowerMargin;
    for (let pass = 0; pass < 2 && !found; pass++) {
      for (let k = 0; k < G.throwAnglesDeg.length && !found; k++) {
        const e = (G.throwAnglesDeg[k]! * PI) / 180;
        let vv = speedFor(ctx, am, e, drop, d, vMax);
        const carry = pass === 0 ? G.carrySeconds * vv * cos(e) : 0;
        if (pass === 0) vv = speedFor(ctx, am, e, drop, Math.max(1, d - carry), vMax);
        if (good(vv, e, carry + 1.5)) { v = vv; el = e; found = true; }
      }
    }
  } else {
    // A fixed muzzle velocity; he chooses the elevation: the flat arc, or the high one if the flat one is blocked.
    v = def.delivery.velocityMps ?? 70;
    let lo = -0.2, hi = (40 * PI) / 180;
    for (let k = 0; k < 16; k++) { const mid = (lo + hi) / 2; if (arcRangeM(ctx, am, v, mid, drop) < d) lo = mid; else hi = mid; }
    el = (lo + hi) / 2;
    found = good(v, el, 3);
    if (!found) {
      lo = (45 * PI) / 180; hi = (80 * PI) / 180; // beyond 45 degrees a steeper barrel means a shorter shot
      for (let k = 0; k < 16; k++) { const mid = (lo + hi) / 2; if (arcRangeM(ctx, am, v, mid, drop) > d) lo = mid; else hi = mid; }
      el = (lo + hi) / 2;
      found = good(v, el, 3); // also fails if the point is too near for any high shot, or the flight too long
    }
  }
  // Nothing he can do from here would get it there (a ceiling, a wall, a lintel in the way): he does not throw.
  if (!found) return "blocked";
  if (removeItems(c, ammoId, 1).length === 0) return null; // he no longer has one
  const ce = cos(el);
  launchProjectile(ctx, state, ammoId, ox, oy, oz, v * cos(az) * ce, v * sin(az) * ce, v * sin(el), id);
  return def.delivery.method;
}

/** Action "grenade": params { ammo, x, y }. Interrupted if the man can no longer use his arms. */
export const grenadeHandler: ActionHandler = {
  check(_ctx, state, actor) {
    const s = state.soldier.get(actor);
    if (!isAble(s) || !s!.impair.canUseArms) return "unable";
    // A new order to move or to change posture breaks it off (the grenade stays in his load).
    if ((state.mover.get(actor)?.waypoints.length ?? 0) > 0) return "moved";
    return s!.postureTo !== null ? "posture" : null;
  },
  complete(ctx, state, actor, a, events) {
    const ammo = String(a.params["ammo"]), x = Number(a.params["x"]), y = Number(a.params["y"]);
    const method = release(ctx, state, actor, ammo, x, y);
    if (method === "blocked") {
      // He keeps the grenade and says so.
      const ident = state.identity.get(actor);
      if (ident) events.emit({ kind: "radio", tick: state.tick, side: ident.side, from: actor, key: "radio.grenadeBlocked", params: { callsign: state.unit.get(ident.unit)?.callsign ?? "" } });
    } else if (method) {
      events.emit({ kind: "grenade.launched", tick: state.tick, soldier: actor, ammo, method, x, y });
      // Throw and get down: his own fragments reach further than he throws.
      if (method === "thrown") requestPosture(ctx, state, actor, "prone");
    }
  },
};

registerActionHandler("grenade", grenadeHandler);

/** Ticks before the burst at which a running man throws himself down. */
const DIVE_TICKS = 85;
/** Ticks after the burst before he thinks of anything else. */
const AFTER_TICKS = 20;

/**
 * REACTION (owner decision 2026-11-11, ahead of the behaviour model in M4): a grenade with a running fuse lands;
 * every able man within reactRadiusM who is not behind a solid wall drops flat after a moment — or, if it is
 * within runRadiusM, first runs straight away from it and throws himself down just before it bursts.
 * (Everyone notices it: who sees what arrives in M3.)
 */
export function grenadeReactionSystem(ctx: SimContext, state: SimState, events: EventSink): void {
  const G = ctx.catalog.shooting.grenades;
  if (G.reactRadiusM <= 0) return;
  const list = events.events;
  for (let k = 0; k < list.length; k++) {
    const e = list[k]!;
    if (e.kind !== "grenade.landed" || e.burstTick <= state.tick) continue;
    for (const [id, s] of state.soldier.entries()) {
      if (!isAble(s) || state.tick < s.stunnedUntilTick || s.mount !== undefined) continue; // men aboard: behind armour
      const t = state.transform.get(id);
      if (!t) continue;
      const d = hypot2(t.x - e.x, t.y - e.y);
      if (d > G.reactRadiusM) continue;
      // Already getting away from one: only a nearer threat changes his mind (a second grenade, or the same
      // one rolling toward him); in any case he stays down until the later burst is over.
      const cur = s.evade;
      if (cur !== null && hypot2(t.x - cur.x, t.y - cur.y) <= d) {
        if (e.burstTick + AFTER_TICKS > cur.untilTick) cur.untilTick = e.burstTick + AFTER_TICKS;
        continue;
      }
      const cz = heightAt(ctx.map, t.x, t.y) + ctx.catalog.body.postures[s.posture].heightM * 0.5;
      if (lineBlocked(ctx.ballistics, ctx.map, ctx.mapIndex, e.x, e.y, e.z + 0.1, t.x, t.y, cz, ctx.catalog.ballistics.blast.shieldSteelMm)) continue;
      const start = cur !== null && state.tick >= cur.startTick ? state.tick : state.tick + Math.round(G.reactDelaySeconds / DT);
      s.evade = {
        x: e.x, y: e.y, startTick: cur !== null ? Math.min(cur.startTick, start) : start,
        untilTick: Math.max(cur?.untilTick ?? 0, e.burstTick + AFTER_TICKS), run: d <= G.runRadiusM, ran: cur?.ran ?? false,
      };
    }
  }
}

/** Carry out the reactions: run from the grenade or drop flat. Runs before movement (which skips these men). */
export function evadeSystem(ctx: SimContext, state: SimState, events: EventSink): void {
  let top = 0;
  for (const m of Object.values(ctx.catalog.movementModes)) if (m.class === "foot" && m.speedMps > top) top = m.speedMps;
  // mounted: ok a man aboard is never given an evade (grenade reaction and vehicle corridors skip him)
  for (const [id, s] of state.soldier.entries()) {
    const ev = s.evade;
    if (ev === null) continue;
    if (!isAble(s) || state.tick >= ev.untilTick) {
      if (ev.ran && isAble(s)) rejoinRoute(ctx, state, id);
      s.evade = null;
      continue;
    }
    if (state.tick < ev.startTick) continue;
    if (state.tick < s.stunnedUntilTick) { const mv = state.mover.get(id); if (mv) mv.speedMps = 0; continue; }
    if (state.action.has(id)) interruptAction(state, events, id, "take-cover"); // whatever he was doing with his hands
    const t = state.transform.req(id);
    // (Out of a vehicle's way, M7: he runs aside to the last tick and does not dive.)
    if (ev.run && s.impair.canWalk && s.posture !== "prone" && state.tick < (ev.aside ? ev.untilTick : ev.untilTick - AFTER_TICKS - DIVE_TICKS)) {
      if (s.postureTo !== null) continue;
      let ux = t.x - ev.x, uy = t.y - ev.y;
      const d = hypot2(ux, uy);
      if (d < 1e-6) { ux = cos(t.heading); uy = sin(t.heading); } else { ux /= d; uy /= d; }
      const step = top * ctx.catalog.body.postures[s.posture].speedFactor * s.impair.move * DT;
      const nx = t.x + ux * step, ny = t.y + uy * step;
      const grid = navFor(ctx, "foot").grid;
      if (nx > 0 && ny > 0 && nx < ctx.map.widthM && ny < ctx.map.heightM && navCostAt(grid, nx, ny) > 0 && grid.wall[Math.floor(ny / grid.cellM) * grid.cols + Math.floor(nx / grid.cellM)] !== 1) {
        t.x = nx; t.y = ny; t.heading = atan2(uy, ux);
        const mv = state.mover.get(id);
        if (mv) mv.speedMps = step / DT;
        ev.ran = true;
        continue;
      }
    }
    const mv = state.mover.get(id);
    if (mv) mv.speedMps = 0;
    if (!ev.aside) requestPosture(ctx, state, id, "prone");
  }
}

/** He ran off his planned way: find a way back to its next point instead of walking straight at it. */
function rejoinRoute(ctx: SimContext, state: SimState, id: EntityId): void {
  const m = state.mover.get(id), t = state.transform.get(id);
  const wp = m?.waypoints[0];
  if (!m || !t || !wp) return;
  const search = navFor(ctx, ctx.catalog.movementModes[wp.mode]?.class ?? "foot").search;
  const p = findPath(search, t.x, t.y, wp.x, wp.y, { maxExpansions: 6000 }) ?? findPath(search, t.x, t.y, wp.x, wp.y);
  if (!p) { m.waypoints = []; return; } // no way back: he stays where he is
  const lead = [];
  for (let i = 0; i + 2 < p.points.length; i += 2) lead.push({ ...wp, x: p.points[i]!, y: p.points[i + 1]! });
  m.waypoints = [...lead, ...m.waypoints];
  m.formation = null; // he walks his own way from here
  m.slotLagM = 0;
}
