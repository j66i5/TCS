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
import { navCostAt } from "../nav";
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
  if (!s || !t || !c || !isAble(s) || !s.impair.canUseArms || state.tick < s.stunnedUntilTick || state.action.has(id)) return null;
  const G = ctx.catalog.shooting.grenades;
  const d = hypot2(x - t.x, y - t.y);
  if (d < G.minSafeDistanceM) return null;
  let launched: GrenadeOption | null = null;
  for (const st of [...c.stacks].sort((a, b) => (a.type < b.type ? -1 : a.type > b.type ? 1 : 0))) {
    if (st.count <= 0) continue;
    const def = ctx.catalog.ammo[st.type];
    if (!def?.delivery || !def.explosive) continue;
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
 * Is the arc from (ox, oy, oz) toward azimuth `az` clear of walls and roofs until a metre short of `d`?
 * Doors, windows and breaches let it through; so the same test finds the throw through a window.
 */
export function arcClear(ctx: SimContext, am: AmmoRT, ox: number, oy: number, oz: number, az: number, v: number, el: number, d: number): boolean {
  const bal = ctx.catalog.ballistics, B = ctx.ballistics, map = ctx.map;
  const ca = cos(az), sa = sin(az);
  let x = 0, z = oz, vx = v * cos(el), vz = v * sin(el);
  const inside = (px: number, py: number) => px >= 0 && py >= 0 && px < map.widthM && py < map.heightM;
  for (let k = 0; k < 60 * 30 && x < d - 1; k++) {
    const s = sqrt(vx * vx + vz * vz);
    const cdv = am.dragA * s + am.dragB, cap = am.dragMax * s;
    const a = am.kDrag * bal.airDensityKgM3 * (cdv < cap ? cdv : cap) * DT;
    const f = 1 / (1 + a), g = 1 / (1 + 0.5 * a), gdt = bal.gravityMps2 * DT;
    const nx = x + vx * g * DT, nz = z + (vz * g - 0.5 * gdt) * DT;
    vx *= f; vz = vz * f - gdt;
    const ax = ox + ca * x, ay = oy + sa * x, bx = ox + ca * nx, by = oy + sa * nx;
    if (!inside(bx, by)) return true;
    if (nz <= heightAt(map, bx, by)) return true; // it has come down: nothing was in the way
    if (lineBlocked(B, map, ctx.mapIndex, ax, ay, z, bx, by, nz)) return false;
    for (let q = 0; q < 2; q++) {
      const ri = roofAt(B, ctx.mapIndex, q === 0 ? ax : bx, q === 0 ? ay : by);
      if (ri < 0) continue;
      const top = B.roofs[ri]!.heightM;
      if ((z - heightAt(map, ax, ay) - top > 0) !== (nz - heightAt(map, bx, by) - top > 0)) return false; // through the roof plane
    }
    x = nx; z = nz;
  }
  return true;
}

/** Send the grenade. Called when the action completes. */
function release(ctx: SimContext, state: SimState, id: EntityId, ammoId: string, tx0: number, ty0: number): "thrown" | "launched" | null {
  const def = ctx.catalog.ammo[ammoId], c = state.container.get(id);
  const s = state.soldier.get(id), t = state.transform.get(id);
  if (!def?.delivery || !def.explosive || !c || !s || !t) return null;
  if (removeItems(c, ammoId, 1).length === 0) return null; // he no longer has one
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
  let v: number, el: number;
  if (thrown) {
    // He can throw as hard as a full-range lob needs, and a little harder. He tries his throw angles in order
    // and takes the first whose path is clear of ceilings and walls (windows and doors count as clear); he aims
    // a little short, because the grenade bounces and rolls on.
    const ref = (G.throwElevationDeg * PI) / 180;
    const vMax = speedFor(ctx, am, ref, 0, throwRangeM(ctx, state, id), 60) * G.throwPowerMargin;
    v = 0; el = ref;
    for (let k = 0; k < G.throwAnglesDeg.length; k++) {
      const e = (G.throwAnglesDeg[k]! * PI) / 180;
      let vv = speedFor(ctx, am, e, drop, d, vMax);
      vv = speedFor(ctx, am, e, drop, Math.max(1, d - G.carrySeconds * vv * cos(e)), vMax);
      if (k === 0) { v = vv; el = e; }
      if (arcClear(ctx, am, ox, oy, oz, az, vv, e, d)) { v = vv; el = e; break; }
    }
  } else {
    // A fixed muzzle velocity; he chooses the elevation: the flat arc, or the high one if the flat one is blocked.
    v = def.delivery.velocityMps ?? 70;
    let lo = -0.2, hi = (40 * PI) / 180;
    for (let k = 0; k < 16; k++) { const mid = (lo + hi) / 2; if (arcRangeM(ctx, am, v, mid, drop) < d) lo = mid; else hi = mid; }
    el = (lo + hi) / 2;
    if (!arcClear(ctx, am, ox, oy, oz, az, v, el, d)) {
      lo = (45 * PI) / 180; hi = (82 * PI) / 180; // beyond 45 degrees a steeper barrel means a shorter shot
      for (let k = 0; k < 16; k++) { const mid = (lo + hi) / 2; if (arcRangeM(ctx, am, v, mid, drop) > d) lo = mid; else hi = mid; }
      const high = (lo + hi) / 2;
      if (arcClear(ctx, am, ox, oy, oz, az, v, high, d)) el = high;
    }
  }
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
    if (method) events.emit({ kind: "grenade.launched", tick: state.tick, soldier: actor, ammo, method, x, y });
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
      if (s.evade !== null || !isAble(s) || state.tick < s.stunnedUntilTick) continue;
      const t = state.transform.get(id);
      if (!t) continue;
      const d = hypot2(t.x - e.x, t.y - e.y);
      if (d > G.reactRadiusM) continue;
      const cz = heightAt(ctx.map, t.x, t.y) + ctx.catalog.body.postures[s.posture].heightM * 0.5;
      if (lineBlocked(ctx.ballistics, ctx.map, ctx.mapIndex, e.x, e.y, e.z + 0.1, t.x, t.y, cz, ctx.catalog.ballistics.blast.shieldSteelMm)) continue;
      s.evade = { x: e.x, y: e.y, startTick: state.tick + Math.round(G.reactDelaySeconds / DT), untilTick: e.burstTick + AFTER_TICKS, run: d <= G.runRadiusM };
    }
  }
}

