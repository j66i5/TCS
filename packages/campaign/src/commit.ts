/**
 * WHO FIGHTS (M12.1a; the player's choice and validation come with M12.2): a battle takes at most one company's worth
 * per side (`core/campaign.json` `battle`): the fittest company (most men; ties: the first), its headquarters and its
 * platoons, and the battalion's support up to the cap (mortar section, AGL team, missile team, tank section). The
 * committed units go into the battle as top-level units (the company headquarters with its own hull, each platoon,
 * each support unit); hulls not in service stay out, and their crews with them (they rest); a carried squad whose
 * carrier is not there walks. Everything is a deep copy: the record is changed only by `applyResult`.
 */
import type { DataSet } from "@tcs/data";
import type { UnitInput, VehicleRecord } from "@tcs/sim";
import type { ScenarioForces } from "@tcs/scenario";
import type { CampaignForce } from "./record";
import { clone, membersOf } from "./record";
import { campaignRules } from "./rules";

const menIn = (u: UnitInput) => membersOf(u).length;

/** Men a unit (with its sub-units) can take into a battle: its members less the crews of hulls not in service (in
 *  the workshop or lost: they rest, `withHulls`). Every "able" count of the choice goes through this, so a choice never
 *  promises men the battle leaves out (review M12: a company of idle crews was proposed and its battle had 0 men). */
export function deployableMen(f: CampaignForce, u: UnitInput): number {
  return withHulls([u], f.vehicles).units.reduce((n, x) => n + menIn(x), 0);
}

/** A company with at least one platoon that has deployable men. */
const canFight = (f: CampaignForce, c: UnitInput) => c.subunits.some((p) => p.echelon === "platoon" && deployableMen(f, p) > 0);

/** The fittest company of a battalion (most deployable men, with an able platoon; ties: the first in order), or null. */
export function fittestCompany(f: CampaignForce): UnitInput | null {
  let best: UnitInput | null = null, bestMen = 0;
  for (const c of f.battalion.subunits) {
    if (c.echelon !== "company" || !canFight(f, c)) continue;
    const n = deployableMen(f, c);
    if (best === null || n > bestMen) { best = c; bestMen = n; }
  }
  return best;
}

/** The support units of a battalion by kind (its sub-units made from the manifest's support templates). */
function supportOf(data: DataSet, f: CampaignForce): { kind: "mortarSections" | "aglTeams" | "missileTeams" | "tankSections"; unit: UnitInput }[] {
  const m = data.factions[f.faction]!.manifest;
  const kinds: [string | undefined, "mortarSections" | "aglTeams" | "missileTeams" | "tankSections"][] = [
    [m.mortarTemplate, "mortarSections"], [m.aglTeamTemplate, "aglTeams"], [m.missileTeamTemplate, "missileTeams"], [m.tankSectionTemplate, "tankSections"],
  ];
  const out: { kind: "mortarSections" | "aglTeams" | "missileTeams" | "tankSections"; unit: UnitInput }[] = [];
  for (const u of f.battalion.subunits) {
    const t = f.establishment[u.key];
    const k = kinds.find(([id]) => id !== undefined && id === t);
    if (k) out.push({ kind: k[1], unit: u });
  }
  return out;
}

/** The units and hulls a side commits to a battle (see the file comment). Empty units: none to commit. */
export function proposeCommit(data: DataSet, f: CampaignForce): ScenarioForces {
  return commitOf(data, f, proposeChoice(data, f));
}

// ------------------------------------------------------------------------------------------------ choosing (M12.2)

/** M12.2: what the player picks from (and what a choice names): a company's headquarters (its key: the company without
 *  its platoons), its platoons, and the battalion's support units. */
export interface Selectable {
  key: string;
  what: "hq" | "platoon" | "section" | "mortarSections" | "aglTeams" | "missileTeams" | "tankSections";
  /** The company (hq, platoon, section). */
  company?: string;
  /** Balance pass 6, a half platoon (`sectionsOf`; key `<platoon key>/a` or `/b`): its platoon and which half. */
  platoon?: string; half?: "a" | "b";
  /** Deployable men (`deployableMen`: the unit's men with it less the crews of hulls not in service; for an hq without
   *  its platoons). */
  men: number;
}

