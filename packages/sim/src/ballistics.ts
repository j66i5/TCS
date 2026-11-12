/**
 * Ballistics tables derived from the map and the catalog at battle start (never saved): coarse height and
 * vegetation grids that let most projectiles skip collision tests, per-wall-segment properties, per-material
 * and per-ammunition numbers pre-multiplied for the inner loop.
 */
import type { Catalog } from "./catalog";
import type { MapDef, Opening } from "./map";
import { PI, sin, sqrt } from "./math";
import { heightAt, pointInPolygon, segmentsInRectInto, type MapIndex } from "./terrain";

export interface SegInfo {
  heightM: number;
  thicknessM: number;
  material: number;
  /** Segment length, m. */
  len: number;
  /** Unit normal (either side). */
  nx: number;
  ny: number;
  /** Doors and windows on this wall (buildings only), plus holes blown in it (terrain damage). */
  openings: Opening[] | null;
  /** The openings the wall was built with (breaches are added on top of these). */
  built: Opening[] | null;
  /** Share of a line of sight that passes through it (0 solid wall, 0.95 wire mesh; from the obstacle kind). */
  seeThrough: number;
}

export interface MaterialRT {
  id: string;
  resistance: number;
  /** sin of the largest angle from the surface at which a ricochet is possible. */
  sinCrit: number;
  breaks: boolean;
  /** Bounce factor for grenades: 1 on hard surfaces, less on soft ones. */
  bounce: number;
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
  /** Carries an explosive filling: never "spent", does not wound by striking, bursts by fuse. */
  explosive: boolean;
  /** A fragment of a burst: may strike the man who threw the grenade; wounds by the fragment rules. */
  fragment: boolean;
  /** Time fuse in ticks from release (0 = impact fuse). */
  fuseTicks: number;
  /** An impact fuse is live only after this many ticks of flight. */
  armTicks: number;
  /** Below this speed (squared) it is spent and removed. For a fragment: the speed at which it can no longer wound. */
  minSpeed2: number;
}

/** A roof: a flat lid on a building's walls (M2.4). */
export interface RoofRT { id: number; footprint: readonly number[]; heightM: number; material: number; thicknessM: number }

export interface HitboxRT {
  halfF: number; // half extent along the facing
  halfL: number; // half extent across it
  height: number;
  alongLength: boolean;
  bands: { group: number; from: number; to: number; halfWidth: number; armsTo: number }[];
}

/** Bits of `BallisticsCtx.near`. */
export const NEAR_WALL = 1;
export const NEAR_SOLDIER = 2;

export interface SoldierGrid {
  n: number;
  id: Int32Array;
  x: Float64Array; y: Float64Array; gz: Float64Array; cf: Float64Array; sf: Float64Array;
  posture: Uint8Array;
  /** Side of each man (index into `sides`), and suppression gathered from rounds passing him this tick (M4.1). */
  side: Int32Array;
  sup: Float64Array;
  sides: string[];
  /** Soldier ID -> side index, rebuilt every tick (to know which side fired a round). */
  sideOf: Map<number, number>;
  /** Linked lists per bucket: head[bucket] -> soldier index -> next[index] ... (-1 ends). */
  head: Int32Array;
  next: Int32Array;
  /** Buckets whose NEAR_SOLDIER bit is set this tick (cleared through this list at the next fill). */
  touched: Int32Array;
  touchedCount: number;
}

