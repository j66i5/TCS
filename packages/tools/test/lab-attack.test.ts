/** Attack lab (M4 acceptance): an attack in the open against a prepared defence fails most of the time; support by fire helps. */
import { describe, expect, it } from "vitest";
import { attackLab, attackLabMarkdown } from "../src/labs/attack";
import { loadData } from "../src/scenarios";

const rows = attackLab(loadData(), 16); // (16: with men aiming low at men lying down (package A) a supported attack on the wall succeeds about 1 in 10)
const rate = (f: (r: (typeof rows)[number]) => boolean) => { const rs = rows.filter(f); return rs.filter((r) => r.winner === "attacker").length / rs.length; };

describe("attack lab", () => {
  it("prints the table", () => { console.log(attackLabMarkdown(rows)); });
  it("one squad attacking across the open against a squad behind a wall fails most of the time", () => {
    expect(rate((r) => r.wall && !r.support)).toBeLessThanOrEqual(0.25);
  });
  it("outcomes vary: a second squad firing in support makes success more likely", () => {
    expect(rate((r) => r.wall && r.support)).toBeGreaterThan(rate((r) => r.wall && !r.support));
    expect(new Set(rows.map((r) => r.how)).size).toBeGreaterThan(2);
  });
});
