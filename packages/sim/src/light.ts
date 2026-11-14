/**
 * NIGHT AND LIGHT (M9.1, SPEC 6.1). Ambient light 0..1 from the local time and the moon, by a table in the data
 * (core/spotting.json `night`): the sun's light by hour (interpolated), and a full moon's light scaled by its
 * illumination. Pure; no transcendental maths (linear interpolation only).
 *
 * The light follows the clock only in a battle whose environment has a `sky` (absent: `light` is whatever the input
 * gave, as before M9.1 — every existing battle and golden replay). With a sky the sim sets `light` at the start and
 * once a second (systems in sim.ts).
 */
import type { Catalog } from "./catalog";
import type { Environment } from "./environment";

/** Light 0..1 at `timeOfDaySeconds` (any value: taken modulo a day) with the moon `moon` (0 new .. 1 full). */
export function lightAt(catalog: Catalog, timeOfDaySeconds: number, moon: number): number {
  const N = catalog.spotting.night;
  const day = 24 * 3600;
  const h = (((timeOfDaySeconds % day) + day) % day) / 3600;
  const t = N.sun;
  let sun = t[t.length - 1]![1];
  for (let i = 1; i < t.length; i++) {
    const a = t[i - 1]!, b = t[i]!;
    if (h <= b[0]) { sun = b[0] > a[0] ? a[1] + ((b[1] - a[1]) * (h - a[0])) / (b[0] - a[0]) : b[1]; break; }
  }
  const m = N.moonFullLight * clampMoon(moon);
  return Math.min(1, Math.max(sun, m));
}

/**
 * The environment of a battle at local time `timeOfDaySeconds` with the moon `moon` (0 new .. 1 full; default a half
 * moon): the default weather, a sky, and the light from the table. For the app's `?time=`, the tools' `--time`, labs.
 */
export function environmentAt(catalog: Catalog, timeOfDaySeconds: number, moon = 0.5, base?: Environment): Environment {
  const e: Environment = base ? { ...base } : { timeOfDaySeconds: 10 * 3600, light: 1, windX: 0, windY: 0, rain: 0, visibilityM: 10000, temperatureC: 15 };
  e.timeOfDaySeconds = timeOfDaySeconds;
  e.sky = { moon: clampMoon(moon) };
  e.light = lightAt(catalog, timeOfDaySeconds, e.sky.moon);
  return e;
}

/** The moon's illumination 0..1; anything not a finite number (a bad `?moon=`) is a half moon. */
function clampMoon(moon: number): number {
  return Number.isFinite(moon) ? Math.min(1, Math.max(0, moon)) : 0.5;
}

/** "21:30", "21", "21.5" -> seconds since midnight; null if it is not a time of day. */
export function parseTimeOfDay(s: string | null | undefined): number | null {
  if (s === null || s === undefined || s === "") return null;
  const m = /^(\d{1,2})(?::(\d{2}))?$/.exec(s);
  let h: number;
  if (m) { if (m[2] !== undefined && Number(m[2]) > 59) return null; h = Number(m[1]) + (m[2] !== undefined ? Number(m[2]) / 60 : 0); }
  else { h = Number(s); if (!Number.isFinite(h)) return null; }
  if (h < 0 || h > 24) return null;
  return Math.round(h * 3600);
}
