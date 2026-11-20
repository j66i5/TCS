/**
 * MOUNTED ASSAULT (balance pass 5, owner 2026-11-20: "Make assault work for vehicles as well. If infantry are riding,
 * the vehicles will stop a sensible distance from the objective, let infantry dismount, fall back slightly to provide
 * support for the infantry that goes the final stretch"). Values: core/behaviour.json `mounting.mountedAssault`
 * (game values, low) and each faction's doctrine `dismountM` / `afterDismount` (sourced per side, docs/research/
 * dismount.md).
 *
 * The `assault {x, y, building?}` order takes this form when its target is
 *   - a foot unit some of whose men ride (a squad aboard, a platoon in its carriers): the mounted assault;
 *   - a vehicle crew: its passengers' squads get out at the dismount point and assault (none aboard: assault by fire);
 *   - a platoon on foot with carriers: the foot drill as before, its carriers support it by fire.
 *
 * Per carrier (`MountedAssaultCarrier`):
 *   drive     to its dismount point (`dismountSpot`: `dismountM` short of the objective on the way in, its own slot
 *             across it, the first spot out of sight of the objective's near edge and of known enemies within a few
 *             steps farther back). Out early on a hit on it or a carrier near it, an anti-tank threat its crew knows
 *             (enemy men or a hull seen close), or the ride timeout; an immobilised hull lets them out where it stands.
 *   dismount  its squads get out (boarding) and take the ordinary assault drill to (x, y) (bounds, the final rush).
 *   support   it backs to a support-by-fire post (`supportPost`: a hull-down post a little behind where it let them
 *             out, whose turret sees the objective) and fires on enemies known near the objective, shifting beyond its
 *             middle and then lifting as its squads close in. "follow" doctrine: a new post behind the squads once they
 *             have moved on. With no riders (a tank, an empty carrier): straight to a post `noRidersStandoffM` out
 *             (tanks do not clear a wood or a village alone).
 *   done      the squads' drills are over: taken (a man of theirs on the objective): the hulls close up to it; failed:
 *             they go to their squads to pick them up.
 *
 * `dismountSpot` and `supportPost` are pure and shared with the AI commander (ai/commander.ts): one siting rule for
 * the player's drill and the AI's attack. State: `Unit.mountedAssault` on the unit ordered (plain data).
 */
import type { MountedAssaultDef, VehicleDef } from "../catalog";
import type { MountedAssault, MountedAssaultCarrier, Unit } from "../components";
import type { SimContext } from "../context";
import type { EventSink } from "../events";
import { secondsToTicks, type EntityId } from "../ids";
import { isAble } from "../impair";
import { sight } from "../los";
import { atan2, cos, hypot2, PI, sin } from "../math";
import { carrierHitNear } from "../mount";
import type { Order, OrderBody, Waypoint } from "../orders";
import { siteHullDown } from "../hulldown";
import type { SimState } from "../state";
import { heightAt } from "../terrain";
import { dismountUnit, footUnits, ridersOf } from "./boarding";
import { vehicleHalt, vehicleMove, type OrderResult } from "./drive";
import { stationFireOrder, stationLineTo } from "./gunnery";
import { radioFromTarget } from "./orders";

/** The mounted-assault values, or undefined (data without the block: an assault to riders dismounts them first). */
export function mountedAssaultDef(ctx: SimContext): MountedAssaultDef | undefined {
  return ctx.catalog.behaviour.mounting.mountedAssault;
}

// ---------------------------------------------------------------- siting (pure; shared with the AI commander)

/** Is (x, y) out of sight of a man standing at (ox, oy) (eye 1.7 m; a hull's top 2.2 m)? The AI's old test. */
export function hiddenFrom(ctx: SimContext, ox: number, oy: number, x: number, y: number): boolean {
  // ground: ok (the open ground the enemy watches from, a hull standing on open ground)
  const z0 = heightAt(ctx.map, ox, oy) + 1.7, z1 = heightAt(ctx.map, x, y) + 2.2;
  return sight(ctx, ox, oy, z0, x, y, z1).blockedBy !== null;
}

function clampTo(v: number, max: number): number { return Math.min(Math.max(v, 5), max - 5); }

/**
 * A carrier's DISMOUNT POINT (M7.2, moved here from the AI commander in balance pass 5): along the way in (unit
 * vector u, toward the objective `tgt`), `offM` across it (its slot), at `dismountM` (+ `behindM`) short of the
 * objective; the first such point at least `dismountM` from every objective in `objectives`, then up to
 * `candidates` points `stepM` farther back for one out of sight of every eye in `eyes` (the objectives' near edges,
 * known enemies); none hidden: the first. Pure.
 */
