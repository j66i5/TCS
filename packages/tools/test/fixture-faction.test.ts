/**
 * FIXTURE FACTION (SPEC 4.3 rule 8, 9.4): a third, made-up faction loads from data alone and fights a
 * battle. If this ever needs an engine change, a faction has leaked into code. Must stay green forever.
 */
import { describe, expect, it } from "vitest";
import { buildCatalog, formatErrors, loadDataSet, Strings } from "@tcs/data";
import { allMembers, buildForce, demoBattle } from "@tcs/scenario";
import { countItems, runBattle } from "@tcs/sim";
import { wanderController } from "@tcs/ai";
import { readDataFiles } from "../src/data-files";

const files = readDataFiles(["core", "factions", "fixtures"]);

describe("fixture faction 'xf'", () => {
  const { data, errors } = loadDataSet(files);
  it("loads without errors", () => {
    expect(formatErrors(errors.filter((e) => e.severity === "error"))).toBe("");
    expect(data?.factions["xf"]?.manifest.fixture).toBe(true);
  });

  it("builds a force entirely from its data (names, ranks, nested units, loads)", () => {
    const u = buildForce(data!, { faction: "xf", template: "porter-band", seed: 4, keyPrefix: "x" });
    expect(u.callsign).toBe("Band 1");
    expect(u.subunits.map((s) => s.callsign)).toEqual(["Gang 1", "Gang 2"]);
    const men = allMembers(u);
    expect(men).toHaveLength(6);
    const names = data!.factions["xf"]!.names;
    for (const m of men) {
      expect(names.given.concat(names.givenFemale)).toContain(m.given);
      expect(names.family.some((f) => m.family === f || m.family === f + names.familyFemaleSuffix)).toBe(true);
      expect(["private", "boss"]).toContain(m.rank);
    }
  });

  it("fights a battle against a real faction and its load comes back out", () => {
    const input = demoBattle(data!, { seed: 9, factions: ["xf", "de"], templates: ["porter-band", "demo-team"], timeLimitSeconds: 60 });
    expect(Object.keys(input.catalog.factions)).toEqual(["de", "xf"]);
    const result = runBattle(input, {
      controllers: [wanderController("blue", 1, input.map), wanderController("red", 2, input.map)],
    });
    expect(result.endReason).toBe("time-limit");
    expect(result.sides.find((s) => s.side === "blue")).toMatchObject({ faction: "xf", soldiersStart: 6 });
    const out = result.forcesOut.find((f) => f.faction === "xf")!;
    const men = out.units.flatMap(allMembers);
    const mags = men.reduce((n, m) => n + m.load.filter((l) => l.type === "xf-mag").reduce((k, l) => k + l.count, 0), 0);
    expect(mags).toBe(2 * (4 + 10 + 2));
    expect(result.eventCounts["order.delivered"]).toBeGreaterThan(0);
    void countItems;
  });

  it("uses its own radio phrasing through the string table, with fallback to core", () => {
    const s = new Strings(data!);
    expect(s.t("radio.ack.move", { callsign: "Gang 1" }, "xf")).toBe("Gang 1 goes.");
    expect(s.t("radio.arrived", { callsign: "Gang 1" }, "xf")).toBe("Gang 1: in position.");
    expect(s.t("radio.ack.move", { callsign: "Trupp 1" }, "de")).toBe("Trupp 1: roger, moving.");
    expect(s.t("no.such.key")).toBe("[[no.such.key]]");
  });

  it("catalog contains only the factions taking part", () => {
    const c = buildCatalog(data!, ["xf"]);
    expect(Object.keys(c.items).sort()).toEqual(["xf-crate", "xf-mag", "xf-round", "xf-vest"]);
  });
});
