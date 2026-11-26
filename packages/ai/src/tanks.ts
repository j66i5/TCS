/**
 * TANKS IN BATTLE (M7.6b; game values, low confidence): the commander's tank section, a unit of its own beside the
 * platoons (`isArmourSection`: crews of vehicles that carry no one, from data alone).
 *
 * Overwatch from hull-down posts (siting.ts `siteHullDown`), one siting per section and stage; tank k takes post k,
 * the others are its alternates. Stages:
 *   attacker  "far"    posts `sbfFarM` short of the main objective along the axis, over it and the ground beyond;
 *             "near"   from the assault on, `sbfNearM` short: the bound with the infantry;
 *             "second" the main objective held: 150 m short of the second objective's support line, over its ring;
 *             "hold"   everything held: `holdBehindM` behind the main objective, over the enemy's side;
 *             "withdraw" the platoons break off: hold until the carriers are on their way back (or a minute), then
 *                      back to the start, reversing first;
 *   defender  "hold"   about its start, over the approach, staying `50 m` behind the main objective's line;
 *             "counter" the main objective lost: over its ring.
 * Infantry cover the enemy may hold is a threat (`threatCover`): cells of houses and tall vegetation beyond the side's
 * foremost man on foot (or near an enemy man known lately) that its men have not cleared; posts keep
 * `coverStandoffM` from them and from known enemy men. Tanks do not drive into villages alone.
 * Each tank moves to its post (reversing when the post lies behind its front), then relocates to the next post on a
 * hit that did not get through, after its smoke drill, after `shotsPerPost` main-gun rounds, when an enemy man is
 * known within `atStandoffM` (the post farthest from him, or straight back), or when threat cover comes within the
 * standoff of its post (the section re-sites), or (an attacker's, balance pass 5) after `idleRelocateSeconds` on its
 * post with no shot. It pulls back once (`pullBackM`, sited again, `pullRangeM` and out)
 * when its gun is out of rounds, disarmed or its front reactive tiles are below `eraLowShare`, with an enemy man
 * known within `atKnownM` or a launch seen. Its front faces the enemy vehicle it knows within reach, else the
 * targets' middle. Target choice stays with gunnery (sim).
 *
 * Its memory is plain data (part of the commander's, saved with the game); the cover cells are derived from the map.
 */
import {
  atan2, cos, countItems, hypot2, indoorAt, isCaptive, isOffMap, isOut, PI, planVehicleRoute, sin, wrapAngle,
  type EntityId, type ObjectiveDef, type SimContext, type SimView, type SoldierState, type VehicleDef, type VehicleState,
} from "@tcs/sim";
import { approachPoints, siteHullDown } from "./siting";

/** Game values (low confidence): see the module comment. */
export const TANKS = {
  sbfFarM: 550, sbfNearM: 350, holdBehindM: 120, secondShortM: 480, coverStandoffM: 200, atStandoffM: 300, clearedM: 50,
  enemyCoverSeconds: 60, enemyNearCoverM: 100, enemyClearSeconds: 60, enemyClearM: 60, frontSlackM: 30, coverMinHeightM: 1.8,
  shotsPerPost: 3, carrierPair: 2, samePostM: 30, arrivedM: 15, resendSeconds: 30, carrierWaitSeconds: 180, defenceEngageM: 1500, pullBackM: 250,
  pullRangeM: 600, eraLowShare: 0.25, atKnownM: 500, coverCellM: 10, rangeM: [150, 2500], beyondM: 150, defenceBehindM: 50,
  pullRingsM: [0, 40, 80], idleRelocateSeconds: 60, stuckSeconds: 5, blockedSeconds: 20, progressM: 20, turnDeg: 40, resiteSeconds: 60, withdrawHoldSeconds: 60, reverseMaxM: 150, launchSeenSeconds: 60, menSeenSeconds: 60,
} as const;

/** One tank's memory: its posts [x, y, facing], the post it holds or goes to, the stage they were sited for, when it
 *  was last sent, the last hit, smoke salvo and main-gun shot it has answered, shots from this post. */
export interface TankMem {
  posts: [number, number, number][]; post: number; stage: string; sent: number; seenHit: number; seenSmoke: number;
  shots: number; lastShot: number; reached?: true; pulled?: true; back?: true;
  /** Balance pass 5 (F7): the last tick it was on its way (an attacker's tank idle on its post since then moves on). */
  idleFrom?: number;
  /** Review fix: posts in a row it could not get to (stood still short of it after an order); `stuck`: all of them
   *  failed, the carriers no longer wait for it. */
  failed?: number; stuck?: true;
  /** Review fix: the shortest way still to go on its route since the order, m, and when it last got `progressM` shorter. */
  progD?: number; progTick?: number;
}
/** The commander's memory for its tank sections. */
export interface TanksMemory {
  tk?: Record<string, TankMem>;
  /** Per section: the stage its posts were sited for, its start, when it was last re-sited for cover. */
  tkSited?: Record<string, string>; tkHome?: Record<string, [number, number]>; tkResite?: Record<string, number>;
  /** Review fix (balance pass 2): a defence's carrier crew -> its pair (fixed the first time it is seen). */
  tkPair?: Record<string, number>;
  /** Balance pass 3: an attacker's overwatch carrier crew -> since when it counts as idle (first seen, last shot or
   *  last bound, ticks), its last shot seen, its last try at a bound. */
  obBound?: Record<string, { since: number; shot: number; tried: number; to?: { x: number; y: number }; at?: { x: number; y: number }; missed?: { x: number; y: number }[] }>;
}

/** The vehicle a crew unit has (or had, if it bailed out). */
function crewVehicle(view: SimView, uid: EntityId): EntityId | undefined {
  const u = view.unit.get(uid);
  return u?.vehicle ?? u?.exVehicle;
}

