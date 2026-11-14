/**
 * Environment state (SPEC 6.1, 9.7). Foundations only need daylight and clear weather, but spotting,
 * ballistics, movement and fatigue read these values from the start, so night and weather later
 * change numbers, not interfaces.
 */
export interface Environment {
  /** Seconds since local midnight at battle start; advanced by the clock. */
  timeOfDaySeconds: number;
  /** Ambient light 0 (dark) .. 1 (full daylight). Derived from time of day + weather later. */
  light: number;
  /** Wind vector, m/s, the way the air moves (x east, y south: the map's y grows southward). */
  windX: number;
  windY: number;
  /** Rain intensity 0..1. */
  rain: number;
  /** Meteorological visibility, metres (fog). */
  visibilityM: number;
  /** Air temperature, degrees Celsius. */
  temperatureC: number;
}

export function defaultEnvironment(): Environment {
  return { timeOfDaySeconds: 10 * 3600, light: 1, windX: 0, windY: 0, rain: 0, visibilityM: 10000, temperatureC: 15 };
}
