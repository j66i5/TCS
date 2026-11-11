/**
 * The four test-map kinds (SPEC 6.1): village, woodland edge, open farmland, industrial area.
 * Fictional Central/Eastern European landscape (owner decision 2026-11-11).
 * Order inside each generator matters: relief -> roads -> water -> settlement -> fields -> woods -> hedges.
 */
import { chance, hypot2, nextInt, nextRange, PI, type Coords } from "@tcs/sim";
import type { MapBuilder } from "./builder";
import { OCC_ROAD } from "./builder";
import { along, blob, distToPolyline, polylineLength, rect } from "./geom";
import {
  addObstacleAvoiding, angleOf, meander, paintFields, paintRelief, paintTreeline, paintWoods, ray,
} from "./landscape";
import { fbm } from "./noise";
import { apartmentBlocks, church, farmstead, plotsAlongRoad } from "./settlement";

const R = "mapgen/kinds";

/** Is a point on the road network (near a road) or at the map edge? */
function joinsNetwork(b: MapBuilder, x: number, y: number): boolean {
  if (x <= 2 || y <= 2 || x >= b.widthM - 2 || y >= b.heightM - 2) return true;
  return b.map.roads.some((r) => distToPolyline(x, y, r.points) < r.widthM / 2 + 4);
}

function hedgesAndTracks(b: MapBuilder, f: ReturnType<typeof paintFields>): void {
  // Field tracks: keep only those that join the network; repeat so tracks can chain off each other.
  let pending = f.tracks.filter((t) => polylineLength(t) > 150);
  for (let pass = 0; pass < 4 && pending.length > 0; pass++) {
    const next: Coords[] = [];
    for (const t of pending) {
      const n = t.length;
      if (b.roadBlocked(t, 3)) continue; // never drive a field track through a farm
      if (joinsNetwork(b, t[0]!, t[1]!) || joinsNetwork(b, t[n - 2]!, t[n - 1]!)) b.addRoad(t, 3, "dirt-track");
      else next.push(t);
    }
    if (next.length === pending.length) break;
    pending = next;
  }
  for (const t of f.treelines) paintTreeline(b, t, 4);
  const avoid = [b.vid("woodland")];
  for (const h of f.hedges) addObstacleAvoiding(b, "hedge", h, avoid);
}

function pond(b: MapBuilder, x: number, y: number, r: number, seed: number): void {
  b.addPond(blob(x, y, r, 14, (i) => (fbm(i * 0.4, 0.5, seed, 2) - 0.5) * 0.5), nextRange(b.rng, R, 1.5, 3));
}

/** Try several spots near the village centre (both sides of the main road) until a church fits. */
function placeChurch(b: MapBuilder, road: Coords, sc: number, startOffset: number): boolean {
  for (let k = 0; k < 12; k++) {
    const p = along(road, sc + (k % 2 === 0 ? 1 : -1) * (startOffset + 25 * Math.floor(k / 2)));
    const side = Math.floor(k / 2) % 2 === 0 ? 1 : -1;
    const off = 38 * side;
    if (church(b, p.x - p.ty * off, p.y + p.tx * off, angleOf(p.tx, p.ty))) return true;
  }
  return false;
}

// ---------------------------------------------------------------- village

