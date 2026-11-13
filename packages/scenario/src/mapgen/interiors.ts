/**
 * Building interiors (M7.5c, plan §5): rooms, inner walls with doorways, stairs and upper-floor windows for every
 * building, generated after all buildings are placed, in building id order, on their own RNG stream
 * ("mapgen/interiors"), so a map generated without interiors is exactly the map before M7.5c.
 *
 * Work is done in the building's local frame: `a` along the front wall (0 at the left back corner), `b` from the
 * back wall (0) to the front wall (D). Every cut is axis-aligned there, so every room is a rectangle (convex).
 * Each cut gets one doorway (a tree: every room reachable), 30 % a second; a cut never ends at a doorway or an
 * outer door or window. The same partition on every floor (plan §7.7); stairs at the same place on each floor.
 */
import type { Building, BuildingKindDef, Coords, InnerWall, Interior, Opening, Room, Stair } from "@tcs/sim";
import { hypot2, nextFloat, nextInt, nextRange, type RngState } from "@tcs/sim";

const R = "mapgen/interiors";
const MIN_ROOM_M = 2.5;
const DOOR_W = 0.9;
const DOOR_HEAD = 2.0;
const INNER_THICK = 0.12;
const INNER_MATERIAL = "brick";

interface Frame { ox: number; oy: number; ux: number; uy: number; nx: number; ny: number; W: number; D: number }
interface Rect { a0: number; b0: number; a1: number; b1: number; kind: Room["kind"] }
/** An opening on an axis line in local coordinates: on the line `axis = at`, centred at `pos` along it. */
interface Gap { axis: "a" | "b"; at: number; pos: number; half: number }
interface Cut { axis: "a" | "b"; at: number; from: number; to: number; doors: number[] }

function frameOf(fp: Coords): Frame {
  // geom.rect: v0 front-left, v1 front-right, v2 back-right, v3 back-left. Origin v3, u = v3->v2, n = v3->v0.
  const x3 = fp[6]!, y3 = fp[7]!, x2 = fp[4]!, y2 = fp[5]!, x0 = fp[0]!, y0 = fp[1]!;
  const W = hypot2(x2 - x3, y2 - y3), D = hypot2(x0 - x3, y0 - y3);
  return { ox: x3, oy: y3, ux: (x2 - x3) / W, uy: (y2 - y3) / W, nx: (x0 - x3) / D, ny: (y0 - y3) / D, W, D };
}

const r2 = (v: number) => Math.round(v * 100) / 100;
function world(f: Frame, a: number, b: number): [number, number] {
  return [r2(f.ox + f.ux * a + f.nx * b), r2(f.oy + f.uy * a + f.ny * b)];
}

/** Outer openings as gaps in the local frame (wall 0 front b = D from a = 0; 1 right a = W; 2 back b = 0; 3 left a = 0). */
function outerGaps(f: Frame, openings: readonly Opening[]): Gap[] {
  const out: Gap[] = [];
  for (const o of openings) {
    if ((o.floor ?? 0) !== 0) continue;
    const half = o.widthM / 2 + 0.25;
    if (o.wall === 0) out.push({ axis: "b", at: f.D, pos: o.offsetM, half });
    else if (o.wall === 1) out.push({ axis: "a", at: f.W, pos: f.D - o.offsetM, half });
    else if (o.wall === 2) out.push({ axis: "b", at: 0, pos: f.W - o.offsetM, half });
    else out.push({ axis: "a", at: 0, pos: o.offsetM, half });
  }
  return out;
}

/** May a cut `axis = at` across rect r (ending on its two sides) be made without ending in a gap? */
function cutClear(r: Rect, axis: "a" | "b", at: number, gaps: readonly Gap[]): boolean {
  // A cut a = at runs from b0 to b1 and ends on the lines b = b0 and b = b1 (gaps there have axis "b").
  const ends = axis === "a" ? [r.b0, r.b1] : [r.a0, r.a1];
  const other = axis === "a" ? "b" : "a";
  for (const g of gaps) {
    if (g.axis !== other) continue;
    if (Math.abs(g.at - ends[0]!) > 0.05 && Math.abs(g.at - ends[1]!) > 0.05) continue;
    if (Math.abs(g.pos - at) < g.half + 0.15) return false;
  }
  return true;
}

