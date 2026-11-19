/**
 * THE CAMPAIGN PAGE (M12.3, plan m12-roster 4.6): `?campaign=1` opens it instead of a battle. It holds the campaign
 * record the player works on (kept in the automatic slot after every step, so a reload or a played battle finds it),
 * shows the screens of `@tcs/ui` campaign.ts from the views of `@tcs/campaign` view.ts, and moves the record through
 * the state machine (flow.ts) on the player's taps. Auto-resolve and the sector preview run in a Web Worker
 * (`client.ts`); cancelling leaves the record as it was. A played battle (`?campaign=auto&play=1`, main.ts) hands its
 * result back through the store's pending slot and `?campaign=1&finish=1`, which applies it here (the flank battle
 * auto-resolved) and opens the after-battle card.
 *
 * URL options: `&seconds=<s>` a new campaign's battle length (tests, screenshots); `&seed=<n>` a new campaign's seed
 * (default from the clock); `&fixtures=1` lists the fixture faction; `&look=photo|flat`.
 */
import {
  AUTO_SLOT, afterBattleView, battalionView, briefingView, chooseForces, confirmForces, FlowError, makeLeader, manView, newCampaign, phaseOf, proceed,
  replenishmentView, reviseForces, setChoice, startFlow, unitsOf, type CampaignRecord, type FlowPhase,
} from "@tcs/campaign";
import type { DataSet, Strings } from "@tcs/data";
import type { BattleResult } from "@tcs/sim";
import { createCampaignUi, drawSectorPreview, type CampaignLook, type CampaignScreen, type CmpHeader, type CmpMember, type CmpSlot } from "@tcs/ui";
import { browserCampaignStore, downloadText, exportFileName, pickFileText, validSlotName, type CampaignStore } from "../campaign-store";
import { CampaignWorker, CancelledError } from "./client";

const LOOK_KEY = "tcs.ui.look";
const SLOT_KEY = "tcs.campaign.slot";

type Back = { kind: "home" } | { kind: "battalion" } | { kind: "man"; personId: string } | { kind: "flow" };

export interface CampaignPageHooks {
  /** The page as the debug hook sees it (Playwright drives and checks it). */
  state(): { screen: string; phase: FlowPhase | null; battles: number; hash: string | null; busy: boolean };
}

