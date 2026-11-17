/**
 * THE VERWUNDETENNEST AND THE PLATOON MEDIC (SPEC 9.1, M10.5).
 *
 * Each platoon (a top unit) gathers its casualties at a rear point of kind "medical" (the `rear` store; the owner's
 * word is Verwundetennest, the Bundeswehr's company point is the Verwundetensammelpunkt). It is sited automatically
 * the first time a man of the platoon needs taking back (core/medical.json `nest`): `backM` behind the centre of the
 * platoon's able men, away from the enemy they know (else toward the nearest map edge), at the spot within `searchM`
 * that is hidden from that enemy for a man lying down, on open ground a wheeled vehicle can reach from that edge.
 * A known enemy coming within `threatM` moves it (unless the player placed it: `casualtyPoint`), and an empty one left
 * more than `driftM` behind follows the platoon.
 *
 * Who goes there: a living, uncaptured wounded man on foot who is out of the fight (incapacitated, cannot walk or
 * cannot fight) or whom the player ordered back (`evacuate`), once nobody is treating him and his urgent needs are
 * seen to (or nobody can see to them). He walks there himself if he can (a carrying party of his own, the "walking"
 * method); otherwise the platoon leader tasks `bearers` riflemen (owner M10-2 Q-2e) — fit men of the platoon who are
 * not leaders or medical men, the casualty's own squad first, never leaving a squad below `minFitLeft` fit men — as a
 * carrying party (systems/carry.ts: they take cover with him under fire and go on when it eases), at most
 * `maxParties` parties per platoon at once, T1 first (by the tag he has; ordered men before all). On arrival he is at
 * the nest (`SoldierState.atNest`), his unit's orders pass him by, and the bearers go back to their squad leader.
 *
 * The platoon medic: the platoon's best-trained medical man (DE the Sanitäter, RU the rifleman-medic) goes to the
 * nest when it is within `medicReachM` and he is free, and sees to the men there one by one (T1 first) as a carer
 * (systems/medical.ts): he triages again (his training beats a comrade's tag) and gives the care only he can
 * (decompression, fluids). Casualties at the nest get no other carers. Same rules for every side, player and AI.
 */
import { onAir } from "../comms";
import type { SoldierState } from "../components";
import type { SimContext } from "../context";
import type { EventSink } from "../events";
import { secondsToTicks, type EntityId } from "../ids";
import { canReport, isAble, isConscious, isFit } from "../impair";
import { indoorAt } from "../interior-nav";
import { careNeed, isResponder, needsEvacuation, nextIntervention, SKILL_RANK } from "../medical";
import { hypot2 } from "../math";
import { isMounted } from "../mount";
import { assetServing } from "../offmap";
import { navCostAt, nearestPassable } from "../nav";
import { navFor } from "../navctx";
import { newEntity, type SimState } from "../state";
import { bearersBack, endCarry, startCarry } from "./carry";
import { inPosition } from "../positions";
import { coveredFrom } from "./decisions";
import { assignCarer, careEnabled, releaseCarer, treatedNow, underFireForCare } from "./medical";

/** Eight directions for the search rings around the nest's ideal spot. */
const DIRS: readonly (readonly [number, number])[] = [[1, 0], [0.7071, 0.7071], [0, 1], [-0.7071, 0.7071], [-1, 0], [-0.7071, -0.7071], [0, -1], [0.7071, -0.7071]];

export function topOf(state: SimState, uid: EntityId): EntityId {
  let u = uid;
  for (let p = state.unit.get(u)?.parent ?? null; p !== null; p = state.unit.get(u)?.parent ?? null) u = p;
  return u;
}

/** Every man of a unit and its sub-units (ascending id). */
function menOf(state: SimState, uid: EntityId): EntityId[] {
  const out: EntityId[] = [];
  const walk = (u: EntityId) => { const x = state.unit.get(u); if (!x) return; out.push(...x.members); for (const c of x.children) walk(c); };
  walk(uid);
  return out.sort((a, b) => a - b);
}

