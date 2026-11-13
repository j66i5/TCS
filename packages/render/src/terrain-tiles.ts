/**
 * The terrain picture as a pyramid of tiles (plan "photo" decision 5), shared by the flat look and the photo look:
 * - the whole map once (L0, about 1 px/m): for the photo look the flat picture shows at once and the photo L0 is
 *   painted in four horizontal strips that replace it as they land;
 * - detail levels of 256 px tiles (flat: 64 m at 4 px/m from the figure zoom; photo: 128 m at 2, 64 m at 4 and, on
 *   capable devices, 32 m at 8 px/m, chosen by screen pixels per metre);
 * - the contour layer (zoomed out) and the close contour tiles of the top-bar toggle (S14).
 * Tiles are painted by a `TileSource`: in plain JavaScript on this thread (flat; tests) or in workers (photo). A
 * `TileQueue` keeps the order (centre first), the cancels and the upload cap. One least-recently-used cache over all
 * levels with a byte budget. The coarser picture stays below a missing tile, so there are no holes.
 */
import { BufferImageSource, Container, Sprite, Texture } from "pixi.js";
import type { MapDef } from "@tcs/sim";
import { CLOSE_CONTOUR_SCALE, CONTOUR_CLOSE_INK, TILE_CACHE, TILE_M, TILE_PPM, paintContours } from "./flat/paint";
import { TileQueue, type TileJob } from "./tile-queue";
import type { PhotoInit } from "./photo/paint";
import type { PhotoReply, PhotoRequest } from "./photo/worker";

export interface TerrainLevel { tileM: number; ppm: number; /** Shown from this many screen px per metre (x device ratio). */ minPx: number }

export interface TerrainTilesOptions {
  /** Detail levels, coarse to fine (level 1, 2, ...). */
  levels: TerrainLevel[];
  sampling: "nearest" | "linear";
  /** Mipmaps on the whole-map picture (the only one shown shrunk: detail tiles are shown at or above their size). */
  mipmaps: boolean;
  budgetBytes: number;
  /** New tiles fade in over this many frames (0: at once). */
  fadeFrames: number;
  /** Device pixel ratio the canvas renders at (at most 2). */
  dpr: number;
  /** Finest detail level used (phones stop at L2). */
  maxLevel: number;
  /** Choose the detail level by the renderer's zoom band ("detail" flag; the flat look) or by screen px per m. */
  byBand: boolean;
  /** The photo L0: painted in this many strips over the placeholder (0: none). */
  strips: number;
  stripPpm: number;
  maxInFlight: number;
  maxUploads: number;
}

/** Paints queued tiles. */
export interface TileSource {
  pump(q: TileQueue): void;
  /** True once it cannot paint any more (a worker failed to load): the tiles fall back to painting here. */
  failed(): boolean;
  destroy(): void;
}

/** Paints on this thread, `perFrame` tiles a frame. */
export class SyncSource implements TileSource {
  constructor(private paint: (j: TileJob) => Uint8Array, private perFrame = 1) {}
  pump(q: TileQueue): void {
    for (let n = 0; n < this.perFrame; n++) { const j = q.next(); if (!j) return; q.done(j, this.paint(j)); }
  }
  failed(): boolean { return false; }
  destroy(): void { /* nothing held */ }
}

