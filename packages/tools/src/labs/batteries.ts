/**
 * BATTERIES AND WATER LAB (M11.6, roadmap-detail slice 49). A German and a Russian platoon on foot, each with its
 * radios, goggles, thermal sight and quadcopter, spend a moonless night (21:00 on, moon 0) of three hours on patrol
 * on a flat map, 2.4 km apart with their fire held: no fight, only the night. Every squad walks a 300 m beat to and
 * fro; each platoon keeps its drone up over its own men (relaunched on a fresh battery once it has come home). Per
 * faction: the devices fitted, batteries changed and gone flat by kind, unit time off the net, drone flights and
 * relaunches, water drunk, and the books: every Wh and every ml at the start must be left (in loads, devices and
 * drones in the air) or used (drained in devices, flown by drones, lost with a drone), and every battery still be
 * there as a counted item (one lost with a drone aside).
 *
 * `speedup` k (tests): battery hours / k, drone power x k, water loss x k and the night k times shorter: the same
 * swaps and sips in a k-th of the ticks (the swap and launch times themselves are not shortened).
 */
import type { DataSet } from "@tcs/data";
import {
  chargeAt, deviceClass, environmentAt, flatMap, newReviewTally, step, submitOrder, tallyReview, TICK_HZ,
  createSim, type BattleInput, type Catalog, type DefId, type EntityId, type ReviewTally, type SimState, type Waypoint,
} from "@tcs/sim";
import { getScenario } from "../scenarios";

export interface BatteriesOptions { seconds?: number; seed?: number; speedup?: number }

export interface BatteriesRow {
  faction: string; side: string; men: number;
  /** Devices with a battery slot, by kind (radio, sight: goggles and thermal sights, other). */
  devices: Record<"radio" | "sight" | "other", number>;
  swaps: Record<"radio" | "sight" | "other" | "drone", number>;
  flat: Record<"radio" | "sight" | "other", number>;
  offNetS: number;
  drones: { launched: number; landed: number; lostBattery: number };
  /** Wh: at the start; left at the end (loads, devices, drones in the air); drained in devices; flown by drones; lost
   *  with a drone; and start - (left + used) (0 when the books balance). */
  wh: { start: number; left: number; devices: number; drones: number; lost: number; error: number };
  /** Battery items at the start and at the end (in loads, devices and drones), and lost with drones. */
  batteries: { start: number; end: number; lost: number };
  /** Water, ml: at the start, left, drunk (`water.drunk`), start - (left + drunk). */
  water: { start: number; left: number; drunk: number; error: number };
  /** Men who drank, and the lowest hydration at the end (1 = none lost). */
  drinkers: number; minHydration: number;
}

export interface BatteriesResult { seconds: number; seed: number; speedup: number; rows: BatteriesRow[]; wallMs: number }

const NIGHT_START = 21 * 3600;
const W = 3000, H = 1200;

/** The catalog with batteries k times shorter, drones k times hungrier and water lost k times faster. */
export function compressCatalog(cat: Catalog, k: number): Catalog {
  if (k === 1) return cat;
  const items: Catalog["items"] = {};
  for (const [id, d] of Object.entries(cat.items)) {
    items[id] = d.power ? { ...d, power: { ...d.power, hours: d.power.hours / k } } : d.drone ? { ...d, drone: { ...d.drone, powerW: d.drone.powerW * k } } : d;
  }
  const P = cat.body.physiology, h = P.hydration;
  const physiology = h ? { ...P, hydration: { ...h, lossBaseLph: h.lossBaseLph * k, lossExertLph: h.lossExertLph * k, fromBattleS: h.fromBattleS / k } } : P;
  return { ...cat, items, body: { ...cat.body, physiology } };
}

