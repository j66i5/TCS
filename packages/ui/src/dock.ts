/**
 * Where the order bar docks (M7.5a, owner answer 7): a full-width strip at the top or bottom, or a full-height
 * strip at the left or right. Dragging its grip and letting go docks it to the edge nearest the finger. The
 * choice is remembered per device (localStorage `tcs.ui.dock`); until the player moves it, it sits at the
 * bottom on a screen held upright and at the right on a screen held sideways (plan §7.5). Pure functions here;
 * the storage access is guarded (private windows and blocked storage throw).
 */
export type Edge = "top" | "bottom" | "left" | "right";
export const EDGES: readonly Edge[] = ["bottom", "right", "left", "top"];
export const DOCK_KEY = "tcs.ui.dock";

/** The screen edge nearest the point (x, y) on a w x h screen. Ties: bottom, right, left, top. */
export function nearestEdge(x: number, y: number, w: number, h: number): Edge {
  const d: Record<Edge, number> = { bottom: h - y, right: w - x, left: x, top: y };
  let best: Edge = "bottom";
  for (const e of EDGES) if (d[e] < d[best]) best = e;
  return best;
}

/** The default dock: bottom when the screen is upright (or square), right when it is held sideways. */
export function defaultEdge(w: number, h: number): Edge {
  return w > h ? "right" : "bottom";
}

export const isVertical = (e: Edge) => e === "left" || e === "right";

/** The edge the player chose on this device, or null (never moved, or storage unavailable). */
export function loadEdge(storage: Pick<Storage, "getItem"> | null | undefined): Edge | null {
  try {
    const v = storage?.getItem(DOCK_KEY);
    return v === "top" || v === "bottom" || v === "left" || v === "right" ? v : null;
  } catch { return null; }
}

/** Remember the chosen edge (silently does nothing where storage is unavailable). */
export function saveEdge(storage: Pick<Storage, "setItem"> | null | undefined, e: Edge): void {
  try { storage?.setItem(DOCK_KEY, e); } catch { /* not remembered: fine */ }
}

/** The unit sidebar's side: left, unless the order bar docks there (plan §7.6). */
export function sidebarSide(dock: Edge): "left" | "right" {
  return dock === "left" ? "right" : "left";
}
