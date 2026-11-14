/**
 * Buildings as two layers (M7.5b, plan m7.5 §4; owner answer 4): the FLOOR layer (floor colour, outer walls with
 * their door gaps and windows; rooms come in M7.5c) under the men, and the ROOF layer above them — one Graphics per
 * building whose alpha follows the roof-fade rule: a roof fades away when zoomed in close, or when one of the
 * player's own able men (not riding in a vehicle) is inside the building or within `ROOF_NEAR_M` of its walls.
 * Original drawings (docs/ASSETS.md).
 *
 * Photo look (plan "photo" step "built"): the roofs are sprites cut from a per-map roof atlas painted by
 * `photo/roof.ts` (hipped, gabled or flat, lit by the sun), one Sprite per building with the same fade rule; their
 * ground shadows are part of the terrain picture, so they stay when the roof fades. When a roof starts to fade, a light
 * dashed eave line shows for 0.3 s, so the player sees which building opened (drawn once per building in metres and
 * cached; only its alpha changes per frame). Floors stay vector drawings (they are game information: the walls are the
 * cover), but softened for the photo: the photo palette's lighter floor colours, walls a dark shade of the floor
 * rather than black ink, a soft shade along the walls inside, fainter floorboards.
 */
import { BufferImageSource, Container, Graphics, Rectangle, Sprite, Texture } from "pixi.js";
import { buildInteriorGraph, type Building, type MapDef } from "@tcs/sim";
import type { Appearance } from "@tcs/data";
import { shade } from "./terrain-flat";
import { buildRoofAtlas, type RoofAtlas } from "./photo/roof";

export const ROOF_NEAR_M = 8;
const BUCKET_M = 32;

/** Buildings bucketed by their bounding box grown by ROOF_NEAR_M (for the per-frame roof test). */
export interface BuildingIndex { cols: number; rows: number; buckets: number[][]; buildings: readonly Building[] }

export function buildingIndex(map: Pick<MapDef, "widthM" | "heightM" | "buildings">): BuildingIndex {
  const cols = Math.max(1, Math.ceil(map.widthM / BUCKET_M)), rows = Math.max(1, Math.ceil(map.heightM / BUCKET_M));
  const buckets: number[][] = Array.from({ length: cols * rows }, () => []);
  map.buildings.forEach((b, i) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let k = 0; k < b.footprint.length; k += 2) { x0 = Math.min(x0, b.footprint[k]!); x1 = Math.max(x1, b.footprint[k]!); y0 = Math.min(y0, b.footprint[k + 1]!); y1 = Math.max(y1, b.footprint[k + 1]!); }
    const c0 = Math.max(0, Math.floor((x0 - ROOF_NEAR_M) / BUCKET_M)), c1 = Math.min(cols - 1, Math.floor((x1 + ROOF_NEAR_M) / BUCKET_M));
    const r0 = Math.max(0, Math.floor((y0 - ROOF_NEAR_M) / BUCKET_M)), r1 = Math.min(rows - 1, Math.floor((y1 + ROOF_NEAR_M) / BUCKET_M));
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) buckets[r * cols + c]!.push(i);
  });
  return { cols, rows, buckets, buildings: map.buildings };
}

/** Is (x, y) inside the polygon or within `d` metres of its edges? */
export function nearPolygon(fp: readonly number[], x: number, y: number, d: number): boolean {
  const n = fp.length / 2;
  let inside = false;
  for (let a = 0, b = n - 1; a < n; b = a++) {
    const ax = fp[2 * a]!, ay = fp[2 * a + 1]!, bx = fp[2 * b]!, by = fp[2 * b + 1]!;
    if ((ay > y) !== (by > y) && x < ((bx - ax) * (y - ay)) / (by - ay) + ax) inside = !inside;
    const ex = bx - ax, ey = by - ay, L2 = ex * ex + ey * ey || 1e-9;
    let u = ((x - ax) * ex + (y - ay) * ey) / L2;
    u = u < 0 ? 0 : u > 1 ? 1 : u;
    const dx = x - ax - u * ex, dy = y - ay - u * ey;
    if (dx * dx + dy * dy <= d * d) return true;
  }
  return inside;
}

/**
 * The roof-fade rule (pure): per building 1 = roof shown, 0 = faded. `men` holds (x, y) pairs of the player's
 * own able men on foot; `close` = zoomed in to true scale.
 */