/** Paints in workers (at most two tiles queued per worker). */
export class WorkerSource implements TileSource {
  private workers: Worker[] = [];
  private busy: number[] = [];
  private jobs = new Map<number, { job: TileJob; w: number }>();
  private seq = 0;
  private broken = false;
  constructor(make: () => Worker, n: number, init: PhotoInit, private q: TileQueue) {
    for (let i = 0; i < n; i++) {
      const w = make();
      w.onmessage = (e: MessageEvent<PhotoReply>) => this.reply(e.data);
      w.onerror = () => this.fail();
      w.postMessage({ type: "init", init } satisfies PhotoRequest);
      this.workers.push(w); this.busy.push(0);
    }
  }
  private reply(r: PhotoReply): void {
    const j = this.jobs.get(r.id);
    if (!j) return;
    this.jobs.delete(r.id);
    this.busy[j.w]!--;
    if (r.data) this.q.done(j.job, new Uint8Array(r.data)); else { this.q.fail(j.job); if (r.error) console.warn(r.error); }
  }
  private fail(): void {
    this.broken = true;
    for (const j of this.jobs.values()) this.q.fail(j.job);
    this.jobs.clear();
  }
  pump(q: TileQueue): void {
    if (this.broken) return;
    for (;;) {
      let w = 0;
      for (let i = 1; i < this.workers.length; i++) if (this.busy[i]! < this.busy[w]!) w = i;
      if (this.busy[w]! >= 2) return;
      const job = q.next();
      if (!job) return;
      const id = ++this.seq;
      this.jobs.set(id, { job, w });
      this.busy[w]!++;
      this.workers[w]!.postMessage({ type: "tile", id, x0: job.x0, y0: job.y0, w: job.w, h: job.h, ppm: job.ppm } satisfies PhotoRequest);
    }
  }
  failed(): boolean { return this.broken; }
  destroy(): void { for (const w of this.workers) w.terminate(); this.workers = []; }
}

const texOf = (data: Uint8Array, width: number, height: number, mode: "nearest" | "linear", mip = false) =>
  new Texture({ source: new BufferImageSource({ resource: data, width, height, format: "rgba8unorm", alphaMode: "premultiplied-alpha", scaleMode: mode, autoGenerateMipmaps: mip }) });

/** Base resolution for a map: about 1 px/m, at most 2048 px a side. */
export const basePpm = (map: MapDef) => Math.min(1, 2048 / Math.max(map.widthM, map.heightM));
/** The photo L0 resolution: 1 px/m, 0.75 above 1600 m (plan decision 5), at most 2048 px a side. */
export const photoBasePpm = (map: MapDef) => Math.min(Math.max(map.widthM, map.heightM) > 1600 ? 0.75 : 1, 2048 / Math.max(map.widthM, map.heightM));

interface Tile { sprite: Sprite; used: number; level: number; bytes: number }
type View = { x: number; y: number; w: number; h: number };

export class TerrainTiles {
  readonly root = new Container();
  readonly base: Sprite;
  readonly contours: Sprite;
  private strips = new Container();
  private levelLayers: Container[] = [];
  private cache = new Map<string, Tile>();
  private bytes = 0;
  private fading: Sprite[] = [];
  private ctiles = new Container();
  private ccache = new Map<string, { sprite: Sprite; used: number }>();
  private frame = 0;
  private ppm: number;
  private q: TileQueue;
  private stripsLeft: number;
  private burst = false;
  private primes: { jobs: TileJob[]; resolve: () => void }[] = [];
  private level = 0;

  constructor(private map: MapDef, base: Uint8Array, private paint: (j: TileJob) => Uint8Array, private source: TileSource | null, private o: TerrainTilesOptions, q?: TileQueue) {
    this.ppm = basePpm(map);
    const W = Math.round(map.widthM * this.ppm), H = Math.round(map.heightM * this.ppm);
    this.base = new Sprite(texOf(base, W, H, o.sampling, o.mipmaps));
    this.base.width = map.widthM; this.base.height = map.heightM;
    this.contours = new Sprite(texOf(paintContours(map, this.ppm), W, H, "linear"));
    this.contours.width = map.widthM; this.contours.height = map.heightM;
    for (let i = 0; i < o.levels.length; i++) this.levelLayers.push(new Container());
    this.root.addChild(this.base, this.strips, ...this.levelLayers, this.contours, this.ctiles);
    this.q = q ?? new TileQueue(o.maxInFlight, o.maxUploads);
    this.q.onDone = () => this.checkPrimes();
    this.source ??= new SyncSource(paint);
    this.stripsLeft = o.strips;
    if (o.strips > 0) this.q.add(this.stripJobs());
  }

