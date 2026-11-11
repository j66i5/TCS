/**
 * COVER LAB (SPEC 5.4): what stops a rifle bullet. One panel of a given material and thickness, bullets fired
 * square-on from 50 m and 300 m; plus a flight table (speed, drop, time of flight by range).
 * Anchored to public figures collected in docs/research/ballistics.md.
 */
import { buildCatalog, type DataSet } from "@tcs/data";
import {
  createSim, DEFAULT_COMMS, flatMap, launchProjectile, step, ticksToSeconds, type BattleInput, type Catalog, type MapDef, type Sim,
} from "@tcs/sim";

function labSim(catalog: Catalog, map: MapDef): Sim {
  const input: BattleInput = {
    map, catalog, seed: 1, orders: [], forces: [],
    rules: { timeLimitSeconds: 3600, commsModel: "simple", comms: { ...DEFAULT_COMMS }, physiologyModel: "none", physiologyParams: {}, objectives: [] },
  };
  return createSim(input);
}

export interface FlightRow { weapon: string; ammo: string; rangeM: number; speedMps: number; dropM: number; timeS: number }

/** Speed, drop and time of flight at each range, for every weapon/ammunition pair of the given factions. */
export function flightTable(catalog: Catalog, ranges = [0, 100, 200, 300, 400, 500]): FlightRow[] {
  const rows: FlightRow[] = [];
  for (const w of Object.values(catalog.weapons).sort((a, b) => (a.id < b.id ? -1 : 1))) {
    for (const [ammo, v0] of Object.entries(w.ammo).sort()) {
      const sim = labSim(catalog, flatMap("flight", 900, 40, 4));
      launchProjectile(sim.ctx, sim.state, ammo, 5, 20, 100, v0, 0, 0, 0);
      const P = sim.state.projectiles;
      let next = 0;
      while (P.count > 0 && next < ranges.length) {
        const d = P.x[0]! - 5;
        if (d >= ranges[next]!) {
          rows.push({ weapon: w.id, ammo, rangeM: ranges[next]!, speedMps: Math.hypot(P.vx[0]!, P.vy[0]!, P.vz[0]!), dropM: 100 - P.z[0]!, timeS: ticksToSeconds(sim.state.tick) });
          next++;
        }
        step(sim);
      }
    }
  }
  return rows;
}

export interface Panel { name: string; material: string; thicknessM: number }

/** Panels of battlefield cover. Thicknesses are typical real ones. */
export const PANELS: Panel[] = [
  { name: "hedge, 1.5 m", material: "hedge", thicknessM: 1.5 },
  { name: "wooden fence, 4 cm", material: "wood", thicknessM: 0.04 },
  { name: "car door (2 mm sheet)", material: "sheet-metal", thicknessM: 0.002 },
  { name: "pine log wall, 41 cm", material: "wood", thicknessM: 0.41 },
  { name: "mild steel plate, 9.5 mm", material: "steel", thicknessM: 0.0095 },
  { name: "mild steel plate, 20 mm", material: "steel", thicknessM: 0.02 },
  { name: "concrete wall, 5 cm", material: "concrete", thicknessM: 0.05 },
  { name: "single brick, 11 cm", material: "brick", thicknessM: 0.11 },
  { name: "double brick, 24 cm", material: "brick", thicknessM: 0.24 },
  { name: "sandbags, 25 cm", material: "soil", thicknessM: 0.25 },
  { name: "sandbag wall, 45 cm", material: "soil", thicknessM: 0.45 },
  { name: "reinforced concrete, 20 cm", material: "reinforced-concrete", thicknessM: 0.2 },
  { name: "stone wall, 50 cm", material: "stone", thicknessM: 0.5 },
];

export interface CoverRow { panel: string; ammo: string; rangeM: number; penetrated: number; speedInMps: number; speedOutMps: number }

