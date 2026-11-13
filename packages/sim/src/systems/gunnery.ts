/**
 * VEHICLE GUNNERY (M7.3, plan §7): turrets, cannon and coaxial machine guns with counted ammunition, smoke
 * dischargers, refilling ready belts from stowage.
 *
 *   stationDecisionSystem  once a second per vehicle (staggered): what each station fires at, with what. An
 *                          ordered task is kept (and follows the named enemy as the crew knows him); otherwise,
 *                          if the crew unit's fire rule allows it, the crew picks among the enemies its men saw
 *                          lately or a comrade reported precisely: vehicles first (armour-piercing), then men
 *                          firing now, nearest first; groups and far men get high explosive at their feet, a
 *                          single near man the coaxial machine gun. The reasons are kept as string keys
 *                          (`station.why`, `vehicle.decision`) for the debug overlay. Halted, a ready belt run
 *                          low is refilled from stowage (owner Q17: both vehicles, about 90 s).
 *   turretSystem           lays the turret: bearing with lead (from the drop table's time of flight), elevation
 *                          with drop; traverse and elevation rates, limits and arc; a stabilised turret holds its
 *                          bearing while the hull turns. Laid = within the station's tolerance.
 *   stationFireSystem      fires: an able operator (the commander if the gunner is out and the station allows
 *                          it), rounds on the feed, feed switched, laid, line of fire clear from the muzzle (the
 *                          own hull ignored), no comrade on foot in the way, bursts as the weapon's data says.
 *                          Error from the station (stabiliser, speed), the gunner's skill and the weapon; range
 *                          error from the rangefinder or the gunner's eye. Rounds are counted off the ready feed
 *                          (rule 9). The owner of every round is the operator (the gunner), `shot.fired.vehicle`
 *                          names the vehicle.
 *
 * Single-round feeds (the fixture's sling; tank guns later): one round per `roundLoadSeconds`, slower without an
 * able man in the loader's station (`noLoaderFactor`), impossible without one if no factor is given. The round
 * stays counted on the rack until it is fired.
 */
import { registerActionHandler, startAction } from "../actions";
import { dropAt, flightTimeAt } from "../ballistics";
import type { Catalog, VehicleDef } from "../catalog";
import type { FireTask, StationState, Unit, VehicleState, VehicleWeaponState } from "../components";
import type { SimContext } from "../context";
import type { EventSink, SimEvent } from "../events";
import type { OrderBody } from "../orders";
import { secondsToTicks, TICK_HZ, type EntityId } from "../ids";
import { isAble } from "../impair";
import { emptyContainer, transferItems } from "../items";
import { sight } from "../los";
import { atan2, cos, hypot2, sin, sqrt, wrapAngle } from "../math";
import { compCondition, fireTop, occupant } from "../mount";
import { nextFloat, nextNormal, Streams } from "../rng";
import type { SimState } from "../state";
import { heightAt } from "../terrain";
import { aimHeightAt, friendInLine, skillFactor } from "./fire";
import { burstCadence, launchShot, pickRound } from "./shot";
import { radioFromTarget } from "./orders";
import { contactErrorM } from "./contacts";

export type Nature = "ap" | "he" | "mg";

/** Can this vehicle still fight (not knocked out, abandoned or destroyed)? */
export function canFight(v: VehicleState): boolean {
  return v.status === "ok" || v.status === "immobilised";
}

/** The man who works this station now: its operator if able, else the commander if the station allows it. */
export function stationOperator(state: SimState, v: VehicleState, def: VehicleDef, si: number): EntityId | null {
  const sn = def.stations[si]!;
  const fit = (id: EntityId | null) => { const s = id === null ? undefined : state.soldier.get(id); return s !== undefined && isAble(s) && s.impair.canFight; };
  const op = occupant(v, def, sn.operator);
  if (fit(op)) return op;
  if (sn.commanderOverride) { const c = occupant(v, def, "commander"); if (fit(c)) return c; }
  return null;
}

/** The platoon (top) unit above a unit. */
function topOf(state: SimState, uid: EntityId): Unit | undefined {
  let u = state.unit.get(uid);
  while (u && u.parent !== null) { const p = state.unit.get(u.parent); if (!p) break; u = p; }
  return u;
}

/**
 * May this crew open fire on its own? Its own rule and cease-fire (fireTop: a crew unit governs its own fire,
 * plan C19); "return" fire answers fire on the crew or on its platoon (an IFV supports its men).
 */
export function gunneryAllowed(ctx: SimContext, state: SimState, crewId: EntityId): boolean {
  const crew = state.unit.get(fireTop(state, crewId));
  if (!crew || crew.fireRule === "hold") return false;
  const top = topOf(state, crewId);
  const under = Math.max(crew.underFireTick, top?.underFireTick ?? -1e9);
  const firedOnSinceCease = under > crew.ceaseFireTick;
  if (crew.ceaseFireTick > -1e9 && !firedOnSinceCease) return false;
  if (crew.fireRule === "free") return true;
  return firedOnSinceCease && state.tick - under <= secondsToTicks(ctx.catalog.behaviour.decisions.underFireMemorySeconds);
}

/** Does this feed's round burst (high explosive)? */
function feedIsHe(catalog: Catalog, item: string): boolean {
  const round = catalog.items[item]?.chargeItem;
  return round !== undefined && catalog.ammo[round]?.explosive !== undefined;
}

/**
 * The weapon and feed for a nature on this station, with rounds: "mg" = a coaxial (non-cannon) weapon,
 * "ap" / "he" = a cannon feed of that kind. null if none has rounds.
 */
