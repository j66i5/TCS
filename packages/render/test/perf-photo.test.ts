/**
 * PHOTO MAP PAINT COST (plan "photo" step "ground"; timing test, run alone with `test:perf`). In the app this runs in a
 * worker (off the main thread); here in Node, warm. Budgets: the per-map preparation <= 150 ms for 1200 x 900 m and
 * <= 400 ms for 2000 x 2000 m; a ground-only 64 m tile at 4 px/m median <= 16 ms, p90 <= 30 ms; the whole map at
 * 1 px/m (1200 x 900 m, four strips, with trees and hedges) <= 1.0 s. Step "vegetation": a woodland 64 m tile at 4 px/m
 * median <= 25 ms, p90 <= 45 ms, max <= 90 ms; the crown stamps <= 10 ms per resolution.
 */
import { describe, expect, it } from "vitest";
import { buildAppearance, buildCatalog } from "@tcs/data";
import { generateMap } from "@tcs/scenario";
import { PhotoPainter, photoInit } from "../src/photo/paint";
import { preparePhoto } from "../src/photo/prep";
import { buildStamps } from "../src/photo/crowns";
import { loadData } from "../../tools/src/scenarios";

const best = (n: number, f: () => void) => { let b = Infinity; for (let i = 0; i < n; i++) { const t = performance.now(); f(); b = Math.min(b, performance.now() - t); } return b; };

describe("photo map paint cost", () => {
  const data = loadData();
  const cat = buildCatalog(data, ["de", "ru"]);
  const app = buildAppearance(data, ["de", "ru"]);
  it("prepares a map, paints tiles and the whole map within budget", () => {
    const map = generateMap(cat.terrain, { kind: "village", seed: 1, widthM: 1200, heightM: 900 });
    const init = photoInit(map, cat.terrain, app);
    const prep = best(3, () => preparePhoto(map, init.col, init.grade));
    const big = generateMap(cat.terrain, { kind: "farmland", seed: 1, widthM: 2000, heightM: 2000 });
    const bigInit = photoInit(big, cat.terrain, app);
    const prepBig = best(2, () => preparePhoto(big, bigInit.col, bigInit.grade));
    const p = new PhotoPainter(init);
    for (let k = 0; k < 16; k++) { p.paint(64 * k, 64, 64, 64, 4, { features: false }); p.paint(64 * k, 128, 64, 64, 4); } // warm-up (JIT)
    const ground: number[] = [], full: number[] = [];
    for (let k = 0; k < 30; k++) {
      const x = 64 * (k % 15) + 128, y = 64 * Math.floor(k / 15) * 4 + 192;
      let t = performance.now(); p.paint(x, y, 64, 64, 4, { features: false }); ground.push(performance.now() - t);
      t = performance.now(); p.paint(x, y, 64, 64, 4); full.push(performance.now() - t);
    }
    ground.sort((a, b) => a - b); full.sort((a, b) => a - b);
    const q = (a: number[], f: number) => a[Math.min(a.length - 1, Math.floor(a.length * f))]!;
    const l0 = best(2, () => { for (let s = 0; s < 4; s++) p.paint(0, s * 225, 1200, 225, 1); });
    const l3 = best(5, () => p.paint(512, 384, 32, 32, 8));
    console.log(`photo: prep ${prep.toFixed(0)} ms (1200 x 900), ${prepBig.toFixed(0)} ms (2000 x 2000); L2 tile ground median ${q(ground, 0.5).toFixed(1)} p90 ${q(ground, 0.9).toFixed(1)} ms, with provisional features median ${q(full, 0.5).toFixed(1)} p90 ${q(full, 0.9).toFixed(1)} ms; L3 tile ${l3.toFixed(1)} ms; L0 1200 x 900 ${l0.toFixed(0)} ms`);
    expect(prep).toBeLessThanOrEqual(150);
    expect(prepBig).toBeLessThanOrEqual(400);
    expect(q(ground, 0.5)).toBeLessThanOrEqual(16);
    expect(q(ground, 0.9)).toBeLessThanOrEqual(30);
    expect(l0).toBeLessThanOrEqual(1000);
  });

  it("paints woods (crowns, shadows) and builds crown stamps within budget", () => {
    const map = generateMap(cat.terrain, { kind: "woodland", seed: 1, widthM: 1200, heightM: 900 });
    const p = new PhotoPainter(photoInit(map, cat.terrain, app));
    for (let k = 0; k < 16; k++) p.paint(64 * k, 192, 64, 64, 4); // warm-up (JIT)
    const t: number[] = [];
    for (let k = 0; k < 30; k++) {
      const x = 64 * (k % 15) + 64, y = 64 * Math.floor(k / 15) * 4 + 128, s = performance.now();
      p.paint(x, y, 64, 64, 4); t.push(performance.now() - s);
    }
    t.sort((a, b) => a - b);
    const stamps = [1, 2, 4, 8].map((ppm) => best(5, () => buildStamps(ppm)));
    const l0 = best(2, () => { for (let s = 0; s < 4; s++) p.paint(0, s * 225, 1200, 225, 1); });
    console.log(`photo woodland: L2 tile median ${t[15]!.toFixed(1)} p90 ${t[27]!.toFixed(1)} max ${t[29]!.toFixed(1)} ms; stamps ${stamps.map((v) => v.toFixed(1)).join(" / ")} ms at 1/2/4/8 px/m; L0 1200 x 900 ${l0.toFixed(0)} ms`);
    expect(t[15]!).toBeLessThanOrEqual(25);
    expect(t[27]!).toBeLessThanOrEqual(45);
    expect(t[29]!).toBeLessThanOrEqual(90);
    for (const v of stamps) expect(v).toBeLessThanOrEqual(10);
    expect(l0).toBeLessThanOrEqual(1000);
  });
});
