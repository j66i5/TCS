/**
 * The battle runner the campaign is given (M12.0a). The campaign package never imports the AI (SPEC 4.2): whoever
 * drives a campaign (tools, the app) wraps `runBattle` with the controllers it wants (AI on both sides, the player's
 * orders) and hands the campaign this function. The campaign only builds inputs and reads results.
 */
import type { BattleInput, BattleResult } from "@tcs/sim";

export interface RunnerOptions {
  /** Called now and then with the battle seconds run so far (a progress bar; auto-resolve, M12.2/12.3). */
  onProgress?(seconds: number): void;
}

export type BattleRunner = (input: BattleInput, opts: RunnerOptions) => BattleResult;