export function roofShown(index: BuildingIndex, men: ArrayLike<number>, nMen: number, close: boolean, out: Uint8Array<ArrayBufferLike> = new Uint8Array(index.buildings.length)): Uint8Array<ArrayBufferLike> {
  out.fill(close ? 0 : 1);
  if (close) return out;
  for (let k = 0; k < nMen; k++) {
    const x = men[2 * k]!, y = men[2 * k + 1]!;
    const c = Math.floor(x / BUCKET_M), r = Math.floor(y / BUCKET_M);
    if (c < 0 || r < 0 || c >= index.cols || r >= index.rows) continue;
    for (const i of index.buckets[r * index.cols + c]!) if (out[i] && nearPolygon(index.buildings[i]!.footprint, x, y, ROOF_NEAR_M)) out[i] = 0;
  }
  return out;
}

const hexN = (c: string) => parseInt(c.slice(1), 16);

/**
 * One floor of an interior (M7.5c; any floor `fl`, M7.5d): halls and stair rooms a shade lighter, inner walls
 * (thinner than the outer ones) with their doorway gaps and a light threshold, and the stairs hatched with their
 * steps (the flight up from this floor, and the head of the flight from the floor below).
 */
function drawInterior(f: Graphics, b: Building, floor: number, outline: number, fl = 0, soft = false): void {
  const it = b.interior!;
  for (const r of it.rooms) {
    if (r.floor !== fl || r.kind === "room") continue;
    f.poly(r.poly).fill({ color: shade(floor, r.kind === "stair" ? 1.12 : 1.06) });
  }
  for (const s of it.stairs) {
    if (s.floor !== fl && s.floor + 1 !== fl) continue;
    const L = Math.hypot(s.x1 - s.x0, s.y1 - s.y0) || 1, ux = (s.x1 - s.x0) / L, uy = (s.y1 - s.y0) / L, nx = -uy * s.widthM / 2, ny = ux * s.widthM / 2;
    f.poly([s.x0 + nx, s.y0 + ny, s.x1 + nx, s.y1 + ny, s.x1 - nx, s.y1 - ny, s.x0 - nx, s.y0 - ny]).fill({ color: shade(floor, 0.8) });
    for (let d = 0.28; d < L; d += 0.28) f.moveTo(s.x0 + ux * d + nx, s.y0 + uy * d + ny).lineTo(s.x0 + ux * d - nx, s.y0 + uy * d - ny);
    f.stroke({ width: 0.05, color: shade(floor, 0.55) });
    // An arrow up the flight.
    f.moveTo(s.x0 + ux * 0.2, s.y0 + uy * 0.2).lineTo(s.x1 - ux * 0.3, s.y1 - uy * 0.3)
      .moveTo(s.x1 - ux * 0.3 + nx * 0.6 - ux * 0.35, s.y1 - uy * 0.3 + ny * 0.6 - uy * 0.35).lineTo(s.x1 - ux * 0.3, s.y1 - uy * 0.3)
      .lineTo(s.x1 - ux * 0.3 - nx * 0.6 - ux * 0.35, s.y1 - uy * 0.3 - ny * 0.6 - uy * 0.35).stroke({ width: 0.07, color: shade(floor, 0.45) });
  }
  for (const w of it.walls) {
    if (w.floor !== fl) continue;
    const L = Math.hypot(w.bx - w.ax, w.by - w.ay) || 1, ux = (w.bx - w.ax) / L, uy = (w.by - w.ay) / L;
    const doors = [...w.doors].sort((p, q) => p.offsetM - q.offsetM);
    let s0 = 0;
    const piece = (a: number, c: number) => { if (c > a) f.moveTo(w.ax + ux * a, w.ay + uy * a).lineTo(w.ax + ux * c, w.ay + uy * c); };
    for (const d of doors) { piece(s0, d.offsetM - d.widthM / 2); s0 = d.offsetM + d.widthM / 2; }
    piece(s0, L);
    f.stroke({ width: Math.max(0.15, w.thicknessM), color: outline, cap: "square", ...(soft ? { alpha: 0.85 } : {}) });
    for (const d of doors) {
      const a = d.offsetM - d.widthM / 2, c = d.offsetM + d.widthM / 2;
      f.moveTo(w.ax + ux * a, w.ay + uy * a).lineTo(w.ax + ux * c, w.ay + uy * c).stroke({ width: 0.08, color: shade(floor, 1.25) });
    }
  }
}
/** A building's plan on floor `fl` (M7.5d; the ground floor as in M7.5b/c): floor, outer walls with that floor's
 *  doors and windows, and the interior of that floor. */
