/**
 * Shared cache of generated maps for the test runs (M10.0, test speed). Installed by `test/setup-map-cache.ts`
 * through `@tcs/scenario`'s `setMapCache`.
 *
 * - In memory per test file and on disk (`node_modules/.cache/tcs-maps/`) across files, workers and runs.
 * - The key holds a hash of the generator's inputs: the terrain catalog, the options, and the source text of
 *   `packages/scenario/src` and `packages/sim/src` (any code change there makes new keys, so a stale map is never
 *   handed out). Old files are simply never read again; delete the folder to reclaim the space.
 * - Every `get` returns a fresh copy (`v8.deserialize`), exact for numbers, typed arrays and key order, so a test
 *   that changes its map changes only its own.
 * - `TCS_MAP_CACHE=0` turns it off.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { deserialize, serialize } from "node:v8";
import { threadId } from "node:worker_threads";
import type { MapDef, TerrainCatalog } from "@tcs/sim";
import type { MapCache } from "@tcs/scenario";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const DIR = join(ROOT, "node_modules", ".cache", "tcs-maps");

let sourceHash: string | null = null;
let writes = 0;
function codeHash(): string {
  if (sourceHash !== null) return sourceHash;
  const h = createHash("sha256");
  const walk = (d: string) => {
    for (const n of readdirSync(d).sort()) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (n.endsWith(".ts")) { h.update(p.slice(ROOT.length)); h.update(readFileSync(p)); }
    }
  };
  walk(join(ROOT, "packages", "scenario", "src"));
  walk(join(ROOT, "packages", "sim", "src"));
  sourceHash = h.digest("hex");
  return sourceHash;
}

const terrainHashes = new WeakMap<TerrainCatalog, string>();
function terrainHash(t: TerrainCatalog): string {
  let s = terrainHashes.get(t);
  if (s === undefined) {
    s = createHash("sha256").update(JSON.stringify(t)).digest("hex");
    terrainHashes.set(t, s);
  }
  return s;
}

export function diskMapCache(): MapCache {
  const mem = new Map<string, Buffer>();
  const id = (terrain: TerrainCatalog, key: string) => createHash("sha256").update(codeHash()).update(terrainHash(terrain)).update(key).digest("hex").slice(0, 40);
  return {
    get(terrain, key) {
      const k = id(terrain, key);
      let buf = mem.get(k);
      if (buf === undefined) {
        try { buf = readFileSync(join(DIR, `${k}.bin`)); } catch { return undefined; }
        mem.set(k, buf);
      }
      try { return deserialize(buf) as MapDef; } catch { mem.delete(k); return undefined; }
    },
    set(terrain, key, map) {
      const k = id(terrain, key);
      const buf = serialize(map);
      mem.set(k, buf);
      try {
        mkdirSync(DIR, { recursive: true });
        const tmp = join(DIR, `${k}.${process.pid}.${threadId}.${writes++}.tmp`);
        writeFileSync(tmp, buf);
        renameSync(tmp, join(DIR, `${k}.bin`)); // atomic: a parallel worker never reads half a file
      } catch {
        // a read-only or full disk only costs speed
      }
    },
  };
}