/** The lab's battle: the platoon scenario's two platoons moved onto a flat map 2.4 km apart, at night. */
export function batteriesBattle(data: DataSet, seed: number, seconds: number, speedup: number): BattleInput {
  const input = getScenario("platoon").build(data, seed, seconds);
  input.catalog = compressCatalog(input.catalog, speedup);
  input.map = flatMap("batteries", W, H, 4);
  input.rules.objectives = [];
  input.environment = environmentAt(input.catalog, NIGHT_START, 0);
  for (const f of input.forces) {
    const n = f.placements.length;
    const mx = f.placements.reduce((a, p) => a + p.x, 0) / n, my = f.placements.reduce((a, p) => a + p.y, 0) / n;
    const cx = f.side === "blue" ? 300 : W - 300;
    f.placements = f.placements.map((p) => ({ ...p, x: Math.min(W - 20, Math.max(20, cx + (p.x - mx))), y: Math.min(H - 200, Math.max(200, H / 2 + (p.y - my))) }));
  }
  return input;
}

/** Battery and water stocks in one side's hands: in men's loads and devices and in its drones' containers. */
function stocks(cat: Catalog, st: SimState, side: string, batteries: ReadonlySet<DefId>): { wh: number; n: number; ml: number } {
  let wh = 0, n = 0, ml = 0;
  const count = (id: EntityId) => {
    const c = st.container.get(id);
    if (!c) return;
    for (const s of c.stacks) {
      const d = cat.items[s.type];
      if (batteries.has(s.type)) { wh += s.count * (s.charge ?? d?.chargeCapacity ?? 0); n += s.count; }
      if (d?.water === true) ml += s.count * (s.charge ?? d.chargeCapacity ?? 0);
    }
  };
  for (const [id, i] of st.identity.entries()) {
    if (i.side !== side) continue;
    count(id);
    for (const slot of st.soldier.get(id)?.power ?? []) if (slot.battery !== null) { wh += chargeAt(slot, st.tick); n++; }
  }
  for (const [id, d] of st.drone.entries()) if (d.side === side) count(id);
  return { wh, n, ml };
}

/** Wh in a drone's container. */
function droneWh(st: SimState, id: EntityId, batteries: ReadonlySet<DefId>): number {
  let wh = 0;
  for (const s of st.container.get(id)?.stacks ?? []) if (batteries.has(s.type)) wh += s.count * (s.charge ?? 0);
  return wh;
}

