/**
 * SMOKE LAB (M8.1, smoke volume v2). Three tables:
 * - **Height:** an observer on the ground, upstairs and higher looks at a man across a cloud: the view through it
 *   against whether his line clears the cloud's top (geometry, no randomness).
 * - **Drift:** a mortar smoke round in a steady wind: how far the cloud's head has gone after 30 s, and whether
 *   any part of it ever lay upwind of the round.
 * - **Screen:** a smoke mission along a 150 m line (`callFire` with `x2, y2`, six rounds for effect), fired by
 *   the real mission chain (ranging included) over several seeds; then lines of sight across the screen's middle
 *   120 m: the view kept (mean, and the share below spotting's `minVisibility`, i.e. a spotting check that cannot
 *   succeed).
 */
import { demoBattle } from "@tcs/scenario";
import { addSmoke, createSim, heightAt, smokePhysics, smokeShapes, smokeTransmission, step, submitOrder, type BattleInput, type Sim } from "@tcs/sim";
import type { DataSet } from "@tcs/data";

export interface SmokeHeightRow { observer: string; eyeZ: number; cloudTopM: number; clearsTop: boolean; view: number }
export interface SmokeDriftRow { windMps: number; bearingDeg: number; headM: number; upwindM: number }
export interface SmokeScreenRow { faction: string; windMps: number; seeds: number; lines: number; meanView: number; blockedShare: number }
export interface SmokeLab { height: SmokeHeightRow[]; drift: SmokeDriftRow[]; screen: SmokeScreenRow[] }

function flatSim(data: DataSet, seed = 1, w = 800, h = 400, prep?: (i: BattleInput) => void): Sim {
  const input = demoBattle(data, { seed, factions: ["de", "ru"], mapWidthM: w, mapHeightM: h, frontM: 300, timeLimitSeconds: 1200 });
  prep?.(input);
  return createSim(input);
}
const tickTo = (sim: Sim, ticks: number) => { for (let k = 0; k < ticks; k++) step(sim); };

/** Ground observer (1.6 m), first floor window (3.0 + 1.6), second floor (6.0 + 1.6), a roof (10 m), a hill (25 m):
 *  each looks 150 m across a cloud standing 60 m in front of him at a standing man (1.2 m aim point). */
function heightRows(data: DataSet): SmokeHeightRow[] {
  const out: SmokeHeightRow[] = [];
  for (const top of [8, 15]) {
    const sim = flatSim(data);
    // Fully built (born long ago), not fading.
    addSmoke(sim.ctx, sim.state, 160, 200, 20, 100000, top, 0);
    sim.state.smoke[sim.state.smoke.length - 1]!.startTick = -100000;
    const P = smokePhysics(sim.ctx.catalog);
    const gz = heightAt(sim.ctx.map, 100, 200);
    for (const [name, eye] of [["ground, standing", 1.6], ["first floor window", 4.6], ["second floor window", 7.6], ["roof", 10], ["hill top", 25], ["high hill top", 40]] as const) {
      const z0 = gz + eye, z1 = gz + 1.2;
      const view = smokeTransmission(sim.state, P, 100, 200, z0, 250, 200, z1);
      // The line (falling toward the man) leaves the cloud's far edge 80 m out: it clears the top if it is above
      // it there.
      const zOut = z0 + ((z1 - z0) * 80) / 150;
      out.push({ observer: name, eyeZ: eye, cloudTopM: top, clearsTop: zOut > gz + top, view });
    }
  }
  return out;
}

/** A DE mortar smoke round in wind of 2-6 m/s from four bearings: the head's distance downwind after 30 s and the
 *  farthest any part of the cloud reached upwind of the round (beyond its own radius) over 60 s. */
function driftRows(data: DataSet): SmokeDriftRow[] {
  const out: SmokeDriftRow[] = [];
  for (const wind of [2, 4, 6]) for (const brg of [0, 90, 200, 315]) {
    const a = (brg * Math.PI) / 180, wx = Math.sin(a) * wind, wy = -Math.cos(a) * wind; // bearing the wind blows toward, y south
    const sim = flatSim(data, 1, 1200, 1200);
    sim.state.environment.windX = wx; sim.state.environment.windY = wy;
    const fs = sim.ctx.catalog.factions["de"]!.fireSupport!;
    addSmoke(sim.ctx, sim.state, 600, 600, fs.smokeRadiusM, fs.smokeSeconds, fs.smokeTopM ?? 15, fs.smokeBurnSeconds ?? 0);
    const P = smokePhysics(sim.ctx.catalog);
    const ux = wx / wind, uy = wy / wind;
    let head = 0, upwind = 0;
    for (let s = 1; s <= 60; s++) {
      tickTo(sim, 60);
      const sh = smokeShapes(sim.state, P).at(-1)!;
      const along = (x: number, y: number) => (x - 600) * ux + (y - 600) * uy;
      upwind = Math.max(upwind, -Math.min(along(sh.ax, sh.ay), along(sh.bx, sh.by)));
      if (s === 30) head = along(sh.bx, sh.by);
    }
    out.push({ windMps: wind, bearingDeg: brg, headM: head, upwindM: upwind });
  }
  return out;
}

