/**
 * REPAIR LAB (M11.7a, roadmap-detail slice 50): how long a crew takes to fix what it can fix in the field, with what
 * parts, and how often the coax and radio repairs work.
 *
 * Part A, repair times: per faction, hull type and crew task its `repair` block lists (track, wheels, coax, radio),
 * the crew alone with its hull on a flat field (no enemy), the component wrecked as roster input (the hull comes
 * into the battle so damaged; mobility kills enter "immobilised"); crew quality as the men's experience (conscript 0.1,
 * regular 0.3, veteran 0.6 = core/qualities.json means). Measured: the men at work, the parts used, the time from
 * the start to the end of the task; expected: the man-minutes over the men's work rates (core/repair.json `skill`),
 * ok within one drill step (+-2 s). For coax and radio over `seeds` seeds: the share of repairs that worked
 * (chance 0.6 / 0.5). Plus "interrupted": a round strikes the hull half-way: the progress is kept, the work resumes
 * after the quiet period: total = expected + the wait.
 */
import { buildCatalog, type DataSet } from "@tcs/data";
import { buildForce, defaultRules } from "@tcs/scenario";
import {
  createSim, flatMap, launchProjectile, newVehicleRecord, step, workRate,
  type BattleInput, type ComponentKind, type EntityId, type SimEvent, type StationKind,
} from "@tcs/sim";

export interface RepairRow {
  faction: string; vehicle: string; task: ComponentKind; quality: string; men: number; parts: string;
  expectedMin: number; measuredMin: number | null; ok: boolean; worked: number; runs: number; chance: number; note: string;
}

const QUALITY: Record<string, number> = { conscript: 0.1, regular: 0.3, veteran: 0.6 };
type RepairEv = Extract<SimEvent, { kind: "vehicle.repair" }>;

/** One crew with its hull alone on a flat field, `task`'s first component wrecked; returns its repair events. */
function run(data: DataSet, faction: string, crewT: string, task: ComponentKind, exp: number, seed: number, hitHalfway: boolean): RepairEv[] {
  const catalog = buildCatalog(data, [faction]);
  const vtype = data.factions[faction]!.units[crewT]!.vehicle!;
  const def = catalog.vehicles[vtype]!;
  const map = flatMap("repair-lab", 400, 400);
  const crew = buildForce(data, { faction, template: crewT, seed, keyPrefix: "c", number: 1 });
  crew.vehicleId = crew.key;
  for (const m of crew.members) m.skills = { ...m.skills, experience: exp };
  const rec = newVehicleRecord(catalog, vtype, crew.key);
  const k = def.components!.findIndex((c) => c.kind === task);
  rec.components = def.components!.map((_, i) => (i === k ? 0 : 1));
  if (task === "track" || task === "wheels") rec.status = "immobilised";
  const slots = data.factions[faction]!.units[crewT]!.members;
  const placements = crew.members.map((m, i) => ({ personId: m.personId, x: 200, y: 200, heading: 0, seat: def.seats.findIndex((q) => q.id === slots[i]?.seat) }));
  const input: BattleInput = {
    map, catalog, seed, orders: [], rules: { ...defaultRules(4 * 3600) },
    forces: [{ side: "blue", faction, units: [crew], placements, vehicles: [rec], vehiclePlacements: [{ vehicleId: crew.key, x: 200, y: 200, heading: 0 }] }],
  };
  const sim = createSim(input);
  const evs: RepairEv[] = [];
  const vid = [...sim.state.vehicle.keys()][0]! as EntityId;
  let hit = false;
  for (let t = 0; t < 4 * 3600 * 60; t++) {
    for (const e of step(sim)) if (e.kind === "vehicle.repair") evs.push(e);
    if (evs.some((e) => e.phase === "done" || e.phase === "failed")) break;
    const rep = sim.state.vehicle.req(vid).repair;
    if (hitHalfway && !hit && rep && rep.doneManS >= rep.needManS / 2) {
      // A rifle round strikes the hull's front plate (away from the men at work).
      hit = true;
      const tr = sim.state.transform.req(vid);
      launchProjectile(sim.ctx, sim.state, ammoOf(sim.ctx.catalog), tr.x + def.body.hull.f[1] + 30, tr.y, 1.2, -850, 0, 0, -1);
    }
  }
  return evs;
}

/** A rifle round of the catalog (the first ball round by id), for the "interrupted" row. */
function ammoOf(catalog: { ammo: Record<string, { kind: string; explosive?: unknown }> }): string {
  return Object.keys(catalog.ammo).sort().find((a) => catalog.ammo[a]!.kind === "ball" && catalog.ammo[a]!.explosive === undefined)!;
}

/** The crew's expected minutes: the task's man-minutes over the work rates of the men the drill takes. */
function expected(data: DataSet, faction: string, crewT: string, task: ComponentKind, exp: number): { min: number; men: number } {
  const catalog = buildCatalog(data, [faction]);
  const R = catalog.repair!, T = R.tasks[task]!;
  const def = catalog.vehicles[data.factions[faction]!.units[crewT]!.vehicle!]!;
  const crewSeats = new Set(data.factions[faction]!.units[crewT]!.members.map((m) => m.seat));
  const order: StationKind[] = T.outside ? ["driver", "loader", "gunner"] : ["loader", "gunner", "commander", "driver"];
  let rate = 0, men = 0;
  for (const st of order) for (const s of def.seats) {
    if (men >= T.men || s.station !== st || !crewSeats.has(s.id)) continue;
    rate += workRate(catalog, { skills: { experience: exp } } as never, st); men++;
  }
  return { min: (T.manMin * 60) / rate / 60, men };
}

