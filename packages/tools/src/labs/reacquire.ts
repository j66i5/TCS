/**
 * RE-ACQUIRE LAB (sight realism, 2026-11-15; DECISIONS "Sight realism: baseline"). Two questions about whole battles,
 * sampled once a second through `runBattle`'s `onTick` (ported from the audit's scratch scripts reacquire/blind.ts and
 * no-engage/diag.ts, diag2.ts):
 *
 * 1. A KNOWN BUT UNSEEN ENEMY. A man is "blind" when he knows a live enemy on foot within 300 m precisely (a seen
 *    contact, at most 20 m off, refreshed within 60 s, not spared) but has seen no enemy man for 3 s or more. He is
 *    "blind and idle" when he also is not moving, not firing, not changing posture and busy with nothing. A blind
 *    episode ends when he sees an enemy again (a re-acquisition), when he forgets, or when he does something.
 *    A squad is "fully blind" when at least one of its men is blind and none sees and none moves or fires, and the
 *    squad is neither moving nor in a drill. For each blind-idle sample the lab also asks whether a peek would have
 *    shown the enemy (kneeling, standing, or a side-step of 2-6 m), and indoors whether another window of the same
 *    house sees him.
 * 2. AN ENEMY IN FRONT, NOT ENGAGED. Exposure: an able man on foot, not panicked, routed or fleeing, with a weapon,
 *    who has seen an enemy man on foot within the last 2 s (a contact that is not spared) within 100 m, within 60
 *    degrees of where he faces, with a clear view (sight visibility at least 0.5). "Not engaged": he has not fired
 *    for more than 5 s. Each such second gets one cause (carrying, care, pinned, rule, moving, drill or ordered
 *    task, other), checked in that order, for the nearest such enemy.
 */
import {
  contactErrorM, eyeHeightM, indoorAt, isAble, navCostAt, navFor, runBattle, secondsToTicks, sight, spared, standZ, TARGET_POINT_M, windowPlaces,
  type EntityId, type SimContext, type SimState,
} from "@tcs/sim";
import { getScenario, loadData } from "../scenarios";

/** Which side attacks in each scenario the lab knows (the other defends). */
const ATTACKER: Record<string, string> = { platoon: "blue", "platoon-ru": "red", "village-occupy": "red", "platoon-vehicles": "blue", "platoon-ru-vehicles": "red" };
/** Battle length by scenario (village-occupy is the audit's 900 s). */
const DEFAULT_SECONDS: Record<string, number> = { platoon: 1200, "platoon-ru": 1200, "village-occupy": 900 };

/** Step 4: an episode spans the man's own looks (posture, a few steps, another window); false: the step 1 definition. */
const PEEK_SPANS = process.env.TCS_REACQUIRE_STEP1 !== "1";
const HZ = 60, LOST_MIN_S = 3, KNOWN_MAX_S = 60, KNOWN_ERR_M = 20, BLIND_RANGE_M = 300, VIS_PEEK = 0.1;
const ENGAGE_RANGE_M = 100, ENGAGE_VIS = 0.5, FRONT_RAD = (60 * Math.PI) / 180, NO_SHOT_S = 5, SEEN_WITHIN_S = 2;

export const NOT_ENGAGED_CAUSES = ["carrying", "care", "pinned", "rule", "moving", "drill or ordered task", "other"] as const;
export type NotEngagedCause = (typeof NOT_ENGAGED_CAUSES)[number];

export interface SideStats {
  manS: number; sightedS: number; blindS: number; blindIdleS: number; blindMovingS: number;
  blindIdlePinned: number; blindIdleIndoor: number; blindIdleProne: number;
  /** Blind-idle samples by what a peek would show: already visible (not yet spotted), kneel, stand, side-step, nothing. */
  peek: { visibleNow: number; kneel: number; stand: number; sidestep: number; none: number };
  /** Indoor blind-idle samples where another window of the same house sees the enemy. */
  indoorOtherWindow: number;
  /** Ended episodes (s) and how each ended. */
  episodes: number[]; endBy: Record<string, number>;
  /** Ended episodes during which the enemy stayed within 10 m of where he was known. */
  stayEpisodes: number[];
  squadS: number; squadBlindS: number; squadEpisodes: number[];
  /** "Not engaged": exposure man-s, not-engaged man-s by cause. */
  exposureS: number; notEngaged: Record<NotEngagedCause, number>;
  /** Sighting census (step 3): ranges (m) of new sightings by this side's men on foot of enemy men lying still in the
   *  open (prone, slower than 0.2 m/s, no shot for 2 s, no vegetation in his cell, not in a house). */
  proneOpenSightingsM: number[];
  /** Step 4: man-s standing up to look / moving aside to look (sampled), and men who went down within 2 s of it. */
  peekStandS: number; peekMoveS: number; downPeekStand: number; downPeekMove: number;
}
export interface BattleStats { scenario: string; seed: number; seconds: number; end: string; attack: SideStats; defence: SideStats }