function split(r: Rect, axis: "a" | "b", at: number, rng: RngState, gaps: Gap[], cuts: Cut[], kinds: [Room["kind"], Room["kind"]] = ["room", "room"]): [Rect, Rect] {
  const from = axis === "a" ? r.b0 : r.a0, to = axis === "a" ? r.b1 : r.a1;
  const len = to - from;
  const doors: number[] = [];
  const nDoors = len >= 4 && nextFloat(rng, R) < 0.3 ? 2 : 1;
  for (let k = 0; k < nDoors; k++) {
    const lo = from + DOOR_W / 2 + 0.3, hi = to - DOOR_W / 2 - 0.3;
    if (hi <= lo) break;
    const c = nDoors === 1 ? nextRange(rng, R, lo, hi) : k === 0 ? nextRange(rng, R, lo, (lo + hi) / 2 - 0.6) : nextRange(rng, R, (lo + hi) / 2 + 0.6, hi);
    const pos = Math.round(c * 10) / 10;
    doors.push(pos);
    gaps.push({ axis, at, pos, half: DOOR_W / 2 + 0.25 });
  }
  cuts.push({ axis, at, from, to, doors });
  return axis === "a"
    ? [{ ...r, a1: at, kind: kinds[0] }, { ...r, a0: at, kind: kinds[1] }]
    : [{ ...r, b1: at, kind: kinds[0] }, { ...r, b0: at, kind: kinds[1] }];
}

/** Try to split r along its longer side at a random clear place; null if it is too small or nothing is clear. */
function trySplit(r: Rect, rng: RngState, gaps: Gap[], cuts: Cut[], minRoom = MIN_ROOM_M): [Rect, Rect] | null {
  const wa = r.a1 - r.a0, wb = r.b1 - r.b0;
  const axis: "a" | "b" = wa >= wb ? "a" : "b";
  const lo = (axis === "a" ? r.a0 : r.b0) + minRoom, hi = (axis === "a" ? r.a1 : r.b1) - minRoom;
  if (hi < lo) return null;
  for (let attempt = 0; attempt < 6; attempt++) {
    const at = Math.round(nextRange(rng, R, lo, hi) * 10) / 10;
    if (cutClear(r, axis, at, gaps)) return split(r, axis, at, rng, gaps, cuts);
  }
  // Windows close together: the clear place nearest the middle, in 0.1 m steps.
  const mid = Math.round(((lo + hi) / 2) * 10) / 10;
  for (let k = 0; k <= Math.ceil((hi - lo) * 10); k++) {
    for (const at of [mid + k / 10, mid - k / 10]) {
      const a = Math.round(at * 10) / 10;
      if (a >= lo && a <= hi && cutClear(r, axis, a, gaps)) return split(r, axis, a, rng, gaps, cuts);
    }
  }
  return null;
}

/** Split into up to `target` rooms, largest first. */
function bsp(start: Rect[], target: number, rng: RngState, gaps: Gap[], cuts: Cut[]): Rect[] {
  const rooms = [...start];
  const stuck = new Set<Rect>();
  while (rooms.length < target) {
    let best = -1, bestA = 0;
    rooms.forEach((r, i) => { const ar = (r.a1 - r.a0) * (r.b1 - r.b0); if (!stuck.has(r) && ar > bestA) { bestA = ar; best = i; } });
    if (best < 0) break;
    const r = rooms[best]!;
    const s = trySplit(r, rng, gaps, cuts);
    if (!s) { stuck.add(r); continue; }
    rooms.splice(best, 1, s[0], s[1]);
  }
  return rooms;
}