export function village(b: MapBuilder, seed: number): string {
  const W = b.widthM, H = b.heightM;
  const cy = H / 2 + nextRange(b.rng, R, -H * 0.08, H * 0.08);
  const main = meander(b, seed + 1, "west", cy, H * 0.06, 900, 40);
  const stream = chance(b.rng, R, 0.65) ? meander(b, seed + 2, "north", W * nextRange(b.rng, R, 0.3, 0.7), W * 0.08, 600, 40) : null;
  paintRelief(b, seed, 14, 700, stream ? { points: stream, depthM: 5, widthM: 160 } : undefined);

  b.addRoad(main, 6, "asphalt");
  const L = polylineLength(main);
  const sc = L / 2 + nextRange(b.rng, R, -W * 0.05, W * 0.05);
  const centre = along(main, sc);
  const clustered = chance(b.rng, R, 0.5);
  const style = clustered ? "clustered" : "street";

  // A crossing road north and south out of the village.
  const crossN = ray(centre.x, centre.y, -PI / 2 + nextRange(b.rng, R, -0.3, 0.3), H, seed + 3, b);
  const crossS = ray(centre.x, centre.y, PI / 2 + nextRange(b.rng, R, -0.3, 0.3), H, seed + 4, b);
  b.addRoad(crossN, clustered ? 5 : 4, clustered ? "asphalt" : "dirt-track");
  b.addRoad(crossS, 4, "dirt-track");
  if (stream) b.addStream(stream, nextRange(b.rng, R, 3, 5), 0.6, "treeline", 5);

  const plots: Parameters<typeof plotsAlongRoad>[5] = { roadWidthM: 6, depthM: [80, 130], widthM: [24, 38], farmShare: 0.6, frontWall: ["brick-wall", "wooden-fence", "stone-wall"] };
  let radius: number;
  if (clustered) {
    radius = nextRange(b.rng, R, 200, 280);
    // Square with church, lanes radiating out, plots along every lane and the main road.
    const sq = rect(centre.x, centre.y + 30, 55, 45, angleOf(centre.tx, centre.ty));
    b.paintSurface(sq, "gravel");
    b.reserve(sq);
    placeChurch(b, main, sc, 70);
    const lanes = 3 + nextInt(b.rng, R, 3);
    const lanePts: Coords[] = [];
    for (let k = 0; k < lanes; k++) {
      const a = (k / lanes) * 2 * PI + nextRange(b.rng, R, -0.3, 0.3) + PI / 4;
      const lane = ray(centre.x, centre.y + 30, a, nextRange(b.rng, R, 140, radius), seed + 10 + k, b);
      b.addRoad(lane, 4, chance(b.rng, R, 0.5) ? "asphalt" : "dirt-track");
      lanePts.push(lane);
    }
    for (const side of [1, -1] as const) plotsAlongRoad(b, main, sc - radius, sc + radius, side, plots);
    for (const lane of lanePts) for (const side of [1, -1] as const) plotsAlongRoad(b, lane, 35, 400, side, { ...plots, roadWidthM: 4, depthM: [50, 85] });
    for (const side of [1, -1] as const) plotsAlongRoad(b, crossN, 40, radius, side, { ...plots, roadWidthM: 5, depthM: [50, 80] });
  } else {
    radius = nextRange(b.rng, R, 260, 380);
    // Street village: long plots on both sides of the main road; church in the middle.
    placeChurch(b, main, sc, 40);
    for (const side of [1, -1] as const) plotsAlongRoad(b, main, sc - radius, sc + radius, side, plots);
    for (const side of [1, -1] as const) plotsAlongRoad(b, crossN, 30, 160, side, { ...plots, roadWidthM: 4, depthM: [45, 70] });
  }
  if (chance(b.rng, R, 0.5)) pond(b, centre.x + nextRange(b.rng, R, -60, 60), centre.y + nextRange(b.rng, R, 50, 90), nextRange(b.rng, R, 12, 22), seed + 5);
  if (chance(b.rng, R, 0.45)) {
    const e = along(main, sc + (chance(b.rng, R, 0.5) ? 1 : -1) * (radius + 70));
    apartmentBlocks(b, e.x + e.ty * 70, e.y - e.tx * 70, angleOf(e.tx, e.ty), 1 + nextInt(b.rng, R, 3));
  }
  for (let k = 0; k < 2; k++) {
    const p = along(main, nextRange(b.rng, R, 0.1, 0.9) * L);
    if (hypot2(p.x - centre.x, p.y - centre.y) > radius + 150) farmstead(b, p.x + p.ty * 70, p.y - p.tx * 70, angleOf(p.tx, p.ty));
  }

  // Fields run right up to the plots (plots are reserved ground, so they are not painted over).
  const fields = paintFields(b, seed + 6, { hedgeChance: 0.15, treelineChance: 0.08, trackChance: 0.08, maxLenM: 450 });
  paintWoods(b, seed + 7, 0.66, 420, (x, y) => hypot2(x - centre.x, y - centre.y) < radius + 120);
  hedgesAndTracks(b, fields);
  return style;
}

