/**
 * The page's side of the campaign worker (M12.3): one request at a time per kind; `cancel()` terminates the worker
 * (cancel-safe: the record the page holds is untouched; a new worker starts with the next request). Without Web
 * Workers (or `inline`: tests) the same functions run on the main thread.
 */
import type { CampaignRecord } from "@tcs/campaign";
import type { DataSet } from "@tcs/data";
import type { BattleResult } from "@tcs/sim";
import { finishNode, nodeTotals, sectorPreview, type NodeProgress, type SectorPreview } from "./resolve";

export interface ResolveCallbacks {
  onStart(totals: { main: number | null; flank: number | null }): void;
  onProgress(p: NodeProgress): void;
}

export class CancelledError extends Error { constructor() { super("cancelled"); this.name = "CancelledError"; } }

type Pending = { resolve(v: unknown): void; reject(e: Error): void; cb?: ResolveCallbacks };

export class CampaignWorker {
  private worker: Worker | null = null;
  private seq = 0;
  private readonly pending = new Map<number, Pending>();

  constructor(private readonly data: DataSet, private readonly inline = typeof Worker === "undefined") {}

  private get(): Worker {
    if (this.worker) return this.worker;
    const w = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    w.onmessage = (ev: MessageEvent<{ id: number; kind: string; [k: string]: unknown }>) => {
      const m = ev.data, p = this.pending.get(m.id);
      if (!p) return;
      if (m.kind === "start") p.cb?.onStart(m["totals"] as { main: number | null; flank: number | null });
      else if (m.kind === "progress") p.cb?.onProgress({ which: m["which"] as "main" | "flank", seconds: m["seconds"] as number });
      else if (m.kind === "done") { this.pending.delete(m.id); p.resolve(m["record"]); }
      else if (m.kind === "preview") { this.pending.delete(m.id); p.resolve(m["preview"]); }
      else if (m.kind === "error") { this.pending.delete(m.id); p.reject(new Error(String(m["message"]))); }
    };
    w.onerror = (e) => { for (const [, p] of this.pending) p.reject(new Error(e.message || "worker failed")); this.pending.clear(); this.worker?.terminate(); this.worker = null; };
    this.worker = w;
    return w;
  }

  /** The node's battles resolved (`played`: the played main battle's result) -> the record in "after-battle". */
  resolve(record: CampaignRecord, played: BattleResult | null, cb: ResolveCallbacks): Promise<CampaignRecord> {
    if (this.inline) {
      return new Promise((res, rej) => setTimeout(() => {
        try { res(finishNode(this.data, record, played, cb.onProgress, (nb) => cb.onStart(nodeTotals(nb)))); } catch (e) { rej(e instanceof Error ? e : new Error(String(e))); }
      }, 0));
    }
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, cb });
      this.get().postMessage({ id, kind: "resolve", record, played });
    });
  }

  preview(record: CampaignRecord, look: "photo" | "flat", maxPx: number): Promise<SectorPreview | null> {
    if (this.inline) return new Promise((res, rej) => setTimeout(() => { try { res(sectorPreview(this.data, record, look, maxPx)); } catch (e) { rej(e instanceof Error ? e : new Error(String(e))); } }, 0));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.get().postMessage({ id, kind: "preview", record, look, maxPx });
    });
  }

  /** Stop whatever runs (the auto-resolve): every waiting request is rejected with `CancelledError`. */
  cancel(): void {
    this.worker?.terminate();
    this.worker = null;
    for (const [, p] of this.pending) p.reject(new CancelledError());
    this.pending.clear();
  }
}
