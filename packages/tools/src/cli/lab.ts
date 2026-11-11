/** Sim labs: `npm run lab -- movement` prints the lab tables (and writes them to reports/). */
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { movementLab, movementLabMarkdown } from "../labs/movement";
import { loadData } from "../scenarios";

const name = process.argv[2] ?? "movement";
if (name !== "movement") { console.error(`unknown lab '${name}' (known: movement)`); process.exit(1); }
const md = `# Movement and fatigue lab\n\n${movementLabMarkdown(movementLab(loadData()))}\n`;
console.log(md);
const dir = fileURLToPath(new URL("../../../../reports", import.meta.url));
mkdirSync(dir, { recursive: true });
writeFileSync(`${dir}/lab-movement.md`, md);
