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
    expect(app.factions["de"]!.uniform.base).toBe(0x4d6b36);
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
    // Review fix: the photo palette's roofs and floors are checked too (a typo fell back to the flat colour quietly).
    const core = files["core/appearance.json"] as { photo: Record<string, unknown> };
    const r2 = loadDataSet({ ...files, "core/appearance.json": { ...core, photo: { ...core.photo, roofs: { "farm-house": "#000000" }, floors: { castle: "#000000" } } } });
    expect(r2.errors.some((e) => e.path === "photo.roofs.farm-house")).toBe(true);
    expect(r2.errors.some((e) => e.path === "photo.floors.castle")).toBe(true);
  });
  it("rank insignia: every rank of every faction (and so every rank in a unit template) has one; unknown ranks are reported", () => {
    for (const f of ["de", "ru", "xf"]) {
      const pack = data.factions[f]!;
      const ins = pack.appearance!.insignia!;
      expect(ins, f).toBeDefined();
      for (const r of Object.keys(pack.ranks)) expect(ins.ranks[r], `${f} ${r}`).toBeDefined();
      for (const u of Object.values(pack.units)) for (const m of u.members) expect(ins.ranks[m.rank], `${f} ${u.id} ${m.rank}`).toBeDefined();
      // Researched factions say where it comes from; nothing from search extracts alone is "high".
      if (f !== "xf") { expect(ins.sources.length).toBeGreaterThan(0); expect(ins.confidence).not.toBe("high"); }
    }
    expect(buildAppearance(data, ["de", "ru"]).insignia?.["ru"]?.ranks["serzhant"]?.elements.map((e) => e.kind)).toEqual(["band", "band", "band"]);
    const de = files["factions/de/appearance.json"] as { insignia: { ranks: Record<string, unknown> } };
    const r = loadDataSet({ ...files, "factions/de/appearance.json": { ...de, insignia: { ...de.insignia, ranks: { ...de.insignia.ranks, general: { elements: [] } } } } });
    expect(r.errors.some((e) => e.file === "factions/de/appearance.json" && e.path === "insignia.ranks.general")).toBe(true);
  });
  it("rank insignia geometry (insignia-exact): every device lies on its board, as researched", () => {
    for (const f of ["de", "ru", "xf"]) {
      const ins = data.factions[f]!.appearance!.insignia!, b = ins.board, L = b.lengthMm;
      const hw = (y: number) => b.widthBottomMm / 2 + ((b.widthTopMm - b.widthBottomMm) / 2) * (y / L);
      if (ins.litze) expect(ins.strap, `${f}: a Litze needs a strap`).toBeDefined();
      for (const [r, d] of Object.entries(ins.ranks)) for (const e of d.elements) {
        const where = `${f} ${r} ${e.kind}`;
        if (e.kind === "band") { expect(Math.min(e.y0, e.y1), where).toBeGreaterThanOrEqual(0); expect(Math.max(e.y0, e.y1), where).toBeLessThanOrEqual(L); }
        if (e.kind === "band" && e.x0 !== undefined) expect(Math.abs(e.x0), where).toBeLessThanOrEqual(hw(e.y0));
        if (e.kind === "star") { expect(Math.abs(e.x) + e.diameterMm / 2, where).toBeLessThanOrEqual(hw(e.y)); expect(e.y - e.diameterMm / 2, where).toBeGreaterThanOrEqual(0); expect(e.y + e.diameterMm / 2, where).toBeLessThanOrEqual(L); }
        if (e.kind === "bar") { const t = Math.tan((e.angleDeg * Math.PI) / 180) * (hw(e.y) - e.insetMm); expect(e.y - Math.abs(t), where).toBeGreaterThan(0); expect(e.y + Math.abs(t), where).toBeLessThan(L); }
        if (e.kind === "chevron") { expect(e.halfSpanMm, where).toBeLessThan(hw(e.y)); expect(e.y + 2 * (e.headMm ?? 0), where).toBeLessThanOrEqual(L); expect(e.y - e.riseMm, where).toBeGreaterThan(0); }
      }
    }
    const de = data.factions["de"]!.appearance!.insignia!, ru = data.factions["ru"]!.appearance!.insignia!;
    // German slide 90 x 52/60 mm (TL 8455-0009), 4 mm Litze (bundeswehr.de); counts per Anlage 2 BPrDGrUnifAnO.
    expect([de.board.lengthMm, de.board.widthTopMm, de.board.widthBottomMm, de.litze!.widthMm]).toEqual([90, 52, 60, 4]);
    const L_DE = de.board.lengthMm;
    expect(de.ranks["schuetze"]!.bare).toBe(true);
    for (const [r, n] of [["gefreiter", 1], ["obergefreiter", 2], ["hauptgefreiter", 3], ["stabsgefreiter", 4]] as const) expect(de.ranks[r]!.elements.filter((e) => e.kind === "bar")).toHaveLength(n);
    expect(de.ranks["unteroffizier"]!.elements).toContainEqual(expect.objectContaining({ kind: "braid", open: true }));
    expect(de.ranks["hauptfeldwebel"]!.elements.some((e) => e.kind === "chevron" && (e.headMm ?? 0) > 0)).toBe(true);
    // Owner correction 2026-11-15: devices are built up from the shoulder end (y 0). Every stripe rank starts with the
    // Gefreiter's stripe; the Stabsgefreiter's fourth stripe is set apart (a larger gap than between the three below).
    const barYs = (r: string) => de.ranks[r]!.elements.flatMap((e) => (e.kind === "bar" ? [e.y] : [])).sort((a, b) => a - b);
    const low = barYs("gefreiter")[0]!;
    expect(low, "Gefreiter stripe in the lower third").toBeLessThan(L_DE / 3);
    for (const r of ["obergefreiter", "hauptgefreiter", "stabsgefreiter"]) expect(barYs(r)[0], r).toBe(low);
    const sg = barYs("stabsgefreiter"), gaps = sg.slice(1).map((y, i) => y - sg[i]!);
    expect(gaps[2]!).toBeGreaterThan(gaps[0]! + 3);
    expect(gaps[2]!).toBeGreaterThan(gaps[1]! + 3);
    expect(barYs("hauptgefreiter")).toEqual(sg.slice(0, 3));
    // The Leutnant's star in the lower third; the Oberleutnant's first star in the same place, the second above it.
    const starYs = (r: string) => de.ranks[r]!.elements.flatMap((e) => (e.kind === "star" ? [e.y] : [])).sort((a, b) => a - b);
    expect(starYs("leutnant")[0]!).toBeLessThan(L_DE / 3);
    expect(starYs("oberleutnant")[0]).toBe(starYs("leutnant")[0]);
    expect(starYs("oberleutnant")[1]!).toBeGreaterThan(starYs("oberleutnant")[0]! + 17);
    // Winkel (and the Kopfwinkel) low inside the closed Tresse: the lowest one's legs end in the lower fifth.
    for (const r of ["feldwebel", "oberfeldwebel", "hauptfeldwebel"]) {
      const lowest = Math.min(...de.ranks[r]!.elements.flatMap((e) => (e.kind === "chevron" ? [e.y - e.riseMm] : [])));
      expect(lowest, r).toBeLessThan(L_DE / 5);
    }
    // Russian field sleeve: narrow stripes 10 mm, 2 mm apart from 25 mm; stars 13 mm, a pair at +-12.5 mm (Ukaz 293, Prikaz 525).
    expect(ru.ranks["serzhant"]!.elements).toEqual([25, 37, 49].map((y0) => ({ kind: "band", y0, y1: y0 + 10 })));
    expect(ru.ranks["leytenant"]!.elements).toEqual([-12.5, 12.5].map((x) => ({ kind: "star", x, y: 25, diameterMm: 13, points: 5 })));
  });
});
