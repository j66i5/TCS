/**
 * ONE FLIGHT STEP (M7.4a, plan §9): what the projectile loop does to a projectile's velocity in one tick —
 * a rocket motor's push along the path (only while it burns), drag relative to the wind (quadratic, integrated
 * exactly for the speed) and gravity — written once so that aiming (the launcher's elevation, lead) flies the
 * same path the projectile engine will. `systems/ballistics.ts` inlines the same arithmetic in its hot loop
 * (a function call per round would cost too much there); `flight.test.ts` checks that both agree.
 */
import type { AmmoRT } from "./ballistics";
import { DT } from "./ids";
import { sqrt } from "./math";

export interface FlightState { x: number; y: number; z: number; vx: number; vy: number; vz: number; age: number }

/**
 * Advance `f` by one tick (1/60 s) for ammunition `am` in air of density `rho` with wind (wx, wy), gravity g.
 * `age` is in ticks since launch (the motor's timing) and is advanced too.
 */
export function flightStep(f: FlightState, am: AmmoRT, rho: number, wx: number, wy: number, g: number): void {
  const dt = DT;
  let vx = f.vx, vy = f.vy, vz = f.vz;
  if (am.thrust > 0 && f.age >= am.ignTicks && f.age < am.burnEndTicks) {
    const sp = sqrt(vx * vx + vy * vy + vz * vz);
    if (sp > 1e-6) { const k = 1 + (am.thrust * dt) / sp; vx *= k; vy *= k; vz *= k; }
  }
  const rvx = vx - wx, rvy = vy - wy;
  const rs = sqrt(rvx * rvx + rvy * rvy + vz * vz);
  const cdv = am.dragA * rs + am.dragB, cap = am.dragMax * rs;
  const a = am.kDrag * rho * (cdv < cap ? cdv : cap) * dt;
  let k: number, h: number;
  if (a < 0.02) { k = 1 - a + a * a; h = 1 - 0.5 * a; } else { k = 1 / (1 + a); h = 1 / (1 + 0.5 * a); }
  const gdt = g * dt;
  f.x += (wx + rvx * h) * dt; f.y += (wy + rvy * h) * dt; f.z += (vz * h - 0.5 * gdt) * dt;
  f.vx = wx + rvx * k; f.vy = wy + rvy * k; f.vz = vz * k - gdt;
  f.age++;
}
