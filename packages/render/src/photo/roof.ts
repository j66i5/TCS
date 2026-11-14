/**
 * Roofs of the photo map (plan "photo" step "built" 6), seen from straight above and lit by the one sun (`light.ts`):
 * RGBA with alpha (premultiplied), one picture per building, packed into atlas pages. Pure (no Pixi, no DOM, no
 * random, no clock): the same bytes for the same map.
 *
 * - Hipped roofs (house, farmhouse, church; and any footprint that is not a rectangle): every point belongs to the face
 *   of its nearest wall, so faces meet along hip lines and the ridge (the straight skeleton of a convex footprint).
 * - Gabled roofs (barn, shed and long footprints): the two long walls' faces meet along the ridge; the short walls are
 *   gable ends.
 * - Flat roofs (apartment block, warehouse, office): gravel, a parapet band with its shadow inside, a few vents.
 * - Every pitched face: about 37 degrees, lit by Lambert against the sun (west-north-west faces light, east-south-east
 *   faces dark), tile courses every 0.35 m (band-limited), a dark eave line, a lighter ridge cap, weathering and moss,
 *   a tone per building. No outline.
 */
import type { Building } from "@tcs/sim";
import { band, hash2, tri as triImp, vnoise as vnoiseImp } from "./noise";
import { SUN } from "./light";
import { polySd } from "./lines";

export type RoofStyle = "hip" | "gable" | "flat";
const FLAT = new Set(["apartment-block", "warehouse", "office"]);
const GABLE = new Set(["barn", "shed"]);
/** Roof pitch (rad) and resolution of the atlas (px/m). */
export const PITCH = 37 * Math.PI / 180;
export const ROOF_PPM = 8;
/** Readability: no roof pixel above this HSV saturation (red roofs stay quieter than the red side's units). */
export const ROOF_SAT = 0.45;

/** Eaves overhang the walls by this much (m): the roof covers the wall tops (and their square corners). */
export const OVERHANG_M = 0.3;

/**
 * The roof's outline: the footprint grown by OVERHANG_M (each vertex moved along the bisector of its two walls'
 * outward normals; footprints are convex or nearly so).
 */
export function roofOutline(b: Building): number[] {
  const fp = b.footprint, n = fp.length >> 1, out: number[] = [];
  const nrm = (k: number): [number, number] => {
    const ax = fp[2 * k]!, ay = fp[2 * k + 1]!, bx = fp[(2 * k + 2) % fp.length]!, by = fp[(2 * k + 3) % fp.length]!;
    const L = Math.hypot(bx - ax, by - ay) || 1e-9;
    let nx = -(by - ay) / L, ny = (bx - ax) / L;
    if (polySd(fp, (ax + bx) / 2 + nx * 0.05, (ay + by) / 2 + ny * 0.05) > 0) { nx = -nx; ny = -ny; }
    return [nx, ny];
  };
  for (let k = 0; k < n; k++) {
    const [ax, ay] = nrm((k + n - 1) % n), [bx, by] = nrm(k);
    const d = 1 + ax * bx + ay * by, f = d > 0.2 ? OVERHANG_M / d : OVERHANG_M;
    out.push(fp[2 * k]! + (ax + bx) * f, fp[2 * k + 1]! + (ay + by) * f);
  }
  return out;
}

/** The roof style of a building: flat by kind, gabled by kind or when the footprint is a long rectangle, else hipped. */
export function roofStyle(b: Building): RoofStyle {
  if (FLAT.has(b.kind)) return "flat";
  const fp = b.footprint;
  if (fp.length !== 8) return "hip";
  if (GABLE.has(b.kind)) return "gable";
  const e0 = Math.hypot(fp[2]! - fp[0]!, fp[3]! - fp[1]!), e1 = Math.hypot(fp[4]! - fp[2]!, fp[5]! - fp[3]!);
  return Math.max(e0, e1) > 2.2 * Math.min(e0, e1) ? "gable" : "hip";
}

export interface RoofPicture {
  /** Global pixel of the picture's corner at `ppm` (world = (gx0 + i) / ppm), its size in pixels. */
  gx0: number; gy0: number; w: number; h: number;
  data: Uint8Array;
}

/** Brightness of a pitched face whose eave faces the outward direction (ox, oy) (unit), lit by the sun. */
export function faceLight(ox: number, oy: number): number {
  const s = Math.sin(PITCH), c = Math.cos(PITCH);
  const l = ox * s * SUN.x + oy * s * SUN.y + c * SUN.z;
  return 0.56 + 0.52 * (l > 0 ? l : 0);
}

