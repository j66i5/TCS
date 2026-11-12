/**
 * SCENARIO FORMAT AND GENERATOR (M6, owner decisions 2026-11-12): platoon against platoon, one side attacks,
 * the other defends; points for the objectives held at the end minus a share for men down; a side that breaks
 * or is wiped out loses at once.
 *
 * A scenario is plain data (`ScenarioDef`, JSON-safe): what kind of battle, the seed, the map kind, the faction
 * of each side and which side attacks. `buildScenario` turns it into a BattleInput deterministically (the same
 * definition always gives the same battle). Blue always starts in the west, red in the east; either may attack.
 */
import { buildCatalog, type DataSet } from "@tcs/data";
import { hypot2, type BattleInput, type ForceInput, type MapDef, type ObjectiveDef, type Placement, PI } from "@tcs/sim";
import { defaultRules, freeSpot, SIDES } from "./demo";
import { allMembers, buildForce } from "./forces";
import { generateMap, type MapKind } from "./mapgen/index";

export interface ScenarioDef {
  kind: "platoon-attack";
  seed: number;
  mapKind: MapKind;
  /** Faction of blue (west) and red (east). */
  factions: [string, string];
  /** Which side attacks: the other holds the objectives at the start. */
  attacker: "blue" | "red";
  /** Platoons on the attacking side (owner, M6 review: two against one); the defender always has one. */
  attackerPlatoons?: number;
  /** Unit template per side (defaults: the faction manifest's platoon template, else its demo template). */
  templates?: [string, string];
  timeLimitSeconds?: number;
  mapWidthM?: number;
  mapHeightM?: number;
}

/** Points of the main and the second objective, and what each man down costs his side. */
export const SCENARIO_POINTS = { main: 100, second: 50, perManDown: 5 } as const;

function centroid(c: number[]): { x: number; y: number } {
  let x = 0, y = 0;
  const n = c.length / 2;
  for (let i = 0; i < c.length; i += 2) { x += c[i]!; y += c[i + 1]!; }
  return { x: x / n, y: y / n };
}

/** The building nearest to a point within `maxM` (its centre), else the point itself. */
function nearBuilding(map: MapDef, x: number, y: number, maxM: number, not: { x: number; y: number }[] = []): { x: number; y: number } {
  let best: { x: number; y: number } | null = null, bestD = maxM;
  for (const b of map.buildings) {
    const c = centroid(b.footprint);
    if (not.some((p) => hypot2(p.x - c.x, p.y - c.y) < 80)) continue;
    const d = hypot2(c.x - x, c.y - y);
    if (d < bestD) { bestD = d; best = c; }
  }
  return best ?? { x, y };
}

export function buildScenario(data: DataSet, def: ScenarioDef): BattleInput {
  const catalog = buildCatalog(data, [...def.factions]);
  const W = def.mapWidthM ?? 1200, H = def.mapHeightM ?? 900;
  const map = generateMap(catalog.terrain, { kind: def.mapKind, seed: def.seed, widthM: W, heightM: H });
  const defender = def.attacker === "blue" ? "red" : "blue";
  // Objectives on the defender's side of the map: the main one at a building near its middle, the second at
  // another building (or the ground) on a flank.
  const dx = defender === "red" ? 1 : -1;
  const mainP = nearBuilding(map, W / 2 + dx * W * 0.2, H / 2, 250);
  let secondP = nearBuilding(map, W / 2 + dx * W * 0.1, H / 2 + (def.seed % 2 === 0 ? 1 : -1) * H * 0.2, 200, [mainP]);
  // The two areas never overlap (their radii are 40 and 30 m): at least 90 m apart.
  if (hypot2(secondP.x - mainP.x, secondP.y - mainP.y) < 90) secondP = { x: mainP.x, y: Math.min(Math.max(mainP.y + (mainP.y < H / 2 ? 1 : -1) * 120, 20), H - 20) };
  const objectives: ObjectiveDef[] = [
    { id: "main", nameKey: "objective.main", x: mainP.x, y: mainP.y, radiusM: 40, points: SCENARIO_POINTS.main, holder: defender },
    { id: "second", nameKey: "objective.second", x: secondP.x, y: secondP.y, radiusM: 30, points: SCENARIO_POINTS.second, holder: defender },
  ];
  const forces: ForceInput[] = SIDES.map((side, s) => {
    const faction = def.factions[s]!;
    const pack = data.factions[faction];
    const template = def.templates?.[s] ?? pack?.manifest.platoonTemplate ?? pack?.manifest.demoTemplate ?? "demo-team";
    const count = side === def.attacker ? Math.max(1, def.attackerPlatoons ?? 2) : 1;
    const units = Array.from({ length: count }, (_, k) => buildForce(data, { faction, template, seed: def.seed * 31 + s * 7 + k * 101, keyPrefix: `${side}-${k + 1}`, number: k + 1 }));
    const placements: Placement[] = [];
    const heading = side === "blue" ? 0 : PI; // facing the other side
    // Each sub-unit (squad) and each platoon's own men get a spot; men stand in a loose line, 6 m apart.
    const groups = units.flatMap((unit) => unit.subunits.length > 0 ? [unit.members, ...unit.subunits.map((u) => allMembers(u))].filter((g) => g.length > 0) : [allMembers(unit)]);
    groups.forEach((men, gi) => {
      let cx: number, cy: number;
      if (side === defender) {
        // Defence: the platoon's men behind the main objective's centre and two squads at its front corners (all
        // inside its 40 m ring), one squad at the second objective, in front of its centre.
        const spots = [{ x: mainP.x + dx * 10, y: mainP.y }, { x: mainP.x - dx * 14, y: mainP.y - 20 }, { x: mainP.x - dx * 14, y: mainP.y + 20 }, { x: secondP.x - dx * 8, y: secondP.y }];
        const sp = spots[Math.min(gi, spots.length - 1)]!;
        cx = sp.x; cy = sp.y;
      } else {
        // Attack: start in a line of squads near the own map edge, opposite the objectives.
        cx = side === "blue" ? W * 0.08 : W * 0.92;
        cy = H / 2 + (gi - (groups.length - 1) / 2) * (groups.length > 4 ? 45 : 70);
      }
      men.forEach((m, mi) => {
        const p = freeSpot(map, catalog, cx, cy + (mi - (men.length - 1) / 2) * 6);
        placements.push({ personId: m.personId, x: p.x, y: p.y, heading });
      });
    });
    return { side, faction, units, placements };
  });
  const rules = defaultRules(def.timeLimitSeconds ?? 2400);
  rules.objectives = objectives;
  rules.victory = { casualtyPoints: SCENARIO_POINTS.perManDown, endOnDefeat: true };
  return { map, catalog, forces, rules, seed: def.seed, orders: [] };
}