/** Layout of the ground floor: rooms (local rects) and cuts (inner walls with doorways). */
function layout(kind: BuildingKindDef, f: Frame, openings: readonly Opening[], storeys: number, rng: RngState): { rooms: Rect[]; cuts: Cut[] } {
  const gaps = outerGaps(f, openings);
  const cuts: Cut[] = [];
  const whole: Rect = { a0: 0, b0: 0, a1: f.W, b1: f.D, kind: "room" };
  const id = kind.id;
  // Barns, warehouses, churches (tall), sheds (thin plank or sheet walls) and anything tiny: one room.
  const big = kind.storeyHeightM >= 4 || kind.wallThicknessM < 0.1 || f.W * f.D < 25;
  if (big) return { rooms: [{ ...whole, kind: id === "church" ? "hall" : "room" }], cuts };
  const corridor = f.W >= 16 && f.D >= 10 && (storeys >= 3 || f.W * f.D > 200);
  let rooms: Rect[];
  if (corridor) {
    // Offices and blocks of flats: a corridor along the building, rooms either side, the front door's room a hall.
    const mid = f.D / 2;
    const c0 = Math.round((mid - 0.9) * 10) / 10, c1 = Math.round((mid + 0.9) * 10) / 10;
    const [back, rest] = split(whole, "b", c0, rng, gaps, cuts, ["room", "room"]);
    const [hall, front] = split(rest, "b", c1, rng, gaps, cuts, ["hall", "room"]);
    // Extra doorways from the corridor into every room come from the cuts below (each cut adds one door to the
    // corridor wall as well, so rooms off the corridor do not chain).
    const sideRooms = (r: Rect): Rect[] => {
      const out: Rect[] = [r];
      for (let guard = 0; guard < 20; guard++) {
        let wi = -1;
        out.forEach((q, i) => { if (q.a1 - q.a0 > 6.5 && wi < 0) wi = i; });
        if (wi < 0) break;
        const q = out[wi]!;
        let done = false;
        for (let attempt = 0; attempt < 6 && !done; attempt++) {
          const at = Math.round(nextRange(rng, R, q.a0 + 3, Math.min(q.a1 - 3, q.a0 + 6)) * 10) / 10;
          if (!cutClear(q, "a", at, gaps)) continue;
          const [x, y] = split(q, "a", at, rng, gaps, cuts);
          out.splice(wi, 1, x, y);
          done = true;
        }
        if (!done) break;
      }
      return out;
    };
    const backRooms = sideRooms(back), frontRooms = sideRooms(front);
    // One doorway from the corridor into each side room that the corridor wall's own doorway does not reach.
    const addCorridorDoors = (side: Rect[], wallAt: number) => {
      const cut = cuts.find((c) => c.axis === "b" && Math.abs(c.at - wallAt) < 1e-9)!;
      for (const q of side) {
        if (cut.doors.some((d) => d > q.a0 + 0.3 && d < q.a1 - 0.3)) continue;
        const lo = q.a0 + DOOR_W / 2 + 0.3, hi = q.a1 - DOOR_W / 2 - 0.3;
        if (hi <= lo) continue;
        const pos = Math.round(nextRange(rng, R, lo, hi) * 10) / 10;
        cut.doors.push(pos);
      }
      cut.doors.sort((x, y) => x - y);
    };
    addCorridorDoors(backRooms, c0);
    addCorridorDoors(frontRooms, c1);
    // The front door opens into a front room: make that one the hall instead of a room behind a room.
    rooms = [...backRooms, hall, ...frontRooms];
    const fd = gaps.find((g) => g.axis === "b" && Math.abs(g.at - f.D) < 0.05);
    if (fd) for (const q of frontRooms) if (fd.pos > q.a0 && fd.pos < q.a1) q.kind = "hall";
    return { rooms, cuts };
  }
  // Houses and farmhouses: 2-5 rooms by floor area; the room with the front door is the hall.
  const target = Math.max(2, Math.min(5, Math.round((f.W * f.D) / 22) + nextInt(rng, R, 2)));
  rooms = bsp([whole], target, rng, gaps, cuts);
  const fd = gaps.find((g) => g.axis === "b" && Math.abs(g.at - f.D) < 0.05);
  if (fd) for (const q of rooms) if (q.b1 >= f.D - 0.05 && fd.pos > q.a0 && fd.pos < q.a1) { q.kind = "hall"; break; }
  return { rooms, cuts };
}