export function dismountSpot(ctx: SimContext, o: {
  tgt: { x: number; y: number }; objectives: readonly { x: number; y: number }[]; ux: number; uy: number; offM: number;
  dismountM: number; behindM?: number; stepM: number; candidates: number; eyes: readonly { x: number; y: number }[];
}): { x: number; y: number; hidden: boolean } {
  const W = ctx.map.widthM, H = ctx.map.heightM, behind = o.behindM ?? 0;
  const at = (d: number) => ({ x: clampTo(o.tgt.x - o.ux * d - o.uy * o.offM, W), y: clampTo(o.tgt.y - o.uy * d + o.ux * o.offM, H) });
  const far = (p: { x: number; y: number }) => o.objectives.every((q) => hypot2(q.x - p.x, q.y - p.y) >= o.dismountM);
  let k0 = 0;
  while (k0 < 20 && !far(at(o.dismountM + behind + k0 * o.stepM))) k0++;
  for (let k = k0; k < k0 + o.candidates; k++) {
    const p = at(o.dismountM + behind + k * o.stepM);
    if (o.eyes.every((e) => hiddenFrom(ctx, e.x, e.y, p.x, p.y))) return { ...p, hidden: true };
  }
  return { ...at(o.dismountM + behind + k0 * o.stepM), hidden: false };
}

/** A hull's sight height (its highest sensor) and the height of its hull's aim point: what hull-down is scored by. */
export function hullHeights(def: VehicleDef): { turretZ: number; hullZ: number } {
  let turretZ = 0;
  for (const s of def.seats) for (const k of s.sensors ?? []) turretZ = Math.max(turretZ, k.pos?.[2] ?? s.pos[2]);
  if (turretZ <= 0) turretZ = def.body.heightM;
  return { turretZ, hullZ: def.signature?.aimPoints[0]?.[2] ?? 1.2 };
}

/** The objective's points a support post must see: its middle and eight round its edge. */
export function objectiveRing(ctx: SimContext, x: number, y: number, r: number): { x: number; y: number }[] {
  const W = ctx.map.widthM, H = ctx.map.heightM;
  const out = [{ x, y }];
  for (let k = 0; k < 8; k++) out.push({ x: x + cos((k * PI) / 4) * r, y: y + sin((k * PI) / 4) * r });
  return out.filter((p) => p.x > 5 && p.y > 5 && p.x < W - 5 && p.y < H - 5);
}

/**
 * A SUPPORT-BY-FIRE POST for a hull (balance pass 5): the best hull-down post (`siteHullDown`) on rings `ringsM` round
 * `anchor` whose turret sees at least `minSeen` of the objective's points within `reachM`, not nearer the objective
 * than `minObjectiveM`, at least `behind.minM` back from `behind` along the way out when given, `standoffM` off every
 * threat (known enemy men: RPG and Panzerfaust reach), off posts in `avoid`. Null: none. Pure.
 */
export function supportPost(ctx: SimContext, def: VehicleDef, o: {
  from: { x: number; y: number }; anchor: { x: number; y: number }; obj: { x: number; y: number; r: number };
  reachM: number; ringsM: readonly number[]; minSeen: number; minObjectiveM: number; standoffM: number;
  threats: readonly { x: number; y: number }[]; avoid?: readonly { x: number; y: number }[];
  behind?: { x: number; y: number; ux: number; uy: number; minM: number };
}): { x: number; y: number; facing: number } | null {
  const { turretZ, hullZ } = hullHeights(def);
  const targets = objectiveRing(ctx, o.obj.x, o.obj.y, o.obj.r);
  const posts = siteHullDown(ctx, o.anchor, targets, {
    cls: def.class, turretZ, hullZ, rangeM: [0, Math.max(1, o.reachM)], threats: o.threats, standoffM: o.standoffM,
    from: o.from, vegMaxM: 1.8, ringsM: o.ringsM, ...(o.behind ? { behind: o.behind } : {}), ...(o.avoid && o.avoid.length > 0 ? { avoid: o.avoid } : {}),
  });
  for (const p of posts) {
    if (p.exposed === true || p.seen < o.minSeen) continue;
    if (hypot2(p.x - o.obj.x, p.y - o.obj.y) < o.minObjectiveM) continue;
    return { x: p.x, y: p.y, facing: p.facing };
  }
  return null;
}

/**
 * How far a hull's guns reach for a support post: its longest engagement range (no gun: 2 km); in the dark (light below
 * `nightBelowLight`) no farther than the longest night sight of its seats (none: 0).
 */