function drawPlan(f: Graphics, b: Building, fl: number, floor: number, outline: number, soft = false): void {
  const fp = b.footprint, n = fp.length / 2;
  f.poly(fp).fill({ color: floor });
  // Photo: a soft shade along the walls inside (two bands), as light falls in a roofless room seen from above.
  if (soft) {
    f.poly(fp).stroke({ width: 1.4, color: shade(floor, 0.62), alpha: 0.14, alignment: 1 });
    f.poly(fp).stroke({ width: 0.7, color: shade(floor, 0.62), alpha: 0.16, alignment: 1 });
  }
  // Floorboards / tiles: faint lines every 1 m along the long side.
  if (n === 4) {
    const e0 = Math.hypot(fp[2]! - fp[0]!, fp[3]! - fp[1]!), e1 = Math.hypot(fp[6]! - fp[0]!, fp[7]! - fp[1]!);
    const [ux, uy, L, vx, vy, M] = e0 >= e1
      ? [(fp[2]! - fp[0]!) / e0, (fp[3]! - fp[1]!) / e0, e0, (fp[6]! - fp[0]!) / e1, (fp[7]! - fp[1]!) / e1, e1]
      : [(fp[6]! - fp[0]!) / e1, (fp[7]! - fp[1]!) / e1, e1, (fp[2]! - fp[0]!) / e0, (fp[3]! - fp[1]!) / e0, e0];
    for (let s = 1; s < M; s += 1) f.moveTo(fp[0]! + vx * s, fp[1]! + vy * s).lineTo(fp[0]! + vx * s + ux * L, fp[1]! + vy * s + uy * L);
    f.stroke({ width: 0.06, color: shade(floor, 0.82), alpha: soft ? 0.45 : 1 });
  }
  // Outer walls, drawn inside the footprint, with gaps for doors and glass in the windows.
  let cx = 0, cy = 0;
  for (let k = 0; k < n; k++) { cx += fp[2 * k]!; cy += fp[2 * k + 1]!; }
  cx /= n; cy /= n;
  const t = Math.max(0.25, b.wallThicknessM);
  for (let k = 0; k < n; k++) {
    const ax = fp[2 * k]!, ay = fp[2 * k + 1]!, bx = fp[(2 * k + 2) % fp.length]!, by = fp[(2 * k + 3) % fp.length]!;
    const L = Math.hypot(bx - ax, by - ay) || 1, ux = (bx - ax) / L, uy = (by - ay) / L;
    let nx = -uy, ny = ux;
    if ((cx - ax) * nx + (cy - ay) * ny < 0) { nx = -nx; ny = -ny; }
    const ox = nx * t / 2, oy = ny * t / 2;
    const ops = b.openings.filter((o) => o.wall === k && (o.floor ?? 0) === fl).sort((p, q) => p.offsetM - q.offsetM);
    let s = 0;
    const piece = (s0: number, s1: number) => { if (s1 > s0) f.moveTo(ax + ux * s0 + ox, ay + uy * s0 + oy).lineTo(ax + ux * s1 + ox, ay + uy * s1 + oy); };
    for (const o of ops) { piece(s, o.offsetM - o.widthM / 2); s = o.offsetM + o.widthM / 2; }
    piece(s, L);
    f.stroke({ width: t, color: outline, cap: "square", ...(soft ? { alpha: 0.92 } : {}) });
    for (const o of ops) {
      if (o.kind !== "window") continue;
      const s0 = o.offsetM - o.widthM / 2, s1 = o.offsetM + o.widthM / 2;
      f.moveTo(ax + ux * s0 + ox, ay + uy * s0 + oy).lineTo(ax + ux * s1 + ox, ay + uy * s1 + oy).stroke({ width: t * 0.6, color: 0xa9cbd6 });
    }
  }
  if (b.interior) drawInterior(f, b, floor, outline, fl, soft);
}