function newSide(): SideStats {
  return {
    manS: 0, sightedS: 0, blindS: 0, blindIdleS: 0, blindMovingS: 0, blindIdlePinned: 0, blindIdleIndoor: 0, blindIdleProne: 0,
    peek: { visibleNow: 0, kneel: 0, stand: 0, sidestep: 0, none: 0 }, indoorOtherWindow: 0, episodes: [], endBy: {}, stayEpisodes: [],
    squadS: 0, squadBlindS: 0, squadEpisodes: [], exposureS: 0, proneOpenSightingsM: [], peekStandS: 0, peekMoveS: 0, downPeekStand: 0, downPeekMove: 0,
    notEngaged: { carrying: 0, care: 0, pinned: 0, rule: 0, moving: 0, "drill or ordered task": 0, other: 0 },
  };
}

function vis(ctx: SimContext, x: number, y: number, ground: number, eye: number, tx: number, ty: number, tz: number, a: number, b: number): number {
  const r = sight(ctx, x, y, ground + eye, tx, ty, tz, a, b);
  return r.blockedBy !== null ? 0 : r.visibility;
}

function squadOf(st: SimState, u: EntityId): EntityId {
  let cur = u;
  for (;;) {
    const un = st.unit.get(cur);
    if (!un) return u;
    if (un.echelon === "squad" || un.parent === null) return cur;
    const p = st.unit.get(un.parent);
    if (!p || p.echelon === "platoon" || p.echelon === "company") return cur;
    cur = un.parent;
  }
}

function topUnit(st: SimState, u: EntityId) {
  let x = st.unit.get(u);
  while (x && x.parent !== null) { const p = st.unit.get(x.parent); if (!p) break; x = p; }
  return x;
}

function inDrill(st: SimState, u: EntityId): boolean {
  for (let x: EntityId | null = u; x !== null; x = st.unit.get(x)?.parent ?? null) { const d = st.unit.get(x)?.drill; if (d && d.kind !== "rout") return true; }
  return false;
}

/** May he open fire on his own (the sim's rule check in decisions.ts, repeated here)? */
function ruleAllows(ctx: SimContext, st: SimState, unitId: EntityId): boolean {
  const unit = st.unit.get(unitId), top = topUnit(st, unitId);
  if (!unit || !top) return true;
  if (unit.fireRule === "hold") return false;
  const fired = top.underFireTick > top.ceaseFireTick;
  if (top.ceaseFireTick > -1e9 && !fired) return false;
  if (unit.fireRule === "free") return true;
  return fired && st.tick - top.underFireTick <= secondsToTicks(ctx.catalog.behaviour.decisions.underFireMemorySeconds);
}

function angleOff(h: number, b: number): number {
  let d = (b - h) % (2 * Math.PI);
  if (d < 0) d += 2 * Math.PI;
  return d > Math.PI ? 2 * Math.PI - d : d;
}

