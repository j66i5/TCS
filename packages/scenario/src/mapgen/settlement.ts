/** Settlement pieces: farm plots along a road, farmsteads around a yard, churches, apartment blocks. */
import { chance, cos, nextInt, nextRange, PI, sin, type Coords } from "@tcs/sim";
import type { MapBuilder } from "./builder";
import { along, inflate, polylineLength, rect } from "./geom";
import { angleOf } from "./landscape";

const R = "mapgen/settlement";

/** A random size within a building kind's data range. */
function dims(b: MapBuilder, kind: string): { w: number; d: number } {
  const k = b.terrain.buildings[kind]!;
  return { w: nextRange(b.rng, R, k.widthM[0], k.widthM[1]), d: nextRange(b.rng, R, k.depthM[0], k.depthM[1]) };
}

/** Local frame along a road: point = origin + t*along + n*across. */
interface Frame { ox: number; oy: number; tx: number; ty: number; nx: number; ny: number }
const at = (f: Frame, l: number, a: number) => ({ x: f.ox + f.tx * l + f.nx * a, y: f.oy + f.ty * l + f.ny * a });
const quad = (f: Frame, l0: number, l1: number, a0: number, a1: number): Coords => {
  const p = [at(f, l0, a0), at(f, l1, a0), at(f, l1, a1), at(f, l0, a1)];
  return p.flatMap((q) => [q.x, q.y]);
};

export interface PlotOptions {
  roadWidthM: number;
  depthM: [number, number];
  widthM: [number, number];
  /** Probability that a plot is a farm (farmhouse + barn) rather than a plain house. */
  farmShare: number;
  frontWall: string[];
}

/**
 * Plots along one side of a road between arc lengths s0 and s1 (side +1 = left of travel, -1 = right):
 * house near the road, yard, barn closing the yard, garden, orchard at the back, fences between plots.
 * The typical layout of farm villages in the region. Returns the number of plots built.
 */
export function plotsAlongRoad(b: MapBuilder, road: Coords, s0: number, s1: number, side: 1 | -1, o: PlotOptions): number {
  let s = Math.max(0, s0);
  const end = Math.min(polylineLength(road), s1);
  let built = 0;
  while (s < end - 15) {
    const pw = nextRange(b.rng, R, o.widthM[0], o.widthM[1]);
    const p = along(road, s + pw / 2);
    const f: Frame = { ox: p.x, oy: p.y, tx: p.tx, ty: p.ty, nx: -p.ty * side, ny: p.tx * side };
    const edge = o.roadWidthM / 2 + 1.5;
    const depth = nextRange(b.rng, R, o.depthM[0], o.depthM[1]);
    const plot = quad(f, -pw / 2 + 0.5, pw / 2 - 0.5, edge, edge + depth);
    s += pw;
    if (!b.canPlace(plot, -1.5)) continue; // plot crosses a road, water or another settlement
    b.reserve(plot);
    built++;
    const farm = nextRange(b.rng, R, 0, 1) < o.farmShare;
    const kind = farm ? "farmhouse" : "house";
    const { w, d } = dims(b, kind);
    const gable = chance(b.rng, R, 0.5); // gable end to the street, or eaves to the street
    const along_ = gable ? d : w, across = gable ? w : d;
    const setback = nextRange(b.rng, R, 2, 6);
    const hl = -pw / 2 + along_ / 2 + 1.5;
    const ha = edge + setback + across / 2;
    const hc = at(f, hl, ha);
    const roadAngle = angleOf(f.tx, f.ty) + (side > 0 ? PI : 0);
    b.addBuilding(kind, rect(hc.x, hc.y, w, d, gable ? roadAngle + PI / 2 : roadAngle), { allowReserved: true, margin: 0.5 });

    const yardEnd = edge + setback + across + nextRange(b.rng, R, 14, 24);
    b.paintSurface(quad(f, -pw / 2 + 1, pw / 2 - 1, edge, yardEnd), "yard", true);
    let back = yardEnd;
    if (farm) {
      const bd = dims(b, "barn");
      const bw = Math.min(pw - 3, bd.w);
      const bc = at(f, 0, yardEnd + bd.d / 2 + 0.5);
      if (b.addBuilding("barn", rect(bc.x, bc.y, bw, bd.d, roadAngle), { allowReserved: true, margin: 0.5 })) back = yardEnd + bd.d + 1;
    }
    const gardenEnd = Math.min(edge + depth - 5, back + nextRange(b.rng, R, 20, 35));
    if (gardenEnd > back + 5) {
      b.paintSurface(quad(f, -pw / 2 + 1, pw / 2 - 1, back, gardenEnd), "garden", true);
      if (chance(b.rng, R, 0.5)) {
        const sd = dims(b, "shed");
        const sc = at(f, nextRange(b.rng, R, -pw / 4, pw / 4), back + 6);
        b.addBuilding("shed", rect(sc.x, sc.y, sd.w, sd.d, roadAngle), { allowReserved: true, margin: 0.5 });
      }
    }
    if (edge + depth > gardenEnd + 5) {
      const orch = quad(f, -pw / 2 + 1, pw / 2 - 1, gardenEnd, edge + depth);
      b.paintSurface(orch, "meadow", true);
      if (chance(b.rng, R, 0.75)) b.paintVegetation(orch, "orchard", false);
    }
    // Front wall with a gate, fence along one side.
    const wall = o.frontWall[nextInt(b.rng, R, o.frontWall.length)]!;
    const g0 = nextRange(b.rng, R, -pw / 6, pw / 6);
    const a0 = at(f, -pw / 2 + 0.5, edge - 0.3), a1 = at(f, g0 - 2, edge - 0.3), a2 = at(f, g0 + 2, edge - 0.3), a3 = at(f, pw / 2 - 0.5, edge - 0.3);
    b.addObstacle(wall, [a0.x, a0.y, a1.x, a1.y]);
    b.addObstacle(wall, [a2.x, a2.y, a3.x, a3.y]);
    if (chance(b.rng, R, 0.7)) {
      const q0 = at(f, -pw / 2 + 0.3, edge), q1 = at(f, -pw / 2 + 0.3, edge + depth);
      b.addObstacle("wooden-fence", [q0.x, q0.y, q1.x, q1.y]);
    }
  }
  return built;
}

