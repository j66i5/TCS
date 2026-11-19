/**
 * THE CAMPAIGN SCREENS (M12.3, plan m12-roster 4.6): phone first, both looks (photo and flat), every text through the
 * string table. They only lay out what the app gives them: plain views of the campaign record (`@tcs/campaign`
 * view.ts builds them; the interfaces below are the parts the screens read, so the ui package needs no campaign
 * import) and callbacks for what the player taps. One screen at a time fills the whole window:
 *
 *   home (new campaign: faction, carriers, operations / endless; continue; slots: load, save, rename, delete, export;
 *   import) · battalion (the tree with strength, able / wounded / recovering bars, ammunition, hulls) · briefing (the
 *   node, a sector preview, kind, enemy estimate, time of day; choose forces with the proposed default and the cap;
 *   play or auto-resolve) · man card (skills with experience, condition, wounds and days, service history with its
 *   stress peaks, his squad, "Make leader") · after battle (what changed; the operation's progress) · replenishment ·
 *   auto-resolve progress (cancel).
 */
import type { Strings } from "@tcs/data";

export type CampaignLook = "photo" | "flat";

// ------------------------------------------------------------------------------------------------ the views read

export interface CmpHull { vehicleId: string; nameKey: string; state: "service" | "workshop" | "lost"; status?: string; days?: number }
export interface CmpUnit {
  key: string; callsign: string; echelon: string; depth: number;
  places: number; men: number; able: number; wounded: number; recovering: number; lost: number;
  leader: string | null; ammo: number | null; hulls: CmpHull[]; children: CmpUnit[];
}
export interface CmpMember { personId: string; given: string; family: string; rank: string; role: string; status: string; leader: boolean }
export interface CmpServiceEntry { battle: number; underFireMin: number; contactMin: number; rounds: number; wounds: number; peakShock: number; peakStrain: number; strainAfter: number; xp: number; status: string }
export interface CmpMan {
  record: { personId: string; given: string; family: string; rank: string; role: string; skills: Record<string, number>; fatigue: number; stress: number; strain?: number; status: string; wounds: { severity: number }[]; recoveryDays?: number };
  faction: string; where: string; unitKey: string; callsign: string; days?: number; leftIn?: number;
  isLeader: boolean; canMakeLeader: boolean; service: CmpServiceEntry[];
  peaks: { shock: number; strain: number; underFire: number; battles: number };
  squad: CmpMember[];
}
export interface CmpStep { node: string; result: string; walkover?: boolean; flank?: { node: string; result: string; walkover?: boolean }; end?: string }
export interface CmpSelectable { key: string; what: string; company?: string; men: number; callsign: string; hulls: number }
export interface CmpBriefing {
  operation: number; endless: boolean; node: string; kind: string; attacker: "player" | "enemy"; pos: number; lineLength: number;
  sector: { id: number; mapKind: string; widthM: number; heightM: number; battles: number; wrecks: number; craters: number };
  flank: { node: string; kind: string } | null; hours: number; seconds: number;
  selectables: CmpSelectable[]; choice: string[]; proposed: string[]; problems: string[];
  cap: { platoons: number; companyHq: boolean; mortarSections: number; missileTeams: number; aglTeams: number; tankSections: number };
  own: { men: number; hulls: number }; enemy: { men: number; platoons: number; hulls: { nameKey: string; count: number }[] };
  steps: CmpStep[]; ableShare: number;
}
export interface CmpChangedMan { personId: string; given: string; family: string; rank: string; role: string; callsign: string; days?: number; xp?: number; replaced?: string; how?: string }
export interface CmpSideCount { in: number; killed: number; evacuated: number; captured: number; missing: number }
export interface CmpAfter {
  result: string; walkover: boolean;
  battles: { index: number; flank: boolean; node: string; kind: string; mapKind: string; winner: "player" | "enemy" | null; endReason: string; durationS: number;
    men: { player: CmpSideCount; enemy: CmpSideCount }; hulls: { player: { in: number; workshop: number; lost: number }; enemy: { in: number; workshop: number; lost: number } } }[];
  killed: CmpChangedMan[]; wounded: CmpChangedMan[]; captured: CmpChangedMan[]; missing: CmpChangedMan[];
  experience: { men: number; total: number; top: CmpChangedMan[] }; leaders: CmpChangedMan[]; rejoined: CmpChangedMan[];
  fired: { calibre: string; kind: string; rounds: number }[];
  hullsLost: CmpHull[]; hullsWorkshop: CmpHull[]; hullsRepaired: CmpHull[]; prisonersTaken: number;
  steps: CmpStep[]; end: string | null; next: { node: string; pos: number } | null; endless: boolean; lineLength: number;
}
export interface CmpReplenishment {
  replacements: CmpChangedMan[]; rejoined: CmpChangedMan[]; hullsReplaced: CmpHull[]; hullsRepaired: CmpHull[];
  rounds: number; litres: number; days: number; men: number; ableShare: number;
}
export interface CmpSlot { slotName: string; savedAt: string; auto: boolean; faction: string; enemy: string; mode: string; battles: number; operation: number; operationBattles: number }

/** The header every screen shares: the campaign's factions and clock (absent on home without a campaign). */
export interface CmpHeader { faction: string; enemy: string; hours: number; mode: string; operation: number; slot: string | null }

// ------------------------------------------------------------------------------------------------ the screens

export type CampaignScreen =
  | { kind: "home"; current: CmpSlot | null; slots: CmpSlot[]; factions: string[]; busy?: string; message?: { text: string; bad?: boolean } }
  | { kind: "battalion"; unit: CmpUnit; faction: string; expanded: ReadonlySet<string>; members: Record<string, CmpMember[]> }
  | { kind: "briefing"; b: CmpBriefing; faction: string; enemy: string; phase: string; preview: HTMLCanvasElement | null; message?: { text: string; bad?: boolean } }
  | { kind: "man"; man: CmpMan; message?: { text: string; bad?: boolean } }
  | { kind: "after"; a: CmpAfter; faction: string; phase: string }
  | { kind: "replenishment"; r: CmpReplenishment; faction: string }
  | { kind: "progress"; title: string; bars: { label: string; seconds: number; total: number }[]; note?: string };

