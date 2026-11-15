/**
 * Soldier sprite atlas (M7.5b, plan m7.5 §4). Pure part: compose a frame from the art (`soldier-art.ts`) with its
 * weapon variant, launcher, muzzle flash and wound marks; turn it to one of 16 facings (pre-rotated pixel art: the
 * picture is enlarged 4x with Scale2x twice and sampled back, so a rotated man keeps clean pixels); the side
 * outline (1-px mask around the figure, tinted blue or red by the renderer); the faction's palette swap.
 * Pixi part: `SoldierAtlas` builds cells lazily into one RGBA buffer texture (nearest sampling).
 */
import { BufferImageSource, Rectangle, Texture } from "pixi.js";
import type { FactionLook } from "@tcs/data";
import { ARMED, ART, FRAMES, LYING, NO_LAUNCHER, WOUND_MARKS, type FrameId } from "./soldier-art";

/**
 * Atlas cell: the 16-px art with a 6-px margin, so a turned figure with a machine gun and its flash, the side outline
 * and the photo rim (2 px beyond the outline) all stay inside the cell (sprite fix 2026-11-15: with 3 px the corners
 * of a turned stretcher or prone man were cut off). Cells sit `GUTTER` px apart in the atlas texture (transparent),
 * so no sampling at a cell edge ever reads a neighbour cell.
 */
export const CELL = 28;
const PAD = 6;
export const GUTTER = 2;
/** Pivot (the man's position) in cell pixels: the centre of art pixel (8, 8). */
export const PIVOT = 8 + PAD + 0.5;
export const LETTERS = ".udlhsgwtfxr";
const L = Object.fromEntries([...LETTERS].map((c, i) => [c, i])) as Record<string, number>;
export const FACINGS = 16;

export type WeaponLook = "rifle" | "mg" | "marksman";
export interface FrameKey { frame: FrameId; weapon: WeaponLook; launcher: boolean; firing: boolean; wounded: boolean; facing: number }

/** WeaponDef.type -> how it is drawn. */
export function weaponLook(type: string | undefined): WeaponLook {
  return type === "machine-gun" || type === "light-machine-gun" ? "mg" : type === "marksman-rifle" ? "marksman" : "rifle";
}

/** Letter codes (indices into LETTERS) of one cell, facing east. */
export function composeFrame(k: Omit<FrameKey, "facing">): Uint8Array {
  const g = new Uint8Array(CELL * CELL);
  const art = FRAMES[k.frame];
  for (let y = 0; y < ART; y++) for (let x = 0; x < ART; x++) g[(y + PAD) * CELL + x + PAD] = L[art[y]![x]!] ?? 0;
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= CELL || y >= CELL ? -1 : g[y * CELL + x]!);
  const put = (x: number, y: number, c: string, onlyEmpty = false) => {
    if (x < 0 || y < 0 || x >= CELL || y >= CELL) return;
    if (onlyEmpty && g[y * CELL + x] !== 0) return;
    g[y * CELL + x] = L[c]!;
  };
  if (ARMED.has(k.frame)) {
    // The weapon: the longest horizontal run of `w`.
    let row = -1, a = 0, b = -1;
    for (let y = 0; y < CELL; y++) {
      let x = 0;
      while (x < CELL) {
        if (at(x, y) !== L.w) { x++; continue; }
        let e = x;
        while (at(e + 1, y) === L.w) e++;
        if (e - x > b - a) { row = y; a = x; b = e; }
        x = e + 1;
      }
    }
    if (row >= 0) {
      if (k.weapon === "mg") { put(b + 1, row, "w"); put(b + 2, row, "w"); put(a + 2, row + 1, "g", true); put(a + 3, row + 1, "g", true); b += 2; }
      if (k.weapon === "marksman") { put(b + 1, row, "w"); put(b + 2, row, "w"); put(a + 1, row - 1, "w", true); put(a + 2, row - 1, "w", true); b += 2; }
      if (k.firing) { put(b + 1, row, "x"); put(b + 2, row, "f"); put(b + 3, row, "f"); put(b + 1, row - 1, "f"); put(b + 1, row + 1, "f"); }
    }
  }
  if (k.launcher && !NO_LAUNCHER.has(k.frame)) {
    // A tube slung across the pack.
    let x0 = CELL, y0 = CELL, x1 = -1, y1 = -1;
    for (let y = 0; y < CELL; y++) for (let x = 0; x < CELL; x++) if (g[y * CELL + x] === L.g) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    if (x1 >= 0) {
      const ax = x0 - 1, ay = y0 - 2, bx = x1 + 1, by = y1 + 2, n = Math.max(Math.abs(bx - ax), Math.abs(by - ay));
      for (let i = 0; i <= n; i++) put(Math.round(ax + ((bx - ax) * i) / n), Math.round(ay + ((by - ay) * i) / n), i === 0 || i === n ? "d" : "t");
    }
  }
  if (k.wounded && k.frame !== "dead") {
    for (const [x, y, c] of WOUND_MARKS[LYING.has(k.frame) ? "lying" : "upright"]) if (at(x + PAD, y + PAD) > 0) put(x + PAD, y + PAD, c);
  }
  return g;
}

