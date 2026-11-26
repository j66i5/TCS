/**
 * Mounted-assault lab (balance pass 5, owner 2026-11-20): the mounted platoon battles with the attacker's platoons
 * given the player's Assault on the main objective while they still ride (mode "player"; the defender's commander as
 * usual), and the same battles AI against AI (mode "ai": the commander's own ride, dismount and support posts).
 * Per battle: where each carrier let its squads out (distance to the objective), how many got out early, men hit
 * while aboard, the support posts (distance to the objective; how far the hull fell back after the dismount), rounds
 * the hulls fired from them, hits by the attacker's hulls on its own men (must be 0), and whether the objective fell.
 */
import { commanderController, rideStats } from "@tcs/ai";
import { buildScenario, mountedTanks, startRulesFor } from "@tcs/scenario";
import { builtUpAround, createSim, dismountDistance, hypot2, isBuiltUp, step, submitOrder, type BattleInput, type Controller, type EntityId, type SimEvent } from "@tcs/sim";
import { getScenario, ON_POSTS } from "../scenarios";
import type { DataSet } from "@tcs/data";
type LoadedData = DataSet;

export interface MountedAssaultRow {
  scenario: string; mode: "player" | "ai"; seed: number; attacker: string; doctrineM: number;
  /** The map kind and whether the objective counts as built-up (buildings within the urban radius). */
  map: string; urban: boolean; buildings: number;
  carriers: number; dismountM: number[]; early: number; hitAboard: number; posts: number; postM: number[]; fellBackM: number[];
  rounds: number; ownHits: number; taken: boolean; takenS: number | null;
  /** Player mode: why each carrier let its squads out (`assault.dismounted` reason), counts. */
  reasons: Record<string, number>;
  /** Player mode, dismounts on known enemy men: the nearest such contact's distance to the hull and to the objective,
   *  and whether a crewman saw it (else reported). */
  threats: { hullM: number; objM: number; seen: boolean }[];
  /** Player mode, dismounts on a hit: the ammunition of the last enemy hit on an attacker's hull before it. */
  hitBy: Record<string, number>;
  /** Review fixes: the share of the objective's points each post sees (0: a follow point seeing nothing); carriers
   *  that made for cover before letting their squads out. */
  postSeen: number[]; covers: number;
  /** Balance pass 6 (carrier stall). Carriers with men aboard at the start; AI mode, from the commander's own tally
   *  (`rideStats`): how far from its dismount point each carrier stood when it let its squad out, the times carriers
   *  were sent on again after a drive that gave up, and the support posts ordered / reached / sited again / given up.
   *  Both modes: the carriers' drives that gave up (`move.noRoute`; on the ride, to a post or on a bound), by cause, and the metres they had left. */
  started: number; pointM: number[]; rideRetries: number;
  postTally: { ordered: number; reached: number; resited: number; failed: number } | null;
  noRoute: Record<string, number>; noRouteLeftM: number[];
  /** Review step 5 (the player's start rule by role): the fire rule the attacker's units started with ("default": the
   *  catalog's, no `ForceInput.start`), the area-fire bursts of the attacker's hulls (`vehicle.areaFire`) and the
   *  attacker's men down. */
  fire: string; areaBursts: number; attackerDown: number;
}

/** The scenario's attacking side: the one not holding the main objective's ground at the start (its defender stands
 *  nearer the objective). */
function attackerOf(input: BattleInput): string {
  const obj = input.rules.objectives[0]!;
  let best = "", bestD = -1;
  for (const f of input.forces) {
    const ps = f.vehiclePlacements ?? [];
    const d = ps.length > 0 ? ps.reduce((s, p) => s + hypot2(p.x - obj.x, p.y - obj.y), 0) / ps.length : 0;
    if (d > bestD) { bestD = d; best = f.side; }
  }
  return best;
}

/** The scenario's battle, or (scenario "platoon-vehicles@farmland" etc.) the same mounted platoon battle on another
 *  map kind: the open-ground and village rows for both attackers. */
