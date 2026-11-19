/**
 * The tools' side of the campaign (M12.0a): the battle runner with the AI commander on both sides (the campaign
 * package never imports the AI) and the faction pairing of a chain.
 */
import { commanderController } from "@tcs/ai";
import type { BattleRunner } from "@tcs/campaign";
import type { DataSet } from "@tcs/data";
import { runBattle, TICK_HZ } from "@tcs/sim";

/** `runBattle` with the AI commander on every side of the input (progress once a battle minute). */
export const aiRunner: BattleRunner = (input, opts) => runBattle(input, {
  controllers: input.forces.map((f) => commanderController(f.side, input)),
  ...(opts.onProgress ? { onTick: (sim) => { if (sim.state.tick % (60 * TICK_HZ) === 0) opts.onProgress!(sim.state.tick / TICK_HZ); } } : {}),
});

/** The enemy of a faction in a chain: the first other faction of the data (sorted), else the same one. */
export function enemyOf(data: DataSet, faction: string): string {
  const other = Object.keys(data.factions).sort().filter((f) => f !== faction && data.factions[f]?.manifest.fixture !== true);
  return other[0] ?? faction;
}
