/** M7.6c: `?vehicles=` chooses the battle on foot or the carrier class of each side's platoon. */
import { describe, expect, it } from "vitest";
import { carriersParam, defaultTanksApply, tanksParam } from "../src/params";

describe("carriersParam (M7.6c)", () => {
  it("0 is on foot; absent, 1 and tracked are the tracked default", () => {
    expect(carriersParam("0")).toEqual({ vehicles: false });
    for (const v of [null, "", "1", "tracked"]) expect(carriersParam(v)).toEqual({ vehicles: true });
  });
  it("wheeled, and one class per side", () => {
    expect(carriersParam("wheeled")).toEqual({ vehicles: true, carriers: "wheeled" });
    expect(carriersParam("wheeled,tracked")).toEqual({ vehicles: true, carriers: ["wheeled", "tracked"] });
  });
  it("anything else warns and falls back to tracked", () => {
    const warnings: string[] = [];
    expect(carriersParam("boxer", (m) => warnings.push(m))).toEqual({ vehicles: true });
    expect(carriersParam("wheeled,hover", (m) => warnings.push(m))).toEqual({ vehicles: true });
    expect(warnings).toHaveLength(2);
  });
});

describe("tanksParam (M7.6b; balance pass 3: the mounted battle's default)", () => {
  const mounted = { tanks: "defender" as const, tankTemplates: [null, "t90"] as [string | null, string | null] };
  it("absent: the balanced mounted battle's sections; on foot none; 0 none", () => {
    expect(tanksParam(null, null, mounted)).toEqual(mounted);
    expect(tanksParam(null, null, { tanks: "attacker" })).toEqual({ tanks: "attacker" });
    expect(tanksParam(null, null, null)).toEqual({});
    expect(tanksParam("0", null, mounted)).toEqual({});
    expect(tanksParam(null, ",x", mounted)).toEqual({ tanks: "defender", tankTemplates: [null, "x"] });
  });
  it("the old values keep working", () => {
    expect(tanksParam("1", null, mounted)).toEqual({ tanks: true });
    expect(tanksParam("both", null, null)).toEqual({ tanks: true });
    expect(tanksParam("attacker", null, mounted)).toEqual({ tanks: "attacker" });
    expect(tanksParam("defender", "a,b", mounted)).toEqual({ tanks: "defender", tankTemplates: ["a", "b"] });
  });
  it("anything else warns and takes the default (review fix)", () => {
    const warnings: string[] = [];
    expect(tanksParam("yes", null, mounted, (m) => warnings.push(m))).toEqual(mounted);
    expect(tanksParam("true", null, null, (m) => warnings.push(m))).toEqual({});
    tanksParam("0", null, mounted, (m) => warnings.push(m));
    tanksParam(null, null, mounted, (m) => warnings.push(m));
    expect(warnings).toHaveLength(2);
  });
});

describe("defaultTanksApply (balance pass 3 review): the default tanks only in the battle the batch measures", () => {
  it("tracked carriers on both sides, no assault group", () => {
    expect(defaultTanksApply({ vehicles: true }, false)).toBe(true);
    expect(defaultTanksApply({ vehicles: true, carriers: "tracked" }, false)).toBe(true);
    expect(defaultTanksApply({ vehicles: true, carriers: ["tracked", "tracked"] }, false)).toBe(true);
  });
  it("not on foot, wheeled, mixed or with the assault group", () => {
    expect(defaultTanksApply({ vehicles: false }, false)).toBe(false);
    expect(defaultTanksApply({ vehicles: true, carriers: "wheeled" }, false)).toBe(false);
    expect(defaultTanksApply({ vehicles: true, carriers: ["tracked", "wheeled"] }, false)).toBe(false);
    expect(defaultTanksApply({ vehicles: true }, true)).toBe(false);
  });
});