export function createSoldierGrid(buckets: number, capacity = 256): SoldierGrid {
  return {
    n: 0, id: new Int32Array(capacity), x: new Float64Array(capacity), y: new Float64Array(capacity), gz: new Float64Array(capacity),
    cf: new Float64Array(capacity), sf: new Float64Array(capacity), posture: new Uint8Array(capacity),
    side: new Int32Array(capacity), sup: new Float64Array(capacity), sides: [], sideOf: new Map(),
    head: new Int32Array(buckets).fill(-1), next: new Int32Array(capacity),
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
  /**
   * Per bucket, what is in it or in one of its eight neighbours, as bits: NEAR_WALL (static, from the map),
   * NEAR_SOLDIER (this tick). One byte read per path sample in the projectile loop.
   */
  near: Uint8Array;
  seg: SegInfo[];
  /** Roofs, and for each bucket of the map index the roofs whose bounding box touches it. */
  roofs: RoofRT[];
  roofBuckets: number[][];
  /** Per coarse bucket: the lowest roof (absolute height, less a margin) in it or next to it; Infinity if none. */
  roofLow: Float32Array;
  /** Scratch for line-of-sight queries: the query generation each roof was last visited in. */
  roofStamp: Uint32Array;
  roofGen: number;
  materials: MaterialRT[];
  /** Material index per surface palette entry of the map. */
  surfaceMaterial: Int32Array;
  /** Stopping chance per metre and height per vegetation palette entry (index = vegetation byte - 1). */
  vegStopPerM: Float32Array;
  vegHeightM: Float32Array;
  /** Share of a line of sight blocked per metre, per vegetation palette entry (index = vegetation byte - 1). */
  vegConcealPerM: Float32Array;
  ammo: AmmoRT[];
  /** Body outlines per posture code (0 standing, 1 crouching, 2 prone). */
  hitboxes: HitboxRT[];
  /** Farthest any part of a body outline lies from the man's position, m (search margin). */
  bodyReachM: number;
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
    return { id, resistance: m.resistance, sinCrit: sin((m.ricochetAngleDeg * PI) / 180), breaks: m.breaksBullets, bounce: m.densityKgM3 < b.bounce.softBelowDensityKgM3 ? b.bounce.softFactor : 1 };
  });
  const matIndex = (id: string) => Math.max(0, matIds.indexOf(id));

  const bucketM = 8;
  const bcols = Math.ceil(map.widthM / bucketM), brows = Math.ceil(map.heightM / bucketM);
  const maxGround = new Float32Array(bcols * brows).fill(-Infinity);
  const maxVegTop = new Float32Array(bcols * brows).fill(-Infinity);
  const vegHeightM = new Float32Array(map.vegetationPalette.map((id) => catalog.terrain.vegetation[id]?.heightM ?? 0));
  const vegConcealPerM = new Float32Array(map.vegetationPalette.map((id) => catalog.terrain.vegetation[id]?.concealmentPerM ?? 0));
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
      return { heightM: bd.storeys * bd.storeyHeightM, thicknessM: bd.wallThicknessM, material: matIndex(bd.wallMaterial), len, nx: ey / len, ny: -ex / len, openings: openings.length > 0 ? openings : null, built: openings.length > 0 ? openings : null, seeThrough: 0 };
    }
    const o = obstacles.get(s.id)!;
    return { heightM: o.heightM, thicknessM: o.thicknessM, material: matIndex(o.material), len, nx: ey / len, ny: -ex / len, openings: null, built: null, seeThrough: catalog.terrain.obstacles[o.kind]?.seeThrough ?? 0 };
  });
  const roofs: RoofRT[] = map.buildings.map((bd) => {
    const kind = catalog.terrain.buildings[bd.kind];
    return { id: bd.id, footprint: bd.footprint, heightM: bd.storeys * bd.storeyHeightM, material: matIndex(kind?.roofMaterial ?? bd.wallMaterial), thicknessM: kind?.roofThicknessM ?? 0.05 };
  });
  const roofBuckets: number[][] = Array.from({ length: index.bcols * index.brows }, () => []);
  roofs.forEach((rf, ri) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let k = 0; k < rf.footprint.length; k += 2) { x0 = Math.min(x0, rf.footprint[k]!); x1 = Math.max(x1, rf.footprint[k]!); y0 = Math.min(y0, rf.footprint[k + 1]!); y1 = Math.max(y1, rf.footprint[k + 1]!); }
    const cl = (v: number, n: number) => (v < 0 ? 0 : v >= n ? n - 1 : v);
    for (let r = cl(Math.floor(y0 / index.bucketM), index.brows); r <= cl(Math.floor(y1 / index.bucketM), index.brows); r++) {
      for (let c = cl(Math.floor(x0 / index.bucketM), index.bcols); c <= cl(Math.floor(x1 / index.bucketM), index.bcols); c++) roofBuckets[r * index.bcols + c]!.push(ri);
    }
  });

  // Buckets with a wall in or next to them (dilated by one bucket so point samples along a path cannot miss).
  const near = new Uint8Array(bcols * brows);
  for (const s of index.segments) {
    const ex = s.bx - s.ax, ey = s.by - s.ay;
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(ex), Math.abs(ey)) / (bucketM / 2)));
    for (let k = 0; k <= steps; k++) {
      const c = Math.floor((s.ax + (ex * k) / steps) / bucketM), r = Math.floor((s.ay + (ey * k) / steps) / bucketM);
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
        const cc = c + dc, rr = r + dr;
        if (cc >= 0 && rr >= 0 && cc < bcols && rr < brows) near[rr * bcols + cc] = near[rr * bcols + cc]! | NEAR_WALL;
      }
    }
  }

  const roofLow = new Float32Array(bcols * brows).fill(Infinity);
  for (const rf of roofs) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, low = Infinity;
    for (let k = 0; k < rf.footprint.length; k += 2) {
      const px = rf.footprint[k]!, py = rf.footprint[k + 1]!;
      x0 = Math.min(x0, px); x1 = Math.max(x1, px); y0 = Math.min(y0, py); y1 = Math.max(y1, py);
      low = Math.min(low, heightAt(map, Math.min(Math.max(px, 0), map.widthM - 0.01), Math.min(Math.max(py, 0), map.heightM - 0.01)));
    }
    low += rf.heightM - 0.75;
    for (let r = Math.max(0, Math.floor(y0 / bucketM) - 1); r <= Math.min(brows - 1, Math.floor(y1 / bucketM) + 1); r++) {
      for (let c = Math.max(0, Math.floor(x0 / bucketM) - 1); c <= Math.min(bcols - 1, Math.floor(x1 / bucketM) + 1); c++) {
        if (low < roofLow[r * bcols + c]!) roofLow[r * bcols + c] = low;
      }
    }
  }
  const surfaceMaterial = new Int32Array(map.surfacePalette.map((id) => matIndex(catalog.terrain.surfaces[id]?.material ?? "")));
  const ammo: AmmoRT[] = catalog.ammoIds.map((id) => {
    const a = catalog.ammo[id]!;
    const area = (PI * a.diameterM * a.diameterM) / 4;
    return { id, kDrag: area / (2 * a.projectileMassKg), dragA: a.drag.a, dragB: a.drag.b, dragMax: a.drag.max, penSteelMm: a.penetration.steelMm, penV: a.penetration.atVelocityMps, penCapV: a.penetration.breakupVelocityMps ?? Infinity, massKg: a.projectileMassKg, tracer: a.tracer,
      explosive: a.explosive !== undefined, fragment: a.kind === "fragment",
      fuseTicks: a.explosive?.fuseSeconds !== undefined ? Math.max(1, Math.round(a.explosive.fuseSeconds * tickHz)) : 0,
      armTicks: Math.round((a.explosive?.armingSeconds ?? 0) * tickHz),
      minSpeed2: Math.max(b.minSpeedMps * b.minSpeedMps, a.kind === "fragment" ? (2 * catalog.wounds.wounding.fragment.minEnergyJ) / a.projectileMassKg : 0) };
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
    hitboxes, bodyReachM: hitboxes.reduce((m, h) => Math.max(m, sqrt(h.halfF * h.halfF + h.halfL * h.halfL)), 0) + 0.05, soldiers: createSoldierGrid(bcols * brows),
    roofs, roofBuckets, roofLow, roofStamp: new Uint32Array(roofs.length), roofGen: 0,
    bucketM, bcols, brows, maxGround: maxGroundWide, maxVegTop: maxVegTopWide, near, seg, materials, surfaceMaterial, vegStopPerM, vegHeightM, vegConcealPerM, ammo,
    deflectionRad: (b.penetrationDeflectionDeg * PI) / 180,
    scatterRad: (b.ricochetScatterDeg * PI) / 180,
    minSpeed2: b.minSpeedMps * b.minSpeedMps,
    maxAgeTicks: Math.round(b.maxFlightSeconds * tickHz),
  };
}

