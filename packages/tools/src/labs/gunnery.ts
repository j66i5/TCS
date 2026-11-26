/**
 * Gunnery lab (M7.3): turrets, cannon and coaxial machine guns from orders only, on a flat field. Each case is
 * a fresh battle built from the vehicle scenario with the vehicles and men placed for it (battle input, not
 * state): hits of armour-piercing rounds on a halted hull side-on, on the move, the time a turret takes to lay
 * on a target 90 degrees off, high explosive at a group of men, and the ammunition count with a refill from
 * stowage (rule 9, owner Q17). The bands asserted in `lab-gunnery.test.ts` are game values.
 */
import { buildCatalog, type DataSet } from "@tcs/data";
import { vehicleBattle } from "@tcs/scenario";
import { createSim, step, submitOrder, type BattleInput, type EntityId, type Sim, type SimEvent } from "@tcs/sim";

export interface GunneryRow { vehicle: string; case: string; value: number; unit: string }

interface Layout {
  blue: { x: number; y: number; heading: number };
  red: { x: number; y: number; heading: number };
  /** Where the red squad stands (else far away in a corner), in a line across, `spacing` apart. */
  redSquadAt?: { x: number; y: number; spacing: number };
}

/** A one-vehicle-a-side battle on a flat 2400 x 1200 m field, laid out as asked. */
export function duel(data: DataSet, factions: [string, string], lay: Layout, squadTemplates?: [string, string], mapWidthM = 2400, crewTemplates?: [string, string], recovery = false): BattleInput {
  // (M11.7b: `recovery`: each side also has its recovery vehicles off the map.)
  const input = vehicleBattle(data, { seed: 3, factions, vehiclesPerPlatoon: 1, mapWidthM, mapHeightM: 1200, timeLimitSeconds: 3600, ...(squadTemplates ? { squadTemplates } : {}), ...(crewTemplates ? { crewTemplates } : {}), ...(recovery ? { recovery } : {}) });
  input.forces.forEach((f, s) => {
    const p = s === 0 ? lay.blue : lay.red;
    for (const vp of f.vehiclePlacements ?? []) { vp.x = p.x; vp.y = p.y; vp.heading = p.heading; }
    const crewIds = new Set(f.units.flatMap((u) => u.subunits).filter((u) => u.vehicleId !== undefined).flatMap((u) => u.members.map((m) => m.personId)));
    let k = 0;
    for (const pl of f.placements) {
      if (crewIds.has(pl.personId)) { pl.x = p.x; pl.y = p.y; continue; }
      if (s === 1 && lay.redSquadAt) { pl.x = lay.redSquadAt.x; pl.y = lay.redSquadAt.y + (k++ - 2.5) * lay.redSquadAt.spacing; pl.heading = Math.PI; continue; }
      pl.x = s === 0 ? 20 : mapWidthM - 20; pl.y = 20 + 3 * k++; // out of the way, far apart
    }
  });
  return input;
}

function crewOf(sim: Sim, side: string): { vid: EntityId; crew: EntityId; type: string } {
  const [vid, v] = [...sim.state.vehicle.entries()].find(([, x]) => x.side === side)!;
  return { vid, crew: v.unit!, type: v.def };
}

function run(sim: Sim, seconds: number, on: (e: SimEvent) => void): void {
  for (let i = 0; i < seconds * 60; i++) for (const e of step(sim)) on(e);
}

/** Everyone holds fire on his own (only orders shoot): the lab measures the gun, not the decisions. */
function holdAll(sim: Sim): void {
  for (const [uid, u] of sim.state.unit.entries()) if (u.parent === null) submitOrder(sim, { tick: sim.state.tick, issuer: u.side, target: uid, kind: "rules", fire: "hold" });
  step(sim);
}

/**
 * The red target hull stays where it is (M7.4b: a crew that is penetrated would otherwise reverse out of the
 * lab): it enters the battle immobilised, as roster input (rule 3: the sim state is never written from outside).
 */
function stillTarget(input: BattleInput): BattleInput {
  for (const rec of input.forces[1]!.vehicles ?? []) rec.status = "immobilised";
  input.rules.repair = false; // (M11.7a: the frozen target is never repaired)
  return input;
}