/** Scale2x (EPX) of a letter grid: n x n -> 2n x 2n, keeping diagonals clean. */
function scale2x(src: Uint8Array, n: number): Uint8Array {
  const m = 2 * n, out = new Uint8Array(m * m);
  const p = (x: number, y: number) => src[Math.min(n - 1, Math.max(0, y)) * n + Math.min(n - 1, Math.max(0, x))]!;
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const P = p(x, y), A = p(x, y - 1), B = p(x + 1, y), C = p(x - 1, y), D = p(x, y + 1);
    const o = 2 * y * m + 2 * x;
    out[o] = C === A && C !== D && A !== B ? A : P;
    out[o + 1] = A === B && A !== C && B !== D ? B : P;
    out[o + m] = D === C && D !== B && C !== A ? C : P;
    out[o + m + 1] = B === D && B !== A && D !== C ? D : P;
  }
  return out;
}

/** True for a letter that is part of the figure (not empty, not the muzzle flash). */
const solidLetter = (v: number) => v !== 0 && v !== L.f && v !== L.x;

/**
 * Empty pixels shut in by the figure (4-connected, not reachable from the cell's border), as a mask: 1 inside.
 * Such gaps (between an arm and the helmet, or left by turning) are never outlined.
 */
export function enclosedMask(g: Uint8Array): Uint8Array {
  const out = new Uint8Array(CELL * CELL).fill(1), stack: number[] = [];
  const push = (i: number) => { if (out[i] === 1 && g[i] === 0) { out[i] = 0; stack.push(i); } };
  for (let i = 0; i < CELL; i++) { push(i); push((CELL - 1) * CELL + i); push(i * CELL); push(i * CELL + CELL - 1); }
  while (stack.length > 0) {
    const i = stack.pop()!, x = i % CELL, y = (i / CELL) | 0;
    if (x > 0) push(i - 1);
    if (x < CELL - 1) push(i + 1);
    if (y > 0) push(i - CELL);
    if (y < CELL - 1) push(i + CELL);
  }
  for (let i = 0; i < out.length; i++) if (g[i] !== 0) out[i] = 0;
  return out;
}

/**
 * Tidy a turned cell (sprite fix 2026-11-15): pinholes of 1-2 px shut in by the figure are filled with the dark
 * uniform tone (sampling leaves them; they showed the ground, or the side colour, through the body), and a lone
 * figure pixel with no figure neighbour is dropped (a speck torn off a thin line).
 */
function tidy(g: Uint8Array): Uint8Array {
  const enc = enclosedMask(g), seen = new Uint8Array(CELL * CELL);
  for (let i = 0; i < enc.length; i++) {
    if (!enc[i] || seen[i]) continue;
    const region: number[] = [i], stack = [i];
    seen[i] = 1;
    while (stack.length > 0) {
      const j = stack.pop()!, x = j % CELL;
      for (const n of [x > 0 ? j - 1 : -1, x < CELL - 1 ? j + 1 : -1, j - CELL, j + CELL]) {
        if (n < 0 || n >= enc.length || !enc[n] || seen[n]) continue;
        seen[n] = 1; region.push(n); stack.push(n);
      }
    }
    if (region.length <= 2) for (const j of region) g[j] = L.d!;
  }
  for (let y = 0; y < CELL; y++) for (let x = 0; x < CELL; x++) {
    if (!solidLetter(g[y * CELL + x]!)) continue;
    let n = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const X = x + dx, Y = y + dy;
      if ((dx || dy) && X >= 0 && Y >= 0 && X < CELL && Y < CELL && g[Y * CELL + X] !== 0) n++;
    }
    if (n === 0) g[y * CELL + x] = 0;
  }
  return g;
}

