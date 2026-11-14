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

  describe("vehicles (M7)", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- clone-and-break edits of raw JSON
    type V = Record<string, any>;
    const broken = (edit: (files: Record<string, unknown>) => void, withFixtures = false) => {
      const files = clone(read(withFixtures ? ["core", "factions", "fixtures"] : ["core", "factions"]));
      edit(files);
      return formatErrors(loadDataSet(files).errors);
    };
    const puma = (f: Record<string, unknown>) => (f["factions/de/vehicles.json"] as { vehicles: V[] }).vehicles[0]!;
    const cart = (f: Record<string, unknown>) => (f["fixtures/factions/xf/vehicles.json"] as { vehicles: V[] }).vehicles[0]!;
    const units = (f: Record<string, unknown>, dir: string) => (f[`${dir}/units.json`] as { units: V[] }).units;

    it("loads the Puma, the BMP-2 and the fixture cart", () => {
      const { data, errors } = loadDataSet(read(["core", "factions", "fixtures"]));
      expect(formatErrors(errors.filter((e) => e.severity === "error"))).toBe("");
      expect(Object.keys(data!.factions["de"]!.vehicles)).toEqual(["de-puma", "de-boxer-san"]);
      expect(Object.keys(data!.factions["ru"]!.vehicles)).toEqual(["ru-bmp2", "ru-bmm"]);
      expect(Object.keys(data!.factions["xf"]!.vehicles)).toEqual(["xf-cart", "xf-wagon", "xf-litter-cart"]);
    });
    it("rejects an unknown or non-litre fuel item", () => {
      expect(broken((f) => { puma(f)["fuel"].item = "de-nothing"; })).toContain("vehicles[0].fuel.item: unknown item 'de-nothing'");
      expect(broken((f) => { puma(f)["fuel"].item = "de-g36-mag"; })).toContain("vehicles[0].fuel.item:");
    });
    it("needs exactly one driver seat and unique seat ids", () => {
      expect(broken((f) => { puma(f)["seats"][2].station = "passenger"; })).toContain("exactly one driver seat is needed (found 0)");
      expect(broken((f) => { puma(f)["seats"][1].id = "cmd"; })).toContain("duplicate seat 'cmd'");
    });
    it("checks gears against the top speed and steering against the class", () => {
      expect(broken((f) => { puma(f)["drive"].topSpeedKmh = 75; })).toContain("the top gear must end at topSpeedKmh");
      expect(broken((f) => { puma(f)["class"] = "wheeled"; })).toContain("a wheeled vehicle needs wheeled steering");
    });
    it("checks station weapons: feed items that hold the weapon's rounds, and the loader station", () => {
      expect(broken((f) => { cart(f)["stations"][0].weapons[0].feeds[0].item = "xf-mag"; }, true)).toContain("'xf-mag' must hold rounds (chargeItem) that 'xf-sling' fires");
      expect(broken((f) => { cart(f)["stations"][0].weapons[0].loaderStation = "loader"; }, true)).toContain("loaderStation: no loader seat on this vehicle");
      expect(broken((f) => { delete cart(f)["stations"][0].weapons[0].roundLoadSeconds; }, true)).toContain("a single-round feed needs roundLoadSeconds");
    });
    it("checks crew templates: the vehicle, crew seats, seat names", () => {
      const crew = (f: Record<string, unknown>) => units(f, "factions/de").find((u) => u["id"] === "puma-besatzung")!;
      expect(broken((f) => { crew(f)["vehicle"] = "de-leopard"; })).toContain("unknown vehicle 'de-leopard'");
      expect(broken((f) => { crew(f)["members"][1].seat = "cmd"; })).toContain("seat 'cmd' is taken twice");
      expect(broken((f) => { crew(f)["members"][1].seat = "roof"; })).toContain("'de-puma' has no seat 'roof'");
      expect(broken((f) => { crew(f)["members"].push(clone(crew(f)["members"][0]), clone(crew(f)["members"][0])); crew(f)["members"][3].seat = undefined; crew(f)["members"][4].seat = undefined; })).toContain("5 crew but 'de-puma' has 3 crew seats");
    });
    it("checks carriage: indices into the parent's sub-units, a crew that crews, a warning for too many men", () => {
      const add = (f: Record<string, unknown>, carriage: V[]) => {
        const zug = units(f, "factions/de").find((u) => u["id"] === "pzgren-zug")!;
        zug["subunits"] = [...zug["subunits"], "puma-besatzung"];
        zug["carriage"] = carriage;
      };
      expect(broken((f) => add(f, [{ crew: 9, carries: [0] }]))).toContain("carriage[0].crew: no sub-unit 9");
      expect(broken((f) => add(f, [{ crew: 0, carries: [1] }]))).toContain("is not a vehicle crew");
      expect(broken((f) => add(f, [{ crew: 3, carries: [9] }]))).toContain("carriage[0].carries: no sub-unit 9 to carry");
      expect(broken((f) => add(f, [{ crew: 3, carries: [0, 1] }]))).toContain("12 men to carry but 'de-puma' has 6 passenger seats");
      // The headquarters (the platoon's own two men) counted in the seats; only one vehicle carries it (M7.2).
      expect(broken((f) => add(f, [{ crew: 3, carries: [0], hq: true }]))).toContain("8 men to carry but 'de-puma' has 6 passenger seats");
      expect(broken((f) => add(f, [{ crew: 3, carries: [], hq: true }, { crew: 4, carries: [], hq: true }]))).toContain("only one vehicle carries the headquarters");
    });
    it("checks that a foot pace names vehicle paces of the right class", () => {
      expect(broken((f) => { (f["core/movement-modes.json"] as { movementModes: V[] }).movementModes[0]!["vehiclePace"].tracked = "wdrive"; })).toContain("movementModes[0].vehiclePace.tracked: 'wdrive' is not a tracked pace");
    });
  });
});