export function pickFeed(ctx: SimContext, def: VehicleDef, st: StationState, si: number, nature: Nature, v?: VehicleState): { weapon: number; feed: number } | null {
  const sn = def.stations[si]!;
  for (let wi = 0; wi < sn.weapons.length; wi++) {
    const wdef = sn.weapons[wi]!, w = st.weapons[wi]!;
    const cannon = ctx.catalog.weapons[wdef.weapon]?.type === "autocannon" || !wdef.coax;
    if ((nature === "mg") === cannon) continue;
    if (v && weaponOut(ctx, v, def, si, wi)) continue; // wrecked (M7.4b)
    for (let fi = 0; fi < wdef.feeds.length; fi++) {
      if ((w.feeds[fi]?.rounds ?? 0) <= 0) continue;
      if (nature === "mg") return { weapon: wi, feed: fi };
      if (feedIsHe(ctx.catalog, wdef.feeds[fi]!.item) === (nature === "he")) return { weapon: wi, feed: fi };
    }
  }
  return null;
}

/** First choice of nature, then the others in a sensible order (a crew out of one kind uses what it has). */
function feedFor(ctx: SimContext, def: VehicleDef, st: StationState, si: number, want: Nature, v: VehicleState): { weapon: number; feed: number; nature: Nature } | null {
  const order: Nature[] = want === "ap" ? ["ap", "he"] : want === "he" ? ["he", "mg", "ap"] : ["mg", "he", "ap"];
  for (const n of order) { const f = pickFeed(ctx, def, st, si, n, v); if (f) return { ...f, nature: n }; }
  return null;
}

/** A station weapon wrecked (M7.4b): the cannon by the "gun" component, a coaxial machine gun by "coax". */
export function weaponOut(ctx: SimContext, v: VehicleState, def: VehicleDef, si: number, wi: number): boolean {
  const wdef = def.stations[si]?.weapons[wi];
  if (!wdef || !def.components) return false;
  const cannon = ctx.catalog.weapons[wdef.weapon]?.type === "autocannon" || !wdef.coax;
  return compCondition(v, def, cannon ? "gun" : "coax") <= 0;
}

/** Nature of the weapon/feed a station task uses. */
function natureOf(ctx: SimContext, def: VehicleDef, si: number, wi: number, fi: number): Nature {
  const wdef = def.stations[si]?.weapons[wi];
  if (!wdef) return "mg";
  const cannon = ctx.catalog.weapons[wdef.weapon]?.type === "autocannon" || !wdef.coax;
  if (!cannon) return "mg";
  return feedIsHe(ctx.catalog, wdef.feeds[fi]?.item ?? "") ? "he" : "ap";
}

/** Range the drop tables of this weapon are built to (beyond the infantry's 1500 m when it reaches further). */
function tableRange(engageRangeM: number): number {
  return Math.max(1500, Math.ceil(engageRangeM / 500) * 500 + 500);
}

/** Give a station a task: fire at (x, y) at `heightM` above the ground, with this weapon and feed. */
export function setStationTask(
  ctx: SimContext, state: SimState, vid: EntityId, si: number, x: number, y: number, heightM: number,
  weapon: number, feed: number, contact: EntityId | undefined, self: boolean,
): void {
  const v = state.vehicle.req(vid), def = ctx.catalog.vehicles[v.def]!, st = v.stations[si]!, sn = def.stations[si]!;
  const prev = st.task;
  const op = stationOperator(state, v, def, si);
  const skill = op === null ? 0.5 : (state.soldier.get(op)?.skills["marksmanship"] ?? 0.5);
  const G = ctx.catalog.behaviour.gunnery;
  // Range error: the laser rangefinder's, else the gunner's eye (stadia).
  const frac = sn.rangefinder ? G.lrfRangeErrorFraction : ctx.catalog.shooting.aim.rangeErrorFraction * skillFactor(ctx, skill);
  const same = prev !== null && hypot2(prev.x - x, prev.y - y) < 3 && st.taskWeapon === weapon;
  const task: FireTask = {
    x, y, heightM, reasonTick: state.tick,
    rangeError: same ? prev!.rangeError : frac * nextNormal(state.rng, Streams.station),
    startTick: same ? prev!.startTick : state.tick,
    lineCheckTick: same ? prev!.lineCheckTick : -100000, lineClear: same ? prev!.lineClear : true,
    linePosture: "standing", basePosture: "standing",
  };
  if (contact !== undefined) task.contact = contact;
  if (self) task.self = true;
  st.task = task;
  st.taskWeapon = weapon; st.taskFeed = feed;
}

/** A crew's picture of an enemy: the most certain contact any able man of the crew unit holds. */
function crewContact(ctx: SimContext, state: SimState, crew: Unit, target: EntityId): { x: number; y: number; err: number; vx: number; vy: number } | null {
  let best: { x: number; y: number; err: number; vx: number; vy: number } | null = null;
  for (const m of crew.members) {
    const s = state.soldier.get(m);
    if (!isAble(s)) continue;
    for (const c of s!.contacts) {
      if (c.target !== target) continue;
      const err = contactErrorM(ctx, c, state.tick);
      if (!best || err < best.err) best = { x: c.x, y: c.y, err, vx: c.vx ?? 0, vy: c.vy ?? 0 };
    }
  }
  return best;
}

/** Is the enemy entity still worth firing at (a man not down, a vehicle still fighting)? */
function targetLive(state: SimState, id: EntityId): boolean {
  const s = state.soldier.get(id);
  if (s) return s.physiology.alive && s.casualty === "none" && s.captive === null;
  const v = state.vehicle.get(id);
  return v !== undefined && v.status !== "destroyed" && v.status !== "abandoned";
}

/** Own men on foot within `r` of the point (no high explosive there). */
function ownMenNear(state: SimState, side: string, x: number, y: number, r: number): boolean {
  const r2 = r * r;
  // mounted: ok men aboard are excluded below
  for (const [id, s] of state.soldier.entries()) {
    if (s.mount !== undefined || !s.physiology.alive) continue;
    if (state.identity.get(id)?.side !== side) continue;
    const t = state.transform.get(id);
    if (t && (t.x - x) * (t.x - x) + (t.y - y) * (t.y - y) <= r2) return true;
  }
  return false;
}