/** Paint one roof (colour 0xRRGGBB) at `ppm`: premultiplied RGBA of the footprint's box plus one pixel. */
export function paintRoof(b: Building, colour: number, ppm = ROOF_PPM): RoofPicture {
  const fp = roofOutline(b), n = fp.length >> 1;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let k = 0; k < fp.length; k += 2) { minX = Math.min(minX, fp[k]!); maxX = Math.max(maxX, fp[k]!); minY = Math.min(minY, fp[k + 1]!); maxY = Math.max(maxY, fp[k + 1]!); }
  const gx0 = Math.floor(minX * ppm) - 1, gy0 = Math.floor(minY * ppm) - 1, w = Math.ceil(maxX * ppm) + 1 - gx0, h = Math.ceil(maxY * ppm) + 1 - gy0;
  const data = new Uint8Array(w * h * 4);
  const style = roofStyle(b), px = 1 / ppm;
  // Per wall: outward normal, its face's light; which walls carry a face (gable: the long ones).
  const ex = new Float64Array(n), ey = new Float64Array(n), ox = new Float64Array(n), oy = new Float64Array(n), lit = new Float64Array(n), face = new Uint8Array(n);
  let longest = 0;
  for (let k = 0; k < n; k++) {
    const ax = fp[2 * k]!, ay = fp[2 * k + 1]!, bx = fp[(2 * k + 2) % fp.length]!, by = fp[(2 * k + 3) % fp.length]!;
    const L = Math.hypot(bx - ax, by - ay) || 1e-9;
    ex[k] = (bx - ax) / L; ey[k] = (by - ay) / L;
    let nx = -ey[k]!, ny = ex[k]!;
    if (polySd(fp, (ax + bx) / 2 + nx * 0.05, (ay + by) / 2 + ny * 0.05) > 0) { nx = -nx; ny = -ny; }
    ox[k] = nx; oy[k] = ny; lit[k] = faceLight(nx, ny);
    longest = Math.max(longest, L);
  }
  for (let k = 0; k < n; k++) {
    const L = Math.hypot(fp[(2 * k + 2) % fp.length]! - fp[2 * k]!, fp[(2 * k + 3) % fp.length]! - fp[2 * k + 1]!);
    face[k] = style !== "gable" || L >= longest - 0.01 ? 1 : 0;
  }
  const [cr0, cg0, cb0] = [(colour >> 16) & 255, (colour >> 8) & 255, colour & 255];
  const tone = 1 + 0.12 * (hash2(b.id, 7, 0x701) - 0.5);
  const salt = (b.id * 13) & 255;
  const bCourse = band(0.35, ppm), bGrit = band(0.3, ppm);
  const tri = triImp;
  // Flat roofs: a few vents (hashed positions well inside the parapet).
  const vents: number[] = [];
  if (style === "flat") {
    const nv = 1 + Math.floor(hash2(b.id, 1, 0x702) * 3);
    for (let v = 0, tries = 0; v < nv && tries < 12; tries++) {
      const vx = minX + (maxX - minX) * hash2(b.id, 10 + tries, 0x703), vy = minY + (maxY - minY) * hash2(b.id, 10 + tries, 0x704);
      if (polySd(fp, vx, vy) > 1.8) { vents.push(vx, vy); v++; }
    }
  }
  const SDX = -SUN.x / Math.hypot(SUN.x, SUN.y), SDY = -SUN.y / Math.hypot(SUN.x, SUN.y);
  // Per wall: start, direction, 1 / length^2; the parapet shadow's reach toward the sun.
  const EA = new Float64Array(n * 5), sun = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    const ax = fp[2 * k]!, ay = fp[2 * k + 1]!, qx = fp[(2 * k + 2) % fp.length]! - ax, qy = fp[(2 * k + 3) % fp.length]! - ay;
    EA[5 * k] = ax; EA[5 * k + 1] = ay; EA[5 * k + 2] = qx; EA[5 * k + 3] = qy; EA[5 * k + 4] = 1 / (qx * qx + qy * qy || 1e-12);
    sun[k] = 0.45 * (ox[k]! * SDX + oy[k]! * SDY);
  }
  const dist = new Float64Array(n), vnoise = vnoiseImp, hash = hash2;
  for (let j = 0; j < h; j++) {
    const y = (gy0 + j + 0.5) * px;
    for (let i = 0; i < w; i++) {
      const x = (gx0 + i + 0.5) * px;
      // Distance to every wall; the signed distance to the outline.
      let inside = false, dAll = Infinity;
      for (let a = 0, c = n - 1; a < n; c = a++) {
        const ay = fp[2 * a + 1]!, by = fp[2 * c + 1]!;
        if ((ay > y) !== (by > y) && x < ((fp[2 * c]! - fp[2 * a]!) * (y - ay)) / (by - ay) + fp[2 * a]!) inside = !inside;
      }
      for (let k = 0; k < n; k++) {
        const o = 5 * k, ax = EA[o]!, ay = EA[o + 1]!, qx = EA[o + 2]!, qy = EA[o + 3]!;
        let u = ((x - ax) * qx + (y - ay) * qy) * EA[o + 4]!;
        u = u < 0 ? 0 : u > 1 ? 1 : u;
        const dx = x - ax - u * qx, dy = y - ay - u * qy, d = Math.sqrt(dx * dx + dy * dy);
        dist[k] = d;
        if (d < dAll) dAll = d;
      }
      const sd = inside ? dAll : -dAll;
      const al = sd * ppm + 0.5;
      if (al <= 0) continue;
      const alpha = al > 1 ? 1 : al;
      let f: number;
      if (style === "flat") {
        // Gravel with stains; a parapet band 0.6 m with its shadow on the roof inside; vents with shadows.
        f = 0.97 + 0.05 * bGrit * (hash(Math.floor(x * 4), Math.floor(y * 4), 0x705 + salt) - 0.5) * 2 + 0.04 * vnoise(x / 4, y / 4, 0x70 + salt) + 0.02 * vnoise(x / 1.9, y / 1.9, 0x72 + salt);
        if (sd < 0.6) f = 1.14 - 0.04 * (sd / 0.6);
        else {
          // Toward the sun: inside the parapet band there? (distance to each wall from the point moved sun-ward)
          let sq = Infinity;
          for (let k = 0; k < n; k++) { const v = dist[k]! + sun[k]!; if (v < sq) sq = v; }
          if (sq < 0.6) f *= 0.78;
          for (let v = 0; v < vents.length; v += 2) {
            const vx = vents[v]!, vy = vents[v + 1]!;
            if (Math.abs(x - vx) < 0.45 && Math.abs(y - vy) < 0.45) f = 1.18 - 0.08 * ((x - vx) + (y - vy));
            else if (Math.abs(x - SDX * 0.5 - vx) < 0.45 && Math.abs(y - SDY * 0.5 - vy) < 0.45) f *= 0.75;
          }
        }
      } else {
        // The face: the nearest wall carrying one; the ridge or hip where the next nearest is about as near.
        let k1 = -1, d1 = Infinity, d2 = Infinity;
        for (let k = 0; k < n; k++) {
          if (!face[k]) continue;
          const d = dist[k]!;
          if (d < d1) { d2 = d1; d1 = d; k1 = k; } else if (d < d2) d2 = d;
        }
        f = lit[k1]!;
        // Tile courses parallel to the eave (rows of tiles: a light/dark wave down the slope).
        f *= 1 + 0.07 * bCourse * tri(d1 / 0.35);
        // Ridge and hip caps: a narrow lighter band where two faces meet.
        const gap = d2 - d1;
        if (gap < 0.36) f = f * (1 - 0.5 * (1 - gap / 0.36)) + 0.92 * 0.5 * (1 - gap / 0.36);
        // Moss and weathering, darker low on the roof.
        f *= 1 + 0.05 * vnoise(x / 2.5, y / 2.5, 0x71 + salt) + 0.025 * vnoise(x / 1.2, y / 1.2, 0x73 + salt) - 0.03 * (d1 < 1 ? 1 - d1 : 0);
      }
      // Dark eave line along every wall.
      if (dAll < 0.22) f *= 0.72 + 0.28 * (dAll / 0.22);
      f *= tone;
      let r = cr0 * f, g = cg0 * f, bb = cb0 * f;
      const mx = Math.max(r, g, bb), mn = Math.min(r, g, bb);
      if (mx > 0 && mx - mn > ROOF_SAT * mx) {
        const L = 0.299 * r + 0.587 * g + 0.114 * bb, k = (ROOF_SAT * 0.98 * L) / (mx - mn - ROOF_SAT * 0.98 * (mx - L));
        if (k > 0 && k < 1) { r = L + (r - L) * k; g = L + (g - L) * k; bb = L + (bb - L) * k; }
      }
      const o = (j * w + i) * 4, a8 = alpha * 255;
      r *= alpha; g *= alpha; bb *= alpha;
      data[o] = r < 0 ? 0 : r > a8 ? a8 + 0.5 | 0 : r + 0.5 | 0;
      data[o + 1] = g < 0 ? 0 : g > a8 ? a8 + 0.5 | 0 : g + 0.5 | 0;
      data[o + 2] = bb < 0 ? 0 : bb > a8 ? a8 + 0.5 | 0 : bb + 0.5 | 0;
      data[o + 3] = a8 + 0.5 | 0;
    }
  }
  return { gx0, gy0, w, h, data };
}

