/** The "map-feel" step (owner choices S5, S7, S8, S13, S14): lines, pins, keys, cycling. */
import { describe, expect, it } from "vitest";
import { buildScenario } from "@tcs/scenario";
import { createSim, step, submitOrder, type EntityId } from "@tcs/sim";
import { loadData } from "../../tools/src/scenarios";
import { ageLabel, cycleUnit, easeToward, HELP_SECTIONS, intentLines, keyAction, LastSeenBook, linesShown, panVector, EMPTY_AFTER_S, type IntentLine, type KnownLike } from "../src/mapfeel";
import { PIN_AFTER_S } from "@tcs/render";
import { Strings } from "@tcs/data";

const NO = { shift: false, ctrl: false, alt: false, meta: false };

describe("S7: one line per own unit on the move, fire missions", () => {
  const data = loadData();
  const input = buildScenario(data, { kind: "platoon-attack", seed: 2, mapKind: "farmland", factions: ["de", "ru"], attacker: "blue", timeLimitSeconds: 600 });
  it("each moving squad has one line to its leader's destination; a fire mission has a line to its target", () => {
    const sim = createSim(input);
    const squads = [...sim.state.unit.entries()].filter(([, u]) => u.side === "blue" && u.parent !== null && u.vehicle === undefined).map(([id]) => id);
    expect(squads.length).toBeGreaterThanOrEqual(2);
    const at = (uid: EntityId) => sim.state.transform.req(sim.state.unit.get(uid)!.leader!);
    for (const uid of squads.slice(0, 2)) { const p = at(uid); submitOrder(sim, { tick: 0, issuer: "blue", target: uid, kind: "move", waypoints: [{ x: p.x + 80, y: p.y, mode: "walk" }] }); }
    const lead = squads[0]!, lp = at(lead);
    submitOrder(sim, { tick: 0, issuer: "blue", target: lead, kind: "callFire", x: lp.x + 300, y: lp.y, ammo: "he", rounds: 2 });
    // While the call is on its way, its line is there already.
    expect(intentLines(sim.state, "blue", null).filter((l) => l.kind === "fire")).toHaveLength(1);
    for (let k = 0; k < 60 * 8; k++) step(sim);
    const lines = intentLines(sim.state, "blue", lead);
    const moves = lines.filter((l) => l.kind === "move");
    expect(moves).toHaveLength(2); // one per unit, never one per man
    const sel = moves.filter((l) => l.selected);
    expect(sel).toHaveLength(1);
    expect(sel[0]!.route!.length).toBeGreaterThan(0);
    expect(moves.find((l) => !l.selected)!.route).toBeUndefined();
    const fire = lines.filter((l) => l.kind === "fire");
    expect(fire.length).toBeGreaterThanOrEqual(1);
    expect(Math.abs(fire[0]!.x1 - (lp.x + 300))).toBeLessThan(5); // (the mission's point, as the sim keeps it)
    // The other side's moves and missions are never shown.
    expect(intentLines(sim.state, "red", null).filter((l) => l.kind === "fire")).toHaveLength(0);
  });
  it("zoomed out to symbols, many faint lines are dropped (the selected one and fire missions stay)", () => {
    const l = (selected: boolean, kind: "move" | "fire" = "move"): IntentLine => ({ x0: 0, y0: 0, x1: 1, y1: 1, kind, selected });
    const many = [l(true), ...Array.from({ length: 7 }, () => l(false)), l(false, "fire")];
    expect(linesShown(many, false)).toHaveLength(9);
    expect(linesShown(many, true).map((x) => `${x.kind}${x.selected}`)).toEqual(["movetrue", "firefalse"]);
    expect(linesShown(many.slice(0, 4), true)).toHaveLength(4);
  });
});

