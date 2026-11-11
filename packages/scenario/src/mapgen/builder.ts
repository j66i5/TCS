/**
 * MapBuilder: mutable working copy of a map while a generator paints it. Rasterises polygons and
 * polylines into the cell grids, keeps an occupancy grid so buildings do not land on roads, water or
 * each other, and produces the final MapDef.
 */
import type { BuildingKindDef, Coords, MapDef, Opening, TerrainCatalog } from "@tcs/sim";
import { hypot2, nextInt, nextRange, type RngState } from "@tcs/sim";
import { bbox, convexOverlap, distToPolyline, inflate } from "./geom";

/** Occupancy flags per cell. */
export const OCC_ROAD = 1, OCC_WATER = 2, OCC_BUILDING = 4, OCC_RESERVED = 8;

export class MapBuilder {
  readonly cols: number;
  readonly rows: number;
  readonly heights: Float32Array;
  readonly surface: Uint8Array;
  readonly vegetation: Uint8Array;
  readonly occ: Uint8Array;
  readonly surfacePalette: string[] = [];
  readonly vegetationPalette: string[] = [];
  readonly map: Pick<MapDef, "obstacles" | "buildings" | "roads" | "water">;
  private nextId = 1;
  private placed: Coords[] = [];

  constructor(
    readonly widthM: number,
    readonly heightM: number,
    readonly cellSizeM: number,
    readonly terrain: TerrainCatalog,
    readonly rng: RngState,
    baseSurface: string,
  ) {
    this.cols = Math.ceil(widthM / cellSizeM);
    this.rows = Math.ceil(heightM / cellSizeM);
    this.heights = new Float32Array((this.cols + 1) * (this.rows + 1));
    this.surface = new Uint8Array(this.cols * this.rows).fill(this.sid(baseSurface));
    this.vegetation = new Uint8Array(this.cols * this.rows);
    this.occ = new Uint8Array(this.cols * this.rows);
    this.map = { obstacles: [], buildings: [], roads: [], water: [] };
  }

  id(): number { return this.nextId++; }

  /** Palette index of a surface (registers it on first use). */
  sid(id: string): number {
    if (!this.terrain.surfaces[id]) throw new Error(`map generator uses unknown surface '${id}'`);
    let i = this.surfacePalette.indexOf(id);
    if (i < 0) { i = this.surfacePalette.length; this.surfacePalette.push(id); }
    return i;
  }

  /** Vegetation byte (1-based; 0 = none). */
  vid(id: string | null): number {
    if (id === null) return 0;
    if (!this.terrain.vegetation[id]) throw new Error(`map generator uses unknown vegetation '${id}'`);
    let i = this.vegetationPalette.indexOf(id);
    if (i < 0) { i = this.vegetationPalette.length; this.vegetationPalette.push(id); }
    return i + 1;
  }

  /** Cell centre coordinates. */
  cx(c: number): number { return (c + 0.5) * this.cellSizeM; }
  cy(r: number): number { return (r + 0.5) * this.cellSizeM; }

  /** Call fn for every cell whose centre lies inside the polygon. */
  forPolygon(poly: readonly number[], fn: (cell: number) => void): void {
    const b = bbox(poly);
    const c0 = Math.max(0, Math.floor(b.x0 / this.cellSizeM)), c1 = Math.min(this.cols - 1, Math.floor(b.x1 / this.cellSizeM));
    const r0 = Math.max(0, Math.floor(b.y0 / this.cellSizeM)), r1 = Math.min(this.rows - 1, Math.floor(b.y1 / this.cellSizeM));
    const n = poly.length / 2;
    for (let r = r0; r <= r1; r++) {
      const y = this.cy(r);
      for (let c = c0; c <= c1; c++) {
        const x = this.cx(c);
        let inside = false;
        for (let i = 0, j = n - 1; i < n; j = i++) {
          const xi = poly[i * 2]!, yi = poly[i * 2 + 1]!, xj = poly[j * 2]!, yj = poly[j * 2 + 1]!;
          if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
        }
        if (inside) fn(r * this.cols + c);
      }
    }
  }

