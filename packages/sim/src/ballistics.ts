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
  breaks: boolean;
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
  /** Impact speed above which penetration of bullet-breaking materials no longer rises (Infinity if none). */
  penCapV: number;
  massKg: number;
  tracer: boolean;
}

export interface HitboxRT {
  halfF: number; // half extent along the facing
  halfL: number; // half extent across it
  height: number;
  alongLength: boolean;
  bands: { group: number; from: number; to: number; halfWidth: number; armsTo: number }[];
}

export interface SoldierGrid {
  n: number;
  id: Int32Array;
  x: Float64Array; y: Float64Array; gz: Float64Array; cf: Float64Array; sf: Float64Array;
  posture: Uint8Array;
  /** Linked lists per bucket: head[bucket] -> soldier index -> next[index] ... (-1 ends). */
  head: Int32Array;
  next: Int32Array;
  /** 1 if a soldier is in the bucket or one of its eight neighbours. */
  near: Uint8Array;
  touched: Int32Array;
  touchedCount: number;
}

export function createSoldierGrid(buckets: number, capacity = 256): SoldierGrid {
  return {
    n: 0, id: new Int32Array(capacity), x: new Float64Array(capacity), y: new Float64Array(capacity), gz: new Float64Array(capacity),
    cf: new Float64Array(capacity), sf: new Float64Array(capacity), posture: new Uint8Array(capacity),
    head: new Int32Array(buckets).fill(-1), next: new Int32Array(capacity), near: new Uint8Array(buckets),
    touched: new Int32Array(capacity * 10), touchedCount: 0,
  };
}

export interface BallisticsCtx {
  /** Coarse grid for quick rejection, 8 m buckets. */
  bucketM: number;
  bcols: number;
  brows: number;
  /** Highest ground in each bucket and its eight neighbours. */
  maxGround: Float32Array;
  /** Highest vegetation top in each bucket and its eight neighbours (absolute), or -Infinity if none. */
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
  /** Body outlines per posture code (0 standing, 1 crouching, 2 prone). */
  hitboxes: HitboxRT[];
  /** Soldiers this tick, in arrays, bucketed on the coarse grid (rebuilt every tick; never saved). */
  soldiers: SoldierGrid;
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
    return { id, resistance: m.resistance, sinCrit: sin((m.ricochetAngleDeg * PI) / 180), breaks: m.breaksBullets };
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

  // Widen by one bucket (highest of the 3 x 3 neighbourhood), so point samples along a path cannot miss a
  // higher neighbouring bucket the path clips.
  const widen = (src: Float32Array): Float32Array => {
    const out = new Float32Array(src.length);
    for (let r = 0; r < brows; r++) for (let c = 0; c < bcols; c++) {
      let m = -Infinity;
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
        const rr = r + dr, cc = c + dc;
        if (rr >= 0 && cc >= 0 && rr < brows && cc < bcols && src[rr * bcols + cc]! > m) m = src[rr * bcols + cc]!;
      }
      out[r * bcols + c] = m;
    }
    return out;
  };
  const maxGroundWide = widen(maxGround), maxVegTopWide = widen(maxVegTop);

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
    return { id, kDrag: area / (2 * a.projectileMassKg), dragA: a.drag.a, dragB: a.drag.b, dragMax: a.drag.max, penSteelMm: a.penetration.steelMm, penV: a.penetration.atVelocityMps, penCapV: a.penetration.breakupVelocityMps ?? Infinity, massKg: a.projectileMassKg, tracer: a.tracer };
  });
  const groups = ["head", "neck", "chest", "abdomen", "pelvis", "arm", "leg"];
  const hitboxes: HitboxRT[] = (["standing", "crouching", "prone"] as const).map((p) => {
    const h = catalog.wounds.hitboxes[p];
    return {
      halfF: h.depthM / 2, halfL: h.widthM / 2, height: h.heightM, alongLength: h.along === "length",
      bands: h.bands.map((b) => ({ group: groups.indexOf(b.zone), from: b.from, to: b.to, halfWidth: b.halfWidthM, armsTo: b.armsToM ?? 0 })),
    };
  });
  return {
    hitboxes, soldiers: createSoldierGrid(bcols * brows),
    bucketM, bcols, brows, maxGround: maxGroundWide, maxVegTop: maxVegTopWide, nearWall, seg, materials, surfaceMaterial, vegStopPerM, vegHeightM, ammo,
    deflectionRad: (b.penetrationDeflectionDeg * PI) / 180,
    scatterRad: (b.ricochetScatterDeg * PI) / 180,
    minSpeed2: b.minSpeedMps * b.minSpeedMps,
    maxAgeTicks: Math.round(b.maxFlightSeconds * tickHz),
  };
}

/** Step between entries of a drop table, m. */
const DROP_STEP_M = 10;

/**
 * Drop below the line of departure at each 10 m of range for a bullet fired level at `v0` in standard air
 * (what a soldier's sights and training assume). Built once per ammunition and muzzle velocity.
 */
export function buildDropTable(catalog: Catalog, ammoId: string, v0: number, maxRangeM = 1500): Float32Array {
  const a = catalog.ammo[ammoId];
  const out = new Float32Array(Math.floor(maxRangeM / DROP_STEP_M) + 1);
  if (!a) return out;
  const b = catalog.ballistics;
  const k = ((PI * a.diameterM * a.diameterM) / 4 / (2 * a.projectileMassKg)) * b.airDensityKgM3;
  const dt = 1 / 240;
  let x = 0, z = 0, vx = v0, vz = 0, next = 1;
  while (next < out.length) {
    const v = sqrt(vx * vx + vz * vz);
    if (v < b.minSpeedMps) break;
    const cdv = Math.min(a.drag.max * v, a.drag.a * v + a.drag.b);
    const f = k * cdv * dt;
    vx -= f * vx; vz -= f * vz + b.gravityMps2 * dt;
    const px = x, pz = z;
    x += vx * dt; z += vz * dt;
    while (next < out.length && x >= next * DROP_STEP_M) {
      const t = (next * DROP_STEP_M - px) / (x - px);
      out[next] = -(pz + t * (z - pz));
      next++;
    }
  }
  for (; next < out.length; next++) out[next] = out[next - 1]! + 50; // beyond the bullet's reach
  return out;
}

/** Drop (m, positive) at `rangeM` for this ammunition and muzzle velocity; table cached in the battle context. */
export function dropAt(ctx: { catalog: Catalog; dropTables: Record<string, Float32Array> }, ammoId: string, v0: number, rangeM: number): number {
  const key = `${ammoId}@${v0}`;
  let t = ctx.dropTables[key];
  if (!t) { t = buildDropTable(ctx.catalog, ammoId, v0); ctx.dropTables[key] = t; }
  const f = Math.min(Math.max(rangeM / DROP_STEP_M, 0), t.length - 1.001);
  const i = Math.floor(f);
  return t[i]! + (t[i + 1]! - t[i]!) * (f - i);
}
