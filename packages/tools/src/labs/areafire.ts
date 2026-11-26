/**
 * Area fire lab (balance pass 5, owner 2026-11-20: "Make vehicles fire more near areas where they believe enemy
 * infantry is, even if they don't see them anymore. For this, they can use HE / airburst munitions, as they do in real
 * life"). Two parts, each a fresh battle on a flat field (battle input only, rule 3):
 *
 *   fuse   each hull with a high-explosive round fires at six prone men in a line (3 m apart) R m off, on order,
 *          for `seconds`: once with the impact setting, once with the air burst where its round has one. Men hit and
 *          men down per round fired. Balance pass 6: an ordered high-explosive fire at a point is swept over a
 *          small circle (`gunnery.areaFire.orderedRadiusM`); the "point" rows switch that off (every round at the one
 *          point, as before pass 6) to show what the sweep is worth: a forward cone 15 m short of the point is under
 *          3 m wide at the men, so at one point it can only reach the man or two nearest it, while an impact round's
 *          all-round fragments reach his neighbours. A round with only the air-burst setting refuses "impact".
 *   area   a crew under fire "free" sees six standing men R m off at the edge of a crop field; 8 s later they lie down
 *          in the crops (a day sight loses them; a thermal one may not). Rounds fired at men it saw, rounds fired at
 *          the place (area fire), men hit, the high explosive left in the ready feed, and when the last area burst
 *          was fired (the place's weight decays: it stops by itself).
 *
 * All values asserted in `lab-areafire.test.ts` are bands, not exact numbers.
 */
import { buildCatalog, type DataSet } from "@tcs/data";
import { buildForce } from "@tcs/scenario";
import {
  createSim, DEFAULT_COMMS, environmentAt, flatMap, newVehicleRecord, step, submitOrder,
  type BattleInput, type EntityId, type SimEvent, type SoldierRecord,
} from "@tcs/sim";

export interface AreaFireRow { part: "fuse" | "area"; vehicle: string; case: string; rounds: number; hit: number; down: number; extra: string }

/** The hulls of the lab: faction, crew template, enemy faction. */
const HULLS: [string, string, string][] = [
  ["de", "puma-besatzung", "ru"], ["de", "leopard2a7v-besatzung", "ru"], ["de", "boxer-besatzung-gmw", "ru"],
  ["ru", "bmp2-ekipazh", "de"], ["ru", "t90m-ekipazh", "de"], ["ru", "t72b3m-ekipazh", "de"], ["ru", "btr82a-ekipazh", "de"],
];
/** A rifleman of each faction (lab targets). */
const RIFLE: Record<string, { weapon: string; mag: string }> = { de: { weapon: "de-g36", mag: "de-g36-mag" }, ru: { weapon: "ru-ak74m", mag: "ru-ak74-mag" } };

function man(id: string, f: string): SoldierRecord {
  const r = RIFLE[f]!;
  return { personId: id, given: "L", family: id, rank: "r", role: "rifleman", skills: { marksmanship: 0.5 }, weapon: r.weapon, fatigue: 0, stress: 0, wounds: [], status: "fit", load: [{ type: r.mag, count: 4, charge: 30 }] };
}

/**
 * One hull at (100, 300) facing east, six enemy men in a line across at (100 + R, 300); crops from R - 30 on.
 * `ownManAt`: an own rifleman (a unit of his own) stands there too (tests: danger close).
 */
export function areaFireLayout(data: DataSet, vf: string, crewT: string, ef: string, R: number, seed: number, crops: boolean, seconds: number, ownManAt?: { x: number; y: number }): BattleInput {
  const cat = buildCatalog(data, [vf, ef].sort());
  const map = flatMap("af", R + 400, 600, 4);
  if (crops) {
    map.vegetationPalette.push("crops");
    const k = map.vegetationPalette.length;
    for (let r = 0; r < map.rows; r++) for (let c = Math.floor((100 + R - 30) / map.cellSizeM); c < map.cols; c++) map.vegetation[r * map.cols + c] = k;
  }
  const crew = buildForce(data, { faction: vf, template: crewT, seed, keyPrefix: "c" });
  crew.vehicleId = "v1";
  const tmpl = data.factions[vf]!.units[crewT]!;
  const vtype = tmpl.vehicle!, def = cat.vehicles[vtype]!;
  const pl = crew.members.map((m, mi) => ({ personId: m.personId, x: 100, y: 300, heading: 0, seat: def.seats.findIndex((q) => q.id === tmpl.members[mi]?.seat) })).filter((p) => p.seat >= 0);
  const men = [0, 1, 2, 3, 4, 5].map((i) => man(`t${i}`, ef));
  const ownMan = ownManAt ? [{ unit: { key: "o", callsign: "O", echelon: "team", leaderIndex: 0, subunits: [], members: [man("own", vf)] }, pl: { personId: "own", x: ownManAt.x, y: ownManAt.y, heading: 0 } }] : [];
  const own = { side: "blue", faction: vf, units: [crew, ...ownMan.map((o) => o.unit)], placements: [...pl, ...ownMan.map((o) => o.pl)], vehicles: [newVehicleRecord(cat, vtype, "v1")], vehiclePlacements: [{ vehicleId: "v1", x: 100, y: 300, heading: 0 }] };
  const them = { side: "red", faction: ef, units: [{ key: "t", callsign: "T", echelon: "squad", leaderIndex: 0, subunits: [], members: men }], placements: men.map((m, i) => ({ personId: m.personId, x: 100 + R, y: 300 + (i - 2.5) * 3, heading: Math.PI })) };
  return {
    map, catalog: cat, seed: 7000 + seed, orders: [], environment: environmentAt(cat, 12 * 3600, 0),
    rules: { timeLimitSeconds: seconds + 30, commsModel: "simple", comms: { ...DEFAULT_COMMS }, physiologyModel: "none", physiologyParams: {}, objectives: [], repair: false },
    forces: [own, them] as BattleInput["forces"],
  };
}

