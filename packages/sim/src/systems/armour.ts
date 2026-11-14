/**
 * ARMOUR, PENETRATION AND DAMAGE INSIDE (M7.4a, plan §8; owner Q11, Q14, Q15).
 *
 * The projectile loop finds where a round strikes a hull or turret box (face and part) and queues the hits the
 * armour must decide; `resolveVehicleHit` runs after the loop:
 *   plate        the plate of that part and face (data); its normal leans back by its slope; the path through
 *                it is thickness / cos(angle of incidence) (at most 20 x thickness), times the material's
 *                resistance per mm (mild-steel equivalent; shaped charges meet `resistanceShaped`).
 *   kinetic      ricochet at grazing angles (chance, as for walls, by the material's angle x the round's
 *                ricochetFactor); else it penetrates if its penetration at that speed is >= the need, else stops.
 *   shaped       an impact-fused warhead striking at a grazing angle may fail to go off; an armed one bursts on
 *                the plate (blast and fragments outside) and its jet penetrates if its penetration >= the need.
 *   HE contact   impact high explosive bursts on the plate as before; its blast holes a plate thinner than the
 *                breach rule (ballistics.json blast) and damages a track it strikes.
 *   inside       (owner Q11: path plus a fragment cone) the penetrator or jet goes on along its path, through
 *                seated men (wounds by the body rules) and components (condition down by what it has left
 *                against the component's toughness; passing costs it), the jet losing penetration per metre; a
 *                kinetic round that still beats the far plate flies out again (re-added after the loop). Behind
 *                the hole a cone of fragments (`behindArmour`) strikes the first man or component on each line.
 *                A hit on fuel or ammunition may start a fire; on ammunition, blow it up at once.
 *   outcome      engine or a track wrecked: immobilised; gun wrecked: disarmed. Crew reaction (owner Q14/Q15):
 *                the crew and passengers get out when the vehicle burns, or when it is immobilised and then
 *                penetrated again (an immobilised vehicle with a working gun fights on while hits bounce off);
 *                also when it can neither move nor fire, or no crewman can act. Fire burns it out after a while,
 *                the ammunition may cook off: destroyed; men still inside are burnt.
 *
 * Randomness: the "armour" stream (created on first use: vehicle-free battles never draw from it). No
 * allocation on the stopped-round path; one event per hit (small arms stay aggregated per vehicle and tick).
 */
import { addSmoke } from "./support";
import type { VehicleComponent, VehicleDef } from "../catalog";
import type { VehicleState } from "../components";
import type { SimContext } from "../context";
import type { EventSink } from "../events";
import { secondsToTicks, type EntityId } from "../ids";
import { isAble } from "../impair";
import { atan2, cbrt, cos, hypot2, PI, pow, sin, sqrt, wrapAngle } from "../math";
import { addProjectile } from "../projectiles";
import { nextFloat, Streams } from "../rng";
import type { SimState } from "../state";
import type { PlateRT, VehicleGrid } from "../ballistics";
import { addStoppedHit } from "../hulls";
import { applyBurn, resolveBodyHit, ZONE_GROUPS } from "./wounds";
import { getOut } from "./boarding";
import { removeItems } from "../items";
import { compCondition, hasDriver, occupant, vehicleItems } from "../mount";
import { vehicleMove } from "./drive";
import { canEngageAt, dischargeSmoke } from "./gunnery";
import { aimHeightAt } from "./fire";
import { launcherRound } from "./launcher";
import { heightAt } from "../terrain";
import { radioFromTarget } from "./orders";

const FACE_NAMES = ["front", "side", "rear", "top"] as const;

/** A part's frame in the world: origin, height datum, cos/sin of its facing. */
interface Frame { ox: number; oy: number; gz: number; c: number; s: number }
const HULL: Frame = { ox: 0, oy: 0, gz: 0, c: 1, s: 0 };
const TURRET: Frame = { ox: 0, oy: 0, gz: 0, c: 1, s: 0 };
function frames(G: VehicleGrid, j: number): void {
  HULL.ox = G.x[j]!; HULL.oy = G.y[j]!; HULL.gz = G.gz[j]!; HULL.c = G.ch[j]!; HULL.s = G.sh[j]!;
  TURRET.ox = G.tx[j]!; TURRET.oy = G.ty[j]!; TURRET.gz = G.gz[j]!; TURRET.c = G.tch[j]!; TURRET.s = G.tsh[j]!;
}

/**
 * The plate a round meets and what it takes to get through it, for a path with unit direction (df, dr, du) in
 * the struck part's frame (f forward, r right, u up), striking face `face` on side `rSign` (+1 right, -1 left).
 * Pure: used by the hit resolution and the armour lab.
 */
export function plateNeed(p: PlateRT | null, face: number, rSign: number, df: number, dr: number, du: number, losFloorCos: number): { needK: number; needS: number; cosInc: number; sinCrit: number } {
  if (!p) return { needK: 0, needS: 0, cosInc: 1, sinCrit: 0 };
  let nf = 0, nr = 0, nu = 1;
  if (face === 1) { nr = rSign * p.cosS; nu = p.sinS; }
  else if (face !== 3) { nf = (face === 0 ? 1 : -1) * p.cosS; nu = p.sinS; }
  let cosInc = -(df * nf + dr * nr + du * nu);
  if (cosInc < 0) cosInc = 0;
  const ce = cosInc < losFloorCos ? losFloorCos : cosInc;
  return { needK: (p.thicknessMm * p.kPerMm) / ce, needS: (p.thicknessMm * p.sPerMm) / ce, cosInc, sinCrit: p.sinCrit };
}

// ---- interior walk scratch (no allocation per hit beyond the small target list)
interface Target { t: number; kind: 0 | 1; index: number }
const TARGETS: Target[] = [];