  /** Tile queue (tests). */
  get queue(): TileQueue { return this.q; }
  /** Detail level shown last (0: whole map only). */
  get shownLevel(): number { return this.level; }

  /** Tiles still to paint or upload (the screenshot tool waits for 0). */
  pending(): number { return this.q.pending(); }

  private stripJobs(): TileJob[] {
    const ppm = this.o.stripPpm, Hp = Math.round(this.map.heightM * ppm), n = this.o.strips, out: TileJob[] = [];
    for (let s = 0; s < n; s++) {
      const r0 = Math.round((Hp * s) / n), r1 = Math.round((Hp * (s + 1)) / n);
      out.push({ key: `s${s}`, level: 0, x0: 0, y0: r0 / ppm, w: this.map.widthM, h: (r1 - r0) / ppm, ppm, prio: -1e9 + s });
    }
    return out;
  }

  /** The detail level for a zoom: by band (flat) or by screen px per metre (photo). */
  levelFor(scale: number, detail: boolean): number {
    if (this.o.byBand) return detail ? Math.min(1, this.o.levels.length) : 0;
    const px = scale * this.o.dpr;
    let lv = 0;
    for (let i = 0; i < this.o.levels.length && i < this.o.maxLevel; i++) if (px >= this.o.levels[i]!.minPx) lv = i + 1;
    return lv;
  }

  private tileRange(view: View, L: TerrainLevel) {
    const tm = L.tileM;
    return {
      tx0: Math.max(0, Math.floor(view.x / tm)), ty0: Math.max(0, Math.floor(view.y / tm)),
      tx1: Math.min(Math.ceil(this.map.widthM / tm) - 1, Math.floor((view.x + view.w) / tm)),
      ty1: Math.min(Math.ceil(this.map.heightM / tm) - 1, Math.floor((view.y + view.h) / tm)),
    };
  }

  private job(lv: number, tx: number, ty: number, cx: number, cy: number): TileJob {
    const L = this.o.levels[lv - 1]!, x = tx * L.tileM, y = ty * L.tileM;
    const w = Math.min(L.tileM, this.map.widthM - x), h = Math.min(L.tileM, this.map.heightM - y);
    const prio = Math.hypot(x + w / 2 - cx, y + h / 2 - cy) / L.tileM - lv * 0.01;
    return { key: `${lv}:${tx},${ty}`, level: lv, x0: x, y0: y, w, h, ppm: L.ppm, prio };
  }

