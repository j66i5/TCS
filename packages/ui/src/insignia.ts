/**
 * Rank insignia (the "insignia" step, owner 2026-11-14; exact shapes, "insignia-exact"): a man's rank as it looks on
 * the field uniform, drawn in code as a small SVG from the faction's appearance data (`appearance.json` →
 * `insignia`): the rank board (its trapezoid, corners and cloth), the shoulder strap showing above and below it (its
 * button), the arm-of-service loop (Litze) at the shoulder seam, and the rank's devices (diagonal stripes, cross and
 * long stripes, braid, chevrons, headed chevron, stars), every one placed in millimetres on the real board. Original
 * drawings of public military insignia; no faction is named here (SPEC 4.3 rule 8): everything comes from the data.
 * Pure strings: no DOM, testable.
 *
 * The viewBox is in millimetres (collar end at the top), so the picture keeps the real proportions at any size. Only
 * where a feature would vanish at small sizes does the drawing help it: cross and diagonal stripes keep a gap of
 * about a pixel between them, stars stay at least about 5 px across, the Litze and the board's edge stay at least
 * about a pixel wide, and below the faction's `small.belowPx` low-contrast devices take their small colour and a
 * light 1 px outline. Four-pointed stars are faceted pips once they are 12 px across.
 */
import type { Insignia, InsigniaElement } from "@tcs/data";

const f = (v: number) => String(Math.round(v * 100) / 100);
type P = readonly [number, number];

/** A closed path through the points with each corner rounded by r (quadratic arcs; r 0: sharp). */
function roundedPath(pts: readonly P[], r: number): string {
  if (r <= 0) return `M${pts.map((p) => `${f(p[0])} ${f(p[1])}`).join("L")}z`;
  const n = pts.length, out: string[] = [];
  for (let i = 0; i < n; i++) {
    const v = pts[i]!, a = pts[(i + n - 1) % n]!, b = pts[(i + 1) % n]!;
    const toward = (q: P): P => { const dx = q[0] - v[0], dy = q[1] - v[1], d = Math.hypot(dx, dy) || 1, k = Math.min(r, d / 2) / d; return [v[0] + dx * k, v[1] + dy * k]; };
    const p1 = toward(a), p2 = toward(b);
    out.push(`${i === 0 ? "M" : "L"}${f(p1[0])} ${f(p1[1])}Q${f(v[0])} ${f(v[1])} ${f(p2[0])} ${f(p2[1])}`);
  }
  return `${out.join("")}z`;
}

/**
 * A star of `points` points centred at (cx, cy) (SVG units), outer radius r, one point up. `facets`: a pressed pip
 * (each point a low pyramid): the half-points facing the light (from the upper left) drawn lighter.
 */
function star(cx: number, cy: number, r: number, points: number, facets: boolean): string {
  const inner = points === 4 ? r * 0.42 : r * 0.382;
  const pt = (k: number): P => { const a = -Math.PI / 2 + (k * Math.PI) / points, rr = k % 2 === 0 ? r : inner; return [cx + rr * Math.cos(a), cy + rr * Math.sin(a)]; };
  const pts: string[] = [];
  for (let k = 0; k < points * 2; k++) { const p = pt(k); pts.push(`${f(p[0])},${f(p[1])}`); }
  let lit = "";
  if (facets) {
    const light = (-3 * Math.PI) / 4;
    for (let k = 0; k < points * 2; k++) {
      const mid = -Math.PI / 2 + ((k + 0.5) * Math.PI) / points; // the facet between point k and k + 1
      if (Math.cos(mid - light) <= 0) continue;
      const a = pt(k), b = pt(k + 1);
      lit += `M${f(cx)} ${f(cy)}L${f(a[0])} ${f(a[1])}L${f(b[0])} ${f(b[1])}z`;
    }
  }
  return `<polygon points="${pts.join(" ")}"/>${lit ? `<path d="${lit}" fill="#fff" fill-opacity="0.16" stroke="none"/>` : ""}`;
}