/** Step between entries of a drop table, m. */
const DROP_STEP_M = 10;

/** A drop table: drop below the line of departure (m) and time of flight (s) at every 10 m of range. */
export interface DropTable { drop: Float32Array; tof: Float32Array }

/**
 * Drop below the line of departure at each 10 m of range for a bullet fired level at `v0` in standard air
 * (what a soldier's sights and training assume), and the time of flight to it. Built once per ammunition,
 * muzzle velocity and table length.
 */
export function buildDropTable(catalog: Catalog, ammoId: string, v0: number, maxRangeM = 1500): DropTable {
  const a = catalog.ammo[ammoId];
  const n = Math.floor(maxRangeM / DROP_STEP_M) + 1;
  const out = new Float32Array(n), tof = new Float32Array(n);
  if (!a) return { drop: out, tof };
  const b = catalog.ballistics;
  const k = ((PI * a.diameterM * a.diameterM) / 4 / (2 * a.projectileMassKg)) * b.airDensityKgM3;
  const dt = 1 / 240;
  let x = 0, z = 0, vx = v0, vz = 0, next = 1, time = 0;
  while (next < out.length) {
    const v = sqrt(vx * vx + vz * vz);
    // Spent, or falling almost straight down without reaching the range (long tables): the rest is out of reach.
    if (v < b.minSpeedMps || time > 120) break;
    const cdv = Math.min(a.drag.max * v, a.drag.a * v + a.drag.b);
    const f = k * cdv * dt;
    vx -= f * vx; vz -= f * vz + b.gravityMps2 * dt;
    const px = x, pz = z;
    x += vx * dt; z += vz * dt;
    while (next < out.length && x >= next * DROP_STEP_M) {
      const t = (next * DROP_STEP_M - px) / (x - px);
      out[next] = -(pz + t * (z - pz));
      tof[next] = time + t * dt;
      next++;
    }
    time += dt;
  }
  for (; next < out.length; next++) { out[next] = out[next - 1]! + 50; tof[next] = tof[next - 1]! + 1; } // beyond the bullet's reach
  return { drop: out, tof };
}

