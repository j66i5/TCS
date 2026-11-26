/**
 * The start menu's pure side (no DOM, no storage): when the menu is shown, the URL each launch writes (the parameters
 * the app has always understood: CLAUDE.md "App URL options"), the launch a menu-made URL stands for (the "Continue"
 * rows describe it), the defaults and the remembered choices read back safely. Tested in packages/app/test/menu.test.ts
 * together with the battle each URL builds (setup.ts).
 */
import { MENU_CARRIERS, MENU_FORCES, MENU_KINDS, MENU_SIZES, MENU_TANKS, MENU_TIMES, normalQuick, type MenuKind, type AssaultChoice, type CampaignChoice, type HoldChoice, type MenuChoices, type MenuLaunch, type MenuLook, type MenuSide, type MenuTime, type QuickChoice, type SandboxChoice } from "@tcs/ui";

/** The clock time each time-of-day choice writes as `&time=` (null: none, the constant daylight as before M9.1). The
 *  sun table (core spotting data) has sunrise about 6:00 and sunset about 18:00 and full dark from 19:15. */
export const MENU_CLOCK: Readonly<Record<MenuTime, string | null>> = { day: null, dawn: "06:00", dusk: "18:30", night: "23:00" };

/** The menu is shown when the URL has no parameters at all, or `?menu=1`; any other parameter is a battle (or the
 *  campaign) as before, so every link made before the menu opens what it opened then. */
export function isMenuRequest(search: string): boolean {
  const p = new URLSearchParams(search);
  if (p.get("menu") === "1") return true;
  for (const [k] of p) if (k !== "") return false;
  return true;
}

const other = (s: MenuSide): MenuSide => (s === "blue" ? "red" : "blue");

/** The URL query (without "?") a launch opens. */
export function launchSearch(l: MenuLaunch): string {
  const q = new URLSearchParams();
  const time = (x: MenuTime) => { const c = MENU_CLOCK[x]; if (c !== null) q.set("time", c); };
  const tail = (seed: number) => { q.set("seed", String(seed >>> 0)); q.set("look", l.look); };
  // (Review step 5: a battle started from the menu opens on its briefing, paused; a URL without `brief=1` runs at
  // once, as every link and tool before.)
  const brief = () => q.set("brief", "1");
  switch (l.mode) {
    case "quick": {
      // (Review step 5: the battle type and the size, as `&kind=` / `&size=` have always been read; the plain attack
      // at platoon size writes neither, so its URL is the one the menu wrote before. A meeting has no roles: the
      // player's side is named the attacker. A company has both sides' tank sections, its own support.)
      const c = normalQuick(l.c);
      q.set("scenario", "platoon");
      if (c.kind !== "attack") q.set("kind", c.kind);
      if (c.size === "company") q.set("size", "company");
      q.set("side", c.side);
      q.set("attacker", c.role === "attack" ? c.side : other(c.side));
      if (c.forces === "foot") q.set("vehicles", "0"); else if (c.forces === "wheeled") q.set("vehicles", "wheeled");
      if (c.tanks === "both") q.set("tanks", "1"); else if (c.tanks === "none") q.set("tanks", "0");
      q.set("map", c.map);
      time(c.time);
      tail(l.seed);
      brief();
      break;
    }
    case "hold":
      q.set("scenario", "hold");
      // (The player defends: `attacker=blue` makes red the defender, holdBattle.)
      if (l.c.side === "red") { q.set("side", "red"); q.set("attacker", "blue"); }
      time(l.c.time);
      tail(l.seed);
      brief();
      break;
    case "assault":
      // (M7.6d: the assault group is red's platoon on foot, red attacking.)
      q.set("scenario", "platoon"); q.set("assault", "1"); q.set("vehicles", "0");
      q.set("side", l.c.role === "assault" ? "red" : "blue");
      q.set("map", l.c.map);
      time(l.c.time);
      tail(l.seed);
      brief();
      break;
    case "sandbox":
      q.set("scenario", "vehicles");
      if (l.c.carriers === "wheeled") q.set("vehicles", "wheeled");
      q.set("map", l.c.map);
      tail(l.seed);
      break;
    case "campaign-new":
      q.set("campaign", "1"); q.set("new", "1"); q.set("faction", l.c.faction); q.set("carriers", l.c.carriers); q.set("mode", l.c.mode); q.set("look", l.look);
      break;
    case "campaign-continue":
      q.set("campaign", "1"); q.set("continue", "1"); q.set("look", l.look);
      break;
    case "campaign-saves":
      q.set("campaign", "1"); q.set("look", l.look);
      break;
  }
  return q.toString();
}

const timeOfClock = (v: string | null): MenuTime | null => {
  if (v === null) return "day";
  for (const k of MENU_TIMES) if (MENU_CLOCK[k] === v) return k;
  return null;
};
const lookOf = (v: string | null): MenuLook => (v === "flat" ? "flat" : "photo");

