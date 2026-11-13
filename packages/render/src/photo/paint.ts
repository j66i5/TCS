/**
 * The photo map painter (plan "photo"): any rectangle of the map at any resolution, as opaque RGBA bytes. Ground
 * (`ground.ts`), then the features (step "ground": the flat painter's feature passes without outlines, provisional
 * until steps "vegetation" and "built" replace them), then the grade (`grade.ts`: blur with a one-pixel apron from
 * 2 px/m, colour grade, grain). Pure (no Pixi, no DOM): runs in a worker, in tests and in Node.
 *
 * Rectangles must start on the global pixel grid of `ppm` (x0 * ppm whole), so tiles join byte for byte.
 */
import type { MapDef, TerrainCatalog } from "@tcs/sim";
import type { Appearance } from "@tcs/data";
import { flatColours, paintFeatures, type FlatColours } from "../flat/paint";
import { paintGround, type GroundOptions } from "./ground";
import { gradeInto } from "./grade";
import { DEFAULT_GRADE, preparePhoto, type PhotoGrade, type PhotoPrep } from "./prep";

export interface PhotoOptions extends GroundOptions {
  /** Paint roads, water, crowns, hedges, walls (default true). */
  features?: boolean;
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

export function paintPhoto(map: MapDef, col: FlatColours, prep: PhotoPrep, x0: number, y0: number, w: number, h: number, ppm: number, opt: PhotoOptions = {}): Uint8Array {
  const W = Math.max(1, Math.round(w * ppm)), H = Math.max(1, Math.round(h * ppm));
  const gx0 = Math.round(x0 * ppm), gy0 = Math.round(y0 * ppm);
  const a = (opt.blur ?? ppm >= 2) ? 1 : 0;
  const SW = W + 2 * a, SH = H + 2 * a;
  const buf = new Uint32Array(SW * SH);
  paintGround(prep, buf, SW, SH, gx0 - a, gy0 - a, ppm, opt);
  if (opt.features !== false) paintFeatures(buf, SW, SH, map, col, (gx0 - a) / ppm, (gy0 - a) / ppm, SW / ppm, SH / ppm, ppm, false);
  return gradeInto(buf, SW, a, W, H, gx0, gy0, prep.grade);
}