function buildBattle(data: LoadedData, scenario: string, seed: number, seconds: number): BattleInput {
  const [name, mapKind] = scenario.split("@");
  if (mapKind === undefined) return getScenario(name!).build(data, seed, seconds);
  const attacker = name === "platoon-ru-vehicles" ? "red" : "blue";
  return buildScenario(data, { kind: "platoon-attack", seed, mapKind: mapKind as "village" | "farmland" | "woodland" | "industrial", factions: ["de", "ru"], attacker, timeLimitSeconds: seconds, vehicles: true, missileTeams: true, ...mountedTanks(data, ["de", "ru"], attacker) }, ON_POSTS);
}

/** `fire` (review step 5, player mode): "role": the attacker's units start with the rule the app gives the player by
 *  his role (`startRulesFor`: At will when attacking); "return" / "free": that rule; absent: no start rules, the
 *  catalog's default (every row before review step 5). */
export function mountedAssaultBattle(data: LoadedData, scenario: string, mode: "player" | "ai", seed: number, seconds: number, fire?: "role" | "return" | "free"): MountedAssaultRow {
  const input = buildBattle(data, scenario, seed, seconds);
  const atk0 = attackerOf(input);
  if (mode === "player" && fire !== undefined) {
    const f = input.forces.find((x) => x.side === atk0)!;
    const st = fire === "role" ? startRulesFor(f) : { fire };
    if (st) f.start = st;
  }
  const fireShown = input.forces.find((x) => x.side === atk0)!.start?.fire ?? "default";
  const sim = createSim(input);
  const atk = atk0, def = input.forces.find((f) => f.side !== atk)!.side;
  const obj = input.rules.objectives[0]!;
  const faction = input.forces.find((f) => f.side === atk)!.faction;
  const ctx = { map: input.map, catalog: input.catalog } as Parameters<typeof isBuiltUp>[0];
  const urban = isBuiltUp(ctx, obj.x, obj.y);
  // (Review fix H3: the distance in force with the way in, from the attacker's hulls to the objective: a village's edge.)
  const vp = input.forces.find((f) => f.side === atk)!.vehiclePlacements ?? [];
  const cx = vp.length > 0 ? vp.reduce((a, p) => a + p.x, 0) / vp.length : obj.x - 1, cy = vp.length > 0 ? vp.reduce((a, p) => a + p.y, 0) / vp.length : obj.y;
  const L = hypot2(obj.x - cx, obj.y - cy) || 1;
  const doctrineM = Math.round(dismountDistance(ctx, faction, obj.x, obj.y, undefined, { ux: (obj.x - cx) / L, uy: (obj.y - cy) / L }).dismountM);
  const buildings = builtUpAround(ctx, obj.x, obj.y, input.catalog.behaviour.mounting.mountedAssault?.urban?.radiusM ?? 120).buildings;
  const ctrls: Controller[] = mode === "ai" ? [commanderController(atk, input), commanderController(def, input)] : [commanderController(def, input)];
  if (mode === "player") {
    for (const [id, u] of sim.state.unit.entries()) {
      if (u.side !== atk || u.parent !== null || u.asset !== undefined || u.missileTeam !== undefined || u.mortar !== undefined) continue;
      submitOrder(sim, { tick: 0, issuer: atk, target: id, kind: "assault", x: obj.x, y: obj.y } as never);
    }
  }
  const row: MountedAssaultRow = { scenario, mode, seed, attacker: atk, doctrineM, map: input.map.meta.kind, urban, buildings, carriers: 0, dismountM: [], early: 0, hitAboard: 0, posts: 0, postM: [], fellBackM: [], rounds: 0, ownHits: 0, taken: false, takenS: null, reasons: {}, threats: [], hitBy: {}, postSeen: [], covers: 0, started: 0, pointM: [], rideRetries: 0, postTally: null, noRoute: {}, noRouteLeftM: [], fire: fireShown, areaBursts: 0, attackerDown: 0 };
  const carrierVids = new Set<EntityId>();
  for (const [, u] of sim.state.unit.entries()) if (u.side === atk && u.carrier !== undefined) carrierVids.add(u.carrier);
  row.started = carrierVids.size;
  const supporting = new Set<EntityId>();
  const watch: { vid: EntityId; tick: number; d0: number }[] = [];
  const hulls = new Set<EntityId>();
  for (const [vid, v] of sim.state.vehicle.entries()) if (v.side === atk) hulls.add(vid);
  const crewOf = (id: EntityId): boolean => { const u = sim.state.identity.get(id)?.unit; return u !== undefined && sim.state.unit.get(u)?.vehicle !== undefined; };
  const seenVid = new Set<EntityId>();
  const end = seconds * 60;
  let lastHit: { tick: number; ammo: string; vid: EntityId } | null = null;
  while (sim.state.tick < end && !sim.state.ended) {
    for (const c of ctrls) for (const o of c.think(sim.state, sim.state.tick)) submitOrder(sim, o);
    const aboard = new Map<EntityId, boolean>();
    for (const [id, s] of sim.state.soldier.entries()) if (s.mount !== undefined) aboard.set(id, true);
    const ev: SimEvent[] = step(sim);
    for (const e of ev) if (e.kind === "vehicle.hit" && hulls.has(e.vehicle) && sim.state.identity.get(e.owner)?.side !== atk) lastHit = { tick: e.tick, ammo: e.ammo, vid: e.vehicle };
    for (const e of ev) {
      if (e.kind === "assault.dismounted") {
        row.reasons[e.reason] = (row.reasons[e.reason] ?? 0) + 1;
        if (e.reason === "hit" && lastHit && e.tick - lastHit.tick <= 600) {
          const hv = sim.state.vehicle.get(lastHit.vid), cls = hv ? input.catalog.vehicles[hv.def]?.class ?? "?" : "?";
          const key = `${lastHit.ammo} on ${lastHit.vid === e.vehicle ? "itself" : cls}`;
          row.hitBy[key] = (row.hitBy[key] ?? 0) + 1;
        }
        if (e.reason === "threatMen") {
          const vt = sim.state.transform.get(e.vehicle), crew = sim.state.vehicle.get(e.vehicle)?.unit;
          let best: { hullM: number; objM: number; seen: boolean } | null = null;
          for (const m of (crew === null || crew === undefined ? [] : sim.state.unit.get(crew)?.members ?? [])) for (const k of sim.state.soldier.get(m)?.contacts ?? []) {
            if (k.cls === "vehicle" || k.wreck === true || k.down === true || k.surrendered === true || k.kind === "heard" || !vt) continue;
            const d = hypot2(k.x - vt.x, k.y - vt.y);
            if (best === null || d < best.hullM) best = { hullM: Math.round(d), objM: Math.round(hypot2(k.x - obj.x, k.y - obj.y)), seen: k.kind === "seen" };
          }
          if (best) row.threats.push(best);
        }
        row.dismountM.push(e.distM); if (e.distM > doctrineM + 50) row.early++; seenVid.add(e.vehicle); supporting.add(e.vehicle); watch.push({ vid: e.vehicle, tick: e.tick, d0: e.distM }); }
      else if (e.kind === "move.noRoute" && e.vehicle !== undefined && carrierVids.has(e.vehicle)) { const k = e.cause ?? "order"; row.noRoute[k] = (row.noRoute[k] ?? 0) + 1; row.noRouteLeftM.push(e.leftM ?? 0); }
      else if (e.kind === "assault.cover") row.covers++;
      else if (e.kind === "vehicle.areaFire" && hulls.has(e.vehicle)) row.areaBursts++;
      else if (e.kind === "assault.supportPost") { row.posts++; row.postSeen.push(e.seen); row.postM.push(Math.round(hypot2(e.x - obj.x, e.y - obj.y))); supporting.add(e.vehicle); }
      else if (e.kind === "unit.dismounted" && mode === "ai" && sim.state.unit.get(e.unit)?.side === atk && !seenVid.has(e.vehicle)) {
        const t = sim.state.transform.get(e.vehicle);
        if (t) { const d = Math.round(hypot2(t.x - obj.x, t.y - obj.y)); seenVid.add(e.vehicle); row.dismountM.push(d); if (d > doctrineM + 50) row.early++; watch.push({ vid: e.vehicle, tick: e.tick, d0: d }); supporting.add(e.vehicle); }
      } else if (e.kind === "shot.fired" && e.vehicle !== undefined && supporting.has(e.vehicle)) row.rounds++;
      else if (e.kind === "hit" && sim.state.identity.get(e.target)?.side === atk && (hulls.has(e.owner) || (sim.state.identity.get(e.owner)?.side === atk && crewOf(e.owner)))) row.ownHits++;
      else if (e.kind === "casualty" && sim.state.identity.get(e.soldier)?.side === atk) { row.attackerDown++; if (aboard.get(e.soldier) === true) row.hitAboard++; }
    }
    for (let i = watch.length - 1; i >= 0; i--) {
      const w = watch[i]!;
      if (sim.state.tick - w.tick < 90 * 60) continue;
      const t = sim.state.transform.get(w.vid), v = sim.state.vehicle.get(w.vid);
      if (t && v && v.status === "ok") row.fellBackM.push(Math.round(hypot2(t.x - obj.x, t.y - obj.y) - w.d0));
      watch.splice(i, 1);
    }
    if (!row.taken && sim.state.objectives[0]?.holder === atk) { row.taken = true; row.takenS = Math.round(sim.state.tick / 60); }
  }
  row.carriers = seenVid.size;
  // Balance pass 6: the commander's own account of the ride (AI mode): why each carrier let its squad out, how far
  // from its point, and its posts. "Early" is then counted from the point (more than 50 m short of it), not from
  // objective 0: the commander's point lies outside every objective and the slots spread sideways.
  if (mode === "ai") {
    const rs = ctrls[0]!.saveState ? rideStats(ctrls[0]!.saveState()) : null;
    if (rs) {
      row.reasons = {}; row.early = 0;
      for (const o of rs.out) { row.reasons[o.why] = (row.reasons[o.why] ?? 0) + 1; row.pointM.push(o.pointM); row.rideRetries += o.retries; if (o.pointM > 50) row.early++; }
      row.postTally = rs.posts;
    }
  }
  return row;
}

