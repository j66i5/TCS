/**
 * Save and load in the browser (from the `main.ts` split, D2): the save is kept with the URL it was made under (the
 * same URL rebuilds the same battle), together with the battle record so far (the review covers the whole battle).
 * M12.1b (plan Q-E (a)): a campaign battle (`?campaign=<slot>`) keeps this one mid-battle save, tagged with its
 * campaign slot; it loads only into a battle of the same slot (and a plain battle's save only outside a campaign).
 * Review M12: and only into the battle of the same campaign record (`setCampaignKey`, the record's hash).
 */
import { createSim, loadGame, readRecord, saveGame, ticksToSeconds, type BattleInput, type BattleRecord, type Controller, type SaveGame, type Sim } from "@tcs/sim";
import type { App } from "./app";

const SAVE_KEY = "tcs.save";

/** The campaign slot of the battle a URL starts (`?campaign=<slot>`), or null. */
export function campaignSlotOf(search: string): string | null {
  const v = new URLSearchParams(search).get("campaign");
  return v === null || v === "" ? null : v;
}

/** Review M12: the hash of the campaign record the battle on this page is fought for (null: not a campaign battle).
 *  main.ts sets it; the mid-battle save carries it and loads only into a battle of the same record (a slot alone
 *  matched an old save of an earlier node on the same sector). */
let campaignKey: string | null = null;
export function setCampaignKey(k: string | null): void { campaignKey = k; }

/** Does a stored mid-battle save belong to this battle's campaign slot (both null: not a campaign battle) and, in a
 *  campaign battle, to the same campaign record (`key`; review M12)? */
export function saveMatchesSlot(blob: { campaignSlot?: string | null; campaignKey?: string | null }, slot: string | null, key: string | null = null): boolean {
  if ((blob.campaignSlot ?? null) !== slot) return false;
  return slot === null || (blob.campaignKey ?? null) === key;
}

/** The campaign slot the stored mid-battle save belongs to (null: a plain battle, or none stored). */
export function midBattleSaveSlot(): string | null {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    return raw ? (JSON.parse(raw) as { campaignSlot?: string | null }).campaignSlot ?? null : null;
  } catch { return null; }
}

/** The battle from `?load=1` (the stored save), or a fresh one; `failed`: a save was there and could not be read. */
export function loadOrCreate(input: BattleInput, ai: Controller[], load: boolean): { sim: Sim; record: BattleRecord | null; failed: boolean } {
  if (!load) return { sim: createSim(input), record: null, failed: false };
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (raw) {
      const blob = JSON.parse(raw) as { save: SaveGame; record?: unknown; campaignSlot?: string | null; campaignKey?: string | null };
      // (A campaign battle's save loads only into its slot's battle of the same record.)
      if (!saveMatchesSlot(blob, campaignSlotOf(location.search), campaignKey)) return { sim: createSim(input), record: null, failed: true };
      // (A record from before D2, or another version: the review starts at the load.)
      return { sim: loadGame(input, blob.save, ai), record: readRecord(blob.record), failed: false };
    }
  } catch { return { sim: createSim(input), record: null, failed: true }; } // e.g. made with other data: a fresh battle, and we say so
  return { sim: createSim(input), record: null, failed: false };
}

export function saveNow(a: App): void {
  const t = ticksToSeconds(a.sim.state.tick);
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify({ url: location.search, campaignSlot: campaignSlotOf(location.search), ...(campaignKey !== null ? { campaignKey } : {}), save: saveGame(a.sim, a.ai), record: a.record }));
    a.hud.radio(a.strings.t("app.saved"), t, "#d8e0c8");
  } catch { a.hud.radio(a.strings.t("app.saveFailed"), t, "#ffb4b4"); }
}

/** Reload the page on the saved battle's URL with `load=1`. */
export function reloadSaved(a: App): void {
  let raw: string | null;
  try { raw = localStorage.getItem(SAVE_KEY); } catch { raw = null; }
  if (!raw) { a.hud.radio(a.strings.t("app.noSave"), ticksToSeconds(a.sim.state.tick), "#ffb4b4"); return; }
  const q = new URLSearchParams((JSON.parse(raw) as { url: string }).url);
  q.set("load", "1");
  location.search = q.toString();
}
