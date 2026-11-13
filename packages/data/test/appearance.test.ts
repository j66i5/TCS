/** M7.5a: appearance (uniform tones, vehicle paint, flat palette) lies outside the catalog and its fingerprint. */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { buildAppearance, buildCatalog, loadDataSet, lookOf, NEUTRAL_LOOK } from "../src/index";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
function read(dirs: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (n.endsWith(".json")) out[relative(ROOT, p).split("\\").join("/")] = JSON.parse(readFileSync(p, "utf8"));
    }
  };
  dirs.forEach((d) => walk(join(ROOT, d)));
  return out;
}

describe("appearance (M7.5a)", () => {
  const files = read(["core", "factions", "fixtures"]);
  const data = loadDataSet(files).data!;
  it("every faction pack has its look; the core palette names real terrain", () => {
    for (const f of ["de", "ru", "xf"]) expect(data.factions[f]!.appearance).toBeDefined();
    expect(Object.keys(data.appearance!.surfaces).sort()).toEqual(Object.keys(data.terrain.surfaces).sort());
    expect(Object.keys(data.appearance!.vegetation).sort()).toEqual(Object.keys(data.terrain.vegetation).sort());
    expect(Object.keys(data.appearance!.roofs).sort()).toEqual(Object.keys(data.terrain.buildings).sort());
  });
  it("is not in the catalog: removing or changing every appearance file leaves the fingerprint unchanged", () => {
    const fp = buildCatalog(data, ["de", "ru", "xf"]).fingerprint;
    const without = Object.fromEntries(Object.entries(files).filter(([k]) => !k.endsWith("appearance.json")));
    const d2 = loadDataSet(without).data!;
    expect(buildCatalog(d2, ["de", "ru", "xf"]).fingerprint).toBe(fp);
    const changed = { ...files, "factions/de/appearance.json": { uniform: { base: "#000000", dark: "#000000", light: "#000000", helmet: "#000000", skin: "#000000" }, vehicle: { hull: "#ffffff", dark: "#ffffff" } } };
    expect(buildCatalog(loadDataSet(changed).data!, ["de", "ru", "xf"]).fingerprint).toBe(fp);
    expect(JSON.stringify(buildCatalog(data, ["de", "ru", "xf"]))).not.toContain("uniform");
  });
  it("a faction without a look gets the neutral one (the fixture faction keeps its own)", () => {
    const without = Object.fromEntries(Object.entries(files).filter(([k]) => k !== "fixtures/factions/xf/appearance.json"));
    const app = buildAppearance(loadDataSet(without).data!, ["de", "xf"]);
    expect(app.factions["xf"]).toEqual(NEUTRAL_LOOK);
    expect(app.factions["de"]!.uniform.base).toBe(0x5f6b45);
    expect(buildAppearance(data, ["xf"]).factions["xf"]).not.toEqual(NEUTRAL_LOOK);
    expect(lookOf(app, "nobody")).toEqual(NEUTRAL_LOOK);
    expect(lookOf(null, "de")).toEqual(NEUTRAL_LOOK);
  });
  it("bad colours and unknown terrain ids are reported", () => {
    const bad = { ...files, "factions/ru/appearance.json": { uniform: { base: "green" }, vehicle: { hull: "#000000", dark: "#000000" } }, "core/appearance.json": { ...(files["core/appearance.json"] as object), roofs: { castle: "#000000" } } };
    const r = loadDataSet(bad);
    expect(r.data).toBeNull();
    expect(r.errors.some((e) => e.file === "factions/ru/appearance.json")).toBe(true);
    expect(r.errors.some((e) => e.file === "core/appearance.json" && e.path === "roofs.castle")).toBe(true);
  });
});