/** The launch a menu-made battle URL stands for (null: not one the menu makes, e.g. a hand-made link with more
 *  parameters). `launchSearch(launchOfSearch(x)) === x` for every URL the menu writes. */
export function launchOfSearch(search: string): Extract<MenuLaunch, { seed: number }> | null {
  const q = new URLSearchParams(search);
  const known = new Set(["scenario", "kind", "size", "side", "attacker", "vehicles", "tanks", "map", "time", "seed", "look", "assault", "brief"]);
  for (const [k] of q) if (!known.has(k)) return null;
  const seedRaw = q.get("seed");
  if (seedRaw === null || !/^\d+$/.test(seedRaw)) return null;
  const seed = Number(seedRaw) >>> 0, look = lookOf(q.get("look"));
  const time = timeOfClock(q.get("time"));
  if (time === null) return null;
  const side: MenuSide = q.get("side") === "red" ? "red" : "blue";
  const map = q.get("map");
  let l: Extract<MenuLaunch, { seed: number }> | null = null;
  const sc = q.get("scenario");
  if (sc === "platoon" && q.get("assault") === "1") {
    if (map !== null) l = { mode: "assault", c: { role: side === "red" ? "assault" : "defend", map, time }, seed, look };
  } else if (sc === "platoon") {
    const v = q.get("vehicles"), tk = q.get("tanks"), att = q.get("attacker");
    const forces = v === "0" ? "foot" : v === "wheeled" ? "wheeled" : v === null ? "tracked" : null;
    const tanks = tk === "1" ? "both" : tk === "0" ? "none" : tk === null ? "standard" : null;
    const kp = q.get("kind"), sz = q.get("size");
    const kind: MenuKind | null = kp === null ? "attack" : kp !== "attack" && (MENU_KINDS as readonly string[]).includes(kp) ? kp as MenuKind : null;
    const size = sz === null ? "platoon" : sz === "company" ? "company" : null;
    if (kind !== null && size !== null && forces !== null && tanks !== null && map !== null && (att === "blue" || att === "red")) l = { mode: "quick", c: { kind, role: att === side ? "attack" : "defend", size, side, forces, tanks, map, time }, seed, look };
  } else if (sc === "hold") {
    l = { mode: "hold", c: { side, time }, seed, look };
  } else if (sc === "vehicles") {
    if (map !== null) l = { mode: "sandbox", c: { carriers: q.get("vehicles") === "wheeled" ? "wheeled" : "tracked", map }, seed, look };
  }
  if (l === null) return null;
  // (A battle remembered before the briefing existed has no `brief=1`: still the same choice.)
  const want = new URLSearchParams(launchSearch(l));
  if (!q.has("brief")) want.delete("brief");
  return want.toString() === q.toString() ? l : null;
}

/** One line for a "Continue" row: the mode and its main choices, in words (`t`: the string table). */
export function describeLaunch(l: Extract<MenuLaunch, { seed: number }>, t: (k: string, p?: Record<string, string | number>) => string, factions: [string, string], factionName: (f: string) => string): string {
  const fac = (s: MenuSide) => factionName(factions[s === "blue" ? 0 : 1]);
  const mapName = (m: string) => t(`map.${m}`);
  const parts: string[] = l.mode === "sandbox" ? [] : [t(`menu.mode.${l.mode}`)];
  if (l.mode === "quick") {
    const c = l.c;
    if (c.kind === "attack") parts.push(t(`menu.role.${c.role}`));
    else if (c.kind === "meeting") parts.push(t("menu.kind.meeting"));
    else parts.push(t(`menu.kind.${c.kind}`), t(`menu.kindRole.${c.kind}.${c.role}`));
    if (c.size === "company") parts.push(t("menu.size.company"));
    parts.push(fac(c.side), t(`menu.forces.${c.forces}`), mapName(c.map));
  }
  else if (l.mode === "hold") parts.push(fac(l.c.side));
  else if (l.mode === "assault") parts.push(fac(l.c.role === "assault" ? "red" : "blue"), mapName(l.c.map));
  else parts.push(t("menu.sandbox"), t(`cmp.carriers.${l.c.carriers}`), mapName(l.c.map));
  if ("time" in l.c && l.c.time !== "day") parts.push(t(`menu.time.${l.c.time}`));
  parts.push(t("menu.seedN", { seed: l.seed }));
  return parts.join(" · ");
}

/** A seed for a new battle from the clock (the menu is user interface, not the simulation): 1 .. 999 999. */
export function clockSeed(nowMs: number): number {
  return 1 + (Math.floor(Math.abs(nowMs)) % 999_999);
}