/** Photo: the wall colour of a floor plan, a dark warm shade of its floor rather than the flat look's black ink. */
const softWall = (floor: number) => shade(floor, 0.36);

const PITCHED_FLAT = new Set(["warehouse", "apartment-block", "office"]);
/** Photo: frames the eave line shows when a roof starts to fade (0.3 s at 60 frames a second). */
export const EAVE_FLASH_FRAMES = 18;

/** Floors and roofs of a map's buildings. Children are in world metres. */
export class BuildingLayers {
  readonly floors = new Graphics();
  /** Upper floors (M7.5d): one Graphics per building and floor, built when first shown, over the ground floors. */
  readonly upper = new Container();
  readonly roofs = new Container();
  private roofG: (Graphics | Sprite)[] = [];
  /** Photo: the roof atlas pages, the eave flash lines (one cached Graphics per building) and frames left per building. */
  private roofSources: BufferImageSource[] = [];
  private readonly eaves = new Container();
  private eaveG = new Map<number, Graphics>();
  private flash: Uint8Array;
  private flashing = false;
  readonly atlas: RoofAtlas | null = null;
  private upperG = new Map<number, Graphics>();
  private shownFloor = 0;
  private readonly map: MapDef;
  private readonly floorColour: (b: Building) => number;
  private readonly outline: number;
  private alpha: Float32Array;
  private target: Uint8Array;
  readonly index: BuildingIndex;

  constructor(map: MapDef, app: Appearance | null, readonly photo = false) {
    this.index = buildingIndex(map);
    this.alpha = new Float32Array(map.buildings.length).fill(1);
    this.target = new Uint8Array(map.buildings.length).fill(1);
    this.flash = new Uint8Array(map.buildings.length);
    const outline = app?.map.outline ?? 0x1d2419;
    this.map = map;
    this.outline = outline;
    this.floorColour = (b) => (photo ? app?.photo?.floors[b.kind] : undefined) ?? app?.map.floors[b.kind] ?? 0x9a8a72;
    const f = this.floors;
    if (photo) {
      // One atlas for the map's roofs; a Sprite per building cut from it.
      const atlas = buildRoofAtlas(map.buildings, (b) => app?.photo?.roofs[b.kind] ?? app?.map.roofs[b.kind] ?? hexN(b.roofColour));
      this.atlas = atlas;
      this.roofSources = atlas.pages.map((p) => new BufferImageSource({ resource: p.data, width: p.w, height: p.h, format: "rgba8unorm", alphaMode: "premultiplied-alpha", scaleMode: "linear", autoGenerateMipmaps: true }));
      for (const it of atlas.items) {
        const s = new Sprite(new Texture({ source: this.roofSources[it.page]!, frame: new Rectangle(it.px, it.py, it.pw, it.ph) }));
        s.position.set(it.x, it.y); s.width = it.wM; s.height = it.hM;
        this.roofG.push(s);
        this.roofs.addChild(s);
      }
      this.roofs.addChild(this.eaves);
    }
    for (const b of map.buildings) {
      const fp = b.footprint, n = fp.length / 2;
      const floor = this.floorColour(b);
      drawPlan(f, b, 0, floor, photo ? softWall(floor) : outline, photo);
      if (photo) continue;
      // Roof: a hard shadow, flat colour, the ridge with one half a shade darker, tile rows, a dark outline.
      const g = new Graphics();
      const h = b.storeys * b.storeyHeightM, off = Math.min(5, 0.22 * h + 0.5);
      g.poly(fp.map((v, i) => v + (i % 2 === 0 ? off * 0.8 : off))).fill({ color: 0x000000, alpha: 0.3 });
      const roof = app?.map.roofs[b.kind] ?? hexN(b.roofColour);
      g.poly(fp).fill({ color: roof });
      if (n === 4) {
        const e0 = Math.hypot(fp[2]! - fp[0]!, fp[3]! - fp[1]!), e1 = Math.hypot(fp[4]! - fp[2]!, fp[5]! - fp[3]!);
        const [A, Z] = e0 >= e1 ? [[fp[6]!, fp[7]!, fp[0]!, fp[1]!], [fp[2]!, fp[3]!, fp[4]!, fp[5]!]] : [[fp[0]!, fp[1]!, fp[2]!, fp[3]!], [fp[4]!, fp[5]!, fp[6]!, fp[7]!]];
        const m0x = (A[0]! + A[2]!) / 2, m0y = (A[1]! + A[3]!) / 2, m1x = (Z[0]! + Z[2]!) / 2, m1y = (Z[1]! + Z[3]!) / 2;
        if (!PITCHED_FLAT.has(b.kind)) {
          g.poly([A[0]!, A[1]!, m0x, m0y, m1x, m1y, Z[2]!, Z[3]!]).fill({ color: shade(roof, 0.84) });
          // Tile rows parallel to the ridge.
          const half = Math.hypot(A[2]! - A[0]!, A[3]! - A[1]!) / 2;
          const vx = (A[2]! - m0x) / (half || 1), vy = (A[3]! - m0y) / (half || 1);
          for (let s = 0.7; s < half; s += 0.7) {
            g.moveTo(m0x + vx * s, m0y + vy * s).lineTo(m1x + vx * s, m1y + vy * s);
            g.moveTo(m0x - vx * s, m0y - vy * s).lineTo(m1x - vx * s, m1y - vy * s);
          }
          g.stroke({ width: 0.1, color: shade(roof, 0.7), alpha: 0.6 });
          g.moveTo(m0x, m0y).lineTo(m1x, m1y).stroke({ width: 0.35, color: shade(roof, 0.6) });
        } else {
          // Flat roof: a parapet band.
          g.poly(fp).stroke({ width: 0.6, color: shade(roof, 0.82), alignment: 1 });
        }
      }
      g.poly(fp).stroke({ width: 0.3, color: outline, alignment: 0.5 });
      this.roofG.push(g);
      this.roofs.addChild(g);
    }
  }

