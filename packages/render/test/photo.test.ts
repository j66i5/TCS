/**
 * The photo map painter (plan "photo" step "ground"): deterministic, tiles at every level join byte for byte with a
 * larger picture (through the blur apron), opaque; fine patterns band-limited; softer field edges than the flat map;
 * natural variation inside a field; readability caps (saturation; the palette's luminance ladder).
 */
import { describe, expect, it } from "vitest";
import { buildAppearance, buildCatalog } from "@tcs/data";
import { generateMap } from "@tcs/scenario";
import type { MapDef } from "@tcs/sim";
import { PhotoPainter, photoInit } from "../src/photo/paint";
import { EDGE_CAP, Tex } from "../src/photo/prep";
import { SAT_CAP } from "../src/photo/grade";
import { band, tri, vnoise } from "../src/photo/noise";
import { SUN, hillshade, shadowOffset } from "../src/photo/light";
import { flatColours, paintRegion } from "../src/flat/paint";
import { loadData } from "../../tools/src/scenarios";

const data = loadData();
const cat = buildCatalog(data, ["de", "ru"]);
const app = buildAppearance(data, ["de", "ru"]);
const maps: Record<string, MapDef> = {};
const painters: Record<string, PhotoPainter> = {};
const mapOf = (kind: "village" | "farmland" | "woodland", seed = 2) => (maps[`${kind}${seed}`] ??= generateMap(cat.terrain, { kind, seed, widthM: 600, heightM: 600 }));
const painterOf = (kind: "village" | "farmland" | "woodland", seed = 2) => (painters[`${kind}${seed}`] ??= new PhotoPainter(photoInit(mapOf(kind, seed), cat.terrain, app)));

const lum = (b: Uint8Array, p: number) => 0.299 * b[p]! + 0.587 * b[p + 1]! + 0.114 * b[p + 2]!;
const satOf = (r: number, g: number, b: number) => { const mx = Math.max(r, g, b), mn = Math.min(r, g, b); return mx === 0 ? 0 : (mx - mn) / mx; };

/** A cell well inside a field of texture `tex` (edge distance at the cap all round), or null. */
function interiorCell(p: PhotoPainter, tex: number, r = 3): { x: number; y: number } | null {
  const pr = p.prep, C = pr.cols;
  for (let k = 0; k < pr.cols * pr.rows; k++) {
    const c = k % C, rr = (k - c) / C;
    if (c < r || rr < r || c >= C - r || rr >= pr.rows - r) continue;
    let ok = true;
    for (let dy = -r; dy <= r && ok; dy++) for (let dx = -r; dx <= r && ok; dx++) { const j = k + dy * C + dx; if (pr.tex[j] !== tex || pr.edge[j]! < EDGE_CAP || pr.field[j] !== pr.field[k]) ok = false; }
    if (ok) return { x: (c + 0.5) * pr.cs, y: (rr + 0.5) * pr.cs };
  }
  return null;
}

