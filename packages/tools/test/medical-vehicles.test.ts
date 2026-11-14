/**
 * M10.4b carrying to and into vehicles (roadmap-detail slice 9). A unit getting into its vehicle fetches its wounded
 * who cannot walk from up to `vehicleLoading.fetchM` away (a carrying party to the exit), then two men load each;
 * aboard a casualty lies (unconscious or in shock) or sits; places: passenger seats, a man lying taking
 * `lyingSeats`, or an ambulance's layouts; a dismount with `wounded` carries them out again and lays them down;
 * a save mid-fetch continues identically.
 */
import { describe, expect, it } from "vitest";
import { buildCatalog } from "@tcs/data";
import {
  createSim, DEFAULT_COMMS, flatMap, hashState, healthyPhysiology, loadSim, placesFit, saveSim, step, submitOrder,
  type BattleInput, type Catalog, type EntityId, type Sim, type SimEvent, type SoldierRecord, type Wound,
} from "@tcs/sim";
import { loadData } from "../src/scenarios";

const data = loadData();
const catalog: Catalog = buildCatalog(data, ["de", "ru"]);

const headWound = (): Wound => ({
  id: 1, zone: "head", mechanism: "bullet", severity: 0.2, bleedingLps: 0, compressible: false, airway: false, breathing: false,
  consciousness: true, tickInflicted: 0, treatments: [],
});

interface Man { id: string; x: number; y: number; down?: boolean; aboard?: boolean }
/** A German vehicle of type `type` at (100, 100) facing east (exit to the west), its crew, and squad "sq". */
function battle(type: string, men: Man[]) {
  const rec = (m: Man): SoldierRecord => ({
    personId: m.id, given: "T", family: m.id, rank: "gefreiter", role: "grenadier", skills: { medical: 0.2 }, fatigue: 0, stress: 0,
    wounds: m.down ? [headWound()] : [], load: [{ type: "de-basic-load", count: 3 }],
    status: m.down ? "incapacitated" : "fit", ...(m.down ? { physiology: { ...healthyPhysiology(), consciousness: 0 } } : {}),
  });
  const crew = ["c0", "c1", "c2"].map((id) => rec({ id, x: 0, y: 0 }));
  const input: BattleInput = {
    map: flatMap("veh-test", 400, 200, 4, "grass"), catalog, seed: 3, orders: [],
    rules: { timeLimitSeconds: 36000, commsModel: "simple", comms: { ...DEFAULT_COMMS, orderDelaySeconds: 0, orderDelayJitterSeconds: 0 }, physiologyModel: "none", physiologyParams: {}, objectives: [] },
    forces: [{
      side: "blue", faction: "de",
      units: [
        { key: "crew", callsign: "Crew", echelon: "vehicle", leaderIndex: 0, vehicleId: "v1", subunits: [], members: crew },
        { key: "sq", callsign: "Sq", echelon: "squad", leaderIndex: 0, carrierId: "v1", subunits: [], members: men.map(rec) },
      ],
      placements: men.map((m) => (m.aboard ? { personId: m.id, x: 100, y: 100, heading: 0, mountedIn: "v1" } : { personId: m.id, x: m.x, y: m.y, heading: 0 })),
      vehicles: [{ vehicleId: "v1", type, load: [] }],
      vehiclePlacements: [{ vehicleId: "v1", x: 100, y: 100, heading: 0 }],
    }],
  };
  const sim = createSim(input);
  const id = (p: string): EntityId => [...sim.state.identity.entries()].find(([, i]) => i.personId === p)![0];
  const sq = [...sim.state.unit.entries()].find(([, u]) => u.callsign === "Sq")![0];
  const v = [...sim.state.vehicle.keys()][0]!;
  return { sim, input, id, sq, v };
}
const order = (sim: Sim, target: EntityId, body: Record<string, unknown>) => submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target, ...body } as never);
function run(sim: Sim, seconds: number, until?: (e: SimEvent[]) => boolean): SimEvent[] {
  const all: SimEvent[] = [];
  for (let i = 0; i < seconds * 60; i++) {
    const ev = step(sim);
    all.push(...ev);
    if (until?.(ev)) break;
  }
  return all;
}
const squad = (n: number): Man[] => Array.from({ length: n }, (_, i) => ({ id: `m${i}`, x: 70, y: 94 + i * 4 }));