  /** Call fn for every cell whose centre is within `halfWidth` of the polyline. */
  forPolyline(pts: readonly number[], halfWidth: number, fn: (cell: number, dist: number) => void): void {
    const b = bbox(pts);
    const m = halfWidth + this.cellSizeM;
    const c0 = Math.max(0, Math.floor((b.x0 - m) / this.cellSizeM)), c1 = Math.min(this.cols - 1, Math.floor((b.x1 + m) / this.cellSizeM));
    const r0 = Math.max(0, Math.floor((b.y0 - m) / this.cellSizeM)), r1 = Math.min(this.rows - 1, Math.floor((b.y1 + m) / this.cellSizeM));
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const d = distToPolyline(this.cx(c), this.cy(r), pts);
        if (d <= halfWidth) fn(r * this.cols + c, d);
      }
    }
  }

  paintSurface(poly: readonly number[], surface: string, onlyIfFree = false): void {
    const s = this.sid(surface);
    this.forPolygon(poly, (i) => { if (!onlyIfFree || this.occ[i] === 0) this.surface[i] = s; });
  }

  paintVegetation(poly: readonly number[], veg: string | null, onlyIfFree = true): void {
    const v = this.vid(veg);
    this.forPolygon(poly, (i) => { if (!onlyIfFree || this.occ[i] === 0) this.vegetation[i] = v; });
  }

  reserve(poly: readonly number[]): void {
    this.forPolygon(poly, (i) => { this.occ[i]! |= OCC_RESERVED; });
  }

  /** True if a road of this width along `points` would cross a building or reserved settlement ground. */
  roadBlocked(points: Coords, widthM: number): boolean {
    let blocked = false;
    this.forPolyline(points, widthM / 2, (i) => { if (this.occ[i]! & (OCC_BUILDING | OCC_RESERVED)) blocked = true; });
    return blocked;
  }

  addRoad(points: Coords, widthM: number, surface: string): void {
    const s = this.sid(surface);
    this.forPolyline(points, widthM / 2 + this.cellSizeM * 0.25, (i) => {
      this.surface[i] = s;
      this.vegetation[i] = 0;
      this.occ[i]! |= OCC_ROAD;
    });
    this.map.roads.push({ id: this.id(), points: round(points), widthM, surface });
    this.cutObstacles(points, widthM / 2 + 1.5);
  }

  addStream(points: Coords, widthM: number, depthM: number, bankVeg: string | null, bankM: number): void {
    const shallow = this.sid("water-shallow");
    const v = this.vid(bankVeg);
    if (bankVeg) this.forPolyline(points, widthM / 2 + bankM, (i) => { if (this.occ[i] === 0) this.vegetation[i] = v; });
    this.forPolyline(points, widthM / 2 + this.cellSizeM * 0.3, (i) => {
      if (this.occ[i]! & OCC_ROAD) return; // bridges/culverts: the road wins
      this.surface[i] = shallow;
      this.vegetation[i] = 0;
      this.occ[i]! |= OCC_WATER;
    });
    this.map.water.push({ id: this.id(), kind: "stream", points: round(points), widthM, depthM });
  }

  /** Add a pond unless it would touch a building or a road; returns whether it was added. */
  addPond(poly: Coords, depthM: number): boolean {
    let clear = true;
    this.forPolygon(inflate(poly, 6), (i) => { if (this.occ[i]! & (OCC_BUILDING | OCC_ROAD)) clear = false; });
    if (!clear) return false;
    const deep = this.sid("water-deep"), shallow = this.sid("water-shallow");
    this.forPolygon(inflate(poly, 3), (i) => { if (!(this.occ[i]! & OCC_ROAD)) { this.surface[i] = shallow; this.vegetation[i] = 0; this.occ[i]! |= OCC_WATER; } });
    this.forPolygon(poly, (i) => { if (!(this.occ[i]! & OCC_ROAD)) this.surface[i] = deep; });
    this.map.water.push({ id: this.id(), kind: "pond", points: round(poly), widthM: 0, depthM });
    return true;
  }

  addObstacle(kind: string, points: Coords): void {
    const k = this.terrain.obstacles[kind];
    if (!k) throw new Error(`map generator uses unknown obstacle '${kind}'`);
    if (points.length < 4) return;
    // Existing roads cut the new obstacle, so no wall or fence ever runs across a road.
    let parts: MapDef["obstacles"] = [{ id: this.id(), kind, points: round(points), heightM: k.heightM, thicknessM: k.thicknessM, material: k.material }];
    for (const r of this.map.roads) parts = parts.flatMap((o) => this.splitByRoad(o, r.points, r.widthM / 2 + 1.5));
    this.map.obstacles.push(...parts);
  }

  /**
   * A new road cuts a gap (a gate) in every wall, fence or hedge it crosses. Railway embankments are left
   * whole (the road passes under or over on a bridge).
   */
  private cutObstacles(road: Coords, halfGap: number): void {
    const out: typeof this.map.obstacles = [];
    for (const o of this.map.obstacles) out.push(...this.splitByRoad(o, road, halfGap));
    this.map.obstacles = out;
  }

  /** Split one obstacle where it passes within `halfGap` of a road centre line. */
  private splitByRoad(o: MapDef["obstacles"][number], road: Coords, halfGap: number): MapDef["obstacles"] {
    const rb = bbox(road), ob = bbox(o.points);
    if (o.kind === "embankment" || ob.x1 < rb.x0 - halfGap || ob.x0 > rb.x1 + halfGap || ob.y1 < rb.y0 - halfGap || ob.y0 > rb.y1 + halfGap) return [o];
    const pieces: Coords[] = [];
    let cur: Coords = [];
    let last: [number, number] | null = null; // last sample outside the gap
    let cut = false;
    const flush = () => {
      if (last && cur.length >= 2 && (cur[cur.length - 2] !== last[0] || cur[cur.length - 1] !== last[1])) cur.push(last[0], last[1]);
      if (cur.length >= 4) pieces.push(cur);
      cur = [];
    };
    for (let i = 0; i + 3 < o.points.length; i += 2) {
      const ax = o.points[i]!, ay = o.points[i + 1]!, bx = o.points[i + 2]!, by = o.points[i + 3]!;
      const n = Math.max(1, Math.ceil(hypot2(bx - ax, by - ay) / 0.5));
      for (let k = i === 0 ? 0 : 1; k <= n; k++) {
        const x = ax + ((bx - ax) * k) / n, y = ay + ((by - ay) * k) / n;
        if (distToPolyline(x, y, road) < halfGap) {
          if (cur.length > 0) flush();
          cut = true;
          last = null;
          continue;
        }
        // Keep piece starts and original corners; straight runs between them need no samples.
        if (cur.length === 0 || k === n) cur.push(x, y);
        last = [x, y];
      }
    }
    if (cur.length >= 4) pieces.push(cur);
    if (!cut) return [o];
    return pieces.map((pc, k) => ({ ...o, id: k === 0 ? o.id : this.id(), points: round(pc) }));
  }

  /** True if a footprint (inflated by `margin`) is clear of roads, water, reserved cells and other buildings, and on the map. */
  canPlace(footprint: Coords, margin: number, allowReserved = false): boolean {
    const b = bbox(footprint);
    if (b.x0 < 2 || b.y0 < 2 || b.x1 > this.widthM - 2 || b.y1 > this.heightM - 2) return false;
    const grown = inflate(footprint, margin);
    let ok = true;
    const mask = allowReserved ? OCC_ROAD | OCC_WATER | OCC_BUILDING : OCC_ROAD | OCC_WATER | OCC_BUILDING | OCC_RESERVED;
    this.forPolygon(grown, (i) => { if (this.occ[i]! & mask) ok = false; });
    if (!ok) return false;
    const gb = bbox(grown);
    // Exact test against road outlines (the cell grid alone lets corners clip a road edge).
    const probes: [number, number][] = [];
    for (let k = 0; k < grown.length; k += 2) {
      const j = (k + 2) % grown.length;
      probes.push([grown[k]!, grown[k + 1]!], [(grown[k]! + grown[j]!) / 2, (grown[k + 1]! + grown[j + 1]!) / 2]);
    }
    for (const r of this.map.roads) {
      const rb = bbox(r.points);
      if (rb.x1 + r.widthM < gb.x0 || rb.x0 - r.widthM > gb.x1 || rb.y1 + r.widthM < gb.y0 || rb.y0 - r.widthM > gb.y1) continue;
      if (probes.some(([x, y]) => distToPolyline(x, y, r.points) < r.widthM / 2 + 0.3)) return false;
    }
    for (const p of this.placed) {
      const pb = bbox(p);
      if (pb.x1 < gb.x0 || pb.x0 > gb.x1 || pb.y1 < gb.y0 || pb.y0 > gb.y1) continue;
      if (convexOverlap(p, grown)) return false;
    }
    return true;
  }

  /**
   * Add a building with a rectangular footprint (from geom.rect: wall 0 = front). Doors on the front,
   * windows spread along the walls. Returns false (and adds nothing) if the spot is not free.
   */
  addBuilding(kindId: string, footprint: Coords, opts: { margin?: number; allowReserved?: boolean; storeys?: number } = {}): boolean {
    const kind = this.terrain.buildings[kindId];
    if (!kind) throw new Error(`map generator uses unknown building kind '${kindId}'`);
    if (!this.canPlace(footprint, opts.margin ?? 1.5, opts.allowReserved ?? false)) return false;
    const floor = this.sid("floor");
    const mark = (i: number) => { this.surface[i] = floor; this.vegetation[i] = 0; this.occ[i]! |= OCC_BUILDING; };
    this.forPolygon(footprint, mark);
    // Small buildings may cover no cell centre: always mark the cell under the centroid.
    let cx = 0, cy = 0;
    for (let k = 0; k < footprint.length; k += 2) { cx += footprint[k]!; cy += footprint[k + 1]!; }
    const n = footprint.length / 2;
    const cc = Math.floor(cx / n / this.cellSizeM), cr = Math.floor(cy / n / this.cellSizeM);
    if (cc >= 0 && cr >= 0 && cc < this.cols && cr < this.rows) mark(cr * this.cols + cc);
    this.placed.push(footprint);
    const storeys = opts.storeys ?? kind.storeys[0] + nextInt(this.rng, "mapgen/buildings", kind.storeys[1] - kind.storeys[0] + 1);
    this.map.buildings.push({
      id: this.id(),
      kind: kindId,
      footprint: round(footprint),
      storeys,
      storeyHeightM: kind.storeyHeightM,
      wallMaterial: kind.wallMaterial,
      wallThicknessM: kind.wallThicknessM,
      openings: openingsFor(kind, footprint, this.rng),
      roofColour: kind.roofColours[nextInt(this.rng, "mapgen/buildings", kind.roofColours.length)]!,
    });
    return true;
  }

  build(id: string, name: string, meta: MapDef["meta"]): MapDef {
    return {
      id, name, widthM: this.widthM, heightM: this.heightM, cellSizeM: this.cellSizeM, cols: this.cols, rows: this.rows,
      heights: this.heights,
      surfacePalette: [...this.surfacePalette], surface: this.surface,
      vegetationPalette: [...this.vegetationPalette], vegetation: this.vegetation,
      obstacles: this.map.obstacles, buildings: this.map.buildings, roads: this.map.roads, water: this.map.water,
      meta,
    };
  }
}