/** The drawing's frame: board-to-SVG mapping and the board's half width at y (mm from its shoulder end). */
interface Frame { L: number; Y: (y: number) => number; hw: (y: number) => number; sep: number; minStarR: number; px1: number; colour: string }

function element(e: InsigniaElement, fr: Frame): string {
  const { Y, hw, L, sep, minStarR, px1, colour } = fr;
  const line = (pts: readonly P[], w: number, closed: boolean) =>
    `<path d="M${pts.map((p) => `${f(p[0])} ${f(Y(p[1]))}`).join("L")}${closed ? "z" : ""}" fill="none" stroke="${colour}" stroke-width="${f(w)}" stroke-linejoin="miter" stroke-miterlimit="10"/>`;
  switch (e.kind) {
    case "band": {
      if (e.x0 !== undefined || e.x1 !== undefined) {
        const x0 = e.x0 ?? -hw(e.y0), x1 = e.x1 ?? hw(e.y0);
        return `<rect x="${f(Math.min(x0, x1))}" y="${f(Y(Math.max(e.y0, e.y1)))}" width="${f(Math.abs(x1 - x0))}" height="${f(Math.abs(e.y1 - e.y0))}"/>`;
      }
      // Edge to edge; at small sizes each stripe gives up a little height so that neighbours stay apart.
      const lo = Math.min(e.y0, e.y1), hi = Math.max(e.y0, e.y1), s = Math.min(sep, (hi - lo) * 0.4) / 2;
      const a = lo + s, b = hi - s;
      return `<path d="${roundedPath([[-hw(a), Y(a)], [hw(a), Y(a)], [hw(b), Y(b)], [-hw(b), Y(b)]], 0)}"/>`;
    }
    case "bar": {
      const t = Math.tan((e.angleDeg * Math.PI) / 180), half = (Math.max(e.widthMm * 0.6, e.widthMm - sep) / 2) / Math.cos((e.angleDeg * Math.PI) / 180);
      const xl = -(hw(e.y) - e.insetMm), xr = hw(e.y) - e.insetMm;
      const yl = e.y + xl * t, yr = e.y + xr * t;
      return `<path d="${roundedPath([[xl, Y(yl - half)], [xr, Y(yr - half)], [xr, Y(yr + half)], [xl, Y(yl + half)]], 0)}"/>`;
    }
    case "braid": {
      const c = e.insetMm + e.widthMm / 2, top = L - c;
      if (e.open) return line([[-(hw(0) - c), 0], [-(hw(top) - c), top], [hw(top) - c, top], [hw(0) - c, 0]], e.widthMm, false);
      return line([[-(hw(c) - c), c], [hw(c) - c, c], [hw(top) - c, top], [-(hw(top) - c), top]], e.widthMm, true);
    }
    case "chevron": {
      const s = e.halfSpanMm, r = e.riseMm, h = e.headMm ?? 0;
      if (h <= 0) return line([[-s, e.y - r], [0, e.y], [s, e.y - r]], e.widthMm, false);
      // Headed: the legs cross at (0, y) and run on up to close a diamond (each leg continues in its own line).
      const k = h / r;
      return line([[-s, e.y - r], [0, e.y], [s * k, e.y + h], [0, e.y + 2 * h], [-s * k, e.y + h], [0, e.y], [s, e.y - r]], e.widthMm, false);
    }
    case "star": {
      const r = Math.max(e.diameterMm / 2, minStarR);
      return star(e.x, Y(e.y), r, e.points, e.points === 4 && r > 6 * px1); // facets only where they show (12 px across)
    }
  }
}

/** The drawing's size in millimetres (width, height) for a faction's insignia: board, strap and Litze. */
export function insigniaSizeMm(ins: Insignia): { w: number; h: number } {
  const b = ins.board, st = ins.strap, m = 1;
  const sw = st ? Math.max(strapWidthAt(ins, -st.belowMm), strapWidthAt(ins, b.lengthMm + st.aboveMm)) : 0;
  return { w: Math.max(b.widthTopMm, b.widthBottomMm, sw) + 2 * m, h: b.lengthMm + (st ? st.aboveMm + st.belowMm : 0) + 2 * m };
}

