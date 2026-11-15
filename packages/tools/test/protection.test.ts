/**
 * Recognition and respect (M10.7a, roadmap-detail slice 15): the protection lab matches the data; a man who has
 * recognised an enemy medic does not fire at him (an unmarked man in his place is fired at); the player's order to
 * fire at a recognised protected target is refused with a radio note (owner Q-7); a recognised marked ambulance is
 * never engaged while an unmarked carrier in its place is; recognition is a man's own and is not passed on.
 */
import { describe, expect, it } from "vitest";
import { buildCatalog } from "@tcs/data";
import {
  createSim, DEFAULT_COMMS, flatMap, onlyProtectedAt, protectionNow, PROT_CARRYING, PROT_MARKED, refusesFireAt, spared, step, submitOrder, TICK_HZ,
  type BattleInput, type Catalog, type Contact, type EntityId, type Order, type Sim, type SimEvent, type SoldierRecord,
} from "@tcs/sim";
import { duel } from "../src/labs/gunnery";
import { protectionLab, protectionLabMarkdown } from "../src/labs/protection";
import { loadData } from "../src/scenarios";

const data = loadData(true);
const catalog: Catalog = buildCatalog(data, ["de", "ru"]);

function run(sim: Sim, seconds: number, on: (e: SimEvent) => void = () => undefined): void {
  for (let i = 0; i < seconds * TICK_HZ; i++) for (const e of step(sim)) on(e);
}
function man(personId: string, armband: boolean): SoldierRecord {
  const r: SoldierRecord = { personId, given: "T", family: personId, rank: "r", role: "rifleman", skills: { marksmanship: 0.6 }, weapon: "de-g36", fatigue: 0, stress: 0, wounds: [], status: "fit", load: [{ type: "de-g36-mag", count: 6, charge: 30 }] };
  if (armband) r.load.push({ type: "de-armband", count: 1 });
  return r;
}
/** A blue rifleman (G36, 3x optic: recognises an armband to 150 m by day) and a red man `rangeM` away. */
function pair(rangeM: number, armband: boolean, seed = 1): { sim: Sim; obs: EntityId; tgt: EntityId } {
  const input: BattleInput = {
    map: flatMap("p", rangeM + 100, 200, 4), catalog, seed, orders: [],
    rules: { timeLimitSeconds: 600, commsModel: "simple", comms: { ...DEFAULT_COMMS, orderDelaySeconds: 0, orderDelayJitterSeconds: 0 }, physiologyModel: "none", physiologyParams: {}, objectives: [] },
    forces: [
      { side: "blue", faction: "de", units: [{ key: "o", callsign: "O", echelon: "team", leaderIndex: 0, subunits: [], members: [man("obs", false)] }], placements: [{ personId: "obs", x: 20, y: 100, heading: 0 }] },
      { side: "red", faction: "de", units: [{ key: "t", callsign: "T", echelon: "team", leaderIndex: 0, subunits: [], members: [man("tgt", armband)] }], placements: [{ personId: "tgt", x: 20 + rangeM, y: 100, heading: Math.PI }] },
    ],
  };
  const sim = createSim(input);
  const ids = [...sim.state.identity.entries()];
  const obs = ids.find(([, i]) => i.side === "blue")![0], tgt = ids.find(([, i]) => i.side === "red")![0];
  for (const [id] of ids) sim.state.soldier.req(id).posture = "standing";
  // The red man never fires (he would lose his protection), and is not frightened.
  sim.state.unit.req(sim.state.identity.req(tgt).unit).fireRule = "hold";
  sim.state.unit.req(sim.state.identity.req(obs).unit).fireRule = "free";
  return { sim, obs, tgt };
}

