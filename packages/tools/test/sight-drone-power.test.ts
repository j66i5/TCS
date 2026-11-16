/** M11.6 stage 3: a flat goggle or thermal sight gives nothing (he is back to eye and weapon sight) until he fits a
 *  spare; a drone still in the air at the end of a battle comes out in its operator's roster record. */
import { describe, expect, it } from "vitest";
import { buildCatalog } from "@tcs/data";
import {
  createSim, DEFAULT_COMMS, deviceLive, environmentAt, flatMap, hasOptics, soldierRecordFromState, stampSlot, step, submitOrder,
  type BattleInput, type Catalog, type Sim, type SimEvent, type SoldierRecord,
} from "@tcs/sim";
import { droneLabBattle } from "../src/labs/drone";
import { poweredDevice } from "../src/labs/spotting";
import { loadData } from "../src/scenarios";

const data = loadData();
const cat: Catalog = buildCatalog(data, ["de", "ru"]);
const SIGHT = "de-thermal-sight";
const BAT = cat.items[SIGHT]!.power!.battery;
const CAP = cat.items[BAT]!.chargeCapacity!;

function man(personId: string, weapon: string, mag: string, extra: SoldierRecord["load"]): SoldierRecord {
  return { personId, given: "Lab", family: personId, rank: "r", role: "rifleman", skills: { marksmanship: 0.5 }, weapon, fatigue: 0, stress: 0, wounds: [], status: "fit", load: [{ type: mag, count: 4, charge: 30 }, ...extra] };
}

/** A man standing still in the open 300 m away on a moonless night: the optic seldom finds him within 30 s, a
 *  thermal sight mostly does (the thermal lab's rows). */
function crops(seed: number, extra: SoldierRecord["load"]): { sim: Sim; obs: number; tgt: number } {
  const map = flatMap("spot", 400, 200, 4);
  const input: BattleInput = {
    map, catalog: cat, seed, orders: [], environment: environmentAt(cat, 0, 0),
    rules: { timeLimitSeconds: 130, commsModel: "simple", comms: { ...DEFAULT_COMMS, orderDelaySeconds: 0, orderDelayJitterSeconds: 0 }, physiologyModel: "none", physiologyParams: {}, objectives: [] },
    forces: [
      { side: "blue", faction: "de", units: [{ key: "o", callsign: "O", echelon: "team", leaderIndex: 0, subunits: [], members: [man("obs", "de-g36", "de-g36-mag", extra)] }], placements: [{ personId: "obs", x: 20, y: 100, heading: 0 }] },
      { side: "red", faction: "ru", units: [{ key: "t", callsign: "T", echelon: "team", leaderIndex: 0, subunits: [], members: [man("tgt", "ru-ak74m", "ru-ak74-mag", [])] }], placements: [{ personId: "tgt", x: 320, y: 100, heading: Math.PI }] },
    ],
  };
  const sim = createSim(input);
  const ids = [...sim.state.identity.entries()];
  const obs = ids.find(([, i]) => i.side === "blue")![0], tgt = ids.find(([, i]) => i.side === "red")![0];
  sim.state.soldier.req(tgt).posture = "standing";
  sim.state.soldier.req(obs).posture = "standing";
  // Red holds fire (the target stays still).
  submitOrder(sim, { tick: 0, issuer: "red", target: sim.state.identity.req(tgt).unit, kind: "rules", fire: "hold" });
  return { sim, obs, tgt };
}
/** Make his sight's battery flat now. */
function flatten(sim: Sim, obs: number): void {
  const slot = sim.state.soldier.req(obs).power!.find((s) => s.device === SIGHT)!;
  stampSlot(slot, 0, slot.on, sim.state.tick);
}
/** Seconds until he spots the target (null: not within `max`), and the events. */
function spotTime(sim: Sim, tgt: number, max: number): { at: number | null; ev: SimEvent[] } {
  const ev: SimEvent[] = [];
  let at: number | null = null;
  for (let k = 0; k < max * 60 && at === null; k++) for (const e of step(sim)) { ev.push(e); if (e.kind === "spotted" && e.target === tgt) at = e.tick / 60; }
  return { at, ev };
}