/** The strap's width at y (mm from the board's shoulder end): `widthMm` at the collar end, widening with the board. */
function strapWidthAt(ins: Insignia, y: number): number {
  const b = ins.board;
  return (ins.strap?.widthMm ?? 0) + (b.widthBottomMm - b.widthTopMm) * (1 - y / b.lengthMm);
}

/**
 * The rank's insignia as inline SVG `px` tall (real proportions, so the width follows), or "" when the faction has
 * no insignia data or that rank is missing. `title`: an accessible name (the rank's name).
 */
export function insigniaSvg(ins: Insignia | undefined, rank: string, px = 22, title = ""): string {
  const d = ins?.ranks[rank];
  if (!ins || !d) return "";
  const b = ins.board, st = ins.strap, L = b.lengthMm, m = 1;
  const { w: W, h: H } = insigniaSizeMm(ins);
  const top = L + (st?.aboveMm ?? 0) + m;
  const scale = px / H; // px per mm
  const Y = (y: number) => top - y;
  const hw = (y: number) => b.widthBottomMm / 2 + ((b.widthTopMm - b.widthBottomMm) / 2) * (y / L);
  const px1 = 1 / scale; // one pixel in mm
  const small = ins.small && px < ins.small.belowPx ? ins.small : undefined;
  const device = small?.device ?? ins.device;
  const fr: Frame = { L, Y, hw, sep: Math.max(0, 1.1 * px1 - 2), minStarR: 2.6 * px1, px1, colour: device };
  const parts: string[] = [];
  if (st) {
    const sw = (y: number) => strapWidthAt(ins, y) / 2, yb = -st.belowMm, yt = L + st.aboveMm, c = Math.min(sw(yt) * 0.6, st.aboveMm);
    parts.push(`<path d="${roundedPath([[-sw(yb), Y(yb)], [sw(yb), Y(yb)], [sw(yt - c), Y(yt - c)], [sw(yt) - c, Y(yt)], [-(sw(yt) - c), Y(yt)], [-sw(yt - c), Y(yt - c)]], 2)}" fill="${st.colour}" stroke="${st.edge}" stroke-width="${f(Math.max(0.6, 0.8 * px1))}"/>`);
    if (st.buttonMm > 0 && st.aboveMm > 0) parts.push(`<circle cx="0" cy="${f(Y(L + Math.max(st.buttonMm / 2 + 1, st.aboveMm / 2)))}" r="${f(st.buttonMm / 2)}" fill="${st.edge}"/>`);
    if (ins.litze) {
      const lw = Math.max(ins.litze.widthMm, 1.4 * px1), yc = -(ins.litze.gapMm + ins.litze.widthMm / 2);
      parts.push(`<rect x="${f(-sw(yc) - 0.8)}" y="${f(Y(yc) - lw / 2)}" width="${f(2 * sw(yc) + 1.6)}" height="${f(lw)}" fill="${ins.litze.colour}"/>`);
    }
  }
  if (!d.bare) {
    parts.push(`<path d="${roundedPath([[-hw(0), Y(0)], [hw(0), Y(0)], [hw(L), Y(L)], [-hw(L), Y(L)]], b.cornerMm)}" fill="${b.colour}" stroke="${b.edge}" stroke-width="${f(Math.max(0.6, 0.8 * px1))}"/>`);
    const halo = small?.outline ? ` stroke="${small.outline}" stroke-width="${f(1.6 * px1)}" stroke-linejoin="round" paint-order="stroke"` : "";
    if (d.elements.length > 0) parts.push(`<g fill="${device}"${halo}>${d.elements.map((e) => element(e, fr)).join("")}</g>`);
  }
  const w = Math.round(((px * W) / H) * 10) / 10;
  const name = title.replace(/[&<>"]/g, "");
  return `<svg class="hud-insignia" viewBox="${f(-W / 2)} 0 ${f(W)} ${f(H)}" width="${w}" height="${px}" role="img"${name ? ` aria-label="${name}"` : ` aria-hidden="true"`}>${name ? `<title>${name}</title>` : ""}${parts.join("")}</svg>`;
}
