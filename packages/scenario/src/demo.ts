/**
 * Demo / test scenarios for the foundations. The real scenario format and procedural generator
 * (attack, defence, meeting engagement, ...) arrive in M6; this builds simple BattleInputs from data.
 */
import { buildCatalog, type DataSet } from "@tcs/data";
import {
  buildingAt, cellIndex, cellMoveCost, cos, DEFAULT_COMMS, flatMap, PI, sin,
  type BattleInput, type BattleRules, type Catalog, type ForceInput, type MapDef, type Order, type Placement,
} from "@tcs/sim";
import { allMembers, buildForce } from "./forces";
import { generateMap, type MapKind } from "./mapgen/index";

export interface DemoOptions {
  seed: number;
  /** Faction per side, e.g. ["de", "ru"]. */
  factions: [string, string];
  /** Unit template per side; defaults to "demo-team". */
  templates?: [string, string];
  /** Number of units per side (each built from the template). */
  unitsPerSide?: number;
  mapWidthM?: number;
  mapHeightM?: number;
  /** Generated map kind; omitted = flat empty map. */
  mapKind?: MapKind;
  /** Map seed (defaults to the battle seed). */
  mapSeed?: number;
  timeLimitSeconds?: number;
  orders?: Order[];
}

export const SIDES = ["blue", "red"] as const;

export function defaultRules(timeLimitSeconds = 600): BattleRules {
  return {
    timeLimitSeconds,
    commsModel: "simple",
    comms: { ...DEFAULT_COMMS },
    physiologyModel: "none",
    physiologyParams: {},
    objectives: [],
  };
}

/** Two forces facing each other across a flat map: blue in the west, red in the east. */
export function demoBattle(data: DataSet, opts: DemoOptions): BattleInput {
  const catalog = buildCatalog(data, [...opts.factions]);
  const map = opts.mapKind
    ? generateMap(catalog.terrain, { kind: opts.mapKind, seed: opts.mapSeed ?? opts.seed, widthM: opts.mapWidthM ?? 2000, heightM: opts.mapHeightM ?? 2000 })
    : flatMap("demo-flat", opts.mapWidthM ?? 400, opts.mapHeightM ?? 300);
  const width = map.widthM;
  const height = map.heightM;
  const per = opts.unitsPerSide ?? 1;
  const forces: ForceInput[] = SIDES.map((side, s) => {
    const faction = opts.factions[s]!;
    const template = opts.templates?.[s] ?? "demo-team";
    const units = Array.from({ length: per }, (_, i) =>
      buildForce(data, { faction, template, seed: opts.seed * 31 + s * 7 + i, keyPrefix: `${side}-${i + 1}`, number: i + 1 }),
    );
    const placements: Placement[] = [];
    units.forEach((u, ui) => {
      const men = allMembers(u);
      const cy = (height * (ui + 1)) / (per + 1);
      const x = s === 0 ? width * 0.15 : width * 0.85;
      men.forEach((m, mi) => {
        // A loose line, 6 m apart, across the axis of advance; nudged onto open, passable ground.
        const dy = (mi - (men.length - 1) / 2) * 6;
        const p = freeSpot(map, catalog, x, cy + dy);
        placements.push({ personId: m.personId, x: p.x, y: p.y, heading: s === 0 ? 0 : PI });
      });
    });
    return { side, faction, units, placements };
  });
  return {
    map,
    catalog,
    forces,
    rules: defaultRules(opts.timeLimitSeconds ?? 600),
    seed: opts.seed,
    orders: opts.orders ?? [],
  };
}

/** Nearest point (searching outward in rings) that is on foot-passable ground and not inside a building. */
export function freeSpot(map: MapDef, catalog: Catalog, x: number, y: number): { x: number; y: number } {
  const ok = (px: number, py: number) => {
    const c = cellIndex(map, px, py);
    if (c < 0) return false;
    const cost = cellMoveCost(map, catalog.terrain, c, "foot");
    return cost !== null && map.surfacePalette[map.surface[c]!] !== "floor" && buildingAt(map, px, py) === null;
  };
  if (ok(x, y)) return { x, y };
  for (let r = 2; r < 400; r += 2) {
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * 2 * PI;
      const px = x + r * cos(a), py = y + r * sin(a);
      if (ok(px, py)) return { x: px, y: py };
    }
  }
  return { x, y };
}
