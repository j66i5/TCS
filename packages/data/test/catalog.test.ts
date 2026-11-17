/** The catalog the simulation runs with (M7.1b): no provenance at any depth; SI vehicle numbers; one armour scale. */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { buildCatalog, loadDataSet } from "../src/index";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
function read(dirs: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (n.endsWith(".json")) out[relative(ROOT, p).split("\\\\").join("/")] = JSON.parse(readFileSync(p, "utf8"));
    }
  };
  dirs.forEach((d) => walk(join(ROOT, d)));
  return out;
}
const data = loadDataSet(read(["core", "factions", "fixtures"])).data!;
const catalog = buildCatalog(data, ["de", "ru", "xf"]);

describe("catalog", () => {
  it("has no provenance key at any depth", () => {
    const found: string[] = [];
    const walk = (o: unknown, path: string) => {
      if (Array.isArray(o)) { o.forEach((x, i) => walk(x, `${path}[${i}]`)); return; }
      if (o === null || typeof o !== "object") return;
      for (const [k, v] of Object.entries(o)) {
        if (k === "sources" || k === "confidence" || k === "note" || k === "nameKey") found.push(`${path}.${k}`);
        walk(v, `${path}.${k}`);
      }
    };
    walk(catalog, "catalog");
    // (A faction's display name key is part of the catalog on purpose: the UI names sides by it.)
    expect(found.filter((p) => !/^catalog\.factions\.[a-z]+\.nameKey$/.test(p))).toEqual([]);
  });

  it("converts vehicle numbers to SI (km/h -> m/s, degrees -> rad, kW -> W)", () => {
    const p = catalog.vehicles["de-puma"]!;
    expect(p.drive.topSpeedMps).toBeCloseTo(70 / 3.6, 9);
    expect(p.drive.powerW).toBe(800000);
    expect(p.drive.gearsMps.at(-1)).toBeCloseTo(p.drive.topSpeedMps, 9);
    expect(p.drive.steering.kind === "tracked" && p.drive.steering.pivotRateRadS).toBeCloseTo((40 * Math.PI) / 180, 9);
    expect(p.massKg).toBe(43000);
    expect(catalog.vehicles["ru-bmp2"]!.stations[0]!.elevationRad[1]).toBeCloseTo((74 * Math.PI) / 180, 9);
    expect(Object.keys(catalog.vehicles).sort()).toEqual(["de-bergepanzer3", "de-boxer-gtk", "de-boxer-gtk-gmw", "de-boxer-san", "de-dingo2-feldjaeger", "de-hx2-truck", "de-leopard2a7v", "de-puma", "ru-bmm", "ru-bmp2", "ru-brem1", "ru-btr82a", "ru-kamaz-patrul-vp", "ru-t72b3m", "ru-t90m", "ru-ural4320", "xf-cart", "xf-litter-cart", "xf-tortoise", "xf-tug", "xf-wagon"]);
    expect(Object.keys(buildCatalog(data, ["de"]).vehicles)).toEqual(["de-bergepanzer3", "de-boxer-gtk", "de-boxer-gtk-gmw", "de-boxer-san", "de-dingo2-feldjaeger", "de-hx2-truck", "de-leopard2a7v", "de-puma"]);
  });

  it("one armour scale: rhaToMildSteel equals the armour-steel material's resistance", () => {
    expect(catalog.ballistics.rhaToMildSteel).toBe(catalog.terrain.materials["armour-steel"]!.resistance);
    expect(catalog.terrain.materials["steel"]!.resistance).toBe(1);
  });
  it("recovery vehicles (M11.7b): each faction's manifest template crews one; who tows what by mass", () => {
    for (const f of ["de", "ru", "xf"]) {
      const m = data.factions[f]!.manifest.recovery!;
      const vt = data.factions[f]!.units[m.template]!.vehicle!;
      expect(catalog.vehicles[vt]!.recovery).toBeDefined();
      expect(catalog.vehicles[vt]!.stations).toEqual([]); // (unarmed in the game, D11)
    }
    const tows = (r: string, t: string) => catalog.vehicles[t]!.massKg <= catalog.vehicles[r]!.recovery!.towMaxKg;
    for (const t of ["de-leopard2a7v", "de-puma", "de-boxer-gtk", "ru-t90m", "ru-bmp2"]) expect(tows("de-bergepanzer3", t)).toBe(true);
    for (const t of ["ru-t90m", "ru-t72b3m", "ru-bmp2", "ru-btr82a"]) expect(tows("ru-brem1", t)).toBe(true);
    expect(tows("ru-brem1", "de-leopard2a7v")).toBe(false);
    expect(tows("xf-tug", "xf-tortoise")).toBe(true);
    expect(catalog.vehicles["de-bergepanzer3"]!.recovery!.towMaxMps).toBeCloseTo(8 / 3.6, 9);
    expect(catalog.recovery?.delayMinS).toBeGreaterThan(0);
  });
});