// ---------------------------------------------------------------- woodland edge

export function woodland(b: MapBuilder, seed: number): string {
  const W = b.widthM, H = b.heightM;
  const edgeX = (y: number) => W * 0.45 + (fbm(y / 500, 0.3, seed + 1, 3) - 0.5) * 360;
  const road = meander(b, seed + 2, "north", W * nextRange(b.rng, R, 0.68, 0.8), W * 0.05, 800, 40);
  paintRelief(b, seed, 30, 800);
  b.addRoad(road, 6, "asphalt");

  // Forest tracks: one across into the woods, one along inside it.
  const ty = H * nextRange(b.rng, R, 0.35, 0.65);
  const cross = meander(b, seed + 3, "west", ty, 60, 500, 40);
  b.addRoad(cross, 3.5, "dirt-track");
  const inner = meander(b, seed + 4, "north", W * nextRange(b.rng, R, 0.15, 0.3), 80, 500, 40);
  b.addRoad(inner, 3, "dirt-track");
  if (chance(b.rng, R, 0.6)) b.addStream(meander(b, seed + 5, "west", H * nextRange(b.rng, R, 0.15, 0.3), 70, 400, 40), 3, 0.5, "treeline", 4);

  // Forester's farmstead where the track leaves the forest; a small hamlet on the road.
  const ex = edgeX(ty) + 60;
  farmstead(b, ex, ty + 50, nextRange(b.rng, R, -0.2, 0.2));
  const rl = polylineLength(road);
  const hs = nextRange(b.rng, R, 0.2, 0.8) * rl;
  for (const side of [1, -1] as const) plotsAlongRoad(b, road, hs - 90, hs + 90, side, { roadWidthM: 6, depthM: [50, 80], widthM: [24, 34], farmShare: 0.5, frontWall: ["wooden-fence", "stone-wall"] });

  // The forest: west of the edge line, with clearings; scrub fringe along the edge.
  const wood = b.vid("woodland"), scrub = b.vid("scrub"), floor = b.sid("forest-floor"), meadow = b.sid("meadow"), tall = b.vid("tall-grass");
  for (let r = 0; r < b.rows; r++) {
    const y = b.cy(r);
    const e = edgeX(y);
    for (let c = 0; c < b.cols; c++) {
      const i = r * b.cols + c;
      if (b.occ[i] !== 0) continue;
      const x = b.cx(c);
      if (x < e) {
        if (fbm(x / 220, y / 220, seed + 6, 3) > 0.72) { b.surface[i] = meadow; b.vegetation[i] = tall; }
        else { b.surface[i] = floor; b.vegetation[i] = wood; }
      } else if (x < e + 10 + fbm(x / 60, y / 60, seed + 7, 2) * 25) {
        b.vegetation[i] = scrub;
      }
    }
  }
  const fields = paintFields(b, seed + 8, { exclude: (x, y) => x < edgeX(y) + 30, hedgeChance: 0.2, treelineChance: 0.1, trackChance: 0.06, maxLenM: 400 });
  paintWoods(b, seed + 9, 0.7, 300, (x, y) => x < edgeX(y) + 30);
  hedgesAndTracks(b, fields);
  return "woodland-edge";
}

// ---------------------------------------------------------------- farmland