describe("S8: last seen pins", () => {
  const k = (target: number, ageS: number, kind: KnownLike["kind"] = "seen"): KnownLike => ({ target, x: target * 10, y: 5, kind, ageS });
  it("a contact unseen PIN_AFTER_S becomes a pin, stays after it is forgotten, goes when seen again", () => {
    const b = new LastSeenBook();
    b.update([k(1, 0)], 100);
    expect(b.pins()).toHaveLength(0);
    b.update([k(1, PIN_AFTER_S + 1)], 100 + 7 * 60);
    expect(b.pins().map((p) => p.target)).toEqual([1]);
    expect(b.pins()[0]!.seenTick).toBe(100);
    b.update([], 100 + 200 * 60); // the simulation forgot him: the pin stays
    expect(b.pins()).toHaveLength(1);
    b.update([k(1, 0.5)], 100 + 201 * 60); // seen again
    expect(b.pins()).toHaveLength(0);
  });
  it("a contact that vanishes while in sight (seen falling, boarding) leaves no pin; a heard one never pins", () => {
    const b = new LastSeenBook();
    b.update([k(1, 1), k(2, 30, "heard")], 50);
    b.update([], 60);
    expect(b.pins()).toHaveLength(0);
  });
  it("a spot in clear view for EMPTY_AFTER_S is seen empty: the pin goes and does not come back from the old sighting", () => {
    const b = new LastSeenBook();
    b.update([k(1, 10), k(2, 10)], 1000);
    expect(b.pins()).toHaveLength(2);
    let t = 1000;
    for (let s = 0; s < EMPTY_AFTER_S + 2; s++) { t += 60; b.update([k(1, 10 + s), k(2, 10 + s)], t); b.look(t, (p) => p.target === 1); }
    expect(b.pins().map((p) => p.target)).toEqual([2]);
    b.update([k(1, 30), k(2, 30)], t + 60);
    expect(b.pins().map((p) => p.target)).toEqual([2]);
    // A newer sighting that is lost again: a new pin.
    b.update([k(1, 0)], t + 120); b.update([k(1, 8)], t + 120 + 8 * 60);
    expect(b.pins().map((p) => p.target)).toContain(1);
  });
  it("a contact seen a long time and then lost is watched EMPTY_AFTER_S from the loss, not from the first sighting", () => {
    const b = new LastSeenBook();
    for (let s = 0; s <= 60; s++) b.update([k(1, 0)], s * 60);
    const lost = 60 * 60 + 7 * 60;
    b.update([k(1, 7)], lost);
    b.look(lost + 60, () => true);
    expect(b.pins()).toHaveLength(1);
    let t = lost + 60;
    for (let s = 0; s < EMPTY_AFTER_S + 1; s++) { t += 60; b.look(t, () => true); }
    expect(b.pins()).toHaveLength(0);
  });
  it("out of view resets the count", () => {
    const b = new LastSeenBook();
    b.update([k(1, 10)], 0);
    let t = 0, view = true;
    for (let s = 0; s < 20; s++) { t += 60; view = s % 4 !== 3; b.look(t, () => view); }
    expect(b.pins()).toHaveLength(1);
  });
  it("age labels: seconds in 5 s steps, then minutes", () => {
    expect(ageLabel(7)).toEqual({ key: "map.lastSeen.s", params: { n: 5 } });
    expect(ageLabel(47)).toEqual({ key: "map.lastSeen.s", params: { n: 45 } });
    expect(ageLabel(185)).toEqual({ key: "map.lastSeen.min", params: { n: 3 } });
  });
});

describe("S5 / S13: keys, cycling, follow", () => {
  it("maps the keys", () => {
    expect(keyAction("Space", " ", NO)).toEqual({ kind: "pause" });
    expect(keyAction("Digit3", "3", NO)).toEqual({ kind: "speed", index: 2 });
    expect(keyAction("Escape", "Escape", NO)).toEqual({ kind: "cancel" });
    expect(keyAction("Tab", "Tab", { ...NO, shift: true })).toEqual({ kind: "cycle", dir: -1 });
    expect(keyAction("KeyF", "f", NO)).toEqual({ kind: "follow" });
    expect(keyAction("KeyT", "t", NO)).toEqual({ kind: "order", order: "fire" });
    expect(keyAction("Slash", "?", { ...NO, shift: true })).toEqual({ kind: "help" });
    expect(keyAction("KeyC", "c", NO)).toEqual({ kind: "contours" });
    // The browser's own shortcuts stay its own; nothing quits.
    expect(keyAction("KeyF", "f", { ...NO, ctrl: true })).toBeNull();
    expect(keyAction("KeyQ", "q", NO)).toBeNull();
  });
  it("pan keys add up; opposite keys cancel", () => {
    expect(panVector(["KeyW", "KeyD"])).toEqual({ x: 1, y: -1 });
    expect(panVector(["ArrowLeft", "ArrowRight"])).toEqual({ x: 0, y: 0 });
  });
  it("Tab cycles round the units; with none selected it starts at the first (Shift: the last)", () => {
    expect(cycleUnit([4, 7, 9], null, 1)).toBe(4);
    expect(cycleUnit([4, 7, 9], null, -1)).toBe(9);
    expect(cycleUnit([4, 7, 9], 9, 1)).toBe(4);
    expect(cycleUnit([4, 7, 9], 4, -1)).toBe(9);
    expect(cycleUnit([], 4, 1)).toBeNull();
  });
  it("the follow camera eases toward the unit", () => {
    const p = easeToward({ x: 0, y: 0 }, { x: 10, y: 0 });
    expect(p.x).toBeGreaterThan(0); expect(p.x).toBeLessThan(10);
  });
  it("the help card lists every key the keyboard knows", () => {
    const rows = HELP_SECTIONS.flatMap((s) => s.rows.map((r) => r[0]));
    const st = new Strings(loadData(), "en");
    for (const sec of HELP_SECTIONS) for (const key of [sec.title, ...sec.rows.flat()]) expect(st.t(key)).not.toMatch(/^\[\[/);
    for (const key of ["map.lastSeen.s", "map.lastSeen.min", "follow.badge", "follow.stop", "app.contours", "app.contoursHint", "help.title", "help.close", "app.pauseKey", "app.speedKey"]) expect(st.t(key)).not.toMatch(/^\[\[/);
    for (const k of ["help.k.space", "help.k.speed", "help.k.pan", "help.k.esc", "help.k.tab", "help.k.f", "help.k.m", "help.k.t", "help.k.h", "help.k.b", "help.k.g", "help.k.c", "help.k.help"]) expect(rows).toContain(k);
  });
});
