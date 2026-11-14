/** M9.6 night drills: the commanders' illumination rounds and the soldiers' fire discipline in the dark. */
import { describe, expect, it } from "vitest";
import { buildCatalog } from "@tcs/data";
import { commanderController } from "@tcs/ai";
import { buildScenario } from "@tcs/scenario";
import {
  createSim, DEFAULT_COMMS, environmentAt, flatMap, runBattle, step, submitOrder, supportLeft, type BattleInput, type Catalog, type Controller, type SoldierRecord,
} from "@tcs/sim";
import { loadData } from "../src/scenarios";

const data = loadData();

/** The two commanders, each order they give noted; the defender's illumination rounds left noted at each look. */
function watched(input: BattleInput, illumLeft: number[]): Controller[] {
  return [commanderController("blue", input), commanderController("red", input)].map((c) => ({
    ...c,
    think: (v: Parameters<Controller["think"]>[0], t: number) => {
      if (c.side === "red" && t % 300 === 0) illumLeft.push(supportLeft(v, "red", "illum", input.catalog));
      return c.think(v, t);
    },
  }));
}

describe("night drills (M9.6)", () => {
  it("the generated battle gives both mortar allotments illumination rounds", () => {
    const input = buildScenario(data, { kind: "platoon-attack", seed: 1, mapKind: "village", factions: ["de", "ru"], attacker: "blue", timeLimitSeconds: 60 });
    for (const s of input.rules.support!) expect(s.illum).toBe(4);
  });

  it("by day the commanders never call an illumination round", () => {
    const input = buildScenario(data, { kind: "platoon-attack", seed: 1, mapKind: "village", factions: ["de", "ru"], attacker: "blue", timeLimitSeconds: 300 });
    const r = runBattle(input, { controllers: watched(input, []) });
    expect(r.orders.filter((o) => o.kind === "callFire" && o.ammo === "illum")).toHaveLength(0);
  });

  it("at night the defender lights up the attackers it knows near its objectives, and its rounds run down", () => {
    const input = buildScenario(data, { kind: "platoon-attack", seed: 1, mapKind: "village", factions: ["de", "ru"], attacker: "blue", timeLimitSeconds: 600 });
    input.environment = environmentAt(input.catalog, 23 * 3600, 0.5);
    const left: number[] = [];
    const r = runBattle(input, { controllers: watched(input, left) });
    const calls = r.orders.filter((o) => o.kind === "callFire" && o.ammo === "illum" && o.issuer === "red");
    expect(calls.length).toBeGreaterThan(0);
    // At most one every `illumEverySeconds` (90 s).
    for (let i = 1; i < calls.length; i++) expect(calls[i]!.tick - calls[i - 1]!.tick).toBeGreaterThanOrEqual(90 * 60);
    expect(left[0]).toBe(4);
    expect(left[left.length - 1]!).toBeLessThan(4);
    // The defence's own rule holds fire at will to the night range.
    expect(r.orders.some((o) => o.issuer === "red" && o.kind === "rules" && o.maxEngageM === 200)).toBe(true);
  });

  /** One German rifleman (G36: the rifle range), fire at will, and one Russian standing still `rangeM` away, in the
   *  open; the observer wears night goggles so that he sees him in the dark too. */
  function lone(catalog: Catalog, rangeM: number, night: boolean): { spotted: boolean; fired: boolean } {
    const man = (personId: string, weapon: string, mag: string): SoldierRecord => ({ personId, given: "Lab", family: personId, rank: "r", role: "rifleman", skills: { marksmanship: 0.5 }, weapon, fatigue: 0, stress: 0, wounds: [], status: "fit", load: [{ type: mag, count: 4, charge: catalog.items[mag]?.chargeCapacity ?? 30 }] });
    const obs = man("obs", "de-g36", "de-g36-mag");
    obs.load.push({ type: "de-nvg", count: 1 });
    const tgt = man("tgt", "ru-ak74m", "ru-ak74-mag");
    const input: BattleInput = {
      map: flatMap("night", rangeM + 80, 200, 4), catalog, seed: 1, orders: [],
      ...(night ? { environment: environmentAt(catalog, 23 * 3600, 1) } : {}),
      rules: { timeLimitSeconds: 120, commsModel: "simple", comms: { ...DEFAULT_COMMS, orderDelaySeconds: 0, orderDelayJitterSeconds: 0 }, physiologyModel: "none", physiologyParams: {}, objectives: [] },
      forces: [
        { side: "blue", faction: "de", units: [{ key: "o", callsign: "O", echelon: "team", leaderIndex: 0, subunits: [], members: [obs] }], placements: [{ personId: "obs", x: 20, y: 100, heading: 0 }] },
        { side: "red", faction: "ru", units: [{ key: "t", callsign: "T", echelon: "team", leaderIndex: 0, subunits: [], members: [tgt] }], placements: [{ personId: "tgt", x: 20 + rangeM, y: 100, heading: Math.PI }] },
      ],
    };
    const sim = createSim(input);
    const ids = [...sim.state.identity.entries()];
    const oid = ids.find(([, i]) => i.side === "blue")![0], tid = ids.find(([, i]) => i.side === "red")![0];
    for (const [id] of ids) sim.state.soldier.req(id).posture = "standing";
    // (The target holds his fire: the observer is never fired on.)
    submitOrder(sim, { tick: 0, issuer: "blue", target: sim.state.identity.req(oid).unit, kind: "rules", fire: "free" });
    submitOrder(sim, { tick: 0, issuer: "red", target: sim.state.identity.req(tid).unit, kind: "rules", fire: "hold" });
    let spotted = false, fired = false;
    for (let k = 0; k < 60 * 60 && !fired; k++) for (const e of step(sim)) {
      if (e.kind === "spotted" && e.target === tid) spotted = true;
      if (e.kind === "shot.fired" && e.shooter === oid) fired = true;
    }
    return { spotted, fired };
  }

  it("a man not fired on holds his own fire at night beyond the night range, but not by day", () => {
    const catalog = buildCatalog(data, ["de", "ru"]);
    const day = lone(catalog, 250, false);
    expect(day.spotted).toBe(true);
    expect(day.fired).toBe(true);
    const night = lone(catalog, 250, true);
    expect(night.spotted).toBe(true);
    expect(night.fired).toBe(false);
    // Closer than the night range he fires.
    const close = lone(catalog, 120, true);
    expect(close.spotted).toBe(true);
    expect(close.fired).toBe(true);
  });
});
