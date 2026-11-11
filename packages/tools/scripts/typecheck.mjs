// Type-checks every package with its own tsconfig (so sim is checked without DOM/Node types),
// plus the test files. Exits non-zero if any check fails.
import { execFileSync } from "node:child_process";
import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const root = new URL("../../..", import.meta.url).pathname;
const tsc = join(root, "node_modules/typescript/bin/tsc");
const projects = readdirSync(join(root, "packages"))
  .map((p) => join("packages", p, "tsconfig.json"))
  .filter((p) => existsSync(join(root, p)));
projects.push("tsconfig.tests.json");
let failed = false;
for (const project of projects) {
  try {
    execFileSync(process.execPath, [tsc, "-p", project], { cwd: root, stdio: "inherit" });
    console.log(`ok   ${project}`);
  } catch {
    console.error(`FAIL ${project}`);
    failed = true;
  }
}
process.exit(failed ? 1 : 0);