  /** The floor the player has on screen (M7.5d floor switch; 0 = ground). */
  setFloor(k: number): void { this.shownFloor = Math.max(0, k | 0); }

  /** The floor of building i on screen: the one switched to, or its top floor if it has fewer. */
  floorShown(i: number): number {
    const b = this.map.buildings[i];
    return b ? Math.min(this.shownFloor, b.storeys - 1) : 0;
  }

  /** Index of the building whose footprint holds (x, y), or -1. */
  buildingAt(x: number, y: number): number {
    const c = Math.floor(x / BUCKET_M), r = Math.floor(y / BUCKET_M);
    if (c < 0 || r < 0 || c >= this.index.cols || r >= this.index.rows) return -1;
    for (const i of this.index.buckets[r * this.index.cols + c]!) if (nearPolygon(this.index.buildings[i]!.footprint, x, y, 0)) return i;
    return -1;
  }

  /**
   * Per frame: the roof-fade rule, then each roof's alpha a step towards its target (about 8 frames). (`_pxPerM`, the
   * zoom, is no longer needed: the eave line is a one-pixel line in any zoom.)
   */
  update(men: ArrayLike<number>, nMen: number, close: boolean, _pxPerM = 10): void {
    roofShown(this.index, men, nMen, close, this.target);
    // Upper floors (M7.5d): the floor switched to, where the roof is lifted (a building with an interior).
    for (const g of this.upperG.values()) g.visible = false;
    if (this.shownFloor > 0) {
      for (let i = 0; i < this.roofG.length; i++) {
        const b = this.map.buildings[i]!;
        const fl = this.floorShown(i);
        if (fl <= 0 || !b.interior || this.alpha[i]! >= 1) continue;
        const key = i * 64 + fl;
        let g = this.upperG.get(key);
        if (!g) {
          g = new Graphics();
          const floor = shade(this.floorColour(b), 1.04);
          drawPlan(g, b, fl, floor, this.photo ? softWall(floor) : this.outline, this.photo);
          this.upperG.set(key, g);
          this.upper.addChild(g);
        }
        g.visible = true;
      }
    }
    for (let i = 0; i < this.roofG.length; i++) {
      const want = this.target[i]!, a = this.alpha[i]!;
      if (a === want) continue;
      const na = want > a ? Math.min(1, a + 0.125) : Math.max(0, a - 0.125);
      if (this.photo && a === 1 && want === 0) { this.flash[i] = EAVE_FLASH_FRAMES; this.flashing = true; }
      this.alpha[i] = na;
      const g = this.roofG[i]!;
      g.alpha = na;
      g.visible = na > 0;
    }
    if (this.flashing) this.flashEaves();
  }