/**
 * Balance pass 6 (owner 2026-11-20: "Smaller forces vs strong side"): a platoon's two halves, for a battle smaller
 * than a platoon. "a": the platoon's own men (its headquarters), the squads that ride with them and further squads up
 * to half of them (rounded down, at least one), with their carriers' crews and everything else of the platoon that is
 * not a squad or a crew; "b": the other squads and their carriers' crews, without the headquarters. Both are pruned
 * copies under the platoon's own key, so a battle's results come back by unit key (`applyResult` leaves the men who
 * stayed at home where they are). Null: fewer than two squads.
 */
export function sectionsOf(p: UnitInput): { a: UnitInput; b: UnitInput } | null {
  const squads = p.subunits.filter((s) => s.vehicleId === undefined);
  if (squads.length < 2) return null;
  const withHq = squads.filter((s) => p.carrierId !== undefined && s.carrierId === p.carrierId);
  const aSquads = [...withHq, ...squads.filter((s) => !withHq.includes(s))].slice(0, Math.max(1, Math.floor(squads.length / 2), withHq.length));
  if (aSquads.length >= squads.length) return null;
  const aKeys = new Set(aSquads.map((s) => s.key));
  const bHulls = new Set(squads.filter((s) => !aKeys.has(s.key) && s.carrierId !== undefined).map((s) => s.carrierId!));
  const aHulls = new Set([p.carrierId, ...aSquads.map((s) => s.carrierId)].filter((x): x is string => x !== undefined));
  const inA = (s: UnitInput) => (squads.includes(s) ? aKeys.has(s.key) : s.vehicleId !== undefined ? aHulls.has(s.vehicleId) || !bHulls.has(s.vehicleId) : true);
  const { carrierId: _c, ...rest } = p;
  void _c;
  return { a: { ...p, subunits: p.subunits.filter(inA) }, b: { ...rest, members: [], leaderIndex: -1, subunits: p.subunits.filter((s) => !inA(s)) } };
}

/** The platoon key and half of a section key (`<platoon key>/a`), or null. */
function sectionKey(k: string): { platoon: string; half: "a" | "b" } | null {
  const h = k.endsWith("/a") ? "a" : k.endsWith("/b") ? "b" : null;
  return h === null ? null : { platoon: k.slice(0, -2), half: h };
}

/** Keys committed elsewhere, with what overlaps them: a half platoon's platoon and its other half, a platoon's two
 *  halves (the same men must not fight two battles of a node). */
function overlapping(keys: readonly string[]): Set<string> {
  const out = new Set(keys);
  for (const k of keys) {
    const sk = sectionKey(k), pl = sk ? sk.platoon : k;
    if (sk) out.add(pl);
    out.add(`${pl}/a`); out.add(`${pl}/b`);
  }
  return out;
}

/** A company's headquarters: the company without its platoons. */
function hqOf(company: UnitInput): UnitInput {
  return { ...company, subunits: company.subunits.filter((s) => s.echelon !== "platoon") };
}

/** Everything a side may commit, in the battalion's order (companies: hq, then platoons, each followed by its two
 *  halves when `battle.sections` is on; then support). */
export function selectables(data: DataSet, f: CampaignForce): Selectable[] {
  const out: Selectable[] = [];
  const sections = campaignRules(data).battle.sections === true;
  for (const c of f.battalion.subunits) {
    if (c.echelon !== "company") continue;
    out.push({ key: c.key, what: "hq", company: c.key, men: deployableMen(f, hqOf(c)) });
    for (const p of c.subunits) {
      if (p.echelon !== "platoon") continue;
      out.push({ key: p.key, what: "platoon", company: c.key, men: deployableMen(f, p) });
      const sec = sections ? sectionsOf(p) : null;
      if (sec) for (const h of ["a", "b"] as const) out.push({ key: `${p.key}/${h}`, what: "section", company: c.key, platoon: p.key, half: h, men: deployableMen(f, sec[h]) });
    }
  }
  for (const s of supportOf(data, f)) out.push({ key: s.unit.key, what: s.kind, men: deployableMen(f, s.unit) });
  return out;
}

/** The default choice (unit keys): the fittest company not excluded (its hq and up to `battle.platoons` platoons with
 *  men), and the support up to the cap that is not excluded. `exclude`: keys already committed elsewhere (a flank
 *  battle's company is not the main battle's). Empty: nothing able to commit. */
