/**
 * THE BATTLE BRIEFING (review 2026-11-24 step 5, problems 5 and 6: "a quick battle starts with no briefing"). Shown
 * before a battle started from the menu (the battle paused until dismissed) and again from the top bar's "Briefing"
 * (under "⋯" on a phone): your task, the situation, what you have, what the enemy is believed to have, the
 * objectives, how the battle ends (the time limit, a side breaking, the battle-end rules and Claim victory, exits)
 * and the fire rule your units start with.
 *
 * `briefingModel` is pure and reads the BATTLE INPUT only (never the running state): the same card before the first
 * tick and after a reload. Every text is a string-table key with parameters (hard rule 12); a parameter named
 * `...Key` is a key itself and is shown as `...` in words (as the radio lines do). No faction in code: hull names
 * come through `hullNameKey` (data), unit names are the callsigns of the input.
 *
 * The card reuses the campaign screens' frame (`.cmp`: top bar, cards, key-value rows, sticky actions), so the two
 * briefings look alike in both looks.
 */
import type { Strings } from "@tcs/data";
import type { BattleInput, ForceInput, ForceStart, UnitInput } from "@tcs/sim";

export interface BriefText { key: string; params?: Record<string, string | number>; /** The faction whose strings name it (hull names). */ faction?: string }
export interface BriefHulls { nameKey: string; count: number }

export interface BriefingModel {
  /** The player's role (his plan's posture, else his stated posture; null: none, a sandbox). */
  role: "attack" | "defend" | "meeting" | "ambush" | "transit" | "withdraw" | "follow" | null;
  task: BriefText;
  situation: { label: string; value: BriefText }[];
  own: { faction: string; men: number; units: string[]; hulls: BriefHulls[]; support: BriefText[]; late: BriefText[] };
  /** The enemy as believed: men rounded as the campaign's briefing rounds them, platoons, hull types. */
  enemy: { faction: string; men: number; platoons: number; hulls: BriefHulls[] };
  objectives: BriefText[];
  ends: BriefText[];
  /** The fire rule the player's units start with, why, and where to change it. */
  fire: BriefText[];
}

export interface BriefingOptions {
  /** String key of the map's kind ("map.village"). */
  mapKey: string;
  /** The string key of a vehicle type's name (data; the key itself when unknown). */
  hullNameKey(type: string): string;
}

/** Round an estimate (the player sees the enemy's strength only roughly; the campaign briefing's rule). */
export const roughly = (n: number): number => (n <= 10 ? n : n <= 50 ? Math.round(n / 5) * 5 : Math.round(n / 10) * 10);

const menOf = (u: UnitInput): number => u.members.length + u.subunits.reduce((n, c) => n + menOf(c), 0);

/** A force's fighting part: its top units and hulls without the off-map assets (ambulances, recovery, police). */
function fighting(f: ForceInput): { units: UnitInput[]; hulls: Map<string, number> } {
  const off = new Set((f.offMap ?? []).map((a) => a.vehicleId));
  const units = f.units.filter((u) => u.vehicleId === undefined || !off.has(u.vehicleId));
  const hulls = new Map<string, number>();
  for (const v of f.vehicles ?? []) if (!off.has(v.vehicleId)) hulls.set(v.type, (hulls.get(v.type) ?? 0) + 1);
  return { units, hulls };
}

const hullList = (hulls: Map<string, number>, nameKey: (type: string) => string): BriefHulls[] =>
  [...hulls].map(([type, count]) => ({ nameKey: nameKey(type), count })).sort((a, b) => b.count - a.count || (a.nameKey < b.nameKey ? -1 : a.nameKey > b.nameKey ? 1 : 0));

const clock = (seconds: number): string => {
  const m = Math.floor((((seconds % 86400) + 86400) % 86400) / 60);
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
};

