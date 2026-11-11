/**
 * FIRING RANGE LAB (SPEC 5.4): one soldier, one man-sized target board (0.5 m wide, 1.7 m high), aimed fire.
 * Hit rates come out of geometry: each round flies as a projectile and either strikes the board or not.
 * Varies range, posture, training level, fatigue and weapon. Owner's benchmark (2026-11-11): a regular soldier,
 * prone, rested and calm, hits about 50 % at 300 m; training level scales it.
 */
import { buildCatalog, type DataSet } from "@tcs/data";
import {
  createSim, DEFAULT_COMMS, flatMap, step, submitOrder, type BattleInput, type Catalog, type Posture,
} from "@tcs/sim";

export interface RangeCase {
  weapon: string;
  rangeM: number;
  posture: Posture;
  /** Marksmanship skill 0..1 (conscript 0.35, regular 0.5, veteran 0.65 are the quality means). */
  skill: number;
  fatigue?: number;
  shots?: number;
}

export interface RangeRow extends RangeCase { fired: number; hits: number; hitRate: number; secondsPerShot: number }

const BOARD_W = 0.5, BOARD_H = 1.7;

export function fireAtBoard(catalog: Catalog, c: RangeCase, seed = 1): RangeRow {
  const wd = catalog.weapons[c.weapon];
  if (!wd) throw new Error(`unknown weapon '${c.weapon}'`);
  const faction = Object.keys(catalog.factions)[0]!;
  const map = flatMap("range", c.rangeM + 80, 60, 4);
  const bx = 10 + c.rangeM;
  map.obstacles.push({ id: 1, kind: "wooden-fence", points: [bx, 30 - BOARD_W / 2, bx, 30 + BOARD_W / 2], heightM: BOARD_H, thicknessM: 0.01, material: "wood" });
  const shots = c.shots ?? 200;
  const mags = Math.ceil(shots / 30) + 3;
  const input: BattleInput = {
    map, catalog, seed, orders: [],
    rules: { timeLimitSeconds: 36000, commsModel: "simple", comms: { ...DEFAULT_COMMS, orderDelaySeconds: 0, orderDelayJitterSeconds: 0 }, physiologyModel: "none", physiologyParams: {}, objectives: [] },
    forces: [{
      side: "blue", faction,
      units: [{ key: "lab", callsign: "Lab", echelon: "team", leaderIndex: 0, subunits: [], members: [{
        personId: "lab#0", given: "Lab", family: "Shooter", rank: "r", role: "rifleman", skills: { marksmanship: c.skill }, weapon: c.weapon,
        fatigue: c.fatigue ?? 0, stress: 0, wounds: [], load: [{ type: wd.feed.magazine, count: mags, charge: catalog.items[wd.feed.magazine]?.chargeCapacity ?? 30 }], status: "fit",
      }] }],
      placements: [{ personId: "lab#0", x: 10, y: 30, heading: 0 }],
    }],
  };
  const sim = createSim(input);
  const id = [...sim.state.identity.keys()][0]!;
  if (c.fatigue !== undefined) sim.state.soldier.req(id).physical.heartRateBpm = 70; // tired but with a settled pulse
  submitOrder(sim, { tick: 0, issuer: "blue", target: id, kind: "posture", posture: c.posture });
  let fired = 0, hits = 0, firstShot = -1, lastShot = 0;
  for (let t = 0; t < 60 * 3600 && fired < shots; t++) {
    // Renew the order every 20 s: full rate throughout, and a fresh estimate of the range each time.
    if (t % 1200 === 180) submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: id, kind: "fire", x: bx, y: 30, heightM: BOARD_H / 2 });
    if (c.fatigue !== undefined) sim.state.soldier.req(id).physical.fatigue = c.fatigue; // lab: hold the condition constant
    for (const e of step(sim)) {
      if (e.kind === "shot.fired") { fired++; if (firstShot < 0) firstShot = e.tick; lastShot = e.tick; }
      else if (e.kind === "impact" && e.surface === "obstacle") hits++;
    }
  }
  // Cease fire, then let the rounds still in flight arrive.
  submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: id, kind: "ceaseFire" });
  for (let t = 0; t < 120; t++) {
    for (const e of step(sim)) {
      if (e.kind === "shot.fired") fired++;
      else if (e.kind === "impact" && e.surface === "obstacle") hits++;
    }
  }
  return { ...c, fired, hits, hitRate: hits / Math.max(1, fired), secondsPerShot: fired > 1 ? (lastShot - firstShot) / 60 / (fired - 1) : 0 };
}

