/**
 * Start menu (owner 2026-11-20): every choice the menu offers writes a URL the app takes as a battle (not the menu
 * again), that URL reads back as the same choice (the "Continue" rows), and `battleSetup` (the app's own battle
 * building, setup.ts) makes a valid battle of it: both sides with men, the player's side, task, carriers, tanks, map
 * and time as chosen, the enemy commanded, and the battle runs. Also: when the menu is shown, the remembered choices
 * read back safely, the default factions come from data (never the fixture), and every menu string exists.
 */
import { describe, expect, it } from "vitest";
import { MAP_KINDS, scenarioPlatoons, startRulesFor } from "@tcs/scenario";
import { Strings } from "@tcs/data";
import { createSim, hashState, step, submitOrder } from "@tcs/sim";
import { MENU_FORCES, MENU_KINDS, MENU_SCREENS, MENU_SIZES, MENU_TANKS, MENU_TIMES, normalQuick, type MenuLaunch, type QuickChoice } from "@tcs/ui";
import { loadData } from "../../tools/src/scenarios";
import { clockSeed, defaultChoices, describeLaunch, isMenuRequest, launchOfSearch, launchSearch, MENU_CLOCK, quickForcesLine, quickScenario, readChoices } from "../src/menu-model";
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
  // Review step 5: every battle type x task x side at platoon size, on foot and in the tracked carriers; a company
  // of every type and task (on foot, and the plain attack mounted). A meeting has no task (one launch per side).
  const seen = new Set<string>([...out].map((l) => launchSearch(l)));
  const add = (c: QuickChoice) => { const l: BattleLaunch = { mode: "quick", c: normalQuick(c), seed: SEED, look }; const k = launchSearch(l); if (!seen.has(k)) { seen.add(k); out.push(l); } };
  for (const kind of MENU_KINDS) for (const role of ["attack", "defend"] as const) for (const side of ["blue", "red"] as const) for (const forces of ["foot", "tracked"] as const) add({ ...q, kind, role, side, forces });
  for (const kind of MENU_KINDS) for (const role of ["attack", "defend"] as const) add({ ...q, kind, role, size: "company", forces: "foot", side: role === "attack" ? "blue" : "red" });
  add({ ...q, size: "company" });
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
    // Review step 5: a battle from the menu opens on its briefing (not the sandbox); the player's units start with
    // the rules of his role, laid on his force only; the enemy has none.
    expect(new URLSearchParams(search).get("brief")).toBe(l.mode === "sandbox" ? null : "1");
    expect(b.start).toEqual(startRulesFor(own) ?? null);
    expect(own.start).toEqual(b.start ?? undefined);
    expect(enemy.start).toBeUndefined();
    if (l.mode === "quick") {
      const c = l.c, mine = c.role === "attack";
      expect(b.scenario).toBe("platoon");
      expect(b.playerSide).toBe(c.side);
      expect(own.posture).toBe(mine ? "attack" : "defend");
      expect(b.mapKind).toBe(c.map);
      const hulls = placedHulls(own) + placedHulls(enemy);
      if (c.forces === "foot" && c.tanks !== "both") expect(hulls).toBe(0);
      else expect(hulls).toBeGreaterThan(0);
      // The role of each side by battle type and task, and the start rule that follows (DECISIONS 2026-11-26).
      const roles: Record<string, [string, string]> = { attack: ["attack", "defend"], "defence-counterattack": ["attack", "defend"], meeting: ["meeting", "meeting"], ambush: ["transit", "ambush"], withdrawal: ["follow", "withdraw"] };
      const roleOf = (f: typeof own) => f.plan?.posture ?? f.posture;
      expect(roleOf(own)).toBe(roles[c.kind]![mine ? 0 : 1]);
      expect(roleOf(enemy)).toBe(roles[c.kind]![mine ? 1 : 0]);
      const want = { attack: { fire: "free" }, meeting: { fire: "free" }, transit: { fire: "free" }, follow: { fire: "free" }, defend: { fire: "return" }, withdraw: { fire: "return" }, ambush: { ambushM: 220 } }[roleOf(own)!];
      expect(b.start).toEqual(want);
      // What each side gets is what the menu's line says (the scenario's own counts): platoons at the start and later.
      const p = scenarioPlatoons(quickScenario(c));
      const platoons = (f: typeof own, late: boolean) => f.units.filter((u) => new RegExp(`^${f.side}-\\d+$`).test(u.key) && ((u.arriveS ?? 0) > 0) === late).length;
      expect([platoons(own, false), platoons(own, true)]).toEqual(mine ? [p.attacker, p.attackerLate] : [p.defender, p.defenderLate]);
      expect([platoons(enemy, false), platoons(enemy, true)]).toEqual(mine ? [p.defender, p.defenderLate] : [p.attacker, p.attackerLate]);
      expect(quickForcesLine(c, (k, pp) => strings.t(k, pp), p)).not.toContain("[[");
      // A company: both sides' tank sections (the company's support), whatever the carriers.
      if (c.size === "company") for (const f of [own, enemy]) expect(f.units.some((u) => u.echelon === "section" && (f.vehicles ?? []).some((v) => u.subunits.some((x) => x.vehicleId === v.vehicleId) || u.vehicleId === v.vehicleId))).toBe(true);
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
    // The battle runs (the enemy's controller thinks, ten seconds; a company: three).
    const sim = createSim(input);
    const ticks = l.mode === "quick" && l.c.size === "company" ? 180 : 600;
    // The units in the state start as the briefing says: the player's on his role's rule (an ambush laid), the
    // enemy's and every off-map asset on the data's default.
    const defRule = input.catalog.behaviour.decisions.defaultFireRule;
    for (const u of sim.state.unit.values()) {
      const mineU = u.side === b.playerSide && u.asset === undefined;
      expect(u.fireRule).toBe(mineU && b.start ? (b.start.ambushM !== undefined ? "free" : b.start.fire) : defRule);
      expect(u.ambush?.rangeM).toBe(mineU ? b.start?.ambushM : undefined);
    }
    for (let k = 0; k < ticks; k++) { for (const c of b.ai) for (const o of c.think(sim.state, sim.state.tick)) submitOrder(sim, o); step(sim); }
    expect(sim.state.tick).toBe(ticks);
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
    // (A choice remembered before review step 5 has no battle type or size: the defaults.)
    expect(r.quick).toEqual({ kind: "attack", role: "defend", size: "platoon", side: "red", forces: "wheeled", tanks: "both", map: base.quick.map, time: "night" });
    const r2 = readChoices(JSON.stringify({ quick: { kind: "ambush", size: "company", role: "defend" } }), base, valid);
    expect([r2.quick.kind, r2.quick.size, r2.quick.role]).toEqual(["ambush", "company", "defend"]);
    expect(readChoices(JSON.stringify({ quick: { kind: "siege", size: "army" } }), base, valid).quick).toEqual(base.quick);
    expect(r.hold).toEqual(base.hold);
    expect(r.seed).toBe(SEED); // (a fresh seed each visit)
  });
  it("review step 5: the URLs of the battle type and the size; the plain attack keeps the URL the menu wrote before (plus the briefing)", () => {
    const url = (c: Partial<QuickChoice>) => launchSearch({ mode: "quick", c: { ...base.quick, ...c }, seed: SEED, look: "photo" });
    expect(url({})).toBe("scenario=platoon&side=blue&attacker=blue&map=village&seed=3&look=photo&brief=1");
    expect(url({ kind: "ambush", role: "defend", size: "company" })).toBe("scenario=platoon&kind=ambush&size=company&side=blue&attacker=red&tanks=1&map=village&seed=3&look=photo&brief=1");
    // A meeting has no task: the player's side is named the attacker whatever was picked before.
    expect(url({ kind: "meeting", role: "defend", side: "red" })).toBe("scenario=platoon&kind=meeting&side=red&attacker=red&map=village&seed=3&look=photo&brief=1");
    // A battle remembered before the briefing existed (no brief=1) still reads back as its choice.
    expect(launchOfSearch("scenario=platoon&side=blue&attacker=blue&map=village&seed=3&look=photo")).toEqual({ mode: "quick", c: base.quick, seed: SEED, look: "photo" });
    // Not the menu's: an unknown kind or size, `kind=attack` spelled out.
    for (const bad of ["kind=siege", "kind=attack", "size=battalion"]) expect(launchOfSearch(`scenario=platoon&${bad}&side=blue&attacker=blue&map=village&seed=3&look=photo&brief=1`)).toBeNull();
  });
  it("review step 5: the forces line says what each side gets, from the scenario (two platoons against one in the plain attack)", () => {
    const t = (k: string, p?: Record<string, string | number>) => strings.t(k, p);
    const line = (c: Partial<QuickChoice>) => { const q = { ...base.quick, ...c }; return quickForcesLine(q, t, scenarioPlatoons(quickScenario(q))); };
    expect(line({})).toBe("You: 2 platoons. Enemy: 1 platoon.");
    expect(line({ role: "defend" })).toBe("You: 1 platoon. Enemy: 2 platoons.");
    expect(line({ kind: "meeting" })).toBe("You: 1 platoon. Enemy: 1 platoon.");
    expect(line({ kind: "defence-counterattack", role: "defend" })).toBe("You: 1 platoon, 1 more arriving later. Enemy: 2 platoons.");
    expect(line({ kind: "defence-counterattack", role: "attack", size: "company" })).toContain("You: 3 platoons. Enemy: 2 platoons, 1 more arriving later.");
    expect(line({ size: "company" })).toContain(strings.t("menu.quick.company"));
    // The description of a remembered battle names its type, task and size.
    const d = (c: Partial<QuickChoice>) => describeLaunch({ mode: "quick", c: { ...base.quick, ...c }, seed: SEED, look: "photo" }, t, defaultFactions(data), (f) => strings.t(`faction.${f}`, {}, f));
    expect(d({})).toMatch(/^Quick battle · Attack · /);
    expect(d({ kind: "ambush", role: "defend", size: "company" })).toMatch(/^Quick battle · Ambush · Lay the ambush · Company · /);
    expect(d({ kind: "meeting" })).toMatch(/^Quick battle · Meeting · /);
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
      "menu.kind", "menu.size", "menu.size.companyInfo", "menu.quick.forces", "menu.quick.platoon1", "menu.quick.platoons", "menu.quick.late", "menu.quick.company",
      ...MENU_KINDS.map((k) => `menu.kind.${k}`), ...MENU_SIZES.map((k) => `menu.size.${k}`),
      ...MENU_KINDS.filter((k) => k !== "attack" && k !== "meeting").flatMap((k) => [`menu.kindRole.${k}.attack`, `menu.kindRole.${k}.defend`]),
      ...["attack", "defend"].map((k) => `menu.role.${k}`), ...MENU_FORCES.map((k) => `menu.forces.${k}`), ...MENU_TANKS.map((k) => `menu.tanks.${k}`), ...MENU_TIMES.map((k) => `menu.time.${k}`),
      ...mapKinds.map((m) => `map.${m}`)];
    expect(keys.filter((k) => !strings.has(k))).toEqual([]);
    for (const f of defaultFactions(data)) expect(strings.has(`faction.${f}`, f)).toBe(true);
  });
});
