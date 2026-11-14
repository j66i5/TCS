/**
 * Save and load in the browser (from the `main.ts` split, D2): the save is kept with the URL it was made under (the
 * same URL rebuilds the same battle), together with the battle record so far (the review covers the whole battle).
 */
import { createSim, loadGame, readRecord, saveGame, ticksToSeconds, type BattleInput, type BattleRecord, type Controller, type SaveGame, type Sim } from "@tcs/sim";
import type { App } from "./app";

const SAVE_KEY = "tcs.save";

/** The battle from `?load=1` (the stored save), or a fresh one; `failed`: a save was there and could not be read. */
export function loadOrCreate(input: BattleInput, ai: Controller[], load: boolean): { sim: Sim; record: BattleRecord | null; failed: boolean } {
  if (!load) return { sim: createSim(input), record: null, failed: false };
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (raw) {
      const blob = JSON.parse(raw) as { save: SaveGame; record?: unknown };
      // (A record from before D2, or another version: the review starts at the load.)
      return { sim: loadGame(input, blob.save, ai), record: readRecord(blob.record), failed: false };
    }
  } catch { return { sim: createSim(input), record: null, failed: true }; } // e.g. made with other data: a fresh battle, and we say so
  return { sim: createSim(input), record: null, failed: false };
}

export function saveNow(a: App): void {
  const t = ticksToSeconds(a.sim.state.tick);
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify({ url: location.search, save: saveGame(a.sim, a.ai), record: a.record }));
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
