/**
 * Start menu (owner 2026-11-20): every choice the menu offers writes a URL the app takes as a battle (not the menu
 * again), that URL reads back as the same choice (the "Continue" rows), and `battleSetup` (the app's own battle
 * building, setup.ts) makes a valid battle of it: both sides with men, the player's side, task, carriers, tanks, map
 * and time as chosen, the enemy commanded, and the battle runs. Also: when the menu is shown, the remembered choices
 * read back safely, the default factions come from data (never the fixture), and every menu string exists.
 */
import { describe, expect, it } from "vitest";
import { MAP_KINDS } from "@tcs/scenario";
import { Strings } from "@tcs/data";
import { createSim, hashState, step, submitOrder } from "@tcs/sim";
import { MENU_FORCES, MENU_SCREENS, MENU_TANKS, MENU_TIMES, type MenuLaunch } from "@tcs/ui";
import { loadData } from "../../tools/src/scenarios";
import { clockSeed, defaultChoices, describeLaunch, isMenuRequest, launchOfSearch, launchSearch, MENU_CLOCK, readChoices } from "../src/menu-model";
import { battleSetup, defaultFactions } from "../src/setup";

const data = loadData();
const strings = new Strings(data, "en");
const mapKinds = [...MAP_KINDS] as string[];
const campaignFactions = Object.keys(data.factions).sort().filter((f) => data.factions[f]!.manifest.battalionTemplates !== undefined && data.factions[f]!.manifest.fixture !== true);
const SEED = 3;
const base = defaultChoices({ mapKinds, campaignFactions, seed: SEED });

type BattleLaunch = Extract<MenuLaunch, { seed: number }>;
/** Every option of every battle mode at least once (one field changed at a time from the defaults), plus the
 *  forces x tanks grid of the quick battle. */
function launches(): BattleLaunch[] {
  const out: BattleLaunch[] = [];
  const q = base.quick, look = "photo" as const;
  out.push({ mode: "quick", c: { ...q }, seed: SEED, look });
  out.push({ mode: "quick", c: { ...q, role: "defend" }, seed: SEED, look: "flat" });
  out.push({ mode: "quick", c: { ...q, side: "red" }, seed: SEED, look });
  out.push({ mode: "quick", c: { ...q, side: "red", role: "defend" }, seed: SEED, look });
  for (const forces of MENU_FORCES) for (const tanks of MENU_TANKS) if (forces !== "tracked" || tanks !== "standard") out.push({ mode: "quick", c: { ...q, forces, tanks }, seed: SEED, look });
  for (const map of mapKinds) if (map !== q.map) out.push({ mode: "quick", c: { ...q, map, forces: "foot" }, seed: SEED, look });
  for (const time of MENU_TIMES) if (time !== q.time) out.push({ mode: "quick", c: { ...q, time, forces: "foot" }, seed: SEED, look });
  for (const side of ["blue", "red"] as const) for (const time of ["day", "night"] as const) out.push({ mode: "hold", c: { side, time }, seed: SEED, look });
  for (const role of ["assault", "defend"] as const) out.push({ mode: "assault", c: { ...base.assault, role }, seed: SEED, look });
  out.push({ mode: "assault", c: { ...base.assault, map: "farmland", time: "dusk" }, seed: SEED, look });
  for (const carriers of ["tracked", "wheeled"] as const) out.push({ mode: "sandbox", c: { ...base.sandbox, carriers }, seed: SEED, look });
  return out;
}

const placedHulls = (f: { vehiclePlacements?: unknown[] } | undefined) => f?.vehiclePlacements?.length ?? 0;

describe("start menu: when it is shown", () => {
  it("the bare app and ?menu=1 show it; every URL with a parameter opens what it opened before", () => {
    expect(isMenuRequest("")).toBe(true);
    expect(isMenuRequest("?")).toBe(true);
    expect(isMenuRequest("?menu=1")).toBe(true);
    expect(isMenuRequest("?menu=1&look=flat")).toBe(true);
    for (const s of ["?seed=1", "?look=flat", "?scenario=platoon", "?campaign=1", "?load=1", "?scenario=hold&seed=2", "?seed=1&map=village&vehicles=0", "?menu=0"]) expect(isMenuRequest(s)).toBe(false);
  });
});

