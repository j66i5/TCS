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
import type { MapDef } from "../map";
import type { MountedAssault, MountedAssaultCarrier, Unit } from "../components";
import type { SimContext } from "../context";
import type { EventSink } from "../events";
import { secondsToTicks, type EntityId } from "../ids";
import { isAble } from "../impair";
import { isOffMap } from "../offmap";
import { sight } from "../los";
import { atan2, cos, hypot2, PI, sin } from "../math";
import { carrierHitNear } from "../mount";
import type { Order, OrderBody, Waypoint } from "../orders";
import { HULL_DOWN, siteHullDown } from "../hulldown";
import type { SimState } from "../state";
import { buildingAt, heightAt } from "../terrain";
import { indoorAt } from "../interior-nav";
import { navCostAt } from "../nav";
import { navFor } from "../navctx";
import { dismountUnit, footUnits, ridersOf } from "./boarding";
import { vehicleHalt, vehicleMove, type OrderResult } from "./drive";
import { areaFireOrder, dischargeSmoke, stationFireOrder, stationLineTo } from "./gunnery";
import { applyOrderNow, radioFromTarget } from "./orders";

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

// ---------------------------------------------------------------- built-up objectives (pure)

/** Area (m2) and centroid of a footprint polygon (flat x, y list). */
function footprintArea(f: readonly number[]): { a: number; cx: number; cy: number } {
  let a = 0, cx = 0, cy = 0;
  const n = f.length / 2;
  for (let i = 0; i < n; i++) {
    const x0 = f[2 * i]!, y0 = f[2 * i + 1]!, x1 = f[(2 * ((i + 1) % n))]!, y1 = f[(2 * ((i + 1) % n)) + 1]!;
    const cr = x0 * y1 - x1 * y0;
    a += cr; cx += (x0 + x1) * cr; cy += (y0 + y1) * cr;
  }
  if (Math.abs(a) < 1e-9) { let sx = 0, sy = 0; for (let i = 0; i < n; i++) { sx += f[2 * i]!; sy += f[2 * i + 1]!; } return { a: 0, cx: sx / Math.max(1, n), cy: sy / Math.max(1, n) }; }
  return { a: Math.abs(a) / 2, cx: cx / (3 * a), cy: cy / (3 * a) };
}

/** Buildings round (x, y): how many have their centre within `radiusM`, and the share of that circle their
 *  footprints cover (each counted whole by its centre). Pure. */
export function builtUpAround(ctx: SimContext, x: number, y: number, radiusM: number): { buildings: number; share: number } {
  let n = 0, area = 0;
  for (const f of buildingShapes(ctx.map)) {
    if (hypot2(f.cx - x, f.cy - y) > radiusM) continue;
    n++; area += f.a;
  }
  return { buildings: n, share: area / (PI * radiusM * radiusM) };
}

/** Each building's footprint area, centroid and reach (its farthest corner from the centroid), cached per map (pure
 *  geometry of the battle's map; review nit: no longer worked out on every drill step). */
const SHAPES = new WeakMap<MapDef, { a: number; cx: number; cy: number; r: number }[]>();
function buildingShapes(map: MapDef): { a: number; cx: number; cy: number; r: number }[] {
  let out = SHAPES.get(map);
  if (out) return out;
  out = map.buildings.map((b) => {
    const f = footprintArea(b.footprint);
    let r = 0;
    for (let i = 0; i + 1 < b.footprint.length; i += 2) r = Math.max(r, hypot2(b.footprint[i]! - f.cx, b.footprint[i + 1]! - f.cy));
    return { ...f, r };
  });
  SHAPES.set(map, out);
  return out;
}

const EDGES = new WeakMap<MapDef, Map<string, number>>();
/**
 * Balance pass 5 review (H3): how far from a built-up objective, back along the way in (unit vector u toward the
 * objective), the built-up ground reaches: walking out from the objective in 10 m steps, the last point with a
 * building within `nearM` of it before a gap of more than `gapM` with none. 0: no building on the way. Pure, cached
 * per map.
 */
