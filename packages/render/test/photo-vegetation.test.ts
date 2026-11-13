/**
 * The photo map's trees, hedges, orchards and scrub (plan "photo" step "vegetation"): the crown list is a function of
 * the map alone (the same after a map file round trip, the same on every prep); tiles cut through woods and hedges
 * join byte for byte with a larger picture at 2, 4 and 8 px/m; hedges stay visible far out; the painted luminance
 * ladder wood < hedge < orchard < grass holds; tracks cut lanes through woods; stamps are lit from the sun's side.
 */
import { describe, expect, it } from "vitest";
import { buildAppearance, buildCatalog } from "@tcs/data";
import { generateMap } from "@tcs/scenario";
import { mapFromFile, mapToFile, type MapDef } from "@tcs/sim";
import { PhotoPainter, crownsAround, photoInit } from "../src/photo/paint";
import { buildStamp, CK, Crowns, SHADOW_DIR, stampBucket, stampRadius } from "../src/photo/crowns";
import { Tex } from "../src/photo/prep";
import { loadData } from "../../tools/src/scenarios";

const data = loadData();
const cat = buildCatalog(data, ["de", "ru"]);
const app = buildAppearance(data, ["de", "ru"]);
type Kind = "village" | "farmland" | "woodland";
const maps: Record<string, MapDef> = {};
const painters: Record<string, PhotoPainter> = {};
const mapOf = (kind: Kind, seed = 2) => (maps[`${kind}${seed}`] ??= generateMap(cat.terrain, { kind, seed, widthM: 600, heightM: 600 }));
const painterOf = (kind: Kind, seed = 2) => (painters[`${kind}${seed}`] ??= new PhotoPainter(photoInit(mapOf(kind, seed), cat.terrain, app)));
const bigOf = (kind: Kind) => (maps[`${kind}big`] ??= generateMap(cat.terrain, { kind, seed: 1, widthM: 1200, heightM: 900 }));
const bigPainterOf = (kind: Kind) => (painters[`${kind}big`] ??= new PhotoPainter(photoInit(bigOf(kind), cat.terrain, app)));
const lum = (b: Uint8Array, p: number) => 0.299 * b[p]! + 0.587 * b[p + 1]! + 0.114 * b[p + 2]!;

/** Crowns of a rectangle as a sorted, comparable list. */
function crownList(p: PhotoPainter, x0: number, y0: number, x1: number, y1: number, ppm: number): string[] {
  const c = crownsAround(p.prep, x0, y0, x1, y1, ppm, new Crowns());
  return [...c.order()].map((i) => `${c.kind[i]} ${c.x[i]!.toFixed(4)} ${c.y[i]!.toFixed(4)} ${c.r[i]!.toFixed(4)} ${c.h[i]} ${c.cr[i]!.toFixed(3)} ${c.variant[i]}`);
}

/** Vegetation id of a cell (palette id, or ""). */
const vegId = (m: MapDef, k: number) => { const v = m.vegetation[k]!; return v ? m.vegetationPalette[v - 1]! : ""; };

/** Cells whose whole (2r+1)^2 neighbourhood satisfies `ok`, as world centres. */
function interiorCells(m: MapDef, ok: (k: number) => boolean, r = 2, limit = 400): { x: number; y: number }[] {
  const C = m.cols, out: { x: number; y: number }[] = [];
  for (let k = 0; k < C * m.rows && out.length < limit; k++) {
    const c = k % C, rr = (k - c) / C;
    if (c < r || rr < r || c >= C - r || rr >= m.rows - r) continue;
    let all = true;
    for (let dy = -r; dy <= r && all; dy++) for (let dx = -r; dx <= r && all; dx++) if (!ok(k + dy * C + dx)) all = false;
    if (all) out.push({ x: (c + 0.5) * m.cellSizeM, y: (rr + 0.5) * m.cellSizeM });
  }
  return out;
}

/** Distance from (x, y) to the nearest road or stream centre line minus its half-width. */
function laneDist(m: MapDef, x: number, y: number): number {
  let best = Infinity;
  const lines = [...m.roads.map((r) => ({ p: r.points, hw: r.widthM / 2 })), ...m.water.filter((w) => w.kind === "stream").map((w) => ({ p: w.points, hw: w.widthM / 2 }))];
  for (const { p, hw } of lines) for (let k = 0; k + 3 < p.length; k += 2) {
    const ax = p[k]!, ay = p[k + 1]!, ex = p[k + 2]! - ax, ey = p[k + 3]! - ay, L2 = ex * ex + ey * ey || 1e-9;
    let u = ((x - ax) * ex + (y - ay) * ey) / L2; u = Math.max(0, Math.min(1, u));
    best = Math.min(best, Math.hypot(x - ax - u * ex, y - ay - u * ey) - hw);
  }
  return best;
}

