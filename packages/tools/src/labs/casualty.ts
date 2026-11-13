/**
 * CASUALTY LAB (SPEC 5.4, 6.4): what happens to men who are shot.
 *
 * Pairs of one rifleman and one target soldier. Each rifleman (regular, prone) fires at his own target until it
 * has been struck once, then ceases fire (rounds already in the air still arrive). Every round is a real
 * projectile meeting the real body outline, armour and wound rules. Afterwards the lab runs each casualty's
 * physiology forward WITHOUT ANY CARE to 10 and 60 minutes.
 *
 * For the owner's review: the mix of killed / incapacitated / wounded, where the rounds strike, what the plate
 * and helmet stop, and how fast untreated men die.
 */
import { buildCatalog, type DataSet } from "@tcs/data";
import {
  createSim, DEFAULT_COMMS, flatMap, simplePhysiology, step, submitOrder,
  type BattleInput, type Catalog, type EntityId, type Posture, type SoldierRecord,
} from "@tcs/sim";

export interface CasualtyCase {
  name: string;
  shooterFaction: string;
  weapon: string;
  targetFaction: string;
  rangeM: number;
  posture: Posture;
  /** Target faces the shooter (true) or stands side-on (false). */
  facing: boolean;
  armour: boolean;
  pairs?: number;
  seeds?: number;
}

export interface CasualtyRow {
  name: string;
  /** Men struck at least once. */
  struck: number;
  /** Struck, but armour stopped every round: bruised, not wounded. */
  savedByArmour: number;
  /** Men with at least one penetrating wound (the casualties below are shares of these). */
  wounded: number;
  killedOutright: number;
  incapacitated: number;
  woundedAble: number;
  ableCanFight: number;
  dead10min: number;
  dead60min: number;
  /** Median minutes until an untreated man who was still conscious passes out (of those who do within 60 min). */
  medianMinutesToCollapse: number | null;
  /** First strike per man, by zone. */
  zones: Record<string, number>;
  /** Rounds on chest, abdomen or head by what the armour did. */
  torsoStopped: number; torsoThrough: number; torsoUncovered: number;
  headStopped: number; headThrough: number;
}