/** Carry out the reactions: run from the grenade or drop flat. Runs before movement (which skips these men). */
export function evadeSystem(ctx: SimContext, state: SimState, events: EventSink): void {
  let top = 0;
  for (const m of Object.values(ctx.catalog.movementModes)) if (m.class === "foot" && m.speedMps > top) top = m.speedMps;
  for (const [id, s] of state.soldier.entries()) {
    const ev = s.evade;
    if (ev === null) continue;
    if (!isAble(s) || state.tick >= ev.untilTick) { s.evade = null; continue; }
    if (state.tick < ev.startTick || state.tick < s.stunnedUntilTick) continue;
    if (state.tick === ev.startTick) interruptAction(state, events, id, "take-cover"); // whatever he was doing with his hands
    const t = state.transform.req(id);
    if (ev.run && s.impair.canWalk && s.posture !== "prone" && state.tick < ev.untilTick - AFTER_TICKS - DIVE_TICKS) {
      if (s.postureTo !== null) continue;
      let ux = t.x - ev.x, uy = t.y - ev.y;
      const d = hypot2(ux, uy);
      if (d < 1e-6) { ux = cos(t.heading); uy = sin(t.heading); } else { ux /= d; uy /= d; }
      const step = top * ctx.catalog.body.postures[s.posture].speedFactor * s.impair.move * DT;
      const nx = t.x + ux * step, ny = t.y + uy * step;
      const grid = navFor(ctx, "foot").grid;
      if (nx > 0 && ny > 0 && nx < ctx.map.widthM && ny < ctx.map.heightM && navCostAt(grid, nx, ny) > 0 && grid.wall[Math.floor(ny / grid.cellM) * grid.cols + Math.floor(nx / grid.cellM)] !== 1) {
        t.x = nx; t.y = ny; t.heading = atan2(uy, ux);
        continue;
      }
    }
    requestPosture(ctx, state, id, "prone");
  }
}
