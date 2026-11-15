import { describe, expect, it } from "vitest";
import { FrameRecorder, percentile, type PerfSample } from "../src/perf";

const sample = (at: number, frame: number, o: Partial<PerfSample> = {}): PerfSample =>
  ({ at, frame, sim: 0, know: 0, ui: 0, draw: 0, gpu: 0, steps: 1, dropped: 0, ...o });

describe("D3 frame recorder", () => {
  it("nearest-rank percentiles", () => {
    const v = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(v, 0.5)).toBe(50);
    expect(percentile(v, 0.95)).toBe(95);
    expect(percentile(v, 1)).toBe(100);
    expect(percentile([7], 0.95)).toBe(7);
    expect(percentile([], 0.5)).toBe(0);
  });

  it("p50 / p95 / max / avg per channel and the share over 33 ms", () => {
    const r = new FrameRecorder();
    // 100 frames 16.7 ms apart: 90 fast ones, 10 at 50 ms.
    for (let i = 0; i < 100; i++) r.record(sample(i * 16.7, i < 90 ? 16.7 : 50, { sim: i, steps: i % 2 === 0 ? 1 : 3, dropped: i === 99 ? 12 : 0 }));
    const s = r.stats(10);
    expect(s.frames).toBe(100);
    expect(s.frame.p50).toBe(16.7);
    expect(s.frame.p95).toBe(50);
    expect(s.frame.max).toBe(50);
    expect(s.over33).toBe(0.1);
    expect(s.sim.p50).toBe(49);
    expect(s.sim.max).toBe(99);
    expect(s.steps.avg).toBe(2);
    expect(s.steps.max).toBe(3);
    expect(s.droppedMs).toBe(12);
    expect(s.spanS).toBeCloseTo(99 * 0.0167, 2);
  });

  it("the window counts back from the newest frame", () => {
    const r = new FrameRecorder();
    for (let i = 0; i < 600; i++) r.record(sample(i * 20, i < 300 ? 100 : 20)); // 12 s: slow first half
    const last5 = r.stats(5);
    expect(last5.frames).toBe(251); // 5000 ms / 20 ms, both ends
    expect(last5.frame.max).toBe(20);
    expect(last5.over33).toBe(0);
    expect(r.stats(1e9).frames).toBe(600);
    expect(r.stats(1e9).frame.max).toBe(100);
  });

  it("the ring keeps only the newest `capacity` frames", () => {
    const r = new FrameRecorder(10);
    for (let i = 0; i < 25; i++) r.record(sample(i, i));
    expect(r.size).toBe(10);
    const s = r.stats(1e9);
    expect(s.frames).toBe(10);
    expect(s.frame.max).toBe(24);
    expect(s.frame.p50).toBe(19); // 15..24
    expect(s.spanS).toBe(0.01); // 9 ms, rounded to 0.01 s
  });

  it("reset empties it", () => {
    const r = new FrameRecorder(8);
    for (let i = 0; i < 5; i++) r.record(sample(i * 16, 40));
    r.reset();
    expect(r.size).toBe(0);
    const s = r.stats(5);
    expect(s.frames).toBe(0);
    expect(s.frame).toEqual({ p50: 0, p95: 0, max: 0, avg: 0 });
    expect(s.over33).toBe(0);
    r.record(sample(1000, 16));
    expect(r.stats(5).frames).toBe(1);
  });
});
