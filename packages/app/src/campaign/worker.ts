/**
 * The campaign's Web Worker (M12.3): auto-resolves a node's battles (or applies a played battle's result, the flank
 * battle auto-resolved here) and paints the briefing's sector preview, so the phone's page stays responsive. Cancel:
 * the page terminates the worker; the record it sent is unchanged (every campaign step is a pure function).
 *
 * In:  { id, kind: "resolve", record, played: BattleResult | null } | { id, kind: "preview", record, look, maxPx }
 * Out: { id, kind: "start", totals } · { id, kind: "progress", which, seconds } · { id, kind: "done", record }
 *      · { id, kind: "preview", preview } · { id, kind: "error", message }
 */
import type { CampaignRecord } from "@tcs/campaign";
import type { BattleResult } from "@tcs/sim";
import { loadBundledData } from "../data";
import { finishNode, nodeTotals, sectorPreview } from "./resolve";

type In = { id: number; kind: "resolve"; record: CampaignRecord; played: BattleResult | null } | { id: number; kind: "preview"; record: CampaignRecord; look: "photo" | "flat"; maxPx: number };

const { data } = loadBundledData();
const post = (m: unknown, transfer: Transferable[] = []) => (self as unknown as { postMessage(m: unknown, t: Transferable[]): void }).postMessage(m, transfer);

self.onmessage = (ev: MessageEvent<In>) => {
  const m = ev.data;
  try {
    if (!data) throw new Error("data failed to load");
    if (m.kind === "resolve") {
      let last = -1;
      const record = finishNode(data, m.record, m.played, (p) => {
        // (At most a message per 10 battle seconds and battle.)
        if (p.seconds !== last) { last = p.seconds; post({ id: m.id, kind: "progress", which: p.which, seconds: p.seconds }); }
      }, (nb) => post({ id: m.id, kind: "start", totals: nodeTotals(nb) }));
      post({ id: m.id, kind: "done", record });
    } else {
      const p = sectorPreview(data, m.record, m.look, m.maxPx);
      post({ id: m.id, kind: "preview", preview: p }, p ? [p.rgba.buffer as ArrayBuffer] : []);
    }
  } catch (e) {
    post({ id: m.id, kind: "error", message: e instanceof Error ? e.message : String(e) });
  }
};