export function briefingModel(input: BattleInput, playerSide: string, start: ForceStart | null, o: BriefingOptions): BriefingModel {
  const own = input.forces.find((f) => f.side === playerSide), enemy = input.forces.find((f) => f.side !== playerSide);
  if (!own || !enemy) throw new Error(`briefing: no force of side '${playerSide}' or no enemy`);
  const rules = input.rules, W = input.map.widthM, H = input.map.heightM;
  const role = own.plan?.posture ?? own.posture ?? null;
  const min = (s: number) => Math.round(s / 60);
  const edgeKey = (z: { x0: number; y0: number; x1: number; y1: number }): string => {
    // (A strip along an edge: by its thin side.)
    if (z.x1 - z.x0 <= z.y1 - z.y0) return (z.x0 + z.x1) / 2 < W / 2 ? "brief.edge.west" : "brief.edge.east";
    return (z.y0 + z.y1) / 2 < H / 2 ? "brief.edge.north" : "brief.edge.south";
  };
  const ownExit = (rules.exits ?? []).find((z) => z.side === playerSide && ((z.pointsPerMan ?? 0) > 0 || (z.pointsPerVehicle ?? 0) > 0));
  const enemyExit = (rules.exits ?? []).find((z) => z.side !== playerSide && ((z.pointsPerMan ?? 0) > 0 || (z.pointsPerVehicle ?? 0) > 0));
  const breakOff = own.plan?.breakOff;

  // ---- the task
  const planExit = own.plan?.exit;
  const taskParams: Record<string, string | number> = {};
  if (own.plan?.untilS !== undefined) taskParams["min"] = min(own.plan.untilS);
  const exitShown = role === "ambush" ? enemyExit : planExit;
  if (exitShown) taskParams["edgeKey"] = edgeKey(exitShown);
  const task: BriefText = { key: `brief.task.${role ?? "none"}`, params: taskParams };

  // ---- the situation
  const situation: BriefingModel["situation"] = [
    { label: "brief.map", value: { key: "brief.mapV", params: { mapKey: o.mapKey, w: (W / 1000).toFixed(1), h: (H / 1000).toFixed(1) } } },
  ];
  const env = input.environment;
  if (env?.sky) situation.push({ label: "brief.time", value: { key: "brief.timeV", params: { time: clock(env.timeOfDaySeconds), lightKey: env.light >= 0.8 ? "brief.light.day" : env.light >= 0.2 ? "brief.light.twilight" : "brief.light.night" } } });
  else situation.push({ label: "brief.time", value: { key: "brief.timeDay" } });
  situation.push({ label: "brief.limit", value: { key: "brief.limitV", params: { min: min(rules.timeLimitSeconds) } } });

  // ---- what you have
  const mine = fighting(own);
  const support: BriefText[] = [];
  for (const s of rules.support ?? []) if (s.side === playerSide && s.he + s.smoke + (s.illum ?? 0) > 0) support.push({ key: `brief.support.${s.asset ?? "mortar"}`, params: { he: s.he, smoke: s.smoke, illum: s.illum ?? 0 } });
  if ((rules.airRecon ?? []).includes(playerSide)) support.push({ key: "brief.support.drone" });
  const late: BriefText[] = mine.units.filter((u) => (u.arriveS ?? 0) > 0).map((u) => ({ key: "brief.lateV", params: { unit: u.callsign, min: min(u.arriveS!) } }));

  // ---- the enemy, believed
  const theirs = fighting(enemy);
  const enemyMen = theirs.units.reduce((n, u) => n + menOf(u), 0);

  // ---- objectives
  const objectives: BriefText[] = rules.objectives.map((ob) => {
    const mineNow = ob.holder === playerSide, held = ob.holder !== null && ob.holder !== undefined;
    const key = ob.untilS !== undefined && held ? (mineNow ? "brief.objective.until" : "brief.objective.untilEnemy") : !held ? "brief.objective.free" : mineNow ? "brief.objective.own" : "brief.objective.enemy";
    return { key, params: { nameKey: ob.nameKey, points: ob.points, ...(ob.untilS !== undefined ? { min: min(ob.untilS) } : {}) } };
  });
  if (objectives.length === 0) objectives.push({ key: rules.victory ? "brief.noObjectives" : "brief.noObjectivesPlain" });

  // ---- how it ends
  const ends: BriefText[] = [{ key: rules.victory ? "brief.ends.time" : "brief.ends.timePlain", params: { min: min(rules.timeLimitSeconds) } }];
  if (rules.victory?.endOnDefeat) ends.push({ key: "brief.ends.broken" });
  const be = input.catalog.behaviour.battleEnd;
  if (rules.victory?.decided === true && be) {
    ends.push({ key: "brief.ends.spent", params: { share: Math.round(be.spentShare * 100), forS: be.spentForS, noticeS: be.noticeS } });
    if (rules.objectives.length > 0) ends.push({ key: "brief.ends.decided", params: { quietMin: min(be.quietS), noticeS: be.noticeS } });
    ends.push({ key: "brief.ends.claim" });
  }
  if (ownExit) ends.push({ key: "brief.ends.exitOwn", params: { edgeKey: edgeKey(ownExit) } });
  if (enemyExit) ends.push({ key: "brief.ends.exitEnemy", params: { edgeKey: edgeKey(enemyExit) } });
  if (breakOff) ends.push({ key: "brief.ends.breakOff", params: { edgeKey: edgeKey(breakOff) } });
  if (enemy.plan?.breakOff) ends.push({ key: "brief.ends.breakOffEnemy", params: { edgeKey: edgeKey(enemy.plan.breakOff) } });
  if ((rules.exits ?? []).length > 0) ends.push({ key: "brief.ends.exit" });

  // ---- the fire rule at the start
  const fire: BriefText[] = [];
  if (start?.ambushM !== undefined) fire.push({ key: "brief.fire.ambush", params: { m: Math.round(start.ambushM) } });
  else fire.push({ key: `brief.fire.${start?.fire ?? input.catalog.behaviour.decisions.defaultFireRule}` });
  if (start) {
    const why = role === "attack" || role === "follow" ? "attack" : role === "defend" || role === "withdraw" ? "defend" : role === "meeting" || role === "transit" ? "move" : role === "ambush" ? "ambush" : null;
    if (why) fire.push({ key: `brief.fire.why.${why}` });
  }
  fire.push({ key: "brief.fire.change" });

  return {
    role, task, situation,
    own: { faction: own.faction, men: mine.units.reduce((n, u) => n + menOf(u), 0), units: mine.units.filter((u) => (u.arriveS ?? 0) <= 0).map((u) => u.callsign), hulls: hullList(mine.hulls, o.hullNameKey), support, late },
    enemy: { faction: enemy.faction, men: roughly(enemyMen), platoons: theirs.units.filter((u) => u.echelon === "platoon").length, hulls: hullList(theirs.hulls, o.hullNameKey) },
    objectives, ends, fire,
  };
}