  /**
   * Per frame: base sampling (flat: nearest when enlarged), contours only zoomed out, detail tiles over the view at
   * the level for this zoom (requested centre first; uploads capped), coarser tiles kept under missing ones.
   */
  update(view: View, scale: number, detail: boolean, contours: boolean, closeContours = false): void {
    this.frame++;
    if (this.source?.failed()) { this.source.destroy(); this.source = new SyncSource(this.paint); }
    if (this.o.sampling === "nearest") {
      const mode = scale >= this.ppm ? "nearest" : "linear";
      if (this.base.texture.source.scaleMode !== mode) this.base.texture.source.scaleMode = mode;
    }
    const close = closeContours && scale >= CLOSE_CONTOUR_SCALE;
    this.contours.visible = contours && !close;
    this.ctiles.visible = close;
    if (close) this.updateContourTiles(view);
    const lv = this.levelFor(scale, detail);
    this.level = lv;
    // Wanted: the strips not yet in, and the missing tiles of this level over the view.
    const jobs: TileJob[] = [];
    if (this.stripsLeft > 0) for (const j of this.stripJobs()) if (!this.cache.has(j.key)) jobs.push(j);
    const cx = view.x + view.w / 2, cy = view.y + view.h / 2;
    for (const t of this.cache.values()) if (t.level >= 1) t.sprite.visible = false;
    let missing = false;
    if (lv >= 1) {
      const r = this.tileRange(view, this.o.levels[lv - 1]!);
      for (let ty = r.ty0; ty <= r.ty1; ty++) for (let tx = r.tx0; tx <= r.tx1; tx++) {
        const t = this.cache.get(`${lv}:${tx},${ty}`);
        if (t) { t.sprite.visible = true; t.used = this.frame; if (t.sprite.alpha < 1) missing = true; continue; }
        missing = true;
        jobs.push(this.job(lv, tx, ty, cx, cy));
      }
    }
    for (const p of this.primes) for (const j of p.jobs) if (!this.cache.has(j.key)) jobs.push(j);
    this.q.want(jobs);
    this.source!.pump(this.q);
    for (const t of this.q.take(this.burst ? Infinity : this.o.maxUploads)) this.upload(t.job, t.data);
    this.burst = false;
    // The whole map is not drawn under a complete detail level (less overdraw; photo only, flat stays as it was).
    const covered = lv >= 1 && !missing && !this.o.byBand;
    this.strips.visible = !covered;
    this.base.visible = !covered && (this.o.strips === 0 || this.stripsLeft > 0);
    // Coarser tiles stay under a level that is not complete yet.
    if (missing) {
      for (let l = lv - 1; l >= 1; l--) {
        const r = this.tileRange(view, this.o.levels[l - 1]!);
        for (let ty = r.ty0; ty <= r.ty1; ty++) for (let tx = r.tx0; tx <= r.tx1; tx++) {
          const t = this.cache.get(`${l}:${tx},${ty}`);
          if (t) { t.sprite.visible = true; t.used = this.frame; }
        }
      }
    }
    // Fade in.
    if (this.fading.length) {
      const step = this.o.fadeFrames > 0 ? 1 / this.o.fadeFrames : 1;
      this.fading = this.fading.filter((s) => { if (s.destroyed) return false; s.alpha = Math.min(1, s.alpha + step); return s.alpha < 1; });
    }
    this.evict();
  }

  private upload(job: TileJob, data: Uint8Array): void {
    const W = Math.round(job.w * job.ppm), H = Math.round(job.h * job.ppm);
    if (this.cache.has(job.key)) return;
    const s = new Sprite(texOf(data, W, H, job.level === 0 ? "linear" : this.o.sampling, this.o.mipmaps && job.level === 0));
    s.position.set(job.x0, job.y0); s.width = job.w; s.height = job.h;
    const bytes = W * H * 4;
    if (job.level === 0) {
      this.strips.addChild(s);
      this.stripsLeft--;
      // (When all strips are in, the placeholder below them is no longer drawn: see update.)
    } else {
      this.levelLayers[job.level - 1]!.addChild(s);
      this.bytes += bytes;
    }
    this.cache.set(job.key, { sprite: s, used: this.frame, level: job.level, bytes: job.level === 0 ? 0 : bytes });
    if (this.o.fadeFrames > 0 && job.level > 0) { s.alpha = 0; this.fading.push(s); }
    this.checkPrimes();
  }

  /** Resolve the primes whose tiles are all painted (uploaded, or waiting for the next frame's upload). */
  private checkPrimes(): void {
    if (this.primes.length === 0) return;
    this.primes = this.primes.filter((p) => {
      if (p.jobs.some((j) => !this.cache.has(j.key) && !this.q.isReady(j.key))) return true;
      p.resolve();
      return false;
    });
  }

  /** Over budget: drop the least recently used detail tiles not shown this frame. */
  private evict(): void {
    if (this.bytes <= this.o.budgetBytes) return;
    const old = [...this.cache.entries()].filter(([, t]) => t.level >= 1 && t.used < this.frame).sort((a, b) => a[1].used - b[1].used);
    for (const [k, t] of old) {
      if (this.bytes <= this.o.budgetBytes) break;
      t.sprite.parent?.removeChild(t.sprite);
      t.sprite.destroy({ texture: true, textureSource: true });
      this.cache.delete(k);
      this.bytes -= t.bytes;
    }
  }