export function supportReachM(ctx: SimContext, def: VehicleDef, light: number): number {
  let reach = 0;
  for (const st of def.stations) for (const w of st.weapons) reach = Math.max(reach, w.engageRangeM ?? 0);
  if (reach <= 0) reach = 2000; // (a hull with no gun of its own: what it sees, by day)
  const P = mountedAssaultDef(ctx);
  if (P === undefined || light >= P.nightBelowLight) return reach;
  let night = 0;
  for (const seat of def.seats) for (const sn of seat.sensors ?? []) {
    const k = ctx.catalog.spotting.sensors[sn.kind];
    if (k && k.nightLight > 0) night = Math.max(night, k.maxRangeM ?? reach);
  }
  return Math.min(reach, night);
}

/**
 * Where a hull goes to support the assault by fire (the drill's and the AI commander's one rule): round `anchor`
 * (behind `behind.minM` along the way out when given) a post seeing `postMinSeen` of the objective; none: round where
 * it stands, no farther forward, then up to three `postBackM` steps farther back (enemy men known close); each
 * seeing `postMinSeen`, else any of it. The stand-off from known enemy men counts up to the
 * objective's near edge (the enemy on it is what it fires at). In the dark the anchor comes forward until the
 * objective lies within its night sight (`supportReachM`), never inside `minObjectiveM`. Null: none (it stays). Pure.
 */
export function siteSupportPost(ctx: SimContext, def: VehicleDef, o: {
  hull: { x: number; y: number }; anchor: { x: number; y: number }; behind?: { x: number; y: number; ux: number; uy: number; minM: number };
  obj: { x: number; y: number; r: number }; light: number; threats: readonly { x: number; y: number }[]; avoid?: readonly { x: number; y: number }[];
}): { x: number; y: number; facing: number } | null {
  const P = mountedAssaultDef(ctx);
  if (P === undefined) return null;
  const reach = supportReachM(ctx, def, o.light);
  let anchor = o.anchor, behind = o.behind;
  const distA = hypot2(anchor.x - o.obj.x, anchor.y - o.obj.y);
  if (reach > 0 && distA > reach) {
    const k = Math.max(P.minObjectiveM, reach - o.obj.r);
    anchor = { x: o.obj.x + ((anchor.x - o.obj.x) * k) / distA, y: o.obj.y + ((anchor.y - o.obj.y) * k) / distA };
    behind = undefined;
  }
  const standoff = (a: { x: number; y: number }) => Math.max(0, Math.min(P.postStandoffM, hypot2(a.x - o.obj.x, a.y - o.obj.y) - o.obj.r - P.arriveM));
  const base = { from: o.hull, obj: o.obj, reachM: reach, ringsM: P.postRingsM, minSeen: P.postMinSeen, minObjectiveM: P.minObjectiveM, threats: o.threats, ...(o.avoid ? { avoid: o.avoid } : {}) };
  const p = supportPost(ctx, def, { ...base, anchor, standoffM: standoff(anchor), ...(behind ? { behind } : {}) });
  if (p) return p;
  if (anchor !== o.anchor) return null; // (the dark: no fall-back behind it)
  // Round where it stands, no farther forward than it is.
  const ux = o.behind ? -o.behind.ux : (o.obj.x - o.hull.x) / (hypot2(o.obj.x - o.hull.x, o.obj.y - o.hull.y) || 1);
  const uy = o.behind ? -o.behind.uy : (o.obj.y - o.hull.y) / (hypot2(o.obj.x - o.hull.x, o.obj.y - o.hull.y) || 1);
  // (Enemy men known close to it: farther back, out of their rockets' reach, `postBackM` at a time, up to three.)
  for (let k = 0; k <= 3; k++) {
    const a = { x: clampTo(o.hull.x - ux * k * P.postBackM, ctx.map.widthM), y: clampTo(o.hull.y - uy * k * P.postBackM, ctx.map.heightM) };
    const here = { ...base, anchor: a, standoffM: standoff(a), behind: { x: o.hull.x, y: o.hull.y, ux: -ux, uy: -uy, minM: 0 } };
    const q = supportPost(ctx, def, here) ?? supportPost(ctx, def, { ...here, minSeen: 0.01 });
    if (q) return q;
  }
  return null;
}

// ---------------------------------------------------------------- the order

function doctrineOf(ctx: SimContext, u: Unit): { dismountM: number; follow: number } {
  const f = ctx.catalog.factions[u.faction];
  const dismountM = f?.dismountM ?? 300 + (1 - (f?.doctrine["willingnessToDismount"] ?? 0.5)) * 500;
  return { dismountM, follow: f?.afterDismount?.kind === "follow" ? f.afterDismount.followM : 0 };
}

/** Crew units under a unit (not the unit itself), ID order. */
function crewsUnder(state: SimState, uid: EntityId): EntityId[] {
  const out: EntityId[] = [];
  const walk = (u: EntityId) => {
    for (const c of state.unit.get(u)?.children ?? []) {
      const cu = state.unit.get(c);
      if (!cu) continue;
      if (cu.vehicle !== undefined) out.push(c); else walk(c);
    }
  };
  walk(uid);
  return out.sort((a, b) => a - b);
}

