/** Sim labs: `npm run lab -- movement|cover|range|casualty|fragmentation|sight|spotting [seeds]|engage [seeds]|reacquire [seeds] [--seeds 1,2,3] [--scenarios a,b] [--seconds s]|suppression|morale [trials]|attack|ambush [trials]|drive|mount|gunnery|armour|antitank|missile|missile-team [trials]|mounted-assault [seeds] [--seconds s] [--scenarios a,b] [--modes player,ai]|areafire [seeds] [--parts fuse,area] [--ranges a,b] [--seconds s] [--area-range m] [--area-seconds s]|agl [trials]|treatment|carry|medevac [seeds]|protection [seeds]|smoke [seeds]|night|thermal|drone [seeds]|indirect [seeds]|artillery [seeds]|house [defend|leave|clear|rocket] [trials]|repair [seeds]|batteries [seed] [speedup]|consumption [seeds] [--seconds 1200,2400] [--scenarios a,b] [--conservation] [--no-resupply] [--no-refill] [--no-consolidate]|redistribute [trials]|cache [trials]|resupply [distances, e.g. 200,400]|rearm|prisoners [runs] [--part 1,2,3,4]|contact [seeds] [--kinds ambush,meeting] [--maps a,b] [--seconds s]` prints the lab tables and writes them to reports/. */
import { buildCatalog } from "@tcs/data";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { casualtyLab, casualtyLabMarkdown } from "../labs/casualty";
import { fragmentationLab, fragmentationLabMarkdown } from "../labs/fragmentation";
import { sightLab, sightLabMarkdown } from "../labs/sight";
import { sightRealismLab, sightRealismMarkdown, spottingLab, spottingLabMarkdown } from "../labs/spotting";
import { engageLab, engageLabMarkdown } from "../labs/engage";
import { reacquireLab, reacquireLabMarkdown, reacquireOptions } from "../labs/reacquire";
import { suppressionLab, suppressionLabMarkdown } from "../labs/suppression";
import { moraleLab, moraleLabMarkdown } from "../labs/morale";
import { ambushLab, ambushLabMarkdown, attackLab, attackLabMarkdown } from "../labs/attack";
import { coverLab, coverLabMarkdown } from "../labs/cover";
import { movementLab, movementLabMarkdown } from "../labs/movement";
import { driveLab, driveLabMarkdown } from "../labs/drive";
import { handSmokeLab, handSmokeLabMarkdown, smokeLab, smokeLabMarkdown } from "../labs/smoke";
import { nightLab, nightLabMarkdown } from "../labs/night";
import { thermalLab, thermalLabMarkdown } from "../labs/thermal";
import { droneLab, droneLabMarkdown } from "../labs/drone";
import { mountLab, mountLabMarkdown } from "../labs/mount";
import { gunneryLab, gunneryLabMarkdown } from "../labs/gunnery";
import { rangeLab, rangeLabMarkdown } from "../labs/range";
import { armourLab, armourLabMarkdown } from "../labs/armour";
import { antitankLab, antitankLabMarkdown } from "../labs/antitank";
import { missileLab, missileLabMarkdown } from "../labs/missile";
import { missileTeamLab, missileTeamLabMarkdown } from "../labs/missile-team";
import { mountedAssaultLab, mountedAssaultLabMarkdown } from "../labs/mounted-assault";
import { areaFireLab, areaFireLabMarkdown } from "../labs/areafire";
import { aglLab, aglLabMarkdown } from "../labs/agl";
import { houseClearLab, houseClearMarkdown, houseDefendLab, houseDefendMarkdown, houseLeaveLab, houseLeaveMarkdown, houseRocketLab, houseRocketMarkdown } from "../labs/house";
import { indirectLab, indirectLabMarkdown } from "../labs/indirect";
import { artilleryLab, artilleryLabMarkdown } from "../labs/artillery";
import { oddsLab, selfAidLab, treatmentLabMarkdown } from "../labs/treatment";
import { carryLab, carryLabMarkdown } from "../labs/carry";
import { medevacLab, medevacLabMarkdown } from "../labs/medevac";
import { breachLab, breachLabMarkdown, chanceTable, protectionLab, protectionLabMarkdown } from "../labs/protection";
import { repairLab, repairLabMarkdown, towLab, towLabMarkdown } from "../labs/repair";
import { batteriesLab, batteriesLabMarkdown } from "../labs/batteries";
import { consumptionLab, consumptionOptions } from "../labs/consumption";
import { redistributeLab, redistributeLabMarkdown } from "../labs/redistribute";
import { cacheBurnLab, cacheChanceLab, cacheLabMarkdown } from "../labs/cache";
import { resupplyLab, resupplyLabMarkdown, vehicleResupplyLab, vehicleResupplyLabMarkdown } from "../labs/resupply";
import { rearmLab, rearmLabMarkdown } from "../labs/rearm";
import { escapeLab, escapeLabMarkdown, fireLab, fireLabMarkdown, mpLab, mpLabMarkdown, prisonersLab, prisonersLabMarkdown } from "../labs/prisoners";
import { loadData, SCENARIOS } from "../scenarios";
import { KIND_CHECKS, KIND_MAPS, kindFails, kindsLab, kindsMarkdown, type KindChecks } from "../labs/kinds";
import { contactLab, contactLine, contactMarkdown } from "../labs/contact";
import { SCENARIO_KINDS, type MapKind } from "@tcs/scenario";