/** A top-level unit whose children are all crews of vehicles with no passenger seats, and no men of its own (M7.6b). */
export function isArmourSection(view: SimView, ctx: SimContext, uid: EntityId): boolean {
  const u = view.unit.get(uid);
  if (!u || u.parent !== null || u.members.length > 0 || u.children.length === 0) return false;
  for (const c of u.children) {
    const vid = crewVehicle(view, c);
    const v = vid === undefined ? undefined : view.vehicle.get(vid);
    const def = v ? ctx.catalog.vehicles[v.def] : undefined;
    if (!def || def.seats.some((s) => s.station === "passenger")) return false;
  }
  return true;
}

/** The hulls of a side's tank sections (to leave out of the platoons' vehicle count). */
export function tankVehicles(view: SimView, ctx: SimContext, side: string): Set<EntityId> {
  const out = new Set<EntityId>();
  for (const [id, u] of view.unit.entries()) {
    if (u.side !== side || !isArmourSection(view, ctx, id)) continue;
    for (const c of u.children) { const vid = crewVehicle(view, c); if (vid !== undefined) out.add(vid); }
  }
  return out;
}

const COVER = new WeakMap<object, { x: number; y: number }[]>();

/** Cells (`coverCellM`) holding infantry cover: a house, or vegetation at least `coverMinHeightM` tall (derived). */
export function coverCells(ctx: SimContext): readonly { x: number; y: number }[] {
  let cells = COVER.get(ctx.map);
  if (cells) return cells;
  cells = [];
  const map = ctx.map, step = TANKS.coverCellM;
  for (let y = step / 2; y < map.heightM; y += step) for (let x = step / 2; x < map.widthM; x += step) {
    const c = Math.min(Math.floor(x / map.cellSizeM), map.cols - 1), r = Math.min(Math.floor(y / map.cellSizeM), map.rows - 1);
    const vi = map.vegetation[r * map.cols + c] ?? 0;
    const veg = vi > 0 ? ctx.catalog.terrain.vegetation[map.vegetationPalette[vi - 1] ?? ""]?.heightM ?? 0 : 0;
    if (veg >= TANKS.coverMinHeightM || indoorAt(ctx, x, y) >= 0) cells.push({ x, y });
  }
  COVER.set(ctx.map, cells);
  return cells;
}

/** Enemy men the side's men know (not down or given up), the freshest report of each (ascending target id). */
export function knownEnemyMen(view: SimView, side: string): { id: EntityId; x: number; y: number; tick: number }[] {
  const best = new Map<EntityId, { x: number; y: number; tick: number }>();
  for (const [id, idn] of view.identity.entries()) {
    if (idn.side !== side) continue;
    const s = view.soldier.get(id) as SoldierState | undefined;
    if (!s || isCaptive(s) || isOut(s)) continue;
    for (const c of s.contacts) {
      if (c.surrendered === true || c.down === true || c.cls === "vehicle") continue;
      const b = best.get(c.target);
      if (!b || c.tick > b.tick) best.set(c.target, { x: c.x, y: c.y, tick: c.tick });
    }
  }
  return [...best.entries()].sort((a, b) => a[0] - b[0]).map(([id, c]) => ({ id, ...c }));
}

/**
 * The cover cells that are a threat to the side's tanks now (see the module comment): beyond its foremost man on
 * foot along (ux, uy) by `frontSlackM`, or within `enemyNearCoverM` of an enemy man known in the last
 * `enemyCoverSeconds`; and not cleared (inside an objective it holds, or within `clearedM` of an own man on foot
 * with no enemy man known within `enemyClearM` in the last `enemyClearSeconds`).
 */
export function threatCover(
  ctx: SimContext, ux: number, uy: number, ownFoot: readonly { x: number; y: number }[], front: number,
  enemies: readonly { x: number; y: number; tick: number }[], held: readonly ObjectiveDef[], tick: number,
): { x: number; y: number }[] {
  const T = TANKS, out: { x: number; y: number }[] = [];
  const recent = enemies.filter((e) => tick - e.tick <= T.enemyCoverSeconds * 60);
  const clearRecent = enemies.filter((e) => tick - e.tick <= T.enemyClearSeconds * 60);
  for (const c of coverCells(ctx)) {
    const beyond = c.x * ux + c.y * uy > front + T.frontSlackM;
    if (!beyond && !recent.some((e) => hypot2(e.x - c.x, e.y - c.y) <= T.enemyNearCoverM)) continue;
    if (held.some((o) => hypot2(o.x - c.x, o.y - c.y) <= o.radiusM)) continue;
    if (ownFoot.some((f) => hypot2(f.x - c.x, f.y - c.y) <= T.clearedM) && !clearRecent.some((e) => hypot2(e.x - c.x, e.y - c.y) <= T.enemyClearM)) continue;
    out.push(c);
  }
  return out;
}

export interface TankArgs {
  view: SimView; tick: number; side: string; ctx: SimContext; objectives: readonly ObjectiveDef[]; mem: TanksMemory;
  order: (target: EntityId, body: Record<string, unknown>) => void;
  defending: boolean;
  /** The attacker's axis toward its objective, or the defender's expected way of the attack (unit vector, toward the enemy). */
  ux: number; uy: number;
  /** The commander's phase ("withdraw": the platoons break off) and since when. */
  phase: string; phaseTick: number;
  /** The carriers still waiting for their squads to get back in (withdrawal). */
  remounting: number;
  /** Own able men on foot (where they stand). */
  ownFoot: readonly { x: number; y: number }[];
  /** The way back for a tank crew in a withdrawal (the commander's own). */
  back: (crew: EntityId) => Record<string, unknown>;
  /** How long the commander leaves a crew reversing out of danger to it, s. */
  reverseHoldSeconds: number;
  /** Balance pass 2 (owner 2026-11-17: "give the defender's carriers hull-down posts"): a defending side's carrier
   *  crews whose squads are out: sited, moved and relocated as more sections (in pairs, keys "carriers-<k>") in its "hold"
   *  and "counter" stages, fire free to `defenceEngageM`. */
  carrierCrews?: readonly EntityId[];
  /** Balance pass 4: the hulls (vehicle ids) placed on their hull-down posts at setup (`onPost` in the battle
   *  input's placements, ai `defenceStartPosts`): at the side's first siting each keeps its spot as its first post. */
  startPosts?: ReadonlySet<string>;
}

