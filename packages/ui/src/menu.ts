/**
 * THE START MENU (owner 2026-11-20: "a starting menu with the different game modes to choose from"). Shown when the
 * app is opened without parameters. Phone first (big touch targets, one column, 360 x 780 portrait and landscape),
 * both looks, every text through the string table, the factions from data (their `faction.<id>` names; an id
 * without a name shows the id). It only lays out the choices and reports taps: the app turns a launch into the URL
 * parameters it has always understood (app/src/menu-model.ts), so every link made before keeps working.
 *
 *   home: title, Continue (the campaign in progress, the saved battle, the last battle again), the modes
 *   quick: one battle (battle type, task, size, side, forces, tanks, map, time of day, seed; review step 5: the
 *     type and the size, and a line saying what each side gets, from the scenario)
 *   campaign: continue / new (army, carriers, operations or endless) / saves (the campaign page)
 *   hold: hold the village (side, time, seed) · assault: the assault group (part, map, time, seed)
 *   more: the vehicle sandbox (carriers, map, seed) and the look
 *
 * It reuses the campaign screens' frame (`.cmp`: top bar, cards, chips, sticky actions) so the two look alike.
 */
import type { Strings } from "@tcs/data";

export type MenuLook = "photo" | "flat";
export type MenuSide = "blue" | "red";
export type MenuTime = "day" | "dawn" | "dusk" | "night";
export type MenuForces = "foot" | "tracked" | "wheeled";
export type MenuTanks = "standard" | "both" | "none";
export type MenuCarriers = "tracked" | "wheeled";

export const MENU_TIMES: readonly MenuTime[] = ["day", "dawn", "dusk", "night"];
export const MENU_FORCES: readonly MenuForces[] = ["foot", "tracked", "wheeled"];
export const MENU_TANKS: readonly MenuTanks[] = ["standard", "both", "none"];
export const MENU_CARRIERS: readonly MenuCarriers[] = ["tracked", "wheeled"];

/** The quick battle's types (review step 5): the scenario kinds, as `&kind=` takes them ("attack": the platoon attack,
 *  written without `kind=` so the links made before read back the same). */
export type MenuKind = "attack" | "meeting" | "ambush" | "withdrawal" | "defence-counterattack";
export const MENU_KINDS: readonly MenuKind[] = ["attack", "meeting", "ambush", "withdrawal", "defence-counterattack"];
export type MenuSize = "platoon" | "company";
export const MENU_SIZES: readonly MenuSize[] = ["platoon", "company"];

/** `role`: "attack" = the player's side is the scenario's `attacker` (the side on the move through an ambush, the
 *  pursuer of a withdrawal), "defend" = the other; a meeting has no roles. */
export interface QuickChoice { kind: MenuKind; role: "attack" | "defend"; size: MenuSize; side: MenuSide; forces: MenuForces; tanks: MenuTanks; map: string; time: MenuTime }

/** The quick choice as it is launched: a meeting has no roles ("attack": the player's side is named the attacker), a
 *  company brings its own tanks (both sides' sections, the company's support), so those rows are not offered. */
export function normalQuick(c: QuickChoice): QuickChoice {
  return { ...c, ...(c.kind === "meeting" ? { role: "attack" as const } : {}), ...(c.size === "company" ? { tanks: "both" as const } : {}) };
}
export interface HoldChoice { side: MenuSide; time: MenuTime }
export interface AssaultChoice { role: "assault" | "defend"; map: string; time: MenuTime }
export interface SandboxChoice { carriers: MenuCarriers; map: string }
export interface CampaignChoice { faction: string; carriers: MenuCarriers; mode: "operations" | "endless" }
/** Everything the player picked (remembered by the app); the seed is shared by the battle modes. */
export interface MenuChoices { quick: QuickChoice; hold: HoldChoice; assault: AssaultChoice; sandbox: SandboxChoice; campaign: CampaignChoice; seed: number }

