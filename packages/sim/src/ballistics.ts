/**
 * Ballistics tables derived from the map and the catalog at battle start (never saved): coarse height and
 * vegetation grids that let most projectiles skip collision tests, per-wall-segment properties, per-material
 * and per-ammunition numbers pre-multiplied for the inner loop.
 */
import type { Catalog } from "./catalog";
import type { MapDef, Opening } from "./map";
import { PI, sin, sqrt } from "./math";
import type { MapIndex } from "./terrain";

export interface SegInfo {
  heightM: number;
  thicknessM: number;
  material: number;
  /** Segment length, m. */
  len: number;
  /** Unit normal (either side). */
  nx: number;
  ny: number;
  /** Doors and windows on this wall (buildings only). */
  openings: Opening[] | null;
}

export interface MaterialRT {
  id: string;
  resistance: number;
  /** sin of the largest angle from the surface at which a ricochet is possible. */
  sinCrit: number;
}

export interface AmmoRT {
  id: string;
  /** Area / (2 x mass). Deceleration = kDrag x air density x Cd(v) x v^2, with Cd(v) = dragA + dragB / v <= dragMax. */
  kDrag: number;
  dragA: number;
  dragB: number;
  dragMax: number;
  penSteelMm: number;
  penV: number;
  tracer: boolean;
}

export interface BallisticsCtx {
  /** Coarse grid for quick rejection, 8 m buckets. */
  bucketM: number;
  bcols: number;
  brows: number;
  /** Highest ground in each bucket (with a margin for neighbours). */
  maxGround: Float32Array;
  /** Highest vegetation top in each bucket (absolute), or -Infinity if none. */
  maxVegTop: Float32Array;
  /** 1 if a wall segment runs through the bucket or one of its eight neighbours. */
  nearWall: Uint8Array;
  seg: SegInfo[];
  materials: MaterialRT[];
  /** Material index per surface palette entry of the map. */
  surfaceMaterial: Int32Array;
  /** Stopping chance per metre and height per vegetation palette entry (index = vegetation byte - 1). */
  vegStopPerM: Float32Array;
  vegHeightM: Float32Array;
  ammo: AmmoRT[];
  deflectionRad: number;
  scatterRad: number;
  minSpeed2: number;
  maxAgeTicks: number;
}

export function buildBallistics(map: MapDef, catalog: Catalog, index: MapIndex, tickHz: number): BallisticsCtx {
  const b = catalog.ballistics;
  const matIds = Object.keys(catalog.terrain.materials).sort();
  const materials: MaterialRT[] = matIds.map((id) => {
    const m = catalog.terrain.materials[id]!;
    return { id, resistance: m.resistance, sinCrit: sin((m.ricochetAngleDeg * PI) / 180) };
  });
  const matIndex = (id: string) => Math.max(0, matIds.indexOf(id));

  const bucketM = 8;
  const bcols = Math.ceil(map.widthM / bucketM), brows = Math.ceil(map.heightM / bucketM);
  const maxGround = new Float32Array(bcols * brows).fill(-Infinity);
  const maxVegTop = new Float32Array(bcols * brows).fill(-Infinity);
  const vegHeightM = new Float32Array(map.vegetationPalette.map((id) => catalog.terrain.vegetation[id]?.heightM ?? 0));
  const vegStopPerM = new Float32Array(map.vegetationPalette.map((id) => catalog.terrain.vegetation[id]?.stoppingPerM ?? 0));
  const w = map.cols + 1;
  for (let r = 0; r < map.rows; r++) {
    for (let c = 0; c < map.cols; c++) {
      const h = Math.max(map.heights[r * w + c]!, map.heights[r * w + c + 1]!, map.heights[(r + 1) * w + c]!, map.heights[(r + 1) * w + c + 1]!);
      const v = map.vegetation[r * map.cols + c]!;
      const top = v > 0 ? h + vegHeightM[v - 1]! : -Infinity;
      const c0 = Math.floor((c * map.cellSizeM) / bucketM), c1 = Math.min(bcols - 1, Math.floor(((c + 1) * map.cellSizeM - 1e-9) / bucketM));
      const r0 = Math.floor((r * map.cellSizeM) / bucketM), r1 = Math.min(brows - 1, Math.floor(((r + 1) * map.cellSizeM - 1e-9) / bucketM));
      for (let br = r0; br <= r1; br++) for (let bc = c0; bc <= c1; bc++) {
        const i = br * bcols + bc;
        if (h > maxGround[i]!) maxGround[i] = h;
        if (top > maxVegTop[i]!) maxVegTop[i] = top;
      }
    }
  }

  const obstacles = new Map(map.obstacles.map((o) => [o.id, o]));
  const buildings = new Map(map.buildings.map((bd) => [bd.id, bd]));
  const seg: SegInfo[] = index.segments.map((s) => {
    const ex = s.bx - s.ax, ey = s.by - s.ay;
    const len = sqrt(ex * ex + ey * ey) || 1;
    if (s.owner === "building") {
      const bd = buildings.get(s.id)!;
      const openings = bd.openings.filter((o) => o.wall === s.part);
      return { heightM: bd.storeys * bd.storeyHeightM, thicknessM: bd.wallThicknessM, material: matIndex(bd.wallMaterial), len, nx: ey / len, ny: -ex / len, openings: openings.length > 0 ? openings : null };
    }
    const o = obstacles.get(s.id)!;
    return { heightM: o.heightM, thicknessM: o.thicknessM, material: matIndex(o.material), len, nx: ey / len, ny: -ex / len, openings: null };
  });

  // Buckets with a wall in or next to them (dilated by one bucket so point samples along a path cannot miss).
  const nearWall = new Uint8Array(bcols * brows);
  for (const s of index.segments) {
    const ex = s.bx - s.ax, ey = s.by - s.ay;
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(ex), Math.abs(ey)) / (bucketM / 2)));
    for (let k = 0; k <= steps; k++) {
      const c = Math.floor((s.ax + (ex * k) / steps) / bucketM), r = Math.floor((s.ay + (ey * k) / steps) / bucketM);
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
        const cc = c + dc, rr = r + dr;
        if (cc >= 0 && rr >= 0 && cc < bcols && rr < brows) nearWall[rr * bcols + cc] = 1;
      }
    }
  }

  const surfaceMaterial = new Int32Array(map.surfacePalette.map((id) => matIndex(catalog.terrain.surfaces[id]?.material ?? "")));
  const ammo: AmmoRT[] = catalog.ammoIds.map((id) => {
    const a = catalog.ammo[id]!;
    const area = (PI * a.diameterM * a.diameterM) / 4;
    return { id, kDrag: area / (2 * a.projectileMassKg), dragA: a.drag.a, dragB: a.drag.b, dragMax: a.drag.max, penSteelMm: a.penetration.steelMm, penV: a.penetration.atVelocityMps, tracer: a.tracer };
  });
  return {
    bucketM, bcols, brows, maxGround, maxVegTop, nearWall, seg, materials, surfaceMaterial, vegStopPerM, vegHeightM, ammo,
    deflectionRad: (b.penetrationDeflectionDeg * PI) / 180,
    scatterRad: (b.ricochetScatterDeg * PI) / 180,
    minSpeed2: b.minSpeedMps * b.minSpeedMps,
    maxAgeTicks: Math.round(b.maxFlightSeconds * tickHz),
  };
}