let ct0 = 0, ct1 = 0;
/** Clip the ray p + t d (t in [0, L]) to a box in a frame; false if it misses. Result in ct0..ct1. */
function clipBox(fr: Frame, x: number, y: number, z: number, dx: number, dy: number, dz: number, L: number, f0: number, f1: number, r0: number, r1: number, u0: number, u1: number): boolean {
  const rx = x - fr.ox, ry = y - fr.oy;
  const pf = rx * fr.c + ry * fr.s, pr = -rx * fr.s + ry * fr.c, pu = z - fr.gz;
  const df = dx * fr.c + dy * fr.s, dr = -dx * fr.s + dy * fr.c;
  ct0 = 0; ct1 = L;
  return slab(pf, df, f0, f1) && slab(pr, dr, r0, r1) && slab(pu, dz, u0, u1);
}
function slab(p: number, d: number, lo: number, hi: number): boolean {
  if (d > -1e-12 && d < 1e-12) return p >= lo && p <= hi;
  let a = (lo - p) / d, b = (hi - p) / d;
  if (a > b) { const t = a; a = b; b = t; }
  if (a > ct0) ct0 = a;
  if (b < ct1) ct1 = b;
  return ct0 <= ct1;
}

/** How far (m) the path runs inside the hull and turret from (x, y, z): the farther exit of the boxes it is in. */
function insideLength(def: VehicleDef, x: number, y: number, z: number, dx: number, dy: number, dz: number): number {
  const h = def.body.hull;
  let L = 0;
  if (clipBox(HULL, x, y, z, dx, dy, dz, 20, h.f[0], h.f[1], h.r[0], h.r[1], h.u[0], h.u[1]) && ct0 < 0.05) L = ct1;
  const tr = def.body.turret;
  if (tr && clipBox(TURRET, x, y, z, dx, dy, dz, 20, tr.f[0], tr.f[1], tr.r[0], tr.r[1], tr.u[0], tr.u[1]) && ct0 < L + 0.05) {
    if (ct1 > L) L = ct1;
    // From the turret down into the hull below it.
    if (clipBox(HULL, x, y, z, dx, dy, dz, 20, h.f[0], h.f[1], h.r[0], h.r[1], h.u[0], h.u[1]) && ct0 < L + 0.05 && ct1 > L) L = ct1;
  }
  return L;
}

/** Men in seats and components along the path within [0, L], nearest first. */
function collectTargets(ctx: SimContext, v: VehicleState, def: VehicleDef, x: number, y: number, z: number, dx: number, dy: number, dz: number, L: number, firstOnly: boolean): number {
  const A = ctx.catalog.ballistics.armour;
  let n = 0;
  const push = (t: number, kind: 0 | 1, index: number) => {
    if (firstOnly && n > 0) { if (t < TARGETS[0]!.t) { TARGETS[0]!.t = t; TARGETS[0]!.kind = kind; TARGETS[0]!.index = index; } return; }
    const slot = TARGETS[n] ?? (TARGETS[n] = { t: 0, kind: 0, index: 0 });
    slot.t = t; slot.kind = kind; slot.index = index; n++;
  };
  for (let k = 0; k < def.seats.length; k++) {
    const who = v.seats[k];
    if (who === null || who === undefined) continue;
    const p = def.seats[k]!.pos;
    const u0 = p[2] - 0.4;
    if (clipBox(HULL, x, y, z, dx, dy, dz, L, p[0] - A.seatHalfM, p[0] + A.seatHalfM, p[1] - A.seatHalfM, p[1] + A.seatHalfM, u0, u0 + A.seatHeightM)) push(ct0, 0, k);
  }
  const comps = def.components ?? [];
  for (let k = 0; k < comps.length; k++) {
    const c = comps[k]!, b = c.box;
    if ((v.comp[k] ?? 1) <= 0) continue;
    if (clipBox(c.part === "turret" ? TURRET : HULL, x, y, z, dx, dy, dz, L, b.f[0], b.f[1], b.r[0], b.r[1], b.u[0], b.u[1])) push(ct0, 1, k);
  }
  if (!firstOnly) {
    // Insertion sort by distance (a handful of entries).
    for (let a = 1; a < n; a++) {
      const cur = TARGETS[a]!; const t = cur.t, kd = cur.kind, ix = cur.index;
      let b = a - 1;
      while (b >= 0 && (TARGETS[b]!.t > t || (TARGETS[b]!.t === t && TARGETS[b]!.index > ix))) { const nx = TARGETS[b + 1]!, pv = TARGETS[b]!; nx.t = pv.t; nx.kind = pv.kind; nx.index = pv.index; b--; }
      const d = TARGETS[b + 1]!; d.t = t; d.kind = kd; d.index = ix;
    }
  }
  return n;
}

/** Zone of a seated man struck from inside: weights of the body groups (head, neck, chest, abdomen, pelvis, arm, leg). */
const SEATED_ZONE_W = [0.1, 0.03, 0.25, 0.17, 0.1, 0.15, 0.2];
function seatedZone(state: SimState): number {
  let r = nextFloat(state.rng, Streams.armour);
  for (let k = 0; k < SEATED_ZONE_W.length; k++) { r -= SEATED_ZONE_W[k]!; if (r < 0) return k; }
  return 2;
}

/** What a hit did, for the event and the outcome. */
interface Damage { components: number[]; fire: boolean; cookOff: boolean; pen: boolean; fireAmmo: boolean }

function damageComponent(ctx: SimContext, state: SimState, events: EventSink, vid: EntityId, v: VehicleState, k: number, loss: number, ce: boolean, dmg: Damage): void {
  const c: VehicleComponent = ctx.catalog.vehicles[v.def]!.components![k]!;
  const before = v.comp[k] ?? 1;
  const after = Math.max(0, before - loss);
  if (after === before) return;
  v.comp[k] = after;
  if (!dmg.components.includes(k)) dmg.components.push(k);
  events.emit({ kind: "vehicle.component", tick: state.tick, vehicle: vid, component: k, condition: after });
  // A penetrating hit on fuel or ammunition may start a fire; on ammunition it may blow it up at once.
  if (c.cookOffChance !== undefined && nextFloat(state.rng, Streams.armour) < c.cookOffChance * (ce ? 1.2 : 1)) dmg.cookOff = true;
  else if (c.fireChance !== undefined && nextFloat(state.rng, Streams.armour) < c.fireChance * (ce ? 1.5 : 1)) { dmg.fire = true; if (c.kind === "ammo") dmg.fireAmmo = true; }
}