export type MenuLaunch =
  | { mode: "quick"; c: QuickChoice; seed: number; look: MenuLook }
  | { mode: "hold"; c: HoldChoice; seed: number; look: MenuLook }
  | { mode: "assault"; c: AssaultChoice; seed: number; look: MenuLook }
  | { mode: "sandbox"; c: SandboxChoice; seed: number; look: MenuLook }
  | { mode: "campaign-new"; c: CampaignChoice; look: MenuLook }
  | { mode: "campaign-continue"; look: MenuLook }
  | { mode: "campaign-saves"; look: MenuLook };

/** A way back in: the campaign in the automatic slot, the mid-battle save, the last battle started from the menu. */
export interface MenuContinue { kind: "campaign" | "saved" | "again"; detail: string }

export type MenuScreen = "home" | "quick" | "campaign" | "hold" | "assault" | "more";
export const MENU_SCREENS: readonly MenuScreen[] = ["home", "quick", "campaign", "hold", "assault", "more"];

export interface MenuModel {
  look: MenuLook;
  /** The battle's two factions, blue then red (data ids). */
  factions: [string, string];
  /** The factions a campaign can be started with (data ids). */
  campaignFactions: string[];
  mapKinds: string[];
  continues: MenuContinue[];
  /** A campaign is in the automatic slot (a new one replaces it: asked first). */
  campaignInProgress: boolean;
  /** The automatic slot has been read (until then "Start a new campaign" is disabled: it could replace a campaign
   *  without asking). Set by `setContinues`. */
  campaignKnown?: boolean;
  choices: MenuChoices;
}

export interface MenuCallbacks {
  onLaunch(l: MenuLaunch): void;
  onContinue(kind: MenuContinue["kind"]): void;
  /** Any choice changed (the app remembers them). */
  onChoices(c: MenuChoices): void;
  onLook(l: MenuLook): void;
  /** A fresh seed (the app takes it from the clock: the menu is not the simulation). */
  newSeed(): number;
  /** One line under the quick battle's choices: what each side gets (from the scenario; the app builds it). */
  describeQuick?(c: QuickChoice): string;
  /** A screen was opened (the app keeps the browser's history in step). */
  onScreen?(s: MenuScreen): void;
}

export interface StartMenu {
  show(screen: MenuScreen): void;
  screen(): MenuScreen;
  /** The continue rows (they arrive late: the campaign store is read asynchronously). */
  setContinues(c: MenuContinue[], campaignInProgress: boolean): void;
  readonly root: HTMLElement;
}

type Child = Node | string | null | undefined | false;
function h(tag: string, cls = "", ...kids: Child[]): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  for (const k of kids) if (k !== null && k !== undefined && k !== false) e.append(k);
  return e;
}
function btn(text: string, cls: string, on: () => void, data?: Record<string, string>, disabled = false): HTMLButtonElement {
  const b = h("button", `cmp-btn ${cls}`, text) as HTMLButtonElement;
  b.type = "button"; b.disabled = disabled;
  b.onclick = (ev) => { ev.stopPropagation(); on(); };
  if (data) for (const [k, v] of Object.entries(data)) b.dataset[k] = v;
  return b;
}

