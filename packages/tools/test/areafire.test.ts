/**
 * Area fire (balance pass 5, owner 2026-11-20): crews keep firing at the places they last knew enemy men, the
 * places' weight fading; the air-burst settings of the Puma's 30 mm (KETF) and the Leopard's DM11; the rules that
 * hold it (fire rule, ammunition rule, own men); a programmed fuze saved in flight.
 */
import { describe, expect, it } from "vitest";
import { coneReachM, createSim, crewSuspects, hashState, loadSim, saveSim, step, submitOrder, type BattleInput, type EntityId, type Sim, type SimEvent } from "@tcs/sim";
import { areaFireLab, areaFireLabMarkdown, areaFireLayout } from "../src/labs/areafire";
import { loadData } from "../src/scenarios";

const data = loadData();

function setup(input: BattleInput, fire: "free" | "return" | "hold", ammo?: "conserve" | "normal" | "max"): { sim: Sim; vid: EntityId; crew: EntityId; red: EntityId } {
  const sim = createSim(input);
  const [vid, v] = [...sim.state.vehicle.entries()][0]!;
  const red = [...sim.state.unit.entries()].find(([, u]) => u.side === "red")![0];
  submitOrder(sim, { tick: 0, issuer: "blue", target: v.unit!, kind: "rules", fire, ...(ammo ? { ammo } : {}) });
  submitOrder(sim, { tick: 0, issuer: "red", target: red, kind: "rules", fire: "hold" });
  return { sim, vid, crew: v.unit!, red };
}

/** Run, with the men lying down in the crops after 8 s; the area-fire events of the hull. */
function lose(s: { sim: Sim; vid: EntityId; red: EntityId }, seconds: number): Extract<SimEvent, { kind: "vehicle.areaFire" }>[] {
  const out: Extract<SimEvent, { kind: "vehicle.areaFire" }>[] = [];
  for (let k = 0; k < seconds * 60; k++) {
    if (k === 8 * 60) submitOrder(s.sim, { tick: s.sim.state.tick, issuer: "red", target: s.red, kind: "posture", posture: "prone" });
    for (const e of step(s.sim)) if (e.kind === "vehicle.areaFire" && e.vehicle === s.vid) out.push(e);
  }
  return out;
}