function runOnce(catalog: Catalog, c: CasualtyCase, seed: number, row: CasualtyRow): void {
  const pairs = c.pairs ?? 30;
  const wd = catalog.weapons[c.weapon];
  if (!wd) throw new Error(`unknown weapon '${c.weapon}'`);
  const map = flatMap("casualty", c.rangeM + 60, 40 + pairs * 6, 4);
  const armourItems = Object.values(catalog.items).filter((i) => i.armour && i.id.startsWith(`${c.targetFaction}-`)).map((i) => ({ type: i.id, count: 1 }));
  const man = (personId: string, extra: Partial<SoldierRecord>): SoldierRecord => ({
    personId, given: "Lab", family: personId, rank: "r", role: "rifleman", skills: { marksmanship: 0.5 },
    fatigue: 0, stress: 0, wounds: [], load: [], status: "fit", ...extra,
  });
  const shooters = Array.from({ length: pairs }, (_, i) => man(`s#${i}`, { weapon: c.weapon, load: [{ type: wd.feed.magazine, count: 4, charge: catalog.items[wd.feed.magazine]?.chargeCapacity ?? 30 }] }));
  const targets = Array.from({ length: pairs }, (_, i) => man(`t#${i}`, { load: c.armour ? armourItems : [] }));
  const y = (i: number) => 20 + i * 6;
  const tx = 20 + c.rangeM;
  // (The targets keep the facing the case gives them: an idle man turning to face the fire, package C, is not what
  // this lab measures.)
  const labCatalog = { ...catalog, behaviour: { ...catalog.behaviour, soldier: { ...catalog.behaviour.soldier, faceEnemy: false } } };
  const input: BattleInput = {
    map, catalog: labCatalog, seed, orders: [],
    rules: { timeLimitSeconds: 36000, commsModel: "simple", comms: { ...DEFAULT_COMMS, orderDelaySeconds: 0, orderDelayJitterSeconds: 0 }, physiologyModel: "simple", physiologyParams: {}, objectives: [] },
    forces: [
      { side: "blue", faction: c.shooterFaction, units: [{ key: "s", callsign: "S", echelon: "team", leaderIndex: 0, subunits: [], members: shooters }], placements: shooters.map((m, i) => ({ personId: m.personId, x: 20, y: y(i), heading: 0 })) },
      { side: "red", faction: c.targetFaction, units: [{ key: "t", callsign: "T", echelon: "team", leaderIndex: 0, subunits: [], members: targets }], placements: targets.map((m, i) => ({ personId: m.personId, x: tx, y: y(i), heading: c.facing ? Math.PI : Math.PI / 2 })) },
    ],
  };
  const sim = createSim(input);
  const idOf = new Map<string, EntityId>();
  for (const [id, ident] of sim.state.identity.entries()) idOf.set(ident.personId, id);
  const sId = shooters.map((m) => idOf.get(m.personId)!), tId = targets.map((m) => idOf.get(m.personId)!);
  const pairOf = new Map<EntityId, number>(tId.map((id, i) => [id, i]));
  for (const id of sId) submitOrder(sim, { tick: 0, issuer: "blue", target: id, kind: "posture", posture: "prone" });
  for (const id of tId) submitOrder(sim, { tick: 0, issuer: "red", target: id, kind: "posture", posture: c.posture });
  const aimH = c.posture === "standing" ? 1.25 : c.posture === "crouching" ? 0.75 : 0.15;
  const firstZone: (string | null)[] = targets.map(() => null);
  const penetrated: boolean[] = targets.map(() => false);
  const done: boolean[] = targets.map(() => false);
  let left = pairs, tail = -1;
  for (let t = 0; t < 60 * 180; t++) {
    if (t % 1200 === 240) for (let i = 0; i < pairs; i++) if (!done[i]) submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: sId[i]!, kind: "fire", x: tx, y: y(i), heightM: aimH });
    // Lab harness: the riflemen take their time (the table is about wounds, not about hurried first shots).
    for (const [, task] of sim.state.fire.entries()) task.startTick = -100000;
    for (const e of step(sim)) {
      if (e.kind !== "hit") continue;
      const i = pairOf.get(e.target);
      if (i === undefined) continue;
      const group = e.zone.replace(/[LR]$/, "");
      if (firstZone[i] === null) firstZone[i] = group;
      if (e.armour !== "stopped") penetrated[i] = true;
      if (group === "chest" || group === "abdomen") { if (e.armour === "stopped") row.torsoStopped++; else if (e.armour === "penetrated") row.torsoThrough++; else row.torsoUncovered++; }
      if (group === "head") { if (e.armour === "stopped") row.headStopped++; else row.headThrough++; }
      if (!done[i]) { done[i] = true; left--; submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: sId[i]!, kind: "ceaseFire" }); }
    }
    if (left === 0 && tail < 0) tail = t + 180; // let rounds in flight arrive
    if (tail >= 0 && t >= tail) break;
  }
  const params = sim.ctx.physiologyParams;
  const dt = params["stepSeconds"] ?? 0.5;
  const collapse: number[] = [];
  for (let i = 0; i < pairs; i++) {
    if (firstZone[i] === null) continue;
    row.struck++;
    row.zones[firstZone[i]!] = (row.zones[firstZone[i]!] ?? 0) + 1;
    if (!penetrated[i]) { row.savedByArmour++; continue; }
    row.wounded++;
    const s = sim.state.soldier.req(tId[i]!);
    if (!s.physiology.alive) row.killedOutright++;
    else if (s.physiology.consciousness < 0.5) row.incapacitated++;
    else { row.woundedAble++; if (s.impair.canFight) row.ableCanFight++; }
    // The clock, with no care at all.
    const p = { ...s.physiology }, wounds = s.wounds.map((w) => ({ ...w }));
    const wasConscious = p.alive && p.consciousness >= 0.5;
    let collapsedAt = -1;
    for (let sec = 0; sec < 3600; sec += dt) {
      if (p.alive) simplePhysiology.step(p, wounds, dt, params);
      if (wasConscious && collapsedAt < 0 && (!p.alive || p.consciousness < 0.5)) collapsedAt = sec;
      if (Math.abs(sec + dt - 600) < dt / 2 && !p.alive) row.dead10min++;
    }
    if (!p.alive) row.dead60min++;
    if (collapsedAt >= 0) collapse.push(collapsedAt / 60);
  }
  (row as { _collapse?: number[] })._collapse = [...((row as { _collapse?: number[] })._collapse ?? []), ...collapse];
}