export function createStartMenu(parent: HTMLElement, s: Strings, model: MenuModel, cb: MenuCallbacks): StartMenu {
  const root = h("div", `cmp menu look-${model.look}`);
  parent.append(root);
  let look = model.look;
  let screen: MenuScreen = "home";
  const ch = model.choices;
  const t = (k: string, p: Record<string, string | number> = {}) => s.t(k, p);
  const factionName = (f: string) => (s.has(`faction.${f}`, f) ? s.t(`faction.${f}`, {}, f) : f);
  const mapName = (m: string) => (s.has(`map.${m}`) ? t(`map.${m}`) : m);
  const changed = () => cb.onChoices(ch);

  const chips = <T extends string>(name: string, opts: readonly T[], label: (o: T) => string, get: () => T, set: (o: T) => void) => {
    const row = h("div", "cmp-chips");
    row.dataset["group"] = name;
    const paint = () => { for (const b of row.querySelectorAll("button")) b.classList.toggle("on", (b as HTMLButtonElement).dataset["val"] === get()); };
    for (const o of opts) row.append(btn(label(o), "chip", () => { set(o); paint(); changed(); }, { val: o }));
    paint();
    return row;
  };
  const label = (k: string) => h("div", "cmp-label", t(k));
  const card = (title: string | null, ...kids: Child[]) => h("section", "cmp-card", title ? h("h3", "cmp-h", title) : null, ...kids);
  const sideChips = (name: string, get: () => MenuSide, set: (x: MenuSide) => void) =>
    chips(name, ["blue", "red"] as const, (x) => factionName(model.factions[x === "blue" ? 0 : 1]), get, set);
  const timeChips = (get: () => MenuTime, set: (x: MenuTime) => void) => chips("time", MENU_TIMES, (x) => t(`menu.time.${x}`), get, set);
  const mapChips = (get: () => string, set: (x: string) => void) => chips("map", model.mapKinds, mapName, get, set);
  const seedRow = () => {
    const inp = h("input", "cmp-input menu-seed") as HTMLInputElement;
    inp.type = "number"; inp.inputMode = "numeric"; inp.min = "0"; inp.step = "1"; inp.value = String(ch.seed); inp.dataset["field"] = "seed";
    inp.setAttribute("aria-label", t("menu.seed"));
    inp.onchange = () => { const v = Math.floor(Number(inp.value)); if (Number.isFinite(v) && v >= 0) { ch.seed = v >>> 0; changed(); } inp.value = String(ch.seed); };
    const dice = btn(t("menu.seedNew"), "", () => { ch.seed = cb.newSeed(); inp.value = String(ch.seed); changed(); }, { act: "seed" });
    return h("div", "", label("menu.seed"), h("div", "cmp-inline", inp, dice), h("div", "cmp-note", t("menu.seedInfo")));
  };
  const startBar = (launch: () => MenuLaunch) => h("div", "cmp-actions sticky", btn(t("menu.start"), "primary", () => cb.onLaunch(launch()), { act: "start" }));

  // -------------------------------------------------------------------------------------------- home
  const continueCard = (): HTMLElement | null => {
    if (model.continues.length === 0) return null;
    const c = card(t("menu.continue"));
    c.classList.add("menu-continue");
    for (const x of model.continues) {
      const b = h("button", "menu-tile menu-tile-small", h("span", "menu-tile-title", t(`menu.continue.${x.kind}`)), h("span", "menu-tile-info", x.detail)) as HTMLButtonElement;
      b.type = "button"; b.dataset["act"] = `continue-${x.kind}`;
      b.onclick = () => cb.onContinue(x.kind);
      c.append(b);
    }
    return c;
  };
  const modeTile = (m: Exclude<MenuScreen, "home">) => {
    const b = h("button", `menu-tile mode-${m}`, h("span", "menu-tile-title", t(`menu.mode.${m}`)), h("span", "menu-tile-info", t(`menu.mode.${m}Info`)), h("span", "menu-tile-go", "›")) as HTMLButtonElement;
    b.type = "button"; b.dataset["act"] = `mode-${m}`;
    b.onclick = () => go(m);
    return b;
  };
  const home = () => {
    const body = h("div", "cmp-body");
    body.append(h("div", "cmp-hero menu-hero", h("div", "cmp-hero-title", t("app.title")), h("div", "cmp-hero-sub", t("menu.sub"))));
    const cc = continueCard(); if (cc) body.append(cc);
    const modes = h("div", "menu-modes");
    modes.append(modeTile("quick"), modeTile("campaign"), modeTile("hold"), modeTile("assault"), modeTile("more"));
    body.append(h("div", "cmp-label", t("menu.modes")), modes);
    return body;
  };

  // -------------------------------------------------------------------------------------------- the modes
  const quick = () => {
    const q = ch.quick;
    // (A choice here changes the rows below it and the forces line: the screen is laid out again, scroll kept.)
    const re = <T extends string>(name: string, opts: readonly T[], lab: (o: T) => string, get: () => T, set: (o: T) => void) => chips(name, opts, lab, get, (o) => { set(o); render(); });
    const roleLabel = (x: "attack" | "defend") => (q.kind === "attack" ? t(`menu.role.${x}`) : t(`menu.kindRole.${q.kind}.${x}`));
    const forces = cb.describeQuick?.(normalQuick(q)) ?? "";
    return h("div", "cmp-body",
      h("div", "cmp-note", t("menu.mode.quickInfo")),
      card(null,
        label("menu.kind"), re("kind", MENU_KINDS, (x) => t(`menu.kind.${x}`), () => q.kind, (x) => { q.kind = x; }),
        ...(q.kind === "meeting" ? [] : [label("menu.role"), re("role", ["attack", "defend"] as const, roleLabel, () => q.role, (x) => { q.role = x; })]),
        label("menu.size"), re("size", MENU_SIZES, (x) => t(`menu.size.${x}`), () => q.size, (x) => { q.size = x; }),
        forces ? h("div", "cmp-note menu-forces-line", forces) : null,
        q.size === "company" ? h("div", "cmp-note", t("menu.size.companyInfo")) : null),
      card(null,
        label("menu.side"), sideChips("side", () => q.side, (x) => { q.side = x; }),
        label("menu.forces"), chips("forces", MENU_FORCES, (x) => t(`menu.forces.${x}`), () => q.forces, (x) => { q.forces = x; }),
        ...(q.size === "company" ? [] : [label("menu.tanks"), chips("tanks", MENU_TANKS, (x) => t(`menu.tanks.${x}`), () => q.tanks, (x) => { q.tanks = x; }),
          h("div", "cmp-note", t("menu.tanksInfo"))])),
      card(null, label("menu.map"), mapChips(() => q.map, (x) => { q.map = x; }), label("menu.time"), timeChips(() => q.time, (x) => { q.time = x; }), seedRow()),
      startBar(() => ({ mode: "quick", c: normalQuick(q), seed: ch.seed, look })));
  };
  const hold = () => {
    const c = ch.hold;
    return h("div", "cmp-body",
      h("div", "cmp-note", t("menu.mode.holdInfo")),
      card(null, label("menu.hold.side"), sideChips("side", () => c.side, (x) => { c.side = x; }), label("menu.time"), timeChips(() => c.time, (x) => { c.time = x; }), seedRow()),
      startBar(() => ({ mode: "hold", c: { ...c }, seed: ch.seed, look })));
  };
  const assault = () => {
    const c = ch.assault;
    // (The assault group is red's platoon, M7.6d: the part names the factions.)
    const part = (x: "assault" | "defend") => t(`menu.assault.${x}`, { faction: factionName(model.factions[x === "assault" ? 1 : 0]) });
    return h("div", "cmp-body",
      h("div", "cmp-note", t("menu.mode.assaultInfo")),
      card(null, label("menu.assault.role"), chips("role", ["assault", "defend"] as const, part, () => c.role, (x) => { c.role = x; }),
        label("menu.map"), mapChips(() => c.map, (x) => { c.map = x; }), label("menu.time"), timeChips(() => c.time, (x) => { c.time = x; }), seedRow()),
      startBar(() => ({ mode: "assault", c: { ...c }, seed: ch.seed, look })));
  };
  const campaign = () => {
    const c = ch.campaign;
    const body = h("div", "cmp-body", h("div", "cmp-note", t("menu.mode.campaignInfo")));
    if (model.continues.some((x) => x.kind === "campaign")) {
      const d = model.continues.find((x) => x.kind === "campaign")!.detail;
      body.append(card(t("menu.continue"), h("div", "cmp-note", d), h("div", "cmp-actions", btn(t("menu.continue.campaign"), "primary", () => cb.onLaunch({ mode: "campaign-continue", look }), { act: "campaign-continue" }))));
    }
    if (model.campaignFactions.length > 0) {
      if (!model.campaignFactions.includes(c.faction)) c.faction = model.campaignFactions[0]!;
      body.append(card(t("cmp.home.new"),
        label("cmp.home.faction"), chips("faction", model.campaignFactions, factionName, () => c.faction, (x) => { c.faction = x; }),
        label("cmp.home.carriers"), chips("carriers", MENU_CARRIERS, (x) => t(`cmp.carriers.${x}`), () => c.carriers, (x) => { c.carriers = x; }),
        label("cmp.home.mode"), chips("mode", ["operations", "endless"] as const, (x) => t(`cmp.mode.${x}`), () => c.mode, (x) => { c.mode = x; }),
        h("div", "cmp-note", t("cmp.home.modeInfo")),
        h("div", "cmp-actions", btn(t("menu.campaign.start"), "primary", () => {
          if (model.campaignKnown !== true) return;
          if (model.campaignInProgress && !confirm(t("menu.campaign.replace"))) return;
          cb.onLaunch({ mode: "campaign-new", c: { ...c }, look });
        }, { act: "campaign-new" }, model.campaignKnown !== true))));
    }
    body.append(card(t("cmp.home.slots"), h("div", "cmp-note", t("menu.campaign.savesInfo")),
      h("div", "cmp-actions", btn(t("menu.campaign.saves"), "", () => cb.onLaunch({ mode: "campaign-saves", look }), { act: "campaign-saves" }))));
    return body;
  };
  const more = () => {
    const c = ch.sandbox;
    return h("div", "cmp-body",
      card(t("menu.sandbox"), h("div", "cmp-note", t("menu.sandboxInfo")),
        label("cmp.home.carriers"), chips("carriers", MENU_CARRIERS, (x) => t(`cmp.carriers.${x}`), () => c.carriers, (x) => { c.carriers = x; }),
        label("menu.map"), mapChips(() => c.map, (x) => { c.map = x; }), seedRow(),
        h("div", "cmp-actions", btn(t("menu.sandboxStart"), "primary", () => cb.onLaunch({ mode: "sandbox", c: { ...c }, seed: ch.seed, look }), { act: "start" }))),
      card(t("menu.look"), h("div", "cmp-note", t("menu.lookInfo")),
        chips("look", ["photo", "flat"] as const, (x) => t(`cmp.look.${x}`), () => look, (x) => setLook(x))));
  };

  // -------------------------------------------------------------------------------------------- frame
  const top = () => {
    const bar = h("div", "cmp-top");
    if (screen !== "home") bar.append(btn("‹", "cmp-back", () => go("home"), { act: "back" }));
    bar.append(h("div", "cmp-title", screen === "home" ? t("menu.title") : t(`menu.mode.${screen}`)));
    bar.append(btn(t(`cmp.look.${look}`), "cmp-look", () => setLook(look === "photo" ? "flat" : "photo"), { act: "look" }));
    return bar;
  };
  const render = () => {
    const same = root.dataset["screen"] === screen;
    root.dataset["screen"] = screen;
    const body = screen === "home" ? home() : screen === "quick" ? quick() : screen === "hold" ? hold() : screen === "assault" ? assault() : screen === "campaign" ? campaign() : more();
    // (Laid out again on the same screen, a choice changed: the scroll position stays.)
    const was = root.querySelector(".cmp-scroll");
    const keep = was !== null && same ? was.scrollTop : 0;
    const scroll = h("div", "cmp-scroll", body);
    root.replaceChildren(top(), scroll);
    scroll.scrollTop = keep;
  };
  const setLook = (l: MenuLook) => {
    root.classList.remove(`look-${look}`); look = l; root.classList.add(`look-${l}`);
    cb.onLook(l);
    render();
  };
  const go = (m: MenuScreen) => { screen = m; render(); cb.onScreen?.(m); };
  render();

  return {
    show(m) { screen = m; render(); },
    screen: () => screen,
    setContinues(c, inProgress) { model.continues = c; model.campaignInProgress = inProgress; model.campaignKnown = true; if (screen === "home" || screen === "campaign") render(); },
    root,
  };
}