export function reacquireBattle(scenario: string, seed: number, seconds: number): BattleStats {
  const sc = getScenario(scenario);
  const data = loadData(sc.fixtures ?? false);
  const input = sc.build(data, seed, seconds);
  const attacker = ATTACKER[scenario] ?? "blue";
  const stats = { attack: newSide(), defence: newSide() };
  const men = new Map<EntityId, { prev?: { x: number; y: number; p: string }; run: number; stay: boolean; looked?: boolean; peekAt?: number; peekKind?: "stand" | "move" }>();
  const squadRun = new Map<EntityId, number>(), squadSide = new Map<EntityId, "attack" | "defence">();
  const spotted: { observer: EntityId; target: EntityId; rangeM: number }[] = [];
  const res = runBattle(input, {
    controllers: sc.controllers?.(input) ?? [],
    onEvents: (evs) => { for (const e of evs) if (e.kind === "spotted" && e.drone !== true) spotted.push({ observer: e.observer, target: e.target, rangeM: e.rangeM }); },
    onTick: (sim) => {
      const st = sim.state, ctx = sim.ctx;
      // ---- 3. sighting census (every tick: the events of this tick)
      for (const e of spotted) {
        const os = st.soldier.get(e.observer), ts = st.soldier.get(e.target), oi = st.identity.get(e.observer), tt = st.transform.get(e.target);
        if (!os || !ts || !oi || !tt || os.mount !== undefined || ts.posture !== "prone") continue;
        if ((st.mover.get(e.target)?.speedMps ?? 0) > 0.2 || st.tick - (st.weapon.get(e.target)?.lastShotTick ?? -1e9) <= 2 * HZ) continue;
        const m = ctx.map, cell = Math.floor(tt.y / m.cellSizeM) * m.cols + Math.floor(tt.x / m.cellSizeM);
        if ((m.vegetation[cell] ?? 0) !== 0 || indoorAt(ctx, tt.x, tt.y) >= 0) continue;
        stats[oi.side === attacker ? "attack" : "defence"].proneOpenSightingsM.push(e.rangeM);
      }
      spotted.length = 0;
      if (st.tick % HZ !== 0) return;
      const grid = navFor(ctx, "foot").grid;
      const squads = new Map<EntityId, { side: "attack" | "defence"; anyLost: boolean; anySees: boolean; anyAct: boolean }>();
      for (const [id, s] of st.soldier.entries()) {
        const idn = st.identity.get(id);
        if (!idn) continue;
        const A = stats[idn.side === attacker ? "attack" : "defence"];
        const t = st.transform.req(id);
        // ---- 2. an enemy in front, not engaged
        const panicked = s.mental.behaviour === "panicked" || s.mental.behaviour === "routed" || s.mental.flee !== null;
        const w = st.weapon.get(id);
        if (isAble(s) && s.mount === undefined && s.casualty === "none" && !panicked && w) {
          let best: EntityId = -1, bd = Infinity;
          for (const e of s.seen) {
            if (st.tick - e.lastTick > SEEN_WITHIN_S * HZ) continue;
            const es = st.soldier.get(e.target);
            if (!es || !isAble(es) || es.mount !== undefined || es.casualty !== "none") continue;
            const c = s.contacts.find((k) => k.target === e.target);
            if (!c || spared(c)) continue;
            const et = st.transform.req(e.target);
            const d = Math.hypot(et.x - t.x, et.y - t.y);
            if (d > ENGAGE_RANGE_M || d >= bd) continue;
            if (angleOff(t.heading, Math.atan2(et.y - t.y, et.x - t.x)) > FRONT_RAD) continue;
            const v = vis(ctx, t.x, t.y, standZ(ctx.map, t), eyeHeightM(ctx, s.posture), et.x, et.y, standZ(ctx.map, et) + TARGET_POINT_M[es.posture], id, e.target);
            if (v < ENGAGE_VIS) continue;
            best = e.target; bd = d;
          }
          if (best >= 0) {
            A.exposureS++;
            if (st.tick - w.lastShotTick > NO_SHOT_S * HZ) {
              const m = st.mover.get(id), ft = st.fire.get(id);
              const cause: NotEngagedCause = s.carrying !== undefined ? "carrying"
                : s.intent?.kind === "care" ? "care"
                  : s.mental.behaviour === "pinned" ? "pinned"
                    : !ruleAllows(ctx, st, idn.unit) ? "rule"
                      : m !== undefined && m.waypoints.length > 0 ? "moving"
                        : inDrill(st, idn.unit) || (ft !== undefined && !ft.self && ft.contact !== best) ? "drill or ordered task"
                          : "other";
              A.notEngaged[cause]++;
            }
          }
        }
        // ---- 1. a known but unseen enemy
        // (Step 4: a man who went down within 2 s of standing up or stepping aside to look.)
        const r0 = men.get(id);
        if (!isAble(s) && r0 !== undefined && st.tick - (r0.peekAt ?? -1e9) <= 2 * HZ) { if (r0.peekKind === "stand") A.downPeekStand++; else A.downPeekMove++; }
        if (!isAble(s) || s.mount !== undefined || s.mental.behaviour === "routed" || s.mental.flee !== null || s.carrying !== undefined) { men.delete(id); continue; }
        if (s.peekUntilTick !== undefined && s.peekUntilTick > st.tick) { A.peekStandS++; const r1 = men.get(id) ?? { run: 0, stay: true }; r1.peekAt = st.tick; r1.peekKind = "stand"; men.set(id, r1); }
        else if ((s.peekHome !== undefined || st.tick - (s.windowSwitchTick ?? -1e9) <= 10 * HZ) && (st.mover.get(id)?.waypoints.length ?? 0) > 0) { A.peekMoveS++; const r1 = men.get(id) ?? { run: 0, stay: true }; r1.peekAt = st.tick; r1.peekKind = "move"; men.set(id, r1); }
        A.manS++;
        let lastSelf = -1e9;
        for (const e of s.seen) if (st.soldier.has(e.target) && e.lastTick > lastSelf) lastSelf = e.lastTick;
        const sees = st.tick - lastSelf <= SEEN_WITHIN_S * HZ;
        let lost: (typeof s.contacts)[number] | null = null, ld = Infinity;
        for (const c of s.contacts) {
          if (spared(c) || c.cls === "vehicle" || !st.soldier.has(c.target)) continue;
          const es = st.soldier.get(c.target)!;
          if (!isAble(es) || es.mount !== undefined) continue;
          if ((st.tick - c.tick) / HZ > KNOWN_MAX_S || c.kind === "heard" || contactErrorM(ctx, c, st.tick) > KNOWN_ERR_M) continue;
          const d = Math.hypot(c.x - t.x, c.y - t.y);
          if (d <= BLIND_RANGE_M && d < ld) { ld = d; lost = c; }
        }
        const sq = squadOf(st, idn.unit);
        let si = squads.get(sq);
        if (!si) { si = { side: idn.side === attacker ? "attack" : "defence", anyLost: false, anySees: false, anyAct: false }; squads.set(sq, si); }
        const m = st.mover.get(id), moving = m !== undefined && m.waypoints.length > 0, firing = st.fire.has(id);
        if (sees) { A.sightedS++; si.anySees = true; }
        if (moving || firing) si.anyAct = true;
        let rec = men.get(id);
        if (!rec) { rec = { run: 0, stay: true }; men.set(id, rec); }
        const changedPosture = rec.prev !== undefined && rec.prev.p !== s.posture;
        const stepped = rec.prev !== undefined && Math.hypot(rec.prev.x - t.x, rec.prev.y - t.y) > 0.3;
        rec.prev = { x: t.x, y: t.y, p: s.posture };
        const end = (how: string) => {
          if (rec!.run > 0) { A.episodes.push(rec!.run); A.endBy[how] = (A.endBy[how] ?? 0) + 1; if (rec!.stay) A.stayEpisodes.push(rec!.run); }
          rec!.run = 0; rec!.stay = true; rec!.looked = false;
        };
        if (!sees && lost && st.tick - lastSelf < LOST_MIN_S * HZ) lost = null;
        if (sees || !lost) { end(sees ? "seen again" : "forgot"); continue; }
        si.anyLost = true;
        A.blindS++;
        // (Step 4: his own look — a change of posture, a few steps aside, a move to another window — is part of the
        // episode, which goes on until he sees the enemy again, forgets him, fires or his unit moves.)
        if (moving || stepped) {
          A.blindMovingS++;
          const unitMoved = st.unit.get(idn.unit)?.moving || st.unit.get(sq)?.moving || st.unit.get(sq)?.drill;
          if (unitMoved || !PEEK_SPANS) end(unitMoved ? "unit moved" : "own move"); else { rec.run++; rec.looked = true; }
          continue;
        }
        if (firing || st.action.has(id) || s.evade !== null) { end(firing ? "fired" : "other"); continue; }
        if (changedPosture || s.postureTo !== null) { if (PEEK_SPANS) { rec.run++; rec.looked = true; } else end("posture"); continue; }
        // blind and idle
        rec.run++;
        A.blindIdleS++;
        const et = st.transform.req(lost.target), es = st.soldier.get(lost.target)!;
        if (Math.hypot(et.x - lost.x, et.y - lost.y) > 10) rec.stay = false;
        if (s.mental.suppression >= 0.1) A.blindIdlePinned++;
        const indoor = t.z > 0 || indoorAt(ctx, t.x, t.y) >= 0;
        if (indoor) A.blindIdleIndoor++;
        if (s.posture === "prone") A.blindIdleProne++;
        const tz = standZ(ctx.map, et) + TARGET_POINT_M[es.posture], g = standZ(ctx.map, t);
        const v0 = vis(ctx, t.x, t.y, g, eyeHeightM(ctx, s.posture), et.x, et.y, tz, id, lost.target);
        const vk = vis(ctx, t.x, t.y, g, eyeHeightM(ctx, "crouching"), et.x, et.y, tz, id, lost.target);
        const vs = vis(ctx, t.x, t.y, g, eyeHeightM(ctx, "standing"), et.x, et.y, tz, id, lost.target);
        let vside = 0;
        if (!indoor) {
          const L = Math.hypot(et.x - t.x, et.y - t.y) || 1, px = -(et.y - t.y) / L, py = (et.x - t.x) / L;
          for (const off of [2, -2, 4, -4, 6, -6]) {
            const x = t.x + px * off, y = t.y + py * off;
            if (navCostAt(grid, x, y) <= 0 || indoorAt(ctx, x, y) >= 0) continue;
            for (const p of ["prone", "crouching"] as const) vside = Math.max(vside, vis(ctx, x, y, standZ(ctx.map, { x, y, z: 0 }), eyeHeightM(ctx, p), et.x, et.y, tz, id, lost.target));
          }
        } else {
          const bi = indoorAt(ctx, t.x, t.y);
          if (bi >= 0 && windowPlaces(ctx, bi).some((wp) => vis(ctx, wp.x, wp.y, standZ(ctx.map, { x: wp.x, y: wp.y, z: wp.z }), eyeHeightM(ctx, wp.posture), et.x, et.y, tz, id, lost!.target) >= VIS_PEEK)) A.indoorOtherWindow++;
        }
        if (v0 >= VIS_PEEK) A.peek.visibleNow++;
        else if (vk >= VIS_PEEK) A.peek.kneel++;
        else if (vs >= VIS_PEEK) A.peek.stand++;
        else if (vside >= VIS_PEEK) A.peek.sidestep++;
        else A.peek.none++;
      }
      for (const [sq, si] of squads) {
        const A = stats[si.side];
        squadSide.set(sq, si.side);
        A.squadS++;
        const blind = si.anyLost && !si.anySees && !si.anyAct && !st.unit.get(sq)?.moving && !st.unit.get(sq)?.drill;
        const r = squadRun.get(sq) ?? 0;
        if (blind) { A.squadBlindS++; squadRun.set(sq, r + 1); } else { if (r > 0) A.squadEpisodes.push(r); squadRun.set(sq, 0); }
      }
    },
  });
  // A fully blind squad episode still open at the end counts too.
  for (const [sq, r] of squadRun) if (r > 0) stats[squadSide.get(sq) ?? "attack"].squadEpisodes.push(r);
  return { scenario, seed, seconds, end: `${res.endReason} at ${res.durationSeconds.toFixed(0)} s`, ...stats };
}

