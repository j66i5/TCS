/**
 * Soldier sprite atlas (M7.5b, plan m7.5 §4). Pure part: compose a frame from the art (`soldier-art.ts`) with its
 * weapon variant, launcher, muzzle flash and wound marks; turn it to one of 16 facings (pre-rotated pixel art: the
 * picture is enlarged 4x with Scale2x twice and sampled back, so a rotated man keeps clean pixels); the side
 * outline (1-px mask around the figure, tinted blue or red by the renderer); the faction's palette swap.
 * Pixi part: `SoldierAtlas` builds cells lazily into one RGBA buffer texture (nearest sampling).
 */
import { BufferImageSource, Rectangle, Texture } from "pixi.js";
import type { FactionLook } from "@tcs/data";
import { ARMED, ART, FRAMES, LYING, WOUND_MARKS, type FrameId } from "./soldier-art";

/** Atlas cell: the 16-px art with a 3-px margin (muzzle flash, longer weapons, outline, turning). */
export const CELL = 22;
const PAD = 3;
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
  if (k.launcher && k.frame !== "down" && k.frame !== "dead") {
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

/** The cell turned clockwise (screen, y down) by facing * 22.5 degrees about the pivot. */
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
  return out;
}

/** The side outline: 1 for every empty pixel touching the figure (8 neighbours; the muzzle flash excluded). */
export function outlineMask(g: Uint8Array): Uint8Array {
  const out = new Uint8Array(CELL * CELL);
  const solid = (x: number, y: number) => x >= 0 && y >= 0 && x < CELL && y < CELL && g[y * CELL + x] !== 0 && g[y * CELL + x] !== L.f && g[y * CELL + x] !== L.x;
  for (let y = 0; y < CELL; y++) for (let x = 0; x < CELL; x++) {
    if (g[y * CELL + x] !== 0) continue;
    let k = false;
    for (let dy = -1; dy <= 1 && !k; dy++) for (let dx = -1; dx <= 1; dx++) if ((dx || dy) && solid(x + dx, y + dy)) { k = true; break; }
    if (k) out[y * CELL + x] = 1;
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
export function frameKey(k: FrameKey): number {
  return ((((FRAME_INDEX[k.frame] * 3 + WEAPONS.indexOf(k.weapon)) * 2 + +k.launcher) * 2 + +k.firing) * 2 + +k.wounded) * FACINGS + (k.facing & (FACINGS - 1));
}

/** Facing step (0..15) for a heading (radians, 0 = east, clockwise on screen). */
export function facingOf(heading: number): number {
  return ((Math.round(heading / (Math.PI / 8)) % FACINGS) + FACINGS) % FACINGS;
}

export interface SpriteCell { figure: Texture; outline: Texture }

/**
 * Lazily built cells for every faction in one RGBA texture: per (faction, frame key) a figure cell and an outline
 * cell beside it. The buffer grows (doubling its height) when full; the texture is re-uploaded once per frame at
 * most (`flush`).
 */
export class SoldierAtlas {
  private width = 1012; // 46 cells
  private height = 264; // 12 rows
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
    const key = slot * 4096 + frameKey(k);
    let c = this.cells.get(key);
    if (c) return c;
    const perRow = Math.floor(this.width / CELL);
    if ((this.next + 2) > perRow * Math.floor(this.height / CELL)) this.grow();
    const g = rotateFrame(composeFrame(k), k.facing), o = outlineMask(g), pal = this.palettes[slot]!;
    const i0 = this.next, i1 = this.next + 1;
    this.next += 2;
    const put = (i: number, f: (x: number, y: number) => number) => {
      const cx = (i % perRow) * CELL, cy = Math.floor(i / perRow) * CELL;
      for (let y = 0; y < CELL; y++) for (let x = 0; x < CELL; x++) {
        const rgb = f(x, y), p = ((cy + y) * this.width + cx + x) * 4;
        if (rgb < 0) { this.buf[p] = this.buf[p + 1] = this.buf[p + 2] = this.buf[p + 3] = 0; continue; }
        this.buf[p] = (rgb >> 16) & 255; this.buf[p + 1] = (rgb >> 8) & 255; this.buf[p + 2] = rgb & 255; this.buf[p + 3] = 255;
      }
      return new Rectangle(cx, cy, CELL, CELL);
    };
    const r0 = put(i0, (x, y) => { const l = g[y * CELL + x]!; return l === 0 ? -1 : pal[l]!; });
    const r1 = put(i1, (x, y) => (o[y * CELL + x] ? 0xffffff : -1));
    c = { figure: new Texture({ source: this.source, frame: r0 }), outline: new Texture({ source: this.source, frame: r1 }) };
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
    for (const c of this.cells.values()) { c.figure.source = src; c.outline.source = src; }
    this.source.destroy();
    this.source = src;
  }

  /** How many cells are built (tests). */
  get size(): number { return this.cells.size; }
}
