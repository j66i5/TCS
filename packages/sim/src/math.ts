/**
 * The ONLY place in the simulation that may call transcendental maths (sin, cos, sqrt, pow, exp, ...).
 *
 * Why: inside one JavaScript engine these are repeatable, but different engines (V8, SpiderMonkey,
 * JavaScriptCore) may return results that differ in the last bit. Lockstep multiplayer (SPEC 9.6)
 * needs bit-identical results across devices, so this module can later be swapped for a fully
 * deterministic software implementation without touching any other file.
 *
 * Basic arithmetic (+ - * /), comparisons, Math.abs/min/max/floor/ceil/round/trunc/sign/fround/imul
 * are exactly specified by IEEE 754 / ECMAScript and may be used anywhere.
 *
 * Enforced by ESLint (no-restricted-properties in packages/sim, except this file).
 */

export const PI = Math.PI;
export const TAU = Math.PI * 2;

export const sqrt = (x: number): number => Math.sqrt(x);
export const sin = (x: number): number => Math.sin(x);
export const cos = (x: number): number => Math.cos(x);
export const tan = (x: number): number => Math.tan(x);
export const asin = (x: number): number => Math.asin(x);
export const acos = (x: number): number => Math.acos(x);
export const atan = (x: number): number => Math.atan(x);
/** atan2 with -0 normalised to +0 (JSON saves cannot hold -0; see state.ts toPlain). */
export const atan2 = (y: number, x: number): number => Math.atan2(y, x) + 0;
export const pow = (x: number, y: number): number => Math.pow(x, y);
export const exp = (x: number): number => Math.exp(x);
export const cbrt = (x: number): number => Math.cbrt(x);
export const log = (x: number): number => Math.log(x);
export const hypot2 = (x: number, y: number): number => Math.sqrt(x * x + y * y);
export const hypot3 = (x: number, y: number, z: number): number => Math.sqrt(x * x + y * y + z * z);

/** Clamp x into [lo, hi]. */
export const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);

/** Normalise an angle to (-PI, PI]. */
export function wrapAngle(a: number): number {
  let r = a % TAU;
  if (r <= -PI) r += TAU;
  else if (r > PI) r -= TAU;
  return r;
}