/** The highest sight of a vehicle type (its turret's eyes) and its hull aim point's height, m. */
function heights(def: VehicleDef): { turretZ: number; hullZ: number } {
  let turretZ = 0;
  for (const s of def.seats) for (const k of s.sensors ?? []) turretZ = Math.max(turretZ, k.pos?.[2] ?? s.pos[2]);
  if (turretZ <= 0) turretZ = def.body.heightM;
  return { turretZ, hullZ: def.signature?.aimPoints[0]?.[2] ?? 1.2 };
}

/** Rounds left for the main gun (station 0, first weapon): on its feeds and stowed. */
function mainGunRounds(view: SimView, vid: EntityId, v: VehicleState, def: VehicleDef): number {
  const wdef = def.stations[0]?.weapons[0], w = v.stations[0]?.weapons[0];
  if (!wdef || !w) return 0;
  const c = view.container.get(vid);
  let n = 0;
  for (let i = 0; i < wdef.feeds.length; i++) { n += w.feeds[i]?.rounds ?? 0; if (c) n += countItems(c as never, wdef.feeds[i]!.item); }
  return n;
}

/** Share of the front reactive tiles left (1 with none fitted). */
function frontTilesLeft(view: SimView, vid: EntityId, def: VehicleDef): number {
  const c = view.container.get(vid);
  let fitted = 0, left = 0;
  for (const t of def.armour?.tiles ?? []) {
    if (t.face !== "front" || t.fitted <= 0) continue;
    fitted += t.fitted;
    left += c ? Math.min(t.fitted, countItems(c as never, t.item)) : 0;
  }
  return fitted > 0 ? left / fitted : 1;
}

/** The site's anchor and targets for a stage (null: no siting, e.g. the withdrawal). */
function stagePlan(a: TankArgs, stage: string, home: { x: number; y: number }, at: { x: number; y: number }):
  { anchor: { x: number; y: number }; targets: { x: number; y: number }[]; behind?: { x: number; y: number; ux: number; uy: number; minM: number } } | null {
  const T = TANKS, main = a.objectives[0];
  if (!main) return null;
  const W = a.ctx.map.widthM, H = a.ctx.map.heightM;
  const cl = (p: { x: number; y: number }) => ({ x: Math.min(Math.max(p.x, 10), W - 10), y: Math.min(Math.max(p.y, 10), H - 10) });
  const ring = (o: { x: number; y: number; radiusM: number }) => {
    const pts = [{ x: o.x, y: o.y }];
    for (let k = 0; k < 8; k++) pts.push({ x: o.x + cos((k * PI) / 4) * o.radiusM, y: o.y + sin((k * PI) / 4) * o.radiusM });
    return pts;
  };
  const fan = (o: { x: number; y: number }, ux: number, uy: number, rs: readonly number[]) => {
    const pts: { x: number; y: number }[] = [];
    for (const r of rs) for (const s of [-1, -0.5, 0, 0.5, 1]) pts.push({ x: o.x + ux * r - uy * s * r * 0.6, y: o.y + uy * r + ux * s * r * 0.6 });
    return pts;
  };
  const inside = (pts: { x: number; y: number }[]) => pts.filter((p) => p.x > 5 && p.y > 5 && p.x < W - 5 && p.y < H - 5);
  const { ux, uy } = a;
  if (a.defending) {
    const front = atan2(uy, ux);
    const behind = { x: main.x, y: main.y, ux: -ux, uy: -uy, minM: T.defenceBehindM };
    if (stage === "hold") return { anchor: home, targets: approachPoints(a.ctx, main.x, main.y, front), behind };
    return { anchor: home, targets: inside(ring(main)), behind };
  }
  if (stage === "far" || stage === "near") {
    const d = stage === "far" ? T.sbfFarM : T.sbfNearM;
    return { anchor: cl({ x: main.x - ux * d, y: main.y - uy * d }), targets: inside([...ring(main), ...fan(main, ux, uy, [T.beyondM])]) };
  }
  if (stage === "second") {
    const o = a.objectives[1] ?? main;
    const L = Math.max(1, hypot2(o.x - at.x, o.y - at.y)), vx = (o.x - at.x) / L, vy = (o.y - at.y) / L;
    return { anchor: cl({ x: o.x - vx * T.secondShortM, y: o.y - vy * T.secondShortM }), targets: inside(ring(o)) };
  }
  if (stage === "hold") return { anchor: cl({ x: main.x - ux * T.holdBehindM, y: main.y - uy * T.holdBehindM }), targets: inside(fan(main, ux, uy, [150, 300, 450])) };
  return null;
}

/**
 * Every think (each `stepSeconds`): site, move and relocate the side's tank sections (see the module comment).
 * Returns the side's tanks not yet on their first post (the carriers wait for them).
 */