/** A six-round screen along a 150 m north-south line at x = 400 (rounds for effect only: ranging at its middle),
 *  then 400 lines across its middle 120 m, from 100-250 m west of it to 50-150 m east of it, 1.6 m eye to 1.2 m. */
function screenRows(data: DataSet, seeds: number): SmokeScreenRow[] {
  const out: SmokeScreenRow[] = [];
  for (const [side, faction] of [["blue", "de"], ["red", "ru"]] as const) for (const wind of [0, 3]) {
    let lines = 0, view = 0, blocked = 0;
    for (let seed = 1; seed <= seeds; seed++) {
      const sim = flatSim(data, seed, 900, 500, (i) => { i.rules.support = [{ side: "blue", he: 0, smoke: 12 }, { side: "red", he: 0, smoke: 12 }]; });
      sim.state.environment.windX = 0; sim.state.environment.windY = wind; // across the line of sight, along the screen
      const top = [...sim.state.unit.entries()].find(([, u]) => u.side === side && u.parent === null)![0];
      submitOrder(sim, { tick: 0, issuer: side, target: top, kind: "callFire", x: 450, y: 175, x2: 450, y2: 325, ammo: "smoke", rounds: 6 });
      // Until the last round is down, then 15 s for it to build up.
      let last = 0;
      for (let k = 0; k < 60 * 400; k++) {
        const ev = step(sim);
        if (ev.some((e) => e.kind === "support.smoke")) last = sim.state.tick;
        if (last > 0 && sim.state.fireMissions.length === 0 && sim.state.tick >= last + 15 * 60) break;
      }
      const P = smokePhysics(sim.ctx.catalog), min = sim.ctx.catalog.spotting.minVisibility;
      let s = seed * 7919;
      const rnd = () => ((s = (s * 1103515245 + 12345) >>> 0) / 4294967296);
      const gz = heightAt(sim.ctx.map, 450, 250);
      for (let k = 0; k < 400; k++) {
        const y = 190 + rnd() * 120, x0 = 450 - 100 - rnd() * 150, x1 = 450 + 50 + rnd() * 100, y1 = y + (rnd() - 0.5) * 40;
        const v = smokeTransmission(sim.state, P, x0, y, gz + 1.6, x1, y1, gz + 1.2);
        lines++; view += v; if (v < min) blocked++;
      }
    }
    out.push({ faction, windMps: wind, seeds, lines, meanView: view / lines, blockedShare: blocked / lines });
  }
  return out;
}

export function smokeLab(data: DataSet, seeds = 6): SmokeLab {
  return { height: heightRows(data), drift: driftRows(data), screen: screenRows(data, seeds) };
}

export function smokeLabMarkdown(lab: SmokeLab): string {
  const f = (x: number, d = 2) => x.toFixed(d);
  const h = ["## Height: looking across a cloud 20 m in radius, 60 m ahead, at a man 150 m away", "",
    "| observer | eye (m) | cloud top (m) | line clears the top | view kept |", "|---|---:|---:|---|---:|",
    ...lab.height.map((r) => `| ${r.observer} | ${f(r.eyeZ, 1)} | ${r.cloudTopM} | ${r.clearsTop ? "yes" : "no"} | ${f(r.view, 3)} |`)];
  const d = ["", "## Drift: a mortar smoke round in a steady wind", "",
    "| wind (m/s) | blowing toward (deg) | head downwind after 30 s (m) | farthest upwind of the round (m) |", "|---:|---:|---:|---:|",
    ...lab.drift.map((r) => `| ${r.windMps} | ${r.bearingDeg} | ${f(r.headM, 0)} | ${f(r.upwindM, 1)} |`)];
  const s = ["", "## Screen: six rounds along 150 m, lines of sight across its middle 120 m", "",
    "| faction | wind along the screen (m/s) | seeds | lines | mean view kept | share no spotting possible | spotting checks blocked (1 - mean view) |", "|---|---:|---:|---:|---:|---:|---:|",
    ...lab.screen.map((r) => `| ${r.faction} | ${r.windMps} | ${r.seeds} | ${r.lines} | ${f(r.meanView, 3)} | ${f(r.blockedShare * 100, 0)} % | ${f((1 - r.meanView) * 100, 0)} % |`)];
  return [...h, ...d, ...s].join("\n");
}