/** The medical rear point of top unit `top`, or null. */
export function nestOf(state: SimState, top: EntityId): EntityId | null {
  for (const [id, p] of state.rear.entries()) if (p.kind === "medical" && p.unit === top) return id;
  return null;
}

/** The nest of the platoon a man or unit belongs to (null if it has none yet). */
export function nestFor(state: SimState, target: EntityId): EntityId | null {
  const uid = state.unit.has(target) ? target : state.identity.get(target)?.unit;
  return uid === undefined ? null : nestOf(state, topOf(state, uid));
}

/** Is he leading a unit? */
function leads(state: SimState, id: EntityId): boolean {
  const u = state.identity.get(id)?.unit;
  return u !== undefined && state.unit.get(u)?.leader === id;
}

/** Free for a new errand (bearer, the medic going to the nest): not busy, not carrying, not at the nest. */
function freeMan(state: SimState, id: EntityId, s: SoldierState): boolean {
  if (!isAble(s) || !s.impair.canWalk || !s.impair.canUseArms || isMounted(s) || s.evade !== null || state.action.has(id)) return false;
  if (s.intent !== null && s.intent.kind !== "engage" && s.intent.kind !== "cover") return false;
  if (s.carrying !== undefined || s.atNest !== undefined || state.tick < s.stunnedUntilTick) return false;
  return s.mental.behaviour !== "panicked" && s.mental.behaviour !== "routed";
}

/**
 * Where the nest goes for top unit `top` (pure apart from reading the state and the map): see the header. Null if the
 * platoon has nobody left to site it from.
 */
export function siteNest(ctx: SimContext, state: SimState, top: EntityId): { x: number; y: number } | null {
  // (M11.3: never within `supply.nestApartM` of the platoon's supply point; review fix: nor within `nestClearM` of any
  // cache holding ammunition — an old point, a crate, a pile, a captured cache.)
  const sp = supplyPointOf(state, top), S = ctx.catalog.supply;
  const avoid: { x: number; y: number; r: number }[] = [];
  if (sp !== null && S) avoid.push({ x: state.rear.req(sp).x, y: state.rear.req(sp).y, r: S.nestApartM });
  if (S && S.nestClearM > 0) for (const [k, c] of state.cache.entries()) {
    if (c.burnt === true || !ammoIn(ctx, state.container.get(k))) continue;
    const t = state.transform.req(k);
    avoid.push({ x: t.x, y: t.y, r: S.nestClearM + 1 });
  }
  return sitePoint(ctx, state, top, ctx.catalog.medical!.nest!, avoid);
}

/** Does a container hold ammunition (rounds in a magazine or package, or whole rounds)? */
function ammoIn(ctx: SimContext, c: { stacks: readonly { type: string; count: number; charge?: number }[] } | undefined): boolean {
  if (c) for (const s of c.stacks) {
    if (s.count <= 0) continue;
    if (s.charge === undefined) { if (ctx.catalog.ammo[s.type] !== undefined) return true; continue; }
    const ci = ctx.catalog.items[s.type]?.chargeItem;
    if (s.charge > 0 && ci !== undefined && ctx.catalog.ammo[ci] !== undefined) return true;
  }
  return false;
}

/** Is a cache holding ammunition within `supply.nestClearM` of (x, y) (a nest may not go there)? */
export function ammoCacheNear(ctx: SimContext, state: SimState, x: number, y: number): boolean {
  const R = ctx.catalog.supply?.nestClearM ?? 0;
  if (R <= 0) return false;
  for (const [k, c] of state.cache.entries()) {
    if (c.burnt === true) continue;
    const t = state.transform.req(k);
    if ((t.x - x) * (t.x - x) + (t.y - y) * (t.y - y) < R * R && ammoIn(ctx, state.container.get(k))) return true;
  }
  return false;
}

/** The supply point (a `rear` point of kind "supply") of top unit `top`, or null (M11.3). */
export function supplyPointOf(state: SimState, top: EntityId): EntityId | null {
  for (const [id, p] of state.rear.entries()) if (p.kind === "supply" && p.unit === top) return id;
  return null;
}

