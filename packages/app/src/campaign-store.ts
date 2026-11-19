/**
 * CAMPAIGN SAVES IN THE BROWSER (M12.1b, plan m12-roster 4.4; owner 2026-11-19: free saving between battles, several
 * slots, export / import). Saves are `CampaignSave` texts (`@tcs/campaign` save.ts: versioned, migrated and repaired
 * on load) kept in IndexedDB behind a small key-value interface (`SaveBackend`), so Node tests use the in-memory one
 * (no fake-indexeddb dependency). Per slot two keys: `save:<slot>` (the save's canonical text, exactly what export
 * gives) and `meta:<slot>` (a few lines for the slot list, so listing never parses whole records).
 *
 * - Named slots (the player's) and the automatic slot `AUTO_SLOT`, written after every battle.
 * - Export: the slot's stored text as a .json download. Import: a file's text read like a stored save (validated,
 *   migrated, ids repaired), stored under a slot; a valid current save imports unchanged, so export -> import ->
 *   export gives the same bytes.
 * - A battle in progress keeps the one mid-battle save (save.ts), tagged with its campaign slot (plan Q-E (a)).
 */
import { AUTO_SLOT, exportSave, makeSave, readSave, type CampaignRecord, type CampaignSave, type LoadedSave } from "@tcs/campaign";
import type { DataSet } from "@tcs/data";

/** The smallest store a save needs (IndexedDB in the browser, a Map in tests). */
export interface SaveBackend {
  get(key: string): Promise<string | undefined>;
  put(key: string, text: string): Promise<void>;
  delete(key: string): Promise<void>;
  keys(): Promise<string[]>;
}

/** In-memory backend (tests; a browser without IndexedDB, e.g. a private window: saves last until the page closes). */
export function memoryBackend(): SaveBackend & { readonly map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    get: (k) => Promise.resolve(map.get(k)),
    put: (k, t) => { map.set(k, t); return Promise.resolve(); },
    delete: (k) => { map.delete(k); return Promise.resolve(); },
    keys: () => Promise.resolve([...map.keys()].sort()),
  };
}

const DB_NAME = "tcs-campaign";
const DB_STORE = "saves";

/** IndexedDB backend (one object store of texts by key); null when the browser has no IndexedDB. */
export function indexedDbBackend(idb: IDBFactory | undefined = globalThis.indexedDB): SaveBackend | null {
  if (!idb) return null;
  let db: Promise<IDBDatabase> | null = null;
  const open = () => db ??= new Promise<IDBDatabase>((resolve, reject) => {
    const req = idb.open(DB_NAME, 1);
    req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains(DB_STORE)) req.result.createObjectStore(DB_STORE); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => { db = null; reject(req.error ?? new Error("IndexedDB open failed")); };
  });
  const run = <T>(mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest): Promise<T> => open().then((d) => new Promise<T>((resolve, reject) => {
    const tx = d.transaction(DB_STORE, mode);
    const req = f(tx.objectStore(DB_STORE));
    tx.oncomplete = () => resolve(req.result as T);
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
  }));
  return {
    get: (k) => run<unknown>("readonly", (s) => s.get(k)).then((v) => (typeof v === "string" ? v : undefined)),
    put: (k, t) => run<unknown>("readwrite", (s) => s.put(t, k)).then(() => undefined),
    delete: (k) => run<unknown>("readwrite", (s) => s.delete(k)).then(() => undefined),
    keys: () => run<IDBValidKey[]>("readonly", (s) => s.getAllKeys()).then((ks) => ks.map(String).sort()),
  };
}

/** A slot as the slot list shows it. */
export interface SlotInfo {
  slotName: string;
  savedAt: string;
  auto: boolean;
  faction: string;
  enemy: string;
  mode: CampaignRecord["mode"];
  /** Battles fought, the operation (1-based) and its battles. */
  battles: number;
  operation: number;
  operationBattles: number;
  bytes: number;
}

export const SLOT_NAME_MAX = 40;
const PENDING_KEY = "pending:result";

/** A slot name the player may use: 1-40 characters after trimming, not the automatic slot's. */
export function validSlotName(name: string): boolean {
  const n = name.trim();
  return n.length > 0 && n.length <= SLOT_NAME_MAX && n !== AUTO_SLOT;
}

function infoOf(save: CampaignSave, bytes: number): SlotInfo {
  const r = save.record;
  return {
    slotName: save.slotName, savedAt: save.savedAt, auto: save.slotName === AUTO_SLOT, faction: r.sides.player.faction, enemy: r.sides.enemy.faction,
    mode: r.mode, battles: r.battles, operation: r.operation.index + 1, operationBattles: r.operation.battles, bytes,
  };
}

