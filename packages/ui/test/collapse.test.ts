/** Owner 2026-11-20: folding sub-units in the unit sidebar (pure part, collapse.ts). */
import { describe, expect, it } from "vitest";
import { Strings } from "@tcs/data";
import { createSim, simHash } from "@tcs/sim";
import { getScenario, loadData } from "../../tools/src/scenarios";
import { expandTo, foldKeys, visibleTiles } from "../src/collapse";
import { unitTiles, type TileState, type UnitTile } from "../src/sidebar";

let next = 1;
const tile = (callsign: string, depth: number, kind: UnitTile["kind"], state: TileState = "ok", unit = next++): UnitTile =>
  ({ unit, callsign, parent: null, depth, kind, fit: 4, total: 4, state });

/** A company: HQ (its HQ group and drone), two platoons (each its HQ group, two squads and a vehicle). */
function company(states: Record<string, TileState> = {}): UnitTile[] {
  next = 1;
  const t: UnitTile[] = [];
  const co = tile("Kp", 0, "hq");
  t.push(co, tile("Kp", 1, "hqGroup", "ok", co.unit), tile("Kp", 2, "drone", "ok", co.unit));
  for (const p of ["1. Zug", "2. Zug"]) {
    const pl = tile(p, 1, "hq");
    t.push(pl, tile(p, 2, "hqGroup", "ok", pl.unit));
    for (const sq of ["1. Gruppe", "2. Gruppe"]) t.push(tile(sq, 2, "infantry", states[`${p}/${sq}`] ?? "ok"));
    t.push(tile("Puma", 2, "vehicle", states[`${p}/Puma`] ?? "ok"));
  }
  return t;
}
const names = (rows: { tile: UnitTile }[]) => rows.map((r) => `${r.tile.depth}:${r.tile.kind}:${r.tile.callsign}`);

describe("visibleTiles", () => {
  it("nothing folded: every tile, in order (today's list)", () => {
    const t = company();
    const rows = visibleTiles(t, new Set());
    expect(rows.map((r) => r.tile)).toEqual(t);
    expect(rows.every((r) => !r.collapsed && r.hidden === 0 && r.alert === null)).toBe(true);
  });
  it("fold keys are callsign paths, only on units with sub-units; the same squad name in two platoons stays apart", () => {
    const t = company();
    const { keys } = foldKeys(t);
    expect(keys.filter((k) => k !== null)).toEqual(["Kp", "Kp/1. Zug", "Kp/2. Zug"]);
    expect(keys[t.findIndex((x) => x.kind === "hqGroup")]).toBeNull();
    expect(keys[t.findIndex((x) => x.kind === "infantry")]).toBeNull();
  });
  it("a folded platoon hides its HQ group, squads and vehicle, and counts the units hidden", () => {
    const t = company();
    const rows = visibleTiles(t, new Set(["Kp/1. Zug"]));
    expect(names(rows)).toEqual(["0:hq:Kp", "1:hqGroup:Kp", "2:drone:Kp", "1:hq:1. Zug", "1:hq:2. Zug", "2:hqGroup:2. Zug", "2:infantry:1. Gruppe", "2:infantry:2. Gruppe", "2:vehicle:Puma"]);
    const pl = rows.find((r) => r.tile.callsign === "1. Zug")!;
    expect(pl).toMatchObject({ collapsed: true, hidden: 3, alert: null, fold: "Kp/1. Zug" });
  });
  it("nested folds: the company folded hides everything under it, the platoon's own fold is kept for later", () => {
    const t = company();
    const both = new Set(["Kp", "Kp/1. Zug"]);
    const rows = visibleTiles(t, both);
    expect(names(rows)).toEqual(["0:hq:Kp"]);
    expect(rows[0]!.hidden).toBe(8); // two platoons, four squads, two vehicles
    // Unfolding the company shows the platoon still folded.
    const open = visibleTiles(t, new Set(["Kp/1. Zug"]));
    expect(open.find((r) => r.tile.callsign === "1. Zug")!.collapsed).toBe(true);
  });
  it("the worst state below shows on the folded tile (broken before pinned before damaged before firing before lost)", () => {
    const t = company({ "1. Zug/2. Gruppe": "pinned", "1. Zug/Puma": "damaged", "2. Zug/1. Gruppe": "lost", "2. Zug/2. Gruppe": "firing" });
    const r = (c: Set<string>, cs: string) => visibleTiles(t, c).find((x) => x.tile.callsign === cs && x.tile.kind === "hq")!;
    expect(r(new Set(["Kp/1. Zug"]), "1. Zug").alert).toBe("pinned");
    expect(r(new Set(["Kp/2. Zug"]), "2. Zug").alert).toBe("firing");
    expect(r(new Set(["Kp"]), "Kp").alert).toBe("pinned");
    const t2 = company({ "2. Zug/Puma": "broken", "1. Zug/1. Gruppe": "pinned" });
    expect(visibleTiles(t2, new Set(["Kp"]))[0]!.alert).toBe("broken");
    // Moving, aboard and ready are not flagged; nor is anything while unfolded.
    expect(visibleTiles(company({ "1. Zug/1. Gruppe": "moving", "1. Zug/2. Gruppe": "aboard" }), new Set(["Kp"]))[0]!.alert).toBeNull();
    expect(visibleTiles(t, new Set()).every((x) => x.alert === null)).toBe(true);
  });
  it("a folded tile that holds the selected unit (or its HQ part) says so", () => {
    const t = company();
    const sq = t.find((x) => x.callsign === "2. Gruppe")!;
    const pl = t.find((x) => x.callsign === "1. Zug")!;
    expect(visibleTiles(t, new Set(["Kp/1. Zug"]), { unit: sq.unit }).find((r) => r.tile === pl)!.holdsSelected).toBe(true);
    expect(visibleTiles(t, new Set(["Kp/1. Zug"]), { unit: pl.unit, part: "hq" }).find((r) => r.tile === pl)!.holdsSelected).toBe(true);
    // The platoon itself selected: its own tile shows, nothing below holds it.
    expect(visibleTiles(t, new Set(["Kp/1. Zug"]), { unit: pl.unit }).find((r) => r.tile === pl)!.holdsSelected).toBe(false);
  });
});