/** Mean luminance of the painted pixels (4 px/m) within 1 m of each point. */
function meanLum(p: PhotoPainter, pts: { x: number; y: number }[], ppm = 4): number {
  let s = 0, n = 0;
  for (const q of pts) {
    const b = p.paint(Math.floor(q.x) - 1, Math.floor(q.y) - 1, 2, 2, ppm);
    for (let i = 0; i < b.length; i += 4) { s += lum(b, i); n++; }
  }
  return s / n;
}

describe("photo vegetation", () => {
  it("the crown list is a function of the map: the same on a fresh prep and after a map file round trip", () => {
    for (const kind of ["woodland", "village"] as const) {
      const a = painterOf(kind);
      const fresh = new PhotoPainter(photoInit(mapOf(kind), cat.terrain, app));
      const trip = new PhotoPainter(photoInit(mapFromFile(JSON.parse(JSON.stringify(mapToFile(mapOf(kind))))), cat.terrain, app));
      for (const ppm of [1, 4]) {
        const ref = crownList(a, 200, 200, 330, 330, ppm);
        expect(ref.length, kind).toBeGreaterThan(20);
        expect(crownList(fresh, 200, 200, 330, 330, ppm)).toEqual(ref);
        expect(crownList(trip, 200, 200, 330, 330, ppm)).toEqual(ref);
      }
    }
  });

  it("every crown kind appears where its vegetation is (woods, scrub, orchards, hedges)", () => {
    const seen = new Set<number>();
    for (const kind of ["woodland", "village", "farmland"] as const) {
      const c = crownsAround(painterOf(kind).prep, 0, 0, 600, 600, 4);
      for (let i = 0; i < c.n; i++) seen.add(c.kind[i]!);
    }
    for (const k of [CK.Wood, CK.Scrub, CK.Hedge]) expect(seen.has(k), `kind ${k}`).toBe(true);
    // Orchards: only some maps have them; the village of seed 1 does.
    const c = crownsAround(bigPainterOf("village").prep, 0, 0, 1200, 900, 4);
    let orch = 0;
    for (let i = 0; i < c.n; i++) if (c.kind[i] === CK.Orchard) orch++;
    expect(orch).toBeGreaterThan(10);
  });

  // Tiles whose edges cut through a wood edge and through a hedge, at every detail level.
  const cases: [Kind, number, "wood" | "hedge"][] = [[ "woodland", 2, "wood"], ["woodland", 4, "wood"], ["woodland", 8, "wood"], ["farmland", 2, "hedge"], ["farmland", 4, "hedge"], ["village", 8, "hedge"]];
  for (const [kind, ppm, what] of cases) {
    it(`a ${256 / ppm} m tile at ${ppm} px/m across a ${what} equals the matching crop of a 3 x 3 tile picture (${kind})`, () => {
      const m = what === "hedge" ? bigOf(kind) : mapOf(kind), p = what === "hedge" ? bigPainterOf(kind) : painterOf(kind), T = 256 / ppm;
      const MW = m.widthM, MH = m.heightM;
      let px = 0, py = 0, cx = -1, cy = -1;
      // The 3 x 3 picture round the tile stays on the map.
      const fits = (x: number, y: number) => { const a = Math.round(x / T) * T, b = Math.round(y / T) * T; return a >= T && b >= T && a <= MW - 2 * T && b <= MH - 2 * T; };
      if (what === "hedge") {
        for (const o of m.obstacles) if (o.kind === "hedge") for (let k = 0; k + 3 < o.points.length && !px; k += 2) for (let f = 0, L = Math.hypot(o.points[k + 2]! - o.points[k]!, o.points[k + 3]! - o.points[k + 1]!); f <= 1 && !px; f += 1 / Math.max(1, L)) {
          const x = o.points[k]! + (o.points[k + 2]! - o.points[k]!) * f, y = o.points[k + 1]! + (o.points[k + 3]! - o.points[k + 1]!) * f;
          // On the tile corner's row or column, so the tile edge runs across the hedge.
          // On a tile column (or row) line, so the tile edge runs across the hedge; the hedge point inside the tile.
          const a = Math.round(x / T) * T, b = Math.round(y / T) * T;
          if (Math.abs(x - a) < 3) { cx = a; cy = Math.floor(y / T) * T; } else if (Math.abs(y - b) < 3) { cx = Math.floor(x / T) * T; cy = b; } else continue;
          if (cx >= T && cy >= T && cx <= MW - 2 * T && cy <= MH - 2 * T) { px = x; py = y; }
        }
        expect(px).toBeGreaterThan(0);
      } else {
        // A wood cell with open ground to its east (crowns and their shadows cross the tile edge).
        const C = m.cols;
        for (let k = 0; k < C * m.rows; k++) {
          const c = k % C, r = (k - c) / C, x = (c + 0.5) * m.cellSizeM, y = (r + 0.5) * m.cellSizeM;
          if (!fits(x, y)) continue;
          if (vegId(m, k) === "woodland" && vegId(m, k + 1) === "" ) { px = x; py = y; break; }
        }
        expect(px).toBeGreaterThan(0);
      }
      // Put the tile corner right on the feature, so the tile edges cut through it.
      const x0 = what === "hedge" ? cx : Math.round(px / T) * T, y0 = what === "hedge" ? cy : Math.round(py / T) * T;
      expect(crownsAround(p.prep, px - 4, py - 4, px + 4, py + 4, ppm).n, "crowns at the tile edge").toBeGreaterThan(0);
      const tile = p.paint(x0, y0, T, T, ppm), big = p.paint(x0 - T, y0 - T, 3 * T, 3 * T, ppm);
      let diff = 0;
      for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
        const a = (y * 256 + x) * 4, b = ((y + 256) * 768 + x + 256) * 4;
        if (tile[a] !== big[b] || tile[a + 1] !== big[b + 1] || tile[a + 2] !== big[b + 2]) diff++;
      }
      expect(diff).toBe(0);
      // And the tile does hold crowns (it is not plain ground).
      expect(crownsAround(p.prep, x0, y0, x0 + T, y0 + T, ppm).n).toBeGreaterThan(0);
    });
  }

  it("hedges stay visible far out: at 1 px/m a cross-section has at least 2 px at least 10 % darker than the ground beside", () => {
    let checked = 0;
    for (const kind of ["farmland", "village", "woodland"] as const) {
      const m = mapOf(kind), p = painterOf(kind), pr = p.prep;
      for (const o of m.obstacles) {
        if (o.kind !== "hedge") continue;
        // The middle of the hedge's longest segment.
        let best = -1, bl = 0;
        for (let k = 0; k + 3 < o.points.length; k += 2) { const l = Math.hypot(o.points[k + 2]! - o.points[k]!, o.points[k + 3]! - o.points[k + 1]!); if (l > bl) { bl = l; best = k; } }
        if (bl < 12) continue;
        const ax = o.points[best]!, ay = o.points[best + 1]!, ux = (o.points[best + 2]! - ax) / bl, uy = (o.points[best + 3]! - ay) / bl;
        // Where the ground on both sides is open (no wood, road or stream within reach): sample a few places along.
        for (const f of [0.3, 0.5, 0.7]) {
          const mx = ax + ux * bl * f, my = ay + uy * bl * f;
          if (mx < 12 || my < 12 || mx > 588 || my > 588 || laneDist(m, mx, my) < 12) continue;
          let open = true;
          for (const s of [-9, -6, 6, 9]) {
            const qx = mx - uy * s, qy = my + ux * s, k = Math.floor(qy / pr.cs) * pr.cols + Math.floor(qx / pr.cs);
            if (m.vegetation[k] && ["woodland", "treeline", "scrub", "orchard"].includes(vegId(m, k))) open = false;
          }
          if (!open) continue;
          const b = p.paint(Math.floor(mx) - 12, Math.floor(my) - 12, 24, 24, 1);
          const at = (s: number) => { const qx = mx - uy * s - (Math.floor(mx) - 12), qy = my + ux * s - (Math.floor(my) - 12); return lum(b, (Math.floor(qy) * 24 + Math.floor(qx)) * 4); };
          const side = (sg: number) => (at(sg * 7) + at(sg * 8) + at(sg * 9)) / 3;
          const ground = Math.min(side(-1), side(1));
          let dark = 0;
          for (let s = -3; s <= 3; s++) if (at(s) <= 0.9 * ground) dark++;
          expect(dark, `${kind} hedge at ${mx.toFixed(0)}, ${my.toFixed(0)}`).toBeGreaterThanOrEqual(2);
          checked++;
          break;
        }
      }
    }
    expect(checked).toBeGreaterThanOrEqual(5);
  });

  it("painted luminance climbs: wood canopy < hedge < orchard < grass, each step at least 1.15 x", () => {
    const m = mapOf("woodland"), p = painterOf("woodland");
    const wood = meanLum(p, interiorCells(m, (k) => vegId(m, k) === "woodland", 3, 60));
    const grassPts = interiorCells(m, (k) => p.prep.tex[k] === Tex.Grass && m.vegetation[k] === 0, 3, 60);
    // Hedges: points on the hedge lines of the farmland, away from roads.
    const fm = mapOf("farmland"), fp = painterOf("farmland"), hp: { x: number; y: number }[] = [];
    for (const o of fm.obstacles) if (o.kind === "hedge") for (let k = 0; k + 3 < o.points.length && hp.length < 80; k += 2) {
      for (const f of [0.25, 0.5, 0.75]) { const x = o.points[k]! + (o.points[k + 2]! - o.points[k]!) * f, y = o.points[k + 1]! + (o.points[k + 3]! - o.points[k + 1]!) * f; if (laneDist(fm, x, y) > 6) hp.push({ x, y }); }
    }
    const hedge = meanLum(fp, hp);
    const v1m = bigOf("village"), v1 = bigPainterOf("village");
    // Orchard: whole 7 m grid squares (trees and the grass between them).
    const op = interiorCells(v1m, (k) => vegId(v1m, k) === "orchard", 1, 40);
    let os = 0, on = 0;
    for (const q of op) { const b = v1.paint(Math.floor(q.x) - 3, Math.floor(q.y) - 3, 7, 7, 4); for (let i = 0; i < b.length; i += 4) { os += lum(b, i); on++; } }
    const orchard = os / on;
    const grass = meanLum(p, grassPts);
    expect(op.length).toBeGreaterThan(3);
    expect(hedge / wood, `hedge ${hedge.toFixed(1)} / wood ${wood.toFixed(1)}`).toBeGreaterThanOrEqual(1.15);
    expect(orchard / hedge, `orchard ${orchard.toFixed(1)} / hedge ${hedge.toFixed(1)}`).toBeGreaterThanOrEqual(1.15);
    expect(grass / orchard, `grass ${grass.toFixed(1)} / orchard ${orchard.toFixed(1)}`).toBeGreaterThanOrEqual(1.15);
  });

  it("tracks cut lanes through woods: the middle of a track inside a wood is not canopy-dark", () => {
    const m = mapOf("woodland"), p = painterOf("woodland");
    const wood = meanLum(p, interiorCells(m, (k) => vegId(m, k) === "woodland", 3, 60));
    let checked = 0;
    for (const r of m.roads) for (let k = 0; k + 3 < r.points.length; k += 2) {
      const ax = r.points[k]!, ay = r.points[k + 1]!, bx = r.points[k + 2]!, by = r.points[k + 3]!, L = Math.hypot(bx - ax, by - ay);
      for (let s = 0; s < L; s += 6) {
        const x = ax + ((bx - ax) * s) / L, y = ay + ((by - ay) * s) / L, ux = (bx - ax) / L, uy = (by - ay) / L;
        const side = (d: number) => { const qx = x - uy * d, qy = y + ux * d; return vegId(m, Math.floor(qy / m.cellSizeM) * m.cols + Math.floor(qx / m.cellSizeM)); };
        if (x < 8 || y < 8 || x > 592 || y > 592 || side(-8) !== "woodland" || side(8) !== "woodland") continue;
        const b = p.paint(Math.floor(x * 4) / 4, Math.floor(y * 4) / 4, 0.25, 0.25, 4);
        expect(lum(b, 0), `track at ${x.toFixed(0)}, ${y.toFixed(0)}`).toBeGreaterThan(1.15 * wood);
        checked++;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(5);
  });

  it("crown stamps are lit from the west-north-west and cast their contact shadow east-south-east", () => {
    for (const ppm of [1, 4, 8]) {
      const rb = stampRadius(stampBucket(3)), st = buildStamp(rb, 1, ppm);
      let lit = 0, nl = 0, dark = 0, nd = 0, shUp = 0, shDown = 0;
      for (let k = 0; k < st.n; k++) {
        const x = st.dx[k]! / ppm, y = st.dy[k]! / ppm, along = x * SHADOW_DIR.x + y * SHADOW_DIR.y;
        if (st.a[k]! > 0.99) { if (along < -rb * 0.4) { lit += st.mG[k]!; nl++; } else if (along > rb * 0.4) { dark += st.mG[k]!; nd++; } }
        if (st.a[k]! < 0.01) { if (along > 0) shDown += st.sh[k]!; else shUp += st.sh[k]!; }
      }
      expect(lit / nl, `ppm ${ppm}`).toBeGreaterThan(1.1 * (dark / nd));
      expect(shDown).toBeGreaterThan(shUp);
    }
  });
});
