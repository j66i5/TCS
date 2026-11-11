/** M2.3: hits on bodies, armour, wound records, the bleeding clock, casualties (SPEC 6.4, rule 10). */
import { describe, expect, it } from "vitest";
import {
  createSim, EventSink, hashState, healthyPhysiology, launchProjectile, loadSim, refreshStatus, resolveBodyHit, saveSim, secondsToTicks, simplePhysiology,
  soldierRecordFromState, step, submitOrder, unitsFromState, type Sim, type SimEvent, type Wound,
} from "../src/index";
import { armedInput, rec, testCatalog } from "./helpers";

const unitOf = (sim: Sim, side: string) => [...sim.state.unit.entries()].find(([, u]) => u.side === side)!;
function run(sim: Sim, seconds: number): SimEvent[] {
  const out: SimEvent[] = [];
  for (let i = 0; i < secondsToTicks(seconds); i++) out.push(...step(sim));
  return out;
}
/** Strike a man directly (no flight): the wound rules alone. */
function strike(sim: Sim, target: number, group: string, capacity = 10, energy = 1300, frontal = true): SimEvent[] {
  const sink = new EventSink();
  resolveBodyHit(sim.ctx, sim.state, sink, target, group, false, frontal, capacity, energy, "ball", 0);
  return sink.events;
}
const physio = (input = armedInput()) => { input.rules.physiologyModel = "simple"; return input; };
const P = testCatalog.wounds.physiology as unknown as Record<string, number>;

describe("armour", () => {
  it("a plate stops a rifle round: no wound through it, but he is knocked down and bruised (owner decision)", () => {
    const input = physio();
    for (const m of input.forces[1]!.units[0]!.members) m.load.push({ type: "vest", count: 1 });
    const sim = createSim(input);
    const man = unitOf(sim, "red")[1].members[0]!;
    const ev = strike(sim, man, "chest");
    expect(ev.find((e) => e.kind === "hit")).toMatchObject({ armour: "stopped", zone: "chest" });
    const s = sim.state.soldier.req(man);
    expect(s.wounds).toHaveLength(1);
    expect(s.wounds[0]).toMatchObject({ mechanism: "blunt", bleedingLps: 0 });
    run(sim, 0.5); // falling takes a moment
    expect(s.posture).toBe("prone");
    expect(s.stunnedUntilTick).toBeGreaterThan(sim.state.tick);
    expect(s.physiology.alive).toBe(true);
    expect(s.casualty).toBe("none");
  });

  it("where the armour does not cover, or the round is stronger than it, the round goes through", () => {
    const input = physio();
    for (const m of input.forces[1]!.units[0]!.members) m.load.push({ type: "vest", count: 1 });
    const sim = createSim(input);
    const [a, b] = unitOf(sim, "red")[1].members as [number, number];
    expect(strike(sim, a, "leg").find((e) => e.kind === "hit")).toMatchObject({ armour: "none" });
    expect(strike(sim, b, "chest", 40).find((e) => e.kind === "hit")).toMatchObject({ armour: "penetrated" });
    expect(sim.state.soldier.req(b).wounds[0]!.mechanism).toBe("bullet");
  });
});