describe("start menu: every battle choice gives a URL the app builds a valid battle from", () => {
  const list = launches();
  it.each(list.map((l) => [launchSearch(l), l] as const))("%s", (search, l) => {
    // A battle URL, not the menu again; it reads back as the same choice.
    expect(isMenuRequest(`?${search}`)).toBe(false);
    expect(launchOfSearch(search)).toEqual(l);
    expect(describeLaunch(l, (k, p) => strings.t(k, p), defaultFactions(data), (f) => strings.t(`faction.${f}`, {}, f))).not.toContain("[[");
    const warnings: string[] = [];
    const b = battleSetup(data, new URLSearchParams(search), null, (m) => warnings.push(m));
    expect(warnings).toEqual([]);
    const { input } = b;
    expect(b.seed).toBe(SEED);
    expect(input.forces).toHaveLength(2);
    for (const f of input.forces) expect(f.placements.length).toBeGreaterThan(0);
    expect(b.ai).toHaveLength(1);
    const own = input.forces.find((f) => f.side === b.playerSide)!, enemy = input.forces.find((f) => f.side === b.enemySide)!;
    // Time of day: the clock only when asked (day: the constant daylight of every golden).
    const clock = "time" in l.c ? MENU_CLOCK[l.c.time] : null;
    expect(input.environment?.sky !== undefined).toBe(clock !== null);
    if (l.mode === "quick") {
      expect(b.scenario).toBe("platoon");
      expect(b.playerSide).toBe(l.c.side);
      expect(own.posture).toBe(l.c.role === "attack" ? "attack" : "defend");
      expect(b.mapKind).toBe(l.c.map);
      const hulls = placedHulls(own) + placedHulls(enemy);
      if (l.c.forces === "foot" && l.c.tanks !== "both") expect(hulls).toBe(0);
      else expect(hulls).toBeGreaterThan(0);
    } else if (l.mode === "hold") {
      expect(b.scenario).toBe("hold");
      expect(b.playerSide).toBe(l.c.side);
      expect(own.posture).toBe("defend");
      expect(enemy.posture).toBe("attack");
    } else if (l.mode === "assault") {
      expect(b.playerSide).toBe(l.c.role === "assault" ? "red" : "blue");
      expect(input.forces.find((f) => f.side === "red")!.posture).toBe("attack");
      expect(placedHulls(own) + placedHulls(enemy)).toBe(0);
    } else {
      expect(b.scenario).toBe("vehicles");
      expect(placedHulls(own)).toBeGreaterThan(0);
    }
    // The battle runs (the enemy's controller thinks, ten seconds).
    const sim = createSim(input);
    for (let k = 0; k < 600; k++) { for (const c of b.ai) for (const o of c.think(sim.state, sim.state.tick)) submitOrder(sim, o); step(sim); }
    expect(sim.state.tick).toBe(600);
  });

  it("tanks: both sides adds hulls to the tracked battle, none takes the standard sections away", () => {
    const hulls = (tanks: "standard" | "both" | "none") => {
      const b = battleSetup(data, new URLSearchParams(launchSearch({ mode: "quick", c: { ...base.quick, tanks }, seed: SEED, look: "photo" })));
      return b.input.forces.reduce((s, f) => s + placedHulls(f), 0);
    };
    const std = hulls("standard"), both = hulls("both"), none = hulls("none");
    expect(both).toBeGreaterThan(none);
    expect(std).toBeGreaterThan(none);
  });

  it("the default quick battle is the app's battle as it opened before the menu (the same input as the old bare URL with that seed)", () => {
    const viaMenu = battleSetup(data, new URLSearchParams(launchSearch({ mode: "quick", c: base.quick, seed: SEED, look: "photo" })));
    const old = battleSetup(data, new URLSearchParams(`seed=${SEED}`));
    expect(createSim(viaMenu.input).state.nextEntityId).toBe(createSim(old.input).state.nextEntityId);
    expect(hashState(createSim(viaMenu.input).state)).toBe(hashState(createSim(old.input).state));
    expect(JSON.stringify(viaMenu.input.forces.map((f) => [f.side, f.faction, f.posture, f.units.length, placedHulls(f)])))
      .toBe(JSON.stringify(old.input.forces.map((f) => [f.side, f.faction, f.posture, f.units.length, placedHulls(f)])));
  });
});

describe("start menu: campaign launches", () => {
  it("open the campaign page (not the menu, not a battle)", () => {
    for (const l of [{ mode: "campaign-new", c: base.campaign, look: "flat" }, { mode: "campaign-continue", look: "photo" }, { mode: "campaign-saves", look: "photo" }] as MenuLaunch[]) {
      const q = new URLSearchParams(launchSearch(l));
      expect(q.get("campaign")).toBe("1");
      expect(q.get("play")).toBeNull();
      expect(isMenuRequest(`?${q.toString()}`)).toBe(false);
      expect(launchOfSearch(q.toString())).toBeNull();
    }
    expect(new URLSearchParams(launchSearch({ mode: "campaign-new", c: { faction: campaignFactions[0]!, carriers: "wheeled", mode: "endless" }, look: "photo" })).get("mode")).toBe("endless");
  });
});