describe("places aboard (M10.4b)", () => {
  const ctx = { catalog } as never;
  it("a carrier: a man lying takes `lyingSeats` passenger seats (the data: 1, his own seat's room)", () => {
    const puma = catalog.vehicles["de-puma"]!;
    expect(catalog.medical!.vehicleLoading!.lyingSeats).toBe(1);
    expect(placesFit(ctx, puma, 0, 6)).toBe(true);
    expect(placesFit(ctx, puma, 1, 5)).toBe(true);
    expect(placesFit(ctx, puma, 2, 5)).toBe(false);
    expect(placesFit(ctx, puma, 6, 0)).toBe(true);
    // With two seats for a man lying (another data set) a full squad leaves no room for him.
    const two = { catalog: { ...catalog, medical: { ...catalog.medical!, vehicleLoading: { ...catalog.medical!.vehicleLoading!, lyingSeats: 2 } } } } as never;
    expect(placesFit(two, puma, 1, 4)).toBe(true);
    expect(placesFit(two, puma, 1, 5)).toBe(false);
  });
  it("an ambulance: its layouts (Boxer: 3 lying, 7 sitting, or 2 and 3; BMM: up to 6 lying with 2 outside, within its seats)", () => {
    const boxer = catalog.vehicles["de-boxer-san"]!, bmm = catalog.vehicles["ru-bmm"]!;
    expect(placesFit(ctx, boxer, 3, 0)).toBe(true);
    expect(placesFit(ctx, boxer, 3, 1)).toBe(false);
    expect(placesFit(ctx, boxer, 2, 3)).toBe(true);
    expect(placesFit(ctx, boxer, 2, 4)).toBe(false);
    expect(placesFit(ctx, boxer, 0, 7)).toBe(true);
    expect(placesFit(ctx, bmm, 6, 0)).toBe(true);
    expect(placesFit(ctx, bmm, 2, 5)).toBe(true);
    expect(placesFit(ctx, bmm, 3, 4)).toBe(false);
  });
});