export async function campaignPage(root: HTMLElement, data: DataSet, strings: Strings, params: URLSearchParams, hashOf: (r: CampaignRecord) => string): Promise<CampaignPageHooks> {
  const store: CampaignStore = browserCampaignStore(data);
  const worker = new CampaignWorker(data);
  let stored: string | null = null;
  try { stored = localStorage.getItem(LOOK_KEY); } catch { /* not remembered */ }
  const lookParam = params.get("look");
  let look: CampaignLook = lookParam === "flat" || lookParam === "pixel" ? "flat" : lookParam === "photo" ? "photo" : stored === "flat" ? "flat" : "photo";
  let record: CampaignRecord | null = null;
  let slotShown: string | null = null;
  try { slotShown = localStorage.getItem(SLOT_KEY); } catch { /* none */ }
  let screen: CampaignScreen["kind"] = "home";
  let busy = false;
  const backStack: Back[] = [];
  const expanded = new Set<string>();
  let preview: { key: string; canvas: HTMLCanvasElement | null } | null = null;
  let message: { text: string; bad?: boolean } | undefined;
  const t = (k: string, p: Record<string, string | number> = {}) => strings.t(k, p);
  const now = () => new Date().toISOString();
  const factions = Object.keys(data.factions).sort().filter((f) => data.factions[f]!.manifest.battalionTemplates !== undefined && (data.factions[f]!.manifest.fixture !== true || params.get("fixtures") === "1"));

  const ui = createCampaignUi(root, strings, {
    onNew: (o) => void guard(async () => {
      const enemy = factions.find((f) => f !== o.faction && data.factions[f]!.manifest.fixture !== true) ?? o.faction;
      const seed = Number(params.get("seed") ?? (Date.now() % 1_000_000_000)) >>> 0;
      const seconds = Number(params.get("seconds") ?? 0);
      let r = newCampaign(data, { seed, faction: o.faction, enemy, carriers: o.carriers, mode: o.mode, ...(seconds > 0 ? { battleSeconds: seconds } : {}) });
      r = startFlow(data, r);
      setSlot(null);
      await commit(r);
      showFlow();
    }),
    onContinue: () => void guard(async () => { await loadSlot(AUTO_SLOT); }),
    onLoad: (slot) => void guard(async () => { await loadSlot(slot); }),
    onSaveAs: (name) => void guard(async () => {
      if (!record) return;
      if (!validSlotName(name)) { message = { text: t("cmp.msg.badName"), bad: true }; await showHome(); return; }
      await store.save(name, record, now());
      setSlot(name.trim());
      message = { text: t("cmp.msg.saved", { slot: name.trim() }) };
      await showHome();
    }),
    onRename: (slot, name) => void guard(async () => {
      if (!validSlotName(name) || name.trim() === slot) { message = { text: t("cmp.msg.badName"), bad: true }; await showHome(); return; }
      const l = await store.load(slot);
      await store.save(name, l.save.record, l.save.savedAt);
      await store.remove(slot);
      if (slotShown === slot) setSlot(name.trim());
      message = { text: t("cmp.msg.renamed", { slot: name.trim() }) };
      await showHome();
    }),
    onDelete: (slot) => void guard(async () => { await store.remove(slot); if (slotShown === slot) setSlot(null); message = { text: t("cmp.msg.deleted", { slot }) }; await showHome(); }),
    onExport: (slot) => void guard(async () => {
      const text = await store.exportText(slot);
      const l = await store.load(slot);
      downloadText(exportFileName(l.save), text);
    }),
    onImport: () => void guard(async () => {
      const text = await pickFileText();
      if (text === null) return;
      try {
        const l = await store.importText(text);
        message = { text: t("cmp.msg.imported", { slot: l.save.slotName }) + warnings(l.warnings.length, l.repairs.length) };
      } catch (e) { message = { text: t("cmp.msg.importFailed", { why: e instanceof Error ? e.message : String(e) }), bad: true }; }
      await showHome();
    }),
    onSingleBattle: () => { location.search = ""; },
    onHome: () => void guard(showHome),
    onBack: () => { const b = backStack.pop(); go(b ?? { kind: "flow" }); },
    onBattalion: () => { push(); show({ kind: "battalion" }); },
    onToggleUnit: (key) => { if (expanded.has(key)) expanded.delete(key); else expanded.add(key); show({ kind: "battalion" }); },
    onMan: (pid) => { push(); show({ kind: "man", personId: pid }); },
    onMakeLeader: (pid) => void guard(async () => {
      if (!record) return;
      try { await commit(makeLeader(data, record, pid)); message = { text: t("cmp.msg.leader") }; } catch (e) { message = { text: e instanceof Error ? e.message : String(e), bad: true }; }
      show({ kind: "man", personId: pid });
    }),
    onToggleChoice: (key) => void guard(async () => {
      if (!record || phaseOf(record) !== "choose") return;
      const c = new Set(record.flow!.choice ?? []);
      if (c.has(key)) c.delete(key); else c.add(key);
      const keys = briefingView(data, record).selectables.map((x) => x.key).filter((k) => c.has(k));
      await commit(setChoice(data, record, keys).record);
      showFlow();
    }),
    onProposed: () => void guard(async () => {
      if (!record || phaseOf(record) !== "choose") return;
      await commit(setChoice(data, record, briefingView(data, record).proposed).record);
      showFlow();
    }),
    onPlay: () => void guard(async () => {
      if (!record) return;
      if (!(await confirm_())) return;
      const q = new URLSearchParams();
      q.set("campaign", AUTO_SLOT); q.set("play", "1"); q.set("look", look);
      location.search = q.toString();
    }),
    onAuto: () => void guard(async () => {
      if (!record || !(await confirm_())) return;
      await autoResolve(null);
    }),
    onRevise: () => void guard(async () => { if (record && phaseOf(record) === "battle") { await commit(reviseForces(record)); showFlow(); } }),
    onProceed: () => void guard(async () => {
      if (!record) return;
      const ph = phaseOf(record);
      if (ph === "briefing") { await commit(chooseForces(data, record)); showFlow(); return; }
      if (ph === "after-battle" || ph === "replenishment" || ph === "operation-end") {
        let r = ph === "after-battle" ? proceed(data, record) : record;
        const p2 = phaseOf(r);
        if (p2 === "replenishment" || p2 === "operation-end") {
          r = proceed(data, r);
          await commit(r);
          show({ kind: "replenishment" });
          return;
        }
        await commit(r);
        showFlow();
        return;
      }
      showFlow();
    }),
    onCancel: () => { worker.cancel(); },
    onLook: (l) => {
      look = l;
      try { localStorage.setItem(LOOK_KEY, l); } catch { /* not remembered */ }
      ui.setLook(l);
      if (screen === "briefing") { preview = null; showFlow(); }
    },
  }, look);

  const warnings = (w: number, r: number) => (w + r > 0 ? ` ${t("cmp.msg.repaired", { w, r })}` : "");
  const setSlot = (s: string | null) => { slotShown = s; try { if (s === null) localStorage.removeItem(SLOT_KEY); else localStorage.setItem(SLOT_KEY, s); } catch { /* not remembered */ } };
  const headerOf = (): CmpHeader | null => (record ? { faction: record.sides.player.faction, enemy: record.sides.enemy.faction, hours: record.hours, mode: record.mode, operation: record.operation.index + 1, slot: slotShown } : null);

  /** One step at a time: a tap while one runs is ignored; an error shows on the screen. */
  async function guard(f: () => Promise<void>): Promise<void> {
    if (busy) return;
    busy = true;
    try { await f(); } catch (e) {
      if (!(e instanceof CancelledError)) { message = { text: e instanceof FlowError ? `${e.message}: ${e.problems.join(", ")}` : e instanceof Error ? e.message : String(e), bad: true }; console.error(e); }
      if (screen === "progress") showFlow(); else rerender();
    } finally { busy = false; }
  }

  /** The record moves on: kept in the automatic slot. */
  async function commit(r: CampaignRecord): Promise<void> {
    record = r;
    await store.saveAuto(r, now());
  }

  async function loadSlot(slot: string): Promise<void> {
    const l = await store.load(slot);
    if (slot !== AUTO_SLOT) setSlot(slot);
    record = startFlow(data, l.save.record);
    await store.saveAuto(record, now());
    message = l.warnings.length + l.repairs.length > 0 ? { text: t("cmp.msg.loaded", { slot }) + warnings(l.warnings.length, l.repairs.length) } : { text: t("cmp.msg.loaded", { slot: slot === AUTO_SLOT ? t("cmp.slot.auto") : slot }) };
    preview = null;
    backStack.length = 0;
    showFlow();
  }

  /** choose -> battle (confirmed); false (and the problems shown) when the choice cannot fight. */
  async function confirm_(): Promise<boolean> {
    if (!record) return false;
    if (phaseOf(record) === "battle") return true;
    if (phaseOf(record) !== "choose") return false;
    try { await commit(confirmForces(data, record)); return true; } catch (e) {
      if (e instanceof FlowError) { message = { text: t("cmp.msg.cannotFight"), bad: true }; showFlow(); return false; }
      throw e;
    }
  }

  async function autoResolve(played: BattleResult | null): Promise<void> {
    if (!record) return;
    const bars: { label: string; seconds: number; total: number }[] = [];
    const which: ("main" | "flank")[] = [];
    screen = "progress";
    ui.show({ kind: "progress", title: t(played ? "cmp.progress.applying" : "cmp.progress.title"), bars: [], note: t("cmp.progress.note") }, headerOf());
    const r = await worker.resolve(record, played, {
      onStart: (totals) => {
        if (totals.flank !== null) { bars.push({ label: t("cmp.progress.flank"), seconds: 0, total: totals.flank }); which.push("flank"); }
        if (totals.main !== null && !played) { bars.push({ label: t("cmp.progress.main"), seconds: 0, total: totals.main }); which.push("main"); }
        ui.show({ kind: "progress", title: t(played ? "cmp.progress.applying" : "cmp.progress.title"), bars, note: t("cmp.progress.note") }, headerOf());
      },
      onProgress: (p) => { const i = which.indexOf(p.which); if (i >= 0) { bars[i]!.seconds = p.seconds; ui.progress(bars); } },
    });
    await commit(r);
    preview = null;
    showFlow();
  }

  function push(): void {
    if (screen === "battalion") backStack.push({ kind: "battalion" });
    else if (screen === "man") backStack.push({ kind: "man", personId: lastMan });
    else if (screen === "home") backStack.push({ kind: "home" });
    else backStack.push({ kind: "flow" });
  }
  function go(b: Back): void {
    if (b.kind === "home") void guard(showHome);
    else if (b.kind === "flow") showFlow();
    else show(b);
  }
  let lastMan = "";
  let lastShown: Back | null = null;
  function rerender(): void {
    if (screen === "home") void showHome();
    else if (lastShown && (lastShown.kind === "battalion" || lastShown.kind === "man")) show(lastShown);
    else showFlow();
  }

  async function showHome(): Promise<void> {
    const slots = (await store.slots()) as CmpSlot[];
    screen = "home";
    lastShown = { kind: "home" };
    const m = message; message = undefined;
    ui.show({ kind: "home", current: slots.find((s) => s.auto) ?? null, slots, factions, ...(m ? { message: m } : {}) }, headerOf());
  }

  function show(b: Exclude<Back, { kind: "home" } | { kind: "flow" }> | { kind: "replenishment" }): void {
    if (!record) { void showHome(); return; }
    const hd = headerOf();
    const m = message; message = undefined;
    if (b.kind === "battalion") {
      const unit = battalionView(data, record);
      if (expanded.size === 0 && unit.children[0]) expanded.add(unit.children[0].key);
      const members: Record<string, CmpMember[]> = {};
      for (const u of unitsOf(record.sides.player.battalion)) if (expanded.has(u.key)) members[u.key] = u.members.map((x, i) => ({ personId: x.personId, given: x.given, family: x.family, rank: x.rank, role: x.role, status: x.status, leader: i === u.leaderIndex }));
      screen = "battalion"; lastShown = b;
      ui.show({ kind: "battalion", unit, faction: record.sides.player.faction, expanded, members }, hd);
    } else if (b.kind === "man") {
      const mv = manView(data, record, b.personId);
      if (!mv) { showFlow(); return; }
      lastMan = b.personId;
      screen = "man"; lastShown = b;
      ui.show({ kind: "man", man: mv, ...(m ? { message: m } : {}) }, hd);
    } else {
      const r = replenishmentView(data, record);
      if (!r) { showFlow(); return; }
      screen = "replenishment"; lastShown = { kind: "flow" };
      ui.show({ kind: "replenishment", r, faction: record.sides.player.faction }, hd);
    }
  }

  /** The screen of the record's phase. */
  function showFlow(): void {
    if (!record) { void showHome(); return; }
    let ph = phaseOf(record);
    if (ph === null) { record = startFlow(data, record); ph = phaseOf(record); }
    lastShown = { kind: "flow" };
    const hd = headerOf();
    const m = message; message = undefined;
    if (ph === "briefing") {
      // (The briefing always opens on the choice: the proposed one.)
      void guardless(async () => { await commit(chooseForces(data, record!)); showFlow(); });
      return;
    }
    if (ph === "choose" || ph === "battle") {
      const b = briefingView(data, record);
      screen = "briefing";
      const key = `${record.battles}/${record.op?.steps.length}/${record.op?.node}/${look}`;
      if (!preview || preview.key !== key) {
        preview = { key, canvas: null };
        const rec = record;
        worker.preview(rec, look, Math.min(900, Math.max(360, Math.round(window.innerWidth * (window.devicePixelRatio || 1))))).then((p) => {
          if (!preview || preview.key !== key) return;
          preview.canvas = p ? drawSectorPreview(p, look) : null;
          if (screen === "briefing" && record === rec) {
            const box = ui.root.querySelector(".cmp-preview");
            if (box) box.replaceChildren(preview.canvas ?? Object.assign(document.createElement("div"), { className: "cmp-preview-wait", textContent: t("cmp.brief.noPreview") }));
          }
        }).catch((e: unknown) => { if (!(e instanceof CancelledError)) console.warn("preview", e); });
      }
      ui.show({ kind: "briefing", b, faction: record.sides.player.faction, enemy: record.sides.enemy.faction, phase: ph, preview: preview.canvas, ...(m ? { message: m } : {}) }, hd);
      return;
    }
    screen = "after";
    const a = afterBattleView(data, record);
    ui.show({ kind: "after", a, faction: record.sides.player.faction, phase: a.end ? "operation-end" : ph ?? "after-battle" }, hd);
  }
  async function guardless(f: () => Promise<void>): Promise<void> { try { await f(); } catch (e) { console.error(e); } }

  // ---- Start: a played battle's result to apply, or home.
  if (params.get("finish") === "1") {
    await guard(async () => {
      const pend = await store.pending();
      const l = await store.load(AUTO_SLOT);
      record = l.save.record;
      if (pend && phaseOf(record) === "battle" && pend.battles === record.battles) {
        await store.clearPending();
        await autoResolve(JSON.parse(pend.result) as BattleResult);
      } else showFlow();
    });
    history.replaceState(null, "", `?campaign=1&look=${look}`);
  } else await showHome();

  return { state: () => ({ screen, phase: record ? phaseOf(record) : null, battles: record?.battles ?? 0, hash: record ? hashOf(record) : null, busy }) };
}
