/**
 * Label decluttering (M7.5a, plan m7.5 §3): the owner saw vehicle and squad labels overlap when zoomed out.
 * Each frame the renderer collects label requests (an anchor point on screen — a man, a hull, a symbol — and
 * the text) and `placeLabels` places them greedily over a 16 px occupancy grid: the selected unit's labels first,
 * then by priority, then by id; each tries four places round its anchor (right, left, above, below) and takes the
 * first whose cells are all free — free of other labels, of the other symbols (a label never hides another
 * man's or hull's symbol) and of the screen areas the HUD covers; a label that fits nowhere is dropped this frame.
 * Width is estimated (chars x 7 px) so no text is measured. Forced labels (debug text) keep their given place and
 * only block cells. (The plan said 16 px cells; 8 px packs labels of hulls 10 px apart, so 8 it is.)
 * A label never hangs off the screen edge (it tries another place or is dropped). Pure: no Pixi; tested without a canvas.
 */
export const LABEL_CELL_PX = 8;
export const LABEL_CHAR_PX = 7;
export const LABEL_HEIGHT_PX = 14;

export interface LabelRequest {
  text: string;
  /** Anchor point (screen px) and the clearance round it (half the symbol's size) the label keeps off. */
  x: number;
  y: number;
  r: number;
  colour: number;
  /** Lower goes first: 0 = the selected unit, 1 = objectives, 2 = units. Ties by `id` (lower first). */
  priority: number;
  id: number;
  /** Debug text: drawn at (x, y) as its top-left corner whatever else is there. */
  force?: boolean;
  /** Keep other labels off the anchor's symbol, this far round (px; 0 or absent = no symbol to keep clear). */
  block?: number;
}

/** A screen rectangle no label may cover (the HUD's bars and sidebar). */
export interface Rect { x: number; y: number; w: number; h: number }

export interface PlacedLabel { index: number; x: number; y: number; w: number; h: number }

/** Estimated width of a label (px). */
export const labelWidth = (text: string) => text.length * LABEL_CHAR_PX + 2;

/** Occupancy grid reused between frames (stamps instead of clearing): labels, and symbols with their owner. */
class Grid {
  cols = 0; rows = 0; stamp = 1;
  cells = new Uint32Array(0);
  sym = new Uint32Array(0);
  owner = new Int32Array(0);
  reset(w: number, h: number): void {
    const cols = Math.ceil(w / LABEL_CELL_PX) + 1, rows = Math.ceil(h / LABEL_CELL_PX) + 1;
    if (cols * rows > this.cells.length) { this.cells = new Uint32Array(cols * rows); this.sym = new Uint32Array(cols * rows); this.owner = new Int32Array(cols * rows); }
    this.cols = cols; this.rows = rows;
    if (++this.stamp === 0xffffffff) { this.cells.fill(0); this.sym.fill(0); this.stamp = 1; }
  }
  private span(x: number, y: number, w: number, h: number): [number, number, number, number] {
    return [Math.max(0, Math.floor(x / LABEL_CELL_PX)), Math.min(this.cols - 1, Math.floor((x + w - 1) / LABEL_CELL_PX)),
      Math.max(0, Math.floor(y / LABEL_CELL_PX)), Math.min(this.rows - 1, Math.floor((y + h - 1) / LABEL_CELL_PX))];
  }
  /** Is every cell under the rectangle free of labels and of symbols other than `self`'s, and on the screen? */
  free(x: number, y: number, w: number, h: number, self: number): boolean {
    if (x < 0 || y < 0 || Math.floor((x + w - 1) / LABEL_CELL_PX) >= this.cols - 1 || Math.floor((y + h - 1) / LABEL_CELL_PX) >= this.rows - 1) return false;
    const [c0, c1, r0, r1] = this.span(x, y, w, h);
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
      const k = r * this.cols + c;
      if (this.cells[k] === this.stamp || (this.sym[k] === this.stamp && this.owner[k] !== self)) return false;
    }
    return true;
  }
  mark(x: number, y: number, w: number, h: number): void {
    const [c0, c1, r0, r1] = this.span(x, y, w, h);
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) this.cells[r * this.cols + c] = this.stamp;
  }
  markSymbol(x: number, y: number, w: number, h: number, self: number): void {
    const [c0, c1, r0, r1] = this.span(x, y, w, h);
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) { const k = r * this.cols + c; this.sym[k] = this.stamp; this.owner[k] = self; }
  }
}
const grid = new Grid();
const order: number[] = [];