describe("wounds are records and casualties stay in the world", () => {
  it("a wound is recorded with zone, mechanism, severity and bleeding; the man is impaired but carries on", () => {
    const sim = createSim(physio());
    const man = unitOf(sim, "red")[1].members[0]!;
    const ev = strike(sim, man, "leg");
    const s = sim.state.soldier.req(man);
    expect(s.wounds[0]).toMatchObject({ zone: "legR", mechanism: "bullet" });
    expect(s.wounds[0]!.severity).toBeGreaterThan(0);
    expect(s.wounds[0]!.bleedingLps).toBeGreaterThan(0);
    expect(ev.some((e) => e.kind === "wound")).toBe(true);
    expect(s.impair.move).toBeLessThan(1);
    expect(s.physiology.alive).toBe(true);
  });

  it("head hits by rifle rounds are mostly fatal; the dead man remains an entity and his record says killed", () => {
    let killed = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const sim = createSim(physio(armedInput(seed)));
      const man = unitOf(sim, "red")[1].members[0]!;
      const ev = strike(sim, man, "head");
      const s = sim.state.soldier.req(man);
      if (!s.physiology.alive) {
        killed++;
        expect(ev.find((e) => e.kind === "casualty")).toMatchObject({ status: "killed", soldier: man });
        expect(sim.state.transform.has(man)).toBe(true);
        expect(soldierRecordFromState(sim.state, man).status).toBe("killed");
        expect(soldierRecordFromState(sim.state, man).wounds).toHaveLength(1);
      }
    }
    expect(killed).toBeGreaterThan(24);
    expect(killed).toBeLessThan(40);
  });

  it("a casualty drops what he was doing; the next man leads and reports him down; the unit still obeys", () => {
    const sim = createSim(physio());
    const [uid, unit] = unitOf(sim, "blue");
    const leader = unit.leader!;
    submitOrder(sim, { tick: 0, issuer: "blue", target: uid, kind: "move", waypoints: [{ x: 60, y: 15, mode: "walk" }] });
    run(sim, 5);
    const s = sim.state.soldier.req(leader);
    s.physiology.alive = true;
    let ev: SimEvent[] = [];
    for (let k = 0; k < 50 && s.physiology.alive; k++) ev = strike(sim, leader, "head");
    expect(s.casualty).toBe("killed");
    expect(ev.find((e) => e.kind === "radio")).toMatchObject({ key: "radio.manDown" });
    expect(unit.leader).not.toBe(leader);
    expect(unit.leader).not.toBeNull();
    const at = { ...sim.state.transform.req(leader) };
    submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: uid, kind: "move", waypoints: [{ x: 100, y: 15, mode: "walk" }] });
    const later = run(sim, 60);
    expect(later.some((e) => e.kind === "unit.arrived")).toBe(true);
    expect(sim.state.transform.req(leader)).toMatchObject({ x: at.x, y: at.y }); // the dead man stays where he fell
    expect(Math.abs(sim.state.transform.req(unit.leader!).x - 100)).toBeLessThan(15);
  });

  it("a man with a bad leg wound cannot walk: he crawls", () => {
    const sim = createSim(physio());
    const man = unitOf(sim, "blue")[1].members[1]!;
    const s = sim.state.soldier.req(man);
    s.wounds.push({ id: 0, zone: "legL", mechanism: "bullet", severity: 0.7, bleedingLps: 0, compressible: true, airway: false, breathing: false, consciousness: false, tickInflicted: 0, treatments: [] });
    refreshStatus(sim.ctx, sim.state, new EventSink(), man);
    expect(s.impair.canWalk).toBe(false);
    submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: man, kind: "move", waypoints: [{ x: 60, y: 15, mode: "walk" }] });
    const x0 = sim.state.transform.req(man).x;
    run(sim, 20);
    expect(s.posture).toBe("prone");
    const moved = sim.state.transform.req(man).x - x0;
    expect(moved).toBeGreaterThan(0.2);
    expect(moved).toBeLessThan(8); // walking would be ~27 m
  });
});

describe("the bleeding clock (simple physiology)", () => {
  const wound = (bleedingLps: number, extra: Partial<Wound> = {}): Wound => ({
    id: 1, zone: "legL", mechanism: "bullet", severity: 0.5, bleedingLps, compressible: true, airway: false, breathing: false, consciousness: false, tickInflicted: 0, treatments: [], ...extra,
  });
  const after = (w: Wound, seconds: number) => {
    const p = healthyPhysiology();
    let out = -1, dead = -1;
    for (let t = 0; t < seconds; t += 0.5) {
      simplePhysiology.step(p, [w], 0.5, P);
      if (out < 0 && p.consciousness < 0.5) out = t;
      if (dead < 0 && !p.alive) dead = t;
    }
    return { p, out, dead };
  };

  it("a major artery (about 1 litre a minute) kills in minutes: unconscious after ~2, dead after ~3 (owner: realistic clock)", () => {
    const r = after(wound(0.0167), 600);
    expect(r.out).toBeGreaterThan(80);
    expect(r.out).toBeLessThan(150);
    expect(r.dead).toBeGreaterThan(120);
    expect(r.dead).toBeLessThan(200);
  });

  it("a moderate bleed takes tens of minutes; a small one clots and the man lives", () => {
    const slow = after(wound(0.0025), 3600);
    expect(slow.dead).toBeGreaterThan(10 * 60);
    expect(slow.dead).toBeLessThan(25 * 60);
    const small = after(wound(0.0015), 3600);
    expect(small.p.alive).toBe(true);
    expect(small.p.bloodVolumeL).toBeGreaterThan(4.4);
  });

  it("an untreated breathing wound kills without much bleeding, more slowly", () => {
    const r = after(wound(0, { zone: "chest", breathing: true }), 3600);
    expect(r.dead).toBeGreaterThan(4 * 60);
    expect(r.dead).toBeLessThan(15 * 60);
  });

  it("in the battle a bleeding man fades on the clock: conscious, then a casualty, then dead", () => {
    const sim = createSim(physio());
    const man = unitOf(sim, "red")[1].members[0]!;
    const s = sim.state.soldier.req(man);
    s.wounds.push(wound(0.0167));
    const ev = run(sim, 240);
    const cas = ev.filter((e) => e.kind === "casualty" && e.soldier === man);
    expect(cas.map((e) => (e.kind === "casualty" ? e.status : ""))).toEqual(["incapacitated", "killed"]);
    expect(s.wounds).toHaveLength(1);
  });
});

