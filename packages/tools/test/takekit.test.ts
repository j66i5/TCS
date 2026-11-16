/**
 * M11.2 "Take enemy kit" with the real data: a German rifleman takes a dead Russian's AK-74M and its magazines (his G36
 * goes into his load), fires them, and the ledger stays exact; an order with nothing that fits is refused on the radio.
 */
import { describe, expect, it } from "vitest";
import { buildCatalog } from "@tcs/data";
import {
  checkConservation, consumedFromEvents, createSim, DEFAULT_COMMS, emptyConsumption, flatMap, ledgerOf, step, submitOrder, TICK_HZ, tracerMap,
  type BattleInput, type Catalog, type EntityId, type Sim, type SimEvent, type SoldierRecord,
} from "@tcs/sim";
import { loadData } from "../src/scenarios";

const data = loadData(true);
const catalog: Catalog = buildCatalog(data, ["de", "ru"]);

function man(personId: string, weapon: string, load: SoldierRecord["load"]): SoldierRecord {
  return { personId, given: "T", family: personId, rank: "r", role: "rifleman", skills: { marksmanship: 0.6 }, weapon, fatigue: 0, stress: 0, wounds: [], status: "fit", load };
}

/** A German rifleman at (20, 100), a Russian (`redWeapon`) beside him to be killed, another Russian 120 m off. */
function setup(redWeapon: string, redLoad: SoldierRecord["load"]): { sim: Sim; de: EntityId; dead: EntityId; foe: EntityId } {
  const input: BattleInput = {
    map: flatMap("k", 300, 200, 4), catalog, seed: 1, orders: [],
    rules: { timeLimitSeconds: 600, commsModel: "simple", comms: { ...DEFAULT_COMMS, orderDelaySeconds: 0, orderDelayJitterSeconds: 0 }, physiologyModel: "none", physiologyParams: {}, objectives: [] },
    forces: [
      { side: "blue", faction: "de", units: [{ key: "d", callsign: "D", echelon: "team", leaderIndex: 0, subunits: [], members: [man("de", "de-g36", [{ type: "de-g36-mag", count: 2, charge: 30 }])] }], placements: [{ personId: "de", x: 20, y: 100, heading: 0 }] },
      { side: "red", faction: "ru", units: [{ key: "r", callsign: "R", echelon: "team", leaderIndex: 0, subunits: [], members: [man("dead", redWeapon, redLoad), man("foe", "ru-ak74m", [{ type: "ru-ak74-mag", count: 2, charge: 30 }])] }],
        placements: [{ personId: "dead", x: 30, y: 100, heading: 0 }, { personId: "foe", x: 140, y: 100, heading: Math.PI }] },
    ],
  };
  const sim = createSim(input);
  const ids = [...sim.state.identity.entries()];
  const de = ids.find(([, i]) => i.side === "blue")![0];
  const [dead, foe] = ids.filter(([, i]) => i.side === "red").map(([id]) => id);
  const s = sim.state.soldier.req(dead!);
  s.physiology.alive = false; s.casualty = "killed"; s.physiology.consciousness = 0;
  sim.state.unit.req(sim.state.identity.req(foe!).unit).fireRule = "hold";
  sim.state.unit.req(sim.state.identity.req(de).unit).fireRule = "hold";
  return { sim, de, dead: dead!, foe: foe! };
}

function run(sim: Sim, seconds: number, on: (e: SimEvent[]) => void): void {
  for (let i = 0; i < seconds * TICK_HZ; i++) on(step(sim));
}

describe("takeKit with the real data (M11.2)", () => {
  it("a German rifleman takes a Russian rifle and 3 magazines, fires them; ledger exact", () => {
    const { sim, de, dead, foe } = setup("ru-ak74m", [{ type: "ru-ak74-mag", count: 4, charge: 30 }]);
    const start = ledgerOf(catalog, sim.state);
    const used = emptyConsumption(), tracer = tracerMap(catalog);
    const all: SimEvent[] = [];
    const on = (ev: SimEvent[]) => { consumedFromEvents(used, ev, tracer); all.push(...ev); };
    submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: sim.state.identity.req(de).unit, kind: "takeKit", source: dead, player: true });
    run(sim, 30, on);
    expect(all.find((e) => e.kind === "weapon.swapped")).toMatchObject({ soldier: de, from: dead, weapon: "ru-ak74m", put: "de-g36-carried" });
    const c = sim.state.container.req(de);
    expect(c.stacks.filter((s) => s.type === "ru-ak74-mag").reduce((n, s) => n + s.count, 0)).toBe(3);
    expect(c.stacks.find((s) => s.type === "de-g36-carried")?.count).toBe(1);
    expect(sim.state.weapon.req(de).weapon).toBe("ru-ak74m");
    // He fires them at the other Russian.
    sim.state.unit.req(sim.state.identity.req(de).unit).fireRule = "free";
    submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: de, kind: "fire", x: 140, y: 100, heightM: 1, contact: foe, player: true });
    run(sim, 30, on);
    const shots = all.filter((e) => e.kind === "shot.fired" && e.shooter === de);
    expect(shots.length).toBeGreaterThan(0);
    expect(shots.every((e) => e.kind === "shot.fired" && e.weapon === "ru-ak74m")).toBe(true);
    expect(checkConservation(start, ledgerOf(catalog, sim.state), used)).toEqual({});
    // Nothing appeared or vanished: every item is where it was or in his load.
    const end = ledgerOf(catalog, sim.state);
    for (const k of ["de-g36-carried", "ru-ak74m-carried", "ru-ak74-mag", "de-g36-mag"]) expect(end.items[k] ?? 0, k).toBe(start.items[k] ?? 0);
  });

  it("refused with a radio reason when nothing fits (a machine gun's belts)", () => {
    const { sim, de, dead } = setup("ru-pkp", [{ type: catalog.weapons["ru-pkp"]!.feed.magazine, count: 2, charge: 100 }]);
    const all: SimEvent[] = [];
    submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: sim.state.identity.req(de).unit, kind: "takeKit", source: dead, player: true });
    run(sim, 10, (ev) => all.push(...ev));
    expect(all.some((e) => e.kind === "radio" && e.key === "radio.kitNothing")).toBe(true);
    expect(all.some((e) => e.kind === "items.taken" || e.kind === "weapon.swapped")).toBe(false);
  });
});
