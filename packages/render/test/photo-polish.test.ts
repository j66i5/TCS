/**
 * The photo look's units and overlays (plan "photo", step "polish"): the small pictures (contact shadow, scorch,
 * grain) and the vector contour lines are deterministic and within their limits; the grain repeats seamlessly; the photo extras
 * (contact shadows, dark rims, scorch decals) exist only in the photo look, so flat and classic stay as they were.
 */
import { describe, expect, it } from "vitest";
import { createSim, heightAt, step } from "@tcs/sim";
import { contactShadow, grainTile, scorchDecal } from "../src/photo/decals";
import { CONTOUR_INTERVAL_M, contourSegments } from "../src/photo/contours";
import { BattleRenderer } from "../src/renderer";
import { getScenario, loadData } from "../../tools/src/scenarios";

const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);
const premultiplied = (b: Uint8Array) => { for (let p = 0; p < b.length; p += 4) if (b[p]! > b[p + 3]! || b[p + 1]! > b[p + 3]! || b[p + 2]! > b[p + 3]!) return false; return true; };

describe("photo decals", () => {
  it("are the same bytes every time and premultiplied", () => {
    for (const f of [() => contactShadow(16), () => scorchDecal(64), () => grainTile(64)]) {
      const a = f(), b = f();
      expect(same(a, b)).toBe(true);
      expect(premultiplied(a)).toBe(true);
    }
  });

  it("contact shadow: black, dense in the middle, clear at the edge, round", () => {
    const n = 16, s = contactShadow(n), A = (i: number, j: number) => s[(j * n + i) * 4 + 3]!;
    expect(A(8, 8)).toBeGreaterThan(200);
    expect(A(0, 0)).toBe(0);
    for (let k = 0; k < n; k++) expect(A(k, 3)).toBe(A(3, k));
    for (let p = 0; p < s.length; p += 4) expect(s[p]! + s[p + 1]! + s[p + 2]!).toBe(0);
  });

  it("scorch: never above its alpha cap, darkest towards the middle, clear in the corners", () => {
    const n = 64, s = scorchDecal(n, 0.5);
    let ring = 0, centre = 0, nr = 0, nc = 0;
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const a = s[(j * n + i) * 4 + 3]!, d = Math.hypot(i + 0.5 - n / 2, j + 0.5 - n / 2) / (n / 2);
      expect(a).toBeLessThanOrEqual(Math.round(255 * 0.5));
      if (d < 0.3) { centre += a; nc++; } else if (d > 0.9) { ring += a; nr++; }
    }
    expect(centre / nc).toBeGreaterThan(3 * (ring / nr));
    expect(s[3]).toBe(0);
  });

  it("grain: about as much lighter as darker, small, and seamless when repeated (wraps at the edge)", () => {
    const n = 64, g = grainTile(n, 0.1);
    let light = 0, dark = 0, maxA = 0;
    for (let p = 0; p < g.length; p += 4) { const a = g[p + 3]!; maxA = Math.max(maxA, a); if (a > 0) { if (g[p]! > 0) light++; else dark++; } }
    expect(maxA).toBeLessThanOrEqual(Math.ceil(255 * 0.14));
    expect(Math.abs(light - dark) / (light + dark)).toBeLessThan(0.15);
    // The coarse speck works in 2 px steps from the tile origin: an even tile size keeps the repeat seamless.
    const big = grainTile(2 * n, 0.1);
    expect(same(big.subarray(0, n * 4), g.subarray(0, n * 4))).toBe(true);
  });

  it("vector contours: every segment end lies on its 2.5 m level, majors every 10 m, deterministic", () => {
    const map = getScenario("platoon").build(loadData(), 1, 600).map;
    const seg = contourSegments(map);
    expect(seg.minor.length + seg.major.length).toBeGreaterThan(0);
    for (const [arr, major] of [[seg.minor, false], [seg.major, true]] as const) {
      for (let k = 0; k < arr.length; k += 2) {
        const h = heightAt(map, arr[k]!, arr[k + 1]!), L = Math.round(h / CONTOUR_INTERVAL_M) * CONTOUR_INTERVAL_M;
        // Linear crossing on a 2 m step of a bilinear surface: within a few centimetres of the level.
        expect(Math.abs(h - L)).toBeLessThan(0.08);
        expect(Math.round(L / CONTOUR_INTERVAL_M) % 4 === 0).toBe(major);
      }
    }
    const again = contourSegments(map);
    expect(Array.from(again.minor)).toEqual(Array.from(seg.minor));
  });
});

describe("photo extras only in the photo look", () => {
  const counts = (look: "photo" | "flat" | "classic") => {
    const input = getScenario("platoon").build(loadData(), 1, 600);
    const sim = createSim(input);
    for (let i = 0; i < 5; i++) step(sim);
    const r = BattleRenderer.headless(1280, 800);
    r.setLook(look);
    r.setCatalog(input.catalog);
    let x = 0, y = 0, n = 0;
    for (const [id, i] of sim.state.identity.entries()) if (i.side === "blue") { const t = sim.state.transform.get(id)!; x += t.x; y += t.y; n++; }
    r.camera = { x: x / n - 32, y: y / n - 20, scale: 20 };
    r.draw(sim.state, input.map, 0.5, { playerSide: "blue", selectedUnit: null, debug: false });
    const p = r as unknown as { contacts: { visible: boolean }[]; rims: unknown[]; figures: { visible: boolean }[] };
    return { figures: p.figures.filter((f) => f.visible).length, contacts: p.contacts.filter((c) => c.visible).length, rims: p.rims.length };
  };
  it("photo: one contact shadow and one rim per man drawn; flat and classic: none", () => {
    const ph = counts("photo"), fl = counts("flat"), cl = counts("classic");
    expect(ph.figures).toBeGreaterThan(0);
    expect(ph.contacts).toBe(ph.figures);
    expect(ph.rims).toBeGreaterThanOrEqual(ph.figures);
    expect(fl.contacts + fl.rims + cl.contacts + cl.rims).toBe(0);
    expect(fl.figures).toBe(ph.figures);
  });
});
