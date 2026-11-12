/**
 * Mount lab (M7.2): how long a squad takes to get into and out of its vehicle, from orders only. Each vehicle
 * type with its faction's squad standing 10 m beside it on a flat field: "mount" (walk over, ramp, one man per
 * exit at a time), "dismount" (ramp, one man per exit), and an order to the squad aboard (it gets out first, Q12).
 */
import type { DataSet } from "@tcs/data";
import { vehicleBattle } from "@tcs/scenario";
import { createSim, step, submitOrder, type EntityId, type Sim, type SimEvent } from "@tcs/sim";

export interface MountRow { vehicle: string; case: string; value: number; unit: string }

const CASES: { factions: [string, string]; squad: string }[] = [
  { factions: ["de", "ru"], squad: "pzgren-schuetzentrupp" },
  { factions: ["ru", "de"], squad: "motor-rifle-squad" },
  { factions: ["xf", "de"], squad: "porter-gang" },
];

function until(sim: Sim, seconds: number, done: (e: SimEvent) => boolean): number | null {
  const t0 = sim.state.tick;
  for (let i = 0; i < seconds * 60; i++) for (const e of step(sim)) if (done(e)) return (sim.state.tick - t0) / 60;
  return null;
}

export function mountLab(data: DataSet): MountRow[] {
  const rows: MountRow[] = [];
  for (const c of CASES) {
    if (!data.factions[c.factions[0]]) continue;
    const input = vehicleBattle(data, { seed: 1, factions: c.factions, squadTemplates: [c.squad, data.factions[c.factions[1]]!.manifest.demoTemplate ?? "demo-team"], vehiclesPerPlatoon: 1, mapWidthM: 800, mapHeightM: 600, timeLimitSeconds: 3600 });
    const sim = createSim(input);
    const v = [...sim.state.vehicle.entries()].find(([, x]) => x.side === "blue")!;
    const vid: EntityId = v[0], type = v[1].def;
    const squad = [...sim.state.unit.entries()].find(([, u]) => u.side === "blue" && u.carrier === vid)![0];
    const men = sim.state.unit.req(squad).members.length;
    const seats = input.catalog.vehicles[type]!.seats.filter((s) => s.station === "passenger").length;
    rows.push({ vehicle: type, case: "men in the squad / passenger seats", value: men * 100 + seats, unit: "men*100+seats" });
    const order = (body: Record<string, unknown>, target = squad) => submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target, ...body } as never);
    order({ kind: "mount" });
    rows.push({ vehicle: type, case: "mount from 10 m (order to all aboard)", value: until(sim, 300, (e) => e.kind === "unit.mounted") ?? -1, unit: "s" });
    // mounted: ok the lab counts the men aboard
    rows.push({ vehicle: type, case: "men aboard after mounting", value: sim.state.unit.req(squad).members.filter((m) => sim.state.soldier.req(m).mount?.vehicle === vid).length, unit: "men" });
    order({ kind: "dismount" });
    rows.push({ vehicle: type, case: "dismount (order to all out)", value: until(sim, 300, (e) => e.kind === "unit.dismounted") ?? -1, unit: "s" });
    order({ kind: "mount" });
    until(sim, 300, (e) => e.kind === "unit.mounted");
    const t = sim.state.transform.req(vid);
    order({ kind: "move", waypoints: [{ x: Math.min(t.x + 60, 790), y: t.y + 40, mode: "walk" }] });
    rows.push({ vehicle: type, case: "move order to the squad aboard: out first, then in position (Q12)", value: until(sim, 300, (e) => e.kind === "unit.arrived" && e.unit === squad) ?? -1, unit: "s" });
  }
  return rows;
}

export function mountLabMarkdown(rows: MountRow[]): string {
  const fmt = (r: MountRow) => (r.unit === "men*100+seats" ? `${Math.floor(r.value / 100)} / ${r.value % 100}` : r.unit === "s" ? r.value.toFixed(1) : String(r.value));
  return ["| vehicle | case | value | unit |", "|---|---|---:|---|", ...rows.map((r) => `| ${r.vehicle} | ${r.case} | ${fmt(r)} | ${r.unit === "men*100+seats" ? "men / seats" : r.unit} |`)].join("\n");
}