export interface CampaignUiCallbacks {
  onNew(o: { faction: string; carriers: "tracked" | "wheeled"; mode: "operations" | "endless" }): void;
  onContinue(): void;
  onLoad(slot: string): void;
  onSaveAs(name: string): void;
  onRename(slot: string, name: string): void;
  onDelete(slot: string): void;
  onExport(slot: string): void;
  onImport(): void;
  onSingleBattle(): void;
  onHome(): void;
  onBack(): void;
  onBattalion(): void;
  onToggleUnit(key: string): void;
  onMan(personId: string): void;
  onMakeLeader(personId: string): void;
  onToggleChoice(key: string): void;
  onProposed(): void;
  onPlay(): void;
  onAuto(): void;
  onRevise(): void;
  onProceed(): void;
  onCancel(): void;
  onLook(look: CampaignLook): void;
}

export interface CampaignUi {
  show(screen: CampaignScreen, header: CmpHeader | null): void;
  /** The progress screen's bars only (no rebuild). */
  progress(bars: { label: string; seconds: number; total: number }[]): void;
  setLook(look: CampaignLook): void;
  readonly root: HTMLElement;
}

/** Hour of the day the campaign's clock starts at (display only: battles are fought in daylight in stage one). */
export const CAMPAIGN_START_HOUR = 6;

/** "Day 3, 18:00" from the campaign's hours. */
export function campaignClock(hours: number): { day: number; hh: string; mm: string } {
  const t = hours + CAMPAIGN_START_HOUR;
  const day = Math.floor(t / 24) + 1;
  const h = Math.floor(t % 24), m = Math.floor((t * 60) % 60);
  return { day, hh: String(h).padStart(2, "0"), mm: String(m).padStart(2, "0") };
}

type Child = Node | string | null | undefined | false;
function h(tag: string, cls = "", ...kids: Child[]): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  for (const k of kids) if (k !== null && k !== undefined && k !== false) e.append(k);
  return e;
}
function btn(text: string, cls: string, on: () => void, data?: Record<string, string>): HTMLButtonElement {
  const b = h("button", `cmp-btn ${cls}`, text) as HTMLButtonElement;
  b.type = "button";
  b.onclick = (ev) => { ev.stopPropagation(); on(); };
  if (data) for (const [k, v] of Object.entries(data)) b.dataset[k] = v;
  return b;
}
const pct = (x: number) => `${Math.round(100 * x)}%`;
const sum = (xs: readonly number[]) => xs.reduce((s, x) => s + x, 0);

