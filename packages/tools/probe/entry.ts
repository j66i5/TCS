/**
 * F2 cross-browser hash probe (D3): the shoot-out golden replayed inside a browser. Bundled by
 * `npm run probe` (src/cli/probe.ts) with Vite into one IIFE script that sets `globalThis.tcsProbe`; the same
 * script runs in Node and in every installed Playwright engine, so differences come from the engine's maths,
 * not from the build. Browser-safe: no Node API here (the data set comes in through a virtual module).
 */
import files from "virtual:tcs-probe-data";
import { loadDataSet } from "@tcs/data";
import { demoBattle } from "@tcs/scenario";
import { canonicalJson, runBattle, secondsToTicks, serializeState, simHash, type BattleInput, type Order } from "@tcs/sim";
import golden from "../golden/shootout-s1.json";

/** What one engine reports back to the CLI. */
export interface ProbeRun {
  userAgent: string;
  fingerprint: string;
  /** tick -> state hash, every `checkpointEverySeconds` (as the golden records them). */
  checkpoints: Record<string, string>;
  ms: number;
}

export interface ProbeDump {
  /** Canonical JSON of the serialised state at the tick ("" if the battle ended before it). */
  state: string;
  /** Raw `Math` results the sim's maths (sim/math.ts) rests on, for a last-bit comparison between engines. */
  math: Record<string, number>;
}

/** The shoot-out battle exactly as `src/scenarios.ts` builds it (`shootout`), with the golden's recorded orders. */
function shootoutInput(): BattleInput {
  const { data, errors } = loadDataSet(files);
  if (!data) throw new Error(`data failed to load: ${errors.length} errors`);
  const input = demoBattle(data, { seed: golden.seed, factions: ["de", "ru"], timeLimitSeconds: golden.seconds, mapWidthM: 800, mapHeightM: 600, frontM: 250 });
  input.orders = golden.orders as Order[];
  return input;
}

function run(): ProbeRun {
  const t0 = performance.now();
  const input = shootoutInput();
  const checkpoints: Record<string, string> = {};
  const every = secondsToTicks(golden.checkpointEverySeconds);
  runBattle(input, { onTick: (sim) => { if (sim.state.tick % every === 0) checkpoints[String(sim.state.tick)] = simHash(sim); } });
  const ua = typeof navigator === "undefined" ? "unknown" : navigator.userAgent;
  return { userAgent: ua, fingerprint: input.catalog.fingerprint, checkpoints, ms: Math.round(performance.now() - t0) };
}

const MATH_ARGS = [0.1, 0.5, 1, 1.3, 2, 3, 10, 100, 1e5];

function dump(tick: number): ProbeDump {
  let state = "";
  runBattle(shootoutInput(), { onTick: (sim) => { if (sim.state.tick === tick) state = canonicalJson(serializeState(sim.state)); } });
  const math: Record<string, number> = {};
  for (const x of MATH_ARGS) {
    math[`sin(${x})`] = Math.sin(x); math[`cos(${x})`] = Math.cos(x); math[`tan(${x})`] = Math.tan(x);
    math[`atan(${x})`] = Math.atan(x); math[`atan2(${x},0.7)`] = Math.atan2(x, 0.7); math[`exp(${x})`] = Math.exp(x);
    math[`log(${x})`] = Math.log(x); math[`pow(${x},1.7)`] = Math.pow(x, 1.7); math[`cbrt(${x})`] = Math.cbrt(x);
    math[`asin(${x / 1e5})`] = Math.asin(x / 1e5); math[`acos(${x / 1e5})`] = Math.acos(x / 1e5);
  }
  return { state, math };
}

(globalThis as { tcsProbe?: unknown }).tcsProbe = { run, dump };