  /**
   * Photo: the light dashed eave line of roofs that just started to fade (0.3 s). Review fix: each building's line is
   * built once (dashes in metres, a one-pixel line at any zoom) and kept; per frame only its alpha changes (it was
   * cleared and re-tessellated every frame, 20-55 ms a frame on a phone when a whole village opened at once).
   */
  private flashEaves(): void {
    let any = false;
    for (let i = 0; i < this.flash.length; i++) {
      const fr = this.flash[i]!;
      const g = this.eaveG.get(i);
      if (fr === 0) { if (g) g.visible = false; continue; }
      this.flash[i] = fr - 1;
      any = true;
      const e = g ?? this.eaveLine(i);
      e.visible = fr > 1;
      e.alpha = Math.min(1, fr / 6) * 0.8;
    }
    this.flashing = any;
  }

  private eaveLine(i: number): Graphics {
    const g = new Graphics(), fp = this.map.buildings[i]!.footprint, n = fp.length / 2, dash = 0.35, gap = 0.25;
    for (let k = 0; k < n; k++) {
      const ax = fp[2 * k]!, ay = fp[2 * k + 1]!, bx = fp[(2 * k + 2) % fp.length]!, by = fp[(2 * k + 3) % fp.length]!;
      const L = Math.hypot(bx - ax, by - ay) || 1, ux = (bx - ax) / L, uy = (by - ay) / L;
      for (let s = 0; s < L; s += dash + gap) g.moveTo(ax + ux * s, ay + uy * s).lineTo(ax + ux * Math.min(L, s + dash), ay + uy * Math.min(L, s + dash));
    }
    g.stroke({ width: 1, color: 0xeee8d8, pixelLine: true });
    this.eaveG.set(i, g);
    this.eaves.addChild(g);
    return g;
  }

  /** Eave lines built so far (tests: built once per building, not per frame). */
  eaveLines(): number { return this.eaveG.size; }

  /** Frames of eave flash left for building i (tests). */
  eaveFlash(i: number): number { return this.flash[i] ?? 0; }

  /** The roof display object of building i (tests). */
  roofObject(i: number): Graphics | Sprite | undefined { return this.roofG[i]; }

  /** The roof's current alpha (tests, screenshots). */
  roofAlpha(i: number): number { return this.alpha[i] ?? 1; }

  destroy(): void {
    this.floors.destroy(); this.upper.destroy({ children: true }); this.roofs.destroy({ children: true, texture: true });
    for (const s of this.roofSources) s.destroy();
  }
}

/**
 * Debug (M7.5c): the interior navigation graphs of every building — nodes (exits orange, doorway nodes cyan), the
 * edges inside each room (faint), the steps through doorways (white) and out of the exits (orange).
 */
export function interiorGraphOverlay(map: MapDef, breaches: readonly { owner: "obstacle" | "building"; id: number; part: number; offsetM: number; widthM: number }[] = []): Graphics {
  const g = new Graphics();
  map.buildings.forEach((b, bi) => {
    if (!b.interior) return;
    const gr = buildInteriorGraph(b, bi, breaches);
    for (const list of gr.roomNodes.filter((l) => l.length > 0 && gr.nodes[l[0]!]!.floor === 0)) {
      for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
        const p = gr.nodes[list[i]!]!, q = gr.nodes[list[j]!]!;
        g.moveTo(p.x, p.y).lineTo(q.x, q.y);
      }
    }
    g.stroke({ width: 0.06, color: 0x7fe0ff, alpha: 0.55 });
    for (let k = 0; k + 1 < gr.through.length; k += 2) {
      const p = gr.nodes[gr.through[k]!]!, q = gr.nodes[gr.through[k + 1]!]!;
      g.moveTo(p.x, p.y).lineTo(q.x, q.y);
    }
    g.stroke({ width: 0.12, color: 0xffffff });
    for (const n of gr.nodes) if (n.exit) g.moveTo(n.x, n.y).lineTo(n.ox, n.oy);
    g.stroke({ width: 0.12, color: 0xff9a2e });
    for (const n of gr.nodes) g.circle(n.x, n.y, 0.16).fill({ color: n.exit ? 0xff9a2e : 0x7fe0ff });
  });
  return g;
}
