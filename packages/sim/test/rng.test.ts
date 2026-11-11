import { describe, expect, it } from "vitest";
import { createRng, nextFloat, nextInt, nextNormal, nextU32 } from "../src/index";

describe("seeded RNG with named streams", () => {
  it("is deterministic for the same seed and stream", () => {
    const a = createRng(42), b = createRng(42);
    const xs = Array.from({ length: 100 }, () => nextU32(a, "ballistics"));
    const ys = Array.from({ length: 100 }, () => nextU32(b, "ballistics"));
    expect(xs).toEqual(ys);
  });

  it("differs between seeds and between streams", () => {
    const a = createRng(1), b = createRng(2);
    expect(nextU32(a, "x")).not.toBe(nextU32(b, "x"));
    const c = createRng(1);
    expect(nextU32(c, "spotting")).not.toBe(nextU32(c, "ballistics"));
  });

  it("isolates streams: extra draws in one stream do not shift another", () => {
    const a = createRng(7), b = createRng(7);
    for (let i = 0; i < 1000; i++) nextFloat(a, "ai"); // only in a
    const xa = Array.from({ length: 50 }, () => nextFloat(a, "ballistics"));
    const xb = Array.from({ length: 50 }, () => nextFloat(b, "ballistics"));
    expect(xa).toEqual(xb);
  });

  it("survives a JSON round trip mid-sequence", () => {
    const a = createRng(9);
    for (let i = 0; i < 10; i++) nextFloat(a, "wounds");
    const b = JSON.parse(JSON.stringify(a)) as typeof a;
    expect(Array.from({ length: 20 }, () => nextFloat(a, "wounds"))).toEqual(Array.from({ length: 20 }, () => nextFloat(b, "wounds")));
  });

  it("has sane distributions", () => {
    const r = createRng(3);
    let sum = 0, sq = 0;
    const n = 20000;
    for (let i = 0; i < n; i++) { const v = nextNormal(r, "n"); sum += v; sq += v * v; }
    expect(Math.abs(sum / n)).toBeLessThan(0.03);
    expect(Math.abs(sq / n - 1)).toBeLessThan(0.05);
    const counts = [0, 0, 0, 0];
    for (let i = 0; i < 8000; i++) counts[nextInt(r, "i", 4)]!++;
    for (const c of counts) expect(Math.abs(c - 2000)).toBeLessThan(200);
  });
});