export function proposeChoice(data: DataSet, f: CampaignForce, exclude: readonly string[] = [], valueRatio = 1): string[] {
  const cap = campaignRules(data).battle;
  const ex = overlapping(exclude);
  let company: UnitInput | null = null, companyMen = 0;
  for (const c of f.battalion.subunits) {
    if (c.echelon !== "company" || ex.has(c.key) || c.subunits.some((p) => ex.has(p.key)) || !canFight(f, c)) continue;
    const n = deployableMen(f, c);
    if (company === null || n > companyMen) { company = c; companyMen = n; }
  }
  if (!company) return [];
  const keys: string[] = [];
  if (cap.companyHq && deployableMen(f, hqOf(company)) > 0) keys.push(company.key);
  // Balance pass 6 (owner 2026-11-20: "Smaller forces vs strong side"): a side whose men are worth more than the
  // enemy's (`valueRatio`, its fighting value over the enemy's, above 1) is proposed fewer platoons, the cap divided
  // by the ratio (at least one): the enemy then has room under its own cap to bring the numbers the ratio asks for.
  const platoons = cap.sections === true && valueRatio > 1 ? Math.max(1, Math.round(cap.platoons / valueRatio)) : cap.platoons;
  const able = company.subunits.filter((s) => s.echelon === "platoon" && deployableMen(f, s) > 0);
  // (And at `proposeSectionAtRatio` or more: the first half, with the platoon's headquarters, of its first able
  // platoon; a platoon that cannot be halved, or whose half has no men: the platoon.)
  const half = cap.sections === true && cap.proposeSectionAtRatio !== undefined && valueRatio >= cap.proposeSectionAtRatio && able.length > 0 ? sectionsOf(able[0]!) : null;
  if (half && deployableMen(f, half.a) > 0 && !ex.has(`${able[0]!.key}/a`)) keys.push(`${able[0]!.key}/a`);
  else keys.push(...able.slice(0, platoons).map((p) => p.key));
  const left = { mortarSections: cap.mortarSections, aglTeams: cap.aglTeams, missileTeams: cap.missileTeams, tankSections: cap.tankSections };
  for (const s of supportOf(data, f)) if (!ex.has(s.unit.key) && left[s.kind] > 0 && deployableMen(f, s.unit) > 0) { left[s.kind]--; keys.push(s.unit.key); }
  return keys;
}

/**
 * The enemy's choice for a node: platoons of any company, the fittest first (most men; ties: battalion order), until
 * its men reach `ratio` times `against` (the player's committed men) or the cap; with `support`, the headquarters of
 * the company most of them come from and the support units up to the cap. Never more than the cap; at least one
 * platoon when any has men. `exclude`: keys committed elsewhere. `capScale` (M12.4): every cap times it (rounded; platoons
 * at least 1).
 * Balance pass 6 (owner 2026-11-20: "Smaller forces vs strong side"; `battle.sections`): when the men wanted are
 * fewer than `battle.sectionBelow` of the fittest platoon, the enemy commits one half of that platoon (the half whose
 * men are nearest the number wanted; `sectionsOf`), without headquarters or support whatever the node says.
 */
export function enemyChoice(data: DataSet, f: CampaignForce, against: number, ratio: number, support: boolean, exclude: readonly string[] = [], capScale = 1): string[] {
  const cap0 = campaignRules(data).battle;
  // M12.4: the caps scaled (`enemyFor`: by the fighting values, at most `enemyCapScale`); at least one platoon.
  const sc = (n: number) => Math.round(n * capScale);
  const cap = { ...cap0, platoons: Math.max(1, sc(cap0.platoons)), mortarSections: sc(cap0.mortarSections), missileTeams: sc(cap0.missileTeams), aglTeams: sc(cap0.aglTeams), tankSections: sc(cap0.tankSections) };
  const ex = overlapping(exclude);
  const all = selectables(data, f);
  const plats = all.filter((s) => s.what === "platoon" && s.men > 0 && !ex.has(s.key))
    .map((s, i) => ({ s, i })).sort((a, b) => b.s.men - a.s.men || a.i - b.i).map((x) => x.s);
  const keys: string[] = [];
  let men = 0;
  const want = ratio * against;
  if (cap0.sections === true && plats.length > 0 && want < (cap0.sectionBelow ?? 0.75) * plats[0]!.men) {
    const secs = all.filter((s) => s.what === "section" && s.platoon === plats[0]!.key && s.men > 0 && !ex.has(s.key))
      .sort((a, b) => Math.abs(a.men - want) - Math.abs(b.men - want) || (a.key < b.key ? -1 : 1));
    if (secs.length > 0) return [secs[0]!.key];
  }
  for (const p of plats) {
    if (keys.length >= cap.platoons || (keys.length > 0 && men >= want)) break;
    keys.push(p.key); men += p.men;
  }
  if (keys.length === 0) return [];
  if (support) {
    const byCompany = new Map<string, number>();
    for (const k of keys) { const c = all.find((s) => s.key === k)!.company!; byCompany.set(c, (byCompany.get(c) ?? 0) + 1); }
    let best: string | null = null;
    for (const [c, n] of byCompany) if (best === null || n > byCompany.get(best)!) best = c;
    const hq = all.find((s) => s.what === "hq" && s.key === best);
    if (cap.companyHq && hq && hq.men > 0 && !ex.has(hq.key)) keys.unshift(hq.key);
    const left = { mortarSections: cap.mortarSections, aglTeams: cap.aglTeams, missileTeams: cap.missileTeams, tankSections: cap.tankSections };
    for (const s of all) if (s.what !== "hq" && s.what !== "platoon" && s.what !== "section" && !ex.has(s.key) && left[s.what] > 0 && s.men > 0) { left[s.what]--; keys.push(s.key); }
  }
  return keys;
}