export function mountedAssaultLab(data: LoadedData, seeds: number, seconds = 600, scenarios = ["platoon-vehicles", "platoon-ru-vehicles"], modes: ("player" | "ai")[] = ["player", "ai"], fire?: "role" | "return" | "free"): MountedAssaultRow[] {
  const rows: MountedAssaultRow[] = [];
  for (const sc of scenarios) for (const mode of modes) for (let s = 1; s <= seeds; s++) {
    const r = mountedAssaultBattle(data, sc, mode, s, seconds, fire);
    rows.push(r);
    process.stderr.write(`${sc} ${mode} seed ${s}: dismount ${r.dismountM.join("/")} m, why ${Object.entries(r.reasons).map(([k, n]) => `${k} ${n}`).join(", ")}, hit by ${Object.entries(r.hitBy).map(([k, n]) => `${k} ${n}`).join(", ")}, from point ${r.pointM.join("/")} m, sent on ${r.rideRetries}, gave up ${Object.entries(r.noRoute).map(([k, n]) => `${k} ${n}`).join(", ")} (${r.noRouteLeftM.join("/")} m left), posts ${r.postTally ? `${r.postTally.reached} of ${r.postTally.ordered} reached, ${r.postTally.resited} sited again, ${r.postTally.failed} given up` : "-"}, threats ${r.threats.map((t) => `${t.hullM}/${t.objM}${t.seen ? "s" : "r"}`).join(" ")}, posts ${r.postM.join("/")} m, fell back ${r.fellBackM.join("/")} m, rounds ${r.rounds}, own hits ${r.ownHits}, taken ${r.taken}\n`);
  }
  return rows;
}

