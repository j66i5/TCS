/**
 * GRENADES (SPEC 6.3): thrown by hand or fired from a launcher the soldier carries.
 *
 * A grenade is a counted item (it is also an ammunition entry with an explosive filling and a `delivery`).
 * Throwing or launching is an ACTION that takes time and can be interrupted; when it completes, one item
 * leaves the man's load and one projectile enters the world on an arc toward the point given, with an error
 * that depends on distance and training. From there the projectile engine and the fuse do the rest.
 */
import type { ActionHandler } from "../actions";
import type { AmmoRT } from "../ballistics";
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

/** Send the grenade. Called when the action completes. */
function release(ctx: SimContext, state: SimState, id: EntityId, ammoId: string, tx: number, ty: number): "thrown" | "launched" | null {
  const def = ctx.catalog.ammo[ammoId], c = state.container.get(id);
  const s = state.soldier.get(id), t = state.transform.get(id);
  if (!def?.delivery || !def.explosive || !c || !s || !t) return null;
  if (removeItems(c, ammoId, 1).length === 0) return null; // he no longer has one
  const G = ctx.catalog.shooting.grenades;
  const am = ctx.ballistics.ammo[ctx.catalog.ammoIds.indexOf(ammoId)]!;
  const thrown = def.delivery.method === "thrown";
  const d0 = hypot2(tx - t.x, ty - t.y);
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
    // A lob at a fixed angle; he chooses how hard to throw.
    el = (G.throwElevationDeg * PI) / 180;
    let lo = 2, hi = 40;
    for (let k = 0; k < 16; k++) { const mid = (lo + hi) / 2; if (arcRangeM(ctx, am, mid, el, drop) < d) lo = mid; else hi = mid; }
    v = (lo + hi) / 2;
  } else {
    // A fixed muzzle velocity; he chooses the elevation (the flat arc).
    v = def.delivery.velocityMps ?? 70;
    let lo = -0.2, hi = (40 * PI) / 180;
    for (let k = 0; k < 16; k++) { const mid = (lo + hi) / 2; if (arcRangeM(ctx, am, v, mid, drop) < d) lo = mid; else hi = mid; }
    el = (lo + hi) / 2;
  }
  const ce = cos(el);
  launchProjectile(ctx, state, ammoId, ox, oy, oz, v * cos(az) * ce, v * sin(az) * ce, v * sin(el), id);
  return def.delivery.method;
}

/** Action "grenade": params { ammo, x, y }. Interrupted if the man can no longer use his arms. */
export const grenadeHandler: ActionHandler = {
  check(_ctx, state, actor) {
    const s = state.soldier.get(actor);
    return isAble(s) && s!.impair.canUseArms ? null : "unable";
  },
  complete(ctx, state, actor, a, events) {
    const ammo = String(a.params["ammo"]), x = Number(a.params["x"]), y = Number(a.params["y"]);
    const method = release(ctx, state, actor, ammo, x, y);
    if (method) events.emit({ kind: "grenade.launched", tick: state.tick, soldier: actor, ammo, method, x, y });
  },
};
