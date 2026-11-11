/**
 * Terrain drawing, naturalistic style (owner decision 2026-11-11): soft ground colours with patchy
 * variation, tree canopies, orchard rows, hill shading and faint contour lines, then roads, water, walls,
 * hedges and buildings (roof, ridge, shadow) as vector shapes in world coordinates (metres).
 *
 * Built once per map; the camera only moves the container, so panning and zooming cost nothing.
 * Colours come from the terrain data (`colour` fields), never from per-type code.
 */
import { Container, Graphics, Sprite, Texture } from "pixi.js";
import { heightAt, type MapDef, type TerrainCatalog } from "@tcs/sim";

const hex = (c: string): [number, number, number] => {
  const n = parseInt(c.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const toNum = (c: string) => parseInt(c.slice(1), 16);

function hash(ix: number, iy: number): number {
  let h = Math.imul(ix, 0x27d4eb2d) ^ Math.imul(iy, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function vnoise(x: number, y: number): number {
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  return (hash(ix, iy) * (1 - ux) + hash(ix + 1, iy) * ux) * (1 - uy) + (hash(ix, iy + 1) * (1 - ux) + hash(ix + 1, iy + 1) * ux) * uy;
}

/**
 * Ground texture. Per cell: a base colour (surface blended with low vegetation) and "how much woodland /
 * orchard / scrub" factors. Per pixel: those are interpolated bilinearly between cell centres (soft,
 * natural edges instead of 4 m stair-steps), then textured (tree crowns, orchard rows, scrub clumps,
 * patches, grain), hill-shaded and given faint contour lines. Cells drawn as vectors on top (roads,
 * streams, building floors) take the average colour of their neighbours, so no raster band shows.
 */
function groundCanvas(map: MapDef, t: TerrainCatalog): HTMLCanvasElement {
  const ppc = Math.max(1, Math.min(3, Math.floor(2048 / Math.max(map.cols, map.rows))));
  const W = map.cols * ppc, H = map.rows * ppc;
  const mpp = map.cellSizeM / ppc;
  const C = map.cols, Rr = map.rows, N = C * Rr;

  // ---- per cell attributes
  const vectorSurf = new Set<number>();
  const roadSurfaces = new Set(map.roads.map((r) => r.surface));
  map.surfacePalette.forEach((id, i) => { if (roadSurfaces.has(id) || id === "floor" || id === "water-shallow" || id === "water-deep") vectorSurf.add(i); });
  const cr = new Float32Array(N), cg = new Float32Array(N), cb = new Float32Array(N);
  const fWood = new Float32Array(N), fOrch = new Float32Array(N), fScrub = new Float32Array(N);
  const woodCol: [number, number, number][] = [];
  const sCol = map.surfacePalette.map((id) => hex(t.surfaces[id]?.colour ?? "#ff00ff"));
  const vCol = map.vegetationPalette.map((id) => hex(t.vegetation[id]?.colour ?? "#ff00ff"));
  const vKind = map.vegetationPalette;
  const wR = new Float32Array(N), wG = new Float32Array(N), wB = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    let [r, g, b] = sCol[map.surface[i]!]!;
    const v = map.vegetation[i]!;
    if (v > 0) {
      const kind = vKind[v - 1]!;
      const [vr, vg, vb] = vCol[v - 1]!;
      if (kind === "woodland" || kind === "treeline") { fWood[i] = 1; wR[i] = vr; wG[i] = vg; wB[i] = vb; }
      else if (kind === "orchard") { fOrch[i] = 1; wR[i] = vr; wG[i] = vg; wB[i] = vb; }
      else if (kind === "scrub") { fScrub[i] = 1; wR[i] = vr; wG[i] = vg; wB[i] = vb; }
      else { const a = 0.6; r = r * (1 - a) + vr * a; g = g * (1 - a) + vg * a; b = b * (1 - a) + vb * a; }
    }
    cr[i] = r; cg[i] = g; cb[i] = b;
  }
  // Vector-drawn cells borrow their neighbours' colour.
  for (let i = 0; i < N; i++) {
    if (!vectorSurf.has(map.surface[i]!)) continue;
    const c0 = i % C, r0 = (i - c0) / C;
    let n = 0, sr = 0, sg = 0, sb = 0;
    for (let dr = -3; dr <= 3; dr++) for (let dc = -3; dc <= 3; dc++) {
      const c = c0 + dc, r = r0 + dr;
      if (c < 0 || r < 0 || c >= C || r >= Rr) continue;
      const j = r * C + c;
      if (vectorSurf.has(map.surface[j]!)) continue;
      sr += cr[j]!; sg += cg[j]!; sb += cb[j]!; n++;
    }
    if (n > 0) { cr[i] = sr / n; cg[i] = sg / n; cb[i] = sb / n; }
  }
  void woodCol;

  const heights = new Float32Array(W * H);
  for (let py = 0; py < H; py++) for (let px = 0; px < W; px++) heights[py * W + px] = heightAt(map, (px + 0.5) * mpp, (py + 0.5) * mpp);

  const canvas = document.createElement("canvas");
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(W, H);
  const d = img.data;
  const exaggerate = 4;
  for (let py = 0; py < H; py++) {
    // position relative to cell centres
    const fy = (py + 0.5) / ppc - 0.5;
    const r0 = Math.max(0, Math.min(Rr - 1, Math.floor(fy))), r1 = Math.min(Rr - 1, r0 + 1);
    const ty = Math.max(0, Math.min(1, fy - r0));
    for (let px = 0; px < W; px++) {
      const x = (px + 0.5) * mpp, y = (py + 0.5) * mpp;
      const fx = (px + 0.5) / ppc - 0.5;
      const c0 = Math.max(0, Math.min(C - 1, Math.floor(fx))), c1 = Math.min(C - 1, c0 + 1);
      const tx = Math.max(0, Math.min(1, fx - c0));
      const i00 = r0 * C + c0, i10 = r0 * C + c1, i01 = r1 * C + c0, i11 = r1 * C + c1;
      const bl = (a: Float32Array) => (a[i00]! * (1 - tx) + a[i10]! * tx) * (1 - ty) + (a[i01]! * (1 - tx) + a[i11]! * tx) * ty;
      let r = bl(cr), g = bl(cg), b = bl(cb);
      let k = (0.92 + 0.16 * vnoise(x / 35, y / 35)) * (0.965 + 0.07 * hash(px, py));
      // Plant cover with irregular, noisy edges.
      const wood = bl(fWood), orch = bl(fOrch), scrub = bl(fScrub);
      const plant = wood + orch + scrub;
      if (plant > 0.02) {
        const wr = bl(wR) / plant, wg = bl(wG) / plant, wb = bl(wB) / plant;
        const crown = vnoise(x / 5, y / 5) * 0.7 + vnoise(x / 13 + 7, y / 13) * 0.3;
        let a = 0;
        if (wood > 0) a = Math.max(a, smooth((wood - 0.5) * 2.5 + (crown - 0.5) * 1.6 + 0.5));
        if (orch > 0) {
          const gx = x / 7 - Math.floor(x / 7) - 0.5, gy = y / 7 - Math.floor(y / 7) - 0.5;
          a = Math.max(a, orch * (gx * gx + gy * gy < 0.08 ? 1 : 0.12));
        }
        if (scrub > 0) a = Math.max(a, scrub * (0.2 + 0.7 * smooth((vnoise(x / 6, y / 6) - 0.35) * 3)));
        r = r * (1 - a) + wr * a; g = g * (1 - a) + wg * a; b = b * (1 - a) + wb * a;
        if (wood > 0) k *= 1 + (0.6 * crown - 0.3) * a;
      }
      // Hill shading (light from the north-west) and contour lines (2.5 m minor, 10 m major).
      const hx = heights[py * W + Math.min(W - 1, px + 1)]! - heights[py * W + Math.max(0, px - 1)]!;
      const hy = heights[Math.min(H - 1, py + 1) * W + px]! - heights[Math.max(0, py - 1) * W + px]!;
      const nx = (-hx * exaggerate) / (2 * mpp), ny = (-hy * exaggerate) / (2 * mpp);
      k *= 1 + 0.55 * ((nx * -0.7 + ny * -0.7) / Math.sqrt(1 + nx * nx + ny * ny));
      const h0 = heights[py * W + px]!;
      const hr = heights[py * W + Math.min(W - 1, px + 1)]!, hd = heights[Math.min(H - 1, py + 1) * W + px]!;
      if (Math.floor(h0 / 10) !== Math.floor(hr / 10) || Math.floor(h0 / 10) !== Math.floor(hd / 10)) k *= 0.8;
      else if (Math.floor(h0 / 2.5) !== Math.floor(hr / 2.5) || Math.floor(h0 / 2.5) !== Math.floor(hd / 2.5)) k *= 0.91;
      const o = (py * W + px) * 4;
      d[o] = Math.min(255, r * k); d[o + 1] = Math.min(255, g * k); d[o + 2] = Math.min(255, b * k); d[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

const smooth = (v: number) => (v <= 0 ? 0 : v >= 1 ? 1 : v * v * (3 - 2 * v));

const darker = (c: number, f: number) => {
  const r = ((c >> 16) & 255) * f, g = ((c >> 8) & 255) * f, b = (c & 255) * f;
  return (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(b);
};

/** Build the terrain display for a map. Children are in world metres. */
export function buildTerrain(map: MapDef, t: TerrainCatalog): Container {
  const root = new Container();
  const tex = Texture.from(groundCanvas(map, t));
  tex.source.scaleMode = "linear";
  const ground = new Sprite(tex);
  ground.width = map.cols * map.cellSizeM;
  ground.height = map.rows * map.cellSizeM;
  root.addChild(ground);

  const g = new Graphics();
  // Water.
  for (const w of map.water) {
    if (w.kind === "pond") g.poly(w.points).fill({ color: toNum(t.surfaces["water-deep"]?.colour ?? "#36576b") });
    else g.poly(w.points, false).stroke({ width: w.widthM, color: toNum(t.surfaces["water-shallow"]?.colour ?? "#4f7184"), cap: "round", join: "round" });
  }
  // Roads: darker verge, then the surface.
  for (const r of map.roads) {
    const c = toNum(t.surfaces[r.surface]?.colour ?? "#777777");
    g.poly(r.points, false).stroke({ width: r.widthM + 1.2, color: darker(c, 0.75), cap: "round", join: "round", alpha: 0.9 });
  }
  for (const r of map.roads) {
    const c = toNum(t.surfaces[r.surface]?.colour ?? "#777777");
    g.poly(r.points, false).stroke({ width: r.widthM, color: c, cap: "round", join: "round" });
  }
  // Linear obstacles: drawn a little wider than reality so thin fences stay visible.
  for (const o of map.obstacles) {
    const k = t.obstacles[o.kind];
    const c = toNum(k?.colour ?? "#ffffff");
    const w = Math.max(o.thicknessM, 0.45);
    if (o.kind === "embankment") {
      g.poly(o.points, false).stroke({ width: o.thicknessM, color: c, cap: "butt", join: "round", alpha: 0.85 });
      g.poly(o.points, false).stroke({ width: 1.2, color: darker(c, 0.7), cap: "butt" });
    } else if (o.kind === "hedge") {
      // Hedges: a soft dark band with a darker core, wide enough to read at tactical zoom.
      g.poly(o.points, false).stroke({ width: 3.2, color: c, cap: "round", join: "round", alpha: 0.75 });
      g.poly(o.points, false).stroke({ width: 1.4, color: darker(c, 0.7), cap: "round", join: "round" });
    } else {
      g.poly(o.points, false).stroke({ width: w, color: c, cap: "round", join: "round", alpha: o.kind === "wire-fence" ? 0.8 : 1 });
    }
  }
  // Buildings: shadow, roof, ridge, outline.
  for (const b of map.buildings) {
    const fp = b.footprint;
    const h = b.storeys * b.storeyHeightM;
    const off = Math.min(6, 0.25 * h + 0.6);
    g.poly(fp.map((v, i) => v + (i % 2 === 0 ? off : off * 1.2))).fill({ color: 0x000000, alpha: 0.28 });
  }
  for (const b of map.buildings) {
    const fp = b.footprint;
    const c = toNum(b.roofColour);
    g.poly(fp).fill({ color: c }).stroke({ width: 0.35, color: darker(c, 0.6) });
    if (fp.length === 8) {
      // Ridge along the long axis; the two roof halves get slightly different light.
      const e0 = Math.hypot(fp[2]! - fp[0]!, fp[3]! - fp[1]!), e1 = Math.hypot(fp[4]! - fp[2]!, fp[5]! - fp[3]!);
      const [a, z] = e0 >= e1 ? [[fp[6]!, fp[7]!, fp[0]!, fp[1]!], [fp[2]!, fp[3]!, fp[4]!, fp[5]!]] : [[fp[0]!, fp[1]!, fp[2]!, fp[3]!], [fp[4]!, fp[5]!, fp[6]!, fp[7]!]];
      const m0x = (a[0]! + a[2]!) / 2, m0y = (a[1]! + a[3]!) / 2, m1x = (z[0]! + z[2]!) / 2, m1y = (z[1]! + z[3]!) / 2;
      const flat = b.kind === "warehouse" || b.kind === "apartment-block" || b.kind === "office";
      if (!flat) {
        g.poly([a[0]!, a[1]!, m0x, m0y, m1x, m1y, z[2]!, z[3]!]).fill({ color: 0x000000, alpha: 0.12 });
        g.moveTo(m0x, m0y).lineTo(m1x, m1y).stroke({ width: 0.4, color: darker(c, 0.55) });
      } else {
        g.poly(fp).stroke({ width: 0.8, color: darker(c, 0.8) });
      }
    }
  }
  root.addChild(g);
  return root;
}