/**
 * The penetrator (or jet) inside: along its path through men and components; then the fragment cone behind
 * the hole. Returns the residual penetration left at the far side (kinetic) or 0.
 */
function interior(
  ctx: SimContext, state: SimState, events: EventSink, vid: EntityId, v: VehicleState, def: VehicleDef,
  x: number, y: number, z: number, dx: number, dy: number, dz: number, residual: number, energy: number, kind: "kinetic" | "shaped" | "blast",
  ammoId: string, owner: EntityId, spall: { spallCount: number; spallConeDeg: number; spallEnergyJ: number }, dmg: Damage,
): { residual: number; L: number } {
  const A = ctx.catalog.ballistics.armour;
  const L = insideLength(def, x, y, z, dx, dy, dz);
  let res = residual;
  if (kind !== "blast" && L > 0) {
    const reach = kind === "shaped" ? Math.min(L, residual / Math.max(1e-6, A.jetDecayMmPerM)) : L;
    const n = collectTargets(ctx, v, def, x, y, z, dx, dy, dz, reach, false);
    const can0 = residual;
    for (let q = 0; q < n && res > 0; q++) {
      const tg = TARGETS[q]!;
      // The jet loses penetration with the distance it has run inside.
      const left = kind === "shaped" ? residual - A.jetDecayMmPerM * tg.t : res;
      if (left <= 0) break;
      if (tg.kind === 1) {
        const c = def.components![tg.index]!;
        damageComponent(ctx, state, events, vid, v, tg.index, Math.min(1, left / c.toughnessMm), kind === "shaped", dmg);
        res = (kind === "shaped" ? left : res) - c.absorbMm;
      } else {
        const man = v.seats[tg.index];
        if (man !== null && man !== undefined) {
          const g = seatedZone(state);
          const e = kind === "shaped" ? 4000 : energy * Math.max(0, left / Math.max(1e-6, can0));
          resolveBodyHit(ctx, state, events, man, ZONE_GROUPS[g]!, nextFloat(state.rng, Streams.armour) < 0.5, true, left, e, ammoId, owner, false);
        }
        res = (kind === "shaped" ? left : res) - 15;
      }
    }
    if (kind === "shaped") res = 0;
  }
  // Fragments of the plate and the round in a cone behind the hole: each strikes the first man or part on its line.
  const cone = (spall.spallConeDeg * PI) / 180;
  // Two directions across the path.
  let ax = -dy, ay = dx;
  const az = 0;
  let al = sqrt(ax * ax + ay * ay);
  if (al < 1e-6) { ax = 1; ay = 0; al = 1; }
  ax /= al; ay /= al;
  const bx = dy * az - dz * ay, by = dz * ax - dx * az, bz = dx * ay - dy * ax;
  for (let k = 0; k < spall.spallCount; k++) {
    const th = cone * sqrt(nextFloat(state.rng, Streams.armour)), ph = 2 * PI * nextFloat(state.rng, Streams.armour);
    const st = sin(th), c1 = cos(ph) * st, c2 = sin(ph) * st, cth = cos(th);
    const ex = dx * cth + ax * c1 + bx * c2, ey = dy * cth + ay * c1 + by * c2, ez = dz * cth + az * c1 + bz * c2;
    const Lk = insideLength(def, x, y, z, ex, ey, ez);
    if (Lk <= 0) continue;
    if (collectTargets(ctx, v, def, x, y, z, ex, ey, ez, Lk, true) === 0) continue;
    const tg = TARGETS[0]!;
    if (tg.kind === 1) damageComponent(ctx, state, events, vid, v, tg.index, A.spallComponentDamage, kind === "shaped", dmg);
    else {
      const man = v.seats[tg.index];
      if (man !== null && man !== undefined) resolveBodyHit(ctx, state, events, man, ZONE_GROUPS[seatedZone(state)]!, nextFloat(state.rng, Streams.armour) < 0.5, true, 3, spall.spallEnergyJ, ammoId, owner, true);
    }
  }
  return { residual: res, L };
}

/** Default fragment cones when the ammunition gives none (game values). */
const SPALL_KINETIC = { spallCount: 8, spallConeDeg: 20, spallEnergyJ: 120 };
const SPALL_SHAPED = { spallCount: 20, spallConeDeg: 25, spallEnergyJ: 250 };
const SPALL_BLAST = { spallCount: 12, spallConeDeg: 45, spallEnergyJ: 150 };

/**
 * Decide one queued hull hit (after the projectile loop). (x, y, z): where it struck; (vx, vy, vz): its velocity;
 * speed: its speed there (0 for an impact HE contact, which bursts by itself); part 0 hull / 1 turret; face 0
 * front, 1 side, 2 rear, 3 top; age: ticks since launch. `burst` queues a warhead burst (added after the loop).
 */
