/**
 * Fragmentation lab (SPEC 5.4, M2 acceptance). Owner decisions 2026-11-11: helmets stop fragments; a close burst
 * that does not wound stuns out to about 10 m. Bands are wide: the table goes to the owner for review.
 */
import { describe, expect, it } from "vitest";
import { FRAG_DISTANCES, fragmentationLab, fragmentationLabMarkdown, type FragRow } from "../src/labs/fragmentation";
import { loadData } from "../src/scenarios";

const r = fragmentationLab(loadData());
const at = (ammo: string, posture: string, d: number): FragRow => r.open.find((x) => x.ammo === ammo && x.posture === posture && x.distanceM === d)!;
const share = (a: number, b: number) => a / Math.max(1, b);
const MUNITIONS = ["de-dm51", "ru-rgd5", "de-40mm-he", "ru-vog25"];

describe("fragmentation lab", () => {
  it("prints its tables", () => { console.log(fragmentationLabMarkdown(r)); });

  it("every munition: nearly everyone at 2 m is wounded, hardly anyone at 30 m, falling with distance", () => {
    for (const m of MUNITIONS) {
      expect(share(at(m, "standing", 2).wounded, at(m, "standing", 2).men)).toBeGreaterThan(0.9);
      expect(share(at(m, "standing", 30).wounded, at(m, "standing", 30).men)).toBeLessThan(0.1);
      for (let i = 1; i < FRAG_DISTANCES.length; i++) {
        const a = at(m, "standing", FRAG_DISTANCES[i - 1]!), b = at(m, "standing", FRAG_DISTANCES[i]!);
        expect(share(b.wounded, b.men)).toBeLessThanOrEqual(share(a.wounded, a.men) + 0.05);
      }
    }
  });

  it("DM51 with its sleeve of steel balls: deadly within a few metres, wounding out to about 20 m", () => {
    const d = (x: number) => at("de-dm51", "standing", x);
    expect(share(d(2).dead60min, d(2).men)).toBeGreaterThan(0.8);
    expect(share(d(5).downAtOnce, d(5).men)).toBeGreaterThan(0.25);
    expect(share(d(5).downAtOnce, d(5).men)).toBeLessThan(0.8);
    expect(share(d(10).wounded, d(10).men)).toBeGreaterThan(0.6);
    expect(share(d(10).dead60min, d(10).men)).toBeLessThan(0.35);
    expect(share(d(20).wounded, d(20).men)).toBeGreaterThan(0.2);
    expect(share(d(20).wounded, d(20).men)).toBeLessThan(0.7);
    expect(share(d(20).downAtOnce, d(20).men)).toBeLessThan(0.05);
  });

  it("the RGD-5 (fewer, heavier fragments) reaches less far than the DM51; the 40 mm rounds wound about half at 5 m", () => {
    expect(share(at("ru-rgd5", "standing", 10).wounded, 160)).toBeLessThan(share(at("de-dm51", "standing", 10).wounded, 160));
    for (const m of ["de-40mm-he", "ru-vog25", "ru-rgd5"]) {
      const x = at(m, "standing", 5);
      expect(share(x.wounded, x.men)).toBeGreaterThan(0.25);
      expect(share(x.wounded, x.men)).toBeLessThan(0.75);
    }
  });

  it("lying down helps a great deal beyond the first metres", () => {
    for (const m of MUNITIONS) for (const d of [5, 10]) {
      const st = at(m, "standing", d), pr = at(m, "prone", d);
      expect(share(pr.wounded, pr.men)).toBeLessThan(share(st.wounded, st.men) * 0.9);
      expect(pr.woundsPerMan).toBeLessThan(st.woundsPerMan * 0.5 + 0.01);
    }
  });

  it("helmet and vest stop a share of the fragments (owner decision: helmets are for fragments)", () => {
    const x = at("de-dm51", "standing", 5);
    expect(x.stoppedPerMan).toBeGreaterThan(1);
    expect(x.stoppedPerMan / (x.stoppedPerMan + x.woundsPerMan)).toBeGreaterThan(0.15);
  });

  it("stun: unwounded men within about 10 m of a hand grenade are stunned; a brick wall protects completely", () => {
    const x = at("ru-rgd5", "standing", 10);
    expect(x.stunnedOnly).toBeGreaterThan(0.6 * x.men);
    expect(at("ru-rgd5", "standing", 15).stunnedOnly).toBe(0);
    for (const w of r.wall) { expect(w.wounded).toBe(0); expect(w.stunnedOnly).toBe(0); }
  });

  it("cover at 5 m: a chest-high brick wall protects a kneeling man completely and a standing man partly; a fence or hedge hardly at all", () => {
    const c = (ammo: string, cover: string, posture: string) => r.cover.find((x) => x.ammo === ammo && x.cover === cover && x.posture === posture)!;
    const openStanding = at("de-dm51", "standing", 5);
    expect(c("de-dm51", "brick wall 1 m", "crouching").wounded).toBe(0);
    expect(c("de-dm51", "brick wall 1 m", "standing").woundsPerMan).toBeLessThan(openStanding.woundsPerMan * 0.2);
    expect(c("de-dm51", "brick wall 1 m", "standing").wounded).toBeGreaterThan(0); // head and shoulders show
    for (const cover of ["wooden fence 1.8 m", "hedge 1.5 m"]) {
      expect(c("de-dm51", cover, "standing").woundsPerMan).toBeGreaterThan(openStanding.woundsPerMan * 0.6);
      expect(share(c("ru-rgd5", cover, "standing").wounded, 160)).toBeGreaterThan(0.25);
    }
  });
});