describe("bullets strike bodies", () => {
  it("a round fired at a standing man's chest hits him; one fired past him does not; the firer is never hit by his own round", () => {
    const sim = createSim(physio());
    const shooter = unitOf(sim, "blue")[1].members[0]!, target = unitOf(sim, "red")[1].members[0]!;
    const a = sim.state.transform.req(shooter), b = sim.state.transform.req(target);
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    // Flat fire from chest height; the drop over 180 m is ~0.2 m, so aim that much high.
    launchProjectile(sim.ctx, sim.state, "ball", a.x, a.y, 1.5, (900 * (b.x - a.x)) / d, (900 * (b.y - a.y)) / d, 900 * (0.22 / d), shooter);
    launchProjectile(sim.ctx, sim.state, "ball", a.x, a.y + 2, 1.3, 900, 0, 0, shooter); // 2 m to the side
    const ev = run(sim, 2);
    const hits = ev.filter((e) => e.kind === "hit");
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ target, owner: shooter });
    expect(["chest", "abdomen", "armL", "armR", "neck"]).toContain(hits[0]!.kind === "hit" ? hits[0]!.zone : "");
    expect(sim.state.soldier.req(shooter).wounds).toHaveLength(0);
  });

  it("a prone man is a much smaller target than a standing one", () => {
    const count = (posture: "standing" | "prone") => {
      const sim = createSim(physio());
      const target = unitOf(sim, "red")[1].members[0]!;
      sim.state.soldier.req(target).posture = posture;
      const b = sim.state.transform.req(target);
      // A fan of rounds 150 m out, spread over 2 m x 2 m around him.
      for (let i = 0; i < 21; i++) for (let j = 0; j < 21; j++) {
        launchProjectile(sim.ctx, sim.state, "ball", b.x - 150, b.y - 1 + i * 0.1, 0.05 + j * 0.1 + 0.15, 900, 0, 0, 0);
      }
      return run(sim, 1).filter((e) => e.kind === "hit").length;
    };
    const standing = count("standing"), prone = count("prone");
    expect(standing).toBeGreaterThan(40);
    expect(prone).toBeGreaterThan(0);
    expect(prone).toBeLessThan(standing / 3);
  });

  it("friendly fire: a round does not know whose side a man is on", () => {
    const sim = createSim(physio());
    const [, unit] = unitOf(sim, "blue");
    const [m0, m1] = unit.members as [number, number];
    const a = sim.state.transform.req(m0), b = sim.state.transform.req(m1);
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    launchProjectile(sim.ctx, sim.state, "ball", a.x, a.y, 1.3, (900 * (b.x - a.x)) / d, (900 * (b.y - a.y)) / d, 0, m0);
    const hit = run(sim, 1).find((e) => e.kind === "hit");
    expect(hit).toMatchObject({ target: m1, owner: m0 });
  });

  it("a fire order at an enemy team wounds it, and the fight replays identically after a mid-battle save", () => {
    const sim = createSim(physio(armedInput(3)));
    const [uid] = unitOf(sim, "blue");
    const red = unitOf(sim, "red")[1].members;
    const t = sim.state.transform.req(red[0]!);
    submitOrder(sim, { tick: 0, issuer: "blue", target: uid, kind: "fire", x: t.x, y: t.y, heightM: 1.2 });
    const ev = run(sim, 40);
    expect(ev.filter((e) => e.kind === "hit").length).toBeGreaterThan(0);
    expect(red.some((m) => sim.state.soldier.req(m).wounds.length > 0)).toBe(true);
    const copy = loadSim(physio(armedInput(3)), JSON.parse(JSON.stringify(saveSim(sim))));
    expect(hashState(copy.state)).toBe(hashState(sim.state));
    run(sim, 30); run(copy, 30);
    expect(hashState(copy.state)).toBe(hashState(sim.state));
  });
});