export interface RoofAtlas {
  pages: { w: number; h: number; data: Uint8Array }[];
  /** Per building: page, pixel rectangle in the page, world corner and size (m). */
  items: { page: number; px: number; py: number; pw: number; ph: number; x: number; y: number; wM: number; hM: number }[];
  /** Resolution of the pitched roofs (flat roofs: half of it). */
  ppm: number;
  bytes: number;
}

/** Atlas budget (pixels of roof pictures): about 3.6 MB of RGBA. */
export const ROOF_ATLAS_PX = 900_000;

/** Box of a building's roof picture at `ppm`. */
function roofBox(b: Building, ppm: number): { gx0: number; gy0: number; w: number; h: number } {
  const fp = roofOutline(b);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let k = 0; k < fp.length; k += 2) { minX = Math.min(minX, fp[k]!); maxX = Math.max(maxX, fp[k]!); minY = Math.min(minY, fp[k + 1]!); maxY = Math.max(maxY, fp[k + 1]!); }
  const gx0 = Math.floor(minX * ppm) - 1, gy0 = Math.floor(minY * ppm) - 1;
  return { gx0, gy0, w: Math.ceil(maxX * ppm) + 1 - gx0, h: Math.ceil(maxY * ppm) + 1 - gy0 };
}

/**
 * All roofs of a map packed into atlas pages (shelves, tallest first, 2 px gutters so mipmaps do not bleed), pages
 * at most `pageSize` px a side. Pitched roofs at ROOF_PPM (8 px/m), lower on maps with very many or very large
 * buildings so the atlas stays within ROOF_ATLAS_PX; flat roofs (plain gravel) at half that. `colourOf(b)`: the roof
 * colour.
 */