/** The crew's choice of target: score, reasons, nature. */
function chooseTarget(ctx: SimContext, state: SimState, vid: EntityId, v: VehicleState, def: VehicleDef, crew: Unit, si: number):
  { target: EntityId; x: number; y: number; heightM: number; nature: Nature; keys: string[] } | null {
  const G = ctx.catalog.behaviour.gunnery, tick = state.tick;
  const me = state.transform.req(vid);
  const sn = def.stations[si]!;
  let reach = 0;
  for (const w of sn.weapons) reach = Math.max(reach, w.engageRangeM);
  if (crew.maxEngageM > 0) reach = Math.min(reach, crew.maxEngageM);
  // Candidates: what the crew saw lately, or a comrade reported precisely and recently (ascending target id).
  const cands = new Map<EntityId, { x: number; y: number; err: number; z?: number }>();
  for (const m of crew.members) {
    const s = state.soldier.get(m);
    if (!isAble(s)) continue;
    for (const c of s!.contacts) {
      if (c.surrendered) continue;
      const age = tick - c.tick;
      const ok = c.kind === "seen" ? age <= secondsToTicks(G.seenWithinSeconds) : c.kind === "reported" && age <= secondsToTicks(G.reportedWithinSeconds) && contactErrorM(ctx, c, tick) <= G.reportedErrorM;
      if (!ok) continue;
      const err = contactErrorM(ctx, c, tick);
      const prev = cands.get(c.target);
      if (!prev || err < prev.err) cands.set(c.target, { x: c.x, y: c.y, err, ...(c.z !== undefined ? { z: c.z } : {}) });
    }
  }
  const scored: { target: EntityId; x: number; y: number; z?: number; score: number; vehicle: boolean; firing: boolean }[] = [];
  for (const [target, c] of [...cands.entries()].sort((a, b) => a[0] - b[0])) {
    if (!targetLive(state, target)) continue;
    const d = hypot2(c.x - me.x, c.y - me.y);
    if (d > reach) continue;
    const isVeh = state.vehicle.has(target);
    const ew = isVeh ? undefined : state.weapon.get(target);
    const firing = isVeh
      ? state.vehicle.get(target)!.stations.some((st) => st.weapons.some((w) => tick - w.lastShotTick <= 3 * TICK_HZ))
      : ew !== undefined && tick - ew.lastShotTick <= 3 * TICK_HZ;
    scored.push({ target, x: c.x, y: c.y, ...(c.z !== undefined ? { z: c.z } : {}), score: d * (isVeh ? G.vehicleScore : 1) * (firing ? G.firingScore : 1), vehicle: isVeh, firing });
  }
  scored.sort((a, b) => a.score - b.score || a.target - b.target);
  // The best one the gun can reach from where the vehicle stands (a few lines of fire tried, best first).
  let best: (typeof scored)[number] | null = null;
  const st = v.stations[si]!;
  for (const cnd of scored.slice(0, 4)) {
    const [mx, my, mz] = muzzleWorld(ctx, def, si, 0, me.x, me.y, me.heading, st.azimuth);
    const tz = heightAt(ctx.map, cnd.x, cnd.y) + (cnd.vehicle ? 1.2 : aimHeightAt(ctx, cnd)); // ground: ok (a man's floor in his aim height)
    const r = sight(ctx, mx, my, mz, cnd.x, cnd.y, tz, vid, cnd.vehicle ? cnd.target : -1);
    if (r.blockedBy === null || (1 - r.blockedAt) * hypot2(cnd.x - mx, cnd.y - my) <= LINE_ALLOWANCE_M) { best = cnd; break; }
  }
  if (!best) return null;
  const keys: string[] = [best.vehicle ? "why.target.vehicle" : best.firing ? "why.target.firing" : "why.target.nearest"];
  const d = hypot2(best.x - me.x, best.y - me.y);
  let nature: Nature;
  let heightM: number;
  if (best.vehicle) { nature = "ap"; heightM = 1.2; keys.push("why.nature.vehicle"); }
  else {
    let group = 0;
    for (const [t, c] of cands) if (t !== best.target && !state.vehicle.has(t) && hypot2(c.x - best.x, c.y - best.y) <= G.groupRadiusM) group++;
    if (group > 0) { nature = "he"; keys.push("why.nature.group"); }
    else if (d > G.coaxSingleWithinM) { nature = "he"; keys.push("why.nature.far"); }
    else { nature = "mg"; keys.push("why.nature.single"); }
    heightM = nature === "he" ? 0 : ctx.catalog.shooting.fire.aimPointHeightM;
    // Never high explosive close to own men on foot: the machine gun, if he is in its reach, else nothing.
    if (nature === "he" && ownMenNear(state, v.side, best.x, best.y, G.friendlyClearM)) {
      if (d <= (sn.weapons.find((w) => w.coax)?.engageRangeM ?? 0)) { nature = "mg"; heightM = ctx.catalog.shooting.fire.aimPointHeightM; keys.push("why.hold.friends"); }
      else return null;
    }
  }
  return { target: best.target, x: best.x, y: best.y, heightM, nature, keys };
}

function emitDecision(events: EventSink, state: SimState, vid: EntityId, si: number, st: StationState, nature: Nature | null, keys: string[]): void {
  const same = st.why.keys.length === keys.length && st.why.keys.every((k, i) => k === keys[i]);
  const target = st.task?.contact ?? null;
  st.why = { tick: state.tick, keys };
  if (same && st.task !== null) return;
  events.emit({ kind: "vehicle.decision", tick: state.tick, vehicle: vid, station: si, target, x: st.task?.x ?? 0, y: st.task?.y ?? 0, nature, keys });
}

