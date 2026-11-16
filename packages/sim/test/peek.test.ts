/** Sight realism step 4: a man who has lost sight of an enemy he knows looks for him (peek ladder, change of window). */
import { describe, expect, it } from "vitest";
import { createSim, secondsToTicks, step, submitOrder, windowPlaces, type BattleInput, type Building, type Catalog, type Sim } from "../src/index";
import { windowWithView } from "../src/systems/occupy";
import { armedInput, testCatalog } from "./helpers";

const PEEK = { afterSeconds: 4, standSeconds: 3, everySeconds: 15, contactSeconds: 60, contactErrM: 20, sidestepM: [2, -2, 4, -4, 6, -6], mode: "crawl", uprightMode: "walk" };
const WINDOW = { afterSeconds: 6, everySeconds: 20, mode: "run", routeCandidates: 3 };
const catalog: Catalog = { ...testCatalog, behaviour: { ...testCatalog.behaviour, soldier: { ...testCatalog.behaviour.soldier, peek: PEEK, windowSwitch: WINDOW } } };

const unitOf = (sim: Sim, side: string) => [...sim.state.unit.entries()].find(([, u]) => u.side === side)!;
const run = (sim: Sim, seconds: number) => { for (let i = 0; i < secondsToTicks(seconds); i++) step(sim); };

/** One blue man at (50, 50) facing east, the red team standing at x = 150 (holding fire); `wall`: in front of him. */
function setup(wall: (input: BattleInput) => void): { sim: Sim; me: number } {
  const input = armedInput(1, 600);
  input.catalog = catalog;
  input.forces[0]!.units[0]!.members = input.forces[0]!.units[0]!.members.slice(0, 1);
  input.forces[0]!.placements = [{ personId: input.forces[0]!.units[0]!.members[0]!.personId, x: 50, y: 50, heading: 0 }];
  input.forces[1]!.placements = input.forces[1]!.placements.map((p, i) => ({ ...p, x: 150, y: 48 + 4 * i }));
  wall(input);
  const sim = createSim(input);
  submitOrder(sim, { tick: 0, issuer: "blue", target: unitOf(sim, "blue")[0], kind: "rules", fire: "return" });
  submitOrder(sim, { tick: 0, issuer: "red", target: unitOf(sim, "red")[0], kind: "rules", fire: "hold" });
  return { sim, me: unitOf(sim, "blue")[1].members[0]! };
}