/**
 * The cell turned clockwise (screen, y down) by facing * 22.5 degrees about the pivot: quarter turns move pixels
 * exactly; the others sample a 4x Scale2x enlargement (clean diagonals), then pinholes and lone specks are tidied.
 */
export function rotateFrame(g: Uint8Array, facing: number): Uint8Array {
  const f = ((facing % FACINGS) + FACINGS) % FACINGS;
  if (f === 0) return g.slice();
  const out = new Uint8Array(CELL * CELL);
  const c = PIVOT; // pivot at a pixel centre: quarter turns map pixels onto pixels exactly
  if (f % 4 === 0) {
    for (let y = 0; y < CELL; y++) for (let x = 0; x < CELL; x++) {
      const dx = x + 0.5 - c, dy = y + 0.5 - c;
      // inverse turn
      const [sx, sy] = f === 4 ? [dy, -dx] : f === 8 ? [-dx, -dy] : [-dy, dx];
      const X = Math.floor(sx + c), Y = Math.floor(sy + c);
      out[y * CELL + x] = X < 0 || Y < 0 || X >= CELL || Y >= CELL ? 0 : g[Y * CELL + X]!;
    }
    return out;
  }
  const big = scale2x(scale2x(g, CELL), 2 * CELL), n = 4 * CELL;
  const a = (f * Math.PI) / 8, ca = Math.cos(a), sa = Math.sin(a);
  for (let y = 0; y < CELL; y++) for (let x = 0; x < CELL; x++) {
    const dx = x + 0.5 - c, dy = y + 0.5 - c;
    const sx = dx * ca + dy * sa + c, sy = -dx * sa + dy * ca + c;
    const X = Math.floor(sx * 4), Y = Math.floor(sy * 4);
    out[y * CELL + x] = X < 0 || Y < 0 || X >= n || Y >= n ? 0 : big[Y * n + X]!;
  }
  // Details and thin lines (weapon, tube, hands, face, highlights, dressing, blood, flash) are also carried over pixel
  // by pixel to where they turn to: Scale2x rounds off single pixels, so sampling alone dropped them at some facings
  // and broke the rifle into specks (sprite fix 2026-11-15).
  for (const v of DETAIL) for (let y = 0; y < CELL; y++) for (let x = 0; x < CELL; x++) {
    if (g[y * CELL + x] !== v) continue;
    const dx = x + 0.5 - c, dy = y + 0.5 - c;
    const X = Math.floor(dx * ca - dy * sa + c), Y = Math.floor(dx * sa + dy * ca + c);
    if (X >= 0 && Y >= 0 && X < CELL && Y < CELL) out[Y * CELL + X] = v;
  }
  return tidy(out);
}
/** Detail letters carried over by forward mapping, in drawing order (later ones win: the flash core over the flash). */
const DETAIL: readonly number[] = [..."flrstwx"].map((ch) => L[ch]!);

/**
 * The side outline: 1 for every empty pixel outside the figure touching it (8 neighbours; the muzzle flash
 * excluded). Gaps shut in by the figure get none (sprite fix 2026-11-15: they showed specks of the side colour
 * inside the body).
 */
export function outlineMask(g: Uint8Array): Uint8Array {
  const out = new Uint8Array(CELL * CELL), enc = enclosedMask(g);
  const solid = (x: number, y: number) => x >= 0 && y >= 0 && x < CELL && y < CELL && solidLetter(g[y * CELL + x]!);
  for (let y = 0; y < CELL; y++) for (let x = 0; x < CELL; x++) {
    if (g[y * CELL + x] !== 0 || enc[y * CELL + x]) continue;
    let k = false;
    for (let dy = -1; dy <= 1 && !k; dy++) for (let dx = -1; dx <= 1; dx++) if ((dx || dy) && solid(x + dx, y + dy)) { k = true; break; }
    if (k) out[y * CELL + x] = 1;
  }
  return out;
}