export interface ReacquireOptions { scenarios: string[]; seeds: number[]; seconds?: number }

/** `[n] [--seeds 1,2,3|1-3] [--scenarios a,b] [--seconds s]`. */
export function reacquireOptions(argv: readonly string[]): ReacquireOptions {
  const o: ReacquireOptions = { scenarios: ["platoon", "platoon-ru", "village-occupy"], seeds: [1, 2, 3] };
  const seedList = (v: string) => {
    const m = /^(\d+)-(\d+)$/.exec(v);
    if (m) { const a = Number(m[1]), b = Number(m[2]); return Array.from({ length: b - a + 1 }, (_, i) => a + i); }
    return v.split(",").map(Number);
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--seeds") o.seeds = seedList(argv[++i] ?? "1");
    else if (a === "--scenarios") o.scenarios = (argv[++i] ?? "").split(",").filter((x) => x);
    else if (a === "--seconds") o.seconds = Number(argv[++i]);
    else if (/^\d+$/.test(a)) o.seeds = Array.from({ length: Number(a) }, (_, k) => k + 1);
  }
  return o;
}

export function reacquireLab(o: ReacquireOptions): BattleStats[] {
  const out: BattleStats[] = [];
  for (const scenario of o.scenarios) for (const seed of o.seeds) out.push(reacquireBattle(scenario, seed, o.seconds ?? DEFAULT_SECONDS[scenario] ?? 1200));
  return out;
}