describe("photo painter", () => {
  it("is deterministic (a fresh painter paints the same bytes)", () => {
    const a = painterOf("village").paint(256, 256, 64, 64, 4);
    const b = new PhotoPainter(photoInit(mapOf("village"), cat.terrain, app)).paint(256, 256, 64, 64, 4);
    expect(b).toEqual(a);
    expect(a.length).toBe(256 * 256 * 4);
    for (let i = 3; i < a.length; i += 4) if (a[i] !== 255) throw new Error("not opaque");
  });

  for (const [ppm, kind] of [[2, "village"], [4, "village"], [8, "woodland"], [4, "farmland"]] as const) {
    it(`a ${256 / ppm} m tile at ${ppm} px/m equals the matching crop of a 3 x 3 tile picture (${kind}; byte-exact through the blur apron)`, () => {
      const p = painterOf(kind), T = 256 / ppm, x0 = 2 * T, y0 = 2 * T;
      const tile = p.paint(x0, y0, T, T, ppm);
      const big = p.paint(x0 - T, y0 - T, 3 * T, 3 * T, ppm);
      let diff = 0;
      for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
        const a = (y * 256 + x) * 4, b = ((y + 256) * 768 + x + 256) * 4;
        if (tile[a] !== big[b] || tile[a + 1] !== big[b + 1] || tile[a + 2] !== big[b + 2]) diff++;
      }
      expect(diff).toBe(0);
    });
  }

  it("band-limits furrows: at 1 px/m a ploughed field's pixel variance is that of the field without furrows (within 10 %)", () => {
    for (const kind of ["farmland", "village"] as const) {
      const p = painterOf(kind), c = interiorCell(p, Tex.Plough);
      if (!c) continue;
      const v = (b: Uint8Array) => { let s = 0, s2 = 0; const n = b.length / 4; for (let i = 0; i < b.length; i += 4) { const l = lum(b, i); s += l; s2 += l * l; } return s2 / n - (s / n) ** 2; };
      const on = v(p.paint(Math.floor(c.x) - 8, Math.floor(c.y) - 8, 16, 16, 1, { features: false }));
      const off = v(p.paint(Math.floor(c.x) - 8, Math.floor(c.y) - 8, 16, 16, 1, { features: false, furrows: false }));
      expect(Math.abs(on - off) / Math.max(off, 1e-6)).toBeLessThanOrEqual(0.1);
      return;
    }
    throw new Error("no ploughed field found");
  });

  it("field edges are softer than the flat map's (mean neighbour step across a ground change)", () => {
    const map = mapOf("farmland"), p = painterOf("farmland"), col = flatColours(map, cat.terrain, app);
    const x0 = 64, y0 = 64, ppm = 4, M = 192, W = M * ppm;
    const photo = p.paint(x0, y0, M, M, ppm, { features: false }), flat = paintRegion(map, col, x0, y0, M, M, ppm);
    const key = col.cellKey, C = map.cols, cs = map.cellSizeM;
    let sp = 0, sf = 0, n = 0;
    for (let j = 0; j < W; j++) for (let i = 0; i + 1 < W; i++) {
      const xa = x0 + (i + 0.5) / ppm, xb = x0 + (i + 1.5) / ppm, y = y0 + (j + 0.5) / ppm;
      const ka = key[Math.floor(y / cs) * C + Math.floor(xa / cs)], kb = key[Math.floor(y / cs) * C + Math.floor(xb / cs)];
      if (ka === kb) continue;
      const a = (j * W + i) * 4, b = a + 4;
      sp += Math.abs(lum(photo, a) - lum(photo, b)); sf += Math.abs(lum(flat, a) - lum(flat, b)); n++;
    }
    expect(n).toBeGreaterThan(20);
    expect(sp / n).toBeLessThan(sf / n);
  });

  it("varies inside a field: luminance spread at 4 px/m at least 1.5 % for grass, crops and plough", () => {
    let checked = 0;
    for (const tex of [Tex.Grass, Tex.Rows, Tex.Plough, Tex.Meadow]) {
      for (const kind of ["farmland", "village"] as const) {
        const p = painterOf(kind), c = interiorCell(p, tex);
        if (!c) continue;
        const b = p.paint(Math.floor(c.x) - 6, Math.floor(c.y) - 6, 12, 12, 4, { features: false });
        let s = 0, s2 = 0; const n = b.length / 4;
        for (let i = 0; i < b.length; i += 4) { const l = lum(b, i); s += l; s2 += l * l; }
        const mean = s / n, sd = Math.sqrt(Math.max(0, s2 / n - mean * mean));
        expect(sd / mean, `texture ${tex} on ${kind}`).toBeGreaterThanOrEqual(0.015);
        checked++;
        break;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(3);
  });

  it("keeps the ground quiet: no pixel above the saturation cap, mean saturation at most 0.30 (water excluded)", () => {
    for (const kind of ["village", "farmland", "woodland"] as const) {
      const b = painterOf(kind).paint(0, 0, 600, 600, 1);
      let sum = 0, n = 0, worst = 0;
      for (let i = 0; i < b.length; i += 4) {
        const r = b[i]!, g = b[i + 1]!, bl = b[i + 2]!;
        if (bl > r && bl >= g - 4) continue; // water: the only bluish ground
        const s = satOf(r, g, bl);
        worst = Math.max(worst, s); sum += s; n++;
      }
      expect(worst, kind).toBeLessThanOrEqual(SAT_CAP + 0.02); // (8-bit rounding of dark pixels)
      expect(sum / n, kind).toBeLessThanOrEqual(0.3);
    }
  });

  it("the photo palette climbs the luminance ladder, each class at least 1.15 x the one below", () => {
    const ph = app.photo!;
    const L = (c: number) => 0.299 * ((c >> 16) & 255) + 0.587 * ((c >> 8) & 255) + 0.114 * (c & 255);
    const classes: number[][] = [
      [ph.surfaces["water-deep"]!],
      [ph.vegetation["woodland"]!],
      [ph.vegetation["treeline"]!, ph.obstacles["hedge"]!],
      [ph.vegetation["scrub"]!, ph.vegetation["orchard"]!],
      [ph.surfaces["ploughed"]!],
      [ph.surfaces["grass"]!, ph.surfaces["meadow"]!],
      [ph.surfaces["stubble"]!, ph.vegetation["crops"]!],
      [ph.surfaces["dirt-track"]!, ph.surfaces["gravel"]!],
      [ph.surfaces["concrete"]!, ph.obstacles["stone-wall"]!, ph.obstacles["concrete-wall"]!],
    ];
    for (const c of classes) for (const v of c) expect(v).toBeTypeOf("number");
    for (let i = 1; i < classes.length; i++) {
      const below = Math.max(...classes[i - 1]!.map(L)), here = Math.min(...classes[i]!.map(L));
      expect(here / below, `class ${i}`).toBeGreaterThanOrEqual(1.15);
    }
    // And no photo ground colour is louder than the cap (water excepted).
    for (const [id, c] of Object.entries(ph.surfaces)) if (!id.startsWith("water")) expect(satOf((c >> 16) & 255, (c >> 8) & 255, c & 255), id).toBeLessThanOrEqual(SAT_CAP);
  });
});

describe("photo noise and light", () => {
  it("noise is bounded and smooth; the wave is periodic; band limits fade fine patterns out", () => {
    for (let i = 0; i < 1000; i++) { const v = vnoise(i * 0.37, i * 0.21, i % 5); expect(Math.abs(v)).toBeLessThanOrEqual(1); }
    expect(Math.abs(vnoise(10.5, 3.25) - vnoise(10.5001, 3.25))).toBeLessThan(0.01);
    expect(tri(0.25)).toBeCloseTo(tri(1.25), 12);
    expect(tri(0)).toBe(1); expect(tri(0.5)).toBe(-1);
    expect(band(1.1, 1)).toBe(0); expect(band(1.1, 4)).toBe(1);
  });
  it("the sun is from the west-north-west and above; shadows fall east-south-east; slopes facing it are lighter", () => {
    expect(SUN.x).toBeLessThan(0); expect(SUN.y).toBeLessThan(0); expect(SUN.z).toBeGreaterThan(0.5);
    expect(Math.abs(SUN.x)).toBeGreaterThan(Math.abs(SUN.y));
    const o = shadowOffset(10); expect(o.dx).toBeGreaterThan(0); expect(o.dy).toBeGreaterThan(0); expect(Math.hypot(o.dx, o.dy)).toBeCloseTo(6, 6);
    expect(hillshade(0.1, 0)).toBeGreaterThan(0); // height rises to the east: the slope faces west, toward the sun
    expect(hillshade(-0.1, 0)).toBeLessThan(0);
    expect(Math.abs(hillshade(5, 5))).toBeLessThanOrEqual(0.07);
  });
});
