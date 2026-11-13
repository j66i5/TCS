/**
 * Touch + mouse input on the map canvas. Emits high-level intents (tap at a world point, camera
 * changes). It never touches the simulation: the app turns taps into ORDERS.
 *
 *   one finger / left mouse: tap = tap; drag = pan, unless the press lands on something the app lets the
 *   player drag (an order marker's handle, M5; the selected unit, an active move's marker, the facing handle, or
 *   anywhere in Fire mode, the "controls" step): then the drag moves that instead. A drag press released without
 *   moving ends the drag as "tap"; the app may then ask for the tap as well (a press on a unit still selects it).
 *   two fingers: pinch = zoom, move = pan
 *   mouse wheel: zoom at cursor
 */
import { pan, screenToWorld, zoomAt, type Camera } from "@tcs/render";

export interface InputCallbacks {
  getCamera(): Camera;
  setCamera(c: Camera): void;
  onTap(world: { x: number; y: number }, screen: { x: number; y: number }): void;
  /** A one-finger press: return true to drag something (no panning); then onDrag / onDragEnd follow. */
  onDragStart?(world: { x: number; y: number }): boolean;
  onDrag?(world: { x: number; y: number }): void;
  /**
   * The drag is over: "drop" (released after moving), "tap" (released without moving: return true to have it
   * delivered as a tap too) or "cancel" (a second finger turned it into a pinch: nothing is to be sent).
   */
  onDragEnd?(how: "drop" | "tap" | "cancel"): boolean | void;
}

const TAP_SLOP_PX = 10;

export function attachInput(el: HTMLElement, cb: InputCallbacks): () => void {
  const pointers = new Map<number, { x: number; y: number }>();
  let downAt: { x: number; y: number } | null = null;
  let moved = false;
  let pinchDist = 0;
  let dragging = false;

  const local = (e: PointerEvent | WheelEvent) => {
    const r = el.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const centroid = () => {
    let x = 0, y = 0;
    for (const p of pointers.values()) { x += p.x; y += p.y; }
    return { x: x / pointers.size, y: y / pointers.size };
  };
  const spread = () => {
    const [a, b] = [...pointers.values()];
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  };

  const down = (e: PointerEvent) => {
    el.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, local(e));
    if (pointers.size === 1) {
      downAt = local(e); moved = false;
      dragging = cb.onDragStart?.(screenToWorld(cb.getCamera(), downAt.x, downAt.y)) === true;
    }
    if (pointers.size === 2) { pinchDist = spread(); moved = true; if (dragging) { dragging = false; cb.onDragEnd?.("cancel"); } }
  };
  const move = (e: PointerEvent) => {
    const prev = pointers.get(e.pointerId);
    if (!prev) return;
    const before = centroid();
    const p = local(e);
    pointers.set(e.pointerId, p);
    const after = centroid();
    if (downAt && Math.hypot(p.x - downAt.x, p.y - downAt.y) > TAP_SLOP_PX) moved = true;
    if (!moved) return;
    if (dragging && pointers.size === 1) { cb.onDrag?.(screenToWorld(cb.getCamera(), p.x, p.y)); return; }
    let cam = pan(cb.getCamera(), after.x - before.x, after.y - before.y);
    if (pointers.size === 2) {
      const d = spread();
      if (pinchDist > 0 && d > 0) cam = zoomAt(cam, after.x, after.y, d / pinchDist);
      pinchDist = d;
    }
    cb.setCamera(cam);
  };
  const up = (e: PointerEvent) => {
    let wasTap = pointers.size === 1 && !moved && downAt !== null && !dragging;
    pointers.delete(e.pointerId);
    if (dragging && pointers.size === 0) {
      dragging = false;
      const asTap = cb.onDragEnd?.(e.type === "pointercancel" ? "cancel" : moved ? "drop" : "tap") === true;
      if (asTap && !moved && downAt !== null) wasTap = true;
    }
    if (wasTap) {
      const s = local(e);
      cb.onTap(screenToWorld(cb.getCamera(), s.x, s.y), s);
    }
    if (pointers.size === 0) downAt = null;
    if (pointers.size < 2) pinchDist = 0;
  };
  const wheel = (e: WheelEvent) => {
    e.preventDefault();
    const s = local(e);
    cb.setCamera(zoomAt(cb.getCamera(), s.x, s.y, Math.exp(-e.deltaY * 0.0015)));
  };

  el.addEventListener("pointerdown", down);
  el.addEventListener("pointermove", move);
  el.addEventListener("pointerup", up);
  el.addEventListener("pointercancel", up);
  el.addEventListener("wheel", wheel, { passive: false });
  return () => {
    el.removeEventListener("pointerdown", down);
    el.removeEventListener("pointermove", move);
    el.removeEventListener("pointerup", up);
    el.removeEventListener("pointercancel", up);
    el.removeEventListener("wheel", wheel);
  };
}