/** The sum of several sides' stats. */
export function sumSides(ss: readonly SideStats[]): SideStats {
  const t = newSide();
  for (const s of ss) {
    t.manS += s.manS; t.sightedS += s.sightedS; t.blindS += s.blindS; t.blindIdleS += s.blindIdleS; t.blindMovingS += s.blindMovingS;
    t.blindIdlePinned += s.blindIdlePinned; t.blindIdleIndoor += s.blindIdleIndoor; t.blindIdleProne += s.blindIdleProne;
    for (const k of Object.keys(t.peek) as (keyof SideStats["peek"])[]) t.peek[k] += s.peek[k];
    t.indoorOtherWindow += s.indoorOtherWindow;
    t.episodes.push(...s.episodes); t.stayEpisodes.push(...s.stayEpisodes);
    for (const [k, v] of Object.entries(s.endBy)) t.endBy[k] = (t.endBy[k] ?? 0) + v;
    t.squadS += s.squadS; t.squadBlindS += s.squadBlindS; t.squadEpisodes.push(...s.squadEpisodes);
    t.exposureS += s.exposureS;
    for (const k of NOT_ENGAGED_CAUSES) t.notEngaged[k] += s.notEngaged[k];
    t.proneOpenSightingsM.push(...s.proneOpenSightingsM);
    t.peekStandS += s.peekStandS; t.peekMoveS += s.peekMoveS; t.downPeekStand += s.downPeekStand; t.downPeekMove += s.downPeekMove;
  }
  return t;
}