describe("area fire", () => {
  it("a crew that loses men in crops keeps firing at the place, then stops as its weight fades", () => {
    const s = setup(areaFireLayout(data, "ru", "t90m-ekipazh", "de", 600, 1, true, 260), "free");
    const ev = lose(s, 260);
    expect(ev.length).toBeGreaterThan(2);
    // every burst lands within the place's circle round where the men were (x 700, y 292-307)
    for (const e of ev) expect(Math.hypot(e.x - 700, e.y - 300)).toBeLessThan(60);
    // it stops by itself: nothing in the last minute (contacts at most 120 s old)
    expect(ev[ev.length - 1]!.tick / 60).toBeLessThan(200);
    // the place it fired at first weighs less by the end (its men unseen since)
    const crew = s.sim.state.unit.req(s.sim.state.vehicle.req(s.vid).unit!);
    for (const p of crewSuspects(s.sim.ctx, s.sim.state, crew)) if (Math.hypot(p.x - ev[0]!.x, p.y - ev[0]!.y) < 40) expect(p.w).toBeLessThan(ev[0]!.weight);
  });

  it("never under fire 'return' or with ammunition 'conserve'", () => {
    expect(lose(setup(areaFireLayout(data, "ru", "t90m-ekipazh", "de", 600, 1, true, 200), "return"), 200).length).toBe(0);
    expect(lose(setup(areaFireLayout(data, "ru", "t90m-ekipazh", "de", 600, 1, true, 200), "free", "conserve"), 200).length).toBe(0);
  });

  it("never with an own man near the place (40 m off its middle)", () => {
    const ev = lose(setup(areaFireLayout(data, "ru", "t90m-ekipazh", "de", 600, 1, true, 200, { x: 700, y: 345 }), "free"), 200);
    expect(ev.length).toBe(0);
  });

  it("KETF: the Puma's air burst goes off short of the point, above the ground, and its pellets fly on", () => {
    const input = areaFireLayout(data, "de", "puma-besatzung", "ru", 800, 1, false, 60);
    const s = setup(input, "hold");
    submitOrder(s.sim, { tick: 0, issuer: "blue", target: s.crew, kind: "fire", x: 900, y: 300, nature: "he", fuse: "airburst" });
    const owners = new Set(s.sim.state.unit.req(s.crew).members);
    const bursts: { x: number; z: number }[] = [];
    let saved = false;
    for (let k = 0; k < 30 * 60 && bursts.length < 6; k++) {
      for (const e of step(s.sim)) if (e.kind === "explosion" && owners.has(e.owner) && e.ammo === "de-30x173-he") bursts.push({ x: e.x, z: e.z });
      // a round in flight with its fuze set: saved and loaded, the same state
      if (!saved && [...s.sim.state.projectiles.burstTick.subarray(0, s.sim.state.projectiles.count)].some((t) => t > 0)) {
        saved = true;
        const b = loadSim(input, JSON.parse(JSON.stringify(saveSim(s.sim))));
        expect(hashState(b.state)).toBe(hashState(s.sim.state));
        for (let j = 0; j < 120; j++) { step(s.sim); step(b); }
        expect(hashState(b.state)).toBe(hashState(s.sim.state));
      }
    }
    expect(saved).toBe(true);
    expect(bursts.length).toBeGreaterThan(2);
    const air = bursts.filter((b) => b.x < 895 && b.x > 860);
    expect(air.length).toBeGreaterThan(bursts.length / 2);
  });

  it("a hull without an air-burst round refuses the air-burst order", () => {
    const s = setup(areaFireLayout(data, "ru", "bmp2-ekipazh", "de", 800, 1, false, 30), "hold");
    submitOrder(s.sim, { tick: 0, issuer: "blue", target: s.crew, kind: "fire", x: 900, y: 300, nature: "he", fuse: "airburst" });
    let refused = false;
    for (let k = 0; k < 10 * 60; k++) for (const e of step(s.sim)) if (e.kind === "radio" && e.key === "radio.noAirburst") refused = true;
    expect(refused).toBe(true);
  });

  it("the lab compares impact and air burst per hull", () => {
    const rows = areaFireLab(data, { seeds: 1, ranges: [800], seconds: 30, parts: ["fuse"] });
    console.log(areaFireLabMarkdown(rows));
    const puma = rows.filter((r) => r.vehicle === "de-puma");
    expect(puma.length).toBe(2);
    expect(puma.every((r) => r.rounds > 10)).toBe(true);
    // the BMP-2's 3UOF8 has no air-burst setting (impact only)
    expect(rows.find((r) => r.vehicle === "ru-bmp2" && r.case.startsWith("air burst"))?.extra).toBe("no air-burst setting");
  });

  it("review fix MH5: an air burst holds for an own man in the pellet cone 100 m past the point; the impact setting does not", () => {
    const reach = coneReachM(createSim(areaFireLayout(data, "de", "puma-besatzung", "ru", 400, 1, false, 30)).ctx, "de-30x173-he", 1100);
    expect(reach).toBeGreaterThan(100);
    expect(reach).toBeLessThan(600);
    const shots = (fuse: "airburst" | "impact"): number => {
      const s = setup(areaFireLayout(data, "de", "puma-besatzung", "ru", 400, 1, false, 30, { x: 600, y: 304 }), "hold");
      submitOrder(s.sim, { tick: 0, issuer: "blue", target: s.crew, kind: "fire", x: 500, y: 300, nature: "he", fuse });
      let n = 0;
      for (let k = 0; k < 20 * 60; k++) for (const e of step(s.sim)) if (e.kind === "shot.fired" && e.vehicle === s.vid) n++;
      return n;
    };
    expect(shots("airburst")).toBe(0);
    expect(shots("impact")).toBeGreaterThan(0);
  });
});
