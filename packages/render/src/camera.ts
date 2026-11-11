/** Camera: world metres <-> screen pixels. Pure maths, no PixiJS, so it can be unit-tested. */
export interface Camera {
  /** World point at the screen's top-left corner, metres. */
  x: number;
  y: number;
  /** Pixels per metre. */
  scale: number;
}

export const MIN_SCALE = 0.05; // 4 km map fits a phone
export const MAX_SCALE = 40; // individual men fill the screen

export function worldToScreen(c: Camera, wx: number, wy: number): { x: number; y: number } {
  return { x: (wx - c.x) * c.scale, y: (wy - c.y) * c.scale };
}

export function screenToWorld(c: Camera, sx: number, sy: number): { x: number; y: number } {
  return { x: sx / c.scale + c.x, y: sy / c.scale + c.y };
}

export interface Insets { top: number; right: number; bottom: number; left: number }

/** Fit a world rectangle into the screen area left free by the HUD (insets), with a margin. */
export function fitCamera(
  worldW: number, worldH: number, screenW: number, screenH: number,
  insets: Insets = { top: 0, right: 0, bottom: 0, left: 0 }, marginPx = 12,
): Camera {
  const w = Math.max(1, screenW - insets.left - insets.right - 2 * marginPx);
  const h = Math.max(1, screenH - insets.top - insets.bottom - 2 * marginPx);
  const s = Math.max(MIN_SCALE, Math.min(MAX_SCALE, Math.min(w / worldW, h / worldH)));
  // Centre the map in the free area.
  const cx = insets.left + marginPx + w / 2;
  const cy = insets.top + marginPx + h / 2;
  return { scale: s, x: worldW / 2 - cx / s, y: worldH / 2 - cy / s };
}

/** Zoom by `factor` keeping the world point under screen point (sx, sy) fixed. */
export function zoomAt(c: Camera, sx: number, sy: number, factor: number): Camera {
  const before = screenToWorld(c, sx, sy);
  const scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, c.scale * factor));
  return { scale, x: before.x - sx / scale, y: before.y - sy / scale };
}

export function pan(c: Camera, dxPx: number, dyPx: number): Camera {
  return { ...c, x: c.x - dxPx / c.scale, y: c.y - dyPx / c.scale };
}