function dropTable(ctx: { catalog: Catalog; dropTables: Record<string, DropTable> }, ammoId: string, v0: number, maxRangeM: number): DropTable {
  const key = `${ammoId}@${v0}@${maxRangeM}`;
  let t = ctx.dropTables[key];
  if (!t) { t = buildDropTable(ctx.catalog, ammoId, v0, maxRangeM); ctx.dropTables[key] = t; }
  return t;
}

function lerpTable(t: Float32Array, rangeM: number): number {
  const f = Math.min(Math.max(rangeM / DROP_STEP_M, 0), t.length - 1.001);
  const i = Math.floor(f);
  return t[i]! + (t[i + 1]! - t[i]!) * (f - i);
}

/**
 * Drop (m, positive) at `rangeM` for this ammunition and muzzle velocity; table cached in the battle context.
 * `maxRangeM` is the table's length (1500 m for small arms; longer for vehicle guns).
 */
export function dropAt(ctx: { catalog: Catalog; dropTables: Record<string, DropTable> }, ammoId: string, v0: number, rangeM: number, maxRangeM = 1500): number {
  return lerpTable(dropTable(ctx, ammoId, v0, maxRangeM).drop, rangeM);
}

/** Time of flight (s) to `rangeM`, from the same table as `dropAt`. */
export function flightTimeAt(ctx: { catalog: Catalog; dropTables: Record<string, DropTable> }, ammoId: string, v0: number, rangeM: number, maxRangeM = 1500): number {
  return lerpTable(dropTable(ctx, ammoId, v0, maxRangeM).tof, rangeM);
}

