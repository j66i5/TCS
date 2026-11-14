/**
 * The photo map painter (plan "photo"): any rectangle of the map at any resolution, as opaque RGBA bytes. Ground
 * (`ground.ts`); embankments, water, roads and bridges (`lines.ts`); then one shadow pass, the crowns' cast shadows
 * (`shadows.ts`) and the ground shadows of buildings, walls and fences combined by maximum; walls and fences; the tree,
 * hedge, orchard and scrub crowns (`crowns.ts`); then the grade (`grade.ts`: blur with a one-pixel apron from 2 px/m,
 * colour grade, grain). Roofs are not part of the ground: they are sprites (`roof.ts`). Pure (no Pixi, no DOM): runs
 * in a worker, in tests and in Node.
 *
 * Rectangles must start on the global pixel grid of `ppm` (x0 * ppm whole), so tiles join byte for byte.
 */
import type { MapDef, TerrainCatalog } from "@tcs/sim";
import type { Appearance } from "@tcs/data";
import { flatColours, type FlatColours } from "../flat/paint";
import { paintGround, type GroundOptions } from "./ground";
import { gradeInto } from "./grade";
import { DEFAULT_GRADE, MACRO_CH, MACRO_M, M_WX, M_WY, preparePhoto, stampsFor, type PhotoGrade, type PhotoPrep } from "./prep";
import { blitCrowns, CROWN_REACH, Crowns, gatherCrowns } from "./crowns";
import { applyShadows, shadowGrid } from "./shadows";
import { hasLines, lineScratch, lineShadows, paintEmbankments, paintRoads, paintWalls, paintWater } from "./lines";

export interface PhotoOptions extends GroundOptions {
  /** Paint roads, water, bridges, walls, fences, embankments and building shadows (default true). */
  features?: boolean;
  /** Paint crowns, hedges and their shadows (default true). */
  vegetation?: boolean;
  /** Blur (default: from 2 px/m). */
  blur?: boolean;
}

/** Everything a worker needs to paint (structured-cloneable). */
export interface PhotoInit { map: MapDef; col: FlatColours; grade: PhotoGrade }

/** The flat colour set built from the photo palette (appearance.json `photo`, falling back to `map`). */
export function photoColours(map: MapDef, t: TerrainCatalog, app: Appearance | null): FlatColours {
  const ph = app?.photo;
  const merged: Appearance | null = app && ph ? { ...app, map: { ...app.map, surfaces: { ...app.map.surfaces, ...ph.surfaces }, vegetation: { ...app.map.vegetation, ...ph.vegetation } } } : app;
  return flatColours(map, t, merged, ph?.obstacles);
}

export function photoInit(map: MapDef, t: TerrainCatalog, app: Appearance | null): PhotoInit {
  return { map, col: photoColours(map, t, app), grade: app?.photo?.grade ?? DEFAULT_GRADE };
}

/** A painter bound to one map: prepares once, paints rectangles. */
export class PhotoPainter {
  readonly prep: PhotoPrep;
  constructor(readonly init: PhotoInit) { this.prep = preparePhoto(init.map, init.col, init.grade); }
  paint(x0: number, y0: number, w: number, h: number, ppm: number, opt: PhotoOptions = {}): Uint8Array {
    return paintPhoto(this.init.map, this.init.col, this.prep, x0, y0, w, h, ppm, opt);
  }
}

/** The crowns that touch the world rectangle [x0, x1) x [y0, y1) at `ppm` (their shadows included), unsorted. */
export function crownsAround(prep: PhotoPrep, x0: number, y0: number, x1: number, y1: number, ppm: number, out = new Crowns()): Crowns {
  const warp = { macro: prep.macro, mcols: prep.mcols, mrows: prep.mrows, ch: MACRO_CH, wx: M_WX, wy: M_WY, mM: MACRO_M };
  gatherCrowns(prep.veg, warp, x0 - CROWN_REACH, y0 - CROWN_REACH, x1 + CROWN_REACH, y1 + CROWN_REACH, ppm, out);
  return out;
}

export function paintPhoto(map: MapDef, col: FlatColours, prep: PhotoPrep, x0: number, y0: number, w: number, h: number, ppm: number, opt: PhotoOptions = {}): Uint8Array {
  const W = Math.max(1, Math.round(w * ppm)), H = Math.max(1, Math.round(h * ppm));
  const gx0 = Math.round(x0 * ppm), gy0 = Math.round(y0 * ppm);
  const a = (opt.blur ?? ppm >= 2) ? 1 : 0;
  const SW = W + 2 * a, SH = H + 2 * a, bgx = gx0 - a, bgy = gy0 - a;
  const buf = new Uint32Array(SW * SH);
  paintGround(prep, buf, SW, SH, bgx, bgy, ppm, opt);
  const bx0 = bgx / ppm, by0 = bgy / ppm, bx1 = bx0 + SW / ppm, by1 = by0 + SH / ppm;
  const lp = prep.lines, features = opt.features !== false;
  if (features) {
    paintEmbankments(lp, buf, SW, SH, bgx, bgy, ppm);
    if (hasLines(lp)) {
      const s = lineScratch(SW, SH, bgx, bgy, ppm);
      paintWater(lp, s, buf, SW, SH, ppm);
      paintRoads(lp, s, buf, SW, SH, ppm);
    }
  }
  // One shadow pass: crowns' cast shadows and ambient darkening, building, wall and fence shadows (max-combined).
  const veg = opt.vegetation !== false ? crownsAround(prep, bx0, by0, bx1, by1, ppm) : null;
  let extra: Float32Array | null = null;
  if (features) { extra = new Float32Array(SW * SH); if (!lineShadows(lp, extra, SW, SH, bgx, bgy, ppm)) extra = null; }
  applyShadows(veg && veg.n > 0 ? shadowGrid(veg, bx0, by0, bx1, by1) : null, buf, SW, SH, bgx, bgy, ppm, extra);
  if (features) paintWalls(lp, buf, SW, SH, bgx, bgy, ppm);
  if (veg && veg.n > 0) blitCrowns(veg, veg.order(), stampsFor(prep, ppm), buf, SW, SH, bgx, bgy, ppm);
  return gradeInto(buf, SW, a, W, H, gx0, gy0, prep.grade);
}