/** A hull that can take part: not lost, a crew aboard. */
function fit(state: SimState, vid: EntityId, crew: EntityId): boolean {
  const v = state.vehicle.get(vid);
  return v !== undefined && v.status !== "destroyed" && v.status !== "abandoned" && v.unit === crew && state.unit.get(crew)?.vehicle === vid;
}

/** Riders of foot unit `u` aboard hull `vid`. */
function ridersIn(ctx: SimContext, state: SimState, u: EntityId, vid: EntityId): EntityId[] {
  return ridersOf(ctx, state, u).filter((m) => state.soldier.get(m)?.mount?.vehicle === vid);
}

/**
 * Does this assault order take the mounted form? Only with the data block, never after a dismount (the order a squad
 * carries out once out), only to a unit: a crew, or a foot unit with riders, or a platoon on foot with carriers.
 */
export function mountedAssaultApplies(ctx: SimContext, state: SimState, order: Order, afterDismount: boolean): boolean {
  if (order.kind !== "assault" || afterDismount || mountedAssaultDef(ctx) === undefined) return false;
  const u = state.unit.get(order.target);
  if (!u) return false;
  if (u.vehicle !== undefined) return true;
  const own = order.own === true;
  if (footUnits(state, order.target, own).some((f) => ridersOf(ctx, state, f).length > 0)) return true;
  return !own && crewsUnder(state, order.target).length > 0;
}

/**
 * Start a mounted assault (see the file header). `footDrill`: the caller has given the platoon its foot drill
 * already (a platoon on foot with carriers): the carriers only support it. Returns the order's result.
 */
export function startMountedAssault(ctx: SimContext, state: SimState, events: EventSink, order: Order & { kind: "assault" }, footDrill: (o: Order) => OrderResult): OrderResult {
  const P = mountedAssaultDef(ctx)!;
  const T = order.target, u = state.unit.req(T), own = order.own === true;
  // Hulls taking part, and the foot units riding in each.
  const crews = u.vehicle !== undefined ? [T] : own ? [] : crewsUnder(state, T);
  const feet = u.vehicle !== undefined ? [] : footUnits(state, T, own);
  const hasKids = u.children.some((c) => state.unit.get(c)?.vehicle === undefined);
  const carriers: MountedAssaultCarrier[] = [];
  const vids = new Set<EntityId>();
  const addCarrier = (crew: EntityId, vid: EntityId) => {
    if (vids.has(vid)) return;
    vids.add(vid);
    carriers.push({ vehicle: vid, crew, squads: [], others: [], phase: "drive", dx: 0, dy: 0, phaseTick: state.tick, dismountAtM: -1, fireTick: -1e9, lifted: 0 });
  };
  for (const c of crews) { const vid = state.unit.req(c).vehicle!; if (fit(state, vid, c)) addCarrier(c, vid); }
  // Riders: each foot unit's hull (a unit split over two hulls rides in the first; the rest of it gets out with it).
  const riding: { f: EntityId; vid: EntityId }[] = [];
  const pool = u.vehicle !== undefined ? [...state.unit.entries()].filter(([, x]) => x.side === u.side && x.vehicle === undefined).map(([id]) => id) : feet;
  for (const f of pool) {
    const men = u.vehicle !== undefined ? ridersIn(ctx, state, f, u.vehicle) : ridersOf(ctx, state, f);
    if (men.length === 0) continue;
    const vid = state.soldier.req(men[0]!).mount!.vehicle;
    const v = state.vehicle.get(vid), crew = v?.unit ?? null;
    if (crew === null || !fit(state, vid, crew) || state.unit.get(crew)?.side !== u.side) continue;
    addCarrier(crew, vid);
    riding.push({ f, vid });
  }
  // A platoon's own men (its headquarters) get out with no drill; a squad (no foot sub-units) assaults.
  for (const r of riding) {
    const c = carriers.find((k) => k.vehicle === r.vid)!;
    const hq = r.f === T && hasKids && u.vehicle === undefined;
    (hq ? c.others : c.squads).push(r.f);
  }
  // Foot units with no riders (on foot already) take the ordinary drill now, each on its own.
  const onFoot = u.vehicle !== undefined ? [] : feet.filter((f) => !riding.some((r) => r.f === f) && !(f === T && hasKids)
    && state.unit.req(f).members.some((m) => { const s = state.soldier.get(m); return isAble(s) && s!.mount === undefined; }));
  let res: OrderResult = carriers.length > 0 ? true : "unable";
  if (riding.length === 0 && u.vehicle === undefined) {
    // A platoon on foot with carriers: its drill as before; the carriers support it.
    res = footDrill(order);
    if (res !== true) return res;
  } else {
    for (const f of onFoot) footDrill({ ...order, target: f, own: true });
  }
  if (carriers.length === 0) return res;
  carriers.sort((a, b) => a.vehicle - b.vehicle);
  // The way in: from the hulls' middle to the objective.
  let mx = 0, my = 0;
  for (const c of carriers) { const t = state.transform.req(c.vehicle); mx += t.x; my += t.y; }
  mx /= carriers.length; my /= carriers.length;
  const L = hypot2(order.x - mx, order.y - my) || 1, ux = (order.x - mx) / L, uy = (order.y - my) / L;
  const ma: MountedAssault = { x: order.x, y: order.y, ux, uy, startTick: state.tick, carriers, squads: [...riding.map((r) => r.f), ...onFoot].filter((f, i, a) => a.indexOf(f) === i).sort((a, b) => a - b) };
  if (order.building !== undefined) ma.building = order.building;
  u.mountedAssault = ma;
  // Dismount points, each hull its own slot across the way in; the hulls with riders only.
  const { dismountM } = doctrineOf(ctx, u);
  const eyes = [...objectiveRing(ctx, order.x, order.y, P.objectiveRadiusM).slice(1).filter((p) => (p.x - order.x) * ux + (p.y - order.y) * uy < 0), ...knownEnemies(ctx, state, ma, P).slice(0, 4)];
  const withRiders = carriers.filter((c) => c.squads.length + c.others.length > 0);
  withRiders.forEach((c, i) => {
    const off = (i - (withRiders.length - 1) / 2) * P.slotM;
    const t = state.transform.req(c.vehicle);
    const here = hypot2(t.x - order.x, t.y - order.y);
    const p = dismountSpot(ctx, { tgt: { x: order.x, y: order.y }, objectives: [{ x: order.x, y: order.y }], ux, uy, offM: off, dismountM, stepM: P.dismountStepM, candidates: P.dismountCandidates, eyes });
    c.dx = p.x; c.dy = p.y;
    events.emit({ kind: "assault.dismountPoint", tick: state.tick, unit: T, vehicle: c.vehicle, x: p.x, y: p.y });
    // Already within the distance: out here.
    if (here <= dismountM + P.arriveM) { startDismount(ctx, state, events, T, ma, c); return; }
    const r = vehicleMove(ctx, state, c.vehicle, [{ x: p.x, y: p.y, mode: "run" }], atan2(uy, ux));
    if (r !== true) startDismount(ctx, state, events, T, ma, c);
  });
  // No riders: assault by fire from a post `noRidersStandoffM` out.
  for (const c of carriers) if (c.squads.length + c.others.length === 0) { c.phase = "support"; c.phaseTick = state.tick; sitePost(ctx, state, events, T, ma, c, true); }
  return true;
}

