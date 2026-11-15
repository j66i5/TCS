/** Mount lab (M7.2): getting in and out from orders only; bands are game values (ramp block of vehicles.json). */
import { describe, expect, it } from "vitest";
import { mountLab, mountLabMarkdown } from "../src/labs/mount";
import { loadData } from "../src/scenarios";

const rows = mountLab(loadData(true));
const val = (v: string, c: string) => {
  const r = rows.find((x) => x.vehicle === v && x.case.startsWith(c));
  if (!r) throw new Error(`no row ${v} / ${c}`);
  return r.value;
};

describe("mount lab", () => {
  it("prints its table", () => {
    console.log(mountLabMarkdown(rows));
  });
  for (const [v, men] of [["de-puma", 6], ["ru-bmp2", 6], ["xf-cart", 3]] as const) {
    it(`${v}: the whole squad gets in and out; mount takes ramp + one man per exit at a time, dismount less`, () => {
      expect(val(v, "men aboard after mounting")).toBe(men);
      const mount = val(v, "mount from 10 m"), out = val(v, "dismount");
      expect(mount).toBeGreaterThan(0);
      expect(out).toBeGreaterThan(0);
      expect(mount).toBeLessThan(40);
      expect(out).toBeLessThan(20);
      expect(out).toBeLessThan(mount);
      // An order to the squad aboard: it gets out first, then carries it out (Q12).
      expect(val(v, "move order to the squad aboard")).toBeGreaterThan(out);
    });
  }
  // (The plan's GTK bands, 8-20 s in and 6-16 s out, assumed a six-man squad: eight men through the Boxer's one ramp
  // at the ambulance's 6 s ramp and 2.5 / 1.5 s a man take about 28 / 20 s; DECISIONS M7.6c.)
  it("M7.6c: the Jaegergruppe (8) through the GTK's rear ramp, the BTR squad (7) through the BTR-82A's side doors; all in, all out", () => {
    for (const [v, men, mount, out] of [["de-boxer-gtk", 8, [18, 35], [12, 25]], ["ru-btr82a", 7, [8, 30], [8, 25]]] as const) {
      expect(val(v, "men aboard after mounting")).toBe(men);
      expect(val(v, "mount from 10 m")).toBeGreaterThanOrEqual(mount[0]);
      expect(val(v, "mount from 10 m")).toBeLessThanOrEqual(mount[1]);
      expect(val(v, "dismount")).toBeGreaterThanOrEqual(out[0]);
      expect(val(v, "dismount")).toBeLessThanOrEqual(out[1]);
      expect(val(v, "move order to the squad aboard")).toBeGreaterThan(val(v, "dismount"));
    }
    // The BTR's cramped side doors: slower out than the BMP-2's rear doors.
    expect(val("ru-btr82a", "dismount")).toBeGreaterThan(val("ru-bmp2", "dismount"));
  });
  it("the Puma's single ramp is slower than the BMP-2's two doors", () => {
    expect(val("de-puma", "mount from 10 m")).toBeGreaterThan(val("ru-bmp2", "mount from 10 m"));
    expect(val("de-puma", "dismount")).toBeGreaterThan(val("ru-bmp2", "dismount"));
  });
});