describe("carrying to and into vehicles (M10.4b)", () => {
  it("a mount fetches a casualty 60 m away (a carrying party to the exit), loads him lying, then the unit is aboard", () => {
    const b = battle("de-puma", [...squad(4), { id: "w", x: 40, y: 150, down: true }]);
    order(b.sim, b.sq, { kind: "mount" });
    const ev = run(b.sim, 300, (e) => e.some((x) => x.kind === "unit.mounted"));
    expect(ev.some((e) => e.kind === "unit.mounted")).toBe(true);
    const starts = ev.filter((e) => e.kind === "medical.carried" && e.phase === "start" && e.payload === b.id("w"));
    expect(starts.length).toBe(1);
    expect(ev.filter((e) => e.kind === "action.started" && e.action === "loadCasualty").length).toBe(2);
    const w = b.sim.state.soldier.req(b.id("w"));
    expect(w.mount?.vehicle).toBe(b.v);
    expect(w.mount?.lying).toBe(true);
    for (let i = 0; i < 4; i++) expect(b.sim.state.soldier.req(b.id(`m${i}`)).mount?.vehicle).toBe(b.v);
    expect(b.sim.state.carry.size).toBe(0);
  });

  it("capacity: only the casualties there are places for are fetched; the rest stay on the ground", () => {
    // Six passenger seats: five men sitting and one man lying fill them; the second casualty stays.
    const b = battle("de-puma", [...squad(5), { id: "w1", x: 60, y: 140, down: true }, { id: "w2", x: 60, y: 60, down: true }]);
    order(b.sim, b.sq, { kind: "mount" });
    const ev = run(b.sim, 300, (e) => e.some((x) => x.kind === "unit.mounted"));
    expect(ev.some((e) => e.kind === "unit.mounted")).toBe(true);
    expect(b.sim.state.soldier.req(b.id("w1")).mount?.vehicle).toBe(b.v);
    expect(b.sim.state.soldier.req(b.id("w2")).mount).toBeUndefined();
    const v = b.sim.state.vehicle.req(b.v), def = catalog.vehicles["de-puma"]!;
    const aboard = v.seats.filter((o, i) => o !== null && def.seats[i]!.station === "passenger").length;
    expect(aboard).toBe(6);
  });

  it("dismount with `wounded`: the men get out, two carry the casualty out and lay him down behind the exit", () => {
    const b = battle("de-puma", [...squad(3).map((m) => ({ ...m, aboard: true })), { id: "w", x: 0, y: 0, down: true, aboard: true }]);
    b.sim.state.soldier.req(b.id("w")).mount!.lying = true;
    order(b.sim, b.sq, { kind: "dismount", wounded: true });
    const ev = run(b.sim, 120, (e) => e.some((x) => x.kind === "unit.dismounted"));
    expect(ev.some((e) => e.kind === "unit.dismounted")).toBe(true);
    const w = b.sim.state.soldier.req(b.id("w"));
    expect(w.mount).toBeUndefined();
    expect(w.posture).toBe("prone");
    const t = b.sim.state.transform.req(b.id("w"));
    expect(t.x).toBeLessThan(96); // behind the rear exit (the hull faces east)
    expect(ev.filter((e) => e.kind === "action.started" && e.action === "unloadCasualty").length).toBe(2);
    // The unloading comes after every able man is out.
    const lastOut = Math.max(...ev.filter((e) => e.kind === "soldier.dismounted" && e.soldier !== b.id("w")).map((e) => e.tick));
    expect(ev.find((e) => e.kind === "action.started" && e.action === "unloadCasualty")!.tick).toBeGreaterThanOrEqual(lastOut);
  });

  it("a plain dismount leaves the casualty aboard", () => {
    const b = battle("de-puma", [...squad(3).map((m) => ({ ...m, aboard: true })), { id: "w", x: 0, y: 0, down: true, aboard: true }]);
    order(b.sim, b.sq, { kind: "dismount" });
    run(b.sim, 120, (e) => e.some((x) => x.kind === "unit.dismounted"));
    expect(b.sim.state.soldier.req(b.id("w")).mount?.vehicle).toBe(b.v);
  });

  it("an ambulance takes its lying places: two men and three casualties lying -> two loaded (layout 2 lying + 3 sitting)", () => {
    const b = battle("de-boxer-san", [...squad(2), { id: "w1", x: 92, y: 104, down: true }, { id: "w2", x: 92, y: 96, down: true }, { id: "w3", x: 90, y: 100, down: true }]);
    order(b.sim, b.sq, { kind: "mount" });
    run(b.sim, 300, (e) => e.some((x) => x.kind === "unit.mounted"));
    const lying = ["w1", "w2", "w3"].filter((p) => b.sim.state.soldier.req(b.id(p)).mount?.lying === true);
    expect(lying.length).toBe(2);
    expect(b.sim.state.soldier.req(b.id("w3")).mount).toBeUndefined();
  });

  it("a save in the middle of a fetch continues identically", () => {
    const mk = () => battle("de-puma", [...squad(4), { id: "w", x: 40, y: 150, down: true }]);
    const a = mk();
    order(a.sim, a.sq, { kind: "mount" });
    run(a.sim, 25);
    expect(a.sim.state.carry.size).toBe(1);
    const saved = saveSim(a.sim);
    const b2 = loadSim(a.input, saved);
    run(a.sim, 60); run(b2, 60);
    expect(hashState(b2.state)).toBe(hashState(a.sim.state));
  });
});