/** A flight of stairs in local coordinates against the longer side of a room, or null if it does not fit. */
function stairIn(r: Rect): { a0: number; b0: number; a1: number; b1: number } | null {
  const wa = r.a1 - r.a0, wb = r.b1 - r.b0;
  const along = wa >= wb ? wa : wb;
  const len = Math.min(3.5, along - 1.2);
  if (len < 3 || Math.min(wa, wb) < 1.6) return null;
  if (wa >= wb) return { a0: r.a0 + 0.6, b0: r.b0 + 0.55, a1: r.a0 + 0.6 + len, b1: r.b0 + 0.55 };
  return { a0: r.a0 + 0.55, b0: r.b0 + 0.6, a1: r.a0 + 0.55, b1: r.b0 + 0.6 + len };
}

/** Rooms, inner walls and stairs for one building; upper-floor openings appended to `b.openings`. */
export function furnishBuilding(b: Building, kind: BuildingKindDef, rng: RngState): Interior {
  const f = frameOf(b.footprint);
  const { rooms: rects, cuts } = layout(kind, f, b.openings, b.storeys, rng);
  const rooms: Room[] = [], walls: InnerWall[] = [], stairs: Stair[] = [];
  const n = rects.length;
  // Stairs: in the hall if they fit there, else in the largest room that takes them.
  let stairRoom = -1;
  if (b.storeys > 1) {
    const order = rects.map((_, i) => i).sort((i, j) => {
      const hi = rects[i]!.kind === "hall" ? 1 : 0, hj = rects[j]!.kind === "hall" ? 1 : 0;
      if (hi !== hj) return hj - hi;
      const ai = (rects[i]!.a1 - rects[i]!.a0) * (rects[i]!.b1 - rects[i]!.b0), aj = (rects[j]!.a1 - rects[j]!.a0) * (rects[j]!.b1 - rects[j]!.b0);
      return aj - ai || i - j;
    });
    for (const i of order) if (stairIn(rects[i]!)) { stairRoom = i; break; }
  }
  for (let fl = 0; fl < b.storeys; fl++) {
    rects.forEach((r, i) => {
      const kindR: Room["kind"] = i === stairRoom ? "stair" : r.kind;
      rooms.push({ id: fl * n + i, floor: fl, poly: [...world(f, r.a0, r.b1), ...world(f, r.a1, r.b1), ...world(f, r.a1, r.b0), ...world(f, r.a0, r.b0)], kind: kindR });
    });
    cuts.forEach((c) => {
      const [ax, ay] = c.axis === "a" ? world(f, c.at, c.from) : world(f, c.from, c.at);
      const [bx, by] = c.axis === "a" ? world(f, c.at, c.to) : world(f, c.to, c.at);
      walls.push({ id: walls.length, floor: fl, ax, ay, bx, by, thicknessM: INNER_THICK, material: INNER_MATERIAL, doors: c.doors.map((d) => ({ offsetM: Math.round((d - c.from) * 100) / 100, widthM: DOOR_W, headM: DOOR_HEAD })) });
    });
    if (stairRoom >= 0 && fl + 1 < b.storeys) {
      const s = stairIn(rects[stairRoom]!)!;
      const [x0, y0] = world(f, s.a0, s.b0), [x1, y1] = world(f, s.a1, s.b1);
      stairs.push({ id: stairs.length, floor: fl, room: fl * n + stairRoom, x0, y0, x1, y1, widthM: 1 });
    }
  }
  // Upper-floor windows: each ground window again on every floor, and a window above every door.
  const ground = b.openings.filter((o) => (o.floor ?? 0) === 0);
  for (let fl = 1; fl < b.storeys; fl++) {
    for (const o of ground) {
      if (o.kind === "window") b.openings.push({ ...o, floor: fl });
      else b.openings.push({ wall: o.wall, offsetM: o.offsetM, widthM: 1.2, kind: "window", sillM: 0.9, headM: 2.1, floor: fl });
    }
  }
  return { rooms, walls, stairs };
}

/** Interiors for every building of the map, in id order, on their own stream (after all buildings are placed). */
export function furnishInteriors(buildings: Building[], terrain: { buildings: Record<string, BuildingKindDef> }, rng: RngState): void {
  const sorted = [...buildings].sort((x, y) => x.id - y.id);
  for (const b of sorted) {
    const kind = terrain.buildings[b.kind];
    if (!kind || b.footprint.length !== 8) continue;
    b.interior = furnishBuilding(b, kind, rng);
  }
}