export class CampaignStore {
  constructor(private readonly backend: SaveBackend, private readonly data: DataSet) {}

  /** Every slot, the automatic one first, then by name. */
  async slots(): Promise<SlotInfo[]> {
    const out: SlotInfo[] = [];
    for (const k of await this.backend.keys()) {
      if (!k.startsWith("meta:")) continue;
      const t = await this.backend.get(k);
      if (t === undefined) continue;
      try { out.push(JSON.parse(t) as SlotInfo); } catch { /* a broken list entry: the save itself may still load */ }
    }
    return out.sort((a, b) => (a.auto !== b.auto ? (a.auto ? -1 : 1) : a.slotName < b.slotName ? -1 : a.slotName > b.slotName ? 1 : 0));
  }

  private async put(save: CampaignSave): Promise<CampaignSave> {
    const text = exportSave(save);
    await this.backend.put(`save:${save.slotName}`, text);
    await this.backend.put(`meta:${save.slotName}`, JSON.stringify(infoOf(save, text.length)));
    return save;
  }

  /** Save the record in a named slot (overwrites it). `savedAt`: the app's clock, shown in the list. */
  save(slotName: string, record: CampaignRecord, savedAt: string): Promise<CampaignSave> {
    if (!validSlotName(slotName)) return Promise.reject(new Error(`invalid slot name '${slotName}'`));
    return this.put(makeSave(this.data, record, slotName.trim(), savedAt));
  }

  /** The automatic save after a battle. */
  saveAuto(record: CampaignRecord, savedAt: string): Promise<CampaignSave> {
    return this.put(makeSave(this.data, record, AUTO_SLOT, savedAt));
  }

  /** Load a slot (migrated and repaired; throws `SaveError` when it cannot be read, an Error when there is none). */
  async load(slotName: string): Promise<LoadedSave> {
    const text = await this.backend.get(`save:${slotName}`);
    if (text === undefined) throw new Error(`no save in slot '${slotName}'`);
    const loaded = readSave(this.data, text);
    loaded.save.slotName = slotName;
    return loaded;
  }

  async remove(slotName: string): Promise<void> {
    await this.backend.delete(`save:${slotName}`);
    await this.backend.delete(`meta:${slotName}`);
  }

  /** M12.3: a played campaign battle's result waiting to be applied (the battle page hands it to the campaign page):
   *  one at a time, with the battle count of the record it belongs to. */
  putPending(battles: number, resultText: string): Promise<void> {
    return this.backend.put(PENDING_KEY, JSON.stringify({ battles, result: resultText }));
  }

  async pending(): Promise<{ battles: number; result: string } | null> {
    const t = await this.backend.get(PENDING_KEY);
    if (t === undefined) return null;
    try { return JSON.parse(t) as { battles: number; result: string }; } catch { return null; }
  }

  clearPending(): Promise<void> { return this.backend.delete(PENDING_KEY); }

  /** The slot's text as stored (the export file's content). */
  async exportText(slotName: string): Promise<string> {
    const text = await this.backend.get(`save:${slotName}`);
    if (text === undefined) throw new Error(`no save in slot '${slotName}'`);
    return text;
  }

  /** Import a file's text into a slot (its own slot name unless one is given): read like a stored save (validated,
   *  migrated, ids repaired), then stored. Throws `SaveError` on a file that is no readable save. */
  async importText(text: string, slotName?: string): Promise<LoadedSave> {
    const loaded = readSave(this.data, text);
    const name = (slotName ?? loaded.save.slotName).trim();
    loaded.save.slotName = name === AUTO_SLOT || validSlotName(name) ? name : "imported";
    await this.put(loaded.save);
    return loaded;
  }
}

/** The export file's name: `tcs-campaign-<slot>-b<battles>.json` (slot cut to file-safe characters). */
export function exportFileName(save: Pick<CampaignSave, "slotName" | "record">): string {
  const slot = save.slotName.replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, SLOT_NAME_MAX) || "save";
  return `tcs-campaign-${slot}-b${save.record.battles}.json`;
}

/** Offer a text as a file download (export). */
export function downloadText(fileName: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** Ask for a .json file and read its text (import); null when the player cancels. */
export function pickFileText(): Promise<string | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,application/json";
    input.onchange = () => { const f = input.files?.[0]; if (!f) resolve(null); else f.text().then(resolve, () => resolve(null)); };
    input.oncancel = () => resolve(null);
    input.click();
  });
}

/** The campaign store of this browser (IndexedDB, else memory). */
export function browserCampaignStore(data: DataSet): CampaignStore {
  return new CampaignStore(indexedDbBackend() ?? memoryBackend(), data);
}