/** Enemies the men of the assault (crews, squads) know: seen or reported, not down, given up or a wreck. */
function knownEnemies(ctx: SimContext, state: SimState, ma: MountedAssault, P: MountedAssaultDef, menOnly = false): { x: number; y: number; z?: number; target: EntityId; vehicle: boolean; seen: boolean }[] {
  const out = new Map<EntityId, { x: number; y: number; z?: number; target: EntityId; vehicle: boolean; seen: boolean; tick: number }>();
  const units = [...ma.carriers.map((c) => c.crew), ...ma.squads, ...ma.carriers.flatMap((c) => c.others)];
  const maxAge = secondsToTicks(P.fireSeenSeconds);
  for (const uid of units) for (const m of state.unit.get(uid)?.members ?? []) {
    const s = state.soldier.get(m);
    if (!s) continue;
    for (const k of s.contacts) {
      if (k.kind === "heard" || k.down === true || k.surrendered === true || k.wreck === true || state.tick - k.tick > maxAge) continue;
      if (menOnly && k.cls === "vehicle") continue;
      const prev = out.get(k.target);
      if (prev && prev.tick >= k.tick) continue;
      out.set(k.target, { x: k.x, y: k.y, ...(k.z !== undefined ? { z: k.z } : {}), target: k.target, vehicle: k.cls === "vehicle", seen: k.kind === "seen", tick: k.tick });
    }
  }
  void ctx;
  return [...out.values()].sort((a, b) => a.target - b.target).map(({ tick: _t, ...r }) => { void _t; return r; });
}