/** `--name v` from the lab's arguments. */
function argOf(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const LABS: Record<string, () => string> = {
  // M12.0b: `lab -- kinds [seeds] [--kinds a,b] [--maps a,b] [--seconds s] [--vehicles] [--roster] [--company]`: every
  // scenario kind AI against AI on every map kind; stalemates flagged. Review 2026-11-24 problem 2: direct fire only;
  // `--quiet-min m` (default 5), `--min-incoming n`, `--min-return n` set the fail flags (a side that never fired back,
  // a quiet stretch with both sides on the map); `--strict` exits non-zero when any battle has one.
  kinds: () => {
    const n = Number(process.argv[3] !== undefined && !process.argv[3].startsWith("--") ? process.argv[3] : 10);
    const kinds = (argOf("kinds") ?? SCENARIO_KINDS.join(",")).split(",");
    const maps = (argOf("maps") ?? KIND_MAPS.join(",")).split(",") as MapKind[];
    const checks: KindChecks = {
      quietS: Number(argOf("quiet-min") ?? KIND_CHECKS.quietS / 60) * 60,
      minIncoming: Number(argOf("min-incoming") ?? KIND_CHECKS.minIncoming), minReturn: Number(argOf("min-return") ?? KIND_CHECKS.minReturn),
    };
    const rows = kindsLab(loadData(), {
      kinds, maps, seeds: Array.from({ length: n }, (_, i) => i + 1), seconds: Number(argOf("seconds") ?? 1200), checks,
      vehicles: process.argv.includes("--vehicles"), roster: process.argv.includes("--roster"), ...(process.argv.includes("--company") ? { size: "company" as const } : {}),
      onRow: (r) => { const f = kindFails(r); console.error(`${r.kind} ${r.map} ${r.seed}${r.roster ? " roster" : ""}: ${r.endReason} ${r.endS}s winner ${r.winner ?? "draw"} able ${r.ableEnd.join("/")} of ${r.men.join("/")} saved ${r.saved.join("/")} direct ${r.direct.join("/")} (men ${r.menDirect.join("/")}) hit ${r.hit.join("/")} closest ${r.closestM} quiet ${r.quietS}${r.stalemate ? " STALEMATE" : ""}${f.length > 0 ? ` FAIL: ${f.join(", ")}` : ""}${r.savedBad ? ` SAVED-NOT-FIT ${r.savedBad}` : ""} (${r.speed}x)`); },
    });
    if (process.argv.includes("--strict") && rows.some((r) => kindFails(r).length > 0)) process.exitCode = 1;
    return `# Scenario kinds lab (M12.0b)\n\n${kindsMarkdown(rows, checks)}\n`;
  },
  // Review 2026-11-24 problem 2: `lab -- contact [seeds] [--kinds ambush,meeting] [--maps village,farmland] [--seconds s]`:
  // battles on foot, per side the time from the first enemy direct round to its first one back, rounds, men hit.
  contact: () => {
    const n = Number(process.argv[3] !== undefined && !process.argv[3].startsWith("--") ? process.argv[3] : 3);
    const kinds = (argOf("kinds") ?? "ambush,meeting").split(",");
    const maps = (argOf("maps") ?? "village,farmland").split(",") as MapKind[];
    const rows = contactLab(loadData(), { kinds, maps, seeds: Array.from({ length: n }, (_, i) => i + 1), seconds: Number(argOf("seconds") ?? 600), onRow: (r) => console.error(contactLine(r)) });
    return `# Contact lab (contact drill)\n\n${contactMarkdown(rows)}\n`;
  },
  consumption: () => {
    const o = consumptionOptions(process.argv.slice(3));
    const names = Object.keys(SCENARIOS).filter((n) => !n.startsWith("hold"));
    return `# Consumption lab\n\n${consumptionLab(loadData(), loadData(true), o, names)}\n`;
  },
  cache: () => { const n = Number(process.argv[3] ?? 40), d = loadData(); return `# Cache lab (M11.3)\n\n${cacheLabMarkdown(cacheChanceLab(d, n), cacheBurnLab(d), n)}\n`; },
  redistribute: () => `# Redistribution lab (M11.2)\n\n${redistributeLabMarkdown(redistributeLab(loadData(), Number(process.argv[3] ?? 4)))}\n`,
  rearm: () => `# Re-arming and refuelling lab (M11.5)\n\n${rearmLabMarkdown(rearmLab(loadData()))}\n`,
  // M11.9a: `lab -- prisoners [runs]` (part 1: search, segregation, escorts, guards, the point, wounded to the nest).
  // M11.9b: part 2 (the military police: delay, drive, take-over, boarding order, places, evacuation, a second run);
  // `--part 1|2` for one part, `--mp-runs n` battles per faction for part 2 (default 10).
  // M11.9c: part 3 (rounds landing near the point and 300 m away; `--fire-runs n` per faction and kind, default 10) and
  // part 4 (escapes: day, night, searched, smoke, guarded; `--escape-seeds n` runs of 100 prisoners x 30 min each,
  // default 2). `--part` takes a list (e.g. `--part 3,4`).
  prisoners: () => {
    const d = loadData(), cat = buildCatalog(d, ["de", "ru"]);
    const parts = (argValue("--part") ?? "1,2,3,4").split(","), mpRuns = Number(argValue("--mp-runs") ?? 10);
    const fireRuns = Number(argValue("--fire-runs") ?? 10), escSeeds = Number(argValue("--escape-seeds") ?? 2);
    const n1 = process.argv[3] !== undefined && /^\d+$/.test(process.argv[3]) ? Number(process.argv[3]) : 20;
    const p1 = !parts.includes("1") ? "" : `## Part 1: taken to held (M11.9a)\n\n${prisonersLabMarkdown(prisonersLab(d, n1), cat)}\n\n`;
    const p2 = !parts.includes("2") ? "" : `## Part 2: the military police (M11.9b)\n\n${mpLabMarkdown(mpLab(d, mpRuns), cat)}\n\n`;
    const p3 = !parts.includes("3") ? "" : `## Part 3: under fire (M11.9c)\n\n${fireLabMarkdown(fireLab(d, fireRuns), cat)}\n\n`;
    const p4 = !parts.includes("4") ? "" : `## Part 4: escapes (M11.9c)\n\n${escapeLabMarkdown(escapeLab(d, escSeeds), cat)}\n`;
    return `# Prisoners lab (M11.9)\n\n${p1}${p2}${p3}${p4}`;
  },
  resupply: () => { const d = (process.argv[3] ?? "400").split(",").map(Number); return `# Resupply lab (M11.4a-b)\n\n## On foot (M11.4a)\n\n${resupplyLabMarkdown(resupplyLab(loadData(), d))}\n\n## By vehicle and from off the map (M11.4b)\n\n${vehicleResupplyLabMarkdown(vehicleResupplyLab(loadData(), d))}\n`; },
  movement: () => `# Movement and fatigue lab\n\n${movementLabMarkdown(movementLab(loadData()))}\n`,
  carry: () => `# Carry lab\n\n${carryLabMarkdown(carryLab(loadData()))}\n`,
  medevac: () => { const n = Number(process.argv[3] ?? 10); return `# Medevac lab\n\n${medevacLabMarkdown(medevacLab(loadData(), n), n)}\n`; },
  protection: () => { const d = loadData(), n = Number(process.argv[3] ?? 3); return `# Protection lab\n\n${protectionLabMarkdown(protectionLab(d, n))}\n\n${breachLabMarkdown(breachLab(d, n), chanceTable(buildCatalog(d, ["de", "ru"])))}\n`; },
  range: () => `# Firing range lab\n\n${rangeLabMarkdown(rangeLab(loadData()))}\n`,
  casualty: () => `# Casualty lab\n\n${casualtyLabMarkdown(casualtyLab(loadData()))}\n`,
  fragmentation: () => `# Fragmentation lab\n\n${fragmentationLabMarkdown(fragmentationLab(loadData()))}\n`,
  sight: () => `# Line-of-sight lab\n\n${sightLabMarkdown(sightLab(loadData()))}\n`,
  spotting: () => { const d = loadData(); return `# Spotting lab\n\n${spottingLabMarkdown(spottingLab(d))}\n\n${sightRealismMarkdown(sightRealismLab(d, Number(process.argv[3] ?? 20)))}\n`; },
  engage: () => `# Engage lab\n\n${engageLabMarkdown(engageLab(loadData(), Number(process.argv[3] ?? 12)))}\n`,
  reacquire: () => `# Re-acquire lab\n\n${reacquireLabMarkdown(reacquireLab(reacquireOptions(process.argv.slice(3))))}\n`,
  suppression: () => `# Suppression lab\n\n${suppressionLabMarkdown(suppressionLab(loadData()))}\n`,
  morale: () => `# Morale lab\n\n${moraleLabMarkdown(moraleLab(loadData(), Number(process.argv[3] ?? 12)))}\n`,
  attack: () => `# Attack lab\n\n${attackLabMarkdown(attackLab(loadData(), Number(process.argv[3] ?? 20)))}\n`,
  ambush: () => `# Ambush lab\n\n${ambushLabMarkdown(ambushLab(loadData(), Number(process.argv[3] ?? 10)))}\n`,
  cover: () => `# Cover and flight lab\n\n${coverLabMarkdown(coverLab(loadData()))}\n`,
  drive: () => `# Drive lab\n\n${driveLabMarkdown(driveLab(loadData(true)))}\n`,
  drone: () => `# Drone lab\n\n${droneLabMarkdown(droneLab(loadData(), Number(process.argv[3] ?? 20)))}\n`,
  thermal: () => `# Thermal lab\n\n${thermalLabMarkdown(thermalLab(loadData()))}\n`,
  night: () => `# Night lab\n\n${nightLabMarkdown(nightLab(loadData()))}\n`,
  mount: () => `# Mount lab\n\n${mountLabMarkdown(mountLab(loadData(true)))}\n`,
  gunnery: () => `# Gunnery lab\n\n${gunneryLabMarkdown(gunneryLab(loadData()))}\n`,
  armour: () => `# Armour lab\n\n${armourLabMarkdown(armourLab(loadData()))}\n`,
  antitank: () => `# Anti-tank lab\n\n${antitankLabMarkdown(antitankLab(loadData(), Number(process.argv[3] ?? 20)))}\n`,
  house: () => {
    const mode = process.argv[3] ?? "defend";
    if (mode === "leave") return `# House lab\n\n${houseLeaveMarkdown(houseLeaveLab(loadData(), Number(process.argv[4] ?? 20)))}\n`;
    if (mode === "clear") return `# House lab\n\n${houseClearMarkdown(houseClearLab(loadData(), Number(process.argv[4] ?? 12)))}\n`;
    if (mode === "rocket") return `# House lab\n\n${houseRocketMarkdown(houseRocketLab(loadData(), Number(process.argv[4] ?? 10)))}\n`;
    if (mode !== "defend") throw new Error(`unknown house lab mode '${mode}' (known: defend, leave, clear, rocket)`);
    return `# House lab\n\n${houseDefendMarkdown(houseDefendLab(loadData(), Number(process.argv[4] ?? 10)))}\n`;
  },
  artillery: () => `# Artillery lab\n\n${artilleryLabMarkdown(artilleryLab(loadData(), Number(process.argv[3] ?? 6)))}\n`,
  indirect: () => `# Indirect fire lab\n\n${indirectLabMarkdown(indirectLab(loadData(), Number(process.argv[3] ?? 12)))}\n`,
  smoke: () => `# Smoke lab\n\n## Hand smoke grenades\n\n${handSmokeLabMarkdown(handSmokeLab(loadData()))}\n\n${smokeLabMarkdown(smokeLab(loadData(), Number(process.argv[3] ?? 6)))}\n`,
  treatment: () => `# Treatment lab\n\n${treatmentLabMarkdown(oddsLab(loadData()), selfAidLab(loadData()))}\n`,
  agl: () => `# Automatic grenade launcher lab\n\n${aglLabMarkdown(aglLab(loadData(), Number(process.argv[3] ?? 20)))}\n`,
  // Balance pass 5: `lab -- mounted-assault [seeds] [--seconds s] [--scenarios a,b] [--modes player,ai]`.
  "mounted-assault": () => {
    const n = Number(process.argv[3] !== undefined && !process.argv[3].startsWith("--") ? process.argv[3] : 3);
    const sc = (argOf("scenarios") ?? "platoon-vehicles,platoon-ru-vehicles").split(",");
    const modes = (argOf("modes") ?? "player,ai").split(",") as ("player" | "ai")[];
    return `# Mounted-assault lab\n\n${mountedAssaultLabMarkdown(mountedAssaultLab(loadData(), n, Number(argOf("seconds") ?? 600), sc, modes))}\n`;
  },
  // Balance pass 5: `lab -- areafire [seeds] [--parts fuse,area] [--ranges 400,800,1200] [--seconds s] [--area-range m] [--area-seconds s]`.
  areafire: () => {
    const n = Number(process.argv[3] !== undefined && !process.argv[3].startsWith("--") ? process.argv[3] : 3);
    const parts = (argOf("parts") ?? "fuse,area").split(",") as ("fuse" | "area")[];
    const ranges = argOf("ranges")?.split(",").map(Number);
    return `# Area fire lab\n\n${areaFireLabMarkdown(areaFireLab(loadData(), { seeds: n, parts, ...(ranges ? { ranges } : {}), seconds: Number(argOf("seconds") ?? 30), areaRange: Number(argOf("area-range") ?? 600), areaSeconds: Number(argOf("area-seconds") ?? 240) }))}\n`;
  },
  "missile-team": () => `# Missile team lab\n\n${missileTeamLabMarkdown(missileTeamLab(loadData(), Number(process.argv[3] ?? 50)))}\n`,
  repair: () => `# Repair lab\n\n## Part A: field repair (M11.7a)\n\n${repairLabMarkdown(repairLab(loadData(true), Number(process.argv[3] ?? 10)))}\n\n## Part B: recovery and towing (M11.7b)\n\n${towLabMarkdown(towLab(loadData(true)))}\n`,
  // M11.6: `lab -- batteries [seed] [speedup]` (the full 3 h night without a speedup).
  batteries: () => `# Batteries and water lab\n\n${batteriesLabMarkdown(batteriesLab(loadData(), { seed: Number(process.argv[3] ?? 1), speedup: Number(process.argv[4] ?? 1) }))}\n`,
  missile: () => `# Missile lab\n\n${missileLabMarkdown(missileLab(loadData(true), Number(process.argv[3] ?? 20)))}\n`,
};
const name = process.argv[2] ?? "movement";
const lab = LABS[name];
if (!lab) { console.error(`unknown lab '${name}' (known: ${Object.keys(LABS).join(", ")})`); process.exit(1); }
const md = lab();
console.log(md);
const dir = fileURLToPath(new URL("../../../../reports", import.meta.url));
mkdirSync(dir, { recursive: true });
// (M11.1: the consumption lab keeps every run: reports/consumption-<stamp>.md.)
writeFileSync(name === "consumption" ? `${dir}/consumption-${new Date().toISOString().replace(/[:.]/g, "-")}.md` : `${dir}/lab-${name}.md`, md);

/** The value after `flag` on the command line (M11.9b), if any. */
function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
