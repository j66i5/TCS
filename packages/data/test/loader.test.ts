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

  it("rejects inconsistent weapon data: wrong calibre, non-magazine feed, mass mismatch, ball marked tracer, duplicate IDs", () => {
    const files = clone(read(["core", "factions"]));
    const weapons = files["factions/de/weapons.json"] as { weapons: { calibre: string; feed: { magazine: string } }[] };
    const ammo = files["factions/de/ammunition.json"] as { ammunition: { id: string; tracer: boolean; cartridgeMassKg: number }[] };
    const items = files["factions/de/items.json"] as { items: Record<string, unknown>[] };
    weapons.weapons[0]!.calibre = "7.62x51";
    ammo.ammunition[0]!.tracer = true; // a "ball" round flagged as tracer
    ammo.ammunition[0]!.cartridgeMassKg = 0.02; // the magazine still says 12.3 g per round
    items.items.push({ id: ammo.ammunition[1]!.id, nameKey: "x", category: "ammunition", massKg: 0.01, sources: [], confidence: "low", note: "dup" });
    const out = formatErrors(loadDataSet(files).errors);
    expect(out).toContain("calibre 5.56x45 does not fit this 7.62x51 weapon");
    expect(out).toContain("contradict each other");
    expect(out).toContain("a magazine and its loose rounds must weigh the same");
    expect(out).toContain("ammunition becomes an item automatically");
    const files2 = clone(read(["core", "factions"]));
    (files2["factions/de/weapons.json"] as typeof weapons).weapons[0]!.feed.magazine = "de-basic-load";
    expect(formatErrors(loadDataSet(files2).errors)).toContain("is not a magazine or belt");
  });
});