/** Let a carrier's squads out (each with the assault drill to follow) and its other men with none. */
function startDismount(ctx: SimContext, state: SimState, events: EventSink, holder: EntityId, ma: MountedAssault, c: MountedAssaultCarrier): void {
  vehicleHalt(state, c.vehicle);
  const then: OrderBody = { kind: "assault", x: ma.x, y: ma.y, ...(ma.building !== undefined ? { building: ma.building } : {}) };
  let any = false;
  for (const sq of c.squads) any = dismountUnit(ctx, state, sq, then) || any;
  for (const o of c.others) any = dismountUnit(ctx, state, o, null) || any;
  const t = state.transform.req(c.vehicle);
  c.dismountAtM = hypot2(t.x - ma.x, t.y - ma.y);
  c.dx = t.x; c.dy = t.y;
  c.phase = "dismount"; c.phaseTick = state.tick;
  if (any) events.emit({ kind: "assault.dismounted", tick: state.tick, unit: holder, vehicle: c.vehicle, distM: Math.round(c.dismountAtM) });
}

/** Site (and drive to) a carrier's support post. `noRiders`: assault by fire, anchored `noRidersStandoffM` out. */
function sitePost(ctx: SimContext, state: SimState, events: EventSink, holder: EntityId, ma: MountedAssault, c: MountedAssaultCarrier, noRiders = false, anchorAt?: { x: number; y: number }): void {
  const P = mountedAssaultDef(ctx)!;
  const v = state.vehicle.get(c.vehicle), def = v ? ctx.catalog.vehicles[v.def] : undefined;
  if (!v || !def) { c.post = null; return; }
  const t = state.transform.req(c.vehicle);
  const threats = knownEnemies(ctx, state, ma, P, true).map((k) => ({ x: k.x, y: k.y }));
  const avoid = ma.carriers.filter((k) => k !== c && k.post).map((k) => ({ x: k.post!.x, y: k.post!.y }));
  const objR = { x: ma.x, y: ma.y, r: P.objectiveRadiusM };
  const slot = ma.carriers.indexOf(c), n = ma.carriers.length, off = (slot - (n - 1) / 2) * P.slotM;
  let anchor: { x: number; y: number };
  let behind: { x: number; y: number; ux: number; uy: number; minM: number } | undefined;
  if (anchorAt) anchor = anchorAt;
  else if (noRiders) {
    // At the stand-off on the way in from where it is (never nearer than it stands now).
    const d = Math.max(P.noRidersStandoffM, P.minObjectiveM);
    const here = hypot2(t.x - ma.x, t.y - ma.y);
    const dd = Math.min(here, d);
    anchor = { x: clampTo(ma.x - ma.ux * dd - ma.uy * off, ctx.map.widthM), y: clampTo(ma.y - ma.uy * dd + ma.ux * off, ctx.map.heightM) };
  } else {
    anchor = { x: clampTo(c.dx - ma.ux * P.postBackM, ctx.map.widthM), y: clampTo(c.dy - ma.uy * P.postBackM, ctx.map.heightM) };
    behind = { x: c.dx, y: c.dy, ux: -ma.ux, uy: -ma.uy, minM: P.postMinBackM };
  }
  const p = siteSupportPost(ctx, def, { hull: { x: t.x, y: t.y }, anchor, ...(behind ? { behind } : {}), obj: objR, light: state.environment.light, threats, avoid });
  c.post = p;
  if (!p) return;
  const back = (p.x - t.x) * ma.ux + (p.y - t.y) * ma.uy < 0 && hypot2(p.x - t.x, p.y - t.y) <= 200;
  const wp: Waypoint = back ? { x: p.x, y: p.y, mode: "walk", reverse: true } : { x: p.x, y: p.y, mode: "run" };
  if (vehicleMove(ctx, state, c.vehicle, [wp], p.facing) !== true) { c.post = null; return; }
  events.emit({ kind: "assault.supportPost", tick: state.tick, unit: holder, vehicle: c.vehicle, x: p.x, y: p.y });
}

/** Leave the mounted assaults of these units (a new order reached them): crews and squads drop out; the unit that
 *  holds one ends it. */
export function leaveMountedAssault(state: SimState, units: ReadonlySet<EntityId>): void {
  for (const [id, u] of state.unit.entries()) {
    const ma = u.mountedAssault;
    if (!ma) continue;
    if (units.has(id)) { delete u.mountedAssault; continue; }
    ma.carriers = ma.carriers.filter((c) => !units.has(c.crew));
    for (const c of ma.carriers) { c.squads = c.squads.filter((s) => !units.has(s)); c.others = c.others.filter((s) => !units.has(s)); }
    ma.squads = ma.squads.filter((s) => !units.has(s));
    if (ma.carriers.length === 0) delete u.mountedAssault;
  }
}

// ---------------------------------------------------------------- the system

function aboard(ctx: SimContext, state: SimState, c: MountedAssaultCarrier): boolean {
  return [...c.squads, ...c.others].some((f) => ridersIn(ctx, state, f, c.vehicle).length > 0);
}