/**
 * A rear point's spot for top unit `top` (the nest, M10.5; the supply point, M11.3): `N.backM` behind the platoon's able
 * men away from the enemy they know, the spot hidden from that enemy within `N.searchM`, between `N.minBackM` and
 * `N.maxBackM` back, on open ground a wheeled vehicle can reach from the edge behind; never within `avoid.r` of `avoid`.
 */
export function sitePoint(ctx: SimContext, state: SimState, top: EntityId, N: { backM: number; searchM: number; minBackM: number; maxBackM: number }, avoidAt?: { x: number; y: number; r: number } | readonly { x: number; y: number; r: number }[]): { x: number; y: number } | null {
  const zones = avoidAt === undefined ? [] : Array.isArray(avoidAt) ? avoidAt as readonly { x: number; y: number; r: number }[] : [avoidAt as { x: number; y: number; r: number }];
  const inside = (x: number, y: number) => zones.some((z) => hypot2(x - z.x, y - z.y) < z.r);
  let cx = 0, cy = 0, n = 0, tx = 0, ty = 0, tn = 0;
  for (const m of menOf(state, top)) {
    const s = state.soldier.get(m), t = state.transform.get(m);
    if (!s || !t || !isAble(s)) continue;
    cx += t.x; cy += t.y; n++;
    for (const c of s.contacts) { if (c.down || c.surrendered) continue; tx += c.x; ty += c.y; tn++; }
  }
  if (n === 0) return null;
  cx /= n; cy /= n;
  const W = ctx.map.widthM, H = ctx.map.heightM;
  let bx: number, by: number;
  if (tn > 0) {
    tx /= tn; ty /= tn;
    const L = hypot2(cx - tx, cy - ty);
    if (L > 1) { bx = (cx - tx) / L; by = (cy - ty) / L; } else { bx = 0; by = 1; }
  } else {
    // Nobody known: toward the nearest map edge (where a platoon comes from).
    const dW = cx, dE = W - cx, dN = cy, dS = H - cy, mn = Math.min(dW, dE, dN, dS);
    [bx, by] = mn === dW ? [-1, 0] : mn === dE ? [1, 0] : mn === dN ? [0, -1] : [0, 1];
  }
  // Wheeled vehicles must reach it from that edge: the same region of the wheeled grid as the edge behind.
  const wheel = navFor(ctx, "wheeled").grid, foot = navFor(ctx, "foot").grid;
  let ex = cx, ey = cy;
  const tE = Math.min(bx > 0 ? (W - cx) / bx : bx < 0 ? -cx / bx : Infinity, by > 0 ? (H - cy) / by : by < 0 ? -cy / by : Infinity);
  if (Number.isFinite(tE)) { ex = cx + bx * Math.max(0, tE - 10); ey = cy + by * Math.max(0, tE - 10); }
  const ei = nearestPassable(wheel, ex, ey, 25);
  const edgeRegion = ei >= 0 ? wheel.region[ei]! : 0;
  const clampX = (x: number) => Math.min(W - 20, Math.max(20, x)), clampY = (y: number) => Math.min(H - 20, Math.max(20, y));
  const gx = clampX(cx + bx * N.backM), gy = clampY(cy + by * N.backM);
  const lie = ctx.catalog.body.postures.prone.heightM * 0.6;
  let best: { x: number; y: number } | null = null, bestScore = Infinity;
  for (let ring = 0; ring <= 3; ring++) {
    const r = (N.searchM * ring) / 3;
    for (let k = 0; k < (ring === 0 ? 1 : 8); k++) {
      const x = gx + DIRS[k]![0] * r, y = gy + DIRS[k]![1] * r;
      if (x < 10 || y < 10 || x > W - 10 || y > H - 10) continue;
      const along = (x - cx) * bx + (y - cy) * by;
      if (along < N.minBackM || along > N.maxBackM) continue;
      if (navCostAt(foot, x, y) <= 0 || indoorAt(ctx, x, y) >= 0) continue;
      if (inside(x, y)) continue;
      const wc = Math.floor(x / wheel.cellM), wr = Math.floor(y / wheel.cellM);
      if (wc < 0 || wr < 0 || wc >= wheel.cols || wr >= wheel.rows) continue;
      const wi = wr * wheel.cols + wc;
      if (wheel.cost[wi]! <= 0 || (edgeRegion !== 0 && wheel.region[wi] !== edgeRegion)) continue;
      const d = hypot2(x - gx, y - gy);
      if (d >= bestScore) continue;
      const score = (tn > 0 && !coveredFrom(ctx, x, y, tx, ty, lie, 0, 0) ? 1000 : 0) + d;
      if (score < bestScore) { bestScore = score; best = { x, y }; }
    }
  }
  if (best) return best;
  const fi = nearestPassable(foot, gx, gy, 15);
  const at = fi >= 0 ? { x: (fi % foot.cols + 0.5) * foot.cellM, y: (Math.floor(fi / foot.cols) + 0.5) * foot.cellM } : { x: gx, y: gy };
  // (Every spot searched lay too near `avoid`: the nearest passable spot just outside it, in one of eight directions.)
  if (inside(at.x, at.y)) {
    let alt: { x: number; y: number } | null = null, altD = Infinity;
    for (const z of zones) for (const [dx, dy] of DIRS) {
      const x = z.x + dx * (z.r + 2), y = z.y + dy * (z.r + 2);
      if (x < 10 || y < 10 || x > W - 10 || y > H - 10 || navCostAt(foot, x, y) <= 0 || indoorAt(ctx, x, y) >= 0 || inside(x, y)) continue;
      const d = hypot2(x - gx, y - gy);
      if (d < altD) { altD = d; alt = { x, y }; }
    }
    if (alt) return alt;
  }
  return at;
}

