/**
 * Gunnery lab (M7.3): turrets, cannon and coaxial machine guns from orders only, on a flat field. Each case is
 * a fresh battle built from the vehicle scenario with the vehicles and men placed for it (battle input, not
 * state): hits of armour-piercing rounds on a halted hull side-on, on the move, the time a turret takes to lay
 * on a target 90 degrees off, high explosive at a group of men, and the ammunition count with a refill from
 * stowage (rule 9, owner Q17). The bands asserted in `lab-gunnery.test.ts` are game values.
 */
import type { DataSet } from "@tcs/data";
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
export function duel(data: DataSet, factions: [string, string], lay: Layout, squadTemplates?: [string, string]): BattleInput {
  const input = vehicleBattle(data, { seed: 3, factions, vehiclesPerPlatoon: 1, mapWidthM: 2400, mapHeightM: 1200, timeLimitSeconds: 3600, ...(squadTemplates ? { squadTemplates } : {}) });
  input.forces.forEach((f, s) => {
    const p = s === 0 ? lay.blue : lay.red;
    for (const vp of f.vehiclePlacements ?? []) { vp.x = p.x; vp.y = p.y; vp.heading = p.heading; }
    const crewIds = new Set(f.units.flatMap((u) => u.subunits).filter((u) => u.vehicleId !== undefined).flatMap((u) => u.members.map((m) => m.personId)));
    let k = 0;
    for (const pl of f.placements) {
      if (crewIds.has(pl.personId)) { pl.x = p.x; pl.y = p.y; continue; }
      if (s === 1 && lay.redSquadAt) { pl.x = lay.redSquadAt.x; pl.y = lay.redSquadAt.y + (k++ - 2.5) * lay.redSquadAt.spacing; pl.heading = Math.PI; continue; }
      pl.x = s === 0 ? 20 : 2380; pl.y = 20 + 3 * k++; // out of the way, far apart
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

const PAIRS: { factions: [string, string] }[] = [{ factions: ["de", "ru"] }, { factions: ["ru", "de"] }];

export function gunneryLab(data: DataSet): GunneryRow[] {
  const rows: GunneryRow[] = [];
  for (const { factions } of PAIRS) {
    // ---- armour-piercing at a halted hull side-on: hits among the first 20 rounds
    for (const R of [1000, 1500]) {
      const sim = createSim(duel(data, factions, { blue: { x: 400, y: 600, heading: 0 }, red: { x: 400 + R, y: 600, heading: Math.PI / 2 } }));
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
    // ---- on the move: driving across at the slow pace, target 800 m off
    {
      const sim = createSim(duel(data, factions, { blue: { x: 400, y: 300, heading: Math.PI / 2 }, red: { x: 1200, y: 600, heading: Math.PI / 2 } }));
      holdAll(sim);
      const b = crewOf(sim, "blue"), r = crewOf(sim, "red");
      const gunner = new Set(sim.state.unit.req(b.crew).members);
      const pace = Object.entries(sim.ctx.catalog.movementModes).filter(([, m]) => m.class === sim.ctx.catalog.vehicles[b.type]!.class).sort((p, q) => ((p[1] as { speedFraction: number }).speedFraction - (q[1] as { speedFraction: number }).speedFraction))[0]![0];
      submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: b.crew, kind: "move", waypoints: [{ x: 400, y: 1100, mode: pace }] });
      run(sim, 3, () => undefined);
      submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: b.crew, kind: "fire", x: 1200, y: 600, heightM: 1.2, nature: "ap" });
      let shots = 0, hits = 0;
      run(sim, 40, (e) => {
        if (e.kind === "shot.fired" && e.vehicle === b.vid) shots++;
        else if (e.kind === "vehicle.hit" && e.vehicle === r.vid && gunner.has(e.owner)) hits += e.rounds;
      });
      rows.push({ vehicle: b.type, case: `AP on the move (${(Math.abs(sim.state.vehicle.req(b.vid).drive.speed) * 3.6).toFixed(0)} km/h) at a hull 800 m off: share of ${shots} rounds that hit`, value: shots > 0 ? hits / shots : 0, unit: "share" });
    }
    // ---- laying: the target 90 degrees off the turret's front; order to first round
    {
      const sim = createSim(duel(data, factions, { blue: { x: 1200, y: 900, heading: 0 }, red: { x: 1200, y: 200, heading: 0 } }));
      holdAll(sim);
      const b = crewOf(sim, "blue");
      const t0 = sim.state.tick;
      submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: b.crew, kind: "fire", x: 1200, y: 200, heightM: 1.2, nature: "ap" });
      let first = -1;
      run(sim, 30, (e) => { if (first < 0 && e.kind === "shot.fired" && e.vehicle === b.vid) first = (e.tick - t0) / 60; });
      rows.push({ vehicle: b.type, case: "order to first round, target 90 deg off the turret, 700 m (orders delay included)", value: first, unit: "s" });
    }
    // ---- high explosive at a group of six standing men, 600 m
    {
      const sim = createSim(duel(data, factions, { blue: { x: 400, y: 600, heading: 0 }, red: { x: 2300, y: 1100, heading: 0 }, redSquadAt: { x: 1000, y: 600, spacing: 3 } }));
      holdAll(sim);
      const b = crewOf(sim, "blue");
      submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: b.crew, kind: "fire", x: 1000, y: 600, heightM: 0, nature: "he" });
      let shots = 0;
      const hit = new Set<EntityId>();
      run(sim, 45, (e) => { if (e.kind === "shot.fired" && e.vehicle === b.vid) shots++; else if (e.kind === "wound" && sim.state.identity.get(e.soldier)?.side === "red") hit.add(e.soldier); });
      rows.push({ vehicle: b.type, case: `HE at six men 600 m off, 45 s (${shots} rounds): men wounded or killed`, value: hit.size, unit: "men" });
    }
    // ---- ammunition: a long order empties the HE belt, the crew refills it from stowage, halted (Q17)
    {
      const sim = createSim(duel(data, factions, { blue: { x: 400, y: 600, heading: 0 }, red: { x: 2300, y: 1100, heading: 0 } }));
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
      // The cannon's high explosive if its belts are stowed too (Puma), else the machine gun (BMP-2).
      const cat = sim.ctx.catalog;
      const heBelt = v.stations[0]!.weapons.flatMap((w) => w.feeds).find((f) => cat.ammo[cat.items[f.item]?.chargeItem ?? ""]?.explosive !== undefined)?.item;
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
  }
  return rows;
}

export function gunneryLabMarkdown(rows: GunneryRow[]): string {
  const fmt = (r: GunneryRow) => (r.unit === "share" ? `${Math.round(r.value * 100)} %` : r.unit === "s" ? r.value.toFixed(1) : String(r.value));
  return ["| vehicle | case | value | unit |", "|---|---|---:|---|", ...rows.map((r) => `| ${r.vehicle} | ${r.case} | ${fmt(r)} | ${r.unit === "share" ? "" : r.unit} |`)].join("\n");
}
