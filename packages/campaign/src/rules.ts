/** The campaign's rules between battles (`core/campaign.json`, M12; game values). */
import type { CampaignT, DataSet } from "@tcs/data";

export type CampaignRules = CampaignT["campaign"];

export function campaignRules(data: DataSet): CampaignRules {
  if (!data.campaign) throw new Error("no core/campaign.json in the data set");
  return data.campaign.campaign;
}
