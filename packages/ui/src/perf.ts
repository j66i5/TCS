/**
 * D3 phone pass: a frame recorder for the `?perf=1` read-out and `__tcs.perf()`.
 *
 * A ring buffer of the last frames, one fixed Float64Array per channel (no allocation per frame). The app stamps
 * `performance.now()` round each part of its frame and records one sample; `stats(windowS)` gives p50 / p95 / max per
 * channel over the last `windowS` seconds, the share of frames over 33 ms and the game time lost to the frame clamp.
 * Pure (no DOM, no clock): the caller passes the times. Nothing here reaches the simulation.
 */

/** The timed parts of a frame, in ms (`steps`: simulation steps run that frame). */
export const PERF_CHANNELS = ["frame", "sim", "know", "ui", "draw", "gpu", "steps"] as const;
export type PerfChannel = (typeof PERF_CHANNELS)[number];

export interface PerfSample {
  /** When the frame began (ms, any monotonic clock). */
  at: number;
  /** Time since the previous frame began (the rAF interval). */
  frame: number;
  /** The stepping loop: AI, capturePrevious, step, events. */
  sim: number;
  /** The player's side's knowledge (fog of war). */
  know: number;
  /** Overlays, pins, orders, tiles, floors, follow, card and HUD. */
  ui: number;
  /** `renderer.draw` (the scene graph). */
  draw: number;
  /** Pixi's `app.render` (CPU side of the GPU submit). */
  gpu: number;
  steps: number;
  /** Game time lost to the frame clamp this frame (ms). */
  dropped: number;
}

export interface PerfSpread { p50: number; p95: number; max: number; avg: number }

export interface PerfStats {
  /** The window asked for, and the span the frames in it actually cover (s). */
  windowS: number;
  spanS: number;
  frames: number;
  frame: PerfSpread; sim: PerfSpread; know: PerfSpread; ui: PerfSpread; draw: PerfSpread; gpu: PerfSpread; steps: PerfSpread;
  /** Share of frames (0..1) with an interval over 33 ms (under 30 fps). */
  over33: number;
  /** Game time lost to the clamp over the window (ms). */
  droppedMs: number;
}

/** Frame intervals above this count as slow (30 fps, the D3 acceptance). */
export const SLOW_FRAME_MS = 33.4;

/** The nearest-rank percentile of an ascending array (0 for an empty one). */
export function percentile(sorted: ArrayLike<number>, p: number): number {
  const n = sorted.length;
  if (n === 0) return 0;
  const i = Math.min(n - 1, Math.max(0, Math.ceil(p * n) - 1));
  return sorted[i]!;
}

const round = (v: number): number => Math.round(v * 100) / 100;

export class FrameRecorder {
  readonly capacity: number;
  private readonly cols: Record<PerfChannel | "at" | "dropped", Float64Array>;
  /** Next slot to write; `count` slots hold samples (at most `capacity`). */
  private head = 0;
  private count = 0;

  /** 1200 slots: 10 s at 120 fps, 20 s at 60. */
  constructor(capacity = 1200) {
    this.capacity = Math.max(1, Math.floor(capacity));
    const mk = () => new Float64Array(this.capacity);
    this.cols = { at: mk(), frame: mk(), sim: mk(), know: mk(), ui: mk(), draw: mk(), gpu: mk(), steps: mk(), dropped: mk() };
  }

  get size(): number { return this.count; }

  record(s: PerfSample): void {
    const i = this.head, c = this.cols;
    c.at[i] = s.at; c.frame[i] = s.frame; c.sim[i] = s.sim; c.know[i] = s.know; c.ui[i] = s.ui;
    c.draw[i] = s.draw; c.gpu[i] = s.gpu; c.steps[i] = s.steps; c.dropped[i] = s.dropped;
    this.head = (i + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
  }

  reset(): void { this.head = 0; this.count = 0; }

  /** Slot indices of the samples within `windowS` seconds of the newest one, oldest first. */
  private windowSlots(windowS: number): number[] {
    const out: number[] = [];
    if (this.count === 0) return out;
    const newest = (this.head - 1 + this.capacity) % this.capacity;
    const from = this.cols.at[newest]! - windowS * 1000;
    for (let k = 0; k < this.count; k++) {
      const i = (newest - k + this.capacity) % this.capacity;
      if (this.cols.at[i]! < from) break;
      out.push(i);
    }
    return out.reverse();
  }

  stats(windowS = 5): PerfStats {
    const slots = this.windowSlots(windowS);
    const n = slots.length;
    const spread = (ch: PerfChannel): PerfSpread => {
      const col = this.cols[ch];
      const v = new Float64Array(n);
      let sum = 0;
      for (let k = 0; k < n; k++) { v[k] = col[slots[k]!]!; sum += v[k]!; }
      v.sort();
      return { p50: round(percentile(v, 0.5)), p95: round(percentile(v, 0.95)), max: round(n ? v[n - 1]! : 0), avg: round(n ? sum / n : 0) };
    };
    let slow = 0, dropped = 0;
    for (const i of slots) { if (this.cols.frame[i]! > SLOW_FRAME_MS) slow++; dropped += this.cols.dropped[i]!; }
    const spanS = n < 2 ? 0 : (this.cols.at[slots[n - 1]!]! - this.cols.at[slots[0]!]!) / 1000;
    return {
      windowS, spanS: round(spanS), frames: n,
      frame: spread("frame"), sim: spread("sim"), know: spread("know"), ui: spread("ui"), draw: spread("draw"), gpu: spread("gpu"), steps: spread("steps"),
      over33: round(n ? slow / n : 0), droppedMs: round(dropped),
    };
  }
}

/** One line of the read-out: "label p50/p95/max". */
export function perfLine(label: string, s: PerfSpread, digits = 1): string {
  return `${label.padEnd(6)} ${s.p50.toFixed(digits)}/${s.p95.toFixed(digits)}/${s.max.toFixed(digits)}`;
}