/** Round coordinates to centimetres: smaller files, and no float noise in saved maps. */
function round(c: Coords): Coords {
  return c.map((v) => Math.round(v * 100) / 100);
}

function openingsFor(kind: BuildingKindDef, fp: Coords, rng: RngState): Opening[] {
  const out: Opening[] = [];
  const big = kind.storeyHeightM >= 4; // barns, warehouses, churches: large doors
  for (let w = 0; w < 4; w++) {
    const ax = fp[w * 2]!, ay = fp[w * 2 + 1]!, bx = fp[((w + 1) % 4) * 2]!, by = fp[((w + 1) % 4) * 2 + 1]!;
    const len = hypot2(bx - ax, by - ay);
    if (w === 0 || (w === 2 && nextRange(rng, "mapgen/buildings", 0, 1) < 0.4)) {
      const dw = big ? 4 : 1.0;
      out.push({ wall: w, offsetM: round1(nextRange(rng, "mapgen/buildings", 0.25, 0.75) * len), widthM: dw, kind: "door", sillM: 0, headM: big ? 4 : 2.1 });
    }
    if (big && kind.wallThicknessM < 0.1) continue; // sheds, barns, warehouses: few windows
    const nWin = Math.floor(len / 3.5);
    for (let k = 1; k < nWin; k++) {
      const off = (k * len) / nWin;
      if (out.some((o) => o.wall === w && Math.abs(o.offsetM - off) < 1.5)) continue;
      out.push({ wall: w, offsetM: round1(off), widthM: 1.2, kind: "window", sillM: 0.9, headM: 2.1 });
    }
  }
  return out;
}

const round1 = (v: number) => Math.round(v * 10) / 10;