/** Once a second per vehicle: targets of every station, refilling ready belts. */
export function stationDecisionSystem(ctx: SimContext, state: SimState, events: EventSink): void {
  if (state.vehicle.size === 0) return;
  const G = ctx.catalog.behaviour.gunnery, tick = state.tick;
  const every = Math.max(1, secondsToTicks(G.stepSeconds));
  for (const [vid, v] of state.vehicle.entries()) {
    if ((vid + tick) % every !== 0 || v.stations.length === 0) continue;
    const def = ctx.catalog.vehicles[v.def];
    const crew = v.unit !== null ? state.unit.get(v.unit) : undefined;
    if (!def) continue;
    if (!crew || !canFight(v)) { for (const st of v.stations) st.task = null; continue; }
    const allowed = gunneryAllowed(ctx, state, v.unit!);
    for (let si = 0; si < v.stations.length; si++) {
      const st = v.stations[si]!;
      refillCheck(ctx, state, events, vid, v, def, si);
      if (stationOperator(state, v, def, si) === null) continue;
      // Its target is down or a wreck (M7.4a): the task ends, ordered or not.
      if (st.task?.contact !== undefined && !targetLive(state, st.task.contact)) { st.task = null; emitDecision(events, state, vid, si, st, null, ["why.hold.targetDown"]); }
      if (st.task && !st.task.self) {
        // An ordered task: follow the named enemy as the crew knows him; the order's nature stays.
        if (st.task.contact !== undefined) {
          const c = crewContact(ctx, state, crew, st.task.contact);
          if (c) { st.task.x = c.x; st.task.y = c.y; }
        }
        continue;
      }
      if (!allowed) {
        if (st.task) { st.task = null; emitDecision(events, state, vid, si, st, null, ["why.hold.rule"]); }
        continue;
      }
      const pick = chooseTarget(ctx, state, vid, v, def, crew, si);
      if (!pick) {
        if (st.task) { st.task = null; emitDecision(events, state, vid, si, st, null, ["why.hold.noTarget"]); }
        continue;
      }
      const f = feedFor(ctx, def, st, si, pick.nature, v);
      if (!f) {
        if (st.task) { st.task = null; emitDecision(events, state, vid, si, st, null, ["why.hold.ammunition"]); }
        continue;
      }
      const changed = !st.task || st.task.contact !== pick.target || st.taskWeapon !== f.weapon || st.taskFeed !== f.feed;
      if (changed) setStationTask(ctx, state, vid, si, pick.x, pick.y, pick.heightM, f.weapon, f.feed, pick.target, true);
      else { st.task!.x = pick.x; st.task!.y = pick.y; st.task!.reasonTick = tick; }
      if (f.nature !== pick.nature) pick.keys.push("why.nature.substitute");
      emitDecision(events, state, vid, si, st, f.nature, pick.keys);
    }
  }
}

/** The turret pivot (world) and the world azimuth of station `si`. */
function pivotOf(def: VehicleDef, x: number, y: number, heading: number): { px: number; py: number } {
  const pf = def.body.turret?.pivotF ?? 0;
  return { px: x + cos(heading) * pf, py: y + sin(heading) * pf };
}

/** Lay every turret toward its task (or back to the front), at its rates and within its limits. */
export function turretSystem(ctx: SimContext, state: SimState): void {
  if (state.vehicle.size === 0) return;
  const G = ctx.catalog.behaviour.gunnery, tick = state.tick, dt = 1 / TICK_HZ;
  for (const [vid, v] of state.vehicle.entries()) {
    if (v.stations.length === 0) continue;
    const def = ctx.catalog.vehicles[v.def], t = state.transform.get(vid);
    if (!def || !t) continue;
    // Damaged turret drive (M7.4b): below half, hand traverse at a quarter of the rate; a wrecked stabiliser.
    const driveK = compCondition(v, def, "turret-drive") < 0.5 ? 0.25 : 1;
    const stabOut = compCondition(v, def, "stabiliser") <= 0;
    for (let si = 0; si < v.stations.length; si++) {
      const st = v.stations[si]!, sn = def.stations[si]!;
      // A stabilised turret holds its bearing while the hull turns under it.
      if (sn.stabiliser !== "none" && !stabOut) st.azimuth = wrapAngle(st.azimuth - v.drive.yawRate * dt);
      const task = st.task;
      // Nothing to lay and already at rest: nothing to do.
      if (!task && st.laidTick < 0 && st.azimuth === st.azCmd && st.elevation === st.elCmd && st.azCmd === st.scanAz && st.elCmd === 0) continue;
      const { px, py } = pivotOf(def, t.x, t.y, t.heading);
      if (task) {
        const wdef = sn.weapons[st.taskWeapon];
        const w = st.weapons[st.taskWeapon];
        let tx = task.x, ty = task.y;
        const range0 = hypot2(tx - px, ty - py);
        let elDrop = 0;
        if (wdef && w) {
          const feed = w.feeds[st.taskFeed];
          const wd = ctx.catalog.weapons[wdef.weapon];
          const round = feed ? ctx.catalog.items[feed.item]?.chargeItem : undefined;
          const v0 = round !== undefined ? wd?.ammo[round] : undefined;
          if (round !== undefined && v0 !== undefined && range0 > 1) {
            const tr = tableRange(wdef.engageRangeM);
            // Lead on a moving vehicle the crew knows the movement of.
            const crew = v.unit !== null ? state.unit.get(v.unit) : undefined;
            if (task.contact !== undefined && crew) {
              const c = crewContact(ctx, state, crew, task.contact);
              if (c && (c.vx !== 0 || c.vy !== 0)) { const tof = flightTimeAt(ctx, round, v0, Math.min(range0, tr), tr); tx += c.vx * tof; ty += c.vy * tof; }
            }
            elDrop = atan2(dropAt(ctx, round, v0, Math.min(range0, tr), tr), Math.max(1, range0));
          }
        }
        const range = Math.max(1, hypot2(tx - px, ty - py));
        // ground: ok (a vehicle's gun; the point fired at)
        const mz = heightAt(ctx.map, t.x, t.y) + (def.body.turret?.trunnionU ?? 2);
        const tz = heightAt(ctx.map, task.x, task.y) + task.heightM; // ground: ok (the point fired at) // ground: ok
        let az = wrapAngle(atan2(ty - py, tx - px) - t.heading);
        if (sn.traverseArcRad) az = Math.min(Math.max(az, sn.traverseArcRad[0]), sn.traverseArcRad[1]);
        st.azCmd = az;
        st.elCmd = Math.min(Math.max(atan2(tz - mz, range) + elDrop, sn.elevationRad[0]), sn.elevationRad[1]);
      } else {
        // Back to the front a while after its last shot (not while a smoke salvo it is laid for is on its way:
        // the dischargers fire along the turret, M7 review).
        const last = st.weapons.reduce((m, w) => Math.max(m, w.lastShotTick), -1e9);
        if (v.pendingSmokeTick < 0 && tick - last >= secondsToTicks(G.scanReturnSeconds)) { st.azCmd = st.scanAz; st.elCmd = 0; }
      }
      const da = wrapAngle(st.azCmd - st.azimuth), de = st.elCmd - st.elevation;
      const stepA = sn.traverseRadS * driveK * dt, stepE = sn.elevateRadS * driveK * dt;
      st.azimuth = wrapAngle(st.azimuth + (da > stepA ? stepA : da < -stepA ? -stepA : da));
      st.elevation += de > stepE ? stepE : de < -stepE ? -stepE : de;
      const tol = sn.layToleranceMrad / 1000;
      const laid = task !== null && Math.abs(wrapAngle(st.azCmd - st.azimuth)) <= tol && Math.abs(st.elCmd - st.elevation) <= tol;
      if (laid) { if (st.laidTick < 0) st.laidTick = tick; } else st.laidTick = -1;
    }
  }
}