export function farmland(b: MapBuilder, seed: number): string {
  const W = b.widthM, H = b.heightM;
  const stream = meander(b, seed + 1, "west", H * nextRange(b.rng, R, 0.55, 0.75), H * 0.08, 700, 40);
  paintRelief(b, seed, 18, 900, { points: stream, depthM: 6, widthM: 220 });
  const road = meander(b, seed + 2, "north", W * nextRange(b.rng, R, 0.35, 0.65), W * 0.07, 900, 40);
  b.addRoad(road, 6, "asphalt");
  const track = meander(b, seed + 3, "west", H * nextRange(b.rng, R, 0.2, 0.4), 80, 600, 40);
  b.addRoad(track, 3.5, "dirt-track");
  b.addStream(stream, nextRange(b.rng, R, 3, 6), 0.7, "treeline", 6);
  if (chance(b.rng, R, 0.6)) pond(b, W * nextRange(b.rng, R, 0.2, 0.8), H * nextRange(b.rng, R, 0.2, 0.8), nextRange(b.rng, R, 15, 30), seed + 4);

  const farms = 2 + nextInt(b.rng, R, 2);
  let made = 0;
  for (let k = 0; k < farms * 6 && made < farms; k++) {
    const onRoad = chance(b.rng, R, 0.5) ? road : track;
    const p = along(onRoad, nextRange(b.rng, R, 0.1, 0.9) * polylineLength(onRoad));
    const side = chance(b.rng, R, 0.5) ? 1 : -1;
    if (farmstead(b, p.x - p.ty * 55 * side, p.y + p.tx * 55 * side, angleOf(p.tx, p.ty))) made++;
  }
  const fields = paintFields(b, seed + 5, { hedgeChance: 0.28, treelineChance: 0.1, trackChance: 0.1, maxLenM: 500 });
  paintWoods(b, seed + 6, 0.7, 380);
  hedgesAndTracks(b, fields);
  return "farmland";
}

// ---------------------------------------------------------------- industrial