export function resolveVehicleHit(
  ctx: SimContext, state: SimState, events: EventSink, row: number, x: number, y: number, z: number, vx: number, vy: number, vz: number, speed: number,
  ammoIdx: number, owner: EntityId, part: number, face: number, age: number,
  burst: (x: number, y: number, z: number, ammo: number, owner: number) => void,
): void {
  const B = ctx.ballistics, G = B.vehicles, am = B.ammo[ammoIdx]!, adef = ctx.catalog.ammo[am.id]!;
  const vid = G.id[row]!, v = state.vehicle.get(vid);
  const def = v ? ctx.catalog.vehicles[v.def] : undefined;
  if (!v || !def) return;
  const rt = B.vehicleRT[v.def];
  frames(G, row);
  const fr = part === 1 ? TURRET : HULL;
  const vl = sqrt(vx * vx + vy * vy + vz * vz) || 1;
  const dx = vx / vl, dy = vy / vl, dz = vz / vl;
  const df = dx * fr.c + dy * fr.s, dr = -dx * fr.s + dy * fr.c;
  const rr = -(x - fr.ox) * fr.s + (y - fr.oy) * fr.c;
  const plate = rt?.plates[part * 4 + face] ?? null;
  const A = ctx.catalog.ballistics.armour;
  const pn = plateNeed(plate, face, rr >= 0 ? 1 : -1, df, dr, dz, A.losFloorCos);
  // Outward normal (world), for a burst just off the plate.
  let nx = 0, ny = 0, nz = 0;
  if (face === 3) nz = 1;
  else if (face === 1) { const sg = rr >= 0 ? 1 : -1; nx = -fr.s * sg; ny = fr.c * sg; }
  else { const sg = face === 0 ? 1 : -1; nx = fr.c * sg; ny = fr.s * sg; }
  const tick = state.tick;
  // Only the other side's rounds count as the vehicle being under fire (lastHitTick, threat bearing, the crew's
  // under-fire stamp; M7 review): friendly fire still does its damage, but the AI and drills do not react to it.
  const os = state.identity.get(owner)?.side;
  const enemy = os === undefined || os !== v.side;
  if (enemy) v.lastHitTick = tick;
  const dmg: Damage = { components: [], fire: false, cookOff: false, pen: false, fireAmmo: false };
  const wasImmobilised = v.status === "immobilised";
  const zone = part === 1 ? "turret" : "hull";
  let result: "ricochet" | "stopped" | "penetrated" = "stopped";

  if (am.shaped) {
    if (enemy) { v.lastShapedHitTick = tick; v.threatAz = atan2(-dy, -dx); }
    // Active protection (M7.4b, plan C16; the fixture only): the rocket is engaged before it reaches the plate. An
    // intercepted round bursts `standoffM` short along its path (blast and fragments, no jet on the hull); a failed
    // engagement lets it strike as usual. One charge (a counted item) per intercept.
    const aps = def.activeProtection;
    if (aps && v.status !== "destroyed" && v.status !== "abandoned" && tick >= (v.aps?.nextReadyTick ?? 0) && vehicleItems(state, vid, aps.item) > 0) {
      v.aps = { nextReadyTick: tick + secondsToTicks(aps.cooldownSeconds) };
      if (nextFloat(state.rng, Streams.armour) < aps.interceptChance) {
        removeItems(state.container.get(vid)!, aps.item, 1);
        burst(x - dx * aps.standoffM, y - dy * aps.standoffM, Math.max(z - dz * aps.standoffM, 0.3), ammoIdx, owner);
        events.emit({ kind: "vehicle.hit", tick, vehicle: vid, x, y, z, face: FACE_NAMES[face]!, zone: part === 1 ? "turret" : "hull", result: "intercepted", ammo: am.id, owner, rounds: 1, components: [] });
        if (enemy) stampUnderFire(state, v);
        return;
      }
    }
    // A grazing strike may not set it off; an unarmed one is a dud.
    const graze = pn.cosInc < A.grazeFuseCos && nextFloat(state.rng, Streams.armour) < 1 - pn.cosInc / Math.max(1e-6, A.grazeFuseCos);
    if (graze || age < am.armTicks) {
      events.emit({ kind: "impact", tick, x, y, z, surface: "vehicle", result: "stopped", material: plate?.material ?? "steel", ammo: am.id, owner });
      result = "ricochet";
    } else {
      burst(x + nx * 0.05, y + ny * 0.05, z + nz * 0.05, ammoIdx, owner);
      // An add-on tile on that face (M7.4b, plan C12): used up (a counted item), it multiplies what the jet needs.
      let needS = pn.needS;
      const tile = def.armour?.tiles?.find((tl) => tl.part === (part === 1 ? "turret" : "hull") && tl.face === FACE_NAMES[face]);
      if (tile && vehicleItems(state, vid, tile.item) > 0) { removeItems(state.container.get(vid)!, tile.item, 1); needS *= tile.factor; }
      if (am.penSteelMm >= needS) {
        result = "penetrated"; dmg.pen = true;
        interior(ctx, state, events, vid, v, def, x - nx * 0.01, y - ny * 0.01, z - nz * 0.01, dx, dy, dz, am.penSteelMm - needS, 0, "shaped", am.id, owner, adef.behindArmour ?? SPALL_SHAPED, dmg);
        // A jet that gets in is hot: it may light what it touches (engine, fuel) even without a listed chance.
      }
    }
  } else if (am.explosive) {
    // Impact HE (it bursts on the plate in the loop): it holes a plate thinner than the breach rule, and wrecks
    // part of a track it strikes.
    const fill = adef.explosive?.fillingKg ?? 0;
    const cr = cbrt(fill);
    const BL = ctx.catalog.ballistics.blast;
    const normalMm = plate ? plate.thicknessMm * plate.kPerMm : 0;
    if (plate && normalMm < BL.breachSteelMmScaled * cr) {
      result = "penetrated"; dmg.pen = true;
      interior(ctx, state, events, vid, v, def, x - nx * 0.01, y - ny * 0.01, z - nz * 0.01, -nx, -ny, -nz, 0, 0, "blast", am.id, owner, SPALL_BLAST, dmg);
    }
    const comps = def.components ?? [];
    for (let k = 0; k < comps.length; k++) {
      const c = comps[k]!;
      if (!c.external || (v.comp[k] ?? 1) <= 0) continue;
      const b = c.box, f2 = c.part === "turret" ? TURRET : HULL;
      const rx = x - f2.ox, ry = y - f2.oy, pf = rx * f2.c + ry * f2.s, pr = -rx * f2.s + ry * f2.c, pu = z - f2.gz;
      const g = 0.3;
      if (pf < b.f[0] - g || pf > b.f[1] + g || pr < b.r[0] - g || pr > b.r[1] + g || pu < b.u[0] - g || pu > b.u[1] + g) continue;
      damageComponent(ctx, state, events, vid, v, k, Math.min(1, 0.25 * cbrt(fill / 0.05)), false, dmg);
    }
    if (!dmg.pen && dmg.components.length === 0) return; // nothing to tell beyond the burst itself
  } else {
    // Kinetic: ricochet at a grazing angle, else through if it has the penetration.
    const rf = adef.ricochetFactor ?? 1;
    const lim = pn.sinCrit * rf;
    if (pn.cosInc < lim && nextFloat(state.rng, Streams.armour) < 1 - pn.cosInc / lim) {
      result = "ricochet";
      if (am.heavy) {
        // It glances off (re-added after the loop, slowed), like a round off a wall.
        const dot = dx * nx + dy * ny + dz * nz;
        const keep = 0.5 * speed;
        addProjectile(state.projectiles, ammoIdx, x + nx * 0.05, y + ny * 0.05, z + nz * 0.05, (dx - 2 * dot * nx) * keep, (dy - 2 * dot * ny) * keep, (dz - 2 * dot * nz) * keep, owner, tick - age);
      }
    } else {
      const can = am.penSteelMm * pow(speed / am.penV, ctx.catalog.ballistics.penetrationVelocityExponent);
      if (can >= pn.needK) {
        result = "penetrated"; dmg.pen = true;
        const energy = 0.5 * am.massKg * speed * speed * (1 - pn.needK / can);
        const r = interior(ctx, state, events, vid, v, def, x + dx * 0.01, y + dy * 0.01, z + dz * 0.01, dx, dy, dz, can - pn.needK, energy, "kinetic", am.id, owner, adef.behindArmour ?? SPALL_KINETIC, dmg);
        // Out through the far side if what is left beats the plate there.
        if (r.residual > 0 && r.L > 0) {
          const ex = x + dx * (r.L + 0.02), ey = y + dy * (r.L + 0.02), ez = z + dz * (r.L + 0.02);
          // The far plate: the face the path leaves by (rear/side/top as found by the exit point).
          const pf = (ex - HULL.ox) * HULL.c + (ey - HULL.oy) * HULL.s, pr = -(ex - HULL.ox) * HULL.s + (ey - HULL.oy) * HULL.c;
          const h = def.body.hull;
          const fFace = Math.abs(pf - h.f[1]) < 0.1 ? 0 : Math.abs(pf - h.f[0]) < 0.1 ? 2 : Math.abs(Math.abs(pr) - h.r[1]) < 0.1 ? 1 : 3;
          const far = plateNeed(rt?.plates[fFace] ?? null, fFace, pr >= 0 ? 1 : -1, -dx * HULL.c - dy * HULL.s, dx * HULL.s - dy * HULL.c, -dz, A.losFloorCos);
          if (r.residual > far.needK) {
            const k = sqrt(1 - far.needK / r.residual) * Math.min(1, r.residual / Math.max(1e-6, can));
            if (speed * k > 100) addProjectile(state.projectiles, ammoIdx, ex + dx * 0.1, ey + dy * 0.1, ez + dz * 0.1, dx * speed * k, dy * speed * k, dz * speed * k, owner, tick - age);
          }
        }
      }
    }
    if (result !== "penetrated" && !am.heavy) {
      // A small-arms round that did not get in: the aggregated per-vehicle event, as for rounds stopped in the loop.
      addStoppedHit(state, G, row, owner, ammoIdx, x, y, z, face * 2 + part);
      return;
    }
  }
  events.emit({ kind: "vehicle.hit", tick, vehicle: vid, x, y, z, face: FACE_NAMES[face]!, zone, result, ammo: am.id, owner, rounds: 1, components: dmg.components });
  if (dmg.pen) v.lastPenTick = tick;
  if (enemy && (dmg.pen || am.heavy)) v.threatAz = atan2(-dy, -dx);
  // The crew and its platoon are under fire (from the other side).
  if (enemy) stampUnderFire(state, v);
  afterDamage(ctx, state, events, vid, v, def, dmg, wasImmobilised);
}