/** Kill a man outright (test helper: the status change goes through the real casualty handling). */
function kill(sim: Sim, id: number): SimEvent[] {
  const sink = new EventSink();
  const s = sim.state.soldier.req(id);
  s.physiology.alive = false; s.physiology.consciousness = 0;
  refreshStatus(sim.ctx, sim.state, sink, id);
  return sink.events;
}

describe("fixes from the independent review", () => {
  it("when the last man firing falls, the unit's fire ends and is reported; a wiped-out unit never 'arrives'", () => {
    const sim = createSim(physio());
    const [uid, unit] = unitOf(sim, "blue");
    submitOrder(sim, { tick: 0, issuer: "blue", target: uid, kind: "fire", x: 150, y: 15 });
    run(sim, 3);
    expect(unit.firing).toBe(true);
    const ev = unit.members.flatMap((m) => kill(sim, m));
    expect(unit.firing).toBe(false);
    expect(ev.filter((e) => e.kind === "fire.ceased")).toMatchObject([{ reason: "unable", unit: uid }]);

    const sim2 = createSim(physio());
    const [uid2, unit2] = unitOf(sim2, "blue");
    submitOrder(sim2, { tick: 0, issuer: "blue", target: uid2, kind: "move", waypoints: [{ x: 150, y: 15, mode: "walk" }] });
    run(sim2, 5);
    for (const m of unit2.members) kill(sim2, m);
    const later = run(sim2, 5);
    expect(later.some((e) => e.kind === "unit.arrived")).toBe(false);
    expect(unit2.moving).toBe(false);
    // An order to a unit with nobody left is answered by nobody and leaves no flags set.
    submitOrder(sim2, { tick: sim2.state.tick, issuer: "blue", target: uid2, kind: "halt" });
    expect(run(sim2, 3).some((e) => e.kind === "radio")).toBe(false);
  });

  it("a casualty's record carries his condition into the next battle: the dead stay dead", () => {
    const sim = createSim(physio());
    const [, unit] = unitOf(sim, "blue");
    const [dead, bled] = unit.members as [number, number];
    strike(sim, dead, "leg");
    kill(sim, dead);
    const b = sim.state.soldier.req(bled);
    b.wounds.push({ id: 0, zone: "legL", mechanism: "bullet", severity: 0.5, bleedingLps: 0.004, compressible: true, airway: false, breathing: false, consciousness: false, tickInflicted: 0, treatments: [] });
    run(sim, 120);
    const blood = b.physiology.bloodVolumeL;
    expect(blood).toBeLessThan(4.7);
    const input = physio();
    input.forces[0]!.units = unitsFromState(sim.state, "blue", input.forces[0]!.units);
    expect(input.forces[0]!.units[0]!.members[0]!.status).toBe("killed");
    const next = createSim(input);
    const [, u2] = unitOf(next, "blue");
    const d2 = next.state.soldier.req(u2.members[0]!), b2 = next.state.soldier.req(u2.members[1]!);
    expect(d2.physiology.alive).toBe(false);
    expect(d2.casualty).toBe("killed");
    expect(b2.physiology.bloodVolumeL).toBeCloseTo(blood, 6);
    expect(run(next, 5).filter((e) => e.kind === "casualty")).toHaveLength(0);
    expect(d2.physiology.alive).toBe(false);
  });

  it("left and right: a round into the arm on his left side is recorded as the left arm", () => {
    const sideOf = (dy: number) => {
      const sim = createSim(physio());
      const target = unitOf(sim, "red")[1].members[0]!;
      const b = sim.state.transform.req(target); // heading 0: he faces east (+x); y grows south, so north is his left
      launchProjectile(sim.ctx, sim.state, "ball", b.x - 30, b.y + dy, 1.3, 900, 0, 0, 0); // from behind him
      const hit = run(sim, 1).find((e) => e.kind === "hit");
      return hit && hit.kind === "hit" ? hit.zone : "";
    };
    expect(sideOf(-0.21)).toBe("armL");
    expect(sideOf(0.21)).toBe("armR");
  });

  it("in a squad with sub-teams the next able man of a sub-team takes over and reports", () => {
    const input = physio();
    const sub = { key: "a/1", callsign: "a/1", echelon: "team", leaderIndex: 0, members: [rec("a1.0"), rec("a1.1")], subunits: [] };
    input.forces[0]!.units = [{ key: "a", callsign: "a", echelon: "squad", leaderIndex: 0, members: [rec("a.0")], subunits: [sub] }];
    input.forces[0]!.placements = ["a.0", "a1.0", "a1.1"].map((personId, i) => ({ personId, x: 10, y: 10 + i * 5, heading: 0 }));
    const sim = createSim(input);
    const [, squad] = [...sim.state.unit.entries()].find(([, u]) => u.side === "blue" && u.parent === null)!;
    const leader = squad.leader!;
    const ev = kill(sim, leader);
    expect(squad.leader).not.toBeNull();
    expect(squad.leader).not.toBe(leader);
    expect(ev.find((e) => e.kind === "radio")).toMatchObject({ key: "radio.manDown" });
  });

  it("a man knocked down by a plate hit cannot get up, reload or change posture until it has passed", () => {
    const input = physio();
    for (const m of input.forces[1]!.units[0]!.members) m.load.push({ type: "vest", count: 1 });
    const sim = createSim(input);
    const [rid, runit] = unitOf(sim, "red");
    const man = runit.members[0]!;
    run(sim, 1);
    strike(sim, man, "chest");
    const s = sim.state.soldier.req(man);
    const until = s.stunnedUntilTick;
    submitOrder(sim, { tick: sim.state.tick, issuer: "red", target: rid, kind: "posture", posture: "standing" });
    run(sim, 0.5); // he falls
    while (sim.state.tick < until) { step(sim); expect(s.posture).toBe("prone"); }
    run(sim, 5);
    expect(s.posture).toBe("standing");
  });

  it("without a physiology model nothing bleeds, but pain still fades and the man fights again", () => {
    const sim = createSim(armedInput()); // physiologyModel "none"
    const man = unitOf(sim, "red")[1].members[0]!;
    const s = sim.state.soldier.req(man);
    s.wounds.push({ id: 0, zone: "abdomen", mechanism: "bullet", severity: 0.5, bleedingLps: 0.01, compressible: false, airway: false, breathing: false, consciousness: false, tickInflicted: 0, treatments: [] });
    s.physiology.pain = 0.72;
    refreshStatus(sim.ctx, sim.state, new EventSink(), man);
    expect(s.impair.canFight).toBe(false);
    run(sim, 600);
    expect(s.physiology.bloodVolumeL).toBe(5);
    expect(s.physiology.pain).toBeLessThan(0.6);
    expect(s.impair.canFight).toBe(true);
  });

  it("a man with a wounded airway cannot report; someone else does", () => {
    const sim = createSim(physio());
    const [uid, unit] = unitOf(sim, "blue");
    const leader = unit.leader!;
    const s = sim.state.soldier.req(leader);
    s.wounds.push({ id: 0, zone: "neck", mechanism: "bullet", severity: 0.55, bleedingLps: 0, compressible: true, airway: true, breathing: false, consciousness: false, tickInflicted: 0, treatments: [] });
    refreshStatus(sim.ctx, sim.state, new EventSink(), leader);
    expect(s.impair.canSpeak).toBe(false);
    submitOrder(sim, { tick: 0, issuer: "blue", target: uid, kind: "halt" });
    const radio = run(sim, 3).find((e) => e.kind === "radio");
    expect(radio && radio.kind === "radio" ? radio.from : leader).not.toBe(leader);
  });
});

