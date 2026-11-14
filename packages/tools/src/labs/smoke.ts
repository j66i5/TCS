/**
 * SMOKE LAB (D1 hand smoke grenades, roadmap-detail slice 5): one man on open flat ground is ordered to throw a smoke
 * grenade (`grenade` order with `smoke: true`) at a point 20 m ahead. Measured from the state: whether it was thrown
 * (one item fewer, nothing else), when it starts to smoke, the cloud's size, and how long a line of sight across
 * the cloud is cut — through its middle (the cloud 20 m across) and the width of the band in which sight is cut to a
 * tenth or less, at 15, 30, 45 and 60 s after the throw. Also: a fragmentation grenade order never takes a smoke
 * grenade, and the smoke never wounds.
 */
import { buildCatalog, type DataSet } from "@tcs/data";
import {
  countItems, createSim, DEFAULT_COMMS, flatMap, smokeTransmission, step, submitOrder, ticksToSeconds,
  type BattleInput, type SoldierRecord,
} from "@tcs/sim";

export interface SmokeRow { ammo: string; case: string; value: number; unit: string }

/** Cut to a tenth or less: what "blocks sight" means here. */
export const BLOCKED = 0.1;

function oneMan(data: DataSet, faction: string, ammo: string) {
  const catalog = buildCatalog(data, [faction]);
  const map = flatMap("smoke-lab", 300, 300, 4, "grass");
  const man: SoldierRecord = {
    personId: "m#1", given: "Lab", family: "m1", rank: "r", role: "rifleman", skills: { marksmanship: 0.5 }, fatigue: 0, stress: 0, wounds: [],
    load: [{ type: ammo, count: 2 }], status: "fit",
  };
  const input: BattleInput = {
    map, catalog, seed: 1, orders: [],
    environment: { timeOfDaySeconds: 12 * 3600, light: 1, windX: 0, windY: 0, rain: 0, visibilityM: 5000, temperatureC: 15 },
    rules: { timeLimitSeconds: 3600, commsModel: "simple", comms: { ...DEFAULT_COMMS, orderDelaySeconds: 0, orderDelayJitterSeconds: 0 }, physiologyModel: "none", physiologyParams: {}, objectives: [] },
    forces: [{ side: "blue", faction, units: [{ key: "t", callsign: "T", echelon: "team", leaderIndex: 0, subunits: [], members: [man] }], placements: [{ personId: "m#1", x: 100, y: 150, heading: 0 }] }],
  };
  const sim = createSim(input);
  const unit = [...sim.state.unit.keys()][0]!;
  const sid = [...sim.state.soldier.keys()][0]!;
  return { sim, unit, sid };
}

export function smokeLab(data: DataSet, cases: { faction: string; ammo: string }[] = [{ faction: "de", ammo: "de-dm45" }, { faction: "ru", ammo: "ru-rdg2" }]): SmokeRow[] {
  const rows: SmokeRow[] = [];
  for (const c of cases) {
    const add = (k: string, value: number, unit: string) => rows.push({ ammo: c.ammo, case: k, value, unit });
    const { sim, unit, sid } = oneMan(data, c.faction, c.ammo);
    const k = sim.ctx.catalog.spotting.smokeExtinctionPerM, build = Math.round(sim.ctx.catalog.spotting.smokeBuildSeconds * 60);
    // A fragmentation grenade order: nobody takes the smoke grenade for it.
    submitOrder(sim, { tick: 0, issuer: "blue", target: unit, kind: "grenade", x: 120, y: 150 });
    for (let i = 0; i < 60 * 3; i++) step(sim);
    add("thrown on a fragmentation grenade order", 2 - countItems(sim.state.container.req(sid), c.ammo), "");
    const t0 = sim.state.tick;
    submitOrder(sim, { tick: t0, issuer: "blue", target: unit, kind: "grenade", x: 120, y: 150, smoke: true });
    let startTick = -1;
    const at: Record<number, { mid: number; width: number }> = {};
    let blockedS = 0;
    for (let i = 0; i < 60 * 150; i++) {
      step(sim);
      const cl = sim.state.smoke[0];
      if (cl && startTick < 0) startTick = sim.state.tick;
      if (!cl) continue;
      // A line of sight across the cloud, square to the throw: observer 100 m to the south, target 100 m north.
      const mid = smokeTransmission(sim.state, k, cl.x, cl.y - 100, cl.x, cl.y + 100, build);
      if (mid <= BLOCKED) blockedS += 1 / 60;
      const s = Math.round(ticksToSeconds(sim.state.tick - t0));
      if ((s === 15 || s === 30 || s === 45 || s === 60) && at[s] === undefined) {
        let width = 0;
        for (let o = -20; o <= 20; o += 0.5) if (smokeTransmission(sim.state, k, cl.x + o, cl.y - 100, cl.x + o, cl.y + 100, build) <= BLOCKED) width += 0.5;
        at[s] = { mid, width };
      }
    }
    add("smoke grenades used", 2 - countItems(sim.state.container.req(sid), c.ammo), "");
    add("smoke from the order", startTick < 0 ? Infinity : ticksToSeconds(startTick - t0), "s");
    add("cloud across", (sim.ctx.catalog.ammo[c.ammo]?.smoke?.radiusM ?? 0) * 2, "m");
    add("line through the middle cut to a tenth", blockedS, "s");
    for (const s of [15, 30, 45, 60]) {
      add(`view left through the middle at ${s} s`, at[s]?.mid ?? 1, "");
      add(`band cut to a tenth at ${s} s`, at[s]?.width ?? 0, "m");
    }
    add("men wounded", sim.state.soldier.req(sid).wounds.length, "");
  }
  return rows;
}

export function smokeLabMarkdown(rows: SmokeRow[]): string {
  const f = (v: number) => (Number.isFinite(v) ? (Math.abs(v) < 1 && v !== 0 ? v.toFixed(3) : v.toFixed(1)) : "-");
  return ["| grenade | case | value |", "|---|---|---|", ...rows.map((r) => `| ${r.ammo} | ${r.case} | ${f(r.value)} ${r.unit} |`)].join("\n");
}