export function batteriesLab(data: DataSet, opts: BatteriesOptions = {}): BatteriesResult {
  const k = opts.speedup ?? 1, seed = opts.seed ?? 1;
  const seconds = Math.round((opts.seconds ?? 10800) / k);
  const t0 = performance.now();
  const input = batteriesBattle(data, seed, seconds, k);
  const cat = input.catalog;
  const sim = createSim(input);
  const st = sim.state;
  const batteries = new Set<DefId>();
  for (const d of Object.values(cat.items)) { if (d.power) batteries.add(d.power.battery); if (d.drone) batteries.add(d.drone.battery); }
  const sides = input.forces.map((f) => ({ side: f.side, faction: f.faction }));
  const start = new Map(sides.map((s) => [s.side, stocks(cat, st, s.side, batteries)]));

  // The books: the charge in each device slot since it was fitted (start, or its last swap).
  const fitted = new Map<string, number>();
  const drained: Record<string, { devices: number; drones: number; lost: number; lostN: number; drunk: number }> = {};
  for (const s of sides) drained[s.side] = { devices: 0, drones: 0, lost: 0, lostN: 0, drunk: 0 };
  for (const [id, s] of st.soldier.entries()) for (const slot of s.power ?? []) fitted.set(`${id}:${slot.device}`, chargeAt(slot, 0));

  // Orders: fire held; every unit with men walks a 300 m beat (north and south of where its leader stands).
  for (const [uid, u] of st.unit.entries()) {
    submitOrder(sim, { tick: 0, issuer: u.side, target: uid, kind: "rules", fire: "hold" });
    const lead = u.members[0] !== undefined ? st.transform.get(u.members[0]) : undefined;
    if (!lead) continue;
    const wps: Waypoint[] = [];
    for (let j = 0; j < 60; j++) wps.push({ x: lead.x, y: Math.min(H - 20, Math.max(20, lead.y + (j % 2 === 0 ? -150 : 150))), mode: "walk" });
    submitOrder(sim, { tick: 0, issuer: u.side, target: uid, kind: "move", waypoints: wps });
  }

  const tally: ReviewTally = newReviewTally();
  // Each drone in the air before the step: its side, Wh and draw per tick.
  const prev = new Map<EntityId, { side: string; wh: number; perTick: number }>();
  const drinkers: Record<string, Set<EntityId>> = Object.fromEntries(sides.map((s) => [s.side, new Set<EntityId>()]));
  const end = seconds * TICK_HZ;
  while (st.tick < end && !st.ended) {
    // Each platoon keeps its drone up (every 60 s): its carrier sends it 100 m above the platoon's middle.
    if (st.tick % (60 * TICK_HZ) === 0) {
      for (const [uid, u] of st.unit.entries()) {
        if (u.parent !== null) continue;
        let up = false;
        for (const [, d] of st.drone.entries()) if (d.unit === uid) up = true;
        if (up) continue;
        const men = allMembers(st, uid);
        const op = men.find((m) => st.container.get(m)?.stacks.some((x) => x.count > 0 && cat.items[x.type]?.drone !== undefined));
        if (op === undefined) continue;
        let sx = 0, sy = 0;
        for (const m of men) { const t = st.transform.get(m); if (t) { sx += t.x; sy += t.y; } }
        submitOrder(sim, { tick: st.tick, issuer: u.side, target: op, kind: "drone", op: "fly", x: sx / men.length, y: sy / men.length + 100, altM: 120 });
      }
    }
    prev.clear();
    for (const [id, d] of st.drone.entries()) prev.set(id, { side: d.side, wh: droneWh(st, id, batteries), perTick: (cat.items[d.item]?.drone?.powerW ?? 0) / (3600 * TICK_HZ) });
    const ev = step(sim);
    tallyReview(tally, ev, st, cat);
    // Drones: what each one in the air flew off this tick; one that came down: its last tick's draw (the model's
    // fixed draw, never more than it had), and the rest landed (into a load) or lost with it.
    for (const [id, p] of prev) {
      const dr = drained[p.side];
      if (!dr) continue;
      if (st.drone.has(id)) { dr.drones += p.wh - droneWh(st, id, batteries); continue; }
      const last = Math.min(p.wh, p.perTick);
      dr.drones += last;
      if (!ev.some((e) => e.kind === "drone.landed" && e.drone === id)) { dr.lost += p.wh - last; dr.lostN++; }
    }
    // Launched this tick: it has already flown its first tick.
    for (const [id, d] of st.drone.entries()) {
      const dr = drained[d.side];
      if (!prev.has(id) && dr) dr.drones += (cat.items[d.item]?.drone?.powerW ?? 0) / (3600 * TICK_HZ);
    }
    for (const e of ev) {
      if (e.kind === "power.swapped") {
        const key = `${e.soldier}:${e.device}`, side = st.identity.get(e.soldier)?.side;
        const dr = side !== undefined ? drained[side] : undefined;
        if (dr) dr.devices += (fitted.get(key) ?? 0) - e.whOut;
        fitted.set(key, e.whIn);
      } else if (e.kind === "water.drunk") {
        const dr = drained[e.side];
        if (dr) { dr.drunk += e.ml; drinkers[e.side]?.add(e.soldier); }
      }
    }
  }
  // Still fitted at the end: drained since fitted.
  for (const [id, s] of st.soldier.entries()) {
    const side = st.identity.get(id)?.side;
    if (side === undefined || !drained[side]) continue;
    for (const slot of s.power ?? []) drained[side].devices += (fitted.get(`${id}:${slot.device}`) ?? 0) - (slot.battery === null ? 0 : chargeAt(slot, st.tick));
  }

  const rows: BatteriesRow[] = sides.map(({ side, faction }) => {
    const s0 = start.get(side)!, s1 = stocks(cat, st, side, batteries), dr = drained[side]!;
    const sup = tally.sides[side]?.supply, drn = tally.sides[side]?.drones;
    const devices = { radio: 0, sight: 0, other: 0 };
    let men = 0, minHydration = 1;
    for (const [id, i] of st.identity.entries()) {
      if (i.side !== side) continue;
      men++;
      const so = st.soldier.get(id);
      for (const slot of so?.power ?? []) devices[deviceClass(cat, slot.device)]++;
      if (so) minHydration = Math.min(minHydration, so.physical.hydration);
    }
    const used = dr.devices + dr.drones + dr.lost;
    return {
      faction, side, men, devices,
      swaps: sup ? { ...sup.swaps } : { radio: 0, sight: 0, other: 0, drone: 0 },
      flat: sup ? { ...sup.flat } : { radio: 0, sight: 0, other: 0 },
      offNetS: sup?.offNetS ?? 0,
      drones: { launched: drn?.launched ?? 0, landed: drn?.landed ?? 0, lostBattery: drn?.lostBattery ?? 0 },
      wh: { start: s0.wh, left: s1.wh, devices: dr.devices, drones: dr.drones, lost: dr.lost, error: s0.wh - (s1.wh + used) },
      batteries: { start: s0.n, end: s1.n, lost: dr.lostN },
      water: { start: s0.ml, left: s1.ml, drunk: dr.drunk, error: s0.ml - (s1.ml + dr.drunk) },
      drinkers: drinkers[side]?.size ?? 0, minHydration,
    };
  });
  return { seconds, seed, speedup: k, rows, wallMs: performance.now() - t0 };
}