export function tankSections(a: TankArgs): number {
  const { view, tick, side, ctx, mem, order } = a;
  const T = TANKS;
  const sections: { key: string; crews: EntityId[]; carriers?: true }[] = [...view.unit.entries()].filter(([id, u]) => u.side === side && isArmourSection(view, ctx, id))
    .map(([id]) => ({ key: String(id), crews: [...view.unit.get(id)!.children].sort((x, y) => x - y) }));
  // (Review fix: the carriers in pairs, each pair a section of its own with its own home: `siteHullDown` gives at most
  // three posts, so four carriers in one section shared posts and one stuck short of all of them.)
  if (a.defending && (a.carrierCrews?.length ?? 0) > 0) {
    const pair = (mem.tkPair ??= {});
    const cc = [...a.carrierCrews!].sort((x, y) => x - y);
    for (const c of cc) if (pair[String(c)] === undefined) pair[String(c)] = Math.floor(Object.keys(pair).length / T.carrierPair);
    const n = cc.reduce((m, c) => Math.max(m, pair[String(c)]! + 1), 0);
    for (let i = 0; i < n; i++) {
      const crewsI = cc.filter((c) => pair[String(c)] === i);
      if (crewsI.length > 0) sections.push({ key: `carriers-${i}`, crews: crewsI, carriers: true });
    }
  }
  if (sections.length === 0) return 0;
  mem.tk ??= {}; mem.tkSited ??= {}; mem.tkHome ??= {}; mem.tkResite ??= {};
  const main = a.objectives[0];
  const holds = (i: number) => view.objectives[i]?.holder === side;
  const enemies = knownEnemyMen(view, side);
  const menNow = enemies.filter((e) => tick - e.tick <= T.menSeenSeconds * 60);
  const front = a.ownFoot.reduce((m, f) => Math.max(m, f.x * a.ux + f.y * a.uy), -Infinity);
  let notReady = 0;
  for (const { key, crews, carriers } of sections) {
    // The tanks that can still drive and fight, with their hulls.
    const live: { c: EntityId; vid: EntityId; v: VehicleState; def: VehicleDef; x: number; y: number; h: number }[] = [];
    for (const c of crews) {
      const vid = view.unit.get(c)?.vehicle;
      const v = vid === undefined ? undefined : (view.vehicle.get(vid) as VehicleState | undefined);
      const def = v ? ctx.catalog.vehicles[v.def] : undefined;
      const t = vid === undefined ? undefined : view.transform.get(vid);
      if (vid === undefined || !v || !def || !t || v.status === "destroyed" || v.status === "abandoned" || v.crewReaction === "bailOut") continue;
      live.push({ c, vid, v, def, x: t.x, y: t.y, h: t.heading });
    }
    if (live.length === 0) continue;
    // (The carrier pairs share one home: the middle of all the carriers, as when they were one section.)
    const homeOf = carriers === true ? sections.filter((x) => x.carriers === true).flatMap((x) => x.crews).map((c) => { const vid = view.unit.get(c)?.vehicle; return vid === undefined ? undefined : view.transform.get(vid); }).filter((t) => t !== undefined) : live;
    const hk = (mem.tkHome[key] ??= [homeOf.reduce((s, q) => s + q.x, 0) / homeOf.length, homeOf.reduce((s, q) => s + q.y, 0) / homeOf.length]);
    const home = { x: hk[0], y: hk[1] };
    // First look: fire free (the defence out to its tanks' reach, not the infantry's 300 m). Balance pass 2: a
    // defence's carriers too: fire discipline, not their weapons' reach (a BMP-2's Konkurs and a Puma's MELLS reach
    // 4,000 m): opening fire beyond 1,500 m only gives their posts away (measured: without it platoon-vehicles 16 of
    // 20, with it see DECISIONS "Balance pass 2").
    for (const q of live) {
      if (mem.tk[String(q.c)]) continue;
      order(q.c, { kind: "rules", fire: "free", ...(a.defending ? { maxEngageM: T.defenceEngageM } : {}) });
      mem.tk[String(q.c)] = { posts: [], post: 0, stage: "", sent: -1e9, seenHit: q.v.lastHitTick, seenSmoke: q.v.smokeReadyTick, shots: 0, lastShot: q.v.stations[0]?.weapons[0]?.lastShotTick ?? -1e9 };
    }
    // The stage.
    let stage: string;
    if (a.defending) stage = main && !holds(0) ? "counter" : "hold";
    else if (a.phase === "withdraw") stage = "withdraw";
    else if (main && holds(0)) stage = a.objectives.some((_, i) => !holds(i)) ? "second" : "hold";
    else stage = a.phase === "assault" || a.phase === "second" ? "near" : "far";
    // The threat cover now, and the known enemy men.
    const held = a.objectives.filter((_, i) => holds(i));
    const cover = threatCover(ctx, a.ux, a.uy, a.ownFoot, Number.isFinite(front) ? front : live.reduce((m, q) => Math.max(m, q.x * a.ux + q.y * a.uy), -Infinity), enemies, held, tick);
    const threats = [...cover, ...menNow];
    const cx = live.reduce((s, q) => s + q.x, 0) / live.length, cy = live.reduce((s, q) => s + q.y, 0) / live.length;
    // Withdrawal: hold until the carriers are on their way back (or a minute), then back, reversing first.
    if (stage === "withdraw") {
      if (a.remounting > 0 && tick - a.phaseTick < T.withdrawHoldSeconds * 60) continue;
      for (const q of live) {
        const m = mem.tk[String(q.c)]!;
        if (m.back || (q.v.status !== "ok" && q.v.status !== "disarmed")) continue;
        order(q.c, a.back(q.c));
        m.back = true;
      }
      continue;
    }
    // Re-site when the stage changes, or when threat cover has come within the standoff of a post (at most once a minute).
    const tooClose = live.some((q) => { const m = mem.tk![String(q.c)]!, p = m.posts[m.post]; return !m.pulled && p !== undefined && cover.some((c) => hypot2(c.x - p[0], c.y - p[1]) < T.coverStandoffM); });
    const resite = mem.tkSited[key] !== stage || (tooClose && tick - (mem.tkResite[key] ?? -1e9) >= T.resiteSeconds * 60);
    if (resite) {
      const plan = stagePlan(a, stage, home, { x: cx, y: cy });
      if (plan) {
        const lead = live[0]!;
        const { turretZ, hullZ } = heights(lead.def);
        // (Review fix: a carrier pair keeps off the posts the other sections hold or go to.)
        const own = new Set(crews.map(String));
        const avoid = carriers === true ? Object.entries(mem.tk).filter(([c]) => !own.has(c)).flatMap(([, m]) => m.posts.slice(m.post, m.post + 1).map((p) => ({ x: p[0], y: p[1] }))) : [];
        const opts = { cls: lead.def.class, turretZ, hullZ, rangeM: T.rangeM, threats, standoffM: T.coverStandoffM, ...(plan.behind ? { behind: plan.behind } : {}), from: { x: lead.x, y: lead.y }, vegMaxM: T.coverMinHeightM, ...(avoid.length > 0 ? { avoid } : {}) };
        const posts = siteHullDown(ctx, plan.anchor, plan.targets, opts);
        // Balance pass 4 (owner 2026-11-19): a defence's hull that starts the battle on the hull-down post sited for it
        // (placed there at setup, `defenceStartPosts`; `startPosts`) keeps it as its first post, unless its spot is now
        // no post at all (within the standoff of a threat, in a wood): no drive across the enemy's view to another.
        const first = a.defending && stage === "hold" && mem.tkSited[key] === undefined && (a.startPosts?.size ?? 0) > 0;
        const kept = new Map<EntityId, (typeof posts)[number]>();
        if (first) {
          for (const q of live) {
            if (!a.startPosts!.has(q.v.vehicleId)) continue;
            const here = siteHullDown(ctx, plan.anchor, plan.targets, { ...opts, at: { x: q.x, y: q.y } })[0];
            if (here && here.exposed !== true) kept.set(q.c, here);
          }
        }
        // (The posts the others take keep off the spots kept.)
        const free = posts.filter((p) => ![...kept.values()].some((h) => hypot2(p.x - h.x, p.y - h.y) < T.samePostM));
        if (posts.length > 0 || kept.size > 0) {
          let k = 0;
          for (const q of live) {
            const m = mem.tk[String(q.c)]!;
            if (m.pulled) continue;
            // Tank k takes post k; the others follow as its alternates.
            // (Review fix: never a spot another hull keeps; a hull left with no post at all goes to the plan's
            // anchor, facing its targets, as a relocation does, rather than standing idle until the next re-site.)
            let mine = free.length > 0 ? free.map((_, j) => free[(k + j) % free.length]!) : [];
            const here = kept.get(q.c);
            if (here) mine = [here, ...mine];
            m.posts = mine.map((p) => [p.x, p.y, p.facing]);
            if (m.posts.length === 0) {
              const tg = plan.targets.length > 0 ? plan.targets : [{ x: q.x + cos(q.h), y: q.y + sin(q.h) }];
              const tx = tg.reduce((n, p) => n + p.x, 0) / tg.length, ty = tg.reduce((n, p) => n + p.y, 0) / tg.length;
              m.posts = [[plan.anchor.x, plan.anchor.y, atan2(ty - plan.anchor.y, tx - plan.anchor.x)]];
            }
            m.post = 0; m.stage = stage; m.sent = -1e9; m.shots = 0;
            k++;
          }
        }
      }
      if (mem.tkSited[key] === stage) mem.tkResite[key] = tick;
      mem.tkSited[key] = stage;
    }
    // The next post in its list that no other hull of the section holds or goes to (review fix: two hulls rotating
    // through offset lists met on one post); none free: simply the next.
    const nextPost = (c: EntityId, m: TankMem): number => {
      const others = live.filter((o) => o.c !== c).map((o) => mem.tk![String(o.c)]!).filter((o) => o.posts.length > 0).map((o) => o.posts[o.post]!);
      for (let j = 1; j < m.posts.length; j++) {
        const i = (m.post + j) % m.posts.length, p = m.posts[i]!;
        if (!others.some((o) => hypot2(o[0] - p[0], o[1] - p[1]) < T.samePostM)) return i;
      }
      return (m.post + 1) % m.posts.length;
    };
    for (const q of live) {
      const m = mem.tk[String(q.c)]!;
      // Reversing out of danger (the sim's crew reaction): left to it for a while.
      if (q.v.crewReaction === "reverseOut" && tick - q.v.reactionTick < a.reverseHoldSeconds * 60) continue;
      const shot = q.v.stations[0]?.weapons[0]?.lastShotTick ?? -1e9;
      if (shot !== m.lastShot) { m.lastShot = shot; m.shots++; }
      if (q.v.status === "immobilised") continue; // (it only fires)
      if (m.posts.length === 0) continue;
      const facingOf = (p: [number, number, number]) => p[2];
      let relocate = false;
      // (a) a hit that did not get through; (b) its smoke drill; (c) enough rounds from this post.
      if (q.v.lastHitTick > m.seenHit) { m.seenHit = q.v.lastHitTick; relocate = true; }
      if (q.v.smokeReadyTick > m.seenSmoke) { m.seenSmoke = q.v.smokeReadyTick; relocate = true; }
      if (m.shots >= T.shotsPerPost) relocate = true;
      // Pull back (once): gun out or empty, or the front tiles nearly used up, with an anti-tank threat near.
      const launchSeen = q.v.smokeReadyTick >= 0 && tick - q.v.smokeReadyTick <= T.launchSeenSeconds * 60;
      const menNear = menNow.some((e) => hypot2(e.x - q.x, e.y - q.y) <= T.atKnownM);
      if (!m.pulled && (menNear || launchSeen) && (mainGunRounds(view, q.vid, q.v, q.def) <= 0 || q.v.status === "disarmed" || frontTilesLeft(view, q.vid, q.def) < T.eraLowShare)) {
        const plan = stagePlan(a, m.stage || stage, home, { x: cx, y: cy });
        const tx = plan && plan.targets.length > 0 ? plan.targets.reduce((s, p) => s + p.x, 0) / plan.targets.length : q.x + cos(q.h), ty = plan && plan.targets.length > 0 ? plan.targets.reduce((s, p) => s + p.y, 0) / plan.targets.length : q.y + sin(q.h);
        // Straight back from the threat: the nearest enemy man it knows, else the targets.
        const man = menNow.filter((e) => hypot2(e.x - q.x, e.y - q.y) <= T.atKnownM).sort((x, y) => hypot2(x.x - q.x, x.y - q.y) - hypot2(y.x - q.x, y.y - q.y) || x.id - y.id)[0];
        const fx = man ? man.x : tx, fy = man ? man.y : ty;
        const L = Math.max(1, hypot2(fx - q.x, fy - q.y)), bx = q.x - ((fx - q.x) / L) * T.pullBackM, by = q.y - ((fy - q.y) / L) * T.pullBackM;
        const W = ctx.map.widthM, H = ctx.map.heightM;
        const anchor = { x: Math.min(Math.max(bx, 10), W - 10), y: Math.min(Math.max(by, 10), H - 10) };
        const { turretZ, hullZ } = heights(q.def);
        const posts = siteHullDown(ctx, anchor, plan?.targets ?? [{ x: tx, y: ty }], { cls: q.def.class, turretZ, hullZ, rangeM: [T.pullRangeM, T.rangeM[1]], threats, standoffM: T.coverStandoffM, from: { x: q.x, y: q.y }, vegMaxM: T.coverMinHeightM, ringsM: T.pullRingsM });
        m.posts = posts.length > 0 ? posts.map((p) => [p.x, p.y, p.facing]) : [[anchor.x, anchor.y, atan2(ty - anchor.y, tx - anchor.x)]];
        m.post = 0; m.sent = -1e9; m.shots = 0; m.pulled = true;
        relocate = false;
      }
      // (d) an enemy man known within the standoff: the post farthest from him, or straight back from him.
      const close = menNow.filter((e) => hypot2(e.x - q.x, e.y - q.y) <= T.atStandoffM).sort((x, y) => hypot2(x.x - q.x, x.y - q.y) - hypot2(y.x - q.x, y.y - q.y))[0];
      const cur = m.posts[m.post]!;
      if (close && hypot2(close.x - cur[0], close.y - cur[1]) <= T.atStandoffM) {
        let bi = -1, bd: number = T.atStandoffM;
        // (Balance pass 6 verification: never a post another hull of the section holds or goes to, as `nextPost`.)
        const held = live.filter((o) => o.c !== q.c).map((o) => mem.tk![String(o.c)]!).filter((o) => o.posts.length > 0).map((o) => o.posts[o.post]!);
        m.posts.forEach((p, i) => { const d = hypot2(close.x - p[0], close.y - p[1]); if (d > bd && !held.some((o) => hypot2(o[0] - p[0], o[1] - p[1]) < T.samePostM)) { bd = d; bi = i; } });
        if (bi >= 0) m.post = bi;
        else {
          const L = Math.max(1, hypot2(q.x - close.x, q.y - close.y));
          const W = ctx.map.widthM, H = ctx.map.heightM;
          m.posts.push([Math.min(Math.max(q.x + ((q.x - close.x) / L) * T.pullBackM, 10), W - 10), Math.min(Math.max(q.y + ((q.y - close.y) / L) * T.pullBackM, 10), H - 10), atan2(close.y - q.y, close.x - q.x)]);
          m.post = m.posts.length - 1;
        }
        m.sent = -1e9; m.shots = 0;
        relocate = false;
      }
      // Balance pass 5 (F7): (e) an attacker's tank that has fired nothing for `idleRelocateSeconds` on its post (since
      // it got there or last fired) takes its next post: another view over the targets (it sat idle with live enemy
      // hulls out of its sight).
      const onWay = !q.v.drive.arrived && q.v.drive.routeIdx < q.v.drive.route.length;
      if (onWay || m.idleFrom === undefined) m.idleFrom = tick;
      if (!a.defending && !onWay && m.reached && tick - Math.max(m.idleFrom, m.lastShot) >= T.idleRelocateSeconds * 60) { relocate = true; m.idleFrom = tick; }
      if (relocate && m.posts.length > 1) { m.post = nextPost(q.c, m); m.sent = -1e9; m.shots = 0; }
      else if (relocate) m.shots = 0;
      const moving = !q.v.drive.arrived && q.v.drive.routeIdx < q.v.drive.route.length;
      // Review fix: standing short of its post after an order (no route), or its route no `progressM` shorter in
      // `blockedSeconds` (behind a blocking hull, mired): the next post; once every post has failed in a row (re-sitings included), the
      // carriers stop waiting for it (it keeps trying; reaching a post ends it).
      if (m.sent > -1e9) {
        const cp = m.posts[m.post]!, dc = hypot2(cp[0] - q.x, cp[1] - q.y), rt = q.v.drive.route;
        let togo = 0;
        for (let i = q.v.drive.routeIdx, px = q.x, py = q.y; i < rt.length; i++) { togo += hypot2(rt[i]!.x - px, rt[i]!.y - py); px = rt[i]!.x; py = rt[i]!.y; }
        if (m.progTick === undefined || togo < (m.progD ?? Infinity) - T.progressM) { m.progD = togo; m.progTick = tick; }
        const blocked = moving && tick - m.progTick >= T.blockedSeconds * 60;
        if ((!moving || blocked) && tick - m.sent >= T.stuckSeconds * 60 && dc > T.arrivedM) {
          m.failed = (m.failed ?? 0) + 1;
          if (m.failed >= m.posts.length) m.stuck = true;
          if (m.posts.length > 1) { m.post = nextPost(q.c, m); m.shots = 0; }
          m.sent = -1e9;
        }
      }
      if (m.sent <= -1e9 && m.progTick !== undefined) { delete m.progD; delete m.progTick; }
      const sendMove = (body: Record<string, unknown>) => { order(q.c, body); m.sent = tick; delete m.progD; delete m.progTick; };
      const p = m.posts[m.post]!;
      // The front toward the enemy vehicle it knows within its gun's reach, else the post's facing.
      const reach = q.def.stations[0]?.weapons[0]?.engageRangeM ?? 0;
      let veh: { x: number; y: number; tick: number } | null = null;
      for (const mm of view.unit.get(q.c)?.members ?? []) {
        const s = view.soldier.get(mm) as SoldierState | undefined;
        if (!s) continue;
        for (const ct of s.contacts) {
          if (ct.cls !== "vehicle" || ct.wreck === true || ct.kind === "heard" || tick - ct.tick > T.menSeenSeconds * 60) continue;
          if (hypot2(ct.x - p[0], ct.y - p[1]) > reach) continue;
          if (!veh || ct.tick > veh.tick) veh = { x: ct.x, y: ct.y, tick: ct.tick };
        }
      }
      const facing = veh ? atan2(veh.y - p[1], veh.x - p[0]) : facingOf(p);
      const d = hypot2(p[0] - q.x, p[1] - q.y);
      if (d <= T.arrivedM) {
        if (!m.reached) m.reached = true;
        if (m.failed) m.failed = 0;
        if (m.stuck) delete m.stuck;
        // On the post: the front turned toward an enemy vehicle off to a side.
        if (veh && !moving && Math.abs(wrapAngle(facing - q.h)) > (T.turnDeg * PI) / 180 && tick - m.sent >= T.resendSeconds * 60) {
          sendMove({ kind: "move", waypoints: [{ x: p[0], y: p[1], mode: "walk" }], facing });
        }
        continue;
      }
      if (!m.reached && !m.stuck) notReady++;
      if (moving && tick - m.sent < T.resendSeconds * 60) continue;
      // Reversing to a post behind its front (a short way only).
      const ahead = (p[0] - q.x) * cos(q.h) + (p[1] - q.y) * sin(q.h);
      const reverse = ahead < 0 && d <= T.reverseMaxM && Math.abs(wrapAngle(p[2] - q.h)) < PI / 2;
      sendMove({ kind: "move", waypoints: [{ x: p[0], y: p[1], mode: m.reached ? "walk" : "run", ...(reverse ? { reverse: true } : {}) }], facing });
    }
  }
  return notReady;
}

