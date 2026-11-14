/**
 * The photo map's built things (plan "photo" step "built"): roads, tracks, water, bridges, walls, building shadows and
 * roofs. Tiles cut through a road junction, a bridge and a wall corner join byte for byte with a larger picture at
 * 2, 4 and 8 px/m; roads, streams and walls keep their minimum widths at 1 px/m; tracks stand out from the fields on
 * both sides; water is the only bluish ground; roofs are deterministic (also after a map file round trip), lit from
 * the sun's side, within the saturation cap; in the photo look a roof sprite's alpha follows the roof-fade rule
 * exactly as the vector roof did.
 */
import { describe, expect, it } from "vitest";
import { buildAppearance, buildCatalog } from "@tcs/data";
import { generateMap } from "@tcs/scenario";
import { flatMap, mapFromFile, mapToFile, type Building, type MapDef } from "@tcs/sim";
import { PhotoPainter, photoInit } from "../src/photo/paint";
import { buildRoofAtlas, faceLight, paintRoof, roofStyle, ROOF_SAT } from "../src/photo/roof";
import { convexHull, polySd } from "../src/photo/lines";
import { BuildingLayers, EAVE_FLASH_FRAMES, ROOF_NEAR_M, buildingIndex, roofShown } from "../src/buildings";
import { loadData } from "../../tools/src/scenarios";

const data = loadData();
const cat = buildCatalog(data, ["de", "ru"]);
const app = buildAppearance(data, ["de", "ru"]);
type Kind = "village" | "farmland" | "industrial" | "woodland";
const maps: Record<string, MapDef> = {};
const painters: Record<string, PhotoPainter> = {};
const mapOf = (kind: Kind, seed = 1) => (maps[`${kind}${seed}`] ??= generateMap(cat.terrain, { kind, seed, widthM: 1200, heightM: 900 }));
const painterOf = (kind: Kind, seed = 1) => (painters[`${kind}${seed}`] ??= new PhotoPainter(photoInit(mapOf(kind, seed), cat.terrain, app)));
const lum = (b: Uint8Array, p: number) => 0.299 * b[p]! + 0.587 * b[p + 1]! + 0.114 * b[p + 2]!;
const roofColour = (b: Building) => app.photo?.roofs[b.kind] ?? app.map.roofs[b.kind] ?? 0x887766;

/** Distance from (x, y) to a polyline. */
function polyDist(p: readonly number[], x: number, y: number): number {
  let best = Infinity;
  for (let k = 0; k + 3 < p.length; k += 2) {
    const ax = p[k]!, ay = p[k + 1]!, ex = p[k + 2]! - ax, ey = p[k + 3]! - ay, L2 = ex * ex + ey * ey || 1e-9;
    const u = Math.max(0, Math.min(1, ((x - ax) * ex + (y - ay) * ey) / L2));
    best = Math.min(best, Math.hypot(x - ax - u * ex, y - ay - u * ey));
  }
  return best;
}

/** Where two segments cross, or null. */
function crossing(a: number[], b: number[]): { x: number; y: number } | null {
  for (let i = 0; i + 3 < a.length; i += 2) for (let j = 0; j + 3 < b.length; j += 2) {
    const [x1, y1, x2, y2, x3, y3, x4, y4] = [a[i]!, a[i + 1]!, a[i + 2]!, a[i + 3]!, b[j]!, b[j + 1]!, b[j + 2]!, b[j + 3]!];
    const d = (x2 - x1) * (y4 - y3) - (y2 - y1) * (x4 - x3);
    if (Math.abs(d) < 1e-9) continue;
    const t = ((x3 - x1) * (y4 - y3) - (y3 - y1) * (x4 - x3)) / d, u = ((x3 - x1) * (y2 - y1) - (y3 - y1) * (x2 - x1)) / d;
    if (t >= 0 && t <= 1 && u >= 0 && u <= 1) return { x: x1 + t * (x2 - x1), y: y1 + t * (y2 - y1) };
  }
  return null;
}