/** Every string key a model shows (tests: each exists in the string table). */
export function briefingKeys(m: BriefingModel): string[] {
  const out: string[] = [];
  const add = (x: BriefText) => { out.push(x.key); for (const [k, v] of Object.entries(x.params ?? {})) if (k.endsWith("Key") && typeof v === "string") out.push(v); };
  add(m.task);
  for (const r of m.situation) { out.push(r.label); add(r.value); }
  [...m.own.support, ...m.own.late, ...m.objectives, ...m.ends, ...m.fire].forEach(add);
  return out;
}

// ------------------------------------------------------------------------------------------------ the card

export interface Briefing {
  /** "start": before the battle (the main button starts it); "resume": opened during it (back to the battle). */
  show(m: BriefingModel, mode: "start" | "resume"): void;
  hide(): void;
  isOpen(): boolean;
  readonly root: HTMLElement;
}

type Child = Node | string | null | undefined | false;
function h(tag: string, cls = "", ...kids: Child[]): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  for (const k of kids) if (k !== null && k !== undefined && k !== false) e.append(k);
  return e;
}

export function createBriefing(parent: HTMLElement, s: Strings, look: "photo" | "flat", cb: { onClose(mode: "start" | "resume"): void; onMenu?: () => void }): Briefing {
  const root = h("div", `cmp brief look-${look}`);
  root.hidden = true;
  parent.append(root);
  let open = false;
  /** A text: its `...Key` parameters in words first. */
  const tx = (x: BriefText): string => {
    const p: Record<string, string | number> = { ...(x.params ?? {}) };
    for (const [k, v] of Object.entries(x.params ?? {})) if (k.endsWith("Key") && typeof v === "string") p[k.slice(0, -3)] = s.t(v, {}, x.faction);
    return s.t(x.key, p, x.faction);
  };
  const t = (k: string, p: Record<string, string | number> = {}) => s.t(k, p);
  const section = (title: string, cls: string, ...kids: Child[]) => { const e = h("section", `cmp-card ${cls}`, h("h3", "cmp-h", title), ...kids); return e; };
  const kv = (label: string, value: string) => h("div", "cmp-kv", h("span", "", label), h("b", "", value));
  const note = (text: string, cls = "") => h("div", `cmp-note ${cls}`, text);
  /** (A name stays on one line: "Leopard 2A7V", "Zug 1" wrap between items, not inside one.) */
  const whole = (text: string) => text.replace(/ /g, "\u00a0");
  const hulls = (list: BriefHulls[], faction: string) => list.map((x) => whole(`${x.count} × ${s.has(x.nameKey, faction) ? s.t(x.nameKey, {}, faction) : x.nameKey}`)).join(", ");
  const button = (text: string, cls: string, act: string, on: () => void) => {
    const b = h("button", `cmp-btn ${cls}`, text) as HTMLButtonElement;
    b.type = "button"; b.dataset["act"] = act; b.onclick = (ev) => { ev.stopPropagation(); on(); };
    return b;
  };
  // (Nothing behind the card takes its taps, wheel or keys while it is open.)
  for (const ev of ["pointerdown", "pointerup", "click", "wheel", "touchstart", "contextmenu"]) root.addEventListener(ev, (e) => e.stopPropagation());

  return {
    root,
    isOpen: () => open,
    hide() { open = false; root.hidden = true; root.replaceChildren(); },
    show(m, mode) {
      open = true;
      const close = () => { this.hide(); cb.onClose(mode); };
      const body = h("div", "cmp-body brief-body");
      body.append(h("div", "cmp-node brief-task", h("div", "cmp-node-kicker", t("brief.task")), h("div", "brief-task-text", tx(m.task))));
      const cols = h("div", "brief-cols");
      cols.append(section(t("brief.situation"), "brief-situation", ...m.situation.map((r) => kv(t(r.label), tx(r.value)))));
      const own = section(t("brief.own"), "brief-own", kv(t("brief.men"), String(m.own.men)));
      if (m.own.units.length > 0) own.append(kv(t("brief.units"), m.own.units.map(whole).join(", ")));
      if (m.own.hulls.length > 0) own.append(kv(t("brief.vehicles"), hulls(m.own.hulls, m.own.faction)));
      for (const x of m.own.support) own.append(note(tx(x)));
      if (m.own.late.length > 0) own.append(kv(t("brief.late"), m.own.late.map(tx).join("; ")));
      cols.append(own);
      const en = section(t("brief.enemy"), "brief-enemy",
        note(m.enemy.platoons === 1 ? t("brief.enemyV1", { men: m.enemy.men }) : m.enemy.platoons > 1 ? t("brief.enemyV", { men: m.enemy.men, platoons: m.enemy.platoons }) : t("brief.enemyMen", { men: m.enemy.men }), "strong"));
      if (m.enemy.hulls.length > 0) en.append(note(hulls(m.enemy.hulls, m.enemy.faction)));
      cols.append(en);
      cols.append(section(t("brief.objectives"), "brief-objectives", ...m.objectives.map((x) => note(tx(x), "strong"))));
      const ends = h("ul", "brief-list");
      for (const x of m.ends) ends.append(h("li", "", tx(x)));
      cols.append(section(t("brief.ends"), "brief-ends", ends));
      const fire = section(t("brief.fire"), "brief-fire", note(tx(m.fire[0]!), "strong"));
      if (m.fire.length > 1) fire.append(note(m.fire.slice(1).map(tx).join(" ")));
      cols.append(fire);
      body.append(cols);
      const bar = h("div", "cmp-actions sticky");
      if (mode === "start" && cb.onMenu) bar.append(button(t("brief.menu"), "", "menu", cb.onMenu));
      bar.append(button(t(mode === "start" ? "brief.start" : "brief.back"), "primary", "start", close));
      body.append(bar);
      const top = h("div", "cmp-top", h("div", "cmp-title", t("brief.title")));
      if (mode === "resume") top.append(button("✕", "cmp-back", "close", close));
      root.dataset["mode"] = mode;
      root.replaceChildren(top, h("div", "cmp-scroll", body));
      root.hidden = false;
    },
  };
}
