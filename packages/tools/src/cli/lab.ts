/** Sim labs: `npm run lab -- movement|cover|range|casualty|fragmentation|sight|spotting|suppression` prints the lab tables and writes them to reports/. */
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { casualtyLab, casualtyLabMarkdown } from "../labs/casualty";
import { fragmentationLab, fragmentationLabMarkdown } from "../labs/fragmentation";
import { sightLab, sightLabMarkdown } from "../labs/sight";
import { spottingLab, spottingLabMarkdown } from "../labs/spotting";
import { suppressionLab, suppressionLabMarkdown } from "../labs/suppression";
import { coverLab, coverLabMarkdown } from "../labs/cover";
import { movementLab, movementLabMarkdown } from "../labs/movement";
import { rangeLab, rangeLabMarkdown } from "../labs/range";
import { loadData } from "../scenarios";

const LABS: Record<string, () => string> = {
  movement: () => `# Movement and fatigue lab\n\n${movementLabMarkdown(movementLab(loadData()))}\n`,
  range: () => `# Firing range lab\n\n${rangeLabMarkdown(rangeLab(loadData()))}\n`,
  casualty: () => `# Casualty lab\n\n${casualtyLabMarkdown(casualtyLab(loadData()))}\n`,
  fragmentation: () => `# Fragmentation lab\n\n${fragmentationLabMarkdown(fragmentationLab(loadData()))}\n`,
  sight: () => `# Line-of-sight lab\n\n${sightLabMarkdown(sightLab(loadData()))}\n`,
  spotting: () => `# Spotting lab\n\n${spottingLabMarkdown(spottingLab(loadData()))}\n`,
  suppression: () => `# Suppression lab\n\n${suppressionLabMarkdown(suppressionLab(loadData()))}\n`,
  cover: () => `# Cover and flight lab\n\n${coverLabMarkdown(coverLab(loadData()))}\n`,
};
const name = process.argv[2] ?? "movement";
const lab = LABS[name];
if (!lab) { console.error(`unknown lab '${name}' (known: ${Object.keys(LABS).join(", ")})`); process.exit(1); }
const md = lab();
console.log(md);
const dir = fileURLToPath(new URL("../../../../reports", import.meta.url));
mkdirSync(dir, { recursive: true });
writeFileSync(`${dir}/lab-${name}.md`, md);