const mean = (a: number[]) => (a.length === 0 ? NaN : a.reduce((s, x) => s + x, 0) / a.length);
const fmt = (x: number) => (Number.isFinite(x) ? x.toFixed(0) : "-");

export function mountedAssaultLabMarkdown(rows: MountedAssaultRow[]): string {
  const groups = new Map<string, MountedAssaultRow[]>();
  for (const r of rows) { const k = `${r.scenario}|${r.mode}`; groups.set(k, [...(groups.get(k) ?? []), r]); }
  const lines = [
    "Cover first = carriers hit or threatened on the way in that made for a hidden spot before letting their squads out; posts seeing none = follow points with no post seeing the objective, the lane or the enemy near it. Reasons a carrier let its squads out (player mode): point = at its dismount point; stopped = its drive gave up short of it (jammed); hit = it or a hull within 300 m hit (last 10 s); threatMen / threatVehicle = enemy men / a hull known close; near = within the distance when ordered; late = ride timeout; immobile; empty. Scenario@map: the same mounted platoon battle on that map kind. The attacker's platoons riding in to the main objective: \"player\" = the player's Assault order to each of its top units at the start (the mounted assault drill), the defender's commander as usual; \"ai\" = both commanders. Dismount = the carrier's distance to the objective when its squads got out (doctrine distance in brackets; early = more than 50 m beyond it); posts = support-by-fire posts sited (their distance to the objective); fell back = the hull's distance to the objective 90 s after the dismount minus at the dismount (+ = farther back); rounds = shots by those hulls after the dismount; own hits = hits by the attacker's hulls and crews on its own men. Game values (low): docs/DECISIONS.md, balance pass 5, mounted assault.",
    "", "| Scenario | Map (buildings within 120 m) | Mode | Battles | Carriers | Dismount m (mean, min-max) | Early | Why out (player) | Cover first | Hit aboard | Posts | Posts seeing none | Post m (mean) | Fell back m (mean) | Rounds | Own hits | Taken |", "|---|---|---|---:|---:|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
  ];
  for (const [k, rs] of groups) {
    const [sc, mode] = k.split("|");
    const d = rs.flatMap((r) => r.dismountM), p = rs.flatMap((r) => r.postM), f = rs.flatMap((r) => r.fellBackM);
    const why: Record<string, number> = {};
    for (const r of rs) for (const [k, n] of Object.entries(r.reasons)) why[k] = (why[k] ?? 0) + n;
    const nb = rs.map((r) => r.buildings);
    lines.push(`| ${sc} | ${rs[0]!.map}${rs[0]!.urban ? ", built-up" : ""} (${Math.min(...nb)}-${Math.max(...nb)}) | ${mode} | ${rs.length} | ${rs.reduce((s, r) => s + r.carriers, 0)} | ${fmt(mean(d))} (${d.length > 0 ? Math.min(...d) : "-"}-${d.length > 0 ? Math.max(...d) : "-"}; doctrine ${rs[0]!.doctrineM}) | ${rs.reduce((s, r) => s + r.early, 0)} | ${Object.entries(why).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(", ") || "-"} | ${rs.reduce((s, r) => s + r.covers, 0)} | ${rs.reduce((s, r) => s + r.hitAboard, 0)} | ${rs.reduce((s, r) => s + r.posts, 0)} | ${rs.reduce((s, r) => s + r.postSeen.filter((x) => x <= 0).length, 0)} | ${fmt(mean(p))} | ${fmt(mean(f))} | ${rs.reduce((s, r) => s + r.rounds, 0)} | ${rs.reduce((s, r) => s + r.ownHits, 0)} | ${rs.filter((r) => r.taken).length} |`);
  }
  // Balance pass 6 (carrier stall): every carrier that let its squad out short of its point has a reason.
  lines.push("", "Carriers and their dismount points (balance pass 6). Started = carriers with men aboard at the start; never out = lost with its men aboard, or the battle ended first. AI mode: the commander's own account (why each carrier let its squad out, in the drill's words; m from its point at that moment; early = more than 50 m from the point; sent on = orders to drive on after a drive that gave up; posts reached = the hull ended within the arrival distance of the post it was sent to, sited again = a second post after a drive that ended short, given up = it fires from where it stands). Drives given up = `move.noRoute` events of the carriers (on the ride, to a post, or on a later bound) by cause (replans = three re-plans without getting on, planner = no way found, order = refused at the order), with the mean metres left.",
    "", "| Scenario | Mode | Started | Out | Never out | At the point | Out short, with reason | m from point (mean, max) | Sent on | Drives given up | Posts ordered | reached | sited again | given up |", "|---|---|---:|---:|---:|---:|---|---|---:|---|---:|---:|---:|---:|");
  for (const [k, rs] of groups) {
    const [sc, mode] = k.split("|");
    const why: Record<string, number> = {};
    for (const r of rs) for (const [k2, n] of Object.entries(r.reasons)) why[k2] = (why[k2] ?? 0) + n;
    const started = rs.reduce((a, r) => a + r.started, 0), out = rs.reduce((a, r) => a + r.carriers, 0);
    const pm = rs.flatMap((r) => r.pointM), nr: Record<string, number> = {};
    for (const r of rs) for (const [k2, n] of Object.entries(r.noRoute)) nr[k2] = (nr[k2] ?? 0) + n;
    const left = rs.flatMap((r) => r.noRouteLeftM);
    const pt = rs.reduce((a, r) => ({ ordered: a.ordered + (r.postTally?.ordered ?? 0), reached: a.reached + (r.postTally?.reached ?? 0), resited: a.resited + (r.postTally?.resited ?? 0), failed: a.failed + (r.postTally?.failed ?? 0) }), { ordered: 0, reached: 0, resited: 0, failed: 0 });
    const ai = mode === "ai";
    lines.push(`| ${sc} | ${mode} | ${started} | ${out} | ${started - out} | ${(why["point"] ?? 0) + (why["near"] ?? 0)} | ${Object.entries(why).filter(([k2]) => k2 !== "point" && k2 !== "near").sort((a, b) => b[1] - a[1]).map(([k2, n]) => `${k2} ${n}`).join(", ") || "-"} | ${ai && pm.length > 0 ? `${fmt(mean(pm))}, ${Math.max(...pm)}` : "-"} | ${ai ? rs.reduce((a, r) => a + r.rideRetries, 0) : "-"} | ${Object.entries(nr).map(([k2, n]) => `${k2} ${n}`).join(", ") || "0"}${left.length > 0 ? ` (${fmt(mean(left))} m left)` : ""} | ${ai ? pt.ordered : "-"} | ${ai ? pt.reached : "-"} | ${ai ? pt.resited : "-"} | ${ai ? pt.failed : "-"} |`);
  }
  // Review step 5: the player's start rule by role (At will when attacking) lets his hulls fire at suspected places.
  lines.push("", "Fire rule at the start (review step 5; player mode: `--fire role` is the app's rule by role, `--fire return` the rule before). Area bursts = the attacker's hulls firing at places men were last known; own hits = hits by the attacker's hulls on its own men (must be 0).",
    "", "| Scenario | Mode | Fire at start | Battles | Area bursts | Rounds from posts | Own hits | Attacker's men down | Taken |", "|---|---|---|---:|---:|---:|---:|---:|---:|");
  for (const [k, rs] of groups) {
    const [sc, mode] = k.split("|");
    const sum = (f: (r: MountedAssaultRow) => number) => rs.reduce((a, r) => a + f(r), 0);
    lines.push(`| ${sc} | ${mode} | ${mode === "ai" ? "the commander's orders" : rs[0]!.fire} | ${rs.length} | ${sum((r) => r.areaBursts)} | ${sum((r) => r.rounds)} | ${sum((r) => r.ownHits)} | ${sum((r) => r.attackerDown)} | ${rs.filter((r) => r.taken).length} |`);
  }
  return lines.join("\n");
}
