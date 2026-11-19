/**
 * A PLAYED CAMPAIGN BATTLE (M12.3): `?campaign=<slot>&play=1` (main.ts) plays the main battle of the node the record
 * in that slot has confirmed (phase "battle"): the same input `battleInputs` builds for the auto-resolve, the player
 * blue, the enemy's AI by its plan. At the end the review offers "Back to the campaign": the result (`battleResultOf`
 * with the logistics gathered from the events) goes to the store's pending slot and the campaign page applies it
 * (`?campaign=1&finish=1`), the flank battle auto-resolved there.
 */
import { battleInputs, phaseOf, type CampaignRecord } from "@tcs/campaign";
import type { DataSet } from "@tcs/data";
import type { BattleInput, BattleResult } from "@tcs/sim";
import { browserCampaignStore } from "../campaign-store";

export interface CampaignBattle { slot: string; record: CampaignRecord; input: BattleInput }

/** The battle to play, or an Error saying why there is none. */
export async function loadCampaignBattle(data: DataSet, slot: string): Promise<CampaignBattle> {
  const l = await browserCampaignStore(data).load(slot);
  const record = l.save.record;
  if (phaseOf(record) !== "battle") throw new Error(`the campaign in slot '${slot}' has no battle ready (phase ${phaseOf(record) ?? "none"})`);
  const nb = battleInputs(data, record);
  if (!nb.main) throw new Error("the enemy has nothing to commit: the node is won without a battle (auto-resolve it)");
  return { slot, record, input: nb.main.input };
}

/** Hand the played battle's result to the campaign page and go there. */
export async function returnToCampaign(data: DataSet, b: CampaignBattle, result: BattleResult, look: string): Promise<void> {
  await browserCampaignStore(data).putPending(b.record.battles, JSON.stringify(result));
  location.search = `?campaign=1&finish=1&look=${encodeURIComponent(look)}`;
}
