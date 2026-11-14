/** M8.3a: on-map mortars — set-up, range band, rounds as counted items, moving packs the tube. */
import { describe, expect, it } from "vitest";
import { allMembers, buildForce, demoBattle } from "@tcs/scenario";
import { countItems, createSim, isMortarUnit, step, submitOrder, supportLeft, teamRounds, tubeOf, type BattleInput, type EntityId, type Sim, type SimEvent } from "@tcs/sim";
import { loadData } from "../src/scenarios";

const data = loadData();

/** The demo squads on a flat 2000 x 400 m map, blue's squad at x 1000, plus a mortar section of `faction` for
 *  `side` at (mx, 200); no off-map allotment. */
function battle(faction: "de" | "ru", template: string, side: "blue" | "red", mx: number, prep?: (i: BattleInput) => void): BattleInput {
  const input = demoBattle(data, { seed: 4, factions: ["de", "ru"], mapWidthM: 2000, mapHeightM: 400, frontM: 600, timeLimitSeconds: 1200 });
  input.rules.support = [];
  const sec = buildForce(data, { faction, template, seed: 9, keyPrefix: `${side}-m`, number: 1 });
  const f = input.forces.find((x) => x.side === side)!;
  f.units.push(sec);
  allMembers(sec).forEach((m, i) => f.placements.push({ personId: m.personId, x: mx + (i % 4) * 3, y: 190 + Math.floor(i / 4) * 20, heading: 0 }));
  prep?.(input);
  return input;
}
const top = (sim: Sim, side: string) => [...sim.state.unit.entries()].find(([id, u]) => u.side === side && u.parent === null && !isMortarUnit(sim.state, id))![0];
const teams = (sim: Sim, side: string) => [...sim.state.unit.entries()].filter(([, u]) => u.side === side && u.mortar !== undefined).map(([id]) => id);
function run(sim: Sim, seconds: number): SimEvent[] {
  const out: SimEvent[] = [];
  for (let k = 0; k < seconds * 60; k++) out.push(...step(sim));
  return out;
}
/** Every round of the side's tubes' kinds held by the side's teams. */
function rounds(sim: Sim, side: string): number {
  let n = 0;
  for (const t of teams(sim, side)) { const tube = tubeOf(sim.ctx, sim.state, t)!; n += teamRounds(sim.state, t, tube.def.he) + teamRounds(sim.state, t, tube.def.smoke); }
  return n;
}

