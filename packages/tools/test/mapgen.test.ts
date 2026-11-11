/** Procedural test maps (M1.1): valid, deterministic, plausible, fast. */
import { describe, expect, it } from "vitest";
import { buildCatalog } from "@tcs/data";
import { checkMap, demoBattle, generateMap, MAP_KINDS, mapStats, type MapKind } from "@tcs/scenario";
import { buildingAt, cellIndex, cellMoveCost, mapFingerprint, mapFromFile, mapToFile, validateMap } from "@tcs/sim";
import { loadData } from "../src/scenarios";

const data = loadData();
const terrain = buildCatalog(data, ["de", "ru"]).terrain;
const SEEDS = [1, 2, 3];
const share = (r: Record<string, number>, ...ids: string[]) => ids.reduce((s, id) => s + (r[id] ?? 0), 0);

/** Plausibility bands per map kind. */
const BANDS: Record<MapKind, (s: ReturnType<typeof mapStats>) => void> = {
  village: (s) => {
    expect(s.buildingCount).toBeGreaterThanOrEqual(30);
    expect(share(s.buildings, "house", "farmhouse")).toBeGreaterThanOrEqual(15);
    expect(s.buildings["church"]).toBe(1);
    expect(share(s.vegetation, "woodland")).toBeLessThan(0.25);
  },
  woodland: (s) => {
    expect(share(s.vegetation, "woodland")).toBeGreaterThan(0.3);
    expect(share(s.vegetation, "woodland")).toBeLessThan(0.65);
    expect(s.buildingCount).toBeGreaterThanOrEqual(5);
  },
  farmland: (s) => {
    expect(share(s.surface, "stubble", "ploughed", "meadow", "grass")).toBeGreaterThan(0.6);
    expect(s.obstacleM["hedge"] ?? 0).toBeGreaterThan(1000);
    expect(s.buildingCount).toBeGreaterThanOrEqual(3);
  },
  industrial: (s) => {
    expect(s.buildings["warehouse"] ?? 0).toBeGreaterThanOrEqual(4);
    expect((s.obstacleM["wire-fence"] ?? 0) + (s.obstacleM["concrete-wall"] ?? 0)).toBeGreaterThan(800);
    expect(s.obstacleM["embankment"] ?? 0).toBeGreaterThan(1000);
  },
};

describe("procedural maps", () => {
  for (const kind of MAP_KINDS) {
    for (const seed of SEEDS) {
      it(`${kind} seed ${seed}: valid, fits the data, plausible`, () => {
        const m = generateMap(terrain, { kind, seed });
        expect(m.widthM).toBe(2000);
        expect(checkMap(m)).toEqual([]);
        expect(validateMap(m, terrain)).toEqual([]);
        const s = mapStats(m);
        expect(s.heightMax - s.heightMin).toBeGreaterThan(2);
        expect(s.heightMax - s.heightMin).toBeLessThan(80);
        BANDS[kind](s);
      });
    }
  }

  it("is deterministic: same seed same map, different seed different map", () => {
    for (const kind of MAP_KINDS) {
      const a = mapFingerprint(generateMap(terrain, { kind, seed: 5 }));
      expect(mapFingerprint(generateMap(terrain, { kind, seed: 5 }))).toBe(a);
      expect(mapFingerprint(generateMap(terrain, { kind, seed: 6 }))).not.toBe(a);
    }
  });

  it("villages come in both styles (street and clustered) depending on the seed", () => {
    const styles = new Set([1, 2, 3, 4, 5, 6].map((seed) => generateMap(terrain, { kind: "village", seed }).name.split("(")[1]));
    expect(styles).toEqual(new Set(["street)", "clustered)"]));
  });

  it("generates a 2 x 2 km map in well under a second", () => {
    generateMap(terrain, { kind: "village", seed: 9 }); // warm-up
    const t0 = performance.now();
    for (const kind of MAP_KINDS) generateMap(terrain, { kind, seed: 10 });
    const per = (performance.now() - t0) / MAP_KINDS.length;
    console.log(`map generation: ${per.toFixed(0)} ms per 2 x 2 km map`);
    expect(per).toBeLessThan(1000);
  });

  it("saves to the map file format and loads back identically", () => {
    const m = generateMap(terrain, { kind: "village", seed: 2 });
    const text = JSON.stringify(mapToFile(m));
    expect(mapFingerprint(mapFromFile(JSON.parse(text)))).toBe(mapFingerprint(m));
    console.log(`village map file: ${(text.length / 1024).toFixed(0)} KB`);
  });

  it("demo battles start every soldier on passable open ground, not in a building", () => {
    for (const kind of MAP_KINDS) {
      const input = demoBattle(data, { seed: 3, factions: ["de", "ru"], mapKind: kind, unitsPerSide: 3 });
      for (const f of input.forces) for (const p of f.placements) {
        const c = cellIndex(input.map, p.x, p.y);
        expect(c).toBeGreaterThanOrEqual(0);
        expect(cellMoveCost(input.map, input.catalog.terrain, c, "foot")).not.toBeNull();
        expect(buildingAt(input.map, p.x, p.y)).toBeNull();
      }
    }
  });
});