/** Put (or move) top unit `top`'s nest at (x, y); `placed` by the player. Its parties on the way go to the new place. */
export function setNest(ctx: SimContext, state: SimState, events: EventSink, top: EntityId, x: number, y: number, reason: "sited" | "threatened" | "drift" | "ordered"): EntityId | null {
  const u = state.unit.get(top);
  if (!u) return null;
  let pid = nestOf(state, top);
  if (pid === null) {
    pid = newEntity(state);
    state.rear.set(pid, { kind: "medical", side: u.side, unit: top, x, y, sitedTick: state.tick, checkTick: state.tick });
  } else {
    const p = state.rear.req(pid);
    p.x = x; p.y = y; p.sitedTick = state.tick; p.checkTick = state.tick;
    // Parties on their way turn to the new place (the leader's way is worked out again).
    for (const [payload, c] of state.carry.entries()) {
      if (c.point !== pid) continue;
      c.dest = { x, y, z: 0 };
      const lead = c.carriers[0] ?? payload, lm = state.mover.get(lead);
      if (c.phase === "move" && lm) { lm.waypoints = []; lm.speedMps = 0; }
    }
  }
  const p = state.rear.req(pid);
  if (reason === "ordered") p.placed = true; else delete p.placed;
  events.emit({ kind: "medical.nest", tick: state.tick, side: u.side, point: pid, unit: top, x: Math.round(x), y: Math.round(y), reason });
  // The platoon leader tells his men where it is.
  const from = u.leader !== null && canReport(state.soldier.get(u.leader)) ? u.leader : menOf(state, top).find((m) => canReport(state.soldier.get(m)));
  if (from !== undefined && reason !== "ordered" && onAir(state, top)) events.emit({ kind: "radio", tick: state.tick, side: u.side, from, key: reason === "sited" ? "radio.nestSited" : "radio.nestMoved", params: { callsign: u.callsign } });
  return pid;
}

