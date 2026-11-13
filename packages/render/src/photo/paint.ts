/**
 * The photo map painter (plan "photo"): any rectangle of the map at any resolution, as opaque RGBA bytes. Ground
 * (`ground.ts`), then roads, water, walls and fences (the flat painter's passes without outlines, provisional until step
 * "built" replaces them), then cast shadows and the tree, hedge, orchard and scrub crowns (`shadows.ts`, `crowns.ts`),
 * then the grade (`grade.ts`: blur with a one-pixel apron from
 * 2 px/m, colour grade, grain). Pure (no Pixi, no DOM): runs in a worker, in tests and in Node.
 *
 * Rectangles must start on the global pixel grid of `ppm` (x0 * ppm whole), so tiles join byte for byte.
 */
import type { MapDef, TerrainCatalog } from "@tcs/sim";
import type { Appearance } from "@tcs/data";
import { flatColours, paintFeatures, type FlatColours } from "../flat/paint";
import { paintGround, type GroundOptions } from "./ground";
import { gradeInto } from "./grade";
import { DEFAULT_GRADE, MACRO_CH, MACRO_M, M_WX, M_WY, preparePhoto, stampsFor, type PhotoGrade, type PhotoPrep } from "./prep";
import { blitCrowns, CROWN_REACH, Crowns, gatherCrowns } from "./crowns";
import { applyShadows, shadowGrid } from "./shadows";

export interface PhotoOptions extends GroundOptions {
  /** Paint roads, water, walls, fences (default true). */
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

/** Cast shadows and ambient darkening on the ground, then the crowns, low to high. */
function paintVegetation(prep: PhotoPrep, buf: Uint32Array, W: number, H: number, gx0: number, gy0: number, ppm: number, bx0: number, by0: number, bx1: number, by1: number): void {
  const c = crownsAround(prep, bx0, by0, bx1, by1, ppm);
  if (c.n === 0) return;
  applyShadows(shadowGrid(c, bx0, by0, bx1, by1), buf, W, H, gx0, gy0, ppm);
  blitCrowns(c, c.order(), stampsFor(prep, ppm), buf, W, H, gx0, gy0, ppm);
}

export function paintPhoto(map: MapDef, col: FlatColours, prep: PhotoPrep, x0: number, y0: number, w: number, h: number, ppm: number, opt: PhotoOptions = {}): Uint8Array {
  const W = Math.max(1, Math.round(w * ppm)), H = Math.max(1, Math.round(h * ppm));
  const gx0 = Math.round(x0 * ppm), gy0 = Math.round(y0 * ppm);
  const a = (opt.blur ?? ppm >= 2) ? 1 : 0;
  const SW = W + 2 * a, SH = H + 2 * a;
  const buf = new Uint32Array(SW * SH);
  paintGround(prep, buf, SW, SH, gx0 - a, gy0 - a, ppm, opt);
  const bx0 = (gx0 - a) / ppm, by0 = (gy0 - a) / ppm, bx1 = bx0 + SW / ppm, by1 = by0 + SH / ppm;
  if (opt.features !== false) paintFeatures(buf, SW, SH, map, col, bx0, by0, SW / ppm, SH / ppm, ppm, false, false);
  if (opt.vegetation !== false) paintVegetation(prep, buf, SW, SH, gx0 - a, gy0 - a, ppm, bx0, by0, bx1, by1);
  return gradeInto(buf, SW, a, W, H, gx0, gy0, prep.grade);
}
