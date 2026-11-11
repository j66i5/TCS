/** Sim labs: `npm run lab -- movement|cover` prints the lab tables and writes them to reports/. */
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { coverLab, coverLabMarkdown } from "../labs/cover";
import { movementLab, movementLabMarkdown } from "../labs/movement";
import { loadData } from "../scenarios";

const LABS: Record<string, () => string> = {
  movement: () => `# Movement and fatigue lab\n\n${movementLabMarkdown(movementLab(loadData()))}\n`,
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