/** The platoon's medic for the nest: its best-trained medical man (a medic, else a first responder), HQ first. */
function nestMedic(ctx: SimContext, state: SimState, top: EntityId): { id: EntityId; skill: "firstResponder" | "medic" } | null {
  const hq = state.unit.get(top)?.members ?? [];
  let best: EntityId | null = null, bestRank = -1;
  for (const m of menOf(state, top)) {
    const ident = state.identity.get(m);
    const lvl = ident ? ctx.catalog.factions[ident.faction]?.medicalRoles?.[ident.role]?.level : undefined;
    if (lvl !== "medic" && lvl !== "firstResponder") continue;
    const s = state.soldier.get(m);
    // (Review fix: a man who can work: not hurt himself, lying at the nest, aboard or evacuated. One merely busy
    // stays the pick.)
    if (!s || !isAble(s) || !s.impair.canWalk || !s.impair.canUseArms || isMounted(s) || s.atNest !== undefined || (s.wounds.length > 0 && needsEvacuation(s))) continue;
    const rank = (lvl === "medic" ? 10 : 0) + (hq.includes(m) ? 1 : 0);
    if (rank > bestRank) { best = m; bestRank = rank; }
  }
  if (best === null) return null;
  return { id: best, skill: bestRank >= 10 ? "medic" : "firstResponder" };
}

/** The Verwundetennest, each second with the medical system (see the header). */
export function nestSystem(ctx: SimContext, state: SimState, events: EventSink): void {
  if (!careEnabled(ctx)) return;
  const M = ctx.catalog.medical!, N = M.nest;
  if (!N) return;
  if (state.tick % Math.max(1, secondsToTicks(M.care.stepS)) !== 0) return;
  let groups: Map<EntityId, EntityId[]> | null = null;
  for (const [id, s] of state.soldier.entries()) {
    if (s.wounds.length === 0 || !s.physiology.alive) continue;
    if (isMounted(s) || s.captive !== null) { if (s.atNest !== undefined) delete s.atNest; continue; }
    if (s.atNest === undefined && !needsEvacuation(s)) continue;
    const uid = state.identity.get(id)?.unit;
    if (uid === undefined) continue;
    const top = topOf(state, uid);
    const g = (groups ??= new Map()).get(top);
    if (g) g.push(id); else groups.set(top, [id]);
  }
  // Nests without anyone to look after are checked too (an empty one follows its platoon).
  const tops: EntityId[] = [];
  for (const [, p] of state.rear.entries()) if (p.kind === "medical" && !tops.includes(p.unit)) tops.push(p.unit);
  if (groups) for (const t of groups.keys()) if (!tops.includes(t)) tops.push(t);
  tops.sort((a, b) => a - b);
  for (const top of tops) stepPlatoon(ctx, state, events, top, groups?.get(top) ?? []);
}

