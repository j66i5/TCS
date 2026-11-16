/** Sim labs: `npm run lab -- movement|cover|range|casualty|fragmentation|sight|spotting [seeds]|engage [seeds]|reacquire [seeds] [--seeds 1,2,3] [--scenarios a,b] [--seconds s]|suppression|morale [trials]|attack|ambush [trials]|drive|mount|gunnery|armour|antitank|missile|missile-team [trials]|agl [trials]|treatment|carry|medevac [seeds]|protection [seeds]|smoke [seeds]|night|thermal|drone [seeds]|indirect [seeds]|artillery [seeds]|house [defend|leave|clear|rocket] [trials]|repair [seeds]` prints the lab tables and writes them to reports/. */
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
import { aglLab, aglLabMarkdown } from "../labs/agl";
import { houseClearLab, houseClearMarkdown, houseDefendLab, houseDefendMarkdown, houseLeaveLab, houseLeaveMarkdown, houseRocketLab, houseRocketMarkdown } from "../labs/house";
import { indirectLab, indirectLabMarkdown } from "../labs/indirect";
import { artilleryLab, artilleryLabMarkdown } from "../labs/artillery";
import { oddsLab, selfAidLab, treatmentLabMarkdown } from "../labs/treatment";
import { carryLab, carryLabMarkdown } from "../labs/carry";
import { medevacLab, medevacLabMarkdown } from "../labs/medevac";
import { breachLab, breachLabMarkdown, chanceTable, protectionLab, protectionLabMarkdown } from "../labs/protection";
import { repairLab, repairLabMarkdown } from "../labs/repair";
import { loadData } from "../scenarios";

const LABS: Record<string, () => string> = {
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
  "missile-team": () => `# Missile team lab\n\n${missileTeamLabMarkdown(missileTeamLab(loadData(), Number(process.argv[3] ?? 50)))}\n`,
  repair: () => `# Repair lab\n\n${repairLabMarkdown(repairLab(loadData(true), Number(process.argv[3] ?? 10)))}\n`,
  missile: () => `# Missile lab\n\n${missileLabMarkdown(missileLab(loadData(true), Number(process.argv[3] ?? 20)))}\n`,
};
const name = process.argv[2] ?? "movement";
const lab = LABS[name];
if (!lab) { console.error(`unknown lab '${name}' (known: ${Object.keys(LABS).join(", ")})`); process.exit(1); }
const md = lab();
console.log(md);
const dir = fileURLToPath(new URL("../../../../reports", import.meta.url));
mkdirSync(dir, { recursive: true });
writeFileSync(`${dir}/lab-${name}.md`, md);