function track(sim: ReturnType<typeof createSim>, vid: EntityId) {
  const red = new Set<EntityId>([...sim.state.identity.entries()].filter(([, i]) => i.side === "red").map(([id]) => id));
  const hit = new Set<EntityId>(), down = new Set<EntityId>();
  let rounds = 0, area = 0, last = -1;
  const on = (e: SimEvent) => {
    if (e.kind === "shot.fired" && e.vehicle === vid) rounds++;
    else if (e.kind === "vehicle.areaFire" && e.vehicle === vid) { area++; last = e.tick / 60; }
    else if (e.kind === "wound" && red.has(e.soldier)) hit.add(e.soldier);
    else if (e.kind === "casualty" && red.has(e.soldier)) down.add(e.soldier);
  };
  return { on, get: () => ({ rounds, area, last, hit: hit.size, down: down.size }) };
}

/** The fuse part: ordered high explosive at six prone men, impact and (where the round has it) air burst. */
function fusePart(data: DataSet, seeds: number, ranges: number[], seconds: number): AreaFireRow[] {
  const rows: AreaFireRow[] = [];
  for (const [vf, crewT, ef] of HULLS) {
    for (const R of ranges) for (const [fuse, sweep] of [["impact", true], ["airburst", true], ["impact", false], ["airburst", false]] as const) {
      let rounds = 0, hit = 0, down = 0, refused = 0, vtype = "";
      for (let s = 1; s <= seeds; s++) {
        const input = areaFireLayout(data, vf, crewT, ef, R, s, false, seconds);
        const G = input.catalog.behaviour.gunnery;
        if ((G.areaFire?.orderedRadiusM ?? 0) <= 0 && !sweep) { refused++; continue; } // (no sweep in the data: one row)
        if (!sweep && G.areaFire) input.catalog = { ...input.catalog, behaviour: { ...input.catalog.behaviour, gunnery: { ...G, areaFire: { ...G.areaFire, orderedRadiusM: 0 } } } };
        const sim = createSim(input);
        const [vid, v] = [...sim.state.vehicle.entries()][0]!;
        vtype = v.def;
        const red = [...sim.state.unit.entries()].find(([, u]) => u.side === "red")![0];
        submitOrder(sim, { tick: 0, issuer: "blue", target: v.unit!, kind: "rules", fire: "hold" });
        submitOrder(sim, { tick: 0, issuer: "red", target: red, kind: "rules", fire: "hold" });
        submitOrder(sim, { tick: 0, issuer: "red", target: red, kind: "posture", posture: "prone" });
        for (let k = 0; k < 120; k++) step(sim);
        submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: v.unit!, kind: "fire", x: 100 + R, y: 300, heightM: 0, nature: "he", fuse });
        const t = track(sim, vid);
        let noAir = false;
        for (let k = 0; k < seconds * 60; k++) for (const e of step(sim)) { t.on(e); if (e.kind === "radio" && (e.key === "radio.noAirburst" || e.key === "radio.noImpactFuse")) noAir = true; }
        if (noAir) { refused++; continue; }
        const g = t.get();
        rounds += g.rounds; hit += g.hit; down += g.down;
      }
      if (refused === seeds) { if (sweep && vtype !== "") rows.push({ part: "fuse", vehicle: vtype, case: `${fuse === "airburst" ? "air burst" : "impact"} at six prone men ${R} m`, rounds: 0, hit: 0, down: 0, extra: fuse === "airburst" ? "no air-burst setting" : "no impact setting (air burst only)" }); continue; }
      rows.push({ part: "fuse", vehicle: vtype, case: `${fuse === "airburst" ? "air burst" : "impact"}${sweep ? "" : ", point (no sweep)"} at six prone men ${R} m, ${seconds} s x ${seeds}`, rounds, hit, down, extra: rounds > 0 ? `${(hit / rounds).toFixed(3)} men hit a round` : "" });
    }
  }
  return rows;
}