describe("bullets go through a body (M2 completion)", () => {
  /** Two red men in a row, the second `gap` metres behind the first, both facing the shooter in the west. */
  const row = (vest: boolean) => {
    const input = physio();
    if (vest) for (const m of input.forces[1]!.units[0]!.members) m.load.push({ type: "vest", count: 1 });
    input.forces[1]!.placements = [{ personId: "b.0", x: 100, y: 100, heading: Math.PI }, { personId: "b.1", x: 101.5, y: 100, heading: Math.PI }];
    const sim = createSim(input);
    const [front, behind] = unitOf(sim, "red")[1].members as [number, number];
    return { sim, front, behind };
  };

  it("a bullet through a leg flies on, slowed, and can wound the man behind; through the trunk it comes out much slower", () => {
    const shoot = (z: number) => {
      const { sim, front, behind } = row(false);
      for (let k = 0; k < 20; k++) launchProjectile(sim.ctx, sim.state, "ball", 60, 99.9 + (k % 5) * 0.03, z, 800, 0, 0, 0);
      const ev = run(sim, 1);
      const hits = (id: number) => ev.filter((e) => e.kind === "hit" && e.target === id).length;
      return { front: hits(front), behind: hits(behind), severity: sim.state.soldier.req(behind).wounds.reduce((m, w) => Math.max(m, w.severity), 0), frontSeverity: sim.state.soldier.req(front).wounds.reduce((m, w) => Math.max(m, w.severity), 0) };
    };
    const legs = shoot(0.5), chest = shoot(1.3);
    expect(legs.front).toBe(20);
    expect(legs.behind).toBe(20); // every round went on into the second man
    expect(chest.front).toBe(20);
    expect(chest.behind).toBeGreaterThan(0);
    // After the first man's trunk the round has 30 % of its speed (9 % of its energy): lighter wounds behind.
    expect(chest.severity).toBeLessThan(chest.frontSeverity);
  });

  it("a round stopped by a plate goes no further; fragments never go through", () => {
    const { sim, behind } = row(true);
    for (let k = 0; k < 10; k++) launchProjectile(sim.ctx, sim.state, "ball", 60, 100, 1.3, 800, 0, 0, 0); // chest, plate
    const ev = run(sim, 1);
    expect(ev.filter((e) => e.kind === "hit" && e.armour === "stopped").length).toBe(10);
    expect(sim.state.soldier.req(behind).wounds).toHaveLength(0);
    const r2 = row(false);
    for (let k = 0; k < 10; k++) launchProjectile(r2.sim.ctx, r2.sim.state, "shard", 97, 100, 0.5, 900, 0, 0, 0);
    run(r2.sim, 1);
    expect(r2.sim.state.soldier.req(r2.front).wounds.length).toBeGreaterThan(0);
    expect(r2.sim.state.soldier.req(r2.behind).wounds).toHaveLength(0);
  });
});

