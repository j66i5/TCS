/** Balance pass 4 (owner G, 2026-11-19): men under effective fire return fire at the shooter's known place. */
import { describe, expect, it } from "vitest";
import { createSim, flatMap, secondsToTicks, step, type Catalog, type Sim, type SimEvent } from "../src/index";
import { armedInput, testCatalog } from "./helpers";

const RF = { firedOnS: 10, withinS: 20, maxErrM: 30, bearingDeg: 30, intervalS: 3, mgIntervalS: 4 };

function run(sim: Sim, seconds: number): SimEvent[] {
  const out: SimEvent[] = [];
  for (let i = 0; i < secondsToTicks(seconds); i++) out.push(...step(sim));
  return out;
}

interface Case {
  /** The returnFire data (absent: off). */
  rf?: typeof RF;
  /** Blue's side posture. */
  posture?: "defend" | "attack";
  /** Rounds cracked past the blue men: from this bearing (degrees from the contact's direction); null: none. */
  firedFrom?: number | null;
  /** The red man fires (his weapon's last shot kept fresh). */
  redFiring?: boolean;
  /** How well the place is known (m). */
  errM?: number;
  /** Where the place is (m east of blue; blue's rifle reaches 400 m). */
  atM?: number;
}

/** Three blue riflemen (rule free) told of a red man `atM` east they cannot see (the real one is beyond sight, 1,300 m off). */
function setup(c: Case): { sim: Sim; blue: number[]; red: number; drive: (seconds: number) => SimEvent[] } {
  const input = armedInput(1, 600);
  const soldier = { ...testCatalog.behaviour.soldier } as Catalog["behaviour"]["soldier"];
  if (c.rf) soldier.returnFire = c.rf; else delete soldier.returnFire;
  delete soldier.suppressKnown;
  input.catalog = { ...testCatalog, behaviour: { ...testCatalog.behaviour, soldier } };
  input.rules.physiologyModel = "simple";
  input.forces[0]!.posture = c.posture ?? "defend";
  input.map = flatMap("t", 1600, 200);
  input.forces[1]!.placements = input.forces[1]!.placements.map((p, i) => ({ ...p, x: 1550, y: 150 + i * 4 }));
  const sim = createSim(input);
  for (const [id, u] of sim.state.unit.entries()) if (u.side === "blue") sim.state.unit.req(id).fireRule = "free";
  const blue = [...sim.state.identity.entries()].filter(([, i]) => i.side === "blue").map(([id]) => id);
  const red = [...sim.state.identity.entries()].find(([, i]) => i.side === "red")![0];
  const at = c.atM ?? 300;
  const drive = (seconds: number): SimEvent[] => {
    const ev: SimEvent[] = [];
    for (let k = 0; k < seconds; k++) {
      const tick = sim.state.tick;
      if (c.redFiring !== false) sim.state.weapon.req(red).lastShotTick = tick;
      for (const m of blue) {
        const s = sim.state.soldier.req(m), t = sim.state.transform.req(m);
        s.contacts = [{ target: red, x: t.x + at, y: t.y, errM: c.errM ?? 5, kind: "reported", tick, reportedTick: tick }];
        const b = ((c.firedFrom ?? 0) * Math.PI) / 180;
        if (c.firedFrom !== null) s.fireFrom = { dx: Math.cos(b), dy: Math.sin(b), tick };
        else delete s.fireFrom;
      }
      ev.push(...run(sim, 1));
    }
    return ev;
  };
  return { sim, blue, red, drive };
}

const shotsBy = (ev: SimEvent[], men: number[]) => ev.filter((e) => e.kind === "shot.fired" && men.includes(e.shooter)).length;

describe("return fire (balance pass 4, G)", () => {
  it("a man fired on who cannot see the shooter fires at his known place, one shot per intervalS, on either side", () => {
    for (const posture of ["defend", "attack"] as const) {
      const { blue, drive } = setup({ rf: RF, posture });
      const shots = shotsBy(drive(20), blue);
      expect(shots).toBeGreaterThan(5);
      // One shot per 3 s at most (+-15 %), per man: 3 men x 20 s.
      expect(shots).toBeLessThanOrEqual(3 * 8);
    }
  });

  it("the fire task is marked as return fire and aimed at the place", () => {
    const { sim, blue, red, drive } = setup({ rf: RF });
    drive(5);
    const ft = blue.map((m) => sim.state.fire.get(m)).find((f) => f !== undefined)!;
    expect(ft.suppress).toBe("return");
    expect(ft.contact).toBe(red);
  });

  it("nothing without the data, when not fired on, when the rounds came from elsewhere, when the shooter is silent, the place is vague or beyond his reach", () => {
    expect(shotsBy(setup({}).drive(20), setup({}).blue)).toBe(0);
    for (const c of [{ firedFrom: null }, { firedFrom: 60 }, { redFiring: false }, { errM: 60 }, { atM: 500 }] as Case[]) {
      const { blue, drive } = setup({ rf: RF, ...c });
      expect(shotsBy(drive(20), blue), JSON.stringify(c)).toBe(0);
    }
  });

  it("the fire stops firedOnS after the last round past him", () => {
    const { sim, blue, drive } = setup({ rf: RF });
    expect(shotsBy(drive(10), blue)).toBeGreaterThan(0);
    // No more rounds past him: the reports stay fresh, the fire ends.
    const tick = sim.state.tick;
    const ev: SimEvent[] = [];
    for (let k = 0; k < 25; k++) {
      for (const m of blue) {
        const s = sim.state.soldier.req(m);
        s.fireFrom = { ...s.fireFrom!, tick };
        for (const c of s.contacts) c.tick = sim.state.tick;
      }
      ev.push(...run(sim, 1));
    }
    const late = ev.filter((e) => e.kind === "shot.fired" && blue.includes(e.shooter) && e.tick > tick + secondsToTicks(RF.firedOnS + 2)).length;
    expect(late).toBe(0);
  });
});