export function buildRoofAtlas(buildings: readonly Building[], colourOf: (b: Building) => number, maxPpm = ROOF_PPM, pageSize = 2048): RoofAtlas {
  const G = 2;
  let ppm = maxPpm;
  const ppmOf = (b: Building, p: number) => (FLAT.has(b.kind) ? p / 2 : p);
  for (; ppm > 4; ppm--) {
    let px = 0;
    for (const b of buildings) { const q = roofBox(b, ppmOf(b, ppm)); px += (q.w + G) * (q.h + G); }
    if (px <= ROOF_ATLAS_PX) break;
  }
  const sizes = buildings.map((b) => {
    const q = roofBox(b, ppmOf(b, ppm));
    return { ...q, w: Math.min(pageSize - 2 * G, q.w), h: Math.min(pageSize - 2 * G, q.h), ppm: ppmOf(b, ppm) };
  });
  // Shelf packing, tallest first (ties: building order): page, x, y per building; each page as large as it is used.
  const order = sizes.map((_, i) => i).sort((a, c) => sizes[c]!.h - sizes[a]!.h || a - c);
  const place: { page: number; px: number; py: number }[] = new Array(buildings.length);
  const used: { w: number; h: number }[] = [{ w: G, h: G }];
  let page = 0, cx = G, cy = G, shelf = 0;
  for (const i of order) {
    const s = sizes[i]!;
    if (cx + s.w + G > pageSize) { cx = G; cy += shelf + G; shelf = 0; }
    if (cy + s.h + G > pageSize) { page++; used.push({ w: G, h: G }); cx = G; cy = G; shelf = 0; }
    place[i] = { page, px: cx, py: cy };
    cx += s.w + G; shelf = Math.max(shelf, s.h);
    used[page]!.w = Math.max(used[page]!.w, cx); used[page]!.h = Math.max(used[page]!.h, cy + shelf + G);
  }
  const pages = used.map((u) => ({ w: u.w, h: u.h, data: new Uint8Array(u.w * u.h * 4) }));
  const items: RoofAtlas["items"] = [];
  buildings.forEach((b, i) => {
    const s = sizes[i]!, q = place[i]!, pg = pages[q.page]!;
    const pic = paintRoof(b, colourOf(b), s.ppm);
    for (let j = 0; j < s.h; j++) pg.data.set(pic.data.subarray(j * pic.w * 4, (j * pic.w + s.w) * 4), ((q.py + j) * pg.w + q.px) * 4);
    items.push({ page: q.page, px: q.px, py: q.py, pw: s.w, ph: s.h, x: s.gx0 / s.ppm, y: s.gy0 / s.ppm, wM: s.w / s.ppm, hM: s.h / s.ppm });
  });
  return { pages, items, ppm, bytes: pages.reduce((a, p) => a + p.data.length, 0) };
}