describe("start menu: choices, seeds, factions, strings", () => {
  it("remembered choices are laid over the defaults field by field; junk keeps the defaults", () => {
    const valid = { mapKinds, campaignFactions };
    expect(readChoices(null, base, valid)).toEqual(base);
    expect(readChoices("not json", base, valid)).toEqual(base);
    expect(readChoices("[1,2]", base, valid).quick).toEqual(base.quick);
    const r = readChoices(JSON.stringify({ quick: { role: "defend", side: "red", forces: "wheeled", tanks: "both", map: "moon", time: "night" }, hold: { side: 7 }, seed: 99 }), base, valid);
    expect(r.quick).toEqual({ role: "defend", side: "red", forces: "wheeled", tanks: "both", map: base.quick.map, time: "night" });
    expect(r.hold).toEqual(base.hold);
    expect(r.seed).toBe(SEED); // (a fresh seed each visit)
  });
  it("a hand-made URL the menu would not write is not taken for a menu choice", () => {
    expect(launchOfSearch("seed=1&map=village")).toBeNull();
    expect(launchOfSearch("scenario=platoon&side=blue&attacker=blue&map=village&seed=1&look=photo&mortars=1")).toBeNull();
    expect(launchOfSearch("scenario=platoon&side=blue&attacker=blue&map=village&time=12:00&seed=1&look=photo")).toBeNull();
  });
  it("clock seeds stay in 1 .. 999 999", () => {
    for (const ms of [0, 1, 999_998, 999_999, 1_763_600_000_123, -5]) { const s = clockSeed(ms); expect(s).toBeGreaterThanOrEqual(1); expect(s).toBeLessThanOrEqual(999_999); }
  });
  it("the default factions are pinned: a link without factions= keeps its battle when a faction is added", () => {
    // (Review: `defaultFactions` takes the first two playable factions by id. A new faction folder sorting before
    // these would change every such link and the menu's sides: change this line on purpose, with a DECISIONS entry.)
    expect(defaultFactions(data)).toEqual(["de", "ru"]);
  });
  it("the default factions come from data: the playable ones in id order, never the fixture", () => {
    const real = Object.keys(data.factions).sort().filter((f) => data.factions[f]!.manifest.fixture !== true);
    expect(defaultFactions(data)).toEqual([real[0], real[1]]);
    expect(defaultFactions(loadData(true))).toEqual([real[0], real[1]]);
    const xfOnly = loadData(true);
    for (const f of real) delete (xfOnly.factions as Record<string, unknown>)[f];
    const [a, b] = defaultFactions(xfOnly);
    expect(a).toBe(b);
    expect(xfOnly.factions[a]?.manifest.fixture).toBe(true);
  });
  it("every string the menu shows exists", () => {
    const keys = ["app.title", "app.mainMenu", "aar.menu", "menu.leaveConfirm", "menu.title", "menu.sub", "menu.continue", "menu.continue.savedOther", "menu.modes",
      "menu.role", "menu.side", "menu.forces", "menu.tanks", "menu.tanksInfo", "menu.map", "menu.time", "menu.seed", "menu.seedN", "menu.seedNew", "menu.seedInfo", "menu.start",
      "menu.hold.side", "menu.assault.role", "menu.assault.assault", "menu.assault.defend", "menu.campaign.start", "menu.campaign.replace", "menu.campaign.saves", "menu.campaign.savesInfo",
      "menu.sandbox", "menu.sandboxInfo", "menu.sandboxStart", "menu.look", "menu.lookInfo", "cmp.look.photo", "cmp.look.flat", "cmp.home.new", "cmp.home.faction", "cmp.home.carriers",
      "cmp.home.mode", "cmp.home.modeInfo", "cmp.home.slots", "cmp.mode.operations", "cmp.mode.endless", "cmp.carriers.tracked", "cmp.carriers.wheeled", "cmp.home.single",
      ...["campaign", "saved", "again"].map((k) => `menu.continue.${k}`),
      ...MENU_SCREENS.filter((s) => s !== "home").flatMap((s) => [`menu.mode.${s}`, `menu.mode.${s}Info`]),
      ...["attack", "defend"].map((k) => `menu.role.${k}`), ...MENU_FORCES.map((k) => `menu.forces.${k}`), ...MENU_TANKS.map((k) => `menu.tanks.${k}`), ...MENU_TIMES.map((k) => `menu.time.${k}`),
      ...mapKinds.map((m) => `map.${m}`)];
    expect(keys.filter((k) => !strings.has(k))).toEqual([]);
    for (const f of defaultFactions(data)) expect(strings.has(`faction.${f}`, f)).toBe(true);
  });
});
