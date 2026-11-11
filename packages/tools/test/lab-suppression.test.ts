/** Suppression lab (M4.1): heavier and closer fire pins sooner; one aimed rifle hardly pins at all. */
import { describe, expect, it } from "vitest";
import { suppressionLab, suppressionLabMarkdown } from "../src/labs/suppression";
import { loadData } from "../src/scenarios";

const rows = suppressionLab(loadData());
const row = (firers: string, rangeM: number) => rows.find((r) => r.firers === firers && r.rangeM === rangeM)!;

describe("suppression lab", () => {
  it("prints the table", () => { console.log(suppressionLabMarkdown(rows)); });
  it("a machine gun pins the men it fires at within seconds, sooner close in than far off", () => {
    expect(row("mg", 200).firstPinS!).toBeLessThan(5);
    expect(row("mg", 600).firstPinS!).toBeLessThan(20);
    expect(row("mg", 600).firstPinS!).toBeGreaterThan(row("mg", 200).firstPinS!);
  });
  it("a fire team pins too, more slowly than the machine gun; one aimed rifle does not pin", () => {
    expect(row("team", 200).firstPinS!).toBeLessThan(15);
    expect(row("team", 200).firstPinS!).toBeGreaterThan(row("mg", 200).firstPinS!);
    expect(row("rifle", 200).firstPinS).toBeNull();
    expect(row("rifle", 200).pinned30).toBe(0);
  });
});
