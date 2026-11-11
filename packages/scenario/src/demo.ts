/**
 * Demo / test scenarios for the foundations. The real scenario format and procedural generator
 * (attack, defence, meeting engagement, ...) arrive in M6; this builds simple BattleInputs from data.
 */
import { buildCatalog, type DataSet } from "@tcs/data";
import {
  DEFAULT_COMMS, flatMap, PI, type BattleInput, type BattleRules, type ForceInput, type Order, type Placement,
} from "@tcs/sim";
import { allMembers, buildForce } from "./forces";

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
  const width = opts.mapWidthM ?? 400;
  const height = opts.mapHeightM ?? 300;
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
        // A loose line, 6 m apart, across the axis of advance.
        const dy = (mi - (men.length - 1) / 2) * 6;
        placements.push({ personId: m.personId, x, y: cy + dy, heading: s === 0 ? 0 : PI });
      });
    });
    return { side, faction, units, placements };
  });
  return {
    map: flatMap("demo-flat", width, height),
    catalog: buildCatalog(data, [...opts.factions]),
    forces,
    rules: defaultRules(opts.timeLimitSeconds ?? 600),
    seed: opts.seed,
    orders: opts.orders ?? [],
  };
}