/** Features to cut tiles through: a road junction, a bridge (road over a stream), a wall corner. */
function feature(m: MapDef, what: "junction" | "bridge" | "wall"): { x: number; y: number } | null {
  const ok = (x: number, y: number) => x >= 140 && y >= 140 && x <= m.widthM - 270 && y <= m.heightM - 270;
  if (what === "junction") {
    for (const r of m.roads) for (const end of [0, r.points.length - 2]) {
      const x = r.points[end]!, y = r.points[end + 1]!;
      if (ok(x, y) && m.roads.some((q) => q !== r && polyDist(q.points, x, y) < 1)) return { x, y };
    }
  } else if (what === "bridge") {
    for (const r of m.roads) for (const w of m.water) if (w.kind === "stream") { const c = crossing(r.points, w.points); if (c && ok(c.x, c.y)) return c; }
  } else {
    for (const o of m.obstacles) if (o.kind.endsWith("-wall")) for (let k = 2; k + 3 < o.points.length; k += 2) if (ok(o.points[k]!, o.points[k + 1]!)) return { x: o.points[k]!, y: o.points[k + 1]! };
  }
  return null;
}

describe("photo built: roads, water, bridges, walls", () => {
  const cases: [Kind, "junction" | "bridge" | "wall", number][] = [["village", "junction", 2], ["village", "junction", 8], ["farmland", "bridge", 4], ["farmland", "bridge", 8], ["village", "wall", 4], ["village", "wall", 8]];
  for (const [kind, what, ppm] of cases) {
    it(`a tile cut through a ${what} at ${ppm} px/m equals the matching crop of a 3 x 3 tile picture (${kind})`, () => {
      const m = mapOf(kind), p = painterOf(kind), f = feature(m, what);
      expect(f, `${what} on ${kind}`).not.toBeNull();
      // The tile's corner on the feature: its edges cut through the road, the deck, the wall.
      const T = 256 / ppm, x0 = Math.round(f!.x), y0 = Math.round(f!.y);
      const tile = p.paint(x0, y0, T, T, ppm), big = p.paint(x0 - T, y0 - T, 3 * T, 3 * T, ppm);
      let diff = 0;
      for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
        const a = (y * 256 + x) * 4, b = ((y + 256) * 768 + x + 256) * 4;
        if (tile[a] !== big[b] || tile[a + 1] !== big[b + 1] || tile[a + 2] !== big[b + 2]) diff++;
      }
      expect(diff).toBe(0);
    });
  }

  it("keeps minimum widths at 1 px/m: roads >= 2 px, streams >= 2 px, walls >= 1 px clearly unlike the ground beside them", () => {
    const checked: Record<string, number> = { road: 0, stream: 0, wall: 0 };
    for (const kind of ["village", "farmland", "industrial", "woodland"] as const) {
      const m = mapOf(kind), img = painterOf(kind).paint(0, 0, m.widthM, m.heightM, 1), W = m.widthM;
      const lines = [
        ...m.roads.map((r) => ({ p: r.points, hw: r.widthM / 2, need: 2, what: "road" })),
        ...m.water.filter((w) => w.kind === "stream").map((w) => ({ p: w.points, hw: w.widthM / 2, need: 2, what: "stream" })),
        ...m.obstacles.filter((o) => o.kind.endsWith("-wall")).map((o) => ({ p: o.points, hw: o.thicknessM / 2, need: 1, what: "wall" })),
      ];
      for (const L of lines) {
        // The middle of the longest segment, away from other lines, buildings and trees.
        let best = -1, bl = 0;
        for (let k = 0; k + 3 < L.p.length; k += 2) { const l = Math.hypot(L.p[k + 2]! - L.p[k]!, L.p[k + 3]! - L.p[k + 1]!); if (l > bl) { bl = l; best = k; } }
        const wall = L.what === "wall", side = wall ? 4 : 6;
        if (bl < (wall ? 6 : 12)) continue;
        const ax = L.p[best]!, ay = L.p[best + 1]!, ux = (L.p[best + 2]! - ax) / bl, uy = (L.p[best + 3]! - ay) / bl, nx = -uy, ny = ux;
        const mx = ax + ux * bl / 2, my = ay + uy * bl / 2;
        const clear = (x: number, y: number) => x > 10 && y > 10 && x < m.widthM - 10 && y < m.heightM - 10
          && lines.every((o) => o === L || polyDist(o.p, x, y) > o.hw + 7)
          && m.buildings.every((b) => polySd(b.footprint, x, y) < (wall ? -5 : -10))
          && m.vegetation[Math.floor(y / m.cellSizeM) * m.cols + Math.floor(x / m.cellSizeM)] === 0;
        if (!clear(mx, my) || !clear(mx + nx * (side + 1), my + ny * (side + 1)) || !clear(mx - nx * (side + 1), my - ny * (side + 1))) continue;
        const at = (d: number) => { const x = Math.floor(mx + nx * d), y = Math.floor(my + ny * d); return { k: y * W + x, l: lum(img, (y * W + x) * 4) }; };
        const ground = (at(-side).l + at(side).l) / 2;
        const seen = new Set<number>();
        let n = 0;
        for (let d = -L.hw - 2; d <= L.hw + 2; d += 0.25) {
          const q = at(d);
          if (seen.has(q.k)) continue;
          seen.add(q.k);
          if (Math.abs(q.l - ground) / ground >= 0.1) n++;
        }
        expect(n, `${L.what} on ${kind} at ${mx.toFixed(0)},${my.toFixed(0)}`).toBeGreaterThanOrEqual(L.need);
        checked[L.what]!++;
      }
    }
    expect(checked["road"], JSON.stringify(checked)).toBeGreaterThanOrEqual(4);
    expect(checked["stream"], JSON.stringify(checked)).toBeGreaterThanOrEqual(1);
    expect(checked["wall"], JSON.stringify(checked)).toBeGreaterThanOrEqual(1);
  });

  it("tracks stand out from the fields on both sides (luminance at least 12 % apart, 1 px/m)", () => {
    let checked = 0;
    for (const kind of ["village", "farmland", "woodland"] as const) {
      const m = mapOf(kind), img = painterOf(kind).paint(0, 0, m.widthM, m.heightM, 1), W = m.widthM;
      for (const r of m.roads) {
        if (r.surface !== "dirt-track") continue;
        for (let k = 0; k + 3 < r.points.length; k += 2) {
          const ax = r.points[k]!, ay = r.points[k + 1]!, L = Math.hypot(r.points[k + 2]! - ax, r.points[k + 3]! - ay);
          if (L < 20) continue;
          const ux = (r.points[k + 2]! - ax) / L, uy = (r.points[k + 3]! - ay) / L, nx = -uy, ny = ux;
          const mx = ax + ux * L / 2, my = ay + uy * L / 2;
          const off = r.widthM / 2 + 3.5;
          const cellOk = (x: number, y: number) => { const c = Math.floor(y / m.cellSizeM) * m.cols + Math.floor(x / m.cellSizeM); return x > 5 && y > 5 && x < m.widthM - 5 && y < m.heightM - 5 && m.vegetation[c] === 0 && m.roads.every((q) => polyDist(q.points, x, y) > q.widthM / 2 + 2.5) && m.buildings.every((b) => polySd(b.footprint, x, y) < -8) && m.water.every((w) => polyDist(w.points, x, y) > 8); };
          if (!cellOk(mx + nx * off, my + ny * off) || !cellOk(mx - nx * off, my - ny * off)) continue;
          // Mean along 8 m of the track and of each side.
          const mean = (d: number) => { let s = 0; for (let t = -4; t <= 4; t++) { const x = Math.floor(mx + ux * t + nx * d), y = Math.floor(my + uy * t + ny * d); s += lum(img, (y * W + x) * 4); } return s / 9; };
          const tr = mean(0), a = mean(off), b = mean(-off);
          for (const side of [a, b]) expect(Math.max(tr, side) / Math.min(tr, side), `track on ${kind} at ${mx.toFixed(0)},${my.toFixed(0)}`).toBeGreaterThanOrEqual(1.12);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThanOrEqual(5);
  });

  it("water is the only bluish ground: its blue-minus-red is above every other ground pixel's", () => {
    for (const [kind, seed] of [["farmland", 1], ["village", 4]] as const) {
      const m = mapOf(kind, seed), img = painterOf(kind, seed).paint(0, 0, m.widthM, m.heightM, 1), W = m.widthM;
      const water: number[] = [], ground: number[] = [];
      for (let y = 0; y < m.heightM; y++) for (let x = 0; x < W; x++) {
        const cx = x + 0.5, cy = y + 0.5, o = (y * W + x) * 4, br = img[o + 2]! - img[o]!;
        let wd = Infinity;
        for (const w of m.water) wd = Math.min(wd, w.kind === "pond" ? -polySd(w.points, cx, cy) - 1.5 : polyDist(w.points, cx, cy) - w.widthM / 2);
        if (wd < -1) { if (m.roads.every((r) => polyDist(r.points, cx, cy) > r.widthM / 2 + 3)) water.push(br); }
        else if (wd > 4) ground.push(br);
      }
      water.sort((a, b) => a - b); ground.sort((a, b) => a - b);
      expect(water.length, kind).toBeGreaterThan(20);
      expect(water[Math.floor(water.length * 0.05)]!, kind).toBeGreaterThan(ground[ground.length - 1]!);
    }
  });
});

describe("photo roofs", () => {
  const house: Building = { id: 3, kind: "house", footprint: [10, 10, 22, 10, 22, 19, 10, 19], storeys: 2, storeyHeightM: 3, wallMaterial: "brick", wallThicknessM: 0.3, openings: [], roofColour: "#884433" };

  it("hipped, gabled and flat by kind and shape; faces toward the sun are lighter", () => {
    expect(roofStyle(house)).toBe("hip");
    expect(roofStyle({ ...house, kind: "barn" })).toBe("gable");
    expect(roofStyle({ ...house, footprint: [0, 0, 30, 0, 30, 8, 0, 8] })).toBe("gable");
    expect(roofStyle({ ...house, kind: "warehouse" })).toBe("flat");
    // Sun from the west-north-west: west > north > south > east.
    expect(faceLight(-1, 0)).toBeGreaterThan(faceLight(0, -1));
    expect(faceLight(0, -1)).toBeGreaterThan(faceLight(0, 1));
    expect(faceLight(0, 1)).toBeGreaterThan(faceLight(1, 0));
    // Painted: the west half of the hipped roof is lighter than the east half.
    const pic = paintRoof(house, 0x8a5a4a, 8);
    let w = 0, e = 0, nw = 0, ne = 0;
    for (let j = 0; j < pic.h; j++) for (let i = 0; i < pic.w; i++) {
      const x = (pic.gx0 + i + 0.5) / 8, y = (pic.gy0 + j + 0.5) / 8, o = (j * pic.w + i) * 4;
      if (pic.data[o + 3] !== 255 || y < 13 || y > 16) continue;
      if (x < 13) { w += lum(pic.data, o); nw++; } else if (x > 19) { e += lum(pic.data, o); ne++; }
    }
    expect(w / nw).toBeGreaterThan(1.3 * (e / ne));
  });

  it("paints the same bytes twice; premultiplied alpha, transparent outside the footprint; within the saturation cap", () => {
    for (const b of [house, { ...house, kind: "barn" }, { ...house, kind: "warehouse", footprint: [0, 0, 40, 0, 40, 25, 0, 25] }]) {
      const a = paintRoof(b, roofColour(b)), c = paintRoof(b, roofColour(b));
      expect(c.data).toEqual(a.data);
      let inside = 0;
      for (let i = 0; i < a.data.length; i += 4) {
        const al = a.data[i + 3]!;
        for (let ch = 0; ch < 3; ch++) expect(a.data[i + ch]!).toBeLessThanOrEqual(al);
        if (al === 255) {
          inside++;
          const r = a.data[i]!, g = a.data[i + 1]!, bl = a.data[i + 2]!, mx = Math.max(r, g, bl);
          expect((mx - Math.min(r, g, bl)) / mx).toBeLessThanOrEqual(ROOF_SAT + 0.02);
        }
      }
      expect(inside).toBeGreaterThan(100);
      expect(a.data[3]).toBe(0); // the corner pixel is outside
    }
  });

  it("the roof atlas is the same after a map file round trip, within 4 MB, every roof in its own rectangle", () => {
    for (const kind of ["village", "industrial"] as const) {
      const m = mapOf(kind, 3), trip = mapFromFile(JSON.parse(JSON.stringify(mapToFile(m))));
      const a = buildRoofAtlas(m.buildings, roofColour), b = buildRoofAtlas(trip.buildings, roofColour);
      expect(b.items).toEqual(a.items);
      expect(b.pages.length).toBe(a.pages.length);
      for (let i = 0; i < a.pages.length; i++) expect(b.pages[i]!.data).toEqual(a.pages[i]!.data);
      expect(a.bytes).toBeLessThanOrEqual(4 * 1024 * 1024);
      expect(a.items.length).toBe(m.buildings.length);
      // No two rectangles on a page overlap.
      for (let i = 0; i < a.items.length; i++) for (let j = i + 1; j < a.items.length; j++) {
        const p = a.items[i]!, q = a.items[j]!;
        if (p.page !== q.page) continue;
        expect(p.px + p.pw <= q.px || q.px + q.pw <= p.px || p.py + p.ph <= q.py || q.py + q.ph <= p.py).toBe(true);
      }
    }
  });

  it("convex hull and polygon distance (building shadows)", () => {
    const h = convexHull([0, 0, 4, 0, 4, 3, 0, 3, 2, 1, 6, 5]);
    expect(h.length / 2).toBe(4); // (4, 3) and (2, 1) lie inside
    expect(polySd([0, 0, 4, 0, 4, 4, 0, 4], 2, 2)).toBeCloseTo(2, 9);
    expect(polySd([0, 0, 4, 0, 4, 4, 0, 4], 6, 2)).toBeCloseTo(-2, 9);
  });
});

describe("photo roof sprites follow the roof-fade rule", () => {
  it("a roof sprite's alpha follows roofShown exactly as the vector roof did; a light eave line flashes when it starts to fade", () => {
    const map = flatMap("t", 300, 300);
    map.buildings.push({ id: 0, kind: "house", footprint: [50, 50, 60, 50, 60, 58, 50, 58], storeys: 1, storeyHeightM: 3, wallMaterial: "brick", wallThicknessM: 0.3, openings: [], roofColour: "#884433" });
    map.buildings.push({ id: 1, kind: "barn", footprint: [150, 150, 170, 150, 170, 158, 150, 158], storeys: 1, storeyHeightM: 4, wallMaterial: "brick", wallThicknessM: 0.3, openings: [], roofColour: "#665544" });
    const photo = new BuildingLayers(map, app, true), flat = new BuildingLayers(map, app, false);
    expect(photo.atlas?.items.length).toBe(2);
    const idx = buildingIndex(map);
    const steps: [number[], boolean][] = [[[], false], [[55, 54], false], [[55, 54], false], [[60 + ROOF_NEAR_M + 0.5, 54], false], [[], true], [[], true], [[], false]];
    for (const [men, close] of steps) for (let f = 0; f < 5; f++) {
      photo.update(men, men.length / 2, close, 12); flat.update(men, men.length / 2, close, 12);
      const want = roofShown(idx, men, men.length / 2, close);
      for (let i = 0; i < 2; i++) {
        expect(photo.roofAlpha(i)).toBe(flat.roofAlpha(i));
        expect(photo.roofObject(i)!.alpha).toBe(flat.roofObject(i)!.alpha);
        expect(photo.roofObject(i)!.visible).toBe(flat.roofObject(i)!.visible);
        if (f === 4 && want[i] === 0) expect(photo.roofAlpha(i)).toBeLessThan(1);
      }
    }
    // The eave flash: set when a roof starts fading, gone after EAVE_FLASH_FRAMES frames; never in the flat look.
    const p2 = new BuildingLayers(map, app, true);
    p2.update([55, 54], 1, false, 12);
    expect(p2.eaveFlash(0)).toBe(EAVE_FLASH_FRAMES - 1);
    expect(p2.eaveFlash(1)).toBe(0);
    for (let f = 0; f < EAVE_FLASH_FRAMES; f++) p2.update([55, 54], 1, false, 12);
    expect(p2.eaveFlash(0)).toBe(0);
    expect(flat.eaveFlash(0)).toBe(0);
    photo.destroy(); flat.destroy(); p2.destroy();
  });
});