/** Index of the roof over (x, y), or -1. */
export function roofAt(b: BallisticsCtx, index: MapIndex, x: number, y: number): number {
  let c = (x / index.bucketM) | 0, r = (y / index.bucketM) | 0;
  if (c < 0) c = 0; else if (c >= index.bcols) c = index.bcols - 1;
  if (r < 0) r = 0; else if (r >= index.brows) r = index.brows - 1;
  const list = b.roofBuckets[r * index.bcols + c]!;
  for (let q = 0; q < list.length; q++) if (pointInPolygon(b.roofs[list[q]!]!.footprint, x, y)) return list[q]!;
  return -1;
}

/** Scratch list of segment indices for `lineBlocked` (reused: no allocation per call). */
const BLOCK_SEGS: number[] = [];

/**
 * Is the straight line between two points blocked by a wall, hedge, fence or house wall (openings and
 * breaches let it through)? Heights are absolute. Used for blast shielding (and later for line of sight).
 */
export function lineBlocked(b: BallisticsCtx, map: MapDef, index: MapIndex, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, minSteelMm = 0): boolean {
  const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0;
  const nSeg = segmentsInRectInto(index, x0, y0, x1, y1, BLOCK_SEGS);
  for (let q = 0; q < nSeg; q++) {
    const si = BLOCK_SEGS[q]!;
    const s = index.segments[si]!;
    const ex = s.bx - s.ax, ey = s.by - s.ay;
    const denom = dx * ey - dy * ex;
    if (denom > -1e-12 && denom < 1e-12) continue;
    const t = ((s.ax - x0) * ey - (s.ay - y0) * ex) / denom;
    if (t <= 1e-9 || t >= 1) continue;
    const u = ((s.ax - x0) * dy - (s.ay - y0) * dx) / denom;
    if (u < 0 || u > 1) continue;
    const info = b.seg[si]!;
    // Too flimsy to count (a plank fence, wire mesh, a hedge against blast).
    if (minSteelMm > 0 && b.materials[info.material]!.resistance * info.thicknessM * 1000 < minSteelMm) continue;
    const rel = z0 + t * dz - heightAt(map, x0 + t * dx, y0 + t * dy);
    if (rel < 0 || rel > info.heightM) continue;
    let open = false;
    if (info.openings) {
      const off = u * info.len;
      for (const o of info.openings) if (off >= o.offsetM - o.widthM / 2 && off <= o.offsetM + o.widthM / 2 && rel >= o.sillM && rel <= o.headM) { open = true; break; }
    }
    if (!open) return true;
  }
  return false;
}

/** Bring the wall table in line with the breaches blown so far (terrain damage lives in the state). */
export function applyBreaches(b: BallisticsCtx, index: MapIndex, breaches: readonly { owner: "obstacle" | "building"; id: number; part: number; offsetM: number; widthM: number }[]): void {
  for (const info of b.seg) info.openings = info.built;
  if (breaches.length === 0) return;
  index.segments.forEach((s, si) => {
    for (const br of breaches) {
      if (br.owner !== s.owner || br.id !== s.id || br.part !== s.part) continue;
      const info = b.seg[si]!;
      if (info.openings === info.built) info.openings = info.built ? [...info.built] : [];
      info.openings!.push({ wall: s.part, offsetM: br.offsetM, widthM: br.widthM, kind: "door", sillM: 0, headM: info.heightM });
    }
  });
}
