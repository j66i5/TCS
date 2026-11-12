import { describe, expect, it } from "vitest";
import {
  buildMapIndex, cellIndex, cellMoveCost, createSim, flatMap, fromBase64, hashState, heightAt, loadSim, mapFingerprint,
  mapFromFile, mapToFile, saveSim, segmentsInRect, segmentsInRectInto, surfaceAt, toBase64, validateMap, type MapDef,
} from "../src/index";
import { testCatalog, testInput } from "./helpers";

function smallMap(): MapDef {
  const m = flatMap("t", 40, 20, 4); // 10 x 5 cells
  m.surfacePalette = ["grass", "water"];
  m.surface[cellIndex(m, 10, 10)] = 1;
  m.vegetationPalette = ["wood"];
  m.vegetation[cellIndex(m, 30, 2)] = 1;
  // heights: rising 1 m per corner column
  for (let r = 0; r <= m.rows; r++) for (let c = 0; c <= m.cols; c++) m.heights[r * (m.cols + 1) + c] = c;
  m.obstacles.push({ id: 1, kind: "wall", points: [5, 5, 35, 5], heightM: 2, thicknessM: 0.25, material: "brick" });
  return m;
}

describe("terrain queries", () => {
  it("interpolates heights bilinearly and clamps outside the map", () => {
    const m = smallMap();
    expect(heightAt(m, 0, 0)).toBe(0);
    expect(heightAt(m, 4, 0)).toBe(1);
    expect(heightAt(m, 6, 3)).toBeCloseTo(1.5, 12);
    expect(heightAt(m, -100, 7)).toBe(0);
    expect(heightAt(m, 1000, 7)).toBe(10);
  });

  it("reads surface and vegetation and combines movement costs; water and woods block vehicles", () => {
    const m = smallMap();
    expect(surfaceAt(m, 10, 10)).toBe("water");
    expect(surfaceAt(m, 1, 1)).toBe("grass");
    expect(surfaceAt(m, -1, 1)).toBeNull();
    const t = testCatalog.terrain;
    expect(cellMoveCost(m, t, cellIndex(m, 10, 10), "foot")).toBeNull();
    expect(cellMoveCost(m, t, cellIndex(m, 1, 1), "wheeled")).toBeCloseTo(1.4);
    expect(cellMoveCost(m, t, cellIndex(m, 30, 2), "foot")).toBeCloseTo(1.25);
    expect(cellMoveCost(m, t, cellIndex(m, 30, 2), "wheeled")).toBeNull();
  });

  it("indexes wall segments for neighbourhood queries", () => {
    const m = smallMap();
    const ix = buildMapIndex(m, 8);
    expect(segmentsInRect(ix, 30, 0, 32, 8)).toEqual([0]);
    expect(segmentsInRect(ix, 0, 15, 40, 20)).toEqual([]);
  });

  it("segmentsInRectInto returns the same ids in the same order as segmentsInRect", () => {
    // Many short walls in all directions, so rectangles collect from many buckets (both sort paths).
    const m = flatMap("t", 400, 300, 4);
    let k = 7;
    const rnd = () => { k = (k * 1103515245 + 12345) % 2147483648; return k / 2147483648; };
    for (let i = 0; i < 300; i++) {
      const x = rnd() * 400, y = rnd() * 300, n = 2 + Math.floor(rnd() * 4), pts = [x, y];
      for (let j = 1; j < n; j++) pts.push(Math.min(399, Math.max(0, pts[pts.length - 2]! + (rnd() - 0.5) * 60)), Math.min(299, Math.max(0, pts[pts.length - 2]! + (rnd() - 0.5) * 60)));
      m.obstacles.push({ id: i + 1, kind: "wall", points: pts, heightM: 2, thicknessM: 0.25, material: "brick" });
    }
    const ix = buildMapIndex(m, 32);
    const out: number[] = [];
    for (let q = 0; q < 400; q++) {
      const x0 = rnd() * 420 - 10, y0 = rnd() * 320 - 10, x1 = rnd() * 420 - 10, y1 = rnd() * 320 - 10;
      const n = segmentsInRectInto(ix, x0, y0, x1, y1, out);
      expect(out.slice(0, n)).toEqual(segmentsInRect(ix, x0, y0, x1, y1));
    }
  });

  it("validates a map against the data", () => {
    const m = smallMap();
    expect(validateMap(m, testCatalog.terrain)).toEqual([]);
    m.surfacePalette.push("lava");
    m.obstacles.push({ id: 2, kind: "moat", points: [0, 0, 1, 1], heightM: 1, thicknessM: 1, material: "brick" });
    expect(validateMap(m, testCatalog.terrain)).toEqual(["unknown surface 'lava'", "obstacle 2: unknown kind 'moat'"]);
  });
});

describe("map file format", () => {
  it("base64 round-trips any byte sequence", () => {
    for (let n = 0; n < 12; n++) {
      const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 97 + n * 13) & 255);
      expect([...fromBase64(toBase64(bytes))]).toEqual([...bytes]);
    }
  });

  it("round-trips a map exactly through JSON", () => {
    const m = smallMap();
    m.heights[3] = 12.34567;
    const back = mapFromFile(JSON.parse(JSON.stringify(mapToFile(m))));
    expect(mapFingerprint(back)).toBe(mapFingerprint(m));
    expect([...back.heights]).toEqual([...m.heights]);
    expect(back.obstacles).toEqual(m.obstacles);
  });

  it("rejects corrupt files", () => {
    const f = mapToFile(smallMap());
    expect(() => mapFromFile({ ...f, cols: 11 })).toThrow(/does not cover/);
    const m = smallMap();
    m.cols = 8;
    expect(validateMap(m, testCatalog.terrain)[0]).toMatch(/does not cover/);
  });
});

describe("terrain damage is battle state", () => {
  it("is saved, hashed and restored; saves refuse a different map", () => {
    const input = testInput();
    const sim = createSim(input);
    const h0 = hashState(sim.state);
    sim.state.terrain.craters.push({ x: 50, y: 50, radiusM: 2, depthM: 0.8, tick: 0 });
    expect(hashState(sim.state)).not.toBe(h0);
    const save = JSON.parse(JSON.stringify(saveSim(sim)));
    expect(loadSim(input, save).state.terrain.craters).toHaveLength(1);
    expect(() => loadSim({ ...input, map: flatMap("other", 200, 200) }, save)).toThrow(/made on map/);
  });
});