describe("recognition and respect (M10.7a)", () => {
  it("protection lab: recognised within the data's range, by day, at night and in smoke, by eye and with optics", () => {
    const lab = protectionLab(data, 2, 40);
    console.log(protectionLabMarkdown(lab));
    for (const r of lab.sim) {
      expect(r.seen).toBe(r.runs);
      if (r.rangeM <= r.predictedM) expect(r.recognised, `${r.light} ${r.optics} ${r.rangeM}`).toBe(r.runs);
      else expect(r.recognised, `${r.light} ${r.optics} ${r.rangeM}`).toBe(0);
    }
    // The order of things: optics beyond the eye, night and smoke shorter than day.
    const R = (k: string, l: string) => lab.ranges.find((x) => x.kind === k && x.light === l)!;
    for (const k of ["armband (medic)", "marked ambulance", "carrying party", "at the Verwundetennest"]) {
      expect(R(k, "day").optics).toBeGreaterThan(R(k, "day").eye);
      expect(R(k, "night").eye).toBeLessThan(R(k, "day").eye);
      expect(R(k, "smoke").eye).toBeLessThan(R(k, "day").eye);
    }
  });

  it("a man who has recognised an enemy medic holds his fire; the same man without the armband is fired at", () => {
    let shotsAtMedic = 0, shotsAtMan = 0;
    {
      const { sim, obs, tgt } = pair(100, true);
      run(sim, 90, (e) => { if (e.kind === "shot.fired" && e.shooter === obs) shotsAtMedic++; });
      const c = sim.state.soldier.req(obs).contacts.find((k) => k.target === tgt)!;
      expect(c.marked).toBe(true);
      expect(protectionNow(catalog, sim.state, tgt) & PROT_MARKED).toBe(PROT_MARKED);
    }
    {
      const { sim, obs } = pair(100, false);
      run(sim, 90, (e) => { if (e.kind === "shot.fired" && e.shooter === obs) shotsAtMan++; });
    }
    expect(shotsAtMedic).toBe(0);
    expect(shotsAtMan).toBeGreaterThan(0);
  });

  it("beyond the recognition range the medic is taken for a soldier (an honest mistake): fired at", () => {
    const { sim, obs, tgt } = pair(250, true);
    let shots = 0;
    run(sim, 120, (e) => { if (e.kind === "shot.fired" && e.shooter === obs) shots++; });
    expect(sim.state.soldier.req(obs).contacts.find((k) => k.target === tgt)?.marked).toBeUndefined();
    expect(shots).toBeGreaterThan(0);
  });

  it("owner Q-7: the player's order to fire at a recognised protected target is refused, with a radio note", () => {
    const { sim, obs, tgt } = pair(100, true);
    sim.state.unit.req(sim.state.identity.req(obs).unit).fireRule = "hold";
    run(sim, 30);
    expect(sim.state.soldier.req(obs).contacts.find((k) => k.target === tgt)?.marked).toBe(true);
    const unit = sim.state.identity.req(obs).unit;
    const radio: string[] = [];
    let shots = 0;
    submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: unit, kind: "fire", x: 120, y: 100, contact: tgt } as Order);
    // At the point alone (no contact named): refused too, nobody else is known there.
    submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: unit, kind: "fire", x: 122, y: 101 } as Order);
    run(sim, 20, (e) => { if (e.kind === "radio" && e.side === "blue") radio.push(e.key); if (e.kind === "shot.fired" && e.shooter === obs) shots++; });
    expect(radio.filter((k) => k === "radio.refuseProtected").length).toBe(2);
    expect(shots).toBe(0);
    expect(sim.state.fire.has(obs)).toBe(false);
  });

  it("review fix: a grenade order at a recognised medic is refused too, and a refused order changes nothing", () => {
    const { sim, obs, tgt } = pair(22, true);
    const unit = sim.state.identity.req(obs).unit;
    sim.state.unit.req(unit).fireRule = "hold";
    sim.state.container.req(obs).stacks.push({ type: "de-dm51", count: 2 });
    run(sim, 20);
    expect(sim.state.soldier.req(obs).contacts.find((k) => k.target === tgt)?.marked).toBe(true);
    // A drill under way (a withdrawal far to the rear) must survive the refused orders.
    const drill = { kind: "withdraw" as const, x: 2, y: 100, groups: [[obs]], mover: 0, phaseTick: sim.state.tick + 1e6, final: false };
    sim.state.unit.req(unit).drill = drill;
    const radio: string[] = [];
    const tp = sim.state.transform.req(tgt);
    submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: unit, kind: "grenade", x: tp.x, y: tp.y } as Order);
    submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: obs, kind: "fire", x: tp.x, y: tp.y, contact: tgt } as Order);
    let thrown = 0;
    for (let i = 0; i < 3; i++) for (const e of step(sim)) {
      if (e.kind === "radio" && e.side === "blue") radio.push(e.key);
      if (e.kind === "action.started" && e.actor === obs && e.action === "grenade") thrown++;
    }
    expect(radio.filter((k) => k === "radio.refuseProtected").length).toBe(2);
    expect(thrown).toBe(0);
    expect(sim.state.action.get(obs)?.kind).not.toBe("grenade");
    expect(sim.state.unit.req(unit).drill?.kind).toBe("withdraw");
  });

  it("review fix: bearers are a carrying party only once they bear the casualty, not while walking up to him", () => {
    const { sim, obs, tgt } = pair(100, false);
    const payload = obs; // (any entity: the carry store is keyed by the payload)
    sim.state.soldier.req(tgt).carrying = payload;
    sim.state.carry.set(payload, { phase: "gather" } as never);
    expect(protectionNow(catalog, sim.state, tgt) & PROT_CARRYING).toBe(0);
    sim.state.carry.set(payload, { phase: "move" } as never);
    expect(protectionNow(catalog, sim.state, tgt) & PROT_CARRYING).toBe(PROT_CARRYING);
  });

  it("an area target with a fighting enemy beside the medic is not refused (only protected people there is)", () => {
    const at = (x: number, y: number, flags: Partial<Contact>): Contact => ({ target: Math.round(x * 10 + y), x, y, errM: 1, kind: "seen", tick: 0, reportedTick: 0, ...flags });
    expect(onlyProtectedAt([at(100, 100, { marked: true })], 102, 100, 10)).toBe(true);
    expect(onlyProtectedAt([at(100, 100, { marked: true }), at(104, 100, {})], 102, 100, 10)).toBe(false);
    expect(onlyProtectedAt([at(100, 100, { down: true })], 102, 100, 10)).toBe(false); // nobody protected there: no refusal
    expect(onlyProtectedAt([at(100, 100, { atPoint: true }), at(101, 100, { down: true })], 100, 100, 10)).toBe(true);
    expect(spared(at(1, 1, { carrying: true }))).toBe(true);
    // refusesFireAt reads the men's own contacts.
    const { sim, obs } = pair(100, true);
    expect(refusesFireAt(sim.state, [obs], 120, 100, undefined, 10)).toBe(false); // nothing known yet
  });

  it("recognition is a man's own: a comrade's report does not carry the flag", () => {
    const { sim, obs, tgt } = pair(100, true);
    run(sim, 60);
    expect(sim.state.soldier.req(obs).contacts.find((k) => k.target === tgt)?.marked).toBe(true);
    for (const r of sim.state.contactReports) { expect(r.contact.marked).toBeUndefined(); expect(r.contact.carrying).toBeUndefined(); expect(r.contact.atPoint).toBeUndefined(); }
  });

  it("a recognised marked ambulance (BMM) is never engaged; an unmarked BMP-2 in its place is", () => {
    const lay = { blue: { x: 400, y: 600, heading: 0 }, red: { x: 900, y: 600, heading: Math.PI / 2 } };
    const fired = (crew: string): { shots: number; marked: boolean | undefined } => {
      const input = duel(data, ["de", "ru"], lay, undefined, 2400, ["puma-besatzung", crew]);
      const sim = createSim(input);
      const [rvid] = [...sim.state.vehicle.entries()].find(([, v]) => v.side === "red")!;
      const [bvid, bv] = [...sim.state.vehicle.entries()].find(([, v]) => v.side === "blue")!;
      // Red holds its fire (an ambulance has nothing to fire anyway); blue is free to fire.
      for (const [uid, u] of sim.state.unit.entries()) if (u.parent === null) submitOrder(sim, { tick: 0, issuer: u.side, target: uid, kind: "rules", fire: u.side === "red" ? "hold" : "free" } as Order);
      let shots = 0;
      run(sim, 90, (e) => { if (e.kind === "shot.fired" && e.vehicle === bvid) shots++; });
      const crewMen = sim.state.unit.req(bv.unit!).members;
      const marked = crewMen.map((m) => sim.state.soldier.req(m).contacts.find((k) => k.target === rvid)?.marked).find((x) => x !== undefined);
      return { shots, marked };
    };
    const amb = fired("bmm-ekipazh"), bmp = fired("bmp2-ekipazh");
    expect(amb.marked).toBe(true);
    expect(amb.shots).toBe(0);
    expect(bmp.marked).toBeUndefined();
    expect(bmp.shots).toBeGreaterThan(0);
  });
});