function stampUnderFire(state: SimState, v: VehicleState): void {
  if (v.unit === null) return;
  let u = state.unit.get(v.unit);
  while (u) { u.underFireTick = state.tick; if (u.parent === null) break; u = state.unit.get(u.parent); }
}

/** Status after damage, fire, and the crew's reaction (owner Q14/Q15). */
function afterDamage(ctx: SimContext, state: SimState, events: EventSink, vid: EntityId, v: VehicleState, def: VehicleDef, dmg: Damage, wasImmobilised: boolean): void {
  if (v.status === "destroyed") return;
  if (dmg.cookOff) { destroyVehicle(ctx, state, events, vid, v, "cookOff"); return; }
  if (dmg.fire && v.fire === null) {
    const C = ctx.catalog.behaviour.crew;
    // The extinguisher (M7.4b) tries first if it works and has a charge; the crew waits for it.
    v.fire = { startTick: state.tick, nextCheckTick: state.tick + secondsToTicks(C.cookOffCheckSeconds), intensity: dmg.fireAmmo ? 2 : 1, nextExtTick: canExtinguish(state, vid, v, def) ? state.tick + Math.max(1, secondsToTicks(def.extinguisher!.delaySeconds)) : -1 };
    events.emit({ kind: "vehicle.fire", tick: state.tick, vehicle: vid });
    const t = state.transform.req(vid);
    if (C.fireSmokeRadiusM > 0) addSmoke(ctx, state, t.x, t.y, C.fireSmokeRadiusM, C.burnSeconds + 60, C.fireSmokeTopM ?? 30, C.burnSeconds + 60);
  }
  updateStatus(ctx, state, events, vid, v, def);
  if (v.status === "abandoned") return;
  const why: string[] = [];
  if (v.fire !== null && v.fire.nextExtTick < 0) why.push("reaction.burning");
  if (wasImmobilised && dmg.pen) why.push("reaction.immobilisedPenetrated");
  if (v.status === "immobilised" && !gunWorks(v, def)) why.push("reaction.cannotFight");
  if (!crewCanAct(state, v, def)) why.push("reaction.crewOut");
  if (why.length > 0) orderBailOut(ctx, state, events, vid, v, why);
  else if (dmg.pen && v.crewReaction === null) { v.crewReaction = "continue"; v.reactionTick = state.tick; v.reactionWhy = ["reaction.fightOn"]; }
}

