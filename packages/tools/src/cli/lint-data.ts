/** `npm run lint:data` - validate all data files (factions + fixtures) and report problems. */
import { formatErrors, lintDataSet } from "@tcs/data";
import { readDataFiles } from "../data-files";

const files = readDataFiles(["core", "factions", "fixtures"]);
const { data, errors } = lintDataSet(files);
const errs = errors.filter((e) => e.severity === "error");
const warns = errors.filter((e) => e.severity === "warning");
console.log(`Data lint: ${Object.keys(files).length} files, ${Object.keys(data?.factions ?? {}).length} faction packs.`);
if (warns.length) console.log(`\n${warns.length} warning(s) (confidence 'low' entries awaiting review are listed here):\n${formatErrors(warns)}`);
if (errs.length) {
  console.error(`\n${errs.length} error(s):\n${formatErrors(errs)}`);
  process.exit(1);
}
console.log("\nNo errors.");