export function casualtyCase(catalog: Catalog, c: CasualtyCase): CasualtyRow {
  const row: CasualtyRow = {
    name: c.name, struck: 0, savedByArmour: 0, wounded: 0, killedOutright: 0, incapacitated: 0, woundedAble: 0, ableCanFight: 0,
    dead10min: 0, dead60min: 0, medianMinutesToCollapse: null, zones: {}, torsoStopped: 0, torsoThrough: 0, torsoUncovered: 0, headStopped: 0, headThrough: 0,
  };
  for (let seed = 1; seed <= (c.seeds ?? 10); seed++) runOnce(catalog, c, seed, row);
  const col = ((row as { _collapse?: number[] })._collapse ?? []).sort((a, b) => a - b);
  delete (row as { _collapse?: number[] })._collapse;
  row.medianMinutesToCollapse = col.length > 0 ? col[Math.floor(col.length / 2)]! : null;
  return row;
}

export function casualtyLab(data: DataSet): CasualtyRow[] {
  const cat = buildCatalog(data, ["de", "ru"]);
  const de = { shooterFaction: "de", weapon: "de-g36", targetFaction: "ru" }, ru = { shooterFaction: "ru", weapon: "ru-ak74m", targetFaction: "de" };
  const cases: CasualtyCase[] = [
    { name: "G36 at 100 m, standing, facing, helmet + plates", ...de, rangeM: 100, posture: "standing", facing: true, armour: true },
    { name: "G36 at 100 m, standing, facing, NO armour", ...de, rangeM: 100, posture: "standing", facing: true, armour: false },
    { name: "G36 at 100 m, standing, side-on, helmet + plates", ...de, rangeM: 100, posture: "standing", facing: false, armour: true },
    { name: "G36 at 300 m, standing, facing, helmet + plates", ...de, rangeM: 300, posture: "standing", facing: true, armour: true },
    { name: "G36 at 100 m, crouching, facing, helmet + plates", ...de, rangeM: 100, posture: "crouching", facing: true, armour: true },
    { name: "G36 at 100 m, prone, facing, helmet + plates", ...de, rangeM: 100, posture: "prone", facing: true, armour: true },
    { name: "AK-74M at 100 m, standing, facing, helmet + plates", ...ru, rangeM: 100, posture: "standing", facing: true, armour: true },
    { name: "AK-74M at 300 m, standing, facing, helmet + plates", ...ru, rangeM: 300, posture: "standing", facing: true, armour: true },
  ];
  return cases.map((c) => casualtyCase(cat, c));
}

export function casualtyLabMarkdown(rows: CasualtyRow[]): string {
  const pct = (a: number, b: number) => (b > 0 ? `${Math.round((100 * a) / b)} %` : "–");
  const out: string[] = [
    "Each man is fired at until struck once (rounds already in the air may strike him again). 300 men per row.",
    "\"Wounded\" = at least one round got through to the body. Deaths at 10 and 60 minutes are with NO care at all.", "",
    "### What happens to men who are struck", "",
    "| case | struck | saved by armour | wounded | killed outright | unconscious | wounded, conscious | of those: can still fight | dead by 10 min | dead by 60 min | median min to collapse |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
  ];
  for (const r of rows) {
    out.push(`| ${r.name} | ${r.struck} | ${pct(r.savedByArmour, r.struck)} | ${r.wounded} | ${pct(r.killedOutright, r.wounded)} | ${pct(r.incapacitated, r.wounded)} | ${pct(r.woundedAble, r.wounded)} | ${pct(r.ableCanFight, r.woundedAble)} | ${pct(r.dead10min, r.wounded)} | ${pct(r.dead60min, r.wounded)} | ${r.medianMinutesToCollapse === null ? "–" : r.medianMinutesToCollapse.toFixed(0)} |`);
  }
  const zones = ["head", "neck", "chest", "abdomen", "pelvis", "arm", "leg"];
  out.push("", "### Where the first round strikes", "", `| case | ${zones.join(" | ")} |`, `|---|${zones.map(() => "---:").join("|")}|`);
  for (const r of rows) out.push(`| ${r.name} | ${zones.map((z) => pct(r.zones[z] ?? 0, r.struck)).join(" | ")} |`);
  out.push("", "### What the armour does", "", "| case | chest/abdomen: stopped by plate | went through armour | struck beside the plate | head: stopped by helmet | head: not stopped |", "|---|---:|---:|---:|---:|---:|");
  for (const r of rows) {
    const torso = r.torsoStopped + r.torsoThrough + r.torsoUncovered, head = r.headStopped + r.headThrough;
    out.push(`| ${r.name} | ${pct(r.torsoStopped, torso)} | ${pct(r.torsoThrough, torso)} | ${pct(r.torsoUncovered, torso)} | ${pct(r.headStopped, head)} | ${pct(r.headThrough, head)} |`);
  }
  return out.join("\n");
}