/**
 * Place the labels on a `screenW` x `screenH` screen. Returns the placed ones (index into `reqs`, top-left, size);
 * two placed labels never share a grid cell, so they never overlap. Labels entirely off the screen are skipped.
 */
export function placeLabels(reqs: readonly LabelRequest[], screenW: number, screenH: number, blocked: readonly Rect[] = []): PlacedLabel[] {
  grid.reset(screenW, screenH);
  const out: PlacedLabel[] = [];
  for (const b of blocked) grid.mark(b.x, b.y, b.w, b.h);
  // Symbols: a label stays off every symbol but its own (a cell two symbols share belongs to the later one).
  for (let i = 0; i < reqs.length; i++) {
    const q = reqs[i]!, k = q.block ?? 0;
    if (k > 0 && !q.force) grid.markSymbol(q.x - k, q.y - k, 2 * k, 2 * k, i);
  }
  const h = LABEL_HEIGHT_PX;
  // Forced labels first (they only block), then the rest in priority / id order.
  order.length = 0;
  for (let i = 0; i < reqs.length; i++) order.push(i);
  order.sort((a, b) => {
    const p = reqs[a]!, q = reqs[b]!;
    return (p.force ? -1 : p.priority) - (q.force ? -1 : q.priority) || p.id - q.id || a - b;
  });
  for (const i of order) {
    const q = reqs[i]!;
    const w = labelWidth(q.text);
    if (q.force) { grid.mark(q.x, q.y, w, h); out.push({ index: i, x: q.x, y: q.y, w, h }); continue; }
    if (q.x + q.r + w < 0 || q.x - q.r - w > screenW || q.y + q.r + h < 0 || q.y - q.r - h > screenH) continue;
    const d = q.r + 3;
    // Right, left, above, below the anchor.
    const spots = [q.x + d, q.y - h / 2, q.x - d - w, q.y - h / 2, q.x - w / 2, q.y - d - h, q.x - w / 2, q.y + d];
    for (let k = 0; k < 8; k += 2) {
      const x = Math.round(spots[k]!), y = Math.round(spots[k + 1]!);
      if (!grid.free(x, y, w, h, i)) continue;
      grid.mark(x, y, w, h);
      out.push({ index: i, x, y, w, h });
      break;
    }
  }
  return out;
}

/**
 * Review fix: the callsigns as shown — the same callsign in two units of a side (each platoon has its "Puma 1",
 * its "Trupp 1") is told apart by the number of the unit above it, as "1/Puma 2" (the parent's last number, else
 * its whole callsign). Unique callsigns stay as they are. Pure; the renderer builds it once a frame.
 */
export function shownCallsigns(units: Iterable<readonly [number, { readonly side: string; readonly callsign: string; readonly parent: number | null }]>): Map<number, string> {
  const all = [...units];
  const count = new Map<string, number>();
  for (const [, u] of all) { const k = `${u.side}\u0000${u.callsign}`; count.set(k, (count.get(k) ?? 0) + 1); }
  const byId = new Map(all);
  const out = new Map<number, string>();
  for (const [id, u] of all) {
    const dup = (count.get(`${u.side}\u0000${u.callsign}`) ?? 0) > 1;
    const p = dup && u.parent !== null ? byId.get(u.parent) : undefined;
    if (!p) { out.set(id, u.callsign); continue; }
    const num = /(\d+)\s*$/.exec(p.callsign);
    out.set(id, `${num ? num[1] : p.callsign}/${u.callsign}`);
  }
  return out;
}