/** The menu's first choices: attack as blue in the tracked carriers, the standard tanks, the village, by day. */
export function defaultChoices(o: { mapKinds: readonly string[]; campaignFactions: readonly string[]; seed: number }): MenuChoices {
  const map = o.mapKinds.includes("village") ? "village" : o.mapKinds[0] ?? "village";
  const farm = o.mapKinds.includes("farmland") ? "farmland" : map;
  return {
    quick: { kind: "attack", role: "attack", size: "platoon", side: "blue", forces: "tracked", tanks: "standard", map, time: "day" },
    hold: { side: "blue", time: "day" },
    assault: { role: "assault", map, time: "day" },
    sandbox: { carriers: "tracked", map: farm },
    campaign: { faction: o.campaignFactions[0] ?? "", carriers: "tracked", mode: "operations" },
    seed: o.seed >>> 0,
  };
}

/**
 * The remembered choices (JSON from localStorage) laid over the defaults field by field: anything missing, of the
 * wrong kind or no longer offered (a map kind or faction gone from the data) keeps its default. The seed is always
 * the fresh one (a new battle each visit; "Play again" keeps the last battle's seed).
 */
export function readChoices(raw: string | null, defaults: MenuChoices, valid: { mapKinds: readonly string[]; campaignFactions: readonly string[] }): MenuChoices {
  const d = structuredClone(defaults);
  let j: unknown;
  try { j = raw ? JSON.parse(raw) : null; } catch { return d; }
  if (typeof j !== "object" || j === null) return d;
  const o = j as Record<string, Record<string, unknown> | undefined>;
  const pick = <T extends string>(v: unknown, opts: readonly T[], def: T): T => (typeof v === "string" && (opts as readonly string[]).includes(v) ? v as T : def);
  const sides = ["blue", "red"] as const;
  const q = o["quick"] ?? {}, hd = o["hold"] ?? {}, as = o["assault"] ?? {}, sb = o["sandbox"] ?? {}, cp = o["campaign"] ?? {};
  const quick: QuickChoice = {
    kind: pick(q["kind"], MENU_KINDS, d.quick.kind), role: pick(q["role"], ["attack", "defend"] as const, d.quick.role), size: pick(q["size"], MENU_SIZES, d.quick.size), side: pick(q["side"], sides, d.quick.side),
    forces: pick(q["forces"], MENU_FORCES, d.quick.forces), tanks: pick(q["tanks"], MENU_TANKS, d.quick.tanks),
    map: pick(q["map"], valid.mapKinds, d.quick.map), time: pick(q["time"], MENU_TIMES, d.quick.time),
  };
  const hold: HoldChoice = { side: pick(hd["side"], sides, d.hold.side), time: pick(hd["time"], MENU_TIMES, d.hold.time) };
  const assault: AssaultChoice = { role: pick(as["role"], ["assault", "defend"] as const, d.assault.role), map: pick(as["map"], valid.mapKinds, d.assault.map), time: pick(as["time"], MENU_TIMES, d.assault.time) };
  const sandbox: SandboxChoice = { carriers: pick(sb["carriers"], MENU_CARRIERS, d.sandbox.carriers), map: pick(sb["map"], valid.mapKinds, d.sandbox.map) };
  const campaign: CampaignChoice = { faction: pick(cp["faction"], valid.campaignFactions, d.campaign.faction), carriers: pick(cp["carriers"], MENU_CARRIERS, d.campaign.carriers), mode: pick(cp["mode"], ["operations", "endless"] as const, d.campaign.mode) };
  return { quick, hold, assault, sandbox, campaign, seed: d.seed };
}

/**
 * Review step 5: what each side of a quick battle gets, in words, from the scenario's own counts (`scenarioPlatoons`
 * of @tcs/scenario, passed in: this file stays free of the scenario). `p`: the platoons of the scenario's attacker
 * and defender at the start and coming on later. "You: 2 platoons. Enemy: 1 platoon, 1 more arriving later."
 */
export function quickForcesLine(c: QuickChoice, t: (k: string, p?: Record<string, string | number>) => string, p: { attacker: number; defender: number; attackerLate: number; defenderLate: number }): string {
  const mine = normalQuick(c).role === "attack";
  const words = (n: number, late: number) => t(n === 1 ? "menu.quick.platoon1" : "menu.quick.platoons", { n }) + (late > 0 ? t("menu.quick.late", { n: late }) : "");
  const own = mine ? words(p.attacker, p.attackerLate) : words(p.defender, p.defenderLate);
  const enemy = mine ? words(p.defender, p.defenderLate) : words(p.attacker, p.attackerLate);
  return t("menu.quick.forces", { own, enemy }) + (c.size === "company" ? ` ${t("menu.quick.company")}` : "");
}

/** The scenario definition's part a quick choice stands for (kind, attacker, size), for `scenarioPlatoons`. */
export function quickScenario(c: QuickChoice): { kind: MenuKind; attacker: MenuSide; size: "platoon" | "company" } {
  const n = normalQuick(c);
  return { kind: n.kind, attacker: n.role === "attack" ? n.side : other(n.side), size: n.size };
}