/** World position of a station weapon's muzzle (turret frame [f, r, u] about the pivot). */
export function muzzleWorld(ctx: SimContext, def: VehicleDef, si: number, wi: number, x: number, y: number, heading: number, azimuth: number): [number, number, number] {
  const m = def.stations[si]!.weapons[wi]!.muzzle;
  const { px, py } = pivotOf(def, x, y, heading);
  const a = heading + azimuth, c = cos(a), s = sin(a);
  return [px + c * m[0] - s * m[1], py + s * m[0] + c * m[1], heightAt(ctx.map, x, y) + m[2]]; // ground: ok (a vehicle's muzzle)
}

/** A wall or the ground this close to the point fired at is the target, not a block. */
const LINE_ALLOWANCE_M = 5;

/** Fire the stations, and fire smoke salvos that are due. */
export function stationFireSystem(ctx: SimContext, state: SimState, events: EventSink): void {
  if (state.vehicle.size === 0) return;
  const tick = state.tick, F = ctx.catalog.shooting.fire, A = ctx.catalog.shooting.aim;
  const fullTicks = secondsToTicks(F.fullRateSeconds), endTicks = fullTicks + secondsToTicks(F.trickleSeconds);
  for (const [vid, v] of state.vehicle.entries()) {
    const def = ctx.catalog.vehicles[v.def], t = state.transform.get(vid);
    if (!def || !t) continue;
    if (v.pendingSmokeTick >= 0 && tick >= v.pendingSmokeTick) smokeScreen(ctx, state, events, vid, v, def);
    if (!canFight(v) || v.stations.length === 0) continue;
    const crew = v.unit !== null ? state.unit.get(v.unit) : undefined;
    for (let si = 0; si < v.stations.length; si++) {
      const st = v.stations[si]!, task = st.task, sn = def.stations[si]!;
      if (!task) continue;
      const op = stationOperator(state, v, def, si);
      if (op === null) continue;
      const os = state.soldier.req(op);
      if (tick < os.stunnedUntilTick || state.action.get(op)?.kind === "reloadStation") continue;
      // An ordered task runs at the full rate while there is reason, then slows, then ends (as for men on foot).
      const since = tick - task.reasonTick;
      if (!task.self && since > endTicks) {
        st.task = null;
        if (crew && v.unit !== null) { crew.firing = false; events.emit({ kind: "fire.ceased", tick, unit: v.unit, reason: "no-target" }); radioFromTarget(state, v.unit, "radio.noTarget", events); }
        continue;
      }
      const wdef = sn.weapons[st.taskWeapon], w = st.weapons[st.taskWeapon];
      if (!wdef || !w) continue;
      const wd = ctx.catalog.weapons[wdef.weapon];
      if (!wd) continue;
      // The weapon wrecked (M7.4b): the task ends; the next decision picks another weapon if one works.
      if (weaponOut(ctx, v, def, si, st.taskWeapon)) { st.task = null; continue; }
      // Feed: switch to the task's feed first (a dual-feed cannon takes a moment).
      if (w.feed !== st.taskFeed) { w.feed = st.taskFeed; w.switchUntilTick = tick + secondsToTicks(wdef.switchSeconds); w.burstLeft = 0; w.loadedRound = false; w.burstIndex = 0; }
      if (tick < w.switchUntilTick) continue;
      const feed = w.feeds[w.feed];
      if (!feed || feed.rounds <= 0) {
        if (feed && !w.lowAmmoReported[w.feed] && v.unit !== null) { w.lowAmmoReported[w.feed] = true; radioFromTarget(state, v.unit, "radio.feedEmpty", events); }
        if (!task.self) {
          // Ordered: the same nature from another weapon or feed, else the order cannot be carried out.
          const f = feedFor(ctx, def, st, si, natureOf(ctx, def, si, st.taskWeapon, st.taskFeed), v);
          if (f) { st.taskWeapon = f.weapon; st.taskFeed = f.feed; } else { st.task = null; if (crew && v.unit !== null) { crew.firing = false; events.emit({ kind: "fire.ceased", tick, unit: v.unit, reason: "ammunition" }); } }
        }
        continue;
      }
      if (w.jammed) { w.jammed = false; w.nextShotTick = tick + secondsToTicks(F.clearStoppageSeconds); continue; }
      // Single-round feeds: a round must be loaded (by the loader if there is one).
      if (wdef.feedKind !== "belt" && !w.loadedRound) {
        if (w.burstIndex !== -1) {
          const loader = wdef.feedKind === "single" && wdef.loaderStation !== undefined ? loaderFit(state, v, def, wdef.loaderStation) : true;
          if (!loader && wdef.noLoaderFactor === undefined) continue; // nobody can load it
          const secs = (wdef.roundLoadSeconds ?? 1) * (loader ? 1 : wdef.noLoaderFactor!);
          w.burstIndex = -1; w.nextShotTick = tick + Math.max(1, secondsToTicks(secs));
        } else if (tick >= w.nextShotTick) { w.loadedRound = true; w.burstIndex = 0; }
        continue;
      }
      // Line of fire from the muzzle, once a second (the own hull and a target hull are not obstacles).
      if (w.burstLeft <= 0 && tick - task.lineCheckTick >= TICK_HZ) {
        task.lineCheckTick = tick;
        if (task.contact !== undefined && crew) { const c = crewContact(ctx, state, crew, task.contact); if (c) { task.x = c.x; task.y = c.y; } }
        const [mx, my, mz] = muzzleWorld(ctx, def, si, st.taskWeapon, t.x, t.y, t.heading, st.azimuth);
        // (Fire at the ground — high explosive at men's feet — is checked to a point a little above it: a line
        // grazing flat ground short of the point is not a wall in the way.)
        const tz = heightAt(ctx.map, task.x, task.y) + Math.max(task.heightM, 0.6); // ground: ok (the point fired at)
        const tv = task.contact !== undefined && state.vehicle.has(task.contact) ? task.contact : -1;
        const r = sight(ctx, mx, my, mz, task.x, task.y, tz, vid, tv);
        const range = hypot2(task.x - mx, task.y - my);
        task.lineClear = r.blockedBy === null || (1 - r.blockedAt) * range <= LINE_ALLOWANCE_M;
        if (!task.lineClear && crew && v.unit !== null && !crew.lineBlockedReported) { crew.lineBlockedReported = true; radioFromTarget(state, v.unit, "radio.noLineOfFire", events); }
      }
      if (!task.lineClear || st.laidTick < 0 || tick < w.nextShotTick) continue;
      if (w.burstLeft <= 0) {
        if (friendInLine(ctx, state, op, task.x, task.y)) { w.nextShotTick = tick + TICK_HZ / 2; continue; }
        w.burstLeft = wdef.feedKind === "belt" && wd.sustained ? wd.sustained.burstRounds : 1;
        w.burstIndex = 0;
      }
      // ---- one round
      const { ammoId, v0 } = pickRound(ctx.catalog, wd, feed.item, feed.rounds);
      if (v0 === undefined) { st.task = null; continue; }
      const [mx, my, mz] = muzzleWorld(ctx, def, si, st.taskWeapon, t.x, t.y, t.heading, st.azimuth);
      let tx = task.x, ty = task.y;
      const tr = tableRange(wdef.engageRangeM);
      if (task.contact !== undefined && crew) {
        const c = crewContact(ctx, state, crew, task.contact);
        if (c && (c.vx !== 0 || c.vy !== 0)) { const tof = flightTimeAt(ctx, ammoId, v0, Math.min(hypot2(tx - mx, ty - my), tr), tr); tx += c.vx * tof; ty += c.vy * tof; }
      }
      const range = hypot2(tx - mx, ty - my);
      if (range < 2) { st.task = null; continue; }
      const tz = heightAt(ctx.map, task.x, task.y) + task.heightM; // ground: ok (the point fired at)
      const a0 = atan2(ty - my, tx - mx);
      const believed = range * (1 + task.rangeError);
      const skill = os.skills["marksmanship"] ?? 0.5;
      const speed = Math.abs(v.drive.speed);
      const recoil = wd.sustained?.recoilFactor ?? 1;
      // Components (M7.4b): a wrecked stabiliser fires as unstabilised; wrecked sights treble the error.
      const stab = compCondition(v, def, "stabiliser") <= 0 ? "none" : sn.stabiliser;
      const sightK = compCondition(v, def, "sights") <= 0 ? 3 : 1;
      const sd = (sn.baseErrorMrad + sn.movingMradPerMps * speed * (stab === "none" ? 3 : stab === "one-plane" ? 1.5 : 1))
        * skillFactor(ctx, skill) * (1 + A.burstGrowth * recoil * w.burstIndex) * os.impair.aim * sightK;
      const total = sqrt(sd * sd + wd.dispersionMrad * wd.dispersionMrad) / 1000;
      launchShot(ctx, state, events, op, wdef.weapon, ammoId, v0, mx, my, mz, tz, a0, range, believed, total, vid, tr);
      feed.rounds--;
      w.lastShotTick = tick;
      if (wdef.feedKind !== "belt") w.loadedRound = false;
      if (wd.jamProbability > 0 && nextFloat(state.rng, Streams.fire) < wd.jamProbability) { w.jammed = true; w.burstLeft = 0; }
      w.burstLeft--;
      w.burstIndex++;
      if (w.burstLeft > 0 && feed.rounds > 0 && !w.jammed) w.nextShotTick = tick + burstCadence(wd.cyclicRpm);
      else {
        w.burstLeft = 0;
        const trickle = !task.self && since > fullTicks;
        const interval = trickle ? F.trickleIntervalS : wd.sustained ? wd.sustained.intervalS : 60 / wd.cyclicRpm;
        const disc = ctx.catalog.behaviour.decisions.ammoIntervalFactor[crew?.ammoRule ?? "normal"];
        w.nextShotTick = tick + Math.max(1, Math.round(secondsToTicks(interval) * disc * (0.85 + 0.3 * nextFloat(state.rng, Streams.fire))));
        if (wdef.feedKind !== "belt") w.burstIndex = 0;
      }
    }
  }
}

