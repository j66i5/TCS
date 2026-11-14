/**
 * The terrain tile queue (plan "photo" decision 6) with a fake worker: centre first, cancel when a tile leaves the
 * view, at most N in flight, at most M uploads a frame, nothing asked twice.
 */
import { describe, expect, it } from "vitest";
import { TileQueue, type TileJob } from "../src/tile-queue";

const job = (key: string, prio: number): TileJob => ({ key, level: 2, x0: 0, y0: 0, w: 64, h: 64, ppm: 4, prio });

/** A fake worker: takes jobs from the queue up to its capacity and finishes them when told. */
class FakeWorker {
  busy: TileJob[] = [];
  constructor(private q: TileQueue) {}
  pump(): void { for (let j = this.q.next(); j; j = this.q.next()) this.busy.push(j); }
  finish(n = 1): void { for (const j of this.busy.splice(0, n)) this.q.done(j, new Uint8Array(4)); }
}

describe("tile queue", () => {
  it("paints the nearest tile first and never more than maxInFlight at once", () => {
    const q = new TileQueue(2, 2), w = new FakeWorker(q);
    q.want([job("far", 9), job("near", 1), job("mid", 4)]);
    w.pump();
    expect(w.busy.map((j) => j.key)).toEqual(["near", "mid"]);
    expect(q.inFlight()).toBe(2);
    w.finish(1); w.pump();
    expect(w.busy.map((j) => j.key)).toEqual(["mid", "far"]);
  });
  it("cancels queued tiles that left the view, keeps the ones in flight, asks nothing twice", () => {
    const q = new TileQueue(1, 2), w = new FakeWorker(q);
    q.want([job("a", 1), job("b", 2), job("c", 3)]);
    w.pump();
    expect(w.busy.map((j) => j.key)).toEqual(["a"]);
    q.want([job("a", 1), job("c", 3)]); // b left the view; a is painting (not queued again)
    expect(q.cancelled).toBe(1);
    expect(q.pending()).toBe(2);
    w.finish(); w.pump();
    expect(w.busy.map((j) => j.key)).toEqual(["c"]);
    q.want([job("a", 1), job("c", 3)]); // a painted, waiting for upload: not asked again
    expect(q.pending()).toBe(2);
  });
  it("hands out at most maxUploads painted tiles a frame, best first", () => {
    const q = new TileQueue(8, 2), w = new FakeWorker(q);
    q.want([job("t3", 3), job("t1", 1), job("t2", 2), job("t0", 0), job("t4", 4)]);
    w.pump(); w.finish(5);
    expect(q.take().map((t) => t.job.key)).toEqual(["t0", "t1"]);
    expect(q.take().map((t) => t.job.key)).toEqual(["t2", "t3"]);
    expect(q.take().map((t) => t.job.key)).toEqual(["t4"]);
    expect(q.take()).toEqual([]);
    expect(q.pending()).toBe(0);
  });
  it("a failed paint is asked for again while still wanted; add() keeps the others", () => {
    const q = new TileQueue(4, 4), w = new FakeWorker(q);
    q.want([job("x", 1)]); w.pump();
    q.fail(w.busy.pop()!);
    q.add([job("strip", -10)]);
    q.want([job("x", 1), job("strip", -10)]);
    w.pump();
    expect(w.busy.map((j) => j.key)).toEqual(["strip", "x"]);
    let called = 0; q.onDone = () => called++;
    w.finish(2);
    expect(called).toBe(2);
    expect(q.isReady("x")).toBe(true);
  });
});