/** M7.6a: the tank pairs fire at the other side's tank on a wider field (3 km rows). */
interface Pair { factions: [string, string]; crewTemplates?: [string, string]; tank?: boolean }
const PAIRS: Pair[] = [
  { factions: ["de", "ru"] }, { factions: ["ru", "de"] },
  { factions: ["de", "ru"], crewTemplates: ["leopard2a7v-besatzung", "t90m-ekipazh"], tank: true },
  { factions: ["ru", "de"], crewTemplates: ["t90m-ekipazh", "leopard2a7v-besatzung"], tank: true },
  { factions: ["ru", "de"], crewTemplates: ["t72b3m-ekipazh", "leopard2a7v-besatzung"], tank: true },
  // M7.6c: the wheeled carriers (GTK Boxer's 12.7 mm remote station, BTR-82A's 2A72) at each other.
  { factions: ["de", "ru"], crewTemplates: ["boxer-besatzung", "btr82a-ekipazh"] },
  { factions: ["ru", "de"], crewTemplates: ["btr82a-ekipazh", "boxer-besatzung"] },
  // M7.6d: the GTK Boxer with the 40 mm GMW on its station.
  { factions: ["de", "ru"], crewTemplates: ["boxer-besatzung-gmw", "btr82a-ekipazh"] },
];
const TANK_FIELD_M = 4000;

/** The blue crewman at a seat of this station kind comes into the battle killed (roster input, rule 3). */
function killBlueSeat(data: DataSet, input: BattleInput, crewTemplate: string, station: string): BattleInput {
  const f = input.forces[0]!, tmpl = data.factions[f.faction]!.units[crewTemplate]!;
  const def = input.catalog.vehicles[tmpl.vehicle!]!;
  const k = tmpl.members.findIndex((m) => def.seats.find((q) => q.id === m.seat)?.station === station);
  for (const u of f.units.flatMap((x) => x.subunits)) if (u.vehicleId !== undefined && k >= 0) u.members[k]!.status = "killed";
  return input;
}

/** M7.6d: does the blue vehicle's first station carry an automatic grenade launcher? */
function isAglStation(data: DataSet, factions: [string, string], crewTemplates?: [string, string]): boolean {
  if (!crewTemplates) return false;
  const c = buildCatalog(data, [...factions]), vid = data.factions[factions[0]]!.units[crewTemplates[0]]!.vehicle!;
  return c.vehicles[vid]!.stations.some((sn) => sn.weapons.some((w) => c.weapons[w.weapon]?.type === "grenade-machine-gun"));
}