describe("shoot-through review fixes", () => {
  it("a wall right behind a man stops the round that went through him", () => {
    for (const gap of [0.03, 0.05]) {
      const input = physio();
      // Steel wall just behind the front man's back (he faces west, his back is at x = 100 + half depth).
      input.map.obstacles.push({ id: 1, kind: "wall", points: [100.125 + gap, 90, 100.125 + gap, 110], heightM: 2, thicknessM: 0.05, material: "steel" });
      input.forces[1]!.placements = [{ personId: "b.0", x: 100, y: 100, heading: Math.PI }, { personId: "b.1", x: 102, y: 100, heading: Math.PI }];
      const sim = createSim(input);
      const behind = unitOf(sim, "red")[1].members[1]!;
      for (let k = 0; k < 20; k++) launchProjectile(sim.ctx, sim.state, "ball", 60, 99.9 + (k % 5) * 0.03, 0.5, 800, 0, 0, 0);
      run(sim, 1);
      expect(sim.state.soldier.req(behind).wounds).toHaveLength(0);
    }
  });

  it("one bullet does not strike the same running man twice", () => {
    const input = physio();
    input.forces[1]!.placements = [{ personId: "b.0", x: 100, y: 100, heading: 0 }, { personId: "b.1", x: 150, y: 150, heading: 0 }];
    const sim = createSim(input);
    const man = unitOf(sim, "red")[1].members[0]!;
    submitOrder(sim, { tick: 0, issuer: "red", target: man, kind: "move", waypoints: [{ x: 190, y: 100, mode: "run" }] });
    run(sim, 2); // he is running east, away from the shooter
    for (let k = 0; k < 20; k++) launchProjectile(sim.ctx, sim.state, "ball", sim.state.transform.req(man).x - 40, 99.95 + (k % 5) * 0.02, 0.5, 880, 0, 0, 0);
    const ev = run(sim, 1);
    const hits = ev.filter((e) => e.kind === "hit" && e.target === man).length;
    expect(hits).toBeGreaterThan(0);
    expect(hits).toBeLessThanOrEqual(20);
  });
});
