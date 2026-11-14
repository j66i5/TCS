/** Sim labs: `npm run lab -- movement|cover|range|casualty|fragmentation|sight|spotting|suppression|attack|drive|mount|gunnery|armour|antitank|missile|house [defend|leave] [trials]` prints the lab tables and writes them to reports/. */
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { casualtyLab, casualtyLabMarkdown } from "../labs/casualty";
import { fragmentationLab, fragmentationLabMarkdown } from "../labs/fragmentation";
import { sightLab, sightLabMarkdown } from "../labs/sight";
import { spottingLab, spottingLabMarkdown } from "../labs/spotting";
import { suppressionLab, suppressionLabMarkdown } from "../labs/suppression";
import { attackLab, attackLabMarkdown } from "../labs/attack";
import { coverLab, coverLabMarkdown } from "../labs/cover";
import { movementLab, movementLabMarkdown } from "../labs/movement";
import { driveLab, driveLabMarkdown } from "../labs/drive";
import { mountLab, mountLabMarkdown } from "../labs/mount";
import { gunneryLab, gunneryLabMarkdown } from "../labs/gunnery";
import { rangeLab, rangeLabMarkdown } from "../labs/range";
import { armourLab, armourLabMarkdown } from "../labs/armour";
import { antitankLab, antitankLabMarkdown } from "../labs/antitank";
import { missileLab, missileLabMarkdown } from "../labs/missile";
import { houseDefendLab, houseDefendMarkdown, houseLeaveLab, houseLeaveMarkdown } from "../labs/house";
import { loadData } from "../scenarios";

const LABS: Record<string, () => string> = {
  movement: () => `# Movement and fatigue lab\n\n${movementLabMarkdown(movementLab(loadData()))}\n`,
  range: () => `# Firing range lab\n\n${rangeLabMarkdown(rangeLab(loadData()))}\n`,
  casualty: () => `# Casualty lab\n\n${casualtyLabMarkdown(casualtyLab(loadData()))}\n`,
  fragmentation: () => `# Fragmentation lab\n\n${fragmentationLabMarkdown(fragmentationLab(loadData()))}\n`,
  sight: () => `# Line-of-sight lab\n\n${sightLabMarkdown(sightLab(loadData()))}\n`,
  spotting: () => `# Spotting lab\n\n${spottingLabMarkdown(spottingLab(loadData()))}\n`,
  suppression: () => `# Suppression lab\n\n${suppressionLabMarkdown(suppressionLab(loadData()))}\n`,
  attack: () => `# Attack lab\n\n${attackLabMarkdown(attackLab(loadData(), Number(process.argv[3] ?? 20)))}\n`,
  cover: () => `# Cover and flight lab\n\n${coverLabMarkdown(coverLab(loadData()))}\n`,
  drive: () => `# Drive lab\n\n${driveLabMarkdown(driveLab(loadData(true)))}\n`,
  mount: () => `# Mount lab\n\n${mountLabMarkdown(mountLab(loadData(true)))}\n`,
  gunnery: () => `# Gunnery lab\n\n${gunneryLabMarkdown(gunneryLab(loadData()))}\n`,
  armour: () => `# Armour lab\n\n${armourLabMarkdown(armourLab(loadData()))}\n`,
  antitank: () => `# Anti-tank lab\n\n${antitankLabMarkdown(antitankLab(loadData(), Number(process.argv[3] ?? 20)))}\n`,
  house: () => {
    const mode = process.argv[3] ?? "defend";
    if (mode === "leave") return `# House lab\n\n${houseLeaveMarkdown(houseLeaveLab(loadData(), Number(process.argv[4] ?? 20)))}\n`;
    if (mode !== "defend") throw new Error(`unknown house lab mode '${mode}' (known: defend, leave)`);
    return `# House lab\n\n${houseDefendMarkdown(houseDefendLab(loadData(), Number(process.argv[4] ?? 10)))}\n`;
  },
  missile: () => `# Missile lab\n\n${missileLabMarkdown(missileLab(loadData(), Number(process.argv[3] ?? 20)))}\n`,
};
const name = process.argv[2] ?? "movement";
const lab = LABS[name];
if (!lab) { console.error(`unknown lab '${name}' (known: ${Object.keys(LABS).join(", ")})`); process.exit(1); }
const md = lab();
console.log(md);
const dir = fileURLToPath(new URL("../../../../reports", import.meta.url));
mkdirSync(dir, { recursive: true });
writeFileSync(`${dir}/lab-${name}.md`, md);
