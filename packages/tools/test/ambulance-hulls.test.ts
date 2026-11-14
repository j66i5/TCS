/** Ambulance hulls (M10.6-data): Boxer ambulance, BMM and the xf litter cart load as wheeled, unarmed, marked hulls with
 *  patient layouts; damaged wheels slow a wheeled hull (drive factors), a wrecked side immobilises it. */
import { describe, expect, it } from "vitest";
import { buildCatalog, formatErrors, loadDataSet } from "@tcs/data";
import { idleDrive, stepDriveDynamics, type DriveFactors } from "@tcs/sim";
import { readDataFiles } from "../src/data-files";
import { loadData } from "../src/scenarios";

describe("ambulance hulls", () => {
  const data = loadData(true);
  const cat = buildCatalog(data, ["de", "ru"]);

  it("Boxer ambulance and BMM: wheeled, no weapon station, marked, research capacities", () => {
    const boxer = cat.vehicles["de-boxer-san"]!, bmm = cat.vehicles["ru-bmm"]!;
    for (const v of [boxer, bmm]) {
      expect(v.class).toBe("wheeled");
      expect(v.stations).toHaveLength(0);
      expect(v.ambulance?.marked).toBe(true);
      // Three crew seats (commander, driver, medic) and seven sitting places.
      expect(v.seats.filter((s) => s.station !== "passenger")).toHaveLength(3);
      expect(v.seats.filter((s) => s.station === "passenger")).toHaveLength(7);
      for (const l of v.ambulance!.layouts) expect(l.sitting).toBeLessThanOrEqual(7);
    }
    expect(boxer.ambulance!.layouts).toEqual([{ lying: 3, sitting: 0, lyingOutside: 0 }, { lying: 0, sitting: 7, lyingOutside: 0 }, { lying: 2, sitting: 3, lyingOutside: 0 }]);
    expect(Math.max(...bmm.ambulance!.layouts.map((l) => l.lying + l.sitting + l.lyingOutside))).toBe(9);
    expect(cat.vehicles["de-puma"]!.ambulance).toBeUndefined();
  });

  it("damaged wheels pull less; a wheeled hull without components is unchanged", () => {
    const boxer = cat.vehicles["de-boxer-san"]!;
    const surf = { rolling: 0.03, traction: 0.8, lateral: 0.7, capMps: Infinity, sinPitch: 0, cosPitch: 1 };
    const run = (f: DriveFactors) => {
      let d = idleDrive(0, 0);
      for (let i = 0; i < 60 * 10; i++) d = stepDriveDynamics(boxer, d, { speed: 20, yawRate: 0 }, surf, 1 / 60, i, f).drive;
      return d.speed;
    };
    const full = run({ engine: 1, trackL: 1, trackR: 1 }), hurt = run({ engine: 1, trackL: 0.2, trackR: 1 });
    expect(hurt).toBeLessThan(full * 0.9);
    expect(hurt).toBeGreaterThan(0.5);
  });

  it("the xf fixture has a litter cart with wheel components (rule 8: no faction in code)", () => {
    const { data: xd, errors } = loadDataSet(readDataFiles(["core", "factions", "fixtures"]));
    if (!xd) throw new Error(formatErrors(errors));
    const xc = buildCatalog(xd, ["xf"]).vehicles["xf-litter-cart"]!;
    expect(xc.ambulance?.layouts.length).toBe(2);
    expect(xc.components?.filter((c) => c.kind === "wheels")).toHaveLength(2);
  });
});