/** `only`: these vehicle types alone (tests). */
export function repairLab(data: DataSet, seeds = 5, only?: string[]): RepairRow[] {
  const rows: RepairRow[] = [];
  for (const faction of Object.keys(data.factions).sort()) {
    const pack = data.factions[faction]!;
    const crews = Object.values(pack.units).filter((u) => u.vehicle !== undefined && pack.vehicles[u.vehicle]?.repair !== undefined)
      .sort((a, b) => (a.vehicle! < b.vehicle! ? -1 : a.vehicle! > b.vehicle! ? 1 : a.id < b.id ? -1 : 1));
    const seen = new Set<string>();
    for (const ct of crews) {
      if (seen.has(ct.vehicle!) || (only !== undefined && !only.includes(ct.vehicle!))) continue; // (one crew per hull type: the first by id)
      seen.add(ct.vehicle!);
      const v = pack.vehicles[ct.vehicle!]!;
      const catalog = buildCatalog(data, [faction]);
      for (const task of catalog.repair!.order) {
        const parts = v.repair!.parts[task];
        if (parts === undefined) continue;
        const T = catalog.repair!.tasks[task]!;
        const partsText = parts.length === 0 ? "-" : parts.map((p) => `${p.count} ${p.item}`).join(", ");
        const qualities = task === "track" || task === "wheels" ? ["conscript", "regular", "veteran"] : ["regular"];
        for (const q of qualities) {
          const e = expected(data, faction, ct.id, task, QUALITY[q]!);
          const n = T.chance < 1 ? seeds : 1;
          let measured: number | null = null, worked = 0;
          for (let sd = 1; sd <= n; sd++) {
            const evs = run(data, faction, ct.id, task, QUALITY[q]!, sd, false);
            const st = evs.find((x) => x.phase === "started"), end = evs.find((x) => x.phase === "done" || x.phase === "failed");
            if (st && end && measured === null) measured = (end.tick - st.tick) / 3600;
            if (end?.phase === "done") worked++;
          }
          rows.push({
            faction, vehicle: v.id, task, quality: q, men: e.men, parts: partsText, expectedMin: e.min, measuredMin: measured,
            ok: measured !== null && Math.abs(measured - e.min) * 60 <= 2, worked, runs: n, chance: T.chance, note: "",
          });
        }
      }
    }
    // The interruption row: the first tracked hull's track (else the first task), a hit half-way.
    const mine = crews.filter((c) => only === undefined || only.includes(c.vehicle!));
    const first = mine.find((c) => pack.vehicles[c.vehicle!]!.repair!.parts.track !== undefined) ?? mine[0];
    if (first) {
      const catalog = buildCatalog(data, [faction]);
      const task: ComponentKind = pack.vehicles[first.vehicle!]!.repair!.parts.track !== undefined ? "track" : (Object.keys(pack.vehicles[first.vehicle!]!.repair!.parts)[0] as ComponentKind);
      const e = expected(data, faction, first.id, task, QUALITY["regular"]!);
      const evs = run(data, faction, first.id, task, QUALITY["regular"]!, 1, true);
      const st = evs.find((x) => x.phase === "started"), stop = evs.find((x) => x.phase === "interrupted"), res = evs.find((x) => x.phase === "resumed"), end = evs.find((x) => x.phase === "done");
      const wait = stop && res ? (res.tick - stop.tick) / 3600 : 0;
      const measured = st && end ? (end.tick - st.tick) / 3600 : null;
      const expect = e.min + wait;
      rows.push({
        faction, vehicle: pack.vehicles[first.vehicle!]!.id, task, quality: "regular, hit half-way", men: e.men, parts: "", expectedMin: expect, measuredMin: measured,
        ok: measured !== null && stop?.why === "hit" && wait * 60 >= catalog.repair!.quietS - 2 && Math.abs(measured - expect) * 60 <= 4, worked: end ? 1 : 0, runs: 1, chance: 1,
        note: stop ? `stopped (${stop.why}), resumed after ${(wait * 60).toFixed(0)} s` : "no interruption",
      });
    }
  }
  return rows;
}

export function repairLabMarkdown(rows: RepairRow[]): string {
  const lines = [
    "Crew alone with its hull on a flat field, the component wrecked at the start (roster input). Expected = man-minutes / sum of the men's work rates (core/repair.json); ok = measured within 2 s (one drill step). Coax and radio: repairs that worked out of the runs (seeds).",
    "",
    "| faction | vehicle | task | crew | men | parts used | expected min | measured min | ok | worked | note |",
    "|---|---|---|---|---:|---|---:|---:|---|---|---|",
  ];
  for (const r of rows) {
    lines.push(`| ${r.faction} | ${r.vehicle} | ${r.task} | ${r.quality} | ${r.men} | ${r.parts} | ${r.expectedMin.toFixed(1)} | ${r.measuredMin === null ? "-" : r.measuredMin.toFixed(1)} | ${r.ok ? "yes" : "NO"} | ${r.chance < 1 ? `${r.worked}/${r.runs} (chance ${r.chance})` : r.worked === r.runs ? "yes" : "no"} | ${r.note} |`);
  }
  return lines.join("\n");
}