/**
 * The photo look's dark rim (sprite fix 2026-11-15): the ring of empty pixels just outside the side outline (`wide`:
 * two pixels deep, for small zooms), so it follows the figure's shape at every facing. It used to be the outline
 * drawn enlarged about the man's position, which slid off long lying figures and doubled their edges.
 */
export function rimMask(outline: Uint8Array, g: Uint8Array, wide: boolean): Uint8Array {
  const taken = new Uint8Array(CELL * CELL), out = new Uint8Array(CELL * CELL);
  for (let i = 0; i < taken.length; i++) taken[i] = g[i] !== 0 || outline[i] ? 1 : 0;
  let ring = outline;
  for (let step = 0; step < (wide ? 2 : 1); step++) {
    const next = new Uint8Array(CELL * CELL);
    for (let y = 0; y < CELL; y++) for (let x = 0; x < CELL; x++) {
      if (taken[y * CELL + x]) continue;
      let k = false;
      for (let dy = -1; dy <= 1 && !k; dy++) for (let dx = -1; dx <= 1; dx++) {
        const X = x + dx, Y = y + dy;
        if ((dx || dy) && X >= 0 && Y >= 0 && X < CELL && Y < CELL && ring[Y * CELL + X]) { k = true; break; }
      }
      if (k) next[y * CELL + x] = 1;
    }
    for (let i = 0; i < next.length; i++) if (next[i]) { out[i] = 1; taken[i] = 1; }
    ring = next;
  }
  return out;
}

const mix = (a: number, b: number, t: number) => {
  const ch = (s: number) => Math.round(((a >> s) & 255) * (1 - t) + ((b >> s) & 255) * t);
  return (ch(16) << 16) | (ch(8) << 8) | ch(0);
};

/** RGB per letter for a faction's look (palette swap); index 0 (transparent) unused. */
export function paletteFor(look: FactionLook): number[] {
  const u = look.uniform;
  return [0, u.base, u.dark, u.light, u.helmet, u.skin, mix(u.dark, 0x2e2a22, 0.45), 0x1c1d1a, mix(u.helmet, 0x2b3322, 0.5), 0xffd75a, 0xf6f2e4, 0x9c1a14];
}

/** Integer key of a frame (atlas lookup). */
const FRAME_IDS = Object.keys(FRAMES) as FrameId[];
const FRAME_INDEX = Object.fromEntries(FRAME_IDS.map((f, i) => [f, i])) as Record<FrameId, number>;
const WEAPONS: WeaponLook[] = ["rifle", "mg", "marksman"];
/** Distinct frame keys per palette slot: a faction's cells never share a key with another faction's. */
export const KEYS_PER_SLOT = FRAME_IDS.length * WEAPONS.length * 8 * FACINGS;
export function frameKey(k: FrameKey): number {
  return ((((FRAME_INDEX[k.frame] * 3 + WEAPONS.indexOf(k.weapon)) * 2 + +k.launcher) * 2 + +k.firing) * 2 + +k.wounded) * FACINGS + (k.facing & (FACINGS - 1));
}

/** Facing step (0..15) for a heading (radians, 0 = east, clockwise on screen). */
export function facingOf(heading: number): number {
  return ((Math.round(heading / (Math.PI / 8)) % FACINGS) + FACINGS) % FACINGS;
}

export interface SpriteCell { figure: Texture; outline: Texture; rim: Texture; rimWide: Texture }

/** Where cell `i` of the atlas sits (top-left pixel), for a texture `width` wide: cells `GUTTER` px apart. */
export function cellOrigin(i: number, width: number): { x: number; y: number } {
  const S = CELL + GUTTER, perRow = Math.floor(width / S);
  return { x: (i % perRow) * S + GUTTER / 2, y: Math.floor(i / perRow) * S + GUTTER / 2 };
}