export function createCampaignUi(parent: HTMLElement, s: Strings, cb: CampaignUiCallbacks, look: CampaignLook): CampaignUi {
  const root = h("div", `cmp look-${look}`);
  root.dataset["screen"] = "none";
  parent.append(root);
  let current: CampaignLook = look;
  const t = (k: string, p: Record<string, string | number> = {}, f?: string) => s.t(k, p, f);
  const rank = (f: string, r: string) => t(`rank.${f}.${r}`, {}, f);
  const role = (f: string, r: string) => t(`role.${f}.${r}`, {}, f);
  const echelon = (e: string) => (s.has(`cmp.echelon.${e}`) ? t(`cmp.echelon.${e}`) : e);
  const nodeName = (n: string) => (s.has(`cmp.node.${n}`) ? t(`cmp.node.${n}`) : n);
  const resultName = (r: string) => t(`cmp.result.${r}`);
  const hullName = (k: string, f: string) => (s.has(k, f) ? t(k, {}, f) : k);
  let bars: HTMLElement[] = [];

  const header = (hd: CmpHeader | null, title: string, back: boolean): HTMLElement => {
    const bar = h("div", "cmp-top");
    if (back) bar.append(btn("‹", "cmp-back", cb.onBack, { act: "back" }));
    const tt = h("div", "cmp-title", title);
    bar.append(tt);
    if (hd) {
      const c = campaignClock(hd.hours);
      bar.append(h("div", "cmp-clock", t("cmp.clock", { day: c.day, time: `${c.hh}:${c.mm}` })));
    }
    const lk = btn(t(`cmp.look.${current}`), "cmp-look", () => cb.onLook(current === "photo" ? "flat" : "photo"), { act: "look" });
    bar.append(lk);
    return bar;
  };
  const sub = (hd: CmpHeader | null): HTMLElement | null => {
    if (!hd) return null;
    return h("div", "cmp-sub",
      `${t(`faction.${hd.faction}`, {}, hd.faction)} — ${t(`faction.${hd.enemy}`, {}, hd.enemy)} · ${t(`cmp.mode.${hd.mode}`)}`
      + (hd.mode === "operations" ? ` · ${t("cmp.operationN", { n: hd.operation })}` : "")
      + (hd.slot ? ` · ${t("cmp.slotShown", { slot: hd.slot === "auto" ? t("cmp.slot.auto") : hd.slot })}` : ""));
  };
  const msg = (m?: { text: string; bad?: boolean }) => (m ? h("div", `cmp-msg${m.bad ? " bad" : ""}`, m.text) : null);
  const section = (title: string, ...kids: Child[]) => h("section", "cmp-card", h("h3", "cmp-h", title), ...kids);
  /** A strength bar: able, walking wounded, recovering, lost against the places. */
  const strength = (u: Pick<CmpUnit, "places" | "able" | "wounded" | "recovering" | "lost">) => {
    const total = Math.max(1, u.places, u.able + u.wounded + u.recovering + u.lost);
    const bar = h("div", "cmp-bar");
    for (const [k, n] of [["able", u.able], ["wounded", u.wounded], ["recovering", u.recovering], ["lost", u.lost]] as const) {
      if (n <= 0) continue;
      const seg = h("span", `seg ${k}`);
      seg.style.width = `${(100 * n) / total}%`;
      bar.append(seg);
    }
    return bar;
  };
  const meter = (x: number | null, cls: string) => {
    const m = h("div", `cmp-meter ${cls}`);
    const f = h("span", "fill");
    f.style.width = x === null ? "0%" : pct(Math.max(0, Math.min(1, x)));
    if (x !== null && x < 0.34) f.classList.add("low"); else if (x !== null && x < 0.67) f.classList.add("mid");
    m.append(f);
    return m;
  };
  const stepsStrip = (steps: readonly CmpStep[], lineLength: number, endless: boolean, nextNode: string | null, pos: number | null) => {
    const strip = h("div", "cmp-steps");
    steps.forEach((st, i) => {
      const chip = h("span", `cmp-step r-${st.result}`, h("b", "", String(i + 1)), ` ${nodeName(st.node)} · ${resultName(st.walkover ? "walkover" : st.result)}`);
      if (st.flank) chip.append(h("span", "cmp-step-flank", ` (${t("cmp.flankShort")}: ${resultName(st.flank.walkover ? "walkover" : st.flank.result)})`));
      strip.append(chip);
    });
    if (nextNode !== null) strip.append(h("span", "cmp-step next", h("b", "", String(steps.length + 1)), ` ${nodeName(nextNode)}`));
    const info = endless ? t("cmp.endlessInfo") : pos !== null ? t("cmp.lineInfo", { pos, n: lineLength }) : "";
    return h("div", "", strip, info ? h("div", "cmp-note", info) : null);
  };
  const manLine = (m: CmpChangedMan, f: string, extra: string) => {
    const row = h("button", "cmp-row cmp-man-row", h("span", "nm", `${rank(f, m.rank)} ${m.given} ${m.family}`), h("span", "dim", ` · ${m.callsign}`), extra ? h("span", "val", extra) : null) as HTMLButtonElement;
    row.type = "button";
    row.onclick = () => cb.onMan(m.personId);
    return row;
  };
  const manList = (list: readonly CmpChangedMan[], f: string, extra: (m: CmpChangedMan) => string, max = 12) => {
    const box = h("div", "cmp-list");
    for (const m of list.slice(0, max)) box.append(manLine(m, f, extra(m)));
    if (list.length > max) box.append(h("div", "cmp-note", t("cmp.andMore", { n: list.length - max })));
    return box;
  };
  const hullLine = (x: CmpHull, f: string) => h("div", "cmp-row", h("span", "nm", hullName(x.nameKey, f)), h("span", "dim", ` · ${x.vehicleId}`),
    h("span", "val", x.state === "workshop" ? t("cmp.hull.workshopDays", { d: Math.ceil(x.days ?? 0) }) : x.state === "lost" ? t(`cmp.hull.lost.${x.status ?? "destroyed"}`) : t(`vehicle.status.${x.status ?? "ok"}`)));
  const actions = (...b: Child[]) => h("div", "cmp-actions", ...b);

  // -------------------------------------------------------------------------------------------- home
  const home = (sc: Extract<CampaignScreen, { kind: "home" }>, hd: CmpHeader | null) => {
    const body = h("div", "cmp-body");
    body.append(h("div", "cmp-hero", h("div", "cmp-hero-title", t("cmp.home.title")), h("div", "cmp-hero-sub", t("cmp.home.sub"))));
    const m = msg(sc.message); if (m) body.append(m);
    if (sc.busy) body.append(h("div", "cmp-msg", sc.busy));
    if (sc.current) {
      const c = sc.current;
      body.append(section(t("cmp.home.continue"),
        h("div", "cmp-row", h("span", "nm", `${t(`faction.${c.faction}`, {}, c.faction)} — ${t(`faction.${c.enemy}`, {}, c.enemy)}`)),
        h("div", "cmp-note", slotLine(c)),
        actions(btn(t("cmp.home.continueBtn"), "primary", cb.onContinue, { act: "continue" }))));
    }
    // New campaign: faction, carriers, mode.
    const pick = { faction: sc.factions[0] ?? "", carriers: "tracked" as "tracked" | "wheeled", mode: "operations" as "operations" | "endless" };
    const chips = <T extends string>(name: string, opts: readonly T[], label: (o: T) => string, get: () => T, set: (o: T) => void) => {
      const row = h("div", "cmp-chips");
      row.dataset["group"] = name;
      const paint = () => { for (const b of row.querySelectorAll("button")) b.classList.toggle("on", (b as HTMLButtonElement).dataset["val"] === get()); };
      for (const o of opts) row.append(btn(label(o), "chip", () => { set(o); paint(); }, { val: o }));
      paint();
      return row;
    };
    body.append(section(t("cmp.home.new"),
      h("div", "cmp-label", t("cmp.home.faction")),
      chips("faction", sc.factions, (f) => t(`faction.${f}`, {}, f), () => pick.faction, (f) => { pick.faction = f; }),
      h("div", "cmp-label", t("cmp.home.carriers")),
      chips("carriers", ["tracked", "wheeled"] as const, (c) => t(`cmp.carriers.${c}`), () => pick.carriers, (c) => { pick.carriers = c; }),
      h("div", "cmp-label", t("cmp.home.mode")),
      chips("mode", ["operations", "endless"] as const, (c) => t(`cmp.mode.${c}`), () => pick.mode, (c) => { pick.mode = c; }),
      h("div", "cmp-note", t("cmp.home.modeInfo")),
      actions(btn(t("cmp.home.start"), "primary", () => cb.onNew({ ...pick }), { act: "new" }))));
    // Slots.
    const slots = section(t("cmp.home.slots"));
    if (hd) {
      const inp = h("input", "cmp-input") as HTMLInputElement;
      inp.maxLength = 40; inp.placeholder = t("cmp.home.slotName"); inp.dataset["field"] = "slotName";
      slots.append(h("div", "cmp-inline", inp, btn(t("cmp.home.saveAs"), "", () => cb.onSaveAs(inp.value), { act: "saveAs" })));
    }
    if (sc.slots.length === 0) slots.append(h("div", "cmp-note", t("cmp.home.noSlots")));
    for (const sl of sc.slots) {
      const row = h("div", "cmp-slot");
      row.dataset["slot"] = sl.slotName;
      row.append(h("div", "cmp-slot-name", sl.auto ? t("cmp.slot.auto") : sl.slotName), h("div", "cmp-note", `${t(`faction.${sl.faction}`, {}, sl.faction)} — ${t(`faction.${sl.enemy}`, {}, sl.enemy)} · ${slotLine(sl)}`));
      const b = h("div", "cmp-slot-btns", btn(t("cmp.home.load"), "", () => cb.onLoad(sl.slotName), { act: "load" }), btn(t("cmp.home.export"), "", () => cb.onExport(sl.slotName), { act: "export" }));
      if (!sl.auto) {
        b.append(btn(t("cmp.home.rename"), "", () => { const n = prompt(t("cmp.home.renamePrompt"), sl.slotName); if (n !== null) cb.onRename(sl.slotName, n); }, { act: "rename" }));
        b.append(btn(t("cmp.home.delete"), "danger", () => { if (confirm(t("cmp.home.deleteConfirm", { slot: sl.slotName }))) cb.onDelete(sl.slotName); }, { act: "delete" }));
      }
      row.append(b);
      slots.append(row);
    }
    slots.append(actions(btn(t("cmp.home.import"), "", cb.onImport, { act: "import" })));
    body.append(slots);
    body.append(actions(btn(t("cmp.home.single"), "ghost", cb.onSingleBattle, { act: "single" })));
    return body;
  };
  const slotLine = (sl: CmpSlot) => [
    t(`cmp.mode.${sl.mode}`),
    sl.mode === "operations" ? t("cmp.slot.op", { op: sl.operation, b: sl.operationBattles }) : "",
    t("cmp.slot.battles", { n: sl.battles }),
    sl.savedAt ? sl.savedAt.replace("T", " ").slice(0, 16) : "",
  ].filter((x) => x).join(" · ");

  // -------------------------------------------------------------------------------------------- battalion
  const battalion = (sc: Extract<CampaignScreen, { kind: "battalion" }>) => {
    const body = h("div", "cmp-body");
    const u0 = sc.unit;
    const top = section(t("cmp.bat.title", { callsign: u0.callsign }),
      strength(u0),
      h("div", "cmp-legend", ...(["able", "wounded", "recovering", "lost"] as const).map((k) => h("span", `lg ${k}`, t(`cmp.bat.${k}`, { n: u0[k] })))),
      h("div", "cmp-note", t("cmp.bat.summary", { men: u0.men, places: u0.places, hulls: u0.hulls.filter((x) => x.state === "service").length, all: u0.hulls.length, ammo: u0.ammo === null ? "-" : pct(u0.ammo) })));
    body.append(top);
    const list = h("div", "cmp-tree");
    const row = (u: CmpUnit) => {
      const open = sc.expanded.has(u.key);
      const hasKids = u.children.length > 0 || u.men > 0;
      const r = h("div", `cmp-unit d${Math.min(u.depth, 4)}${open ? " open" : ""}`);
      r.dataset["unit"] = u.key;
      const head = h("button", "cmp-unit-head",
        h("span", "tw", hasKids ? (open ? "▾" : "▸") : "·"),
        h("span", "nm", u.callsign), h("span", "dim", ` ${echelon(u.echelon)}`),
        h("span", "val", `${u.able + u.wounded}/${u.places}`)) as HTMLButtonElement;
      head.type = "button";
      head.onclick = () => cb.onToggleUnit(u.key);
      const svc = u.hulls.filter((x) => x.state === "service").length;
      const info = h("div", "cmp-unit-info", strength(u), meter(u.ammo, "ammo"),
        h("span", "cmp-tag", u.ammo === null ? t("cmp.bat.noAmmo") : t("cmp.bat.ammo", { p: pct(u.ammo) })),
        u.hulls.length > 0 ? h("span", `cmp-tag${svc < u.hulls.length ? " warn" : ""}`, t("cmp.bat.hulls", { n: svc, all: u.hulls.length })) : null,
        u.recovering > 0 ? h("span", "cmp-tag rec", t("cmp.bat.recoveringN", { n: u.recovering })) : null);
      r.append(head, info);
      list.append(r);
      if (!open) return;
      const members = sc.members[u.key] ?? [];
      for (const m of members) {
        const mr = h("button", "cmp-row cmp-man-row", h("span", "nm", `${m.leader ? "★ " : ""}${rank(sc.faction, m.rank)} ${m.given} ${m.family}`), h("span", "dim", ` · ${role(sc.faction, m.role)}`),
          m.status !== "fit" ? h("span", "val warn", t(`cmp.status.${m.status}`)) : null) as HTMLButtonElement;
        mr.type = "button";
        mr.classList.add(`d${Math.min(u.depth + 1, 5)}`);
        mr.onclick = () => cb.onMan(m.personId);
        mr.dataset["person"] = m.personId;
        list.append(mr);
      }
      for (const hl of u.hulls.filter((x) => x.state !== "service" && u.children.every((c) => !c.hulls.includes(x)))) list.append(hullLine(hl, sc.faction));
      for (const c of u.children) row(c);
    };
    for (const c of u0.children) row(c);
    body.append(list);
    return body;
  };

  // -------------------------------------------------------------------------------------------- man card
  const manCard = (sc: Extract<CampaignScreen, { kind: "man" }>) => {
    const m = sc.man, r = m.record, f = m.faction;
    const body = h("div", "cmp-body");
    const mm = msg(sc.message); if (mm) body.append(mm);
    body.append(h("div", "cmp-man-head",
      h("div", "cmp-man-name", `${r.given} ${r.family}`),
      h("div", "cmp-man-rank", `${rank(f, r.rank)} · ${role(f, r.role)}${m.isLeader ? ` · ${t("cmp.man.leads")}` : ""}`),
      h("div", "cmp-note", `${m.callsign} · ${t(`cmp.where.${m.where}`)}${m.days !== undefined && m.days > 0 ? ` · ${t("cmp.man.days", { d: Math.ceil(m.days) })}` : ""}`)));
    const skills = section(t("cmp.man.skills"));
    const keys = Object.keys(r.skills).sort((a, b) => (a === "experience" ? -1 : b === "experience" ? 1 : a < b ? -1 : 1));
    for (const k of keys) {
      skills.append(h("div", `cmp-skill${k === "experience" ? " xp" : ""}`, h("span", "nm", s.has(`cmp.skill.${k}`) ? t(`cmp.skill.${k}`) : k), meter(r.skills[k]!, "skill"), h("span", "val", pct(r.skills[k]!))));
    }
    const gained = sum(m.service.map((e) => e.xp));
    if (gained > 0) skills.append(h("div", "cmp-note", t("cmp.man.xpGained", { xp: `+${(100 * gained).toFixed(1)}`, n: m.service.length })));
    body.append(skills);
    const worst = r.wounds.reduce((x, w) => Math.max(x, w.severity), 0);
    body.append(section(t("cmp.man.condition"),
      h("div", "cmp-kv", h("span", "", t("cmp.man.status")), h("b", "", t(`cmp.status.${r.status}`))),
      h("div", "cmp-kv", h("span", "", t("cmp.man.fatigue")), meter(r.fatigue, "bad"), h("b", "", pct(r.fatigue))),
      h("div", "cmp-kv", h("span", "", t("cmp.man.shock")), meter(r.stress, "bad"), h("b", "", pct(r.stress))),
      h("div", "cmp-kv", h("span", "", t("cmp.man.strain")), meter(r.strain ?? 0, "bad"), h("b", "", pct(r.strain ?? 0))),
      h("div", "cmp-kv", h("span", "", t("cmp.man.wounds")), h("b", "", r.wounds.length === 0 ? t("cmp.man.noWounds") : t("cmp.man.woundsN", { n: r.wounds.length, worst: t(worst >= 0.6 ? "cmp.sev.critical" : worst >= 0.3 ? "cmp.sev.serious" : "cmp.sev.light") }))),
      m.days !== undefined && m.days > 0 ? h("div", "cmp-kv", h("span", "", t("cmp.man.recovery")), h("b", "", t("cmp.man.days", { d: Math.ceil(m.days) }))) : null));
    const hist = section(t("cmp.man.history"),
      h("div", "cmp-note", t("cmp.man.peaks", { battles: m.peaks.battles, fire: m.peaks.underFire, shock: pct(m.peaks.shock), strain: pct(m.peaks.strain) })));
    if (m.service.length === 0) hist.append(h("div", "cmp-note", t("cmp.man.noService")));
    else {
      const tbl = h("div", "cmp-table");
      tbl.append(h("div", "tr th", ...["cmp.man.col.battle", "cmp.man.col.fire", "cmp.man.col.rounds", "cmp.man.col.shock", "cmp.man.col.xp"].map((k) => h("span", "", t(k)))));
      for (const e of [...m.service].reverse().slice(0, 12)) {
        tbl.append(h("div", `tr${e.wounds > 0 ? " hurt" : ""}`, h("span", "", `#${e.battle + 1}${e.wounds > 0 ? " ✚" : ""}`), h("span", "", `${e.underFireMin.toFixed(1)}′`), h("span", "", String(e.rounds)),
          h("span", "", pct(e.peakShock)), h("span", "", `+${(100 * e.xp).toFixed(1)}`)));
      }
      hist.append(tbl);
    }
    body.append(hist);
    if (m.squad.length > 0) {
      const sq = section(t("cmp.man.squad", { callsign: m.callsign }));
      for (const x of m.squad) {
        const row = h("button", `cmp-row cmp-man-row${x.personId === r.personId ? " me" : ""}`, h("span", "nm", `${x.leader ? "★ " : ""}${rank(f, x.rank)} ${x.given} ${x.family}`), h("span", "dim", ` · ${role(f, x.role)}`)) as HTMLButtonElement;
        row.type = "button";
        row.onclick = () => cb.onMan(x.personId);
        sq.append(row);
      }
      body.append(sq);
    }
    if (m.canMakeLeader) body.append(actions(btn(t("cmp.man.makeLeader"), "primary", () => cb.onMakeLeader(r.personId), { act: "makeLeader" })));
    return body;
  };

  // -------------------------------------------------------------------------------------------- briefing
  const briefing = (sc: Extract<CampaignScreen, { kind: "briefing" }>, hd: CmpHeader | null) => {
    const b = sc.b;
    const body = h("div", "cmp-body");
    const mm = msg(sc.message); if (mm) body.append(mm);
    const c = campaignClock(b.hours);
    body.append(h("div", "cmp-node",
      h("div", "cmp-node-kicker", b.endless ? t("cmp.brief.endless") : t("cmp.brief.kicker", { op: b.operation, pos: b.pos, n: b.lineLength })),
      h("div", "cmp-node-title", nodeName(b.node)),
      h("div", "cmp-note", t(`cmp.nodeInfo.${b.node}`))));
    const prev = h("div", "cmp-preview");
    if (sc.preview) prev.append(sc.preview); else prev.append(h("div", "cmp-preview-wait", t("cmp.brief.previewWait")));
    body.append(prev);
    body.append(section(t("cmp.brief.situation"),
      h("div", "cmp-kv", h("span", "", t("cmp.brief.sector")), h("b", "", t("cmp.brief.sectorV", { map: t(`map.${b.sector.mapKind}`), w: (b.sector.widthM / 1000).toFixed(1), h: (b.sector.heightM / 1000).toFixed(1) }))),
      b.sector.battles > 0 ? h("div", "cmp-kv", h("span", "", t("cmp.brief.foughtHere")), h("b", "", t("cmp.brief.foughtV", { n: b.sector.battles, wrecks: b.sector.wrecks, craters: b.sector.craters }))) : null,
      h("div", "cmp-kv", h("span", "", t("cmp.brief.attacker")), h("b", "", t(`cmp.brief.attacker.${b.attacker}`))),
      h("div", "cmp-kv", h("span", "", t("cmp.brief.time")), h("b", "", t("cmp.brief.timeV", { day: c.day, time: `${c.hh}:${c.mm}`, min: Math.round(b.seconds / 60) }))),
      h("div", "cmp-kv", h("span", "", t("cmp.brief.enemy")), h("b", "", t("cmp.brief.enemyV", { men: b.enemy.men, platoons: b.enemy.platoons }))),
      b.enemy.hulls.length > 0 ? h("div", "cmp-note", b.enemy.hulls.map((x) => `${x.count} × ${hullName(x.nameKey, sc.enemy)}`).join(", ")) : null,
      b.flank ? h("div", "cmp-note flank", t("cmp.brief.flank", { node: nodeName(b.flank.node) })) : null,
      b.steps.length > 0 ? stepsStrip(b.steps, b.lineLength, b.endless, null, null) : null));
    // The choice.
    const choose = sc.phase === "choose";
    const chosen = new Set(b.choice), proposed = new Set(b.proposed);
    const forces = section(t("cmp.brief.forces"),
      h("div", "cmp-note", t("cmp.brief.cap", { p: b.cap.platoons, hq: b.cap.companyHq ? 1 : 0, sup: b.cap.mortarSections + b.cap.missileTeams + b.cap.aglTeams + b.cap.tankSections })));
    let lastCompany: string | undefined = "-";
    for (const x of b.selectables) {
      if (x.company !== lastCompany) {
        lastCompany = x.company;
        const label = x.company ? b.selectables.find((y) => y.key === x.company)?.callsign ?? x.company : t("cmp.brief.support");
        forces.append(h("div", "cmp-label", label));
      }
      const on = chosen.has(x.key);
      const row = h("button", `cmp-pick${on ? " on" : ""}${x.men === 0 ? " empty" : ""}`,
        h("span", "box", on ? "✓" : ""), h("span", "nm", x.what === "hq" ? t("cmp.brief.hq") : x.callsign),
        h("span", "dim", ` ${t(`cmp.what.${x.what}`)}`),
        proposed.has(x.key) ? h("span", "cmp-tag prop", t("cmp.brief.proposed")) : null,
        h("span", "val", t("cmp.brief.menHulls", { men: x.men, hulls: x.hulls }))) as HTMLButtonElement;
      row.type = "button";
      row.dataset["pick"] = x.key;
      row.disabled = !choose;
      row.onclick = () => cb.onToggleChoice(x.key);
      forces.append(row);
    }
    forces.append(h("div", "cmp-total", t("cmp.brief.total", { men: b.own.men, hulls: b.own.hulls, able: pct(b.ableShare) })));
    if (b.problems.length > 0) forces.append(h("div", "cmp-msg bad", b.problems.map((p) => problemText(p)).join(" · ")));
    body.append(forces);
    const bar = choose
      ? actions(btn(t("cmp.brief.proposedBtn"), "", cb.onProposed, { act: "proposed" }), btn(t("cmp.brief.battalion"), "", cb.onBattalion, { act: "battalion" }),
        btn(t("cmp.brief.auto"), "", cb.onAuto, { act: "auto" }), btn(t("cmp.brief.play"), "primary", cb.onPlay, { act: "play" }))
      : sc.phase === "battle"
      ? actions(btn(t("cmp.brief.revise"), "", cb.onRevise, { act: "revise" }), btn(t("cmp.brief.auto"), "", cb.onAuto, { act: "auto" }), btn(t("cmp.brief.play"), "primary", cb.onPlay, { act: "play" }))
      : actions(btn(t("cmp.brief.battalion"), "", cb.onBattalion, { act: "battalion" }), btn(t("cmp.brief.choose"), "primary", cb.onProceed, { act: "choose" }));
    bar.classList.add("sticky");
    body.append(bar);
    void hd;
    return body;
  };
  const problemText = (p: string) => {
    const [k, ...rest] = p.split(": ");
    const key = k!.replace(/ .*/, "");
    return s.has(`cmp.problem.${key}`) ? t(`cmp.problem.${key}`, { what: rest.join(": ") || p }) : p;
  };

  // -------------------------------------------------------------------------------------------- after a battle
  const after = (sc: Extract<CampaignScreen, { kind: "after" }>) => {
    const a = sc.a, f = sc.faction;
    const body = h("div", "cmp-body");
    const banner = h("div", `cmp-banner r-${a.result}`, h("div", "big", resultName(a.walkover ? "walkover" : a.result)),
      a.end ? h("div", "", t(`cmp.end.${a.end}`)) : a.next ? h("div", "", t("cmp.after.next", { node: nodeName(a.next.node) })) : null);
    body.append(banner);
    for (const bt of a.battles) {
      const mp = bt.men.player, me = bt.men.enemy;
      body.append(section(bt.flank ? t("cmp.after.flankBattle", { node: nodeName(bt.node) }) : t("cmp.after.mainBattle", { node: nodeName(bt.node) }),
        h("div", "cmp-note", `${t(`map.${bt.mapKind}`)} · ${t("cmp.after.minutes", { m: Math.round(bt.durationS / 60) })} · ${resultName(bt.winner === null ? "draw" : bt.winner === "player" ? "win" : "loss")}`),
        h("div", "cmp-table cols3",
          h("div", "tr th", h("span", "", ""), h("span", "", t("cmp.after.own")), h("span", "", t("cmp.after.enemy"))),
          ...([["in", "cmp.after.in"], ["killed", "cmp.after.killed"], ["evacuated", "cmp.after.evacuated"], ["captured", "cmp.after.captured"], ["missing", "cmp.after.missing"]] as const)
            .map(([k, key]) => h("div", "tr", h("span", "", t(key)), h("span", "", String(mp[k])), h("span", "", String(me[k])))),
          h("div", "tr", h("span", "", t("cmp.after.hullsLost")), h("span", "", `${bt.hulls.player.lost}/${bt.hulls.player.in}`), h("span", "", `${bt.hulls.enemy.lost}/${bt.hulls.enemy.in}`)))));
    }
    if (a.walkover) body.append(h("div", "cmp-msg", t("cmp.after.walkoverInfo")));
    const nameOnly = () => "";
    if (a.killed.length > 0) body.append(section(t("cmp.after.killedList", { n: a.killed.length }), manList(a.killed, f, nameOnly)));
    if (a.wounded.length > 0) body.append(section(t("cmp.after.woundedList", { n: a.wounded.length }), manList(a.wounded, f, (m) => (m.days !== undefined ? t("cmp.man.days", { d: Math.ceil(m.days) }) : ""))));
    if (a.captured.length + a.missing.length > 0) body.append(section(t("cmp.after.capturedList", { n: a.captured.length + a.missing.length }), manList([...a.captured, ...a.missing], f, (m) => (a.missing.includes(m) ? t("cmp.after.missingShort") : t("cmp.after.capturedShort")))));
    body.append(section(t("cmp.after.xp"),
      h("div", "cmp-note", t("cmp.after.xpLine", { n: a.experience.men, avg: a.experience.men > 0 ? `+${((100 * a.experience.total) / a.experience.men).toFixed(1)}` : "0" })),
      manList(a.experience.top, f, (m) => `+${(100 * (m.xp ?? 0)).toFixed(1)}`, 5)));
    if (a.leaders.length > 0) body.append(section(t("cmp.after.leaders"), manList(a.leaders, f, (m) => (m.replaced ? t("cmp.after.replaced", { name: m.replaced }) : t("cmp.after.appointed")))));
    if (a.rejoined.length > 0) body.append(section(t("cmp.after.rejoined"), manList(a.rejoined, f, (m) => t(m.how === "unassigned" ? "cmp.after.unassigned" : "cmp.after.back"))));
    if (a.fired.length > 0) {
      const ammo = section(t("cmp.after.fired", { n: sum(a.fired.map((x) => x.rounds)) }));
      for (const x of a.fired.slice(0, 8)) ammo.append(h("div", "cmp-row", h("span", "nm", x.calibre), h("span", "dim", ` ${x.kind}`), h("span", "val", String(Math.round(x.rounds)))));
      body.append(ammo);
    }
    if (a.hullsLost.length + a.hullsWorkshop.length + a.hullsRepaired.length > 0) {
      const hs = section(t("cmp.after.hulls"));
      for (const x of [...a.hullsLost, ...a.hullsWorkshop, ...a.hullsRepaired]) hs.append(hullLine(x, f));
      body.append(hs);
    }
    if (a.prisonersTaken > 0) body.append(h("div", "cmp-note", t("cmp.after.prisoners", { n: a.prisonersTaken })));
    body.append(section(t("cmp.after.progress"), stepsStrip(a.steps, a.lineLength, a.endless, a.end ? null : a.next?.node ?? null, a.next ? a.next.pos + 1 : null)));
    const bar = actions(btn(t("cmp.brief.battalion"), "", cb.onBattalion, { act: "battalion" }), btn(t("cmp.after.save"), "", cb.onHome, { act: "home" }),
      btn(t(sc.phase === "operation-end" ? "cmp.after.endOp" : sc.phase === "replenishment" ? "cmp.after.toReplenish" : "cmp.after.continue"), "primary", cb.onProceed, { act: "proceed" }));
    bar.classList.add("sticky");
    body.append(bar);
    return body;
  };

  // -------------------------------------------------------------------------------------------- replenishment
  const replenishment = (sc: Extract<CampaignScreen, { kind: "replenishment" }>) => {
    const r = sc.r, f = sc.faction;
    const body = h("div", "cmp-body");
    body.append(h("div", "cmp-banner r-repl", h("div", "big", t("cmp.repl.title")), h("div", "", t("cmp.repl.days", { d: r.days }))));
    body.append(section(t("cmp.repl.men"),
      h("div", "cmp-kv", h("span", "", t("cmp.repl.replacements")), h("b", "", String(r.replacements.length))),
      h("div", "cmp-kv", h("span", "", t("cmp.repl.rejoined")), h("b", "", String(r.rejoined.length))),
      h("div", "cmp-kv", h("span", "", t("cmp.repl.strength")), h("b", "", t("cmp.repl.strengthV", { men: r.men, p: pct(r.ableShare) }))),
      r.replacements.length > 0 ? manList(r.replacements, f, () => t("cmp.repl.green"), 8) : null,
      r.rejoined.length > 0 ? manList(r.rejoined, f, () => t("cmp.after.back"), 8) : null));
    body.append(section(t("cmp.repl.supply"),
      h("div", "cmp-kv", h("span", "", t("cmp.repl.rounds")), h("b", "", String(Math.round(r.rounds)))),
      h("div", "cmp-kv", h("span", "", t("cmp.repl.fuel")), h("b", "", t("cmp.repl.litres", { l: Math.round(r.litres) }))),
      h("div", "cmp-note", t("cmp.repl.refilled"))));
    if (r.hullsReplaced.length + r.hullsRepaired.length > 0) {
      const hs = section(t("cmp.repl.hulls"));
      for (const x of r.hullsReplaced) hs.append(h("div", "cmp-row", h("span", "nm", hullName(x.nameKey, f)), h("span", "dim", ` · ${x.vehicleId}`), h("span", "val", t("cmp.repl.new"))));
      for (const x of r.hullsRepaired) hs.append(h("div", "cmp-row", h("span", "nm", hullName(x.nameKey, f)), h("span", "dim", ` · ${x.vehicleId}`), h("span", "val", t("cmp.repl.repaired"))));
      body.append(hs);
    }
    const bar = actions(btn(t("cmp.brief.battalion"), "", cb.onBattalion, { act: "battalion" }), btn(t("cmp.after.continue"), "primary", cb.onProceed, { act: "proceed" }));
    bar.classList.add("sticky");
    body.append(bar);
    return body;
  };

  // -------------------------------------------------------------------------------------------- progress
  const progressScreen = (sc: Extract<CampaignScreen, { kind: "progress" }>) => {
    const body = h("div", "cmp-body cmp-progress");
    body.append(h("div", "cmp-node-title", sc.title));
    if (sc.note) body.append(h("div", "cmp-note", sc.note));
    bars = [];
    for (const b of sc.bars) {
      const fill = h("span", "fill");
      const lbl = h("div", "cmp-label", "");
      bars.push(fill, lbl);
      body.append(lbl, h("div", "cmp-meter big", fill));
    }
    fillBars(sc.bars);
    body.append(actions(btn(t("cmp.progress.cancel"), "danger", cb.onCancel, { act: "cancel" })));
    return body;
  };
  const fillBars = (bs: { label: string; seconds: number; total: number }[]) => {
    bs.forEach((b, i) => {
      const fill = bars[2 * i], lbl = bars[2 * i + 1];
      if (!fill || !lbl) return;
      const x = b.total > 0 ? Math.min(1, b.seconds / b.total) : 0;
      fill.style.width = pct(x);
      lbl.textContent = t("cmp.progress.bar", { label: b.label, m: Math.floor(b.seconds / 60), s: String(Math.floor(b.seconds % 60)).padStart(2, "0"), total: Math.round(b.total / 60) });
    });
  };

  const titles: Record<CampaignScreen["kind"], string> = {
    home: "cmp.title.home", battalion: "cmp.title.battalion", briefing: "cmp.title.briefing", man: "cmp.title.man", after: "cmp.title.after", replenishment: "cmp.title.replenishment", progress: "cmp.title.progress",
  };
  return {
    root,
    show(sc, hd) {
      root.dataset["screen"] = sc.kind;
      const back = sc.kind === "battalion" || sc.kind === "man";
      const body = sc.kind === "home" ? home(sc, hd) : sc.kind === "battalion" ? battalion(sc) : sc.kind === "man" ? manCard(sc) : sc.kind === "briefing" ? briefing(sc, hd)
        : sc.kind === "after" ? after(sc) : sc.kind === "replenishment" ? replenishment(sc) : progressScreen(sc);
      const scrollWas = root.querySelector(".cmp-scroll")?.scrollTop ?? 0;
      const keep = root.dataset["last"] === sc.kind && (sc.kind === "battalion" || sc.kind === "briefing");
      root.dataset["last"] = sc.kind;
      const scroll = h("div", "cmp-scroll", sub(hd), body);
      root.replaceChildren(header(sc.kind === "home" ? null : hd, t(titles[sc.kind]), back), scroll);
      if (keep) scroll.scrollTop = scrollWas;
    },
    progress(bs) { fillBars(bs); },
    setLook(l) { root.classList.remove(`look-${current}`); current = l; root.classList.add(`look-${l}`); const b = root.querySelector<HTMLButtonElement>("[data-act=look]"); if (b) b.textContent = t(`cmp.look.${l}`); },
  };
}