export function gunneryLab(data: DataSet): GunneryRow[] {
  const rows: GunneryRow[] = [];
  for (const { factions, crewTemplates, tank } of PAIRS) {
    const W = tank ? TANK_FIELD_M : 2400;
    const mk = (lay: Layout) => duel(data, factions, lay, undefined, W, crewTemplates);
    // ---- armour-piercing at a halted hull side-on: share of the rounds fired in 90 s that hit
    for (const R of tank ? [1000, 2000, 3000] : [1000, 1500]) {
      const sim = createSim(stillTarget(mk({ blue: { x: 400, y: 600, heading: 0 }, red: { x: 400 + R, y: 600, heading: Math.PI / 2 } })));
      holdAll(sim);
      const b = crewOf(sim, "blue"), r = crewOf(sim, "red");
      const gunner = new Set(sim.state.unit.req(b.crew).members);
      submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: b.crew, kind: "fire", x: 400 + R, y: 600, heightM: 1.2, nature: "ap" });
      let shots = 0, hits = 0;
      run(sim, 90, (e) => {
        if (e.kind === "shot.fired" && e.vehicle === b.vid) shots++;
        else if (e.kind === "vehicle.hit" && e.vehicle === r.vid && gunner.has(e.owner)) hits += e.rounds;
      });
      rows.push({ vehicle: b.type, case: `AP at a halted hull side-on, ${R} m: share of ${shots} rounds that hit`, value: shots > 0 ? hits / shots : 0, unit: "share" });
    }
    // ---- on the move: driving across at the slow pace, target 800 m off (tanks: 1500 m)
    {
      const D = tank ? 1500 : 800;
      const sim = createSim(stillTarget(mk({ blue: { x: 400, y: 300, heading: Math.PI / 2 }, red: { x: 400 + D, y: 600, heading: Math.PI / 2 } })));
      holdAll(sim);
      const b = crewOf(sim, "blue"), r = crewOf(sim, "red");
      const gunner = new Set(sim.state.unit.req(b.crew).members);
      const pace = Object.entries(sim.ctx.catalog.movementModes).filter(([, m]) => m.class === sim.ctx.catalog.vehicles[b.type]!.class).sort((p, q) => ((p[1] as { speedFraction: number }).speedFraction - (q[1] as { speedFraction: number }).speedFraction))[0]![0];
      submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: b.crew, kind: "move", waypoints: [{ x: 400, y: 1100, mode: pace }] });
      run(sim, 3, () => undefined);
      submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: b.crew, kind: "fire", x: 400 + D, y: 600, heightM: 1.2, nature: "ap" });
      let shots = 0, hits = 0;
      run(sim, 40, (e) => {
        if (e.kind === "shot.fired" && e.vehicle === b.vid) shots++;
        else if (e.kind === "vehicle.hit" && e.vehicle === r.vid && gunner.has(e.owner)) hits += e.rounds;
      });
      rows.push({ vehicle: b.type, case: `AP on the move (${(Math.abs(sim.state.vehicle.req(b.vid).drive.speed) * 3.6).toFixed(0)} km/h) at a hull ${D} m off: share of ${shots} rounds that hit`, value: shots > 0 ? hits / shots : 0, unit: "share" });
    }
    // ---- laying: the target 90 degrees off the turret's front; order to first round
    {
      const sim = createSim(mk({ blue: { x: 1200, y: 900, heading: 0 }, red: { x: 1200, y: 200, heading: 0 } }));
      holdAll(sim);
      const b = crewOf(sim, "blue");
      const t0 = sim.state.tick;
      submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: b.crew, kind: "fire", x: 1200, y: 200, heightM: 1.2, nature: "ap" });
      let first = -1;
      run(sim, 30, (e) => { if (first < 0 && e.kind === "shot.fired" && e.vehicle === b.vid) first = (e.tick - t0) / 60; });
      rows.push({ vehicle: b.type, case: "order to first round, target 90 deg off the turret, 700 m (orders delay included)", value: first, unit: "s" });
    }
    // ---- M7.6a: the rate of a single-round gun: seconds between rounds while an armour-piercing order runs at
    // its full rate (shooting.json fire.fullRateSeconds; then it trickles), a full crew; again with the loader
    // (a loaded gun) or the gunner (an autoloader: the commander fires) killed
    if (tank) {
      const blueT = crewTemplates![0];
      const seats = data.factions[factions[0]]!.units[blueT]!.members.map((m) => m.seat);
      const rate = (kill: string | null) => {
        let input = stillTarget(mk({ blue: { x: 400, y: 600, heading: 0 }, red: { x: 1900, y: 600, heading: Math.PI / 2 } }));
        if (kill) input = killBlueSeat(data, input, blueT, kill);
        const sim = createSim(input);
        holdAll(sim);
        const b = crewOf(sim, "blue");
        const t0 = sim.state.tick, full = sim.ctx.catalog.shooting.fire.fullRateSeconds;
        submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: b.crew, kind: "fire", x: 1900, y: 600, heightM: 1.2, nature: "ap" });
        const all: number[] = [];
        run(sim, 60, (e) => { if (e.kind === "shot.fired" && e.vehicle === b.vid) all.push(e.tick - t0); });
        const ticks = all.filter((t) => t <= full * 60);
        // (Review fix: the load runs within the post-shot interval, so after fullRateSeconds the trickle shows.)
        const late = all.filter((t) => t > full * 60 + 60), lateGap = late.length > 1 ? (late[late.length - 1]! - late[0]!) / 60 / (late.length - 1) : -1;
        return { cycle: ticks.length > 1 ? (ticks[ticks.length - 1]! - ticks[0]!) / 60 / (ticks.length - 1) : -1, n: ticks.length, in60: all.length, lateGap, type: b.type };
      };
      const full = rate(null);
      rows.push({ vehicle: full.type, case: `seconds between AP rounds at the full rate (first 30 s of an order, ${full.n} rounds), 1500 m`, value: full.cycle, unit: "s" });
      rows.push({ vehicle: full.type, case: "AP rounds in the first 60 s of an order (30 s full rate, then the trickle)", value: full.in60, unit: "rounds" });
      rows.push({ vehicle: full.type, case: "seconds between AP rounds after the full rate (the trickle, from 31 s)", value: full.lateGap, unit: "s" });
      const def = buildCatalog(data, [...factions]).vehicles[full.type]!;
      const hasLoader = seats.some((sid) => def.seats.find((q) => q.id === sid)?.station === "loader");
      const k = rate(hasLoader ? "loader" : "gunner");
      rows.push({ vehicle: full.type, case: hasLoader ? `same, the loader killed: the commander loads (${k.n} rounds)` : `same, the gunner killed: the commander fires (${k.n} rounds)`, value: k.cycle, unit: "s" });
    }
    // ---- high explosive at a group of six standing men, 600 m
    {
      const sim = createSim(mk({ blue: { x: 400, y: 600, heading: 0 }, red: { x: W - 100, y: 1100, heading: 0 }, redSquadAt: { x: 1000, y: 600, spacing: 3 } }));
      holdAll(sim);
      const b = crewOf(sim, "blue");
      submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: b.crew, kind: "fire", x: 1000, y: 600, heightM: 0, nature: "he" });
      let shots = 0;
      const hit = new Set<EntityId>();
      run(sim, 45, (e) => { if (e.kind === "shot.fired" && e.vehicle === b.vid) shots++; else if (e.kind === "wound" && sim.state.identity.get(e.soldier)?.side === "red") hit.add(e.soldier); });
      rows.push({ vehicle: b.type, case: `HE at six men 600 m off, 45 s (${shots} rounds): men wounded or killed`, value: hit.size, unit: "men" });
    }
    // ---- M7.6d: an automatic grenade launcher on the station: the first burst's mean miss from the aim point
    // (the drop table's laying at long range) and men down among six standing at 600 / 1000 / 1500 m in 60 s
    if (isAglStation(data, factions, crewTemplates)) {
      for (const R of [600, 1000, 1500]) {
        const sim = createSim(mk({ blue: { x: 300, y: 600, heading: 0 }, red: { x: W - 100, y: 1100, heading: 0 }, redSquadAt: { x: 300 + R, y: 600, spacing: 3 } }));
        holdAll(sim);
        const b = crewOf(sim, "blue");
        submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: b.crew, kind: "fire", x: 300 + R, y: 600, heightM: 0, nature: "he" });
        let shots = 0;
        const miss: number[] = [], hit = new Set<EntityId>(), down = new Set<EntityId>();
        const own = new Set(sim.state.unit.req(b.crew).members);
        let aim: { x: number; y: number } | null = null;
        run(sim, 60, (e) => {
          if (e.kind === "shot.fired" && e.vehicle === b.vid) shots++;
          // (Balance pass 6: an ordered fire at a point is swept; the miss counts from the point the burst was laid on.)
          else if (e.kind === "vehicle.areaFire" && e.vehicle === b.vid && aim === null) aim = { x: e.x, y: e.y };
          else if (e.kind === "explosion" && own.has(e.owner) && miss.length < 3) miss.push(Math.hypot(e.x - (aim?.x ?? 300 + R), e.y - (aim?.y ?? 600)));
          else if (e.kind === "wound" && sim.state.identity.get(e.soldier)?.side === "red") hit.add(e.soldier);
          else if (e.kind === "casualty" && sim.state.identity.get(e.soldier)?.side === "red") down.add(e.soldier);
        });
        rows.push({ vehicle: b.type, case: `GMW: mean miss of the first burst's ${miss.length} rounds from the aim point, ${R} m`, value: miss.length > 0 ? miss.reduce((a, x) => a + x, 0) / miss.length : -1, unit: "m" });
        rows.push({ vehicle: b.type, case: `GMW at six standing men ${R} m off, 60 s (${shots} rounds): men hit / down`, value: hit.size, unit: `men (${down.size} down)` });
      }
    }
    // ---- ammunition: a long order empties the HE belt, the crew refills it from stowage, halted (Q17)
    {
      const sim = createSim(mk({ blue: { x: 400, y: 600, heading: 0 }, red: { x: W - 100, y: 1100, heading: 0 } }));
      holdAll(sim);
      const b = crewOf(sim, "blue");
      const v = sim.state.vehicle.req(b.vid), c = sim.state.container.req(b.vid);
      const rounds = () => {
        let ready = 0, stowed = 0;
        for (const st of v.stations) for (const w of st.weapons) for (const f of w.feeds) ready += f.rounds;
        const belts = new Set(v.stations.flatMap((st) => st.weapons.flatMap((w) => w.feeds.map((f) => f.item))));
        for (const s of c.stacks) if (belts.has(s.type)) stowed += (s.charge ?? 0) * s.count;
        return { ready, stowed };
      };
      const before = rounds();
      let fired = 0, refillStart = -1, refillEnd = -1;
      // The cannon's high explosive if its belts are stowed too (Puma, the tanks), else the machine gun (BMP-2).
      const cat = sim.ctx.catalog;
      const heBelt = v.stations[0]!.weapons.flatMap((w) => w.feeds).find((f) => cat.ammo[cat.items[f.item]?.chargeItem ?? ""]?.explosive !== undefined && cat.ammo[cat.items[f.item]?.chargeItem ?? ""]?.guided === undefined)?.item;
      const nature = heBelt !== undefined && c.stacks.some((st) => st.type === heBelt) ? "he" : "mg";
      const order = () => submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: b.crew, kind: "fire", x: 1400, y: 600, heightM: 0, nature });
      order();
      for (let k = 0; k < 40; k++) {
        run(sim, 10, (e) => {
          if (e.kind === "shot.fired" && e.vehicle === b.vid) fired++;
          else if (e.kind === "action.started" && e.action === "reloadStation" && refillStart < 0) refillStart = e.tick / 60;
          else if (e.kind === "action.completed" && e.action === "reloadStation" && refillEnd < 0) refillEnd = e.tick / 60;
        });
        if (!v.stations[0]!.task) order();
      }
      const after = rounds();
      rows.push({ vehicle: b.type, case: `rounds fired in 400 s of ordered fire (${nature === "he" ? "cannon HE" : "machine gun"})`, value: fired, unit: "rounds" });
      rows.push({ vehicle: b.type, case: "rounds fired - (ready + stowed before - after): 0 = every round counted", value: fired - (before.ready + before.stowed - after.ready - after.stowed), unit: "rounds" });
      rows.push({ vehicle: b.type, case: "refilling a ready belt from stowage, halted (owner Q17)", value: refillEnd >= 0 && refillStart >= 0 ? refillEnd - refillStart : -1, unit: "s" });
    }
    // ---- M7.6a: the crew's own choice of round at an enemy tank side-on (fire free): 1 = its missile, 0 = AP
    // (tanks with a gun-launched missile)
    const blueVeh = tank ? data.factions[factions[0]]!.units[crewTemplates![0]]!.vehicle! : "";
    const hasMissile = tank && buildCatalog(data, [...factions]).vehicles[blueVeh]!.stations.some((sn) => sn.weapons.some((w) => w.missileBeyondM !== undefined));
    if (hasMissile) {
      for (const R of [1500, 3000]) {
        const sim = createSim(stillTarget(mk({ blue: { x: 400, y: 600, heading: 0 }, red: { x: 400 + R, y: 600, heading: Math.PI / 2 } })));
        holdAll(sim);
        const b = crewOf(sim, "blue");
        submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: b.crew, kind: "rules", fire: "free" });
        let nature = -1, why = "";
        run(sim, 60, (e) => {
          if (nature >= 0 || e.kind !== "shot.fired" || e.vehicle !== b.vid) return;
          nature = sim.ctx.catalog.ammo[e.ammo]?.guided !== undefined ? 1 : 0;
          why = sim.state.vehicle.req(b.vid).stations[0]!.why.keys.find((k) => k.startsWith("why.nature.")) ?? "";
        });
        rows.push({ vehicle: b.type, case: `own choice at a tank side-on ${R} m, fire free: 1 = missile, 0 = AP (${why || "no shot"})`, value: nature, unit: "choice" });
      }
    }
  }
  return rows;
}

export function gunneryLabMarkdown(rows: GunneryRow[]): string {
  const fmt = (r: GunneryRow) => (r.unit === "share" ? `${Math.round(r.value * 100)} %` : r.unit === "s" || r.unit === "m" ? r.value.toFixed(1) : String(r.value));
  return ["| vehicle | case | value | unit |", "|---|---|---:|---|", ...rows.map((r) => `| ${r.vehicle} | ${r.case} | ${fmt(r)} | ${r.unit === "share" ? "" : r.unit} |`)].join("\n");
}