export function industrial(b: MapBuilder, seed: number): string {
  const W = b.widthM, H = b.heightM;
  paintRelief(b, seed, 6, 900);
  const zw = Math.min(W * 0.6, 1200), zh = Math.min(H * 0.45, 850);
  const zx0 = (W - zw) / 2 + nextRange(b.rng, R, -W * 0.05, W * 0.05), zy0 = (H - zh) / 2 + nextRange(b.rng, R, -H * 0.05, H * 0.05);
  const zx1 = zx0 + zw, zy1 = zy0 + zh;

  // Railway on an embankment along the north side.
  const ry = zy0 - 45;
  const rail: Coords = [0, ry, W, ry];
  b.forPolyline(rail, 7, (i) => { b.surface[i] = b.sid("gravel"); b.vegetation[i] = 0; b.occ[i]! |= OCC_ROAD; });
  b.addObstacle("embankment", rail);

  // Road grid.
  const midY = (zy0 + zy1) / 2;
  const main = meander(b, seed + 1, "west", midY, 25, 900, 40);
  b.addRoad(main, 8, "asphalt");
  const nx = 3 + nextInt(b.rng, R, 2);
  const xs: number[] = [];
  for (let k = 0; k < nx; k++) xs.push(zx0 + ((k + 0.5) * zw) / nx + nextRange(b.rng, R, -25, 25));
  for (const x of xs) b.addRoad([x, zy0 - 30, x, zy1 + 10], 7, "asphalt");
  const exitS = ray(xs[Math.floor(xs.length / 2)]!, zy1 + 10, PI / 2, H, seed + 2, b);
  b.addRoad(exitS, 6, "asphalt");

  // Lots between the roads: concrete yards, fences, warehouses and offices.
  const bounds = [zx0, ...xs, zx1];
  for (let i = 0; i + 1 < bounds.length; i++) {
    for (const [y0, y1] of [[zy0, midY], [midY, zy1]] as const) {
      const x0 = bounds[i]! + 8, x1 = bounds[i + 1]! - 8, a = y0 + 8, z = y1 - 8;
      if (x1 - x0 < 40 || z - a < 40) continue;
      const lot: Coords = [x0, a, x1, a, x1, z, x0, z];
      if (chance(b.rng, R, 0.15)) {
        b.paintSurface(lot, "gravel", true);
        b.paintVegetation(lot, "tall-grass", true);
        continue;
      }
      b.paintSurface(lot, "gravel", true);
      b.paintVegetation(lot, chance(b.rng, R, 0.5) ? "tall-grass" : null, true);
      const fence = chance(b.rng, R, 0.7) ? "wire-fence" : "concrete-wall";
      const gateY = y0 === zy0 ? z : a; // gate faces the main road
      const gx = (x0 + x1) / 2 + nextRange(b.rng, R, -10, 10);
      b.addObstacle(fence, [gx - 4, gateY, x0, gateY, x0, y0 === zy0 ? a : z, x1, y0 === zy0 ? a : z, x1, gateY, gx + 4, gateY]);
      const tries = 5 + nextInt(b.rng, R, 4);
      for (let k = 0; k < tries; k++) {
        const kind = k === 0 ? "warehouse" : chance(b.rng, R, 0.5) ? "office" : chance(b.rng, R, 0.5) ? "warehouse" : "shed";
        const kd = b.terrain.buildings[kind]!;
        const w = Math.min(nextRange(b.rng, R, kd.widthM[0], kd.widthM[1]), x1 - x0 - 12);
        const d = Math.min(nextRange(b.rng, R, kd.depthM[0], kd.depthM[1]), z - a - 12);
        if (w < kd.widthM[0] * 0.6 || d < kd.depthM[0] * 0.6) continue;
        const cx = nextRange(b.rng, R, x0 + w / 2 + 6, x1 - w / 2 - 6), cy = nextRange(b.rng, R, a + d / 2 + 6, z - d / 2 - 6);
        const fp = rect(cx, cy, w, d, y0 === zy0 ? PI : 0);
        if (b.canPlace(fp, 5)) {
          b.paintSurface(rect(cx, cy, w + 16, d + 16, y0 === zy0 ? PI : 0), "concrete", true); // apron for lorries
          b.paintVegetation(rect(cx, cy, w + 16, d + 16, 0), null, true);
          b.addBuilding(kind, fp, { margin: 5 });
        }
      }
    }
  }
  if (chance(b.rng, R, 0.6)) apartmentBlocks(b, zx0 + zw * nextRange(b.rng, R, 0.2, 0.8), zy1 + 110, 0, 2 + nextInt(b.rng, R, 3));

  const inZone = (x: number, y: number) => x > zx0 - 20 && x < zx1 + 20 && y > zy0 - 60 && y < zy1 + 20;
  // Wasteland fringe: scrub and tall grass around the zone.
  const scrub = b.vid("scrub"), tall = b.vid("tall-grass");
  for (let r = 0; r < b.rows; r++) for (let c = 0; c < b.cols; c++) {
    const i = r * b.cols + c;
    if (b.occ[i] !== 0) continue;
    const x = b.cx(c), y = b.cy(r);
    const dx = Math.max(zx0 - x, 0, x - zx1), dy = Math.max(zy0 - 60 - y, 0, y - zy1);
    const d = hypot2(dx, dy);
    if (d > 0 && d < 90) {
      const n = fbm(x / 70, y / 70, seed + 3, 3);
      if (n > 0.62) b.vegetation[i] = scrub;
      else if (n > 0.45) b.vegetation[i] = tall;
    }
  }
  const fields = paintFields(b, seed + 4, { exclude: (x, y) => inZone(x, y) || (Math.abs(y - ry) < 12), hedgeChance: 0.15, treelineChance: 0.08, trackChance: 0.06, maxLenM: 450 });
  paintWoods(b, seed + 5, 0.68, 380, inZone);
  hedgesAndTracks(b, fields);
  return "industrial";
}
