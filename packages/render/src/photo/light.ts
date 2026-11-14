/**
 * The sun of the photo map (plan "photo" decision 2): one fixed direction for every lit face and every shadow. Light
 * comes from the west-north-west, about 40 degrees up (an off-diagonal sun, so hip lines of roofs show); shadows fall
 * toward the east-south-east, `SHADOW_K` metres per metre of height, at most `SHADOW_MAX` metres. Pure.
 */
const sx = -0.68, sy = -0.42, sz = 0.6, sn = Math.sqrt(sx * sx + sy * sy + sz * sz);
/** Unit vector toward the sun (x east, y south, z up). */
export const SUN = { x: sx / sn, y: sy / sn, z: sz / sn } as const;
export const SHADOW_K = 0.6;
export const SHADOW_MAX = 6;
/** Hillshade strength: brightness change per unit of (n . sun - flat), capped at +-`HILL_CAP` (plan decision 13). */
export const HILL_GAIN = 1.4;
export const HILL_CAP = 0.07;

/** Brightness change (about -0.07..+0.07) of ground with height slopes dh/dx, dh/dy (m per m). */
export function hillshade(dhdx: number, dhdy: number): number {
  const n = 1 / Math.sqrt(dhdx * dhdx + dhdy * dhdy + 1);
  const d = (-dhdx * SUN.x - dhdy * SUN.y + SUN.z) * n - SUN.z;
  const v = d * HILL_GAIN;
  return v < -HILL_CAP ? -HILL_CAP : v > HILL_CAP ? HILL_CAP : v;
}

/** Where the shadow of something `heightM` tall falls, as an offset (m) from its foot. */
export function shadowOffset(heightM: number): { dx: number; dy: number } {
  const l = Math.min(SHADOW_MAX, SHADOW_K * heightM), h = Math.sqrt(SUN.x * SUN.x + SUN.y * SUN.y);
  return { dx: (-SUN.x / h) * l, dy: (-SUN.y / h) * l };
}