function stepPlatoon(ctx: SimContext, state: SimState, events: EventSink, top: EntityId, wounded: readonly EntityId[]): void {
  const M = ctx.catalog.medical!, N = M.nest!, params = ctx.physiologyParams;
  let pid = nestOf(state, top);
  const away = wounded.filter((c) => state.soldier.req(c).atNest === undefined);
  if (pid === null) {
    if (away.length === 0) return;
    const at = siteNest(ctx, state, top);
    if (!at) return;
    pid = setNest(ctx, state, events, top, at.x, at.y, "sited");
    if (pid === null) return;
  }
  const p = state.rear.req(pid);
  // ---- moving it: threatened, or left behind while empty (every checkS; never one the player placed)
  if (!p.placed && state.tick - p.checkTick >= secondsToTicks(N.checkS)) {
    p.checkTick = state.tick;
    let reason: "threatened" | "drift" | null = null;
    let cx = 0, cy = 0, n = 0;
    const r2 = N.threatM * N.threatM;
    for (const m of menOf(state, top)) {
      const s = state.soldier.get(m), t = state.transform.get(m);
      if (!s || !t || !isAble(s)) continue;
      if (s.atNest === undefined && s.carrying === undefined) { cx += t.x; cy += t.y; n++; }
      if (reason === null) for (const c of s.contacts) if (!c.down && !c.surrendered && (c.x - p.x) * (c.x - p.x) + (c.y - p.y) * (c.y - p.y) <= r2) { reason = "threatened"; break; }
    }
    if (reason === null && n > 0 && hypot2(cx / n - p.x, cy / n - p.y) > N.driftM && wounded.every((c) => state.soldier.req(c).atNest === undefined)) {
      // (Not while bearers or an ambulance, M10.6a, are on their way to it.)
      let enRoute = assetServing(state, pid) !== null;
      for (const [, c] of state.carry.entries()) if (c.point === pid) { enRoute = true; break; }
      if (!enRoute) reason = "drift";
    }
    if (reason !== null) {
      const at = siteNest(ctx, state, top);
      if (at && hypot2(at.x - p.x, at.y - p.y) > N.arriveM * 2) setNest(ctx, state, events, top, at.x, at.y, reason);
    }
  }
  // ---- who is at it: within twice arriveM (else he has left it, or it moved)
  const far2 = 4 * N.arriveM * N.arriveM, at2 = N.arriveM * N.arriveM;
  const near = (id: EntityId, r2: number) => { const t = state.transform.req(id); return (t.x - p.x) * (t.x - p.x) + (t.y - p.y) * (t.y - p.y) <= r2 && t.z < 1; };
  let treating: Map<EntityId, EntityId> | null = null;
  for (const c of wounded) {
    const s = state.soldier.req(c);
    if (s.atNest !== undefined && (s.atNest !== pid || !near(c, far2))) { delete s.atNest; continue; }
    // Fit to fight again after care at the nest: back to his squad (returned to duty).
    if (s.atNest === pid && !needsEvacuation(s) && isConscious(s)) {
      treating ??= treatedNow(state);
      if (treating.has(c)) continue;
      delete s.atNest;
      events.emit({ kind: "medical.evac", tick: state.tick, casualty: c, point: pid, phase: "returned" });
      bearersBack(ctx, state, [c]);
    }
  }
  // ---- taking them back: T1 first (the player's orders before all)
  const queue = wounded.filter((c) => {
    const s = state.soldier.req(c);
    return s.atNest === undefined && needsEvacuation(s) && !state.carry.has(c) && s.carrying === undefined && state.tick >= (s.evacRetryTick ?? 0);
  });
  if (queue.length > 0) {
    const busy = treatedNow(state);
    const cat = (c: EntityId) => { const s = state.soldier.req(c); return s.evacOrdered ? 0 : s.triage?.cat ?? 2; };
    queue.sort((a, b) => cat(a) - cat(b) || a - b);
    let parties = 0;
    for (const [, c] of state.carry.entries()) if (c.point === pid && c.carriers.length > 0) parties++;
    const u = state.unit.get(top);
    for (const c of queue) {
      const s = state.soldier.req(c);
      if (near(c, at2)) { arrive(state, events, c, pid); continue; }
      if (busy.has(c)) continue;
      // (His squad getting into its vehicle takes him along, M10.4b.)
      const cuid = state.identity.req(c).unit;
      if (state.unit.get(cuid)?.boarding !== undefined) continue;
      // His urgent needs first (unless nobody can see to them here, or the player wants him back now).
      if (!s.evacOrdered && careNeed(ctx.catalog, state, c, params)?.urgent === true && s.careWait === undefined) continue;
      const walks = isConscious(s) && s.impair.canWalk && state.tick >= s.stunnedUntilTick;
      if (walks) {
        // (Not while he is under fire: he keeps with his squad, which may be getting out of a house, until it eases.)
        if (!s.evacOrdered && underFireForCare(ctx, state, c)) continue;
        // (He leaves his carers: he goes himself.)
        releaseCarersOf(ctx, state, events, c);
        const party = startCarry(ctx, state, events, c, [], { x: p.x, y: p.y, z: 0 }, { purpose: "move", method: "walking", point: pid });
        if (party && state.carry.has(c)) { events.emit({ kind: "medical.evac", tick: state.tick, casualty: c, point: pid, phase: "walks", ...(s.evacOrdered ? { ordered: true } : {}) }); }
        continue;
      }
      if (parties >= N.maxParties) continue;
      // The platoon leader tasks the bearers (or, with him down, the casualty's squad leader).
      const cu = state.unit.get(state.identity.req(c).unit);
      const tasker = u !== undefined && u.leader !== null && canReport(state.soldier.get(u.leader)) ? u.leader : cu !== undefined && cu.leader !== null && canReport(state.soldier.get(cu.leader)) ? cu.leader : null;
      if (tasker === null) continue;
      // (With fewer men free, one carries him alone: a fireman's carry.)
      const bearers = pickBearers(ctx, state, top, c, N.bearers, N.minFitLeft);
      if (bearers.length === 0) continue;
      releaseCarersOf(ctx, state, events, c);
      const party = startCarry(ctx, state, events, c, bearers, { x: p.x, y: p.y, z: 0 }, { purpose: "move", point: pid });
      if (!party || !state.carry.has(c)) continue;
      parties++;
      events.emit({ kind: "medical.evac", tick: state.tick, casualty: c, point: pid, phase: "tasked", by: tasker, bearers: party.carriers.length, ...(s.evacOrdered ? { ordered: true } : {}) });
    }
  }
  // ---- the platoon medic sees to the men at the nest
  const medic = nestMedic(ctx, state, top);
  if (!medic) return;
  const ms = state.soldier.req(medic.id);
  if (!freeMan(state, medic.id, ms)) return;
  const mt = state.transform.req(medic.id);
  if (hypot2(mt.x - p.x, mt.y - p.y) > N.medicReachM) return;
  let pick: EntityId | null = null, pickCat = 9;
  let busy: Map<EntityId, EntityId> | null = null;
  for (const c of wounded) {
    const s = state.soldier.req(c);
    if (s.atNest !== pid) continue;
    const retag = !s.triage || SKILL_RANK[s.triage.skill] < SKILL_RANK[medic.skill];
    const k = s.triage?.cat ?? 2;
    if (k >= pickCat) continue;
    if (!retag && (careNeed(ctx.catalog, state, c, params) === null || nextIntervention(ctx.catalog, state, medic.id, c, false, params) === null)) continue;
    busy ??= treatedNow(state);
    if (busy.has(c)) continue;
    pick = c; pickCat = k;
  }
  if (pick !== null) assignCarer(ctx, state, events, medic.id, pick, true);
}

