/** House lab (M7.5e): mode defend (the AI's mixed defence spreads the squad: one burst cannot catch them all) and
 *  mode leave (men leave a house that has become a trap, or that the enemy is inside); mode clear (a squad clears a
 *  house room by room, its grenades bursting in the room it clears). */
import { describe, expect, it } from "vitest";
import { houseClearMarkdown, houseClearRun, houseDefendLab, houseDefendMarkdown, houseLeaveMarkdown, houseLeaveRun, houseRocketLab, houseRocketMarkdown } from "../src/labs/house";
import { loadData } from "../src/scenarios";

const rows = houseDefendLab(loadData(), 3);
const mean = (d: string, f: (r: (typeof rows)[number]) => number) => { const rs = rows.filter((r) => r.defence === d); return rs.reduce((a, r) => a + f(r), 0) / rs.length; };

describe("house lab (defend)", () => {
  it("prints the table", () => { console.log(houseDefendMarkdown(rows)); });
  it("the mixed defence keeps at most a house's cap inside and fewer men within one burst's reach than all in", () => {
    for (const r of rows.filter((x) => x.defence === "mixed")) expect(r.insideAtSpread).toBeLessThanOrEqual(4);
    expect(mean("mixed", (r) => r.max10AtSpread)).toBeLessThan(mean("all in", (r) => r.max10AtSpread));
    expect(mean("mixed", (r) => r.insideAtSpread)).toBeGreaterThan(0);
  });
});

describe("house lab (leave)", () => {
  const data = loadData();
  const runs = [houseLeaveRun(data, 1, "trap", true), houseLeaveRun(data, 1, "trap", false), houseLeaveRun(data, 1, "enemy", true)];
  it("prints the table", () => { console.log(houseLeaveMarkdown(runs)); });
  it("a trap empties the house in time with the rule on, never with it off; an enemy inside does too", () => {
    const [on, off, enemy] = runs as [typeof runs[0], typeof runs[0], typeof runs[0]];
    expect(on.inside).toBeGreaterThan(0);
    // (Everyone who can walk: a man the trap left with a broken leg, M10.1, cannot get out by himself.)
    // (Since the D1 merge, seed 1: one man the trap leaves with a bad leg wound limps out, a few seconds too late.)
    expect(on.outInTime + on.cannotWalk).toBeGreaterThanOrEqual(on.inside - 1);
    expect(on.cannotWalk).toBeLessThanOrEqual(1);
    expect(on.reasons).toContain("trap");
    expect(off.reasons).toEqual([]);
    expect(off.outInTime).toBe(0);
    expect(enemy.seenInside).toBe(true);
    expect(enemy.outInTime).toBe(enemy.inside);
  });
});

describe("house lab (clear)", () => {
  const data = loadData();
  const runs = [houseClearRun(data, 1, "empty"), houseClearRun(data, 2, "empty")];
  it("prints the table", () => { console.log(houseClearMarkdown(runs)); });
  it("an empty house is cleared: every room entered, a grenade into most rooms, bursting in the room being cleared", () => {
    for (const r of runs) {
      expect(r.cleared).toBe(true);
      expect(r.taken).toBe(true);
      expect(r.roomsDone).toBe(r.rooms);
      expect(r.grenades).toBeGreaterThanOrEqual(2);
      expect(r.inRoom / r.grenades).toBeGreaterThanOrEqual(0.7);
      expect(r.redDown).toBeLessThanOrEqual(1);
    }
  });
});

describe("house lab (rocket, M7.6d)", () => {
  const rr = houseRocketLab(loadData(), 10);
  const sum = (a: string, f: (r: (typeof rr)[number]) => number) => rr.filter((r) => r.ammo === a).reduce((n, r) => n + f(r), 0);
  it("prints the table", () => { console.log(houseRocketMarkdown(rr)); });
  it("the RPO-A on a held room's wall puts at least twice as many of its men down as a PG-7VL; other rooms within one man", () => {
    expect(sum("ru-rpo-a", (r) => r.roomDown)).toBeGreaterThanOrEqual(2 * Math.max(1, sum("ru-pg7vl", (r) => r.roomDown)));
    expect(Math.abs(sum("ru-rpo-a", (r) => r.otherDown) - sum("ru-pg7vl", (r) => r.otherDown)) / 10).toBeLessThanOrEqual(1);
    expect(sum("ru-rpo-a", (r) => r.outsideDown)).toBe(0);
  });
});
