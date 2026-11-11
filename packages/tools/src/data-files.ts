/** Node helper: read all data JSON files from packages/data into the map the loader expects. */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

export const DATA_ROOT = fileURLToPath(new URL("../../data", import.meta.url));

/** @param include top-level folders to read, e.g. ["core", "factions"] or with "fixtures". */
export function readDataFiles(include: string[] = ["core", "factions"]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith(".json")) {
        const rel = relative(DATA_ROOT, p).split("\\").join("/");
        try {
          out[rel] = JSON.parse(readFileSync(p, "utf8"));
        } catch (e) {
          throw new Error(`${rel}: invalid JSON: ${(e as Error).message}`, { cause: e });
        }
      }
    }
  };
  for (const top of include) walk(join(DATA_ROOT, top));
  return out;
}
