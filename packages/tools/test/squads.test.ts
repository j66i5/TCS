/**
 * M2.5: the two real squads as data (owner decision 2026-11-11: research defaults, he corrects them afterwards),
 * their weapons and itemised loads.
 */
import { describe, expect, it } from "vitest";
import { buildCatalog } from "@tcs/data";
import { demoBattle } from "@tcs/scenario";
import { containerMassKg, createSim, loadKg, step, submitOrder, type SimEvent } from "@tcs/sim";
import { fireAtBoard, SKILLS } from "../src/labs/range";
import { loadData } from "../src/scenarios";

const data = loadData();

describe("squads and kit (M2.5)", () => {
  const input = demoBattle(data, { seed: 1, factions: ["de", "ru"], timeLimitSeconds: 600 });
  const sim = createSim(input);
  const side = (s: string) => [...sim.state.identity.entries()].filter(([, i]) => i.side === s).map(([id, i]) => ({ id, role: i.role, weapon: sim.state.weapon.get(id)?.weapon ?? null }));

  it("the demo starts with the Puma dismount squad and the BMP motor-rifle squad, six men each, as chosen", () => {
    expect(side("blue").map((m) => `${m.role}:${m.weapon}`)).toEqual([
      "truppfuehrer:de-g36", "mg-gunner:de-mg5", "at-gunner:de-g36", "marksman:de-g28", "grenadier:de-g36", "panzergrenadier:de-g36",
    ]);
    expect(side("red").map((m) => `${m.role}:${m.weapon}`)).toEqual([
      "squad-leader:ru-ak74m", "mg-gunner:ru-pkp", "at-gunner:ru-ak74m", "assistant-at-gunner:ru-ak74m", "senior-rifleman:ru-ak74m", "rifleman-gl:ru-ak74m",
    ]);
    for (const [, u] of sim.state.unit.entries()) expect(u.leader).not.toBeNull();
  });

  it("every man can feed his weapon from his own load; loads are itemised and plausible (22-45 kg)", () => {
    const lines: string[] = [];
    for (const s of ["blue", "red"]) for (const m of side(s)) {
      const w = sim.state.weapon.req(m.id);
      const wd = input.catalog.weapons[w.weapon]!;
      expect(w.magazine).not.toBeNull();
      expect(sim.state.container.req(m.id).stacks.some((st) => st.type === wd.feed.magazine && st.count > 0)).toBe(true);
      const kg = loadKg(sim.ctx, sim.state, m.id);
      lines.push(`${s} ${m.role}: ${kg.toFixed(1)} kg (${sim.state.container.req(m.id).stacks.map((st) => `${st.count}x ${st.type}`).join(", ")})`);
      expect(kg).toBeGreaterThan(22);
      expect(kg).toBeLessThan(45);
      expect(containerMassKg(input.catalog, sim.state.container.req(m.id))).toBeGreaterThan(15);
    }
    console.log(lines.join("\n"));
  });

  it("ammunition in the squad follows the cited norms: 480 MG rounds (DE), 600 (RU), 180 rifle rounds per Russian rifleman", () => {
    const rounds = (s: string, belt: string) => side(s).reduce((n, m) => {
      const w = sim.state.weapon.req(m.id);
      const inGun = w.magazine?.item === belt ? w.magazine.rounds : 0;
      return n + inGun + sim.state.container.req(m.id).stacks.filter((st) => st.type === belt).reduce((k, st) => k + st.count * (st.charge ?? 0), 0);
    }, 0);
    expect(rounds("blue", "de-mg5-belt")).toBe(480);
    expect(rounds("red", "ru-pkp-belt")).toBe(600);
    const leader = side("red")[0]!;
    expect(rounds("red", "ru-ak74-mag") / 1).toBeGreaterThanOrEqual(180 * 4);
    expect((sim.state.weapon.req(leader.id).magazine?.rounds ?? 0) + sim.state.container.req(leader.id).stacks.filter((st) => st.type === "ru-ak74-mag").reduce((k, st) => k + st.count * (st.charge ?? 0), 0)).toBe(180);
  });

  it("the machine gun fires 5-round bursts at 300 m with a tracer every fifth round; every round comes off the belt", () => {
    const s2 = createSim(demoBattle(data, { seed: 2, factions: ["de", "ru"], timeLimitSeconds: 600 }));
    const gunner = [...s2.state.identity.entries()].find(([, i]) => i.side === "blue" && i.role === "mg-gunner")![0];
    const t = s2.state.transform.req(gunner);
    const before = (s2.state.weapon.req(gunner).magazine?.rounds ?? 0) + s2.state.container.req(gunner).stacks.filter((st) => st.type === "de-mg5-belt").reduce((k, st) => k + st.count * (st.charge ?? 0), 0);
    submitOrder(s2, { tick: 0, issuer: "blue", target: gunner, kind: "posture", posture: "prone" });
    for (let i = 0; i < 240; i++) step(s2);
    submitOrder(s2, { tick: s2.state.tick, issuer: "blue", target: gunner, kind: "fire", x: Math.min(t.x + 300, s2.ctx.map.widthM - 5), y: t.y });
    const shots: Extract<SimEvent, { kind: "shot.fired" }>[] = [];
    for (let i = 0; i < 60 * 25; i++) for (const e of step(s2)) if (e.kind === "shot.fired" && e.shooter === gunner) shots.push(e);
    expect(shots.length).toBeGreaterThanOrEqual(30);
    // Within a burst the shots are a cyclic interval apart (720/min = 5 ticks); between bursts about 2.5 s.
    const gaps = shots.slice(1).map((e, i) => e.tick - shots[i]!.tick);
    const bursts = Math.floor(shots.length / 5);
    expect(gaps.filter((g) => g <= 6).length).toBeGreaterThanOrEqual(bursts * 4); // (the last burst may be cut by the clock)
    expect(Math.min(...gaps.filter((g) => g > 6))).toBeGreaterThan(100);
    const tracers = shots.filter((e) => e.ammo === "de-762-dm21").length;
    expect(Math.abs(tracers - shots.length / 5)).toBeLessThanOrEqual(1);
    const after = (s2.state.weapon.req(gunner).magazine?.rounds ?? 0) + s2.state.container.req(gunner).stacks.filter((st) => st.type === "de-mg5-belt").reduce((k, st) => k + st.count * (st.charge ?? 0), 0);
    expect(before - after).toBe(shots.length);
  });

  it("the marksman rifle with its telescopic sight hits clearly better at 500 m than the G36; a machine-gun burst is less accurate per round", () => {
    const cat = buildCatalog(data, ["de"]);
    const at = (weapon: string) => fireAtBoard(cat, { weapon, rangeM: 500, posture: "prone", skill: SKILLS.regular }).hitRate;
    const g36 = at("de-g36"), g28 = at("de-g28"), mg5 = at("de-mg5");
    console.log(`500 m, regular, prone: G36 ${(g36 * 100).toFixed(0)} %, G28 ${(g28 * 100).toFixed(0)} %, MG5 per round ${(mg5 * 100).toFixed(0)} %`);
    expect(g28).toBeGreaterThan(g36 + 0.05);
    expect(mg5).toBeLessThan(g36);
    expect(mg5).toBeGreaterThan(0.03);
  });
});