/** He has reached the nest. */
function arrive(state: SimState, events: EventSink, c: EntityId, pid: EntityId): void {
  const s = state.soldier.req(c);
  s.atNest = pid;
  if (s.evacOrdered) delete s.evacOrdered;
  events.emit({ kind: "medical.evac", tick: state.tick, casualty: c, point: pid, phase: "arrived" });
}

/** Carers on their way to `c` go back (he is taken to the nest). */
function releaseCarersOf(ctx: SimContext, state: SimState, events: EventSink, c: EntityId): void {
  const ids: EntityId[] = [];
  // mounted: ok a man aboard has no care intent
  for (const [m, s] of state.soldier.entries()) if (s.intent?.kind === "care" && s.intent.target === c && !state.action.has(m)) ids.push(m);
  for (const m of ids) releaseCarer(ctx, state, events, m, "handed-over", true);
}

/**
 * Bearers for casualty `c` (`n` men): fit riflemen of the platoon, not leaders or medical men, free, the casualty's own
 * squad first then the nearest; no squad left below `minFit` fit men, none from a squad in an assault or clearing.
 */
function pickBearers(ctx: SimContext, state: SimState, top: EntityId, c: EntityId, n: number, minFit: number): EntityId[] {
  const cu = state.identity.req(c).unit, ct = state.transform.req(c);
  const fit = new Map<EntityId, number>();
  const cands: { m: EntityId; d: number; u: EntityId }[] = [];
  for (const m of menOf(state, top)) {
    const s = state.soldier.get(m), ident = state.identity.get(m);
    if (!s || !ident) continue;
    if (isFit(s) && !isMounted(s) && s.carrying === undefined && s.atNest === undefined) fit.set(ident.unit, (fit.get(ident.unit) ?? 0) + 1);
    if (m === c || !isFit(s) || !freeMan(state, m, s) || leads(state, m) || isResponder(ctx.catalog, state, m)) continue;
    if (state.fire.has(m)) continue; // (a man firing at the enemy keeps firing: support by fire is not stripped)
    const dk = state.unit.get(ident.unit)?.drill?.kind;
    if (dk === "assault" || dk === "clear") continue;
    if ((state.mover.get(m)?.waypoints.length ?? 0) > 0 && s.intent?.kind !== "cover") continue; // (on the move with his squad)
    const t = state.transform.req(m);
    // (Not a man in a house under fire: his squad may have to get out of it.)
    if (indoorAt(ctx, t.x, t.y) >= 0 && underFireForCare(ctx, state, m)) continue;
    // (M11: nor a man in a fighting position under fire: the defence keeps its holes manned; the carry waits.)
    if (inPosition(ctx, state, m) && underFireForCare(ctx, state, m)) continue;
    cands.push({ m, d: hypot2(t.x - ct.x, t.y - ct.y) * (ident.unit === cu ? 0.5 : 1), u: ident.unit });
  }
  cands.sort((a, b) => a.d - b.d || a.m - b.m);
  const out: EntityId[] = [];
  for (const x of cands) {
    if (out.length >= n) break;
    const left = fit.get(x.u) ?? 0;
    if (left - 1 < minFit) continue;
    fit.set(x.u, left - 1);
    out.push(x.m);
  }
  return out;
}

