/** M7.6c: `?vehicles=` chooses the battle on foot or the carrier class of each side's platoon. */
import { describe, expect, it } from "vitest";
import { carriersParam } from "../src/params";

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