export function builtUpEdgeM(ctx: SimContext, x: number, y: number, ux: number, uy: number, nearM: number, gapM: number): number {
  let cache = EDGES.get(ctx.map);
  if (!cache) { cache = new Map(); EDGES.set(ctx.map, cache); }
  const key = `${Math.round(x)},${Math.round(y)},${Math.round(ux * 1000)},${Math.round(uy * 1000)},${nearM},${gapM}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const shapes = buildingShapes(ctx.map), W = ctx.map.widthM, H = ctx.map.heightM;
  let last = 0;
  for (let d = 0; d <= 2000; d += 10) {
    const px = x - ux * d, py = y - uy * d;
    if (px < 0 || py < 0 || px > W || py > H) break;
    if (d - last > gapM) break;
    if (shapes.some((f) => hypot2(f.cx - px, f.cy - py) - f.r <= nearM)) last = d;
  }
  cache.set(key, last);
  return last;
}

/** Is an assault objective BUILT-UP (balance pass 5, owner 2026-11-20): a building, or enough houses round it
 *  (`MountedAssaultDef.urban`)? Without the urban values: never. Pure. */
export function isBuiltUp(ctx: SimContext, x: number, y: number, building?: number): boolean {
  const U = mountedAssaultDef(ctx)?.urban;
  if (!U) return false;
  if (building !== undefined) return true;
  const b = builtUpAround(ctx, x, y, U.radiusM);
  return b.buildings >= U.minBuildings || b.share >= U.minShare;
}

/** The faction's dismount distance for an objective at (x, y) (its doctrine `dismountM`, or `dismountUrbanM` when the
 *  objective is built-up; without a doctrine the willingness formula), and whether it is built-up. With the way in
 *  (`way`, unit vector toward the objective) and `urban.edgeMarginM`, a built-up objective deep inside a village is
 *  dismounted for at the village's edge (review fix H3: the last cover before the built-up area, `builtUpEdgeM` +
 *  the margin) when that is farther out than the urban distance. Pure; the AI commander uses it too. */
export function dismountDistance(ctx: SimContext, faction: string, x: number, y: number, building?: number, way?: { ux: number; uy: number }): { dismountM: number; urban: boolean; edgeM?: number } {
  const f = ctx.catalog.factions[faction];
  const open = f?.dismountM ?? 300 + (1 - (f?.doctrine["willingnessToDismount"] ?? 0.5)) * 500;
  const urban = isBuiltUp(ctx, x, y, building);
  if (!urban) return { dismountM: open, urban };
  const near = Math.min(open, f?.dismountUrbanM ?? open);
  const U = mountedAssaultDef(ctx)?.urban;
  if (!way || U?.edgeMarginM === undefined) return { dismountM: near, urban };
  const edgeM = builtUpEdgeM(ctx, x, y, way.ux, way.uy, U.edgeNearM ?? 30, U.edgeGapM ?? 60);
  return { dismountM: Math.max(near, edgeM + U.edgeMarginM), urban, edgeM };
}

/** Enemy men known this close to a carrier make its squads get out early: `threatMenM`, at most the dismount distance
 *  in force (open or built-up) + `threatMarginM` (balance pass 5: the doctrine rides to that distance from the enemy's
 *  edge, so men seen on the objective must not turn every ride back at `threatMenM`). */
export function threatMenFor(P: MountedAssaultDef, dismountM: number): number {
  return P.threatMarginM !== undefined ? Math.min(P.threatMenM, dismountM + P.threatMarginM) : P.threatMenM;
}

/** Up to `n` points of the roads within `r` of (x, y), nearest first: the streets a support post must see into. */
export function streetPoints(ctx: SimContext, x: number, y: number, r: number, n: number): { x: number; y: number }[] {
  const out: { x: number; y: number; d: number }[] = [];
  for (const rd of ctx.map.roads) {
    const p = rd.points;
    for (let i = 0; i + 3 < p.length; i += 2) {
      // Points along the segment every 20 m.
      const ax = p[i]!, ay = p[i + 1]!, bx = p[i + 2]!, by = p[i + 3]!;
      const L = hypot2(bx - ax, by - ay), k = Math.max(1, Math.ceil(L / 20));
      for (let j = 0; j < k; j++) {
        const qx = ax + ((bx - ax) * j) / k, qy = ay + ((by - ay) * j) / k, d = hypot2(qx - x, qy - y);
        if (d <= r && d > 10) out.push({ x: qx, y: qy, d });
      }
    }
  }
  out.sort((a, b) => a.d - b.d || a.x - b.x || a.y - b.y);
  // Spread them: skip points within 25 m of one already taken.
  const pick: { x: number; y: number }[] = [];
  for (const q of out) { if (pick.length >= n) break; if (pick.every((s) => hypot2(s.x - q.x, s.y - q.y) >= 25)) pick.push({ x: q.x, y: q.y }); }
  return pick;
}

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
  // (Balance pass 5, urban: never a point inside a house; the first such point farther back instead.)
  const inHouse = (p: { x: number; y: number }) => buildingAt(ctx.map, p.x, p.y) !== null;
  while (k0 < 20 && inHouse(at(o.dismountM + behind + k0 * o.stepM))) k0++;
  for (let k = k0; k < k0 + o.candidates; k++) {
    const p = at(o.dismountM + behind + k * o.stepM);
    if (inHouse(p)) continue;
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
  /** Enemies known on or near the objective: points to see as well (in a village its middle is often hidden). */
  extra?: readonly { x: number; y: number }[];
  /** A built-up objective's street points (`streetPoints`): to see as well. */
  streets?: readonly { x: number; y: number }[];
}): { x: number; y: number; facing: number; seen: number } | null {
  const { turretZ, hullZ } = hullHeights(def);
  const targets = [...objectiveRing(ctx, o.obj.x, o.obj.y, o.obj.r), ...(o.extra ?? []).slice(0, 7), ...(o.streets ?? [])];
  const posts = siteHullDown(ctx, o.anchor, targets, {
    cls: def.class, turretZ, hullZ, rangeM: [0, Math.max(1, o.reachM)], threats: o.threats, standoffM: o.standoffM,
    from: o.from, vegMaxM: 1.8, ringsM: o.ringsM, ...(o.behind ? { behind: o.behind } : {}), ...(o.avoid && o.avoid.length > 0 ? { avoid: o.avoid } : {}),
  });
  for (const p of posts) {
    if (p.exposed === true || p.seen < o.minSeen) continue;
    if (hypot2(p.x - o.obj.x, p.y - o.obj.y) < o.minObjectiveM) continue;
    return { x: p.x, y: p.y, facing: p.facing, seen: p.seen };
  }
  return null;
}

/**
 * How far a hull's guns reach for a support post: its main gun's engagement range (no gun: 2 km); in the dark (light below
 * `nightBelowLight`) no farther than the longest night sight of its seats (none: 0).
 */
export function supportReachM(ctx: SimContext, def: VehicleDef, light: number): number {
  let reach = def.stations[0]?.weapons[0]?.engageRangeM ?? 0;
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
 * seeing `postMinSeen`, else any of it (the objective's points and the enemies known near it); none: null (no blind
 * post). The stand-off from known enemy men counts up to the
 * objective's near edge (the enemy on it is what it fires at). In the dark the anchor comes forward until the
 * objective lies within its night sight (`supportReachM`), never inside `minObjectiveM`. Null: none (it stays). Pure.
 */
export function siteSupportPost(ctx: SimContext, def: VehicleDef, o: {
  hull: { x: number; y: number }; anchor: { x: number; y: number }; behind?: { x: number; y: number; ux: number; uy: number; minM: number };
  obj: { x: number; y: number; r: number }; light: number; threats: readonly { x: number; y: number }[]; avoid?: readonly { x: number; y: number }[];
  /** Known enemies near the objective (seen as well as the objective's points). */
  extra?: readonly { x: number; y: number }[];
  /** A built-up objective (balance pass 5): posts may stand closer (`urban.minObjectiveM`, `urban.postStandoffM`) and
   *  must also see into its streets (road points round it count as objective points). */
  urban?: boolean;
}): { x: number; y: number; facing: number; seen: number } | null {
  const P0 = mountedAssaultDef(ctx);
  if (P0 === undefined) return null;
  const U = o.urban === true ? P0.urban : undefined;
  const P = U ? { ...P0, minObjectiveM: U.minObjectiveM, postStandoffM: U.postStandoffM } : P0;
  const streets = U && U.streetPoints > 0 ? streetPoints(ctx, o.obj.x, o.obj.y, U.radiusM, U.streetPoints) : [];
  const reach = supportReachM(ctx, def, o.light);
  let anchor = o.anchor, behind = o.behind;
  const distA = hypot2(anchor.x - o.obj.x, anchor.y - o.obj.y);
  if (reach > 0 && distA > reach) {
    const k = Math.max(P.minObjectiveM, reach - o.obj.r);
    anchor = { x: o.obj.x + ((anchor.x - o.obj.x) * k) / distA, y: o.obj.y + ((anchor.y - o.obj.y) * k) / distA };
    behind = undefined;
  }
  const standoff = (a: { x: number; y: number }) => Math.max(0, Math.min(P.postStandoffM, hypot2(a.x - o.obj.x, a.y - o.obj.y) - o.obj.r - P.arriveM));
  const base = { from: o.hull, obj: o.obj, reachM: reach, ringsM: P.postRingsM, minSeen: P.postMinSeen, minObjectiveM: P.minObjectiveM, threats: o.threats, ...(o.avoid ? { avoid: o.avoid } : {}), ...(o.extra ? { extra: o.extra } : {}), ...(streets.length > 0 ? { streets } : {}) };
  const p = supportPost(ctx, def, { ...base, anchor, standoffM: standoff(anchor), ...(behind ? { behind } : {}) })
    // (Review fix H1: the hull-down search's full rings, out to 250 m round the anchor, before falling back.)
    ?? supportPost(ctx, def, { ...base, ringsM: HULL_DOWN.ringsM, anchor, standoffM: standoff(anchor), ...(behind ? { behind } : {}) });
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
  // None sees anything of it (the objective, its streets or the enemy known near it): none (review fix H1: no blind
  // post `postBackM` straight back any more; the drill's hull follows its squads instead, the AI's stays).
  return null;
}

// ---------------------------------------------------------------- the order

function doctrineOf(ctx: SimContext, u: Unit, ma: { x: number; y: number; ux: number; uy: number; building?: number; dismountM?: number; urban?: boolean }): { dismountM: number; urban: boolean; follow: number } {
  const f = ctx.catalog.factions[u.faction];
  // (Review nit: worked out once when ordered and kept on the drill.)
  const d = ma.dismountM !== undefined ? { dismountM: ma.dismountM, urban: ma.urban === true } : dismountDistance(ctx, u.faction, ma.x, ma.y, ma.building, { ux: ma.ux, uy: ma.uy });
  return { ...d, follow: f?.afterDismount?.kind === "follow" ? f.afterDismount.followM : 0 };
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
    // (Review fix: an Assault to the headquarters alone, `own`, is its own assault, not a platoon's.)
    const hq = !own && r.f === T && hasKids && u.vehicle === undefined;
    (hq ? c.others : c.squads).push(r.f);
  }
  // Foot units with no riders (on foot already) take the ordinary drill now, each on its own.
  const onFoot = u.vehicle !== undefined ? [] : feet.filter((f) => !riding.some((r) => r.f === f) && !(f === T && hasKids && !own)
    && state.unit.req(f).members.some((m) => { const s = state.soldier.get(m); return isAble(s) && s!.mount === undefined; }));
  let res: OrderResult = carriers.length > 0 ? true : "unable";
  const platoonOnFoot = riding.length === 0 && u.vehicle === undefined;
  if (platoonOnFoot) {
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
  // (Review fix: a platoon on foot carries its drill itself: it is what the hulls wait on, its men what they follow.)
  const squads = platoonOnFoot ? [T] : [...riding.map((r) => r.f), ...onFoot].filter((f, i, a) => a.indexOf(f) === i).sort((a, b) => a - b);
  const ma: MountedAssault = { x: order.x, y: order.y, ux, uy, startTick: state.tick, carriers, squads };
  if (order.building !== undefined) ma.building = order.building;
  u.mountedAssault = ma;
  // Dismount points, each hull its own slot across the way in; the hulls with riders only.
  const { dismountM, urban } = doctrineOf(ctx, u, ma);
  ma.dismountM = dismountM;
  if (urban) ma.urban = true;
  // (Review nit: a hull taken into the drill forgets a place it was to go back to after reversing out.)
  for (const c of carriers) { const v = state.vehicle.get(c.vehicle); if (v) delete v.returnTo; }
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
    if (here <= dismountM + P.arriveM) { startDismount(ctx, state, events, T, ma, c, "near"); return; }
    const r = vehicleMove(ctx, state, c.vehicle, [{ x: p.x, y: p.y, mode: "run" }], atan2(uy, ux));
    if (r !== true) startDismount(ctx, state, events, T, ma, c, "noRoute");
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
/** Why a carrier let its squads out (the `assault.dismounted` event; labs). */
export type DismountReason = "point" | "stopped" | "late" | "immobile" | "hit" | "threatMen" | "threatVehicle" | "empty" | "near" | "noRoute";

function startDismount(ctx: SimContext, state: SimState, events: EventSink, holder: EntityId, ma: MountedAssault, c: MountedAssaultCarrier, reason: DismountReason): void {
  vehicleHalt(state, c.vehicle);
  const then: OrderBody = { kind: "assault", x: ma.x, y: ma.y, ...(ma.building !== undefined ? { building: ma.building } : {}) };
  let any = false;
  for (const sq of c.squads) any = dismountUnit(ctx, state, sq, then) || any;
  for (const o of c.others) any = dismountUnit(ctx, state, o, null) || any;
  const t = state.transform.req(c.vehicle);
  c.dismountAtM = hypot2(t.x - ma.x, t.y - ma.y);
  c.dx = t.x; c.dy = t.y;
  c.phase = "dismount"; c.phaseTick = state.tick;
  if (any) events.emit({ kind: "assault.dismounted", tick: state.tick, unit: holder, vehicle: c.vehicle, distM: Math.round(c.dismountAtM), reason });
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
  // (Review fix H2: the enemy known in the assault lane counts as what the post must see, not only that on the objective.)
  const lane = laneOf(state, ma, P);
  const extra = knownEnemies(ctx, state, ma, P).filter((k) => inLane(lane, k.x, k.y)).map((k) => ({ x: k.x, y: k.y }));
  // (Review fix: a post it finds no route to is passed over for the next, up to three times.)
  for (let tries = 0; tries < 3; tries++) {
    let p: { x: number; y: number; facing: number; seen: number } | null = siteSupportPost(ctx, def, { hull: { x: t.x, y: t.y }, anchor, ...(behind ? { behind } : {}), obj: objR, light: state.environment.light, threats, avoid, extra, ...(ma.urban === true ? { urban: true } : {}) });
    // (Following its squads with no post that sees anything: to the point behind them itself, review fix H1.)
    if (!p && anchorAt && tries === 0 && navCostAt(navFor(ctx, def.class).grid, anchorAt.x, anchorAt.y) > 0 && indoorAt(ctx, anchorAt.x, anchorAt.y) < 0) p = { x: anchorAt.x, y: anchorAt.y, facing: atan2(ma.y - anchorAt.y, ma.x - anchorAt.x), seen: 0 };
    c.post = p ? { x: p.x, y: p.y, facing: p.facing } : null;
    if (!p) return;
    const back = (p.x - t.x) * ma.ux + (p.y - t.y) * ma.uy < 0 && hypot2(p.x - t.x, p.y - t.y) <= 200;
    const wp: Waypoint = back ? { x: p.x, y: p.y, mode: "walk", reverse: true } : { x: p.x, y: p.y, mode: "run" };
    if (vehicleMove(ctx, state, c.vehicle, [wp], p.facing) === true) {
      c.postSeen = Math.round(p.seen * 100) / 100;
      events.emit({ kind: "assault.supportPost", tick: state.tick, unit: holder, vehicle: c.vehicle, x: p.x, y: p.y, seen: c.postSeen });
      return;
    }
    c.post = null;
    avoid.push({ x: p.x, y: p.y });
  }
}

/** The assault lane (review fix H2): from the squads' middle (none on foot: the hulls') to `laneBeyondM` past the
 *  objective, `laneHalfWidthM` either side; without the values only the objective's `fireNearObjectiveM`. */
interface Lane { ax: number; ay: number; ux: number; uy: number; len: number; half: number; ox: number; oy: number; near: number }
function laneOf(state: SimState, ma: MountedAssault, P: MountedAssaultDef): Lane {
  const men = squadMen(state, ma.squads);
  let ax = 0, ay = 0, n = 0;
  if (men.length > 0) for (const m of men) { ax += m.x; ay += m.y; n++; }
  else for (const c of ma.carriers) { const t = state.transform.get(c.vehicle); if (t) { ax += t.x; ay += t.y; n++; } }
  if (n === 0) { ax = ma.x - ma.ux * 300; ay = ma.y - ma.uy * 300; n = 1; }
  ax /= n; ay /= n;
  const L = hypot2(ma.x - ax, ma.y - ay) || 1;
  return { ax, ay, ux: (ma.x - ax) / L, uy: (ma.y - ay) / L, len: L + (P.laneBeyondM ?? 0), half: P.laneHalfWidthM ?? 0, ox: ma.x, oy: ma.y, near: P.fireNearObjectiveM };
}
function inLane(l: Lane, x: number, y: number): boolean {
  if (hypot2(x - l.ox, y - l.oy) <= l.near) return true;
  if (l.half <= 0) return false;
  const along = (x - l.ax) * l.ux + (y - l.ay) * l.uy, across = Math.abs(-(x - l.ax) * l.uy + (y - l.ay) * l.ux);
  return along >= 0 && along <= l.len && across <= l.half;
}

/** Drop the area fire the drill gave a hull's stations (an ordered area task), e.g. once it lifts or leaves the drill. */
function clearDrillAreaFire(state: SimState, vid: EntityId): void {
  const v = state.vehicle.get(vid);
  if (!v) return;
  for (const st of v.stations) if (st.task && st.task.area !== undefined && st.task.self !== true) st.task = null;
}

/** Leave the mounted assaults of these units (a new order reached them): crews and squads drop out; the unit that
 *  holds one ends it. */
export function leaveMountedAssault(state: SimState, units: ReadonlySet<EntityId>): void {
  for (const [id, u] of state.unit.entries()) {
    const ma = u.mountedAssault;
    if (!ma) continue;
    // (Review fix: a hull leaving the drill stops the area fire the drill gave it.)
    for (const c of ma.carriers) if (units.has(id) || units.has(c.crew)) clearDrillAreaFire(state, c.vehicle);
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
function atThreat(state: SimState, P: MountedAssaultDef, c: MountedAssaultCarrier, threatMenM: number): "threatMen" | "threatVehicle" | null {
  const t = state.transform.get(c.vehicle);
  if (!t) return null;
  const maxAge = secondsToTicks(P.threatSeenSeconds);
  for (const m of state.unit.get(c.crew)?.members ?? []) for (const k of state.soldier.get(m)?.contacts ?? []) {
    if (k.wreck === true || k.down === true || k.surrendered === true || k.kind === "heard" || state.tick - k.tick > maxAge) continue;
    const r = k.cls === "vehicle" ? (k.kind === "seen" ? P.threatVehicleM : 0) : threatMenM;
    if (hypot2(k.x - t.x, k.y - t.y) <= r) return k.cls === "vehicle" ? "threatVehicle" : "threatMen";
  }
  return null;
}

/** Men of the assault's squads on foot and able (a unit's own men and those of its foot sub-units, not crews):
 *  where they are. */
function squadMen(state: SimState, squads: readonly EntityId[]): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  const walk = (uid: EntityId) => {
    const u = state.unit.get(uid);
    if (!u || u.vehicle !== undefined) return;
    for (const m of u.members) {
      const s = state.soldier.get(m), t = state.transform.get(m);
      if (t && isAble(s) && s!.mount === undefined) out.push({ x: t.x, y: t.y });
    }
    for (const c of u.children) walk(c);
  };
  for (const sq of squads) walk(sq);
  return out;
}

/** Is the squads' part over: none of them still aboard, getting out, or in its assault drill? */
function squadsDone(state: SimState, squads: readonly EntityId[]): boolean {
  return squads.every((sq) => { const u = state.unit.get(sq); return !u || (u.boarding === undefined && (u.drill === null || u.drill.kind === "rout")); });
}

/**
 * Fire on the objective and the lane to it: an enemy known in the assault lane (`laneOf`: from the squads to
 * `laneBeyondM` past the objective, `laneHalfWidthM` either side; the objective's `fireNearObjectiveM` always), the
 * one nearest the squads first, none within `ownClearM` of own men on foot. The squads within `shiftM`: on the
 * objective beyond its middle only; within `liftM`: none on the objective (the drill's tasks end); with
 * `fireHysteresisM` before fire comes back as they fall back (review fixes: checked every step, before the interval
 * and the post; said on the radio each time it changes).
 */
function supportFire(ctx: SimContext, state: SimState, events: EventSink, ma: MountedAssault, c: MountedAssaultCarrier, P: MountedAssaultDef): void {
  const v = state.vehicle.get(c.vehicle);
  if (!v || (v.status !== "ok" && v.status !== "immobilised" && v.status !== "disarmed")) return;
  const own = squadMen(state, [...ma.squads, ...ma.carriers.flatMap((k) => k.others)]);
  let near = Infinity;
  for (const m of own) near = Math.min(near, hypot2(m.x - ma.x, m.y - ma.y));
  // Shift and lift, every step (review fix: not only every `fireEverySeconds`, nor only on the post).
  const H = P.fireHysteresisM ?? 0;
  const want = near <= P.liftM || (c.lifted === 2 && near <= P.liftM + H) ? 2 : near <= P.shiftM || (c.lifted >= 1 && near <= P.shiftM + H) ? 1 : 0;
  if (want !== c.lifted) {
    if (want === 2) { clearDrillAreaFire(state, c.vehicle); for (const st of v.stations) if (st.task && st.task.self !== true && st.task.contact === c.fireAt) st.task = null; }
    radioFromTarget(state, c.crew, want === 2 ? "radio.liftFire" : want === 1 ? "radio.shiftFire" : "radio.resumeFire", events);
    c.lifted = want;
  }
  if (state.tick - c.fireTick < secondsToTicks(P.fireEverySeconds)) return;
  // (On its post: not while it backs there — a line checked once a second swings with the hull.)
  if (!v.drive.arrived && v.drive.routeIdx < v.drive.route.length) return;
  c.fireTick = state.tick;
  const lifted = c.lifted === 2, shift = c.lifted === 1;
  // (Only at an enemy its gun has a line to: no order the crew would answer with "no line of fire".)
  const line = (k: { x: number; y: number; target: EntityId }) => stationLineTo(ctx, state, c.vehicle, k.target, k.x, k.y);
  const lane = laneOf(state, ma, P);
  let best: { x: number; y: number; target: EntityId } | null = null, bestD = Infinity;
  for (const k of knownEnemies(ctx, state, ma, P)) {
    if (!inLane(lane, k.x, k.y)) continue;
    const dObj = hypot2(k.x - ma.x, k.y - ma.y), onObj = dObj <= P.fireNearObjectiveM;
    if (onObj && lifted) continue;
    if (onObj && shift && (k.x - ma.x) * ma.ux + (k.y - ma.y) * ma.uy < 0) continue;
    if (own.some((f) => hypot2(f.x - k.x, f.y - k.y) < P.ownClearM)) continue;
    // The nearest to the squads first (the one firing on them); each hull its own target first.
    const taken = ma.carriers.some((o) => o !== c && o.fireAt === k.target);
    const dd = hypot2(k.x - lane.ax, k.y - lane.ay) + (taken ? 60 : 0);
    if (dd >= bestD || !line(k)) continue;
    bestD = dd; best = k;
  }
  // Balance pass 5 (area fire): nobody known there: fire on the objective itself (its far half once the squads are
  // close), as at a suspected place; not once lifted.
  if (!best) {
    delete c.fireAt;
    if (lifted) return;
    const R = P.objectiveRadiusM, k = shift ? R : 0;
    if (own.every((f) => hypot2(f.x - (ma.x + ma.ux * k), f.y - (ma.y + ma.uy * k)) >= P.ownClearM + R)) areaFireOrder(ctx, state, c.vehicle, ma.x + ma.ux * k, ma.y + ma.uy * k, R, 1);
    return;
  }
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

/**
 * Review fix MH4: the nearest spot within `coverSearchM` of the hull, back or to the side (never forward), on drivable
 * open ground, out of sight of every eye (the enemy its crew and squads know; none known: the objective's near edge).
 * Null: none.
 */
function coverSpot(ctx: SimContext, state: SimState, ma: MountedAssault, c: MountedAssaultCarrier, P: MountedAssaultDef): { x: number; y: number } | null {
  const v = state.vehicle.get(c.vehicle), def = v ? ctx.catalog.vehicles[v.def] : undefined, t = state.transform.get(c.vehicle);
  const R = P.coverSearchM ?? 0;
  if (!v || !def || !t || R <= 0) return null;
  const known = knownEnemies(ctx, state, ma, P).slice(0, 6).map((k) => ({ x: k.x, y: k.y }));
  const eyes = known.length > 0 ? known : objectiveRing(ctx, ma.x, ma.y, P.objectiveRadiusM).slice(1).filter((p) => (p.x - ma.x) * ma.ux + (p.y - ma.y) * ma.uy < 0);
  if (eyes.length === 0) return null;
  const grid = navFor(ctx, def.class).grid, back = atan2(-ma.uy, -ma.ux), W = ctx.map.widthM, Hm = ctx.map.heightM;
  for (const d of [40, 80, 120, R].filter((x, i, a) => x <= R && a.indexOf(x) === i)) {
    for (const deg of [0, -30, 30, -60, 60, -90, 90]) {
      const a = back + (deg * PI) / 180, x = t.x + cos(a) * d, y = t.y + sin(a) * d;
      if (x < 5 || y < 5 || x > W - 5 || y > Hm - 5 || navCostAt(grid, x, y) <= 0 || indoorAt(ctx, x, y) >= 0 || buildingAt(ctx.map, x, y) !== null) continue;
      if (eyes.every((e) => hiddenFrom(ctx, e.x, e.y, x, y))) return { x, y };
    }
  }
  return null;
}

function stepAssault(ctx: SimContext, state: SimState, events: EventSink, holder: EntityId, u: Unit, ma: MountedAssault, P: MountedAssaultDef): void {
  const hitTicks = secondsToTicks(P.hitRecentSeconds);
  const hit: EntityId[] = [];
  // (Review fix M6: hits by cannon rounds, rockets and missiles only.)
  for (const [vid, v] of state.vehicle.entries()) if (!isOffMap(v) && v.side === u.side && state.tick - (v.lastHeavyHitTick ?? -1e9) <= hitTicks) hit.push(vid);
  const { follow, dismountM, urban } = doctrineOf(ctx, u, ma);
  const threatMen = threatMenFor(P, dismountM);
  const minObj = urban && P.urban ? P.urban.minObjectiveM : P.minObjectiveM;
  for (const c of ma.carriers) {
    if (c.phase === "done") continue;
    const v = state.vehicle.get(c.vehicle)!;
    if (!fit(state, c.vehicle, c.crew)) {
      // Lost: its men aboard bail out on their own (boarding); they carry on on foot only if ordered again.
      c.phase = "done";
      continue;
    }
    const t = state.transform.req(c.vehicle);
    const stopped = v.drive.arrived || v.drive.routeIdx >= v.drive.route.length;
    if (c.phase === "drive") {
      const atPoint = hypot2(t.x - c.dx, t.y - c.dy) <= P.arriveM, there = atPoint || stopped;
      const late = state.tick - ma.startTick >= secondsToTicks(P.rideTimeoutSeconds);
      // (Review nit: a disarmed hull still drives; only an immobilised one lets them out where it stands.)
      const why: DismountReason | null = there ? (atPoint ? "point" : "stopped") : late ? "late" : v.status === "immobilised" ? "immobile" : carrierHitNear(state, c.vehicle, hit, P.hitNearM) ? "hit"
        : atThreat(state, P, c, threatMen) ?? (!aboard(ctx, state, c) ? "empty" : null);
      // A drive that gave up short of the point (jammed among the other hulls): sent on again, `driveRetries` times.
      if (why === "stopped" && (c.retries ?? 0) < (P.driveRetries ?? 0)) {
        c.retries = (c.retries ?? 0) + 1;
        if (vehicleMove(ctx, state, c.vehicle, [{ x: c.dx, y: c.dy, mode: "run" }], atan2(ma.uy, ma.ux)) === true) continue;
      }
      // Review fix MH4: hit or threatened on the way: smoke, and into the nearest spot hidden from the enemy first.
      if ((why === "hit" || why === "threatMen" || why === "threatVehicle") && v.status === "ok" && (P.coverSearchM ?? 0) > 0) {
        if (why === "hit" || why === "threatVehicle") dischargeSmoke(ctx, state, c.vehicle);
        const spot = coverSpot(ctx, state, ma, c, P);
        if (spot) {
          const behind = (spot.x - t.x) * ma.ux + (spot.y - t.y) * ma.uy < 0;
          const wp: Waypoint = behind ? { x: spot.x, y: spot.y, mode: "run", reverse: true } : { x: spot.x, y: spot.y, mode: "run" };
          if (vehicleMove(ctx, state, c.vehicle, [wp], atan2(ma.uy, ma.ux)) === true) {
            c.phase = "cover"; c.phaseTick = state.tick; c.coverWhy = why;
            events.emit({ kind: "assault.cover", tick: state.tick, unit: holder, vehicle: c.vehicle, x: spot.x, y: spot.y, reason: why });
            continue;
          }
        }
      }
      if (why !== null) startDismount(ctx, state, events, holder, ma, c, why);
      continue;
    }
    if (c.phase === "cover") {
      const done = stopped || v.status !== "ok" || state.tick - c.phaseTick >= secondsToTicks(P.coverSeconds ?? 30);
      if (done) startDismount(ctx, state, events, holder, ma, c, (c.coverWhy as DismountReason | undefined) ?? "hit");
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
      // Taken: a man of theirs on it and no enemy man known on it (review fix L9).
      const slack = P.objectiveRadiusM + P.takenSlackM;
      const taken = men.some((m) => hypot2(m.x - ma.x, m.y - ma.y) <= slack)
        && !knownEnemies(ctx, state, ma, P, true).some((k) => hypot2(k.x - ma.x, k.y - ma.y) <= slack);
      clearDrillAreaFire(state, c.vehicle);
      if (v.status === "ok") {
        if (taken) {
          const slot = ma.carriers.indexOf(c), off = (slot - (ma.carriers.length - 1) / 2) * P.slotM;
          const x = clampTo(ma.x - ma.ux * P.consolidateM - ma.uy * off, ctx.map.widthM), y = clampTo(ma.y - ma.uy * P.consolidateM + ma.ux * off, ctx.map.heightM);
          vehicleMove(ctx, state, c.vehicle, [{ x, y, mode: "walk" }], atan2(ma.uy, ma.ux));
        } else if (men.length > 0 && c.dismountAtM >= 0) {
          // Failed (review fix L7): the hull waits back where it let them out (out of sight of the objective, as
          // sited), never forward among them; its squads fall back to it.
          const px = c.dx, py = c.dy;
          const fwd = (px - t.x) * ma.ux + (py - t.y) * ma.uy;
          if (fwd < 0) vehicleMove(ctx, state, c.vehicle, [hypot2(px - t.x, py - t.y) <= 200 ? { x: px, y: py, mode: "walk", reverse: true } : { x: px, y: py, mode: "walk" }], atan2(ma.uy, ma.ux));
          for (const sq of c.squads) {
            const su = state.unit.get(sq);
            if (!su || su.drill?.kind === "rout" || squadMen(state, [sq]).length === 0) continue;
            applyOrderNow(ctx, state, { tick: state.tick, issuer: u.side, target: sq, kind: "withdraw", x: clampTo(px - ma.ux * P.pickupBackM, ctx.map.widthM), y: clampTo(py - ma.uy * P.pickupBackM, ctx.map.heightM) }, events);
          }
        }
      }
      events.emit({ kind: "assault.ended", tick: state.tick, unit: holder, vehicle: c.vehicle, taken });
      c.phase = "done";
      continue;
    }
    // "follow" doctrine: a new post behind the squads once they have moved on (not while it drives to one). A hull
    // that found no post seeing anything follows them so too (review fix H1), `blindFollowM` behind.
    const fol = follow > 0 ? follow : c.post === null ? P.blindFollowM ?? 0 : 0;
    const folSquads = c.squads.length > 0 ? c.squads : ma.squads;
    if (fol > 0 && folSquads.length > 0 && v.status === "ok" && stopped) {
      const men = squadMen(state, folSquads);
      if (men.length > 0) {
        let mx = 0, my = 0;
        for (const m of men) { mx += m.x; my += m.y; }
        mx /= men.length; my /= men.length;
        const px = mx - ma.ux * fol, py = my - ma.uy * fol;
        const fwd = (px - t.x) * ma.ux + (py - t.y) * ma.uy;
        // (Review nit: a built-up objective's own minimum distance, as `sitePost` uses.)
        if ((c.followAt === undefined || hypot2(c.followAt[0] - px, c.followAt[1] - py) >= P.followReplanM) && fwd >= P.followReplanM
          && hypot2(px - ma.x, py - ma.y) >= minObj) {
          c.followAt = [px, py];
          sitePost(ctx, state, events, holder, ma, c, false, { x: clampTo(px, ctx.map.widthM), y: clampTo(py, ctx.map.heightM) });
        }
      }
    }
    supportFire(ctx, state, events, ma, c, P);
  }
}