/** Can it still fire anything: the cannon, or the coaxial machine gun (M7.4b: all out = disarmed)? */
function gunWorks(v: VehicleState, def: VehicleDef): boolean {
  const comps = def.components ?? [];
  let any = false;
  for (let k = 0; k < comps.length; k++) { const kd = comps[k]!.kind; if (kd === "gun" || kd === "coax") { any = true; if ((v.comp[k] ?? 1) > 0) return true; } }
  return !any;
}

function mobile(v: VehicleState, def: VehicleDef): boolean {
  const comps = def.components ?? [];
  for (let k = 0; k < comps.length; k++) {
    const kd = comps[k]!.kind;
    if ((kd === "engine" || kd === "track" || kd === "transmission") && (v.comp[k] ?? 1) <= 0) return false;
  }
  return true;
}

/** Is any crewman (not a passenger) able to act? */
function crewCanAct(state: SimState, v: VehicleState, def: VehicleDef): boolean {
  for (let k = 0; k < def.seats.length; k++) {
    if (def.seats[k]!.station === "passenger") continue;
    const m = v.seats[k];
    if (m !== null && m !== undefined && isAble(state.soldier.get(m))) return true;
  }
  return false;
}

/** Immobilised / disarmed from the components (never back to ok in battle). */
function updateStatus(_ctx: SimContext, state: SimState, events: EventSink, vid: EntityId, v: VehicleState, def: VehicleDef): void {
  if (v.status === "destroyed" || v.status === "abandoned") return;
  if (!mobile(v, def) && v.status !== "immobilised") {
    v.status = "immobilised";
    v.drive.route = []; v.drive.routeIdx = 0; v.drive.arrived = true;
    events.emit({ kind: "vehicle.status", tick: state.tick, vehicle: vid, status: "immobilised" });
    if (v.unit !== null) radioFromTarget(state, v.unit, "radio.vehicleImmobilised", events);
  } else if (v.status === "ok" && !gunWorks(v, def)) {
    v.status = "disarmed";
    events.emit({ kind: "vehicle.status", tick: state.tick, vehicle: vid, status: "disarmed" });
    if (v.unit !== null) radioFromTarget(state, v.unit, "radio.vehicleDisarmed", events);
  }
}

function orderBailOut(ctx: SimContext, state: SimState, events: EventSink, vid: EntityId, v: VehicleState, why: string[]): void {
  if (v.crewReaction === "bailOut") return;
  v.crewReaction = "bailOut"; v.reactionTick = state.tick; v.reactionWhy = why;
  // The driver stops.
  v.drive.route = []; v.drive.routeIdx = 0; v.drive.arrived = true;
  if (v.unit !== null) radioFromTarget(state, v.unit, "radio.bailOut", events);
  void ctx;
}

/** Destroyed (ammunition blown up, or burnt out): men still inside are burnt. */
function destroyVehicle(ctx: SimContext, state: SimState, events: EventSink, vid: EntityId, v: VehicleState, cause: "cookOff" | "burnt"): void {
  if (v.status === "destroyed") return;
  const C = ctx.catalog.behaviour.crew;
  const wasAbandoned = v.status === "abandoned";
  v.status = "destroyed";
  v.drive.route = []; v.drive.routeIdx = 0; v.drive.arrived = true;
  for (const st of v.stations) st.task = null;
  events.emit({ kind: "vehicle.destroyed", tick: state.tick, vehicle: vid, cause });
  if (v.unit !== null && !wasAbandoned) radioFromTarget(state, v.unit, "radio.vehicleDestroyed", events);
  for (let k = 0; k < v.seats.length; k++) {
    const m = v.seats[k];
    if (m === null || m === undefined) continue;
    const sev = C.occupantBurnSeverity[0] + (C.occupantBurnSeverity[1] - C.occupantBurnSeverity[0]) * nextFloat(state.rng, Streams.armour);
    applyBurn(ctx, state, events, m, sev, vid);
  }
  markWreck(state, vid);
  // Survivors who can still move get out at once.
  if (v.crewReaction !== "bailOut") { v.crewReaction = "bailOut"; v.reactionTick = state.tick - 100000; v.reactionWhy = ["reaction.destroyed"]; }
}

/** Owner Q8: both sides know of a wreck at once: every contact on it is marked a wreck. */
function markWreck(state: SimState, vid: EntityId): void {
  // mounted: ok contacts of every man (aboard or not) learn of the wreck
  for (const [, s] of state.soldier.entries()) for (const c of s.contacts) if (c.target === vid) c.wreck = true;
}

/** Is there a working extinguisher with a charge left (M7.4b)? */
function canExtinguish(state: SimState, vid: EntityId, v: VehicleState, def: VehicleDef): boolean {
  const E = def.extinguisher;
  return E !== undefined && compCondition(v, def, "extinguisher") > 0 && vehicleItems(state, vid, E.item) > 0;
}

/**
 * The extinguisher's try (M7.4b): one charge out of the container (counted); the fire goes out with the data's
 * chance (half that in the ammunition). Out: no more cook-off checks, the smoke thins, the crew stays (unless it
 * has another reason to go). Not out: the next charge after the delay, or the crew bails out when none is left.
 */
function tryExtinguish(ctx: SimContext, state: SimState, events: EventSink, vid: EntityId, v: VehicleState, def: VehicleDef): void {
  const fire = v.fire!;
  const E = def.extinguisher;
  if (!E || !canExtinguish(state, vid, v, def)) { fire.nextExtTick = -1; orderBailOut(ctx, state, events, vid, v, ["reaction.burning"]); return; }
  removeItems(state.container.get(vid)!, E.item, 1);
  if (nextFloat(state.rng, Streams.armour) < E.chance / fire.intensity) {
    v.fire = null;
    events.emit({ kind: "vehicle.extinguished", tick: state.tick, vehicle: vid });
    if (v.unit !== null) radioFromTarget(state, v.unit, "radio.fireOut", events);
    return;
  }
  if (canExtinguish(state, vid, v, def)) fire.nextExtTick = state.tick + Math.max(1, secondsToTicks(E.delaySeconds));
  else { fire.nextExtTick = -1; orderBailOut(ctx, state, events, vid, v, ["reaction.burning"]); }
}