/** A problem with a choice, as a string-table key and its parameters (review M12, rule 12: the UI says it through
 *  `Strings.t("cmp.problem.<key>")`; `text` is the plain-English form for logs, tests and errors). `unit`: a unit key;
 *  `what`: a selectable kind ("platoon", "hq", "mortarSections", ...); `vehicle`: a hull id. */
export interface CommitProblem {
  key: "unknown" | "twice" | "elsewhere" | "noMen" | "cap" | "noPlatoon" | "squadNoCarrier" | "carrierNoSquad";
  params: { unit?: string; what?: string; n?: number; max?: number; vehicle?: string };
  text: string;
}

/** Problems with a choice as plain-English lines (empty: it may fight); `commitProblems` has them for the screen. */
export function validateCommit(data: DataSet, f: CampaignForce, keys: readonly string[], exclude: readonly string[] = []): string[] {
  return commitProblems(data, f, keys, exclude).map((x) => x.text);
}

/** Problems with a choice (empty: it may fight): unknown or doubled keys, more than the cap, no able platoon, a unit
 *  without men, a carrier committed without the squads it carries or a squad without its carrier in service. */
export function commitProblems(data: DataSet, f: CampaignForce, keys: readonly string[], exclude: readonly string[] = []): CommitProblem[] {
  const cap = campaignRules(data).battle;
  const p: CommitProblem[] = [];
  const say = (key: CommitProblem["key"], params: CommitProblem["params"], text: string) => { p.push({ key, params, text }); };
  const all = new Map(selectables(data, f).map((s) => [s.key, s]));
  const seen = new Set<string>();
  const count = { hq: 0, platoon: 0, section: 0, mortarSections: 0, aglTeams: 0, missileTeams: 0, tankSections: 0 };
  // (Balance pass 6: a half platoon counts as a platoon toward the cap, both halves of one platoon as one; a platoon
  // and one of its own halves together is "twice".)
  const platoonsIn = new Set<string>();
  const elsewhere = overlapping(exclude);
  for (const k of keys) {
    const s = all.get(k);
    if (!s) { say("unknown", { unit: k }, `not selectable: ${k}`); continue; }
    if (seen.has(k) || (s.what === "section" && seen.has(s.platoon!)) || (s.what === "platoon" && (seen.has(`${k}/a`) || seen.has(`${k}/b`)))) { say("twice", { unit: k }, `twice: ${k}`); continue; }
    if (s.what === "platoon" || s.what === "section") platoonsIn.add(s.platoon ?? k);
    if (elsewhere.has(k)) say("elsewhere", { unit: k }, `committed elsewhere: ${k}`);
    seen.add(k);
    if (s.men === 0) say("noMen", { unit: k }, `no men: ${k}`);
    count[s.what]++;
  }
  if (platoonsIn.size > cap.platoons) say("cap", { what: "platoon", n: platoonsIn.size, max: cap.platoons }, `platoons ${platoonsIn.size} > ${cap.platoons}`);
  if (count.hq > (cap.companyHq ? 1 : 0)) say("cap", { what: "hq", n: count.hq, max: cap.companyHq ? 1 : 0 }, `company headquarters ${count.hq} > ${cap.companyHq ? 1 : 0}`);
  for (const k of ["mortarSections", "aglTeams", "missileTeams", "tankSections"] as const) if (count[k] > cap[k]) say("cap", { what: k, n: count[k], max: cap[k] }, `${k} ${count[k]} > ${cap[k]}`);
  if (![...seen].some((k) => (all.get(k)!.what === "platoon" || all.get(k)!.what === "section") && all.get(k)!.men > 0)) say("noPlatoon", {}, "no able platoon");
  // Carriers and their squads go together (a committed hull's carried squads are committed; a committed squad's
  // carrier, when in service, is committed).
  const units = unitsInChoice(f, [...seen]);
  const inUnits = new Set(units.flatMap(unitsOfTree).map((u) => u.key));
  const going = new Set(units.flatMap(unitsOfTree).flatMap((u) => u.members.map((m) => m.personId)));
  const service = new Set(f.vehicles.map((v) => v.vehicleId));
  const crewOf = new Map<string, string>();
  for (const u of unitsOfTree(f.battalion)) if (u.vehicleId !== undefined && u.members.length > 0) crewOf.set(u.vehicleId, u.key);
  for (const u of unitsOfTree(f.battalion)) {
    if (u.carrierId === undefined || !service.has(u.carrierId) || u.members.length === 0) continue;
    const crew = crewOf.get(u.carrierId);
    if (crew === undefined) continue;
    // (Balance pass 6: "committed" is its men going, not its key: a platoon's second half goes under the platoon's
    // key without the platoon's own men.)
    const goes = u.members.some((m) => going.has(m.personId));
    if (goes && !inUnits.has(crew)) say("squadNoCarrier", { unit: u.key, vehicle: u.carrierId }, `squad ${u.key} without its carrier ${u.carrierId}`);
    if (inUnits.has(crew) && !goes) say("carrierNoSquad", { unit: u.key, vehicle: u.carrierId }, `carrier ${u.carrierId} without its squad ${u.key}`);
  }
  return p;
}