describe("sight realism step 4: looking for a lost enemy", () => {
  it("remembers when he last saw an enemy", () => {
    const { sim, me } = setup(() => {});
    run(sim, 3);
    const s = sim.state.soldier.req(me);
    expect(s.seen.length).toBeGreaterThan(0);
    expect(sim.state.tick - (s.sawEnemyTick ?? -1e9)).toBeLessThanOrEqual(secondsToTicks(1));
  });

  it("lying blind behind a wall that kneeling does not clear, he stands up to look and lies down again", () => {
    const { sim, me } = setup((i) => { i.map.obstacles.push({ id: 1, kind: "wall", points: [52, 40, 52, 60], heightM: 1.3, thicknessM: 0.25, material: "brick" } as never); });
    run(sim, 3); // he sees them over the wall, standing
    submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: me, kind: "posture", posture: "prone" });
    run(sim, 3);
    const s = sim.state.soldier.req(me);
    expect(s.homePosture).toBe("prone");
    let stood = false;
    for (let k = 0; k < 12 && !stood; k++) { run(sim, 1); stood = s.posture === "standing" || s.postureTo === "standing"; }
    expect(stood).toBe(true);
    expect(s.peekUntilTick).toBeDefined();
    expect(sim.state.transform.req(me).x).toBeCloseTo(50, 3); // (no step aside: standing was enough)
    run(sim, 8);
    expect(s.posture).toBe("prone");
    expect(s.peekUntilTick).toBeUndefined();
  });

  it("behind a high wall he moves a few metres aside to a spot that sees the enemy, never closer to him", () => {
    const { sim, me } = setup((i) => { i.map.obstacles.push({ id: 1, kind: "wall", points: [52, 47, 52, 53], heightM: 2.5, thicknessM: 0.25, material: "brick" } as never); });
    // He saw them from (50, 40), then went behind the wall.
    sim.state.transform.req(me).y = 40;
    run(sim, 3);
    expect(sim.state.soldier.req(me).contacts.length).toBeGreaterThan(0);
    submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: me, kind: "move", waypoints: [{ x: 50, y: 50, mode: "walk" }] });
    const t = sim.state.transform.req(me), s = sim.state.soldier.req(me);
    let home: { x: number; y: number } | undefined;
    for (let k = 0; k < 20 && home === undefined; k++) { run(sim, 1); home = s.peekHome; }
    expect(home).toBeDefined();
    run(sim, 30);
    const d = (p: { x: number; y: number }) => Math.hypot(p.x - 150, p.y - 50);
    const off = Math.hypot(t.x - home!.x, t.y - home!.y);
    expect(off).toBeGreaterThanOrEqual(1.5);
    expect(off).toBeLessThanOrEqual(6.5);
    expect(d(t)).toBeGreaterThanOrEqual(d(home!) - 0.5);
    expect(sim.state.mover.get(me)!.waypoints.length).toBe(0);
    expect(s.posture).toBe(s.homePosture);
  });

  // (Review fixes 2026-11-16.)
  const lowWall = (i: BattleInput) => { i.map.obstacles.push({ id: 1, kind: "wall", points: [52, 40, 52, 60], heightM: 1.3, thicknessM: 0.25, material: "brick" } as never); };
  it("with no posture of his own he goes back to the posture he stood up from, and it does not become his", () => {
    const { sim, me } = setup(lowWall);
    run(sim, 3);
    const s = sim.state.soldier.req(me);
    s.posture = "prone"; delete s.homePosture;
    let stood = false;
    for (let k = 0; k < 12 && !stood; k++) { run(sim, 1); stood = (s.posture as string) === "standing" || s.postureTo === "standing"; }
    expect(stood).toBe(true);
    expect(s.peekFrom).toBe("prone");
    run(sim, 8);
    expect(s.posture).toBe("prone");
    expect(s.peekFrom).toBeUndefined();
    expect(s.homePosture).toBeUndefined();
  });

  it("in a fight (rounds passing him lately) he does not stand up to look", () => {
    const { sim, me } = setup(lowWall);
    run(sim, 3);
    submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: me, kind: "posture", posture: "prone" });
    const s = sim.state.soldier.req(me);
    run(sim, 3);
    expect(s.homePosture).toBe("prone");
    for (let k = 0; k < 20; k++) { s.fireFrom = { dx: 1, dy: 0, tick: sim.state.tick }; run(sim, 1); expect(s.posture === "standing" || s.postureTo === "standing").toBe(false); }
    expect(s.peekTick).toBeDefined(); // (he did look: turned to him)
  });

  it("a man of a missile team that is set up does not leave his post to look", () => {
    const { sim, me } = setup(lowWall);
    run(sim, 3);
    submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: me, kind: "posture", posture: "prone" });
    (sim.state.unit.req(unitOf(sim, "blue")[0]) as { missileTeam?: unknown }).missileTeam = { state: "ready" };
    run(sim, 25);
    expect(sim.state.soldier.req(me).posture).toBe("prone");
    expect(sim.state.soldier.req(me).peekTick).toBeUndefined();
  });

  it("does not look under rule hold or in an ambush", () => {
    const { sim, me } = setup((i) => { i.map.obstacles.push({ id: 1, kind: "wall", points: [52, 40, 52, 60], heightM: 1.3, thicknessM: 0.25, material: "brick" } as never); });
    submitOrder(sim, { tick: 0, issuer: "blue", target: unitOf(sim, "blue")[0], kind: "rules", fire: "hold" });
    run(sim, 3);
    submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: me, kind: "posture", posture: "prone" });
    run(sim, 25);
    expect(sim.state.soldier.req(me).posture).toBe("prone");
    expect(sim.state.soldier.req(me).peekTick).toBeUndefined();
  });
});

/** A one-storey 12 x 10 m house, one room, a window in the north wall (y = 80) and one in the east wall (x = 112). */
function house(): Building {
  const fp = [100, 80, 112, 80, 112, 90, 100, 90];
  return {
    id: 1, kind: "house", footprint: fp, storeys: 1, storeyHeightM: 2.8, wallMaterial: "brick", wallThicknessM: 0.3, roofColour: "#8c4a3b",
    openings: [
      { wall: 3, offsetM: 3, widthM: 1.0, kind: "door", sillM: 0, headM: 2.1 },
      { wall: 0, offsetM: 3, widthM: 1.2, kind: "window", sillM: 0.9, headM: 2.1 },
      { wall: 1, offsetM: 5, widthM: 1.2, kind: "window", sillM: 0.9, headM: 2.1 },
    ],
    interior: { rooms: [{ id: 0, floor: 0, poly: fp, kind: "room" }], walls: [], stairs: [] },
  };
}

describe("sight realism step 4: another window", () => {
  it("finds the window of his house that sees the enemy, not one a comrade holds", () => {
    const input = armedInput(1, 600);
    input.catalog = catalog;
    input.map = { ...input.map, buildings: [house()] };
    const sim = createSim(input);
    const [me, mate] = unitOf(sim, "blue")[1].members;
    const wins = windowPlaces(sim.ctx, 0);
    const north = wins.find((w) => w.y < 85)!, east = wins.find((w) => w.x > 106)!;
    Object.assign(sim.state.transform.req(me!), { x: north.x, y: north.y, z: 0 });
    const r = windowWithView(sim.ctx, sim.state, me!, { x: 160, y: 85, z: 0 }, 3);
    expect(r).not.toBeNull();
    expect(r!.place.x).toBeCloseTo(east.x, 6);
    // A comrade at the east window: none left.
    Object.assign(sim.state.transform.req(mate!), { x: east.x, y: east.y, z: 0 });
    expect(windowWithView(sim.ctx, sim.state, me!, { x: 160, y: 85, z: 0 }, 3)).toBeNull();
  });
});
