/**
 * THE START MENU PAGE (owner 2026-11-20): the app opened without parameters (or `?menu=1`) shows the menu of
 * `@tcs/ui` menu.ts instead of a battle. A launch navigates to the URL the app already understands (menu-model.ts);
 * "Continue" offers the campaign in the automatic slot, the mid-battle save and the last battle started here. The
 * choices are remembered in localStorage (`tcs.menu.choices`, `tcs.menu.last`; a private window: not remembered).
 */
import type { DataSet, Strings } from "@tcs/data";
import { MAP_KINDS } from "@tcs/scenario";
import { AUTO_SLOT } from "@tcs/campaign";
import { createStartMenu, MENU_SCREENS, type MenuChoices, type MenuContinue, type MenuLaunch, type MenuLook, type MenuScreen } from "@tcs/ui";
import { browserCampaignStore } from "./campaign-store";
import { clockSeed, defaultChoices, describeLaunch, launchOfSearch, launchSearch, readChoices } from "./menu-model";
import { defaultFactions } from "./setup";

const LOOK_KEY = "tcs.ui.look";
const CHOICES_KEY = "tcs.menu.choices";
const LAST_KEY = "tcs.menu.last";
const SAVE_KEY = "tcs.save";

export interface MenuHooks {
  /** The menu as Playwright sees it (npm run screenshot -- --scene menu). */
  state(): { screen: MenuScreen; choices: MenuChoices; continues: MenuContinue["kind"][]; look: MenuLook };
  /** The URL a launch would open (tests of the page). */
  launchSearch(l: MenuLaunch): string;
}

const get = (k: string): string | null => { try { return localStorage.getItem(k); } catch { return null; } };
const set = (k: string, v: string): void => { try { localStorage.setItem(k, v); } catch { /* not remembered */ } };

/** The app's own address with no parameters: the menu. */
export function menuUrl(): string { return location.pathname; }

export async function menuPage(root: HTMLElement, data: DataSet, strings: Strings, params: URLSearchParams): Promise<MenuHooks> {
  const lp = params.get("look"), stored = get(LOOK_KEY);
  let look: MenuLook = lp === "flat" || lp === "pixel" ? "flat" : lp === "photo" ? "photo" : stored === "flat" || stored === "pixel" ? "flat" : "photo";
  const factions = defaultFactions(data);
  const campaignFactions = Object.keys(data.factions).sort().filter((f) => data.factions[f]!.manifest.battalionTemplates !== undefined && (data.factions[f]!.manifest.fixture !== true || params.get("fixtures") === "1"));
  const mapKinds = [...MAP_KINDS] as string[];
  const valid = { mapKinds, campaignFactions };
  const choices = readChoices(get(CHOICES_KEY), defaultChoices({ ...valid, seed: clockSeed(Date.now()) }), valid);
  const t = (k: string, p: Record<string, string | number> = {}) => strings.t(k, p);
  const factionName = (f: string) => (strings.has(`faction.${f}`, f) ? strings.t(`faction.${f}`, {}, f) : f);

  // ---- Continue: the mid-battle save (a plain battle's), the last battle started here; the campaign (async).
  const savedSearch = (() => {
    const raw = get(SAVE_KEY);
    if (!raw) return null;
    try {
      const b = JSON.parse(raw) as { url?: unknown; campaignSlot?: unknown };
      return typeof b.url === "string" && (b.campaignSlot ?? null) === null ? b.url : null;
    } catch { return null; }
  })();
  const lastSearch = get(LAST_KEY);
  const lastLaunch = lastSearch !== null ? launchOfSearch(lastSearch) : null;
  const local: MenuContinue[] = [];
  if (savedSearch !== null) {
    const l = launchOfSearch(savedSearch);
    local.push({ kind: "saved", detail: l ? describeLaunch(l, t, factions, factionName) : t("menu.continue.savedOther") });
  }
  if (lastLaunch) local.push({ kind: "again", detail: describeLaunch(lastLaunch, t, factions, factionName) });
  let continues = local;

  const go = (search: string) => { location.search = search; };
  const menu = createStartMenu(root, strings, { look, factions, campaignFactions, mapKinds, continues, campaignInProgress: false, choices }, {
    onLaunch: (l) => {
      set(CHOICES_KEY, JSON.stringify(choices));
      const search = launchSearch(l);
      if ("seed" in l) set(LAST_KEY, search);
      go(search);
    },
    onContinue: (k) => {
      if (k === "campaign") go(launchSearch({ mode: "campaign-continue", look }));
      else if (k === "saved" && savedSearch !== null) { const q = new URLSearchParams(savedSearch); q.set("load", "1"); go(q.toString()); }
      else if (k === "again" && lastSearch !== null) go(lastSearch);
    },
    onChoices: () => set(CHOICES_KEY, JSON.stringify(choices)),
    onLook: (l) => { look = l; set(LOOK_KEY, l); },
    newSeed: () => clockSeed(Date.now() + 7919 * (choices.seed + 1)),
    // (The phone's back button returns from a mode's screen to the menu's first screen.)
    onScreen: (s) => { if (s !== "home") history.pushState({ tcsMenu: s }, ""); else if ((history.state as { tcsMenu?: string } | null)?.tcsMenu) history.back(); },
  });
  addEventListener("popstate", (e) => {
    const s = (e.state as { tcsMenu?: string } | null)?.tcsMenu;
    menu.show(MENU_SCREENS.includes(s as MenuScreen) ? s as MenuScreen : "home");
  });

  // The campaign in the automatic slot (IndexedDB; none or unreadable: no row).
  try {
    const slots = await browserCampaignStore(data).slots();
    const auto = slots.find((x) => x.slotName === AUTO_SLOT);
    if (auto) {
      const line = [`${factionName(auto.faction)} — ${factionName(auto.enemy)}`, t(`cmp.mode.${auto.mode}`), t("cmp.slot.battles", { n: auto.battles })].join(" · ");
      continues = [{ kind: "campaign", detail: line }, ...local];
      menu.setContinues(continues, true);
    }
  } catch (e) { console.warn("menu: campaign store", e); }

  return {
    state: () => ({ screen: menu.screen(), choices: structuredClone(choices), continues: continues.map((c) => c.kind), look }),
    launchSearch,
  };
}