/**
 * Lazily built cells for every faction in one RGBA texture: per (faction, frame key) a figure cell and an outline
 * cell beside it. The buffer grows (doubling its height) when full; the texture is re-uploaded once per frame at
 * most (`flush`).
 */
export class SoldierAtlas {
  private width = 32 * (CELL + GUTTER);
  private height = 12 * (CELL + GUTTER);
  private buf = new Uint8Array(this.width * this.height * 4);
  private source: BufferImageSource;
  private next = 0;
  private cells = new Map<number, SpriteCell>();
  private palettes: number[][] = [];
  private slots = new Map<string, number>();
  private dirty = false;

  constructor() { this.source = this.makeSource(); }

  private makeSource(): BufferImageSource {
    return new BufferImageSource({ resource: this.buf, width: this.width, height: this.height, format: "rgba8unorm", alphaMode: "premultiplied-alpha", scaleMode: "nearest" });
  }

  /** The palette slot of a faction (by its id: no faction is named in code). */
  slot(faction: string, look: FactionLook): number {
    let s = this.slots.get(faction);
    if (s === undefined) { s = this.palettes.length; this.palettes.push(paletteFor(look)); this.slots.set(faction, s); }
    return s;
  }

  get(slot: number, k: FrameKey): SpriteCell {
    // (Sprite fix 2026-11-15: the key was slot * 4096 + frameKey, but frameKey reaches past 4096, so a second
    // faction's standing men could be given the first faction's captive, carried or stretcher cells.)
    const key = slot * KEYS_PER_SLOT + frameKey(k);
    let c = this.cells.get(key);
    if (c) return c;
    const S = CELL + GUTTER;
    while ((this.next + 4) > Math.floor(this.width / S) * Math.floor(this.height / S)) this.grow();
    const g = rotateFrame(composeFrame(k), k.facing), o = outlineMask(g), pal = this.palettes[slot]!;
    const rim = rimMask(o, g, false), rimWide = rimMask(o, g, true);
    const i0 = this.next;
    this.next += 4;
    const put = (i: number, f: (x: number, y: number) => number) => {
      const { x: cx, y: cy } = cellOrigin(i, this.width);
      for (let y = 0; y < CELL; y++) for (let x = 0; x < CELL; x++) {
        const rgb = f(x, y), p = ((cy + y) * this.width + cx + x) * 4;
        if (rgb < 0) { this.buf[p] = this.buf[p + 1] = this.buf[p + 2] = this.buf[p + 3] = 0; continue; }
        this.buf[p] = (rgb >> 16) & 255; this.buf[p + 1] = (rgb >> 8) & 255; this.buf[p + 2] = rgb & 255; this.buf[p + 3] = 255;
      }
      return new Rectangle(cx, cy, CELL, CELL);
    };
    const tex = (frame: Rectangle) => new Texture({ source: this.source, frame });
    const mask = (m: Uint8Array) => (x: number, y: number) => (m[y * CELL + x] ? 0xffffff : -1);
    c = {
      figure: tex(put(i0, (x, y) => { const l = g[y * CELL + x]!; return l === 0 ? -1 : pal[l]!; })),
      outline: tex(put(i0 + 1, mask(o))), rim: tex(put(i0 + 2, mask(rim))), rimWide: tex(put(i0 + 3, mask(rimWide))),
    };
    this.cells.set(key, c);
    this.dirty = true;
    return c;
  }

  /** Upload new cells (once per frame). */
  flush(): void {
    if (!this.dirty) return;
    this.dirty = false;
    this.source.update();
  }

  private grow(): void {
    const old = this.buf, oh = this.height;
    this.height *= 2;
    this.buf = new Uint8Array(this.width * this.height * 4);
    this.buf.set(old.subarray(0, this.width * oh * 4));
    const src = this.makeSource();
    // Existing textures move to the new source (same frames).
    for (const c of this.cells.values()) for (const t of [c.figure, c.outline, c.rim, c.rimWide]) t.source = src;
    this.source.destroy();
    this.source = src;
  }

  /** How many cells are built (tests). */
  get size(): number { return this.cells.size; }
}