describe("powered sights (M11.6)", () => {
  const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];
  it("a flat thermal sight at night gives no thermal: spotting is exactly the optic-only case", () => {
    let live = 0, eye = 0;
    for (const seed of SEEDS) {
      const optic = crops(seed, []);
      const flat = crops(seed, [{ type: SIGHT, count: 1 }]); // no battery: an empty slot
      const flatBat = crops(seed, poweredDevice(cat, SIGHT));
      flatten(flatBat.sim, flatBat.obs);
      const sighted = crops(seed, poweredDevice(cat, SIGHT));
      expect(deviceLive(cat, flat.sim.state, flat.obs, SIGHT, 0)).toBe(false);
      expect(deviceLive(cat, flatBat.sim.state, flatBat.obs, SIGHT, 0)).toBe(false);
      expect(deviceLive(cat, sighted.sim.state, sighted.obs, SIGHT, 0)).toBe(true);
      const a = spotTime(optic.sim, optic.tgt, 30).at, b = spotTime(flat.sim, flat.tgt, 30).at, c = spotTime(flatBat.sim, flatBat.tgt, 30).at;
      expect(b).toBe(a);
      expect(c).toBe(a);
      if (a !== null) eye++;
      if (spotTime(sighted.sim, sighted.tgt, 30).at !== null) live++;
    }
    // (The live thermal sight finds him in 30 s far more often than the optic.)
    expect(live).toBeGreaterThanOrEqual(eye + 3);
  });

  it("with a spare he changes the flat battery and the thermal sight works again", () => {
    let found = 0;
    for (const seed of SEEDS) {
      const r = crops(seed, [...poweredDevice(cat, SIGHT), { type: BAT, count: 1, charge: CAP }]);
      flatten(r.sim, r.obs);
      const { at, ev } = spotTime(r.sim, r.tgt, 60);
      const sw = ev.find((e) => e.kind === "power.swapped");
      expect(sw).toBeDefined();
      expect(deviceLive(cat, r.sim.state, r.obs, SIGHT, r.sim.state.tick)).toBe(true);
      if (at !== null) { expect(at * 60).toBeGreaterThanOrEqual(sw!.tick); found++; }
    }
    expect(found).toBeGreaterThanOrEqual(SEEDS.length / 2);
  });

  it("hasOptics: a powered magnifying sensor counts only while live (thermal and night never count)", () => {
    const magCat: Catalog = { ...cat, items: { ...cat.items, [SIGHT]: { ...cat.items[SIGHT]!, sensor: "telescopic" } } };
    const r = crops(1, poweredDevice(cat, SIGHT));
    // (Same state, a catalog where the device magnifies: live, it counts; flat, it does not.)
    const noWeapon = () => { const w = r.sim.state.weapon.get(r.obs); if (w) w.weapon = "ru-ak74m"; };
    noWeapon();
    expect(hasOptics(magCat, r.sim.state, r.obs)).toBe(true);
    flatten(r.sim, r.obs);
    expect(hasOptics(magCat, r.sim.state, r.obs)).toBe(false);
  });
});

describe("drone in the air at the end (M11.6)", () => {
  const BATT = "de-drone-battery";
  const whOf = (load: SoldierRecord["load"]) => load.filter((s) => s.type === BATT).reduce((a, s) => a + s.count * (s.charge ?? 0), 0);
  const nOf = (load: SoldierRecord["load"], t: string) => load.filter((s) => s.type === t).reduce((a, s) => a + s.count, 0);
  function up(): { sim: Sim; op: number; drone: number } {
    const input = droneLabBattle(cat, { name: "t", altM: 100, posture: "standing" }, 1, 4000);
    const sim = createSim(input);
    const op = [...sim.state.identity.entries()].find(([, i]) => i.side === "blue")![0];
    submitOrder(sim, { tick: 0, issuer: "blue", target: op, kind: "drone", op: "fly", x: 400, y: 120, altM: 100 });
    for (let k = 0; k < 120 * 60; k++) step(sim);
    expect(sim.state.drone.size).toBe(1);
    return { sim, op, drone: [...sim.state.drone.keys()][0]! };
  }
  it("its airframe and battery (Wh as left) go into its operator's record", () => {
    const { sim, op, drone } = up();
    const inAir = sim.state.container.req(drone).stacks.find((s) => s.type === BATT)!.charge!;
    expect(inAir).toBeGreaterThan(0);
    const rec = soldierRecordFromState(sim.state, op);
    expect(nOf(rec.load, "de-quadcopter")).toBe(1);
    expect(nOf(rec.load, BATT)).toBe(1);
    expect(whOf(rec.load)).toBe(inAir);
    // The state itself is untouched (roster out only reads).
    expect(sim.state.container.req(drone).stacks.some((s) => s.type === "de-quadcopter")).toBe(true);
  });
  it("with no operator (he was hit) it goes to the first man of its unit still alive", () => {
    const { sim, op, drone } = up();
    sim.state.drone.req(drone).operator = null;
    const rec = soldierRecordFromState(sim.state, op);
    expect(nOf(rec.load, "de-quadcopter")).toBe(1);
  });
});
