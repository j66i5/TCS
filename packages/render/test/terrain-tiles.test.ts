/**
 * The terrain tile pyramid's own rules (review fix: only the pure queue was tested), with a fake tile source:
 * level choice (device ratio, max level, the budget cap over the view), the strips replacing and then freeing the
 * placeholder, the opening prime ahead of the strips and resolving, coarser tiles kept under missing ones, eviction
 * never dropping tiles in view and keeping its byte count, and the switch to painting here after a worker failure.
 */
import { describe, expect, it } from "vitest";
import { TerrainTiles, type TerrainTilesOptions, type TileSource } from "../src/terrain-tiles";
import { TileQueue, type TileJob } from "../src/tile-queue";
import { deviceTier, photoTileOptions } from "../src/renderer";
import { PhotoPainter, photoInit } from "../src/photo/paint";
import { buildAppearance, buildCatalog } from "@tcs/data";
import { generateMap } from "@tcs/scenario";
import { getScenario, loadData } from "../../tools/src/scenarios";

const data = loadData();
const map = getScenario("platoon").build(data, 1, 600).map;
const paint = (j: TileJob) => new Uint8Array(Math.round(j.w * j.ppm) * Math.round(j.h * j.ppm) * 4);
const base = () => new Uint8Array(Math.round(map.widthM) * Math.round(map.heightM) * 4);

/** Paints only when told (like a worker); can be made to fail. */
class FakeSource implements TileSource {
  busy: TileJob[] = [];
  broken = false;
  constructor(private q: TileQueue, private cap = 2) {}
  pump(q: TileQueue): void { while (this.busy.length < this.cap) { const j = q.next(); if (!j) return; this.busy.push(j); } }
  finish(n = Infinity): void { for (const j of this.busy.splice(0, n)) this.q.done(j, paint(j)); }
  /** Like a worker's onerror: the tiles in flight are given back to the queue. */
  breakNow(): void { this.broken = true; for (const j of this.busy.splice(0)) this.q.fail(j); }
  failed(): boolean { return this.broken; }
  destroy(): void { this.busy = []; }
}

const opts = (o: Partial<TerrainTilesOptions> = {}): TerrainTilesOptions => ({
  levels: [{ tileM: 128, ppm: 2, minPx: 2 }, { tileM: 64, ppm: 4, minPx: 4.5 }, { tileM: 32, ppm: 8, minPx: 11 }],
  sampling: "linear", mipmaps: false, budgetBytes: 40 * 1024 * 1024, fadeFrames: 0, dpr: 1, maxLevel: 3, byBand: false,
  strips: 4, stripPpm: 1, maxInFlight: 4, maxUploads: 8, ...o,
});
const make = (o: Partial<TerrainTilesOptions> = {}) => {
  const q = new TileQueue(4, 8), src = new FakeSource(q);
  const t = new TerrainTiles(map, base(), paint, src, opts(o), q);
  return { t, q, src };
};
const view = (x: number, y: number, w: number, h: number) => ({ x, y, w, h });