function loaderFit(state: SimState, v: VehicleState, def: VehicleDef, kind: string): boolean {
  for (let i = 0; i < def.seats.length; i++) {
    if (def.seats[i]!.station !== kind) continue;
    const o = v.seats[i];
    if (o !== null && o !== undefined && isAble(state.soldier.get(o))) return true;
  }
  return false;
}

// ---------------------------------------------------------------- smoke dischargers

/**
 * Order: fire a salvo of smoke grenades (counted items from the container, rule 9). The clouds stand after the
 * dischargers' delay. Returns true, or a radio key why not.
 */
export function dischargeSmoke(ctx: SimContext, state: SimState, vid: EntityId): true | { unable: string } {
  const v = state.vehicle.get(vid);
  const def = v ? ctx.catalog.vehicles[v.def] : undefined;
  const D = def?.dischargers;
  const c = state.container.get(vid);
  // Any crew still in a vehicle that is not burnt out can fire its dischargers if they work (M7.4b).
  if (!v || !def || !D || !c || v.status === "destroyed" || v.status === "abandoned" || compCondition(v, def, "dischargers") <= 0) return { unable: "radio.noSmoke" };
  if (v.pendingSmokeTick >= 0) return true; // a salvo is on its way already
  const have = c.stacks.filter((s) => s.type === D.item).reduce((n, s) => n + s.count, 0);
  if (have < D.perSalvo) return { unable: "radio.noSmoke" };
  // The grenades leave the container now; the screen stands after the delay.
  const sink = emptyContainer();
  transferItems(ctx.catalog, { get: (id) => (id === vid ? c : id === -1 ? sink : undefined) }, { from: vid, to: -1, type: D.item, count: D.perSalvo });
  v.pendingSmokeTick = state.tick + Math.max(1, secondsToTicks(D.delaySeconds));
  v.smokeReadyTick = v.pendingSmokeTick;
  return true;
}