export interface BoundArgs {
  view: SimView; tick: number; side: string; ctx: SimContext; objectives: readonly ObjectiveDef[]; mem: TanksMemory;
  order: (target: EntityId, body: Record<string, unknown>) => void;
  /** The attacker's axis toward its objective (unit vector). */
  ux: number; uy: number;
  /** The objective the attack is after now (its index). */
  target: number;
  /** The carrier crews in overwatch whose squads are out. */
  crews: readonly EntityId[];
  /** Own able men on foot (where they stand). */
  ownFoot: readonly { x: number; y: number }[];
  bound: { idleS: number; stepM: number; behindM: number; minGainM: number; retryS: number };
  reverseHoldSeconds: number;
}

/** The last shot of any of a hull's weapons (ticks). */
function lastShotOf(v: VehicleState): number {
  let t = -1e9;
  for (const st of v.stations) for (const w of st.weapons) if (w.lastShotTick > t) t = w.lastShotTick;
  return t;
}

/** The bound's post search rings (m round the anchor `stepM` ahead): the bound stays about `stepM` long (review fix). */
const BOUND_RINGS_M = [0, 40, 80] as const;

/**
 * Balance pass 3 (owner 2026-11-18, "idle overwatch Pumas move up"): an attacking side's carriers in overwatch after
 * the dismount (`afterDismount` not "follow") that have fired nothing for `idleS` (since they were first seen here,
 * their last shot or their last bound) bound forward: a hull-down post (siting.ts `siteHullDown`, as the tank
 * sections') sited about `stepM` ahead along the axis, over the objective the attack is after and the ground beyond
 * it, at least `minGainM` farther forward than the hull stands, never less than `behindM` behind the side's foremost
 * man on foot, `TANKS.coverStandoffM` off threat cover and known enemy men (`threatCover`), 30 m off the other own
 * hulls and where they go. None found (or the hull is already as far forward as allowed): it tries again after
 * `retryS`. Not a hull that is hit and reversing out, immobilised, moving, out of main-gun rounds, or whose crew
 * knows an enemy vehicle within its gun's reach (it is busy), re-arming or refuelling. Review fixes: the post is no
 * farther from the objective than the hull, at most 1.5 `stepM` away, not nearer a known enemy hull inside that hull's
 * longest reach, and on a route the hull can drive (`planVehicleRoute`); a post it was sent to and never reached is
 * left out while it stands where it stood. Values: core/behaviour.json `mounting.overwatchBound`.
 */