/** Men of a unit and its subunits. */
function allMembers(st: SimState, uid: EntityId): EntityId[] {
  const u = st.unit.get(uid);
  if (!u) return [];
  return [...u.members, ...u.children.flatMap((c) => allMembers(st, c))];
}

function f1(x: number): string { return x.toFixed(1); }

export function batteriesLabMarkdown(r: BatteriesResult): string {
  const hh = (s: number) => `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`;
  const lines = [
    `A German and a Russian platoon on foot, ${hh(r.seconds * r.speedup)} of a moonless night from 21:00 (seed ${r.seed}${r.speedup !== 1 ? `, compressed ${r.speedup}x` : ""}), every squad walking a 300 m beat, fire held, 2.4 km apart; each platoon keeps its quadcopter up over its men. Wall time ${(r.wallMs / 1000).toFixed(0)} s.`,
    "",
    "| Faction | Men | Devices (radio / sight / other) | Batteries changed (radio / sight / other) | Gone flat (radio / sight / other) | Off the net, unit-min | Drone flights (relaunches, recovered, flat) | Water drunk, L (men who drank; lowest hydration at the end) |",
    "|---|---|---|---|---|---|---|---|",
    ...r.rows.map((x) => `| ${x.faction} | ${x.men} | ${x.devices.radio} / ${x.devices.sight} / ${x.devices.other} | ${x.swaps.radio} / ${x.swaps.sight} / ${x.swaps.other} | ${x.flat.radio} / ${x.flat.sight} / ${x.flat.other} | ${f1(x.offNetS / 60)} | ${x.drones.launched} (${x.swaps.drone}, ${x.drones.landed}, ${x.drones.lostBattery}) | ${(x.water.drunk / 1000).toFixed(2)} (${x.drinkers}; ${x.minHydration.toFixed(2)}) |`),
    "",
    "Conservation (every Wh and ml at the start is left or used; every battery still a counted item unless lost with a drone):",
    "",
    "| Faction | Wh at start | Wh left | drained in devices | flown by drones | lost with a drone | start - (left + used) | batteries start / end / lost | water ml start | left | drunk | start - (left + drunk) |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|",
    ...r.rows.map((x) => `| ${x.faction} | ${f1(x.wh.start)} | ${f1(x.wh.left)} | ${f1(x.wh.devices)} | ${f1(x.wh.drones)} | ${f1(x.wh.lost)} | ${x.wh.error.toExponential(1)} | ${x.batteries.start} / ${x.batteries.end} / ${x.batteries.lost} | ${x.water.start} | ${x.water.left} | ${x.water.drunk} | ${x.water.error} |`),
  ];
  return lines.join("\n");
}