/** Is an anti-tank threat known to the crew close to its hull: enemy men within `threatMenM`, a hull seen within
 *  `threatVehicleM` (contacts younger than `threatSeenSeconds`)? */
function atThreat(state: SimState, P: MountedAssaultDef, c: MountedAssaultCarrier): boolean {
  const t = state.transform.get(c.vehicle);
  if (!t) return false;
  const maxAge = secondsToTicks(P.threatSeenSeconds);
  for (const m of state.unit.get(c.crew)?.members ?? []) for (const k of state.soldier.get(m)?.contacts ?? []) {
    if (k.wreck === true || k.down === true || k.surrendered === true || k.kind === "heard" || state.tick - k.tick > maxAge) continue;
    const r = k.cls === "vehicle" ? (k.kind === "seen" ? P.threatVehicleM : 0) : P.threatMenM;
    if (hypot2(k.x - t.x, k.y - t.y) <= r) return true;
  }
  return false;
}

/** Men of the assault's squads on foot and able: where they are. */
function squadMen(state: SimState, squads: readonly EntityId[]): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  for (const sq of squads) for (const m of state.unit.get(sq)?.members ?? []) {
    const s = state.soldier.get(m), t = state.transform.get(m);
    if (t && isAble(s) && s!.mount === undefined) out.push({ x: t.x, y: t.y });
  }
  return out;
}

/** Is the squads' part over: none of them still aboard, getting out, or in its assault drill? */
function squadsDone(state: SimState, squads: readonly EntityId[]): boolean {
  return squads.every((sq) => { const u = state.unit.get(sq); return !u || (u.boarding === undefined && (u.drill === null || u.drill.kind === "rout")); });
}

/** Fire on the objective: an enemy known within `fireNearObjectiveM` of it, none within `ownClearM` of own men on
 *  foot; the squads within `shiftM`: beyond its middle only; within `liftM`: none (the tasks it was given end). */
function supportFire(ctx: SimContext, state: SimState, events: EventSink, ma: MountedAssault, c: MountedAssaultCarrier, P: MountedAssaultDef): void {
  const v = state.vehicle.get(c.vehicle);
  if (!v || (v.status !== "ok" && v.status !== "immobilised" && v.status !== "disarmed")) return;
  if (state.tick - c.fireTick < secondsToTicks(P.fireEverySeconds)) return;
  // (On its post: not while it backs there — a line checked once a second swings with the hull.)
  if (!v.drive.arrived && v.drive.routeIdx < v.drive.route.length) return;
  const own = squadMen(state, [...ma.squads, ...ma.carriers.flatMap((k) => k.others)]);
  let near = Infinity;
  for (const m of own) near = Math.min(near, hypot2(m.x - ma.x, m.y - ma.y));
  if (near <= P.liftM) {
    if (c.lifted < 2) { c.lifted = 2; for (const st of v.stations) st.task = null; radioFromTarget(state, c.crew, "radio.liftFire", events); }
    return;
  }
  const shift = near <= P.shiftM;
  if (shift && c.lifted < 1) { c.lifted = 1; radioFromTarget(state, c.crew, "radio.shiftFire", events); }
  c.fireTick = state.tick;
  // (Only at an enemy its gun has a line to: no order the crew would answer with "no line of fire".)
  const line = (k: { x: number; y: number; target: EntityId }) => stationLineTo(ctx, state, c.vehicle, k.target, k.x, k.y);
  let best: { x: number; y: number; target: EntityId } | null = null, bestD = P.fireNearObjectiveM;
  for (const k of knownEnemies(ctx, state, ma, P)) {
    const d = hypot2(k.x - ma.x, k.y - ma.y);
    if (d >= bestD) continue;
    if (shift && (k.x - ma.x) * ma.ux + (k.y - ma.y) * ma.uy < 0) continue;
    if (own.some((f) => hypot2(f.x - k.x, f.y - k.y) < P.ownClearM)) continue;
    // (Each hull its own target first.)
    const taken = ma.carriers.some((o) => o !== c && o.fireAt === k.target);
    const dd = d + (taken ? 60 : 0);
    if (dd >= bestD || !line(k)) continue;
    bestD = dd; best = k;
  }
  if (!best) { delete c.fireAt; return; }
  c.fireAt = best.target;
  stationFireOrder(ctx, state, c.vehicle, { kind: "fire", x: best.x, y: best.y, contact: best.target }, v.side);
}

export function mountedAssaultSystem(ctx: SimContext, state: SimState, events: EventSink): void {
  const P = mountedAssaultDef(ctx);
  if (P === undefined || state.tick % secondsToTicks(P.stepSeconds) !== 0) return;
  for (const [holder, u] of state.unit.entries()) {
    const ma = u.mountedAssault;
    if (!ma) continue;
    stepAssault(ctx, state, events, holder, u, ma, P);
    if (ma.carriers.every((c) => c.phase === "done")) delete u.mountedAssault;
  }
}