/**
 * The player's `casualtyPoint` order (M10.5): the target's platoon puts its nest at (x, y) (snapped to passable ground
 * outside buildings). True if done.
 */
export function casualtyPointOrder(ctx: SimContext, state: SimState, events: EventSink, target: EntityId, x: number, y: number): true | false | { unable: string } {
  const uid = state.unit.has(target) ? target : state.identity.get(target)?.unit;
  if (uid === undefined) return false;
  // (M11.3, owner: the nest and the supply point stay apart.)
  const sp = supplyPointOf(state, topOf(state, uid)), S = ctx.catalog.supply;
  if (sp !== null && S && hypot2(state.rear.req(sp).x - x, state.rear.req(sp).y - y) < S.nestApartM) return { unable: "radio.nestNearSupply" };
  const foot = navFor(ctx, "foot").grid;
  let px = x, py = y;
  if (navCostAt(foot, x, y) <= 0 || indoorAt(ctx, x, y) >= 0) {
    const i = nearestPassable(foot, x, y, 10);
    if (i < 0) return false;
    px = (i % foot.cols + 0.5) * foot.cellM; py = (Math.floor(i / foot.cols) + 0.5) * foot.cellM;
  }
  // (Review fix: never on ammunition — any cache holding it within `supply.nestClearM`.)
  if (ammoCacheNear(ctx, state, px, py)) return { unable: "radio.nestNearSupply" };
  return setNest(ctx, state, events, topOf(state, uid), px, py, "ordered") !== null;
}

/**
 * A unit ordered into its vehicle (M10.4b) takes its wounded along: its men's trips to the Verwundetennest end (bearers
 * and casualties alike) and its men at the nest are its own again, so the mount fetches them as it fetches any
 * wounded.
 */
export function releaseForBoarding(ctx: SimContext, state: SimState, events: EventSink, uid: EntityId): void {
  const men = new Set(menOf(state, uid));
  const end: EntityId[] = [];
  for (const [payload, c] of state.carry.entries()) if (c.point !== undefined && (men.has(payload) || c.carriers.some((m) => men.has(m)))) end.push(payload);
  for (const p of end) endCarry(ctx, state, events, p, "ordered");
  for (const m of men) { const s = state.soldier.get(m); if (s?.atNest !== undefined) delete s.atNest; }
}

/** The player's `evacuate` order (M10.5): the wounded man goes first in the queue. False if he is no casualty. */
export function evacuateOrder(state: SimState, target: EntityId): boolean {
  const s = state.soldier.get(target);
  if (!s || !s.physiology.alive || s.captive !== null || s.wounds.length === 0 || s.atNest !== undefined) return false;
  s.evacOrdered = true;
  return true;
}
