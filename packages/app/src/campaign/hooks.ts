/**
 * The scenario hooks every campaign battle is built with (review M12): the defence's hulls start on their posts
 * (ai `defenceStartPosts`, balance pass 4), as in the tools' batches and CLI (`ON_POSTS`) the campaign was tuned with
 * and in the app's single battles. Auto-resolve, the played battle and the sector preview all use it, so a save
 * resolved on the phone gives the same record as the same save run by the tools.
 */
import { defenceStartPosts } from "@tcs/ai";
import type { ScenarioHooks } from "@tcs/scenario";

export const CAMPAIGN_HOOKS: ScenarioHooks = { defenceStartPosts };
