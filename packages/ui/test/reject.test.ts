/** Review 2026-11-24 step 5, item 7: every reason the simulation can refuse an order with has a player sentence. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Strings } from "@tcs/data";
import { createSim, step, submitOrder, type OrderKind, type OrderRejectReason } from "@tcs/sim";
import { getScenario, loadData } from "../../tools/src/scenarios";
import { REJECT_KEYS, rejectionKeys, rejectionText } from "../src/reject";
import { unitTiles } from "../src/sidebar";

const strings = new Strings(loadData(), "en");
const REASONS = Object.keys(REJECT_KEYS) as OrderRejectReason[];
const src = (p: string) => readFileSync(new URL(`../../sim/src/${p}`, import.meta.url), "utf8");

describe("order rejections in words", () => {
  it("the simulation's reasons are exactly the ones with a sentence", () => {
    // The union in orders.ts ...
    const decl = src("orders.ts");
    const body = decl.slice(decl.indexOf("export type OrderRejectReason")).replace(/\/\*[\s\S]*?\*\//g, "").split(";")[0]!;
    const union = [...body.matchAll(/"([a-z-]+)"/g)].map((m) => m[1]!).sort();
    expect(union).toEqual([...REASONS].sort());
    // ... and every reason literal the order system returns or emits.
    const sys = src("systems/orders.ts");
    const validate = sys.slice(sys.indexOf("function validate("), sys.indexOf("function orderApplies("));
    const used = new Set([
      ...[...validate.matchAll(/return "([a-z-]+)"/g), ...validate.matchAll(/\? null : "([a-z-]+)"/g)].map((m) => m[1]!),
      ...[...sys.matchAll(/kind: "order\.rejected"[^\n]*?reason: "([a-z-]+)"/g)].map((m) => m[1]!),
    ]);
    expect([...used].sort()).toEqual([...REASONS].sort());
    for (const r of used) expect(REASONS, r).toContain(r);
  });
  it("every sentence exists in the string table and shows no raw reason", () => {
    for (const key of rejectionKeys()) {
      const text = strings.t(key, { unit: "Alpha" });
      expect(text.startsWith("[["), key).toBe(false);
      // (The raw tokens are hyphenated or were shown in brackets: "(late)".)
      for (const r of REASONS) expect(r.includes("-") ? text.includes(r) : text.includes(`(${r})`), `${key}: ${text}`).toBe(false);
      expect(text).not.toMatch(/\{[a-z]+\}/i);
    }
    // The old general line is the last fallback and has no reason placeholder any more.
    expect(strings.t("order.rejected")).not.toContain("{");
  });
  it("a superseded order says nothing; the others a sentence, more exact where the kind tells", () => {
    expect(rejectionText("superseded", "move")).toBeNull();
    for (const r of REASONS) if (r !== "superseded") expect(rejectionText(r, null)?.key).toBe(REJECT_KEYS[r]);
    expect(rejectionText("not-applicable", "posture")?.key).toBe("order.rejected.not-applicable.crew");
    expect(rejectionText("not-applicable", "repair")?.key).toBe("order.rejected.not-applicable.battle");
    expect(rejectionText("invalid-params", "move")?.key).toBe("order.rejected.invalid-params.move");
    expect(rejectionText("invalid-params", "rules")?.key).toBe("order.rejected.invalid-params");
    expect(rejectionText("no-comms", "move")?.key).toBe("order.rejected.no-comms");
  });
  it("a real refusal: a posture order to a vehicle crew, a move off the map", () => {
    const sim = createSim(getScenario("platoon-vehicles").build(loadData(), 1, 60));
    const tiles = unitTiles(sim.state, "blue", sim.ctx.catalog);
    const crew = tiles.find((t) => t.kind === "vehicle")!, squad = tiles.find((t) => t.kind === "infantry")!;
    const kinds = new Map<number, OrderKind>();
    kinds.set(submitOrder(sim, { tick: 0, issuer: "blue", target: crew.unit, kind: "posture", posture: "prone" }), "posture");
    kinds.set(submitOrder(sim, { tick: 0, issuer: "blue", target: squad.unit, kind: "move", waypoints: [{ x: -50, y: 10, mode: "walk" }] }), "move");
    const lines: string[] = [];
    for (const e of step(sim)) if (e.kind === "order.rejected") {
      const r = rejectionText(e.reason, kinds.get(e.seq) ?? null)!;
      lines.push(strings.t(r.key, { unit: sim.state.unit.get(e.target)!.callsign }));
    }
    expect(lines.length).toBe(2);
    expect(lines[0]).toContain(crew.callsign);
    expect(lines[0]).toContain("vehicle crew");
    expect(lines[1]).toContain("off the map");
    for (const l of lines) for (const r of REASONS) if (r.includes("-")) expect(l.includes(r)).toBe(false);
  });
});