export const SKILLS = { conscript: 0.35, regular: 0.5, veteran: 0.65 } as const;

export function rangeLab(data: DataSet): { byRange: RangeRow[]; byPosture: RangeRow[]; bySkill: RangeRow[]; byFatigue: RangeRow[]; others: RangeRow[] } {
  const de = buildCatalog(data, ["de"]), ru = buildCatalog(data, ["ru"]);
  const rifles: [Catalog, string][] = [[de, "de-g36"], [ru, "ru-ak74m"]];
  const byRange: RangeRow[] = [], byPosture: RangeRow[] = [], bySkill: RangeRow[] = [], byFatigue: RangeRow[] = [];
  for (const [cat, weapon] of rifles) {
    for (const rangeM of [25, 50, 100, 200, 300, 400, 500]) byRange.push(fireAtBoard(cat, { weapon, rangeM, posture: "prone", skill: SKILLS.regular }));
    for (const posture of ["prone", "crouching", "standing"] as Posture[]) for (const rangeM of [100, 200, 300]) byPosture.push(fireAtBoard(cat, { weapon, rangeM, posture, skill: SKILLS.regular }));
    for (const skill of Object.values(SKILLS)) for (const rangeM of [200, 300]) bySkill.push(fireAtBoard(cat, { weapon, rangeM, posture: "prone", skill }));
    for (const fatigue of [0, 0.5, 0.9]) byFatigue.push(fireAtBoard(cat, { weapon, rangeM: 200, posture: "prone", skill: SKILLS.regular, fatigue }));
  }
  // Other squad weapons (M2.5): machine guns fire their bursts, the marksman rifle single aimed shots.
  const others: RangeRow[] = [];
  for (const [cat, weapon] of [[de, "de-mg5"], [de, "de-g28"], [ru, "ru-pkp"]] as [Catalog, string][]) {
    if (!cat.weapons[weapon]) continue;
    for (const rangeM of [200, 300, 500, 700]) others.push(fireAtBoard(cat, { weapon, rangeM, posture: "prone", skill: SKILLS.regular }));
  }
  return { byRange, byPosture, bySkill, byFatigue, others };
}

export function rangeLabMarkdown(r: ReturnType<typeof rangeLab>): string {
  const pct = (x: RangeRow) => `${(x.hitRate * 100).toFixed(0)} %`;
  const skillName = (s: number) => Object.entries(SKILLS).find(([, v]) => v === s)?.[0] ?? String(s);
  const out: string[] = ["Target: board 0.5 m wide x 1.7 m high. 200 rounds per cell.", "",
    "### By range (regular soldier, prone, rested)", "", "| weapon | range m | hits | seconds per shot |", "|---|---:|---:|---:|"];
  for (const x of r.byRange) out.push(`| ${x.weapon} | ${x.rangeM} | ${pct(x)} | ${x.secondsPerShot.toFixed(1)} |`);
  out.push("", "### By posture (regular soldier, rested)", "", "| weapon | posture | 100 m | 200 m | 300 m |", "|---|---|---:|---:|---:|");
  for (const w of [...new Set(r.byPosture.map((x) => x.weapon))]) for (const p of ["prone", "crouching", "standing"]) {
    const row = (rg: number) => pct(r.byPosture.find((x) => x.weapon === w && x.posture === p && x.rangeM === rg)!);
    out.push(`| ${w} | ${p} | ${row(100)} | ${row(200)} | ${row(300)} |`);
  }
  out.push("", "### By training level (prone, rested)", "", "| weapon | training | 200 m | 300 m |", "|---|---|---:|---:|");
  for (const w of [...new Set(r.bySkill.map((x) => x.weapon))]) for (const s of Object.values(SKILLS)) {
    const row = (rg: number) => pct(r.bySkill.find((x) => x.weapon === w && x.skill === s && x.rangeM === rg)!);
    out.push(`| ${w} | ${skillName(s)} | ${row(200)} | ${row(300)} |`);
  }
  out.push("", "### Machine guns (5-round bursts) and marksman rifle (regular soldier, prone, rested)", "", "| weapon | range m | hits | seconds per shot |", "|---|---:|---:|---:|");
  for (const x of r.others) out.push(`| ${x.weapon} | ${x.rangeM} | ${pct(x)} | ${x.secondsPerShot.toFixed(1)} |`);
  out.push("", "### By fatigue (regular soldier, prone, 200 m)", "", "| weapon | fatigue | hits |", "|---|---:|---:|");
  for (const x of r.byFatigue) out.push(`| ${x.weapon} | ${x.fatigue} | ${pct(x)} |`);
  return out.join("\n");
}