export function overwatchBounds(a: BoundArgs): void {
  const { view, tick, side, ctx, mem, order, ux, uy, bound: B } = a;
  if (a.crews.length === 0 || a.ownFoot.length === 0) return;
  const obj = a.objectives[a.target] ?? a.objectives[0];
  if (!obj) return;
  mem.obBound ??= {};
  const front = a.ownFoot.reduce((m, f) => Math.max(m, f.x * ux + f.y * uy), -Infinity);
  const limit = front - B.behindM;
  const W = ctx.map.widthM, H = ctx.map.heightM;
  let threats: { x: number; y: number }[] | null = null;
  const threatsNow = (): { x: number; y: number }[] => {
    if (threats) return threats;
    const enemies = knownEnemyMen(view, side);
    const held = a.objectives.filter((_, i) => view.objectives[i]?.holder === side);
    threats = [...threatCover(ctx, ux, uy, a.ownFoot, front, enemies, held, tick), ...enemies.filter((e) => tick - e.tick <= TANKS.menSeenSeconds * 60)];
    return threats;
  };
  // Where the side's other hulls stand or go (no post within 30 m of one).
  const others = (self: EntityId): { x: number; y: number }[] => {
    const out: { x: number; y: number }[] = [];
    for (const [vid, v] of view.vehicle.entries()) {
      if (vid === self || v.side !== side || isOffMap(v) || v.status === "destroyed") continue;
      const t = view.transform.get(vid);
      if (t) out.push({ x: t.x, y: t.y });
      const r = v.drive.route, end = r[r.length - 1];
      if (!v.drive.arrived && end) out.push({ x: end.x, y: end.y });
    }
    return out;
  };
  const ring: { x: number; y: number }[] = [{ x: obj.x, y: obj.y }];
  for (let k = 0; k < 8; k++) ring.push({ x: obj.x + cos((k * PI) / 4) * obj.radiusM, y: obj.y + sin((k * PI) / 4) * obj.radiusM });
  for (const s of [-1, -0.5, 0, 0.5, 1]) ring.push({ x: obj.x + ux * TANKS.beyondM - uy * s * TANKS.beyondM * 0.6, y: obj.y + uy * TANKS.beyondM + ux * s * TANKS.beyondM * 0.6 });
  const targets = ring.filter((p) => p.x > 5 && p.y > 5 && p.x < W - 5 && p.y < H - 5);
  for (const c of [...a.crews].sort((x, y) => x - y)) {
    const vid = view.unit.get(c)?.vehicle;
    const v = vid === undefined ? undefined : (view.vehicle.get(vid) as VehicleState | undefined);
    const def = v ? ctx.catalog.vehicles[v.def] : undefined;
    const t = vid === undefined ? undefined : view.transform.get(vid);
    if (vid === undefined || !v || !def || !t) continue;
    const shot = lastShotOf(v);
    const m = (mem.obBound[String(c)] ??= { since: tick, shot, tried: -1e9 });
    if (shot > m.shot) { m.shot = shot; m.since = Math.max(m.since, shot); }
    // (Not while it re-arms or refuels: a move order would break that off, review fix.)
    if (v.status !== "ok" || v.crewReaction === "bailOut" || v.resupply !== undefined) continue;
    if (v.crewReaction === "reverseOut" && tick - v.reactionTick < a.reverseHoldSeconds * 60) continue;
    if (!v.drive.arrived && v.drive.routeIdx < v.drive.route.length) continue;
    if (tick - m.since < B.idleS * 60 || tick - m.tried < B.retryS * 60) continue;
    m.tried = tick;
    const proj = t.x * ux + t.y * uy;
    if (proj + B.minGainM > limit) continue;
    if (mainGunRounds(view, vid, v, def) <= 0) continue;
    // (Busy: its crew knows an enemy vehicle within its gun's reach lately.)
    const reach = def.stations[0]?.weapons[0]?.engageRangeM ?? 0;
    // (Known enemy hulls, each with its longest gun or launcher reach: no post nearer one inside that reach, review fix.)
    let busy = false;
    const armour: { x: number; y: number; reach: number }[] = [];
    for (const mm of view.unit.get(c)?.members ?? []) {
      const s = view.soldier.get(mm) as SoldierState | undefined;
      for (const ct of s?.contacts ?? []) {
        if (ct.cls !== "vehicle" || ct.wreck === true || ct.kind === "heard" || tick - ct.tick > TANKS.menSeenSeconds * 60) continue;
        if (hypot2(ct.x - t.x, ct.y - t.y) <= reach) busy = true;
        const ed = ct.vtype !== undefined ? ctx.catalog.vehicles[ct.vtype] : undefined;
        let r = 0;
        for (const st of ed?.stations ?? []) for (const w of st.weapons) if ((w.engageRangeM ?? 0) > r) r = w.engageRangeM ?? 0;
        armour.push({ x: ct.x, y: ct.y, reach: r });
      }
      if (busy) break;
    }
    if (busy) continue;
    // (A post it was sent to and never reached, standing where it stood then: left out, review fix. Balance pass 4:
    // every such post while it stands there, not only the last: a hull stuck at one spot alternated between two.)
    const failed = m.to !== undefined && m.at !== undefined && hypot2(t.x - m.at.x, t.y - m.at.y) <= 5 ? [...(m.missed ?? []), m.to] : [];
    const step = Math.min(B.stepM, limit - proj);
    const anchor = { x: Math.min(Math.max(t.x + ux * step, 10), W - 10), y: Math.min(Math.max(t.y + uy * step, 10), H - 10) };
    // (The line it must stay behind: `behindM` short of the foremost man, as a `behind` bound facing back.)
    const lx = t.x + ux * (limit - proj), ly = t.y + uy * (limit - proj);
    const { turretZ, hullZ } = heights(def);
    const posts = siteHullDown(ctx, anchor, targets, {
      cls: def.class, turretZ, hullZ, rangeM: TANKS.rangeM, threats: threatsNow(), standoffM: TANKS.coverStandoffM,
      behind: { x: lx, y: ly, ux: -ux, uy: -uy, minM: 0 }, from: { x: t.x, y: t.y }, vegMaxM: TANKS.coverMinHeightM, avoid: [...others(vid), ...failed],
      ringsM: BOUND_RINGS_M,
    });
    // (A bound: forward by minGainM, no farther from the objective, at most 1.5 stepM long, out of known enemy hulls'
    //  reach unless nearer none of them, and a route the hull can drive there; review fixes.)
    const dObj = hypot2(t.x - obj.x, t.y - obj.y);
    const p = posts.find((q) => q.exposed !== true && q.x * ux + q.y * uy >= proj + B.minGainM && hypot2(q.x - obj.x, q.y - obj.y) <= dObj
      && hypot2(q.x - t.x, q.y - t.y) <= 1.5 * B.stepM
      && !armour.some((h) => { const d = hypot2(q.x - h.x, q.y - h.y); return d <= h.reach && d < hypot2(t.x - h.x, t.y - h.y); })
      && planVehicleRoute(ctx, def.class, t.x, t.y, [{ x: q.x, y: q.y, mode: "walk" }]) !== null);
    if (!p) continue;
    order(c, { kind: "move", waypoints: [{ x: p.x, y: p.y, mode: "walk" }], facing: p.facing });
    m.since = tick;
    m.to = { x: p.x, y: p.y };
    m.at = { x: t.x, y: t.y };
    if (failed.length > 0) m.missed = failed; else delete m.missed;
  }
}