function smokeScreen(ctx: SimContext, state: SimState, events: EventSink, vid: EntityId, v: VehicleState, def: VehicleDef): void {
  v.pendingSmokeTick = -1;
  const D = def.dischargers;
  const t = state.transform.get(vid);
  if (!D || !t) return;
  const ms = ctx.catalog.ammo[D.item]?.multispectral === true;
  const az = t.heading + (v.stations[0]?.azimuth ?? 0);
  let sx = 0, sy = 0;
  for (let k = 0; k < D.perSalvo; k++) {
    const a = az + (D.perSalvo === 1 ? 0 : D.arcRad * (k / (D.perSalvo - 1) - 0.5));
    const x = Math.min(Math.max(t.x + cos(a) * D.rangeM, 1), ctx.map.widthM - 1), y = Math.min(Math.max(t.y + sin(a) * D.rangeM, 1), ctx.map.heightM - 1);
    state.smoke.push({ x, y, radiusM: D.cloudRadiusM, startTick: state.tick, untilTick: state.tick + secondsToTicks(D.cloudSeconds), ...(ms ? { multispectral: true as const } : {}) });
    sx += x; sy += y;
  }
  events.emit({ kind: "vehicle.smoke", tick: state.tick, vehicle: vid, x: sx / D.perSalvo, y: sy / D.perSalvo });
}

// ---------------------------------------------------------------- ready belts from stowage (owner Q17)

/** Capacity of a feed's ready belts, rounds. */
function readyCapacity(def: VehicleDef, si: number, wi: number, fi: number): number {
  const r = def.stations[si]?.weapons[wi]?.feeds[fi]?.ready;
  return r ? r.count * r.charge : 0;
}

/** Halted, a feed run low with belts of its kind in stowage: the operator refills it (timed action). */
function refillCheck(ctx: SimContext, state: SimState, events: EventSink, vid: EntityId, v: VehicleState, def: VehicleDef, si: number): void {
  const sn = def.stations[si]!;
  if (!sn.readyRefillInBattle || sn.refillSeconds === undefined) return;
  if (Math.abs(v.drive.speed) > 0.3 || (v.drive.route.length > v.drive.routeIdx && !v.drive.arrived)) return;
  const op = stationOperator(state, v, def, si);
  if (op === null || state.action.has(op)) return;
  const c = state.container.get(vid);
  if (!c) return;
  const frac = ctx.catalog.behaviour.gunnery.refillBelowFraction;
  const st = v.stations[si]!;
  for (let wi = 0; wi < st.weapons.length; wi++) {
    const w = st.weapons[wi]!;
    for (let fi = 0; fi < w.feeds.length; fi++) {
      const f = w.feeds[fi]!, cap = readyCapacity(def, si, wi, fi);
      if (cap <= 0 || f.rounds > cap * frac) continue;
      const belt = c.stacks.find((s) => s.type === f.item && (s.charge ?? 0) > 0 && f.rounds + (s.charge ?? 0) <= cap);
      if (!belt) continue;
      startAction(state, events, op, "reloadStation", secondsToTicks(sn.refillSeconds), { vehicle: vid, station: si, weapon: wi, feed: fi });
      return;
    }
  }
}

registerActionHandler("reloadStation", {
  check(_ctx, state, actor, a) {
    const v = state.vehicle.get(Number(a.params["vehicle"]));
    if (!v || state.soldier.get(actor)?.mount?.vehicle !== Number(a.params["vehicle"])) return "left-vehicle";
    if (Math.abs(v.drive.speed) > 0.3) return "moving";
    return null;
  },
  complete(ctx, state, actor, a, events) {
    const vid = Number(a.params["vehicle"]), si = Number(a.params["station"]), wi = Number(a.params["weapon"]), fi = Number(a.params["feed"]);
    const v = state.vehicle.get(vid), def = v ? ctx.catalog.vehicles[v.def] : undefined, c = state.container.get(vid);
    const w: VehicleWeaponState | undefined = v?.stations[si]?.weapons[wi];
    const f = w?.feeds[fi];
    if (!v || !def || !c || !w || !f) return;
    const cap = readyCapacity(def, si, wi, fi);
    // Whole belts from stowage onto the ready feed while they fit (counted items, the one generic transfer).
    const ready = emptyContainer();
    const box = { get: (id: EntityId) => (id === vid ? c : id === -1 ? ready : undefined) };
    let moved = 0;
    for (;;) {
      const belt = [...c.stacks].filter((s) => s.type === f.item && (s.charge ?? 0) > 0).sort((p, q) => (q.charge ?? 0) - (p.charge ?? 0))[0];
      if (!belt || f.rounds + (belt.charge ?? 0) > cap) break;
      const r = transferItems(ctx.catalog, box, { from: vid, to: -1, type: f.item, count: 1, charge: belt.charge! });
      if (r.moved === 0) break;
      for (const s of ready.stacks) f.rounds += (s.charge ?? 0) * s.count;
      moved += r.moved;
      ready.stacks = [];
    }
    if (moved > 0) {
      w.lowAmmoReported[fi] = false;
      events.emit({ kind: "items.transferred", tick: state.tick, from: vid, to: actor, item: f.item, count: moved });
    }
  },
});

