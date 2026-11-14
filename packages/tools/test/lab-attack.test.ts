/** Attack lab (M4 acceptance): an attack in the open against a prepared defence fails most of the time; support by fire helps. */
import { describe, expect, it } from "vitest";
import { attackLab, attackLabMarkdown } from "../src/labs/attack";
import { loadData } from "../src/scenarios";

const rows = attackLab(loadData(), 16);
const rate = (f: (r: (typeof rows)[number]) => boolean) => { const rs = rows.filter(f); return rs.filter((r) => r.winner === "attacker").length / rs.length; };

const defenceLoss = (f: (r: (typeof rows)[number]) => boolean) => { const rs = rows.filter(f); return rs.reduce((a, r) => a + r.defenderDown / Math.max(1, r.defenderMen), 0) / rs.length; };

describe("attack lab", () => {
  it("prints the table", () => { console.log(attackLabMarkdown(rows)); });
  it("one squad attacking across the open against a squad behind a wall fails most of the time", () => {
    expect(rate((r) => r.wall && !r.support)).toBeLessThanOrEqual(0.25);
  });
  // (Review fixes 2026-11-14: the win-rate comparison alone had come to rest on one or two seeds — 20 trials were
  // needed at one point. Support is also measured by what it does to the defence, its losses: over 50 trials a
  // supported attack on the wall wins 14/50 and costs the defence 12 % of its men, an unsupported one 0/50 and 4 %.)
  it("outcomes vary: a second squad firing in support hurts the defence more and makes success more likely", () => {
    expect(defenceLoss((r) => r.wall && r.support)).toBeGreaterThan(defenceLoss((r) => r.wall && !r.support));
    expect(rate((r) => r.wall && r.support)).toBeGreaterThan(rate((r) => r.wall && !r.support));
    expect(new Set(rows.map((r) => r.how)).size).toBeGreaterThan(2);
  });
});