function stepAssault(ctx: SimContext, state: SimState, events: EventSink, holder: EntityId, u: Unit, ma: MountedAssault, P: MountedAssaultDef): void {
  const hitTicks = secondsToTicks(P.hitRecentSeconds);
  const hit: EntityId[] = [];
  for (const [vid, v] of state.vehicle.entries()) if (v.side === u.side && state.tick - v.lastHitTick <= hitTicks) hit.push(vid);
  const { follow } = doctrineOf(ctx, u);
  for (const c of ma.carriers) {
    if (c.phase === "done") continue;
    const v = state.vehicle.get(c.vehicle)!;
    if (!fit(state, c.vehicle, c.crew)) {
      // Lost: its men aboard bail out on their own (boarding); they carry on on foot only if ordered again.
      c.phase = "done";
      continue;
    }
    const t = state.transform.req(c.vehicle);
    if (c.phase === "drive") {
      const there = hypot2(t.x - c.dx, t.y - c.dy) <= P.arriveM || v.drive.arrived || v.drive.routeIdx >= v.drive.route.length;
      const late = state.tick - ma.startTick >= secondsToTicks(P.rideTimeoutSeconds);
      if (there || late || v.status !== "ok" || carrierHitNear(state, c.vehicle, hit, P.hitNearM) || atThreat(state, P, c) || !aboard(ctx, state, c)) startDismount(ctx, state, events, holder, ma, c);
      continue;
    }
    if (c.phase === "dismount") {
      const out = !aboard(ctx, state, c) && [...c.squads, ...c.others].every((f) => state.unit.get(f)?.boarding?.kind !== "dismount");
      if (!out && state.tick - c.phaseTick < secondsToTicks(P.dismountTimeoutSeconds)) continue;
      c.phase = "support"; c.phaseTick = state.tick;
      radioFromTarget(state, c.crew, "radio.supportPost", events);
      sitePost(ctx, state, events, holder, ma, c);
      continue;
    }
    // ---- support
    const squads = c.squads.length > 0 ? c.squads : ma.squads;
    if (squads.length > 0 && squadsDone(state, squads)) {
      const men = squadMen(state, squads);
      const taken = men.some((m) => hypot2(m.x - ma.x, m.y - ma.y) <= P.objectiveRadiusM + P.takenSlackM);
      if (v.status === "ok") {
        if (taken) {
          const slot = ma.carriers.indexOf(c), off = (slot - (ma.carriers.length - 1) / 2) * P.slotM;
          const x = clampTo(ma.x - ma.ux * P.consolidateM - ma.uy * off, ctx.map.widthM), y = clampTo(ma.y - ma.uy * P.consolidateM + ma.ux * off, ctx.map.heightM);
          vehicleMove(ctx, state, c.vehicle, [{ x, y, mode: "walk" }], atan2(ma.uy, ma.ux));
        } else if (men.length > 0) {
          let mx = 0, my = 0;
          for (const m of men) { mx += m.x; my += m.y; }
          mx /= men.length; my /= men.length;
          vehicleMove(ctx, state, c.vehicle, [{ x: clampTo(mx - ma.ux * P.pickupBackM, ctx.map.widthM), y: clampTo(my - ma.uy * P.pickupBackM, ctx.map.heightM), mode: "walk" }], atan2(ma.uy, ma.ux));
        }
      }
      events.emit({ kind: "assault.ended", tick: state.tick, unit: holder, vehicle: c.vehicle, taken });
      c.phase = "done";
      continue;
    }
    // "follow" doctrine: a new post behind the squads once they have moved on (not while it drives to one).
    if (follow > 0 && c.squads.length > 0 && v.status === "ok" && (v.drive.arrived || v.drive.routeIdx >= v.drive.route.length)) {
      const men = squadMen(state, c.squads);
      if (men.length > 0) {
        let mx = 0, my = 0;
        for (const m of men) { mx += m.x; my += m.y; }
        mx /= men.length; my /= men.length;
        const px = mx - ma.ux * follow, py = my - ma.uy * follow;
        const fwd = (px - t.x) * ma.ux + (py - t.y) * ma.uy;
        if ((c.followAt === undefined || hypot2(c.followAt[0] - px, c.followAt[1] - py) >= P.followReplanM) && fwd >= P.followReplanM
          && hypot2(px - ma.x, py - ma.y) >= P.minObjectiveM) {
          c.followAt = [px, py];
          sitePost(ctx, state, events, holder, ma, c, false, { x: clampTo(px, ctx.map.widthM), y: clampTo(py, ctx.map.heightM) });
        }
      }
    }
    supportFire(ctx, state, events, ma, c, P);
  }
}