describe("terrain tiles", () => {
  it("chooses the level by screen px per metre, the device ratio and the max level", () => {
    const { t } = make();
    expect(t.levelFor(1, false)).toBe(0);
    expect(t.levelFor(2, false)).toBe(1);
    expect(t.levelFor(5, false)).toBe(2);
    expect(t.levelFor(12, false)).toBe(3);
    expect(make({ dpr: 2 }).t.levelFor(6, false)).toBe(3);
    expect(make({ maxLevel: 2 }).t.levelFor(20, false)).toBe(2);
  });

  it("drops to a coarser level when the view's tiles would not fit three quarters of the budget", () => {
    const { t } = make({ budgetBytes: 8 * 1024 * 1024 }); // 16 tiles of 256 px (counted twice): 12 fit
    expect(t.levelFor(5, false, view(0, 0, 100, 100))).toBe(2); // 2 x 2 tiles of 64 m
    expect(t.levelFor(5, false, view(0, 0, 600, 600))).toBe(0); // 10 x 10 of 64 m do not fit, nor 5 x 5 of 128 m
    expect(t.levelFor(5, false, view(0, 0, 300, 300))).toBe(1); // 25 of 64 m no, 9 of 128 m yes
  });

  it("the opening prime goes ahead of the whole-map strips and resolves when its tiles are painted", async () => {
    const { t, src } = make();
    let done = false;
    const p = t.prime(view(200, 200, 60, 60), 5, false).then(() => { done = true; });
    // The fake worker took the prime's tiles first, not the strips queued at map load.
    expect(src.busy.length).toBeGreaterThan(0);
    expect(src.busy.every((j) => j.level === 2)).toBe(true);
    for (let i = 0; i < 10 && !done; i++) { src.finish(); t.update(view(200, 200, 60, 60), 5, false, false); await Promise.resolve(); }
    await p;
    expect(done).toBe(true);
  });

  it("frees the placeholder once all strips are in; the strips stay under detail tiles that are not complete", () => {
    const { t, src } = make();
    expect(t.placeholderHeld).toBe(true);
    const v = view(0, 0, 200, 200);
    for (let i = 0; i < 30; i++) { t.update(v, 1, false, false); src.finish(); }
    expect(t.pending()).toBe(0);
    expect(t.placeholderHeld).toBe(false);
  });

  it("keeps coarser tiles under a level still painting, so there are no holes", () => {
    const { t, src } = make();
    const v = view(0, 0, 200, 200);
    for (let i = 0; i < 30; i++) { t.update(v, 2.5, false, false); src.finish(); } // level 1 complete
    expect(t.shownLevel).toBe(1);
    t.update(v, 5, false, false); // level 2 asked for, nothing painted yet
    expect(t.shownLevel).toBe(2);
    const l1 = (t.root.children.filter((c) => c.children?.length) as { children: { visible: boolean }[] }[])
      .flatMap((c) => c.children).filter((s) => s.visible);
    expect(l1.length).toBeGreaterThan(0);
  });

  it("evicts only tiles out of view and keeps its byte count right", () => {
    const { t, src } = make({ budgetBytes: 6 * 1024 * 1024, strips: 0 }); // 12 tiles of 256 px counted twice
    for (let x = 0; x < 1100; x += 64) {
      const v = view(x, 0, 120, 120);
      for (let i = 0; i < 4; i++) { t.update(v, 5, false, false); src.finish(); }
      expect(t.budgetUsed).toBeGreaterThan(0);
      expect(t.budgetUsed).toBeLessThanOrEqual(t.tilesHeld * 256 * 256 * 4 * 2); // (edge tiles are smaller)
      expect(t.budgetUsed).toBeLessThanOrEqual(6 * 1024 * 1024 + 4 * 256 * 256 * 8);
    }
    // The last view's tiles are all held.
    const v = view(1050, 0, 120, 120);
    t.update(v, 5, false, false); src.finish(); t.update(v, 5, false, false);
    expect(t.pending()).toBe(0);
  });

  it("paints here after a worker failure", () => {
    const { t, src } = make({ strips: 0 });
    const v = view(0, 0, 100, 100);
    t.update(v, 5, false, false);
    src.breakNow();
    for (let i = 0; i < 8; i++) t.update(v, 5, false, false);
    expect(t.pending()).toBe(0);
    expect(t.tilesHeld).toBe(4);
  });
});

describe("device tier", () => {
  it("a device without a fine pointer is a phone: never strong, one worker, levels by CSS px, 8 px/m at the opening zoom", () => {
    const g = globalThis as { matchMedia?: unknown };
    const had = g.matchMedia;
    try {
      g.matchMedia = () => ({ matches: false });
      const tier = deviceTier();
      expect(tier).toEqual({ phone: true, strong: false, workers: 1 });
      const o = photoTileOptions(map, tier, 3);
      expect(o.dpr).toBe(1);
      const t = new TerrainTiles(map, base(), paint, new SyncSourceless(), o);
      expect(t.levelFor(8, true)).toBe(3);
      g.matchMedia = () => ({ matches: true });
      expect(deviceTier().phone).toBe(false);
    } finally { g.matchMedia = had; }
  });
});

/** A source that never paints (level choice only). */
class SyncSourceless implements TileSource { pump(): void {} failed(): boolean { return false; } destroy(): void {} }

describe("photo apron at the map's top and left edges", () => {
  it("row 0 and column 0 of a tile at the origin are not darkened by the blur apron", () => {
    const cat = buildCatalog(data, ["de", "ru"]), app = buildAppearance(data, ["de", "ru"]);
    const m = generateMap(cat.terrain, { kind: "farmland", seed: 2, widthM: 600, heightM: 600 });
    const W = 256, img = new PhotoPainter(photoInit(m, cat.terrain, app)).paint(0, 0, 64, 64, 4, { features: false, vegetation: false });
    const lum = (i: number, j: number) => { const o = (j * W + i) * 4; return img[o]! + img[o + 1]! + img[o + 2]!; };
    let row0 = 0, row1 = 0, col0 = 0, col1 = 0;
    for (let k = 8; k < 248; k++) { row0 += lum(k, 0); row1 += lum(k, 1); col0 += lum(0, k); col1 += lum(1, k); }
    expect(row0 / row1).toBeGreaterThan(0.95);
    expect(col0 / col1).toBeGreaterThan(0.95);
  });
});