describe("expandTo", () => {
  it("opens every fold above the selected tile and keeps the others", () => {
    const t = company();
    const sq = t.filter((x) => x.callsign === "1. Gruppe")[1]!; // the second platoon's
    const c = new Set(["Kp", "Kp/1. Zug", "Kp/2. Zug"]);
    const out = expandTo(t, c, sq.unit);
    expect([...out].sort()).toEqual(["Kp/1. Zug"]);
    expect(visibleTiles(t, out).some((r) => r.tile === sq)).toBe(true);
    expect(c.size).toBe(3); // not changed in place
  });
  it("the same set back when the tile already shows; a folded unit selected itself stays folded", () => {
    const t = company();
    const c = new Set(["Kp/1. Zug"]);
    const pl = t.find((x) => x.callsign === "1. Zug")!;
    expect(expandTo(t, c, pl.unit)).toBe(c);
    expect(expandTo(t, c, t.find((x) => x.callsign === "2. Gruppe")!.unit) === c).toBe(false);
    // A platoon's drone or HQ tile opens the platoon.
    expect(expandTo(t, c, pl.unit, "hq").size).toBe(0);
    expect(expandTo(t, new Set(["Kp"]), t[0]!.unit, "drone").size).toBe(0);
    expect(expandTo(t, c, 9999)).toBe(c);
  });
});

describe("folding a real battle's list", () => {
  it("a platoon folded rolls its men up in its own tile (fit/total of the whole platoon); the sim untouched", () => {
    const sim = createSim(getScenario("platoon-vehicles").build(loadData(), 1, 600));
    const h = simHash(sim);
    const tiles = unitTiles(sim.state, "blue", sim.ctx.catalog);
    const { keys } = foldKeys(tiles);
    const k = keys.find((x) => x !== null)!;
    const rows = visibleTiles(tiles, new Set([k]));
    expect(rows.length).toBeLessThan(tiles.length);
    const top = rows.find((r) => r.collapsed)!;
    const i = tiles.indexOf(top.tile);
    let fit = 0, total = 0;
    for (let j = i + 1; j < tiles.length && tiles[j]!.depth > top.tile.depth; j++) if (tiles[j]!.kind === "infantry" || tiles[j]!.kind === "vehicle" || tiles[j]!.kind === "hqGroup") { fit += tiles[j]!.fit; total += tiles[j]!.total; }
    expect(top.tile.total).toBe(total);
    expect(top.tile.fit).toBe(fit);
    expect(simHash(sim)).toBe(h);
  });
  it("its labels are in the string table", () => {
    const st = new Strings(loadData(), "en");
    for (const k of ["side.fold", "side.unfold", "side.foldedN", "side.worstBelow"]) expect(st.t(k, { n: 3, callsign: "1. Zug", state: "pinned" })).not.toMatch(/^\[\[/);
  });
});
