/**
 * Golden replays: stored order streams with the expected state hashes at checkpoints.
 * A changed hash is either a bug or an intended change that must be recorded in docs/DECISIONS.md
 * and the goldens regenerated with `npm run golden:update`.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runBattle, secondsToTicks, simHash, stripInteriors, type Order, type Sim } from "@tcs/sim";
import { getScenario, loadData } from "./scenarios";

export const GOLDEN_DIR = fileURLToPath(new URL("../golden", import.meta.url));
/**
 * The goldens recorded before building interiors (M7.5c), kept unchanged: replayed with interiors off they must
 * still match bit for bit (the equivalence proof of plan §1.3).
 */
export const GOLDEN_NO_INTERIORS_DIR = join(GOLDEN_DIR, "no-interiors");

export interface GoldenFile {
  name: string;
  description: string;
  scenario: string;
  seed: number;
  seconds: number;
  checkpointEverySeconds: number;
  /** The recorded order stream (produced once by the scenario's controllers). */
  orders: Order[];
  /** tick -> state hash. */
  checkpoints: Record<string, string>;
  /** Hash of the catalog (data) the golden was recorded with. */
  catalogFingerprint: string;
}

/** Record a golden: run with the scenario's controllers, capture the order stream and checkpoint hashes. */
export function recordGolden(name: string, description: string, scenario: string, seed: number, seconds: number, every = 10): GoldenFile {
  const sc = getScenario(scenario);
  const data = loadData(sc.fixtures ?? false);
  const input = sc.build(data, seed, seconds);
  const checkpoints: Record<string, string> = {};
  const everyTicks = secondsToTicks(every);
  const result = runBattle(input, {
    controllers: sc.controllers?.(input) ?? [],
    onTick: (sim) => { if (sim.state.tick % everyTicks === 0) checkpoints[String(sim.state.tick)] = hashOf(sim); },
  });
  return {
    name, description, scenario, seed, seconds, checkpointEverySeconds: every,
    orders: result.orders, checkpoints, catalogFingerprint: input.catalog.fingerprint,
  };
}

const hashOf = (sim: Sim) => simHash(sim);

/** Replay a golden's order stream WITHOUT controllers and return the checkpoint hashes. */
export function replayGolden(g: GoldenFile, opts: { interiors?: boolean } = {}): { checkpoints: Record<string, string>; catalogFingerprint: string } {
  const sc = getScenario(g.scenario);
  const data = loadData(sc.fixtures ?? false);
  const input = sc.build(data, g.seed, g.seconds);
  // Without interiors: exactly the map `generateMap(..., { interiors: false })` gives (tested in mapgen).
  if (opts.interiors === false) input.map = stripInteriors(input.map);
  input.orders = g.orders;
  const checkpoints: Record<string, string> = {};
  const everyTicks = secondsToTicks(g.checkpointEverySeconds);
  runBattle(input, { onTick: (sim) => { if (sim.state.tick % everyTicks === 0) checkpoints[String(sim.state.tick)] = simHash(sim); } });
  return { checkpoints, catalogFingerprint: input.catalog.fingerprint };
}

export function readGoldens(dir = GOLDEN_DIR): GoldenFile[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as GoldenFile);
}

/** The set of goldens that should exist. Add new ones here. */
export const GOLDEN_SPECS: { name: string; description: string; scenario: string; seed: number; seconds: number }[] = [
  { name: "demo-s1", description: "Demo scenario, seed 1, 120 s, wander orders", scenario: "demo", seed: 1, seconds: 120 },
  { name: "shootout-s1", description: "Scripted shoot-out of the two real squads, seed 1, 180 s", scenario: "shootout", seed: 1, seconds: 180 },
  { name: "fixture-s7", description: "Fixture faction vs DE, seed 7, 90 s", scenario: "demo-fixture", seed: 7, seconds: 90 },
  { name: "vehicles-s1", description: "Two Pumas and two BMP-2s with their squads wandering on farmland, seed 1, 150 s (M7.1c)", scenario: "vehicles", seed: 1, seconds: 150 },
  { name: "fixture-cart-s3", description: "Fixture wheeled carts vs Pumas on a flat field, seed 3, 90 s (M7.1c)", scenario: "vehicles-fixture", seed: 3, seconds: 90 },
  { name: "platoon-vehicles-s1", description: "Platoon battle with vehicles: the Germans ride in and get out, AI v AI, seed 1, 150 s (M7.2)", scenario: "platoon-vehicles", seed: 1, seconds: 150 },
];