/**
 * The sector preview (briefing): the painted map (RGBA, `w` x `h` pixels for `widthM` x `heightM` metres) with the
 * buildings' outlines, the objectives, the exits and the player's starting men and hulls on top. Pure canvas drawing.
 */
export interface SectorPreview {
  w: number; h: number; rgba: Uint8ClampedArray<ArrayBuffer>; widthM: number; heightM: number;
  buildings: number[][];
  objectives: { x: number; y: number; r: number; holder: "player" | "enemy" | null }[];
  exits: { x0: number; y0: number; x1: number; y1: number; own: boolean }[];
  men: { x: number; y: number }[];
  hulls: { x: number; y: number }[];
  attacker: "player" | "enemy";
}

export function drawSectorPreview(p: SectorPreview, look: CampaignLook): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = p.w; c.height = p.h;
  c.className = "cmp-map";
  const g = c.getContext("2d");
  if (!g) return c;
  g.putImageData(new ImageData(p.rgba, p.w, p.h), 0, 0);
  const k = p.w / p.widthM;
  g.lineWidth = 1;
  g.fillStyle = look === "photo" ? "rgba(92,84,76,0.9)" : "#8a7f73";
  g.strokeStyle = look === "photo" ? "rgba(30,28,24,0.7)" : "#3b3631";
  for (const poly of p.buildings) {
    if (poly.length < 6) continue;
    g.beginPath();
    g.moveTo(poly[0]! * k, poly[1]! * k);
    for (let i = 2; i < poly.length; i += 2) g.lineTo(poly[i]! * k, poly[i + 1]! * k);
    g.closePath(); g.fill(); g.stroke();
  }
  for (const e of p.exits) {
    g.fillStyle = e.own ? "rgba(90,150,230,0.30)" : "rgba(220,90,80,0.22)";
    g.fillRect(e.x0 * k, e.y0 * k, (e.x1 - e.x0) * k, (e.y1 - e.y0) * k);
  }
  for (const o of p.objectives) {
    g.beginPath(); g.arc(o.x * k, o.y * k, Math.max(4, o.r * k), 0, Math.PI * 2);
    g.strokeStyle = o.holder === "player" ? "#7fb3ff" : o.holder === "enemy" ? "#ff8a7a" : "#f5d061";
    g.lineWidth = 2; g.setLineDash(look === "flat" ? [] : [4, 3]); g.stroke(); g.setLineDash([]);
  }
  g.fillStyle = "#4f8fff";
  for (const m of p.men) g.fillRect(m.x * k - 1, m.y * k - 1, 2, 2);
  g.fillStyle = "#1e4fb0"; g.strokeStyle = "#cfe0ff"; g.lineWidth = 1;
  for (const v of p.hulls) { g.fillRect(v.x * k - 3, v.y * k - 2, 6, 4); g.strokeRect(v.x * k - 3, v.y * k - 2, 6, 4); }
  // The direction of the attack: an arrow from the attacker's edge (the player is west).
  const y = p.h * 0.12, x0 = p.w * (p.attacker === "player" ? 0.08 : 0.92), x1 = p.w * (p.attacker === "player" ? 0.3 : 0.7);
  g.strokeStyle = p.attacker === "player" ? "#7fb3ff" : "#ff8a7a"; g.lineWidth = 3;
  g.beginPath(); g.moveTo(x0, y); g.lineTo(x1, y); g.stroke();
  const d = p.attacker === "player" ? 1 : -1;
  g.beginPath(); g.moveTo(x1, y); g.lineTo(x1 - d * 8, y - 6); g.lineTo(x1 - d * 8, y + 6); g.closePath(); g.fillStyle = g.strokeStyle; g.fill();
  return c;
}
