/**
 * M7.5b look: zoom levels with hysteresis, the soldier art and atlas (original 16 x 16 frames, palette swap,
 * outline, turning), the roof-fade rule, and the flat map painter (deterministic, tiles join seamlessly).
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildAppearance, buildCatalog } from "@tcs/data";
import { generateMap } from "@tcs/scenario";
import { flatMap, type MapDef } from "@tcs/sim";
import { CLOSE_SCALE, FIGURE_SCALE, OPENING_SCALE, LOD_CLOSE, LOD_DOTS, LOD_FIGURE, LOD_SYMBOLS, SYMBOL_SCALE, lodFor } from "../src/lod";
import { ART, FRAMES, type FrameId } from "../src/sprites/soldier-art";
import { CELL, FACINGS, LETTERS, composeFrame, facingOf, frameKey, outlineMask, paletteFor, rotateFrame, weaponLook } from "../src/sprites/atlas";
import { ROOF_NEAR_M, buildingIndex, roofShown } from "../src/buildings";
import { flatColours, paintContours, paintRegion } from "../src/terrain-flat";
import { loadData } from "../../tools/src/scenarios";

describe("zoom levels", () => {
  it("bands by scale and 10 % hysteresis at each boundary", () => {
    expect(lodFor(0.5, null)).toBe(LOD_SYMBOLS);
    expect(lodFor(2, null)).toBe(LOD_DOTS);
    expect(lodFor(8, null)).toBe(LOD_FIGURE);
    expect(lodFor(20, null)).toBe(LOD_CLOSE);
    // Up at the threshold, down only 10 % below it.
    expect(lodFor(CLOSE_SCALE * 0.95, LOD_CLOSE)).toBe(LOD_CLOSE);
    expect(lodFor(CLOSE_SCALE * 0.95, LOD_FIGURE)).toBe(LOD_FIGURE);
    expect(lodFor(CLOSE_SCALE / 1.1 - 0.01, LOD_CLOSE)).toBe(LOD_FIGURE);
    expect(lodFor(FIGURE_SCALE * 0.95, LOD_FIGURE)).toBe(LOD_FIGURE);
    expect(lodFor(FIGURE_SCALE * 0.95, LOD_DOTS)).toBe(LOD_DOTS);
    expect(lodFor(SYMBOL_SCALE * 0.95, LOD_DOTS)).toBe(LOD_DOTS);
    expect(lodFor(SYMBOL_SCALE * 0.8, LOD_DOTS)).toBe(LOD_SYMBOLS);
    // A big jump crosses several levels at once.
    expect(lodFor(0.3, LOD_CLOSE)).toBe(LOD_SYMBOLS);
    expect(lodFor(30, LOD_SYMBOLS)).toBe(LOD_CLOSE);
  });
  it("figures only where a man (1 m, true scale) is at least 8 px; the opening zoom shows figures", () => {
    expect(FIGURE_SCALE).toBeGreaterThanOrEqual(8);
    expect(lodFor(OPENING_SCALE, null)).toBe(LOD_FIGURE);
  });
});

describe("soldier art and atlas", () => {
  const frames = Object.keys(FRAMES) as FrameId[];
  it("every frame is 16 x 16 of known letters", () => {
    for (const f of frames) {
      expect(FRAMES[f].length, f).toBe(ART);
      for (const row of FRAMES[f]) { expect(row.length, `${f}: ${row}`).toBe(ART); for (const ch of row) expect(LETTERS.includes(ch), `${f}: '${ch}'`).toBe(true); }
    }
  });
  it("composition is deterministic; weapons, flash, launcher and wounds change the picture; the outline is never empty", () => {
    for (const f of frames) {
      const base = composeFrame({ frame: f, weapon: "rifle", launcher: false, firing: false, wounded: false });
      expect(composeFrame({ frame: f, weapon: "rifle", launcher: false, firing: false, wounded: false })).toEqual(base);
      expect(outlineMask(base).some((v) => v === 1), f).toBe(true);
      for (let k = 0; k < FACINGS; k++) expect(outlineMask(rotateFrame(base, k)).some((v) => v === 1), `${f} ${k}`).toBe(true);
    }
    const plain = composeFrame({ frame: "stand", weapon: "rifle", launcher: false, firing: false, wounded: false });
    for (const v of [{ weapon: "mg" }, { weapon: "marksman" }, { firing: true }, { launcher: true }, { wounded: true }] as const) {
      expect(composeFrame({ frame: "stand", weapon: "rifle", launcher: false, firing: false, wounded: false, ...v }), JSON.stringify(v)).not.toEqual(plain);
    }
    // The flash has its own colour (f) and never gets the side outline.
    const fire = composeFrame({ frame: "stand", weapon: "rifle", launcher: false, firing: true, wounded: false });
    expect(fire.includes(LETTERS.indexOf("f"))).toBe(true);
  });
  it("quarter turns move pixels exactly; every facing keeps the figure's size roughly", () => {
    const g = composeFrame({ frame: "prone", weapon: "mg", launcher: true, firing: true, wounded: true });
    const r4 = rotateFrame(g, 4), r8 = rotateFrame(g, 8), back = rotateFrame(rotateFrame(rotateFrame(rotateFrame(g, 4), 4), 4), 4);
    expect(back).toEqual(g);
    expect(rotateFrame(r4, 4)).toEqual(r8);
    const n = (a: Uint8Array) => a.reduce((s, v) => s + (v ? 1 : 0), 0);
    for (let k = 1; k < FACINGS; k++) { const m = n(rotateFrame(g, k)); expect(m).toBeGreaterThan(n(g) * 0.75); expect(m).toBeLessThan(n(g) * 1.35); }
    expect(g.length).toBe(CELL * CELL);
  });
  it("palette swap per faction from the appearance data; no faction is named in the code", () => {
    const data = loadData(true);
    const ids = Object.keys(data.factions).sort();
    const app = buildAppearance(data, ids);
    const pals = ids.map((f) => paletteFor(app.factions[f]!).join());
    expect(new Set(pals).size).toBe(ids.length); // each faction its own tones
    expect(paletteFor(app.factions["no-such-faction"] ?? app.factions[ids[0]!]!)).toHaveLength(LETTERS.length);
  });
  it("weapon looks, facings and keys", () => {
    expect(weaponLook("machine-gun")).toBe("mg");
    expect(weaponLook("light-machine-gun")).toBe("mg");
    expect(weaponLook("marksman-rifle")).toBe("marksman");
    expect(weaponLook("rifle")).toBe("rifle");
    expect(weaponLook(undefined)).toBe("rifle");
    expect(facingOf(0)).toBe(0);
    expect(facingOf(Math.PI / 2)).toBe(4);
    expect(facingOf(-Math.PI / 2)).toBe(12);
    expect(facingOf(Math.PI / 8 * 0.49)).toBe(0);
    const keys = new Set<number>();
    for (const f of frames) for (const weapon of ["rifle", "mg", "marksman"] as const) for (const facing of [0, 5, 15]) keys.add(frameKey({ frame: f, weapon, launcher: true, firing: false, wounded: true, facing }));
    expect(keys.size).toBe(frames.length * 3 * 3);
  });
});

describe("roof fade", () => {
  const map = flatMap("t", 200, 200);
  map.buildings.push({ id: 0, kind: "house", footprint: [50, 50, 60, 50, 60, 58, 50, 58], storeys: 1, storeyHeightM: 3, wallMaterial: "brick", wallThicknessM: 0.3, openings: [], roofColour: "#884433" });
  map.buildings.push({ id: 1, kind: "house", footprint: [150, 150, 160, 150, 160, 158, 150, 158], storeys: 1, storeyHeightM: 3, wallMaterial: "brick", wallThicknessM: 0.3, openings: [], roofColour: "#884433" });
  const idx = buildingIndex(map);
  it("shown with nobody near; faded with an own man inside or within 8 m; all faded close up", () => {
    expect([...roofShown(idx, [], 0, false)]).toEqual([1, 1]);
    expect([...roofShown(idx, [55, 54], 1, false)]).toEqual([0, 1]);
    expect([...roofShown(idx, [60 + ROOF_NEAR_M - 0.5, 54], 1, false)]).toEqual([0, 1]);
    expect([...roofShown(idx, [60 + ROOF_NEAR_M + 0.5, 54], 1, false)]).toEqual([1, 1]);
    expect([...roofShown(idx, [5, 5, 155, 159 + 7], 2, false)]).toEqual([1, 0]);
    expect([...roofShown(idx, [], 0, true)]).toEqual([0, 0]);
    expect([...roofShown(idx, [-50, 900], 1, false)]).toEqual([1, 1]); // off the map: ignored
  });
});

describe("flat map painter", () => {
  const data = loadData();
  const cat = buildCatalog(data, ["de", "ru"]);
  const app = buildAppearance(data, ["de", "ru"]);
  const map: MapDef = generateMap(cat.terrain, { kind: "village", seed: 2, widthM: 600, heightM: 600 });
  const col = flatColours(map, cat.terrain, app);
  it("deterministic, and a detail tile equals the same part of a larger picture (seamless tiles)", () => {
    const a = paintRegion(map, col, 256, 256, 64, 64, 4);
    expect(paintRegion(map, col, 256, 256, 64, 64, 4)).toEqual(a);
    const big = paintRegion(map, col, 192, 192, 192, 192, 4);
    let diff = 0;
    // (The last row and column of a tile have no neighbour for the field seams: compared without them.)
    for (let y = 0; y < 255; y++) for (let x = 0; x < 255; x++) {
      const p = (y * 256 + x) * 4, q = ((y + 256) * 768 + x + 256) * 4;
      if (a[p] !== big[q] || a[p + 1] !== big[q + 1] || a[p + 2] !== big[q + 2]) diff++;
    }
    expect(diff).toBe(0);
    expect(a.length).toBe(256 * 256 * 4);
    for (let i = 3; i < a.length; i += 4) if (a[i] !== 255) throw new Error("not opaque");
  });
});

describe("flat map painter after the photo split (plan photo step ground)", () => {
  it("paints the same bytes as before the split (hashes taken from the M7.5b painter)", () => {
    const data = loadData();
    const cat = buildCatalog(data, ["de", "ru"]);
    const app = buildAppearance(data, ["de", "ru"]);
    const h = (b: Uint8Array) => createHash("sha256").update(b).digest("hex").slice(0, 16);
    const want: Record<string, [string, string, string]> = {
      village: ["0f99b6b7ed897225", "c4a715275935319c", "e9e29bcb9ee45348"],
      woodland: ["fd1bc3357db50640", "72a31a4c6aed3493", "aec003f6eb0839c8"],
    };
    for (const kind of ["village", "woodland"] as const) {
      const map = generateMap(cat.terrain, { kind, seed: 2, widthM: 600, heightM: 600 });
      const col = flatColours(map, cat.terrain, app);
      expect([h(paintRegion(map, col, 256, 256, 64, 64, 4)), h(paintRegion(map, col, 0, 0, 600, 600, 1)), h(paintContours(map, 1))], kind).toEqual(want[kind]);
    }
  });
});
