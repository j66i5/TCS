/** Bundles all data JSON files into the app at build time and loads them through the validating loader. */
import { loadDataSet, type LoadResult } from "@tcs/data";

const modules = import.meta.glob<unknown>(["../../data/core/**/*.json", "../../data/factions/**/*.json"], {
  eager: true,
  import: "default",
});

export function loadBundledData(): LoadResult {
  const files: Record<string, unknown> = {};
  for (const [path, json] of Object.entries(modules)) files[path.replace(/^(\.\.\/)+data\//, "")] = json;
  return loadDataSet(files);
}
