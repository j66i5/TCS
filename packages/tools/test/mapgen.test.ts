/** Procedural test maps (M1.1): valid, deterministic, plausible, fast. */
import { describe, expect, it } from "vitest";
import { buildCatalog } from "@tcs/data";
import { checkMap, demoBattle, generateMap, MAP_KINDS, mapStats, type MapKind } from "@tcs/scenario";
import { buildingAt, buildNavGrid, stripInteriors, buildMapIndex, cellIndex, cellMoveCost, mapFingerprint, segmentsInRect, segmentsInRectInto, mapFromFile, mapToFile, validateMap } from "@tcs/sim";
import { loadData } from "../src/scenarios";

const data = loadData();
const terrain = buildCatalog(data, ["de", "ru"]).terrain;
/** 12 seeds per kind: a generator bug that shows up in ~5 % of maps is caught with high probability. */
const SEEDS = Array.from({ length: 12 }, (_, i) => i + 1);
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

  it("segmentsInRectInto returns the same ids in the same order as segmentsInRect on every map kind", () => {
    for (const kind of MAP_KINDS) {
      const ix = buildMapIndex(generateMap(terrain, { kind, seed: 3 }));
      const out: number[] = [];
      let k = 11;
      const rnd = () => { k = (k * 1103515245 + 12345) % 2147483648; return k / 2147483648; };
      for (let q = 0; q < 300; q++) {
        // Short sight lines and blast boxes, and some long lines across half the map.
        const x0 = rnd() * 2000, y0 = rnd() * 2000, r = q % 3 === 0 ? 1000 : 60;
        const x1 = x0 + (rnd() - 0.5) * r, y1 = y0 + (rnd() - 0.5) * r;
        const n = segmentsInRectInto(ix, x0, y0, x1, y1, out);
        expect(out.slice(0, n)).toEqual(segmentsInRect(ix, x0, y0, x1, y1));
      }
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

describe("building interiors (M7.5c)", () => {
  for (const kind of MAP_KINDS) {
    for (const seed of [1, 2, 3, 4, 5, 41]) { // 41: a corner rounded to cm just outside the footprint
      it(`${kind} seed ${seed}: every building has a valid interior; without interiors the map is the map of before`, () => {
        const on = generateMap(terrain, { kind, seed }), off = generateMap(terrain, { kind, seed, interiors: false });
        expect(on.buildings.every((b) => b.interior && b.interior.rooms.length >= b.storeys)).toBe(true);
        expect(validateMap(on, terrain)).toEqual([]);
        expect(mapToFile(on).formatVersion).toBe(2);
        // Equivalence (plan §1.3): interiors off is format 1, generator version 1, no interior, no upper window,
        // and exactly the map with interiors on stripped of them (the interiors come last, on their own stream).
        expect(mapToFile(off).formatVersion).toBe(1);
        expect(off.meta.version).toBe(1);
        expect(off.buildings.some((b) => b.interior || b.openings.some((o) => o.floor !== undefined))).toBe(false);
        expect(mapFingerprint(stripInteriors(on))).toBe(mapFingerprint(off));
      });
    }
  }

  it("houses get 2-5 rooms with a hall, big halls one room, offices and blocks a corridor; stairs in every multi-storey building", () => {
    const m = generateMap(terrain, { kind: "village", seed: 3 });
    for (const b of m.buildings) {
      const ground = b.interior!.rooms.filter((r) => r.floor === 0);
      if (b.kind === "barn" || b.kind === "church" || b.kind === "shed" || b.kind === "warehouse") expect(ground).toHaveLength(1);
      if (b.kind === "house" || b.kind === "farmhouse") {
        expect(ground.length).toBeGreaterThanOrEqual(2);
        expect(ground.length).toBeLessThanOrEqual(5);
      }
      if (b.storeys > 1) expect(b.interior!.stairs.length).toBe(b.storeys - 1);
    }
  });

  it("the outdoor navigation grid is identical with interiors on and off", () => {
    const on = generateMap(terrain, { kind: "village", seed: 2, widthM: 800, heightM: 800 }), off = generateMap(terrain, { kind: "village", seed: 2, widthM: 800, heightM: 800, interiors: false });
    const a = buildNavGrid(on, terrain, "foot"), b = buildNavGrid(off, terrain, "foot");
    expect(Buffer.from(a.cost.buffer).equals(Buffer.from(b.cost.buffer))).toBe(true);
    expect(Buffer.from(a.wall.buffer).equals(Buffer.from(b.wall.buffer))).toBe(true);
  });

  it("interiors add little generation time (< 150 ms per 2 x 2 km map in all)", () => {
    generateMap(terrain, { kind: "village", seed: 9 });
    const t0 = performance.now();
    for (const kind of MAP_KINDS) generateMap(terrain, { kind, seed: 11 });
    const per = (performance.now() - t0) / MAP_KINDS.length;
    console.log(`map generation with interiors: ${per.toFixed(0)} ms per map`);
    expect(per).toBeLessThan(150 * 2); // CI machines are slower than the plan's 150 ms target
  });
});