const q = (arr: readonly number[], f: number) => { if (arr.length === 0) return 0; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * f))]!; };
export const reacquisitionRate = (s: SideStats) => (s.episodes.length > 0 ? (s.endBy["seen again"] ?? 0) / s.episodes.length : 0);
export const notEngagedS = (s: SideStats) => NOT_ENGAGED_CAUSES.reduce((a, k) => a + s.notEngaged[k], 0);

export function reacquireLabMarkdown(rows: BattleStats[]): string {
  const pct = (a: number, b: number) => (b > 0 ? `${((100 * a) / b).toFixed(1)} %` : "–");
  const scenarios = [...new Set(rows.map((r) => r.scenario))];
  const out = [
    "Sampled once a second. Blind: a precisely known live enemy man within 300 m (seen contact, at most 20 m off, refreshed within 60 s) but no enemy man seen for 3 s or more; blind and idle: also not moving, firing or changing posture. Not engaged: a seen, unspared enemy man within 100 m, within 60 degrees of his facing, in clear view (visibility 0.5 or more), and no shot for more than 5 s.",
    "",
    "### Battles",
    "",
    "| scenario | seed | end |",
    "|---|---:|---|",
    ...rows.map((r) => `| ${r.scenario} | ${r.seed} | ${r.end} |`),
    "",
    "### Known but unseen enemy",
    "",
    "| scenario | side | man-s | sighted man-s | blind-idle man-s | blind-idle / sighted | blind-idle share of man-time | re-acquisition | episodes | median s | p90 s | median s, enemy stayed within 10 m | fully blind squad-time | longest fully blind squad s | squad episodes over 30 s |",
    "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
  ];
  const sideRow = (label: string, side: "attack" | "defence", s: SideStats, battles: number) => {
    out.push(`| ${label} | ${side} | ${s.manS} | ${s.sightedS} | ${s.blindIdleS} | ${s.sightedS > 0 ? (s.blindIdleS / s.sightedS).toFixed(2) : "–"} | ${pct(s.blindIdleS, s.manS)} | ${pct(s.endBy["seen again"] ?? 0, s.episodes.length)} | ${s.episodes.length} | ${q(s.episodes, 0.5)} | ${q(s.episodes, 0.9)} | ${s.stayEpisodes.length > 0 ? q(s.stayEpisodes, 0.5) : "–"} | ${pct(s.squadBlindS, s.squadS)} | ${s.squadEpisodes.length > 0 ? Math.max(...s.squadEpisodes) : 0} | ${s.squadEpisodes.filter((e) => e > 30).length} (${(s.squadEpisodes.filter((e) => e > 30).length / battles).toFixed(1)} per battle) |`);
  };
  for (const sc of scenarios) {
    const rs = rows.filter((r) => r.scenario === sc);
    for (const side of ["defence", "attack"] as const) sideRow(`${sc} s${rs.map((r) => r.seed).join(",")}`, side, sumSides(rs.map((r) => r[side])), rs.length);
  }
  out.push("", "### Blind and idle: where, and would a peek help?", "",
    "| scenario | side | blind-idle man-s | prone | under fire (suppression 0.1+) | indoors | indoors, another window sees | visible now, not yet spotted | kneel shows him | stand shows him | side-step of 2-6 m shows him | fixable by a peek of 6 m or less | nothing near shows him | episodes ended by |",
    "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|");
  for (const sc of scenarios) {
    const rs = rows.filter((r) => r.scenario === sc);
    for (const side of ["defence", "attack"] as const) {
      const s = sumSides(rs.map((r) => r[side])), p = s.peek;
      const ends = Object.entries(s.endBy).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(", ");
      out.push(`| ${sc} | ${side} | ${s.blindIdleS} | ${s.blindIdleProne} | ${s.blindIdlePinned} | ${s.blindIdleIndoor} | ${s.indoorOtherWindow} (${pct(s.indoorOtherWindow, s.blindIdleIndoor)}) | ${p.visibleNow} | ${p.kneel} | ${p.stand} | ${p.sidestep} | ${p.kneel + p.stand + p.sidestep} (${pct(p.kneel + p.stand + p.sidestep, s.blindIdleS)}) | ${p.none} | ${ends} |`);
    }
  }
  out.push("", "### Enemy in front, not engaged", "",
    `| scenario | side | exposure man-s | not engaged man-s | share | ${NOT_ENGAGED_CAUSES.join(" | ")} |`,
    `|---|---|---:|---:|---:|${NOT_ENGAGED_CAUSES.map(() => "---:").join("|")}|`);
  const neRow = (label: string, side: string, s: SideStats) => out.push(`| ${label} | ${side} | ${s.exposureS} | ${notEngagedS(s)} | ${pct(notEngagedS(s), s.exposureS)} | ${NOT_ENGAGED_CAUSES.map((k) => s.notEngaged[k]).join(" | ")} |`);
  for (const sc of scenarios) {
    const rs = rows.filter((r) => r.scenario === sc);
    for (const side of ["defence", "attack"] as const) neRow(sc, side, sumSides(rs.map((r) => r[side])));
  }
  neRow("all", "both", sumSides(rows.flatMap((r) => [r.attack, r.defence])));
  out.push("", "### Sighting census", "", "New sightings by men on foot of enemy men lying still in the open (prone, slower than 0.2 m/s, no shot for 2 s, no vegetation in his cell, not in a house).", "",
    "| scenario | side | sightings | median range m | p25 m | p75 m |", "|---|---|---:|---:|---:|---:|");
  const csRow = (label: string, side: string, s: SideStats) => out.push(`| ${label} | ${side} | ${s.proneOpenSightingsM.length} | ${q(s.proneOpenSightingsM, 0.5).toFixed(0)} | ${q(s.proneOpenSightingsM, 0.25).toFixed(0)} | ${q(s.proneOpenSightingsM, 0.75).toFixed(0)} |`);
  for (const sc of scenarios) {
    const rs = rows.filter((r) => r.scenario === sc);
    for (const side of ["defence", "attack"] as const) csRow(sc, side, sumSides(rs.map((r) => r[side])));
  }
  csRow("all", "both", sumSides(rows.flatMap((r) => [r.attack, r.defence])));
  out.push("", "### Looking for a lost enemy (step 4)", "", "Sampled man-s standing up to look and moving aside (or to another window) to look, and men who went down (killed, or unable to fight) within 2 s of either.", "",
    "| scenario | side | standing to look man-s | down while standing to look | moving to look man-s | down while moving to look |", "|---|---|---:|---:|---:|---:|");
  for (const sc of scenarios) {
    const rs = rows.filter((r) => r.scenario === sc);
    for (const side of ["defence", "attack"] as const) { const t = sumSides(rs.map((r) => r[side])); out.push(`| ${sc} | ${side} | ${t.peekStandS} | ${t.downPeekStand} | ${t.peekMoveS} | ${t.downPeekMove} |`); }
  }
  return out.join("\n");
}