/** Fire `shots` bullets square-on at each panel from each range; share penetrating and mean speed behind it. */
export function coverTable(catalog: Catalog, ammoIds: string[], ranges = [50, 300], shots = 20): CoverRow[] {
  const rows: CoverRow[] = [];
  const muzzle = (ammo: string) => Math.max(...Object.values(catalog.weapons).map((w) => w.ammo[ammo] ?? 0));
  for (const panel of PANELS) {
    for (const ammo of ammoIds) {
      for (const range of ranges) {
        const map = flatMap("cover", range + 60, 60, 4);
        map.obstacles.push({ id: 1, kind: "brick-wall", points: [range + 10, 0, range + 10, 60], heightM: 30, thicknessM: panel.thicknessM, material: panel.material });
        const sim = labSim(catalog, map);
        // Small spread of muzzle velocities (+-2 %), as between real rounds: a mixed cell means "marginal".
        for (let k = 0; k < shots; k++) launchProjectile(sim.ctx, sim.state, ammo, 10, 10 + k * 2, 15, muzzle(ammo) * (0.98 + (0.04 * k) / (shots - 1)), 0, 0, k + 1);
        const P = sim.state.projectiles;
        let pen = 0, vin = 0, vout = 0, hits = 0;
        for (let t = 0; t < 120 && hits < shots; t++) {
          const before = new Map<number, number>();
          for (let i = 0; i < P.count; i++) before.set(P.owner[i]!, Math.hypot(P.vx[i]!, P.vy[i]!, P.vz[i]!));
          for (const e of step(sim)) {
            if (e.kind !== "impact" || e.surface !== "obstacle") continue;
            hits++;
            vin += before.get(e.owner) ?? 0;
            if (e.result === "penetrated") {
              pen++;
              for (let i = 0; i < P.count; i++) if (P.owner[i] === e.owner) vout += Math.hypot(P.vx[i]!, P.vy[i]!, P.vz[i]!);
            }
          }
        }
        rows.push({ panel: panel.name, ammo, rangeM: range, penetrated: pen / shots, speedInMps: vin / Math.max(1, hits), speedOutMps: pen > 0 ? vout / pen : 0 });
      }
    }
  }
  return rows;
}

/**
 * One bullet fired square-on at a panel `rangeM` away; `velocityScale` varies the muzzle velocity (to check
 * that a result does not hinge on a few m/s). Square-on penetration has no randomness.
 */
export function shotPasses(catalog: Catalog, ammo: string, material: string, thicknessM: number, rangeM: number, velocityScale = 1): boolean {
  const map = flatMap("shot", rangeM + 60, 40, 4);
  map.obstacles.push({ id: 1, kind: "brick-wall", points: [rangeM + 10, 0, rangeM + 10, 40], heightM: 200, thicknessM, material });
  const sim = labSim(catalog, map);
  const v0 = Math.max(...Object.values(catalog.weapons).map((w) => w.ammo[ammo] ?? 0)) * velocityScale;
  launchProjectile(sim.ctx, sim.state, ammo, 10, 20, 100, v0, 0, 0, 1);
  for (let t = 0; t < 600; t++) {
    for (const e of step(sim)) if (e.kind === "impact" && e.surface === "obstacle") return e.result === "penetrated";
    if (sim.state.projectiles.count === 0) return false;
  }
  return false;
}

export function coverLab(data: DataSet): { flight: FlightRow[]; cover: CoverRow[]; ammo: string[] } {
  const catalog = buildCatalog(data, ["de", "ru"]);
  const ammo = catalog.ammoIds.filter((id) => catalog.ammo[id]!.kind === "ball");
  return { flight: flightTable(catalog), cover: coverTable(catalog, ammo), ammo };
}

export function coverLabMarkdown(r: ReturnType<typeof coverLab>): string {
  const lines: string[] = ["### Flight", "", "| weapon | ammunition | range m | speed m/s | drop m | time s |", "|---|---|---:|---:|---:|---:|"];
  for (const f of r.flight) lines.push(`| ${f.weapon} | ${f.ammo} | ${f.rangeM} | ${f.speedMps.toFixed(0)} | ${f.dropM.toFixed(2)} | ${f.timeS.toFixed(2)} |`);
  lines.push("", "### Cover: does it stop a bullet fired square-on? (speed in m/s before -> behind the panel)", "");
  const cols = r.ammo.flatMap((a) => [50, 300].map((rg) => ({ a, rg })));
  lines.push(`| panel | ${cols.map((c) => `${c.a} @ ${c.rg} m`).join(" | ")} |`, `|---|${cols.map(() => "---").join("|")}|`);
  for (const p of PANELS) {
    const cells = cols.map((c) => {
      const row = r.cover.find((x) => x.panel === p.name && x.ammo === c.a && x.rangeM === c.rg)!;
      if (row.penetrated === 0) return "stops";
      const speeds = `(${row.speedInMps.toFixed(0)} -> ${row.speedOutMps.toFixed(0)})`;
      return row.penetrated === 1 ? `passes ${speeds}` : `marginal: ${(row.penetrated * 100).toFixed(0)} % pass ${speeds}`;
    });
    lines.push(`| ${p.name} | ${cells.join(" | ")} |`);
  }
  return lines.join("\n");
}
