/** M5 review: tap, pan, pinch and dragging a handle, with a stand-in for the map element (no browser). */
import { describe, expect, it } from "vitest";
import type { Camera } from "@tcs/render";
import { attachInput } from "../src/input";

type L = (e: unknown) => void;
function fakeEl() {
  const ls = new Map<string, L>();
  return {
    el: { addEventListener: (k: string, f: L) => ls.set(k, f), removeEventListener: () => {}, setPointerCapture: () => {}, getBoundingClientRect: () => ({ left: 0, top: 0 }) },
    fire: (k: string, id: number, x: number, y: number) => ls.get(k)!({ pointerId: id, clientX: x, clientY: y, preventDefault: () => {} }),
  };
}
function setup(dragAt: ((w: { x: number; y: number }) => boolean) | null, asTap = false) {
  const f = fakeEl();
  let cam: Camera = { x: 0, y: 0, scale: 1 } as Camera;
  const log: string[] = [];
  attachInput(f.el as unknown as HTMLElement, {
    getCamera: () => cam,
    setCamera: (c) => { cam = c; log.push("camera"); },
    onTap: (w) => log.push(`tap ${Math.round(w.x)},${Math.round(w.y)}`),
    ...(dragAt ? { onDragStart: (w: { x: number; y: number }) => { const r = dragAt(w); log.push(`start ${r}`); return r; }, onDrag: () => { log.push("drag"); }, onDragEnd: (how: string) => { log.push("end", `end ${how}`); return asTap; } } : {}),
  });
  return { f, log, cam: () => cam };
}

describe("map input", () => {
  it("a press without moving is a tap", () => {
    const { f, log } = setup(null);
    f.fire("pointerdown", 1, 100, 100); f.fire("pointerup", 1, 102, 101);
    expect(log.some((l) => l.startsWith("tap"))).toBe(true);
    expect(log).not.toContain("camera");
  });
  it("a one-finger drag on empty ground pans the map (no tap)", () => {
    const { f, log } = setup(() => false);
    f.fire("pointerdown", 1, 100, 100); f.fire("pointermove", 1, 160, 100); f.fire("pointerup", 1, 160, 100);
    expect(log).toContain("camera");
    expect(log.some((l) => l.startsWith("tap"))).toBe(false);
    expect(log).not.toContain("drag");
  });
  it("a press on a handle drags it: no panning, no tap, an end", () => {
    const { f, log } = setup(() => true);
    f.fire("pointerdown", 1, 100, 100); f.fire("pointermove", 1, 160, 100); f.fire("pointermove", 1, 170, 120); f.fire("pointerup", 1, 170, 120);
    expect(log.filter((l) => l === "drag").length).toBe(2);
    expect(log).toContain("end");
    expect(log).not.toContain("camera");
    expect(log.some((l) => l.startsWith("tap"))).toBe(false);
  });
  it("a second finger turns a handle drag into a pinch (the drag ends)", () => {
    const { f, log } = setup(() => true);
    f.fire("pointerdown", 1, 100, 100); f.fire("pointerdown", 2, 200, 100);
    expect(log).toContain("end cancel");
    f.fire("pointermove", 2, 260, 100);
    expect(log).toContain("camera");
    expect(log).not.toContain("drag");
  });
  it("controls step: a drag press released after moving ends as a drop (no tap)", () => {
    const { f, log } = setup(() => true, true);
    f.fire("pointerdown", 1, 100, 100); f.fire("pointermove", 1, 160, 100); f.fire("pointerup", 1, 160, 100);
    expect(log).toContain("end drop");
    expect(log.some((l) => l.startsWith("tap"))).toBe(false);
  });
  it("controls step: a drag press released without moving ends as a tap, delivered as a tap if asked", () => {
    const a = setup(() => true, true);
    a.f.fire("pointerdown", 1, 100, 100); a.f.fire("pointerup", 1, 103, 101);
    expect(a.log).toContain("end tap");
    expect(a.log).toContain("tap 103,101");
    const b = setup(() => true, false);
    b.f.fire("pointerdown", 1, 100, 100); b.f.fire("pointerup", 1, 103, 101);
    expect(b.log).toContain("end tap");
    expect(b.log.some((l) => l.startsWith("tap"))).toBe(false);
  });
});