describe("on-map mortars (M8.3a)", () => {
  it("a section sets up on its own after standing still, in its set-up time; a deploy order is accepted", () => {
    const sim = createSim(battle("de", "moerser-gruppe", "blue", 300));
    const ts = teams(sim, "blue");
    expect(ts).toHaveLength(2);
    const def = tubeOf(sim.ctx, sim.state, ts[0]!)!.def;
    const ev = run(sim, def.setupSeconds + 5);
    const setup = ev.filter((e) => e.kind === "mortar.setup");
    const ready = ev.filter((e): e is Extract<SimEvent, { kind: "mortar.ready" }> => e.kind === "mortar.ready");
    expect(setup).toHaveLength(2);
    expect(ready).toHaveLength(2);
    expect((ready[0]!.tick - setup[0]!.tick) / 60).toBeCloseTo(def.setupSeconds, 0);
    for (const t of ts) expect(sim.state.unit.get(t)!.mortar!.state).toBe("ready");
    // Deploy order to the section (already set up): accepted.
    const secId = sim.state.unit.get(ts[0]!)!.parent!;
    submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: secId, kind: "deploy" });
    expect(run(sim, 3).some((e) => e.kind === "radio" && e.key === "radio.ack.deploy")).toBe(true);
    // A deploy order to a rifle squad does not apply.
    submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: top(sim, "blue"), kind: "deploy" });
    expect(run(sim, 2).some((e) => e.kind === "order.rejected" && e.reason === "not-applicable")).toBe(true);
  });

  it("a mission in range is fired from the tubes; rounds are conserved: every round fired left a crew's load", () => {
    const sim = createSim(battle("de", "moerser-gruppe", "blue", 300));
    run(sim, 125);
    const before = rounds(sim, "blue"), heBefore = supportLeft(sim.state, "blue", "he", sim.ctx.catalog);
    expect(heBefore).toBe(24); // 2 tubes x 12 HE
    submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: top(sim, "blue"), kind: "callFire", x: 1500, y: 200, ammo: "he", rounds: 6 });
    const ev = run(sim, 200);
    const fired = ev.filter((e) => e.kind === "mortar.fired");
    const bursts = ev.filter((e) => e.kind === "explosion" && e.ammo === "de-120-he");
    const fs = sim.ctx.catalog.factions["de"]!.fireSupport!;
    expect(fired).toHaveLength(6 + fs.rangingRounds);
    expect(bursts).toHaveLength(fired.length);
    expect(new Set(fired.map((e) => (e as Extract<SimEvent, { kind: "mortar.fired" }>).unit)).size).toBe(2); // both tubes for effect
    expect(rounds(sim, "blue")).toBe(before - fired.length);
    expect(supportLeft(sim.state, "blue", "he", sim.ctx.catalog)).toBe(heBefore - fired.length);
    expect(sim.state.fireMissions).toHaveLength(0);
    // Each round from a tube's position, aimed near the point.
    for (const e of fired) { if (e.kind !== "mortar.fired") continue; expect(Math.abs(e.x - 300)).toBeLessThan(20); expect(Math.hypot(e.tx - 1500, e.ty - 200)).toBeLessThan(200); }
  });

  it("a mission out of the tubes' range is refused (inside the minimum range, beyond the maximum); nothing is fired", () => {
    // Inside the minimum range: the German 120 mm (minimum 500 m), a point 200 m in front of the tubes.
    const sim = createSim(battle("de", "moerser-gruppe", "blue", 300));
    run(sim, 125);
    const before = rounds(sim, "blue");
    submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: top(sim, "blue"), kind: "callFire", x: 500, y: 200, ammo: "he", rounds: 4 });
    const ev = run(sim, 60);
    expect(ev.some((e) => e.kind === "radio" && e.key === "radio.fireOutOfRange")).toBe(true);
    expect(ev.some((e) => e.kind === "mortar.fired")).toBe(false);
    expect(rounds(sim, "blue")).toBe(before);
    // Beyond the maximum: an 82 mm section far back (shrink its reach with the data for the test).
    const input = battle("ru", "minomyotny-vzvod-82", "red", 1900);
    input.catalog.items["ru-2b14-mortar"] = { ...input.catalog.items["ru-2b14-mortar"]!, mortar: { ...input.catalog.items["ru-2b14-mortar"]!.mortar!, maxRangeM: 600 } };
    const sim2 = createSim(input);
    run(sim2, 70);
    submitOrder(sim2, { tick: sim2.state.tick, issuer: "red", target: top(sim2, "red"), kind: "callFire", x: 900, y: 200, ammo: "he", rounds: 2 });
    const ev2 = run(sim2, 30);
    expect(ev2.some((e) => e.kind === "radio" && e.key === "radio.fireOutOfRange")).toBe(true);
  });

  it("a team set up that is ordered to move packs its tube first (its men wait), and must set up again", () => {
    const sim = createSim(battle("ru", "minomyotny-vzvod-82", "red", 1700));
    run(sim, 70);
    const t = teams(sim, "red")[0]!;
    const u = sim.state.unit.get(t)!;
    expect(u.mortar!.state).toBe("ready");
    const tube = tubeOf(sim.ctx, sim.state, t)!;
    const x0 = sim.state.transform.get(tube.carrier)!.x;
    submitOrder(sim, { tick: sim.state.tick, issuer: "red", target: t, kind: "move", waypoints: [{ x: 1600, y: 200, mode: "walk" }] });
    const ev = run(sim, tube.def.packSeconds - 5);
    expect(ev.some((e) => e.kind === "mortar.packed" && e.unit === t)).toBe(true);
    expect(u.mortar!.state).toBe("packed");
    expect(Math.abs(sim.state.transform.get(tube.carrier)!.x - x0)).toBeLessThan(1); // still packing
    run(sim, 40);
    expect(sim.state.transform.get(tube.carrier)!.x).toBeLessThan(x0 - 10); // on his way
  });

  it("the tubes' rounds are counted items of the crews (rule 9); the AI commander leaves the section alone", () => {
    const sim = createSim(battle("ru", "minomyotny-vzvod-82", "red", 1700));
    const t = teams(sim, "red")[0]!;
    const men = sim.state.unit.get(t)!.members;
    const held = men.reduce((n, m) => n + countItems(sim.state.container.get(m)!, "ru-82-he"), 0);
    expect(held).toBe(24);
    expect(isMortarUnit(sim.state, sim.state.unit.get(t)!.parent!)).toBe(true);
    expect(isMortarUnit(sim.state, top(sim, "red") as EntityId)).toBe(false);
  });

  // ---- review fixes (M8.3b commit)

  it("rounds from tubes at different ranges each land after their own flight (not held behind the first in the list)", () => {
    const input = battle("de", "moerser-gruppe", "blue", 300);
    const sim = createSim(input);
    // The second team 1,200 m further back than the first.
    const [, t2] = teams(sim, "blue");
    for (const m of sim.state.unit.get(t2!)!.members) { const t = sim.state.transform.get(m)!; t.x = 40 + (t.x - 300); }
    run(sim, 125);
    submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: top(sim, "blue"), kind: "callFire", x: 1700, y: 200, ammo: "he", rounds: 6 });
    const ev = run(sim, 220);
    const fired = ev.filter((e): e is Extract<SimEvent, { kind: "mortar.fired" }> => e.kind === "mortar.fired");
    const bursts = ev.filter((e) => e.kind === "explosion" && e.ammo === "de-120-he").map((e) => e.tick).sort((a, b) => a - b);
    expect(new Set(fired.map((e) => e.unit)).size).toBe(2);
    const due = fired.map((f) => f.tick + Math.round(f.flightS * 60)).sort((a, b) => a - b);
    expect(bursts).toHaveLength(due.length);
    for (let i = 0; i < due.length; i++) expect(Math.abs(bursts[i]! - due[i]!)).toBeLessThanOrEqual(31);
  });

  it("a screen asked for with more rounds than the crews hold is spread over the whole line with what they have", () => {
    const sim = createSim(battle("de", "moerser-gruppe", "blue", 300));
    run(sim, 125);
    // 8 smoke rounds held (2 tubes x 4); 12 asked: 2 ranging + 6 for effect, end to end.
    submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: top(sim, "blue"), kind: "callFire", x: 1500, y: 60, x2: 1500, y2: 340, ammo: "smoke", rounds: 12 });
    const ev = run(sim, 220);
    const effect = ev.filter((e): e is Extract<SimEvent, { kind: "mortar.fired" }> => e.kind === "mortar.fired").slice(2);
    expect(effect).toHaveLength(6);
    const ys = effect.map((e) => e.ty);
    expect(Math.min(...ys)).toBeLessThan(120);
    expect(Math.max(...ys)).toBeGreaterThan(280);
  });

  it("a fallen gunner's tube passes to a living crewman, who fires it (and is the one heard)", () => {
    const sim = createSim(battle("de", "moerser-gruppe", "blue", 300));
    run(sim, 125);
    const t1 = teams(sim, "blue")[0]!;
    const g0 = tubeOf(sim.ctx, sim.state, t1)!.carrier;
    sim.state.soldier.get(g0)!.physiology.consciousness = 0;
    run(sim, 1);
    const g1 = tubeOf(sim.ctx, sim.state, t1)!.carrier;
    expect(g1).not.toBe(g0);
    submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: top(sim, "blue"), kind: "callFire", x: 1500, y: 200, ammo: "he", rounds: 4 });
    const ev = run(sim, 160);
    const shots = ev.filter((e): e is Extract<SimEvent, { kind: "shot.fired" }> => e.kind === "shot.fired" && e.indirect === true);
    expect(shots.length).toBeGreaterThan(0);
    expect(shots.some((e) => e.shooter === g0)).toBe(false);
  });

  it("a move given to the section packs its teams too (their men wait), and they do not set up while walking", () => {
    const sim = createSim(battle("ru", "minomyotny-vzvod-82", "red", 1700));
    run(sim, 70);
    const [t1] = teams(sim, "red");
    const secId = sim.state.unit.get(t1!)!.parent!;
    submitOrder(sim, { tick: sim.state.tick, issuer: "red", target: secId, kind: "move", waypoints: [{ x: 1200, y: 200, mode: "walk" }] });
    run(sim, 3);
    expect(sim.state.unit.get(t1!)!.mortar!.state).toBe("packed");
    const states = new Set<string>();
    for (let k = 0; k < 60; k++) { run(sim, 1); if (sim.state.unit.get(t1!)!.members.some((m) => (sim.state.mover.get(m)?.waypoints.length ?? 0) > 0)) states.add(sim.state.unit.get(t1!)!.mortar!.state); }
    expect([...states]).toEqual(["packed"]);
  });

  it("each side's section reaches its main objective from where it stands, or the side keeps its off-map rounds", async () => {
    const { getScenario } = await import("../src/scenarios");
    for (const name of ["platoon-mortars", "platoon-ru-mortars"]) for (let seed = 1; seed <= 4; seed++) {
      const input = getScenario(name).build(data, seed, 600);
      const sim = createSim(input);
      const obj = input.rules.objectives![0]!;
      for (const side of ["blue", "red"]) {
        const ts = teams(sim, side);
        expect(ts.length).toBeGreaterThan(0);
        const tube = tubeOf(sim.ctx, sim.state, ts[0]!)!;
        const reaches = Math.hypot(tube.x - obj.x, tube.y - obj.y) >= tube.def.minRangeM;
        const keeps = (input.rules.support ?? []).some((s) => s.side === side);
        expect(reaches || keeps).toBe(true);
      }
    }
  });

});

