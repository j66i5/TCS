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
 *
 * Part B, recovery and towing (M11.7b, `towLab`): see there.
 */
import { buildCatalog, type DataSet } from "@tcs/data";
import { addRecoveryAssets, allMembers, buildForce, defaultRules } from "@tcs/scenario";
import {
  createSim, flatMap, launchProjectile, newVehicleRecord, step, submitOrder, workRate,
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

// ---------------------------------------------------------------- Part B: recovery and towing (M11.7b)

export interface TowRow {
  faction: string; recovery: string; target: string; massT: number; towMaxT: number; distM: number; outcome: string;
  delayS: number | null; driveS: number | null; aloneS: number | null; driveOk: boolean; hookS: number | null; hookUpS: number;
  towMps: number | null; capMps: number; towS: number | null; ok: boolean;
}

const REFUSALS = new Set(["radio.noRecovery", "radio.recoveryTooHeavy", "radio.recoveryAlready", "radio.recoveryNotNeeded", "radio.recoveryNoWay", "radio.unable"]);

/** A foot unit of the faction to make the call (its demo team, else its first team without a vehicle). */
function footTemplate(data: DataSet, faction: string): string {
  const pack = data.factions[faction]!;
  return pack.manifest.demoTemplate ?? Object.values(pack.units).filter((u) => u.vehicle === undefined && u.echelon === "team").map((u) => u.id).sort()[0]!;
}

/**
 * One recovery run: on a flat field 1600 x 1400 m, the hull (abandoned, no crew: a roster record) `distM` from the west
 * edge, heading 0.7 rad, a foot team of the recovery's faction near the edge to call; the faction's recovery vehicle
 * off the map. The call goes in at tick 1; the run is followed to its end.
 */
function towRun(data: DataSet, faction: string, targetType: string, distM: number, seed: number): { evs: Extract<SimEvent, { kind: "vehicle.recovery" | "radio" }>[]; sim: ReturnType<typeof createSim>; rid: EntityId | null; vid: EntityId; speeds: number[] } {
  const catalog = buildCatalog(data, Object.keys(data.factions).sort());
  const map = flatMap("tow-lab", 1600, 1400);
  const team = buildForce(data, { faction, template: footTemplate(data, faction), seed: 1, keyPrefix: "t", number: 1 });
  const rec = newVehicleRecord(catalog, targetType, "hull");
  rec.status = "abandoned";
  const force: BattleInput["forces"][number] = {
    side: "blue", faction, units: [team], placements: allMembers(team).map((m, i) => ({ personId: m.personId, x: 30, y: 680 + 3 * i, heading: 0 })),
    vehicles: [rec], vehiclePlacements: [{ vehicleId: "hull", x: 10 + distM, y: 700, heading: 0.7 }],
  };
  addRecoveryAssets(data, catalog, force, 1);
  const input: BattleInput = { map, catalog, seed, orders: [], rules: { ...defaultRules(4 * 3600) }, forces: [force] };
  const sim = createSim(input);
  const vid = [...sim.state.vehicle.entries()].find(([, v]) => v.offMap === undefined)![0];
  const tu = [...sim.state.unit.entries()].find(([, u]) => u.asset === undefined && u.parent === null)![0];
  submitOrder(sim, { tick: 0, issuer: "blue", target: tu, kind: "callRecovery", vehicle: vid });
  const evs: Extract<SimEvent, { kind: "vehicle.recovery" | "radio" }>[] = [];
  let rid: EntityId | null = null;
  const speeds: number[] = [];
  for (let t = 0; t < 3 * 3600 * 60; t++) {
    for (const e of step(sim)) if (e.kind === "vehicle.recovery" || (e.kind === "radio" && REFUSALS.has(e.key))) { evs.push(e); if (e.kind === "vehicle.recovery") rid = e.vehicle; }
    if (rid !== null) {
      const o = sim.state.vehicle.req(rid).offMap!;
      if (o.phase === "towing" && sim.state.tick % 60 === 0) speeds.push(Math.abs(sim.state.vehicle.req(rid).drive.speed));
      if (o.phase === "away" || o.phase === "lost" || o.phase === "ready") break;
    }
    if (evs.some((e) => e.kind === "radio")) break; // (a refusal: nothing comes)
  }
  return { evs, sim, rid, vid, speeds };
}

/** The same recovery vehicle alone, driving from where it came on to its turning point and reversing onto its spot. */
function aloneRun(data: DataSet, faction: string, from: { x: number; y: number; heading: number }, a: { x: number; y: number }, s: { x: number; y: number }): number | null {
  const catalog = buildCatalog(data, Object.keys(data.factions).sort());
  const rcv = data.factions[faction]!.manifest.recovery!;
  const vtype = data.factions[faction]!.units[rcv.template]!.vehicle!;
  const crew = buildForce(data, { faction, template: rcv.template, seed: 1, keyPrefix: "r", number: 1 });
  crew.vehicleId = crew.key;
  const def = catalog.vehicles[vtype]!, slots = data.factions[faction]!.units[rcv.template]!.members;
  const input: BattleInput = {
    map: flatMap("tow-lab", 1600, 1400), catalog, seed: 1, orders: [], rules: { ...defaultRules(3600) },
    forces: [{ side: "blue", faction, units: [crew], placements: crew.members.map((m, i) => ({ personId: m.personId, x: from.x, y: from.y, heading: from.heading, seat: def.seats.findIndex((q) => q.id === slots[i]?.seat) })), vehicles: [newVehicleRecord(catalog, vtype, crew.key)], vehiclePlacements: [{ vehicleId: crew.key, ...from }] }],
  };
  const sim = createSim(input);
  const R = catalog.recovery!, uid = [...sim.state.unit.keys()][0]! as EntityId;
  submitOrder(sim, { tick: 0, issuer: "blue", target: uid, kind: "move", waypoints: [{ x: a.x, y: a.y, mode: R.pace }, { x: s.x, y: s.y, mode: R.nearPace, reverse: true }] });
  let start = -1;
  for (let t = 0; t < 3600 * 60; t++) {
    for (const e of step(sim)) if (e.kind === "unit.arrived" && start >= 0) return (e.tick - start) / 60;
    const v = [...sim.state.vehicle.values()][0]!;
    if (start < 0 && v.drive.route.length > 0) start = sim.state.tick;
  }
  return null;
}

/**
 * The recovery lab (M11.7b): per faction its recovery vehicle against each of its own hull types (no ambulances, no
 * recovery vehicles) 300 m from the edge it comes on by, the heaviest also from 600 m; the Russian BREM-1 against the
 * Leopard 2A7V (refused: too heavy). Columns: the delay drawn, the drive in (call to arrival less the delay) against
 * the same drive alone (+-10 %), the hook-up (its hookUpS), the mean tow speed (at most its cap) and the tow to the
 * edge.
 */
export function towLab(data: DataSet, only?: string[]): TowRow[] {
  const rows: TowRow[] = [];
  const catalog = buildCatalog(data, Object.keys(data.factions).sort());
  for (const faction of Object.keys(data.factions).sort()) {
    const pack = data.factions[faction]!, rcv = pack.manifest.recovery;
    if (!rcv) continue;
    const rtype = pack.units[rcv.template]!.vehicle!, rdef = catalog.vehicles[rtype]!;
    const own = Object.keys(pack.vehicles).sort().filter((t) => catalog.vehicles[t]!.ambulance === undefined && catalog.vehicles[t]!.recovery === undefined);
    const heaviest = [...own].sort((a, b) => catalog.vehicles[b]!.massKg - catalog.vehicles[a]!.massKg)[0];
    const cases: [string, number][] = own.map((t) => [t, 300] as [string, number]);
    if (heaviest) cases.push([heaviest, 600]);
    // (A foreign heavy hull: the Russian recovery vehicle and a Leopard 2, a captured hull.)
    for (const [f, t] of [["ru", "de-leopard2a7v"]] as const) if (faction === f && catalog.vehicles[t]) cases.push([t, 300]);
    for (const [t, distM] of cases) {
      if (only !== undefined && !only.includes(t)) continue;
      const tdef = catalog.vehicles[t]!;
      const { evs, sim, rid, vid, speeds } = towRun(data, faction, t, distM, rows.length + 1);
      const at = (p: string) => (evs.find((e) => e.kind === "vehicle.recovery" && e.phase === p)?.tick ?? null);
      const refused = evs.find((e) => e.kind === "radio");
      const called = at("called"), entered = at("entered"), arrived = at("arrived"), hooked = at("hookedUp"), away = at("away");
      const towed = sim.state.vehicle.req(vid).towAway === true;
      const delayS = called !== null && entered !== null ? (entered - called) / 60 : null;
      const driveS = entered !== null && arrived !== null ? (arrived - entered) / 60 : null;
      let aloneS: number | null = null;
      if (driveS !== null && rid !== null) {
        const o = sim.state.vehicle.req(rid).offMap!, entry = o.entry!;
        const tt = { x: 10 + distM, y: 700 };
        const L = Math.hypot(entry.x - tt.x, entry.y - tt.y), ux = (entry.x - tt.x) / L, uy = (entry.y - tt.y) / L;
        const off = tdef.body.lengthM / 2 + catalog.recovery!.gapM + rdef.body.lengthM / 2;
        const s = { x: tt.x + ux * off, y: tt.y + uy * off }, a = { x: s.x + ux * catalog.recovery!.approachM, y: s.y + uy * catalog.recovery!.approachM };
        aloneS = aloneRun(data, faction, entry, a, s);
      }
      const hookS = arrived !== null && hooked !== null ? (hooked - arrived) / 60 : null;
      const towS = hooked !== null && away !== null ? (away - hooked) / 60 : null;
      const towMps = speeds.length > 0 ? speeds.reduce((x, y) => x + y, 0) / speeds.length : null;
      const driveOk = driveS !== null && aloneS !== null && Math.abs(driveS - aloneS) <= 0.1 * aloneS + 2;
      const cap = rdef.recovery!.towMaxMps;
      const outcome = refused ? `refused (${refused.key.replace("radio.", "")})` : towed ? "towed" : "not towed";
      const tooHeavy = tdef.massKg > rdef.recovery!.towMaxKg;
      const ok = tooHeavy ? refused?.key === "radio.recoveryTooHeavy" : towed && driveOk && hookS !== null && Math.abs(hookS - rdef.recovery!.hookUpS) <= 2 && towMps !== null && towMps <= cap + 0.05;
      rows.push({
        faction, recovery: rtype, target: t, massT: tdef.massKg / 1000, towMaxT: rdef.recovery!.towMaxKg / 1000, distM, outcome,
        delayS, driveS, aloneS, driveOk, hookS, hookUpS: rdef.recovery!.hookUpS, towMps, capMps: cap, towS, ok,
      });
    }
  }
  return rows;
}

export function towLabMarkdown(rows: TowRow[]): string {
  const f = (x: number | null, d = 0) => (x === null ? "-" : x.toFixed(d));
  const lines = [
    "The hull abandoned on a flat field `dist` m from the west edge (heading 0.7 rad), a foot team of the faction calls at tick 1; the recovery vehicle comes on at the edge after the delay (drawn, `Streams.recovery`), drives to the hull and reverses the last 25 m onto its spot, hooks up, tows the hull back to where it came on. drive in = arrival - coming on; alone = the same vehicle on the same two legs with nothing else (ok within 10 % + 2 s); hook-up against the vehicle's hookUpS; tow speed = mean while towing (at most the cap); tow = hooked up to off the map.",
    "",
    "| recovery | hull | t | tows up to t | dist m | outcome | delay s | drive in s | alone s | hook-up s (data) | tow m/s (cap) | tow s | ok |",
    "|---|---|---:|---:|---:|---|---:|---:|---:|---:|---:|---:|---|",
  ];
  for (const r of rows) lines.push(`| ${r.recovery} | ${r.target} | ${r.massT.toFixed(1)} | ${r.towMaxT.toFixed(0)} | ${r.distM} | ${r.outcome} | ${f(r.delayS)} | ${f(r.driveS)} | ${f(r.aloneS)} | ${f(r.hookS)} (${r.hookUpS}) | ${f(r.towMps, 2)} (${r.capMps.toFixed(2)}) | ${f(r.towS)} | ${r.ok ? "yes" : "NO"} |`);
  return lines.join("\n");
}