/**
 * Fire, cook-off and bailing out (M7.4a), every tick (cheap; returns at once without vehicles). Men get out
 * (able ones, through the exits in turn) `bailOutSeconds` after the reaction (`bailOnFireSeconds` when burning).
 * M7.4b: the extinguisher tries first; a crew that has got out becomes a unit on foot (it can be given orders).
 */
export function vehicleDamageSystem(ctx: SimContext, state: SimState, events: EventSink): void {
  if (state.vehicle.size === 0) return;
  const C = ctx.catalog.behaviour.crew;
  for (const [vid, v] of state.vehicle.entries()) {
    const def = ctx.catalog.vehicles[v.def];
    if (!def) continue;
    if (v.fire !== null && v.status !== "destroyed" && v.fire.nextExtTick >= 0 && state.tick >= v.fire.nextExtTick) tryExtinguish(ctx, state, events, vid, v, def);
    if (v.fire !== null && v.status !== "destroyed") {
      if (state.tick - v.fire.startTick >= secondsToTicks(C.burnSeconds)) destroyVehicle(ctx, state, events, vid, v, "burnt");
      else if (state.tick >= v.fire.nextCheckTick) {
        v.fire.nextCheckTick += secondsToTicks(C.cookOffCheckSeconds);
        const ammo = (def.components ?? []).some((c, k) => c.kind === "ammo" && (v.comp[k] ?? 1) > 0);
        if (ammo && nextFloat(state.rng, Streams.armour) < C.cookOffChancePerCheck) destroyVehicle(ctx, state, events, vid, v, "cookOff");
      }
      if (v.fire !== null && v.fire.nextExtTick < 0 && v.crewReaction !== "bailOut" && (v.status as string) !== "destroyed") orderBailOut(ctx, state, events, vid, v, ["reaction.burning"]);
    }
    if (v.crewReaction !== "bailOut") {
      // A crew all out of action (killed or wounded by rifle fire through no armour, or earlier hits): no one is
      // left to fight it. (Checked once a second.)
      if (v.status !== "destroyed" && v.status !== "abandoned" && (vid + state.tick) % 60 === 0 && def.components && !crewCanAct(state, v, def)) orderBailOut(ctx, state, events, vid, v, ["reaction.crewOut"]);
      continue;
    }
    const delay = secondsToTicks(v.fire !== null ? C.bailOnFireSeconds : def.ramp.bailOutSeconds);
    if (state.tick - v.reactionTick < delay) continue;
    // Out they get: every man aboard who can move, through the exits in turn (owner Q14: passengers with the crew).
    let k = 0;
    for (let seat = 0; seat < v.seats.length; seat++) {
      const m = v.seats[seat];
      if (m === null || m === undefined) continue;
      const s = state.soldier.get(m);
      if (!isAble(s) || !s!.impair.canWalk) continue;
      // His unit's boarding (if any) ends: he is out for good.
      const uid = state.identity.get(m)?.unit;
      const u = uid !== undefined ? state.unit.get(uid) : undefined;
      if (u?.boarding) delete u.boarding;
      getOut(ctx, state, m, vid, k % def.ramp.exits.length, events);
      k++;
    }
    if (v.status !== "destroyed" && v.status !== "abandoned") {
      v.status = "abandoned";
      for (const st of v.stations) st.task = null;
      events.emit({ kind: "vehicle.abandoned", tick: state.tick, vehicle: vid, reason: v.reactionWhy[0] ?? "reaction.bailOut" });
      markWreck(state, vid);
    }
    // The crew is out: from now on it is a unit on foot (orders reach its men like any squad's, M7.4b). Men who
    // could not get out stay in their seats (rule 10). The hull keeps no crew unit.
    if (v.unit !== null) {
      const u = state.unit.get(v.unit);
      if (u && u.vehicle === vid) { delete u.vehicle; u.exVehicle = vid; u.moving = false; u.firing = false; }
      v.unit = null;
    }
  }
}

/**
 * CREW REACTIONS (M7.4b, plan §8, C2/C21; owner 2026-11-13 "make armour not back out of every fight"), once a
 * second per vehicle (staggered): a crew in a vehicle that can still move decides between fighting on and reversing
 * out of reach:
 *   reverseOut   penetrated without losing its mobility; its weapons wrecked; its commander panicked (shaken is
 *                not enough); an enemy man on foot it knows within `atThreatM` (point-blank) that none of its guns
 *                can fire at from where it stands (too close to depress on, out of the arc, no line, no gun left).
 *                A rocket that bounced off and ordinary infantry fire are no reasons. It fires its smoke
 *                dischargers (if it has salvos) and backs away from where the danger is `reverseOutM` (forward if
 *                that is behind it), facing it, then holds there `reverseHoldSeconds`. When the reason was not
 *                damage (enemy close, commander panicked), it drives back to where it stood once the hold is over
 *                and nothing new drives it off (`returnTo`). A vehicle under a player's move or halt order
 *                (`playerHold`) reverses out only when penetrated or disarmed.
 *   continue     everything else (an immobilised vehicle with a working gun fights on under fire that bounces off).
 * Bailing out is decided where the damage happens (above). The reasons go to `reactionWhy` and a
 * `vehicle.reaction` event (debug overlay); the crew calls it on the radio.
 */
