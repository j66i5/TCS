/**
 * Regenerate golden replays. Only do this for an INTENDED change, and record it in docs/DECISIONS.md.
 *   npm run golden:update
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GOLDEN_DIR, GOLDEN_SPECS, recordGolden, type GoldenFile } from "../golden";

mkdirSync(GOLDEN_DIR, { recursive: true });
for (const s of GOLDEN_SPECS) {
  const path = join(GOLDEN_DIR, `${s.name}.json`);
  const g = recordGolden(s.name, s.description, s.scenario, s.seed, s.seconds);
  let change = "new";
  if (existsSync(path)) {
    const old = JSON.parse(readFileSync(path, "utf8")) as GoldenFile;
    const diff = Object.keys(g.checkpoints).filter((t) => old.checkpoints[t] !== g.checkpoints[t]);
    change = diff.length === 0 ? "unchanged" : `CHANGED at ${diff.length} checkpoint(s), first at tick ${diff[0]}`;
  }
  writeFileSync(path, JSON.stringify(g, null, 1) + "\n");
  console.log(`${s.name}: ${change} (${Object.keys(g.checkpoints).length} checkpoints, ${g.orders.length} orders)`);
}