  /**
   * Paint the tiles over an area now (the opening view, so the first picture is complete). Painting here: done
   * when it returns. Workers: resolves when they have all been painted (the next frame uploads them all).
   */
  prime(view: View, scale: number, detail: boolean): Promise<void> {
    const lv = this.levelFor(scale, detail);
    if (lv < 1) return Promise.resolve();
    const r = this.tileRange(view, this.o.levels[lv - 1]!), cx = view.x + view.w / 2, cy = view.y + view.h / 2;
    const jobs: TileJob[] = [];
    for (let ty = r.ty0; ty <= r.ty1; ty++) for (let tx = r.tx0; tx <= r.tx1; tx++) if (!this.cache.has(`${lv}:${tx},${ty}`)) jobs.push(this.job(lv, tx, ty, cx, cy));
    if (this.source instanceof SyncSource) {
      for (const j of jobs) { this.upload(j, this.paint(j)); this.cache.get(j.key)!.sprite.alpha = 1; }
      this.fading = this.fading.filter((s) => s.alpha < 1);
      return Promise.resolve();
    }
    this.q.add(jobs);
    this.source!.pump(this.q);
    // A newer prime (the view moved on) releases the older ones: their callers show what there is.
    for (const p of this.primes.splice(0)) p.resolve();
    return new Promise((resolve) => {
      this.primes.push({ jobs, resolve: () => { this.burst = true; resolve(); } });
    });
  }

  /** S14 close contour tiles: built here, one per frame, nearest the centre first (as before the pyramid). */
  private updateContourTiles(view: View): void {
    const tx0 = Math.max(0, Math.floor(view.x / TILE_M)), ty0 = Math.max(0, Math.floor(view.y / TILE_M));
    const tx1 = Math.min(Math.ceil(this.map.widthM / TILE_M) - 1, Math.floor((view.x + view.w) / TILE_M));
    const ty1 = Math.min(Math.ceil(this.map.heightM / TILE_M) - 1, Math.floor((view.y + view.h) / TILE_M));
    for (const t of this.ccache.values()) t.sprite.visible = false;
    let want: { k: string; tx: number; ty: number; d: number } | null = null;
    const cx = view.x + view.w / 2, cy = view.y + view.h / 2;
    for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) {
      const k = `${tx},${ty}`, t = this.ccache.get(k);
      if (t) { t.sprite.visible = true; t.used = this.frame; continue; }
      const d = ((tx + 0.5) * TILE_M - cx) ** 2 + ((ty + 0.5) * TILE_M - cy) ** 2;
      if (!want || d < want.d) want = { k, tx, ty, d };
    }
    if (!want) return;
    const x = want.tx * TILE_M, y = want.ty * TILE_M, w = Math.min(TILE_M, this.map.widthM - x), h = Math.min(TILE_M, this.map.heightM - y);
    const s = new Sprite(texOf(paintContours(this.map, TILE_PPM, x, y, w, h, CONTOUR_CLOSE_INK, [0.45, 0.8], true), Math.round(w * TILE_PPM), Math.round(h * TILE_PPM), "nearest"));
    s.position.set(x, y); s.width = w; s.height = h;
    this.ctiles.addChild(s);
    this.ccache.set(want.k, { sprite: s, used: this.frame });
    if (this.ccache.size > TILE_CACHE) {
      let old: string | null = null, oldest = Infinity;
      for (const [kk, t] of this.ccache) if (t.used < oldest && kk !== want.k) { oldest = t.used; old = kk; }
      if (old !== null) { const t = this.ccache.get(old)!; this.ctiles.removeChild(t.sprite); t.sprite.destroy({ texture: true, textureSource: true }); this.ccache.delete(old); }
    }
  }

  destroy(): void { this.source?.destroy(); this.root.destroy({ children: true, texture: true, textureSource: true }); }
}