/**
 * A farmstead around a square yard (three or four wings), set back from a road point.
 * Returns true if built.
 */
export function farmstead(b: MapBuilder, x: number, y: number, angle: number): boolean {
  const yard = nextRange(b.rng, R, 26, 38);
  const area = rect(x, y, yard + 40, yard + 40, angle);
  if (!b.canPlace(area, 2)) return false;
  b.reserve(inflate(area, 10));
  b.paintSurface(rect(x, y, yard + 30, yard + 30, angle), "yard");
  const c = (dx: number, dy: number) => ({ x: x + dx * cos(angle) - dy * sin(angle), y: y + dx * sin(angle) + dy * cos(angle) });
  const half = yard / 2;
  const fh = dims(b, "farmhouse");
  const p1 = c(0, half + fh.d / 2);
  b.addBuilding("farmhouse", rect(p1.x, p1.y, Math.min(fh.w, yard), fh.d, angle), { allowReserved: true, margin: 0.3 });
  const bn = dims(b, "barn");
  const p2 = c(0, -half - bn.d / 2);
  b.addBuilding("barn", rect(p2.x, p2.y, Math.min(bn.w, yard + 8), bn.d, angle), { allowReserved: true, margin: 0.3 });
  const b2 = dims(b, "barn");
  const p3 = c(half + b2.d / 2, 0);
  b.addBuilding("barn", rect(p3.x, p3.y, Math.min(b2.w, yard - 2), b2.d, angle + PI / 2), { allowReserved: true, margin: 0.3 });
  if (chance(b.rng, R, 0.6)) {
    const sh = dims(b, "shed");
    const p4 = c(-half - sh.d / 2 - 1, half / 2);
    b.addBuilding("shed", rect(p4.x, p4.y, sh.w, sh.d, angle + PI / 2), { allowReserved: true, margin: 0.3 });
  }
  // Wall with gate on the open (west) side.
  const w0 = c(-half - 1, -half), w1 = c(-half - 1, -4), w2 = c(-half - 1, 4), w3 = c(-half - 1, half);
  b.addObstacle("brick-wall", [w0.x, w0.y, w1.x, w1.y]);
  b.addObstacle("brick-wall", [w2.x, w2.y, w3.x, w3.y]);
  // Orchard behind the house.
  const o = c(0, half + fh.d + 22);
  b.paintVegetation(rect(o.x, o.y, yard + 20, 30, angle), "orchard");
  return true;
}

/** Church with a walled churchyard, next to a point; returns true if built. */
export function church(b: MapBuilder, x: number, y: number, angle: number): boolean {
  const { w, d } = dims(b, "church");
  const yard = rect(x, y, w + 24, d + 24, angle);
  if (!b.canPlace(yard, 1, true)) return false;
  b.paintSurface(yard, "grass");
  b.paintVegetation(yard, null, false);
  if (!b.addBuilding("church", rect(x, y, w, d, angle), { allowReserved: true, margin: 2 })) return false;
  b.reserve(yard);
  const pts = [...yard, yard[0]!, yard[1]!];
  // churchyard wall with a gap on wall 0
  b.addObstacle("stone-wall", [pts[0]!, pts[1]!, (pts[0]! + pts[2]!) / 2 - 1.5 * cos(angle), (pts[1]! + pts[3]!) / 2 - 1.5 * sin(angle)]);
  b.addObstacle("stone-wall", [(pts[0]! + pts[2]!) / 2 + 1.5 * cos(angle), (pts[1]! + pts[3]!) / 2 + 1.5 * sin(angle), ...pts.slice(2)]);
  return true;
}

/** Up to `n` apartment blocks (common at the edge of villages and towns in the region). */
export function apartmentBlocks(b: MapBuilder, x: number, y: number, angle: number, n: number): number {
  let built = 0;
  for (let k = 0; k < n * 4 && built < n; k++) {
    const { w, d } = dims(b, "apartment-block");
    const px = x + nextRange(b.rng, R, -70, 70), py = y + nextRange(b.rng, R, -70, 70);
    const fp = rect(px, py, w, d, angle + (chance(b.rng, R, 0.3) ? PI / 2 : 0));
    if (b.addBuilding("apartment-block", fp, { margin: 8 })) {
      b.paintSurface(inflate(fp, 10), "grass", true);
      built++;
    }
  }
  return built;
}

