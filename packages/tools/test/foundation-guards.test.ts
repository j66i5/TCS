/**
 * Foundation guards added at the start of M10 (ARCHITECTURE §17, roadmap-detail slice 2):
 * - SPEC 9.5: contact sharing passes only through the comms model (a model that delivers nothing means no man ever
 *   learns of an enemy from a comrade);
 * - SPEC 9.7: the environment is battle state and survives a save and load in the middle of a battle.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createSim, loadSim, saveSim, simHash, simpleComms, step, type CommsModel, type Sim } from "@tcs/sim";
import { getScenario, loadData } from "../src/scenarios";

const data = loadData();
const sc = getScenario("shootout");

/** Run the shoot-out scenario's squads (no controllers, own fire rules) and count what reached the men. */
function run(sim: Sim, seconds: number): { reported: number; queued: number } {
  let reported = 0, queued = 0;
  const end = sim.state.tick + seconds * 60;
  while (sim.state.tick < end) {
    step(sim);
    queued = Math.max(queued, sim.state.contactReports.length);
    if (sim.state.tick % 60 === 0) {
      for (const [, s] of sim.state.soldier.entries()) for (const c of s.contacts) if (c.kind === "reported") reported++;
    }
  }
  return { reported, queued };
}

describe("contact sharing goes only through the comms model (SPEC 9.5)", () => {
  it("with the foundations model men hear of enemies from comrades; with a mute model nobody ever does", () => {
    const input = sc.build(data, 4, 120);
    const normal = run(createSim(input), 120);
    expect(normal.reported, "the shoot-out shares contacts at all").toBeGreaterThan(0);

    const mute: CommsModel = { ...simpleComms, id: "mute", contactShareDelayTicks: () => null };
    const sim = createSim(sc.build(data, 4, 120));
    (sim.ctx as { comms: CommsModel }).comms = mute;
    const silent = run(sim, 120);
    expect(silent.queued).toBe(0);
    expect(silent.reported).toBe(0);
  });

  it("only systems/contacts.ts queues reports or makes a 'reported' contact", () => {
    const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
    const files: string[] = [];
    const walk = (d: string) => {
      for (const n of readdirSync(d)) {
        const p = join(d, n);
        if (statSync(p).isDirectory()) walk(p);
        else if (n.endsWith(".ts")) files.push(p);
      }
    };
    for (const pkg of ["sim", "ai"]) walk(join(ROOT, "packages", pkg, "src"));
    const bad: string[] = [];
    for (const f of files) {
      const rel = relative(ROOT, f).replace(/\\/g, "/");
      if (rel === "packages/sim/src/systems/contacts.ts") continue;
      const text = readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
      if (/contactReports\s*\.\s*(push|unshift|splice)|contactReports\s*=(?!=)/.test(text)) bad.push(`${rel}: writes contactReports`);
      if (/kind\s*:\s*["']reported["']/.test(text)) bad.push(`${rel}: makes a reported contact`);
    }
    // state.ts creates and restores the (empty or saved) queue: allowed.
    expect(bad.filter((b) => !b.startsWith("packages/sim/src/state.ts"))).toEqual([]);
  });
});

describe("the environment is battle state (SPEC 9.7)", () => {
  it("wind, rain, fog, temperature and the clock survive a save and load mid-battle and the battle continues identically", () => {
    const make = () => {
      const input = sc.build(data, 6, 90);
      input.environment = { timeOfDaySeconds: 15 * 3600 + 17, light: 0.8, windX: 3.5, windY: -2.25, rain: 0.4, visibilityM: 1800, temperatureC: 4 };
      return input;
    };
    const full = createSim(make());
    while (full.state.tick < 80 * 60) step(full);

    const input = make();
    const sim = createSim(input);
    while (sim.state.tick < 35 * 60) step(sim);
    const before = { ...sim.state.environment };
    expect(before.timeOfDaySeconds).toBeGreaterThan(15 * 3600 + 17); // the clock runs
    const loaded = loadSim(input, JSON.parse(JSON.stringify(saveSim(sim))));
    expect(loaded.state.environment).toEqual(before);
    expect(simHash(loaded)).toBe(simHash(sim));
    while (loaded.state.tick < 80 * 60) step(loaded);
    expect(loaded.state.environment).toEqual(full.state.environment);
    expect(simHash(loaded)).toBe(simHash(full));
  });
});