/** The area part: a crew loses six men who lie down in crops and keeps firing at the place for a while. */
function areaPart(data: DataSet, seeds: number, R: number, seconds: number): AreaFireRow[] {
  const rows: AreaFireRow[] = [];
  for (const [vf, crewT, ef] of HULLS) {
    let rounds = 0, area = 0, hit = 0, down = 0, heLeft = 0, heCap = 0, vtype = "";
    const lasts: number[] = [];
    for (let s = 1; s <= seeds; s++) {
      const sim = createSim(areaFireLayout(data, vf, crewT, ef, R, s, true, seconds));
      const [vid, v] = [...sim.state.vehicle.entries()][0]!;
      vtype = v.def;
      const red = [...sim.state.unit.entries()].find(([, u]) => u.side === "red")![0];
      submitOrder(sim, { tick: 0, issuer: "blue", target: v.unit!, kind: "rules", fire: "free" });
      submitOrder(sim, { tick: 0, issuer: "red", target: red, kind: "rules", fire: "hold" });
      const t = track(sim, vid);
      for (let k = 0; k < seconds * 60; k++) {
        if (k === 8 * 60) submitOrder(sim, { tick: sim.state.tick, issuer: "red", target: red, kind: "posture", posture: "prone" });
        for (const e of step(sim)) t.on(e);
      }
      const g = t.get();
      rounds += g.rounds; area += g.area; hit += g.hit; down += g.down;
      if (g.last >= 0) lasts.push(g.last);
      const cat = sim.ctx.catalog, def = cat.vehicles[v.def]!;
      for (let si = 0; si < def.stations.length; si++) for (let wi = 0; wi < def.stations[si]!.weapons.length; wi++) {
        const wd = def.stations[si]!.weapons[wi]!;
        wd.feeds.forEach((f, fi) => {
          const r = cat.items[f.item]?.chargeItem;
          if (r === undefined || cat.ammo[r]?.explosive === undefined || cat.ammo[r]?.guided !== undefined) return;
          heLeft += v.stations[si]!.weapons[wi]!.feeds[fi]!.rounds; heCap += f.ready.count * f.ready.charge;
        });
      }
    }
    lasts.sort((a, b) => a - b);
    rows.push({
      part: "area", vehicle: vtype, case: `six men lie down in crops ${R} m off after 8 s; ${seconds} s x ${seeds}`, rounds, hit, down,
      extra: `${area} area bursts; last at ${lasts.length > 0 ? lasts[lasts.length >> 1]!.toFixed(0) : "-"} s (median); ready HE left ${heCap > 0 ? Math.round((100 * heLeft) / heCap) : 0} %`,
    });
  }
  return rows;
}

export function areaFireLab(data: DataSet, opts: { seeds?: number; ranges?: number[]; seconds?: number; areaRange?: number; areaSeconds?: number; parts?: ("fuse" | "area")[] } = {}): AreaFireRow[] {
  const seeds = opts.seeds ?? 3, parts = opts.parts ?? ["fuse", "area"];
  return [
    ...(parts.includes("fuse") ? fusePart(data, seeds, opts.ranges ?? [400, 800, 1200], opts.seconds ?? 30) : []),
    ...(parts.includes("area") ? areaPart(data, seeds, opts.areaRange ?? 600, opts.areaSeconds ?? 240) : []),
  ];
}

export function areaFireLabMarkdown(rows: AreaFireRow[]): string {
  return ["Fuse part: ordered high explosive at a point in the middle of six prone men 3 m apart. An ordered fire at a point is swept over a circle (8 m radius in the data) round it; the \"point (no sweep)\" rows put every round on the one point, as before balance pass 6. A forward cone (KETF) bursting 15 m short is under 3 m wide at the men: at one point it reaches at most the two men nearest it, while an impact round's all-round fragments reach their neighbours; swept, it reaches all six. In battle crews lay on each man they see.", "",
    "| part | vehicle | case | rounds | men hit | men down | notes |", "|---|---|---|---:|---:|---:|---|",
    ...rows.map((r) => `| ${r.part} | ${r.vehicle} | ${r.case} | ${r.rounds} | ${r.hit} | ${r.down} | ${r.extra} |`)].join("\n");
}
