/**
 * The heavy campaign steps the app runs off the main thread (M12.3; `worker.ts` wraps them, Node tests call them
 * directly): a node's battles auto-resolved or a played battle's result applied (`finishNode`), and the briefing's
 * sector preview (`sectorPreview`: the node's battle built with the proposed or chosen forces, its map painted small
 * in the look asked for, the player's starting places, objectives and exits). No DOM.
 */
import { planControllers } from "@tcs/ai";
import {
  battleInputs, commitOf, enemyFor, finishBattle, menOf, nodeBattleDef, proposeChoice, type BattleRunner, type CampaignRecord, type NodeBattles,
} from "@tcs/campaign";
import { buildAppearance, type DataSet } from "@tcs/data";
import { flatColours, paintRegion, photoInit, PhotoPainter } from "@tcs/render";
import { buildScenario } from "@tcs/scenario";
import { runBattle, TICK_HZ, type BattleResult } from "@tcs/sim";
import type { SectorPreview } from "@tcs/ui";

/** `runBattle` with the AI commander on both sides (by each side's plan); progress every 10 battle seconds. */
export const appRunner: BattleRunner = (input, opts) => runBattle(input, {
  controllers: planControllers(input),
  ...(opts.onProgress ? { onTick: (sim) => { if (sim.state.tick % (10 * TICK_HZ) === 0) opts.onProgress!(sim.state.tick / TICK_HZ); } } : {}),
});

export interface NodeProgress { which: "main" | "flank"; seconds: number }

/** The battles' time limits (the progress bars' totals); null battles: none. */
export function nodeTotals(nb: NodeBattles): { main: number | null; flank: number | null } {
  return { main: nb.main ? nb.main.input.rules.timeLimitSeconds : null, flank: nb.flank ? nb.flank.input.rules.timeLimitSeconds : null };
}

/**
 * battle -> after-battle: the flank battle (if any) auto-resolved, the main battle auto-resolved (`played` null) or
 * the played battle's result applied. `onStart` sees the built battles first (the progress bars).
 */
export function finishNode(data: DataSet, record: CampaignRecord, played: BattleResult | null, onProgress: (p: NodeProgress) => void, onStart?: (nb: NodeBattles) => void, runner: BattleRunner = appRunner): CampaignRecord {
  const nb = battleInputs(data, record);
  onStart?.(nb);
  return finishBattle(data, record, { runner, onProgress: (which, seconds) => onProgress({ which, seconds }) }, played ?? "auto", nb);
}

/** The briefing's sector preview (see the file comment); null when the node's battle cannot be built (no enemy). */
export function sectorPreview(data: DataSet, record: CampaignRecord, look: "photo" | "flat", maxPx = 720): SectorPreview | null {
  const p = record.sides.player, e = record.sides.enemy;
  const choice = record.flow?.choice ?? proposeChoice(data, p);
  const pf = commitOf(data, p, choice.length > 0 ? choice : proposeChoice(data, p));
  if (menOf(pf.units) === 0) return null;
  const ek = enemyFor(data, record, "main", menOf(pf.units));
  if (ek.length === 0) return null;
  const ef = commitOf(data, e, ek);
  const input = buildScenario(data, nodeBattleDef(data, record, "main", [pf, ef]));
  const map = input.map;
  const ppm = Math.min(0.5, maxPx / map.widthM);
  const app = buildAppearance(data, [p.faction, e.faction]);
  const terrain = input.catalog.terrain;
  const bytes = look === "photo"
    ? new PhotoPainter(photoInit(map, terrain, app)).paint(0, 0, map.widthM, map.heightM, ppm, { blur: false })
    : paintRegion(map, flatColours(map, terrain, app), 0, 0, map.widthM, map.heightM, ppm);
  const w = Math.max(1, Math.round(map.widthM * ppm)), h = Math.max(1, Math.round(map.heightM * ppm));
  const blue = input.forces.find((f) => f.side === "blue")!;
  const aboard = new Set<string>();
  for (const pl of blue.placements) if (pl.mountedIn !== undefined) aboard.add(pl.personId);
  const attacker = input.forces.find((f) => f.posture === "attack")?.side;
  return {
    w, h, rgba: new Uint8ClampedArray(bytes.buffer as ArrayBuffer, bytes.byteOffset, w * h * 4), widthM: map.widthM, heightM: map.heightM,
    buildings: map.buildings.map((b) => [...b.footprint]),
    objectives: input.rules.objectives.map((o) => ({ x: o.x, y: o.y, r: o.radiusM, holder: o.holder === "blue" ? "player" : o.holder === "red" ? "enemy" : null })),
    exits: (input.rules.exits ?? []).map((x) => ({ x0: x.x0, y0: x.y0, x1: x.x1, y1: x.y1, own: x.side === "blue" })),
    men: blue.placements.filter((pl) => !aboard.has(pl.personId)).map((pl) => ({ x: pl.x, y: pl.y })),
    hulls: (blue.vehiclePlacements ?? []).map((v) => ({ x: v.x, y: v.y })),
    attacker: attacker === "red" ? "enemy" : "player",
  };
}