function unitsOfTree(u: UnitInput): UnitInput[] {
  return [u, ...u.subunits.flatMap(unitsOfTree)];
}

/** The battalion's units a choice names (a company key: its headquarters; a section key: that half of its platoon,
 *  both halves of one platoon: the platoon), in the choice's order. */
function unitsInChoice(f: CampaignForce, keys: readonly string[]): UnitInput[] {
  const out: UnitInput[] = [];
  const tree = unitsOfTree(f.battalion);
  for (const k of keys) {
    const sk = sectionKey(k), pl = sk ? tree.find((x) => x.key === sk.platoon && x.echelon === "platoon") : undefined;
    if (sk && pl) {
      const other = `${sk.platoon}/${sk.half === "a" ? "b" : "a"}`;
      if (keys.includes(other)) { if (keys.indexOf(other) > keys.indexOf(k)) out.push(pl); continue; }
      const sec = sectionsOf(pl);
      if (sec) out.push(sec[sk.half]);
      continue;
    }
    const u = tree.find((x) => x.key === k);
    if (!u) continue;
    out.push(u.echelon === "company" ? hqOf(u) : u);
  }
  return out;
}

/** The forces of a choice (deep copies; hulls in service with their crews, see `withHulls`). */
export function commitOf(data: DataSet, f: CampaignForce, keys: readonly string[]): ScenarioForces {
  void data;
  return withHulls(clone(unitsInChoice(f, keys).filter((u) => menIn(u) > 0)), f.vehicles);
}

/** Committed units with the hulls in service they crew: crews without a hull in service left out, carriers that are
 *  not there taken off their squads. */
function withHulls(units: UnitInput[], inService: readonly VehicleRecord[]): ScenarioForces {
  const have = new Set(inService.map((v) => v.vehicleId));
  const crewed = new Set<string>();
  const strip = (u: UnitInput): UnitInput | null => {
    if (u.vehicleId !== undefined && !have.has(u.vehicleId)) return null;
    const subunits = u.subunits.map(strip).filter((x): x is UnitInput => x !== null);
    if (u.members.length === 0 && subunits.length === 0) return null;
    if (u.vehicleId !== undefined && u.members.length > 0) crewed.add(u.vehicleId);
    return { ...u, subunits };
  };
  const kept = units.map(strip).filter((x): x is UnitInput => x !== null);
  const fix = (u: UnitInput): UnitInput => {
    const { carrierId, vehicleId, arriveS: _a, ...rest } = u;
    void _a;
    return {
      ...rest, subunits: u.subunits.map(fix),
      ...(vehicleId !== undefined && crewed.has(vehicleId) ? { vehicleId } : {}),
      ...(carrierId !== undefined && crewed.has(carrierId) ? { carrierId } : {}),
    };
  };
  const out = kept.map(fix);
  return { units: out, vehicles: clone(inService.filter((v) => crewed.has(v.vehicleId))) };
}
