/**
 * The terrain tile queue (plan "photo" decision 6): which tiles are wanted, which are being painted, which are
 * painted and wait for upload. Pure (no Pixi, no DOM, no clock), so its rules are unit-tested with a fake worker:
 * - the wanted list is replaced every frame; a queued tile that left the view is dropped (cancelled);
 * - the tile with the lowest priority number goes first (distance from the view centre; finer levels first);
 * - at most `maxInFlight` tiles are being painted at once;
 * - at most `maxUploads` painted tiles are handed out per frame (texture uploads).
 */
export interface TileJob {
  key: string;
  level: number;
  x0: number; y0: number; w: number; h: number; ppm: number;
  /** Lower goes first. */
  prio: number;
}

export interface PaintedTile { job: TileJob; data: Uint8Array }

export class TileQueue {
  private wanted = new Map<string, TileJob>();
  private flying = new Map<string, TileJob>();
  private ready: PaintedTile[] = [];
  private readyKeys = new Set<string>();
  /** Tiles dropped from the queue before painting (for tests and the debug count). */
  cancelled = 0;
  /** Called after every painted tile (a prime waiting for its tiles). */
  onDone: (() => void) | null = null;

  constructor(public maxInFlight: number, public maxUploads: number) {}

  /** Replace the wanted list (tiles already painting or painted are kept and not asked for again). */
  want(jobs: readonly TileJob[]): void {
    const next = new Map<string, TileJob>();
    for (const j of jobs) if (!this.flying.has(j.key) && !this.readyKeys.has(j.key)) next.set(j.key, j);
    for (const k of this.wanted.keys()) if (!next.has(k)) this.cancelled++;
    this.wanted = next;
  }

  /** Add jobs to the wanted list without dropping the others (map-load strips, the opening view). */
  add(jobs: readonly TileJob[]): void {
    for (const j of jobs) if (!this.flying.has(j.key) && !this.readyKeys.has(j.key)) this.wanted.set(j.key, j);
  }

  /** The next tile to paint (lowest priority number; ties by key), now in flight; null when none or too many fly. */
  next(): TileJob | null {
    if (this.flying.size >= this.maxInFlight) return null;
    let best: TileJob | null = null;
    for (const j of this.wanted.values()) if (!best || j.prio < best.prio || (j.prio === best.prio && j.key < best.key)) best = j;
    if (!best) return null;
    this.wanted.delete(best.key);
    this.flying.set(best.key, best);
    return best;
  }

  /** A painted tile came back. */
  done(job: TileJob, data: Uint8Array): void {
    if (!this.flying.delete(job.key)) return;
    this.ready.push({ job, data });
    this.readyKeys.add(job.key);
    this.onDone?.();
  }

  /** A paint failed: forget it (it is asked for again while wanted). */
  fail(job: TileJob): void { this.flying.delete(job.key); }

  /** Painted tiles for upload this frame, coarse levels and high priority first; at most `max` (default the cap). */
  take(max = this.maxUploads): PaintedTile[] {
    if (this.ready.length === 0) return [];
    this.ready.sort((a, b) => a.job.prio - b.job.prio || (a.job.key < b.job.key ? -1 : a.job.key > b.job.key ? 1 : 0));
    const out = this.ready.splice(0, max);
    for (const t of out) this.readyKeys.delete(t.job.key);
    return out;
  }

  isFlying(key: string): boolean { return this.flying.has(key); }
  isReady(key: string): boolean { return this.readyKeys.has(key); }
  /** Wanted, painting, or painted and not yet uploaded. */
  pending(): number { return this.wanted.size + this.flying.size + this.ready.length; }
  inFlight(): number { return this.flying.size; }
  /** Whether any of these keys is still wanted, painting or waiting for upload. */
  anyPending(keys: Iterable<string>): boolean {
    for (const k of keys) if (this.wanted.has(k) || this.flying.has(k) || this.readyKeys.has(k)) return true;
    return false;
  }
}