export function crewReactionSystem(ctx: SimContext, state: SimState, events: EventSink): void {
  if (state.vehicle.size === 0) return;
  const C = ctx.catalog.behaviour.crew, tick = state.tick;
  const every = Math.max(1, secondsToTicks(C.reactionStepSeconds));
  const recent = secondsToTicks(C.recentHitSeconds);
  for (const [vid, v] of state.vehicle.entries()) {
    if ((vid + tick) % every !== 0) continue;
    if (v.unit === null || v.crewReaction === "bailOut" || (v.status !== "ok" && v.status !== "disarmed")) continue;
    const def = ctx.catalog.vehicles[v.def];
    if (!def || !def.components) continue;
    // Still backing off, or holding where it went: nothing new for a while.
    if (v.crewReaction === "reverseOut" && tick - v.reactionTick < secondsToTicks(C.reverseHoldSeconds)) continue;
    if (!hasDriver(state, v, def) || !crewCanAct(state, v, def)) continue;
    const why: string[] = [];
    if (tick - v.lastPenTick <= recent) why.push("reaction.penetrated");
    if (v.status === "disarmed" && v.crewReaction !== "reverseOut") why.push("reaction.disarmed");
    const damage = why.length > 0;
    let near: { x: number; y: number } | null = null;
    if (v.playerHold !== true) {
      const cmd = occupant(v, def, "commander");
      if (cmd !== null && state.soldier.get(cmd)?.mental.behaviour === "panicked") why.push("reaction.panicked");
      const close = C.atThreatM > 0 ? closeEnemyFoot(ctx, state, v, def, vid, C.atThreatM) : null;
      if (close) { near = close; why.push(close.launcher ? "reaction.atClose" : "reaction.atThreat"); }
    }
    if (why.length === 0) {
      if (v.crewReaction === "reverseOut") {
        v.crewReaction = "continue"; v.reactionTick = tick; v.reactionWhy = ["reaction.fightOn"];
        // Back to where it stood (not after damage): it rejoins the fight.
        const back = v.returnTo;
        if (back && vehicleMove(ctx, state, vid, [{ x: back.x, y: back.y, mode: "walk" }], back.heading) === true) {
          events.emit({ kind: "vehicle.reaction", tick, vehicle: vid, reaction: "continue", keys: ["reaction.returning"] });
          v.reactionWhy = ["reaction.returning"];
        } else delete v.returnTo;
      } else if (v.returnTo && v.drive.arrived) delete v.returnTo;
      continue;
    }
    const t = state.transform.req(vid);
    if (damage) delete v.returnTo;
    else v.returnTo ??= { x: t.x, y: t.y, heading: t.heading };
    const from = near ? atan2(near.y - t.y, near.x - t.x) : v.threatAz ?? t.heading;
    reverseOut(ctx, state, events, vid, v, def, from, why);
  }
}

/**
 * The nearest enemy man on foot this crew saw within `r` of the hull in the last 10 s that none of its guns can
 * fire at from where it stands (`canEngageAt`), or null; `launcher`: he carries a loaded anti-tank launcher.
 */
function closeEnemyFoot(ctx: SimContext, state: SimState, v: VehicleState, def: VehicleDef, vid: EntityId, r: number): { x: number; y: number; launcher: boolean } | null {
  const t = state.transform.req(vid);
  let best: { x: number; y: number; launcher: boolean } | null = null, bestD = r;
  const checked: EntityId[] = [];
  for (let k = 0; k < def.seats.length; k++) {
    if (def.seats[k]!.station === "passenger") continue;
    const m = v.seats[k];
    const s = m === null || m === undefined ? undefined : state.soldier.get(m);
    if (!s || !isAble(s)) continue;
    for (const c of s.contacts) {
      if (c.cls === "vehicle" || c.surrendered || c.down || c.kind !== "seen" || state.tick - c.tick > secondsToTicks(10)) continue;
      const d = hypot2(c.x - t.x, c.y - t.y);
      if (d >= bestD || checked.includes(c.target)) continue;
      checked.push(c.target);
      // ground: ok (the point a gun would fire at: a man's floor in his aim height)
      if (canEngageAt(ctx, state, vid, v, def, c.x, c.y, heightAt(ctx.map, c.x, c.y) + aimHeightAt(ctx, c))) continue;
      bestD = d; best = { x: c.x, y: c.y, launcher: launcherRound(ctx, state, c.target) !== null };
    }
  }
  return best;
}

/** Smoke, then back off away from bearing `from` (reverse if the threat is ahead), ending facing it. */
function reverseOut(ctx: SimContext, state: SimState, events: EventSink, vid: EntityId, v: VehicleState, def: VehicleDef, from: number, why: string[]): void {
  const C = ctx.catalog.behaviour.crew;
  const t = state.transform.req(vid);
  v.crewReaction = "reverseOut"; v.reactionTick = state.tick; v.reactionWhy = why;
  events.emit({ kind: "vehicle.reaction", tick: state.tick, vehicle: vid, reaction: "reverseOut", keys: [...why] });
  // Smoke between it and the threat: the turret is laid toward it at its own rate (a damaged drive is slow) and
  // the salvo goes off along the turret wherever it points when it is due (the dischargers fire ahead of it).
  if (def.dischargers && v.stations.length > 0 && state.tick >= v.smokeReadyTick) {
    const st = v.stations[0]!;
    if (st.task === null) st.azCmd = wrapAngle(from - t.heading);
    dischargeSmoke(ctx, state, vid);
  }
  const ahead = Math.abs(wrapAngle(from - t.heading)) < PI / 2;
  const W = ctx.map.widthM, H = ctx.map.heightM;
  // Straight away from the threat; failing a route, a little to either side.
  for (const off of [0, 0.5, -0.5]) {
    const a = from + PI + off;
    const x = Math.min(Math.max(t.x + cos(a) * C.reverseOutM, 5), W - 5), y = Math.min(Math.max(t.y + sin(a) * C.reverseOutM, 5), H - 5);
    const res = vehicleMove(ctx, state, vid, [{ x, y, mode: "run", ...(ahead ? { reverse: true as const } : {}) }], from);
    if (res === true) break;
  }
  if (v.unit !== null) radioFromTarget(state, v.unit, "radio.reversingOut", events);
}

/** For tests and the lab: a vehicle's component index by kind (first), or -1. */
export function componentIndex(def: VehicleDef, kind: VehicleComponent["kind"]): number {
  return (def.components ?? []).findIndex((c) => c.kind === kind);
}

