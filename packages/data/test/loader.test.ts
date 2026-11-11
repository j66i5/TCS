import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { formatErrors, lintDataSet, loadDataSet } from "../src/index";

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
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

describe("data loader", () => {
  it("loads the real factions (de, ru) without errors", () => {
    const { data, errors } = lintDataSet(read(["core", "factions"]));
    expect(formatErrors(errors.filter((e) => e.severity === "error"))).toBe("");
    expect(Object.keys(data!.factions).sort()).toEqual(["de", "ru"]);
  });

  it("every real-faction entry has sources or is flagged low confidence with a note", () => {
    const { errors } = lintDataSet(read(["core", "factions"]));
    expect(errors.filter((e) => e.severity === "error")).toEqual([]);
  });

  it("reports broken references readably with file and path", () => {
    const files = clone(read(["core", "factions"]));
    const units = files["factions/de/units.json"] as { units: { members: { role: string }[] }[] };
    units.units[0]!.members[1]!.role = "riflemann";
    const { data, errors } = loadDataSet(files);
    expect(data).toBeNull();
    expect(formatErrors(errors)).toContain("factions/de/units.json: units[0].members[1].role: unknown role 'riflemann'");
  });

  it("reports schema errors with the path", () => {
    const files = clone(read(["core", "factions"]));
    (files["core/movement-modes.json"] as { movementModes: { speedMps: unknown }[] }).movementModes[0]!.speedMps = -1;
    const { errors } = loadDataSet(files);
    expect(formatErrors(errors)).toMatch(/core\/movement-modes\.json: movementModes\[0\]\.speedMps: /);
  });

  it("rejects a missing file and a manifest id that does not match its folder", () => {
    const files = clone(read(["core", "factions"]));
    delete files["factions/ru/names.json"];
    (files["factions/de/manifest.json"] as { id: string }).id = "dx";
    const out = formatErrors(loadDataSet(files).errors);
    expect(out).toContain("factions/ru/names.json: (file): required file is missing");
    expect(out).toContain("must equal the folder name 'de'");
  });

  it("rejects an unsourced entry that claims medium confidence", () => {
    const files = clone(read(["core", "factions"]));
    const r = files["factions/de/roles.json"] as { roles: { confidence: string }[] };
    r.roles[0]!.confidence = "medium";
    const { errors } = lintDataSet(files);
    expect(formatErrors(errors)).toContain("no sources: either add a source URL");
  });
});