// ---------------------------------------------------------------- orders and incoming fire

/** A fire order to a vehicle crew: each station that can, at the point or the named enemy, with the nature asked. */
export function stationFireOrder(ctx: SimContext, state: SimState, vid: EntityId, order: Extract<OrderBody, { kind: "fire" }>, issuer: string): true | "unable" | { unable: string } {
  const v = state.vehicle.get(vid), def = v ? ctx.catalog.vehicles[v.def] : undefined;
  if (!v || !def || !canFight(v)) return "unable";
  if (v.stations.length === 0) return "unable";
  const crew = v.unit !== null ? state.unit.get(v.unit) : undefined;
  const t = state.transform.req(vid);
  // The named enemy, if the crew knows him (an unknown or own entity is ignored: the point is used).
  const named = order.contact !== undefined && targetLive(state, order.contact) && (state.identity.get(order.contact)?.side ?? state.vehicle.get(order.contact)?.side) !== issuer ? order.contact : undefined;
  let x = order.x, y = order.y;
  if (named !== undefined && crew) { const c = crewContact(ctx, state, crew, named); if (c) { x = c.x; y = c.y; } }
  const isVeh = named !== undefined && state.vehicle.has(named);
  const d = hypot2(x - t.x, y - t.y);
  const G = ctx.catalog.behaviour.gunnery;
  const want: Nature = (order.nature === "at" ? undefined : order.nature) ?? (isVeh ? "ap" : d > G.coaxSingleWithinM ? "he" : "mg");
  let any = false;
  for (let si = 0; si < v.stations.length; si++) {
    if (stationOperator(state, v, def, si) === null) continue;
    const f = feedFor(ctx, def, v.stations[si]!, si, want, v);
    if (!f) continue;
    const h = order.heightM ?? (isVeh ? 1.2 : f.nature === "he" ? 0 : ctx.catalog.shooting.fire.aimPointHeightM);
    setStationTask(ctx, state, vid, si, x, y, h, f.weapon, f.feed, named, false);
    v.stations[si]!.why = { tick: state.tick, keys: ["why.target.ordered", `why.nature.${f.nature}`] };
    any = true;
  }
  if (!any) return { unable: "radio.noAmmunition" };
  if (crew) { crew.firing = true; crew.lineBlockedReported = false; }
  return true;
}

/** Cease fire for a crew: its station tasks end, and it holds its fire until fired upon again. */
export function stationCeaseFire(state: SimState, crewId: EntityId, events: EventSink): void {
  const crew = state.unit.get(crewId);
  if (!crew || crew.vehicle === undefined) return;
  crew.ceaseFireTick = state.tick;
  const v = state.vehicle.get(crew.vehicle);
  let had = false;
  if (v) for (const st of v.stations) if (st.task) { st.task = null; had = true; }
  if (crew.firing || had) { crew.firing = false; events.emit({ kind: "fire.ceased", tick: state.tick, unit: crewId, reason: "ordered" }); }
}

/**
 * Hits on a hull (plan §1): the crew unit and its platoon are under fire (return-fire rule, drills), and the
 * vehicle remembers when (the AI polls `lastHitTick`). Incoming fire near a vehicle keeps its ordered tasks at
 * the full rate.
 */
export function vehicleIncomingSystem(ctx: SimContext, state: SimState, events: readonly SimEvent[]): void {
  if (state.vehicle.size === 0) return;
  const D = ctx.catalog.behaviour.decisions, F = ctx.catalog.shooting.fire, tick = state.tick;
  const mem = secondsToTicks(D.underFireMemorySeconds);
  const stamp = (u: Unit | undefined) => { if (!u) return; if (tick - u.underFireTick > mem) u.contactTick = tick; u.underFireTick = tick; };
  let near: { vid: EntityId; x: number; y: number; side: string }[] | null = null;
  const r2 = F.incomingRadiusM * F.incomingRadiusM;
  const refresh = new Set<EntityId>();
  for (const e of events) {
    if (e.kind === "vehicle.hit") {
      const v = state.vehicle.get(e.vehicle);
      if (!v) continue;
      const sideOwner = state.identity.get(e.owner)?.side;
      if (sideOwner === v.side) continue;
      v.lastHitTick = tick;
      if (v.unit !== null) { stamp(state.unit.get(v.unit)); stamp(topOf(state, v.unit)); }
      refresh.add(e.vehicle);
      continue;
    }
    let side: string | undefined;
    if (e.kind === "shot.fired") side = state.identity.get(e.shooter)?.side;
    else if (e.kind === "impact" && e.owner > 0) side = state.identity.get(e.owner)?.side;
    else continue;
    if (side === undefined) continue;
    if (near === null) {
      near = [];
      for (const [vid, v] of state.vehicle.entries()) {
        if (!v.stations.some((s) => s.task !== null)) continue;
        const t = state.transform.get(vid);
        if (t) near.push({ vid, x: t.x, y: t.y, side: v.side });
      }
    }
    for (const m of near) {
      if (m.side === side) continue;
      const dx = m.x - e.x, dy = m.y - e.y;
      let hit: boolean;
      if (e.kind === "impact") hit = dx * dx + dy * dy <= r2;
      else { const along = dx * e.dirX + dy * e.dirY, across = dx * -e.dirY + dy * e.dirX; hit = along > 0 && along <= F.incomingReachM && across * across <= r2; }
      if (hit) refresh.add(m.vid);
    }
  }
  const fullTicks = secondsToTicks(F.fullRateSeconds);
  for (const vid of [...refresh].sort((a, b) => a - b)) {
    const v = state.vehicle.get(vid);
    if (!v) continue;
    for (const st of v.stations) {
      if (!st.task) continue;
      if (tick - st.task.reasonTick > fullTicks) for (const w of st.weapons) w.nextShotTick = Math.min(w.nextShotTick, tick + TICK_HZ / 2);
      st.task.reasonTick = tick;
    }
  }
}

