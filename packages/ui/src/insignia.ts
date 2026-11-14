/**
 * Rank insignia (the "insignia" step, owner 2026-11-14): a man's rank as it looks on the field uniform, drawn in
 * code as a small SVG from the faction's appearance data (`appearance.json` → `insignia`): the board (a slide, a
 * shoulder board or a tab, its colours) and the rank's devices (diagonal bars, cross stripes, braid, chevrons,
 * stars, oak leaves). Original drawings of public military insignia; no faction is named here (SPEC 4.3 rule 8):
 * everything comes from the data. Pure strings: no DOM, testable.
 *
 * The board stands upright, its collar end at the top, in a 20 x 44 box.
 */
import type { Insignia, InsigniaDevice } from "@tcs/data";

const W = 20, H = 44;

/** A star of `points` points centred at (cx, cy), outer radius r (a 4-point pip is fuller in the middle). */
function star(cx: number, cy: number, r: number, points: number): string {
  const inner = points === 4 ? r * 0.5 : r * 0.42;
  const pts: string[] = [];
  for (let k = 0; k < points * 2; k++) {
    const a = -Math.PI / 2 + (k * Math.PI) / points;
    const rr = k % 2 === 0 ? r : inner;
    pts.push(`${(cx + rr * Math.cos(a)).toFixed(2)},${(cy + rr * Math.sin(a)).toFixed(2)}`);
  }
  return `<polygon points="${pts.join(" ")}"/>`;
}

/** The board's outline (and its top: where the devices may start). */
function board(shape: Insignia["shape"]): { path: string; top: number; bottom: number; extra: string } {
  if (shape === "pogon") return { path: `M1.5 43V10L10 2.5 18.5 10V43z`, top: 13, bottom: 41, extra: "button" };
  if (shape === "tab") return { path: `M6 3h8a5 5 0 0 1 5 5v28a5 5 0 0 1-5 5H6a5 5 0 0 1-5-5V8a5 5 0 0 1 5-5z`, top: 7, bottom: 37, extra: "" };
  return { path: `M2.5 1.5h15a1 1 0 0 1 1 1v39a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1v-39a1 1 0 0 1 1-1z`, top: 5, bottom: 40, extra: "" };
}

/** The devices of one rank on the given board, in the device colour (fill) or as strokes. */
function devices(d: InsigniaDevice, ins: Insignia, top: number, bottom: number): string {
  const out: string[] = [];
  const stroke = (p: string, w = 2.4) => out.push(`<path d="${p}" fill="none" stroke="${ins.device}" stroke-width="${w}" stroke-linejoin="miter"/>`);
  let lo = bottom, hi = top; // the free span still left (devices take room from the collar end down, stars from the outer end up)
  if (d.braid) {
    // Braid round the board's edge: "open" leaves the outer (shoulder) end open.
    const i = 3.6;
    stroke(d.braid === "open" ? `M${i} ${H - 1}V${top - 1.5}H${W - i}V${H - 1}` : `M${i} ${top - 1.5}H${W - i}V${bottom + 1.2}H${i}z`, 2.2);
    hi = top + 2.5; lo = bottom - 2.5;
  }
  if (d.longStripe) out.push(`<rect x="${W / 2 - 3}" y="${hi}" width="6" height="${lo - hi}" fill="${ins.device}"/>`);
  if (d.wideStripe) { out.push(`<rect x="1.5" y="${hi + 1}" width="${W - 3}" height="6" fill="${ins.device}"/>`); hi += 9; }
  for (let k = 0; k < (d.stripes ?? 0); k++) { out.push(`<rect x="1.5" y="${hi + 1 + k * 4.6}" width="${W - 3}" height="2.6" fill="${ins.device}"/>`); }
  if ((d.stripes ?? 0) > 0) hi += 2 + (d.stripes ?? 0) * 4.6;
  if (d.headChevron) {
    // A headed chevron: the chevron and a bar under its point that closes it (Kopfwinkel).
    const y = hi + 3;
    stroke(`M5 ${y + 6}L10 ${y}L15 ${y + 6}`);
    stroke(`M7.3 ${y + 3.6}H12.7`, 2);
    hi = y + 9;
  }
  for (let k = 0; k < (d.chevrons ?? 0); k++) {
    const y = hi + 3 + k * 5;
    stroke(`M5 ${y + 6}L10 ${y}L15 ${y + 6}`);
  }
  if ((d.chevrons ?? 0) > 0) hi += 3 + (d.chevrons ?? 0) * 5 + 4;
  if ((d.bars ?? 0) > 0) {
    // Diagonal stripes rising to the right, centred in what is left.
    const n = d.bars!, step = 4.8, mid = (hi + lo) / 2 + 2, y0 = mid + ((n - 1) * step) / 2;
    for (let k = 0; k < n; k++) {
      const y = y0 - k * step;
      out.push(`<path d="M3 ${y + 3.2}L17 ${y - 3.2}V${y - 0.6}L3 ${y + 5.8}z" fill="${ins.device}"/>`);
    }
  }
  if (d.oakLeaves) {
    const y = lo - 3;
    out.push(`<path d="M10 ${y}C6 ${y - 1} 4.5 ${y - 4} 5 ${y - 7}C7.5 ${y - 6} 9.5 ${y - 3.5} 10 ${y}C10.5 ${y - 3.5} 12.5 ${y - 6} 15 ${y - 7}C15.5 ${y - 4} 14 ${y - 1} 10 ${y}z" fill="${ins.device}"/>`);
    lo = y - 8;
  }
  const n = d.stars ?? 0;
  if (n > 0) {
    const r = ins.starPoints === 4 ? 4.2 : 4, gap = 9;
    if (d.starLayout === "pairs") {
      const y = lo - 5;
      for (let k = 0; k < Math.min(2, n); k++) out.push(star(k === 0 ? 5.6 : 14.4, y, r, ins.starPoints));
      for (let k = 2; k < n; k++) out.push(star(W / 2, y - (k - 1) * gap, r, ins.starPoints));
    } else {
      // Along the middle from the outer end.
      for (let k = 0; k < n; k++) out.push(star(W / 2, lo - 5 - k * gap, r, ins.starPoints));
    }
  }
  return out.length === 0 ? "" : `<g fill="${ins.device}">${out.join("")}</g>`;
}

/**
 * The rank's insignia as inline SVG `px` tall (a board 20 x 44 scaled), or "" when the faction has no insignia data
 * or that rank is missing. `title`: an accessible name (the rank's name).
 */
export function insigniaSvg(ins: Insignia | undefined, rank: string, px = 22, title = ""): string {
  const d = ins?.ranks[rank];
  if (!ins || !d) return "";
  const b = board(ins.shape);
  const w = Math.round((px * W) / H * 10) / 10;
  const btn = b.extra === "button" ? `<circle cx="10" cy="7.6" r="2.1" fill="${ins.edge}"/>` : "";
  const label = title ? `<title>${title.replace(/[&<>"]/g, "")}</title>` : "";
  return `<svg class="hud-insignia" viewBox="0 0 ${W} ${H}" width="${w}" height="${px}" role="img"${title ? ` aria-label="${title.replace(/[&<>"]/g, "")}"` : ` aria-hidden="true"`}>${label}`
    + `<path d="${b.path}" fill="${ins.base}" stroke="${ins.edge}" stroke-width="1.2"/>${btn}${devices(d, ins, b.top, b.bottom)}</svg>`;
}
