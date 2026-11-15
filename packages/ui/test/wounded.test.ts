/** M10.5: the Wounded tab's rows and the Verwundetennest markers (pure, from the read-only view). */
import { describe, expect, it } from "vitest";
import { createSim, simHash } from "@tcs/sim";
import { getScenario, loadData } from "../../tools/src/scenarios";
import { nestAt, nestMarkers, woundedRows } from "../src/wounded";

const hurt = (sev: number) => ({ id: 1, zone: "legL" as const, mechanism: "bullet" as const, severity: sev, bleedingLps: 0, compressible: false, airway: false, breathing: false, consciousness: false, tickInflicted: 0, treatments: [] });

describe("woundedRows and nestMarkers (M10.5)", () => {
  const sim = createSim(getScenario("platoon").build(loadData(), 1, 600));
  const st = sim.state;
  const blue = [...st.identity.entries()].filter(([, i]) => i.side === "blue").map(([id]) => id);
  const red = [...st.identity.entries()].filter(([, i]) => i.side === "red").map(([id]) => id);

  it("own living, uncaptured wounded only, T1 first; statuses and the Back button", () => {
    expect(woundedRows(st, "blue")).toEqual([]);
    const [a, b, c, d, e] = blue.slice(2, 7) as [number, number, number, number, number];
    const sa = st.soldier.req(a), sb = st.soldier.req(b), sc = st.soldier.req(c), sd = st.soldier.req(d), se = st.soldier.req(e);
    sa.wounds.push(hurt(0.05)); // a scratch: fighting on
    sb.wounds.push(hurt(0.6)); sb.impair.canWalk = false; sb.triage = { cat: 1, by: a, tick: 0, skill: "buddy" }; // waiting for bearers, T1
    sc.wounds.push(hurt(0.3)); sc.atNest = 999; sc.triage = { cat: 3, by: a, tick: 0, skill: "medic" };
    sd.wounds.push(hurt(0.3)); sd.physiology.alive = false; // dead: not listed
    se.wounds.push(hurt(0.3)); se.evacOrdered = true;
    st.soldier.req(red[3]!).wounds.push(hurt(0.4)); // the enemy's: never listed (owner Q-2d)
    const h = simHash(sim);
    const rows = woundedRows(st, "blue");
    expect(simHash(sim)).toBe(h);
    expect(rows.map((r) => r.id)).toEqual([b, c, a, e]);
    const by = (id: number) => rows.find((r) => r.id === id)!;
    expect(by(b).tag).toBe(1);
    expect(by(b).status).toBe("waiting");
    expect(by(b).canEvacuate).toBe(true);
    expect(by(c).status).toBe("nest");
    expect(by(c).canEvacuate).toBe(false);
    expect(by(a).status).toBe("fighting");
    expect(by(a).tag).toBeNull();
    expect(by(e).ordered).toBe(true);
    expect(by(e).canEvacuate).toBe(false);
    expect(by(a).name).toBe(st.identity.req(a).family);
  });

  it("the side's nests with the men lying there; the marker under a point", () => {
    expect(nestMarkers(st, "blue")).toEqual([]);
    const top = [...st.unit.entries()].find(([, u]) => u.side === "blue" && u.parent === null)![0];
    st.rear.set(999, { kind: "medical", side: "blue", unit: top, x: 100, y: 200, sitedTick: 0, checkTick: 0 });
    st.rear.set(998, { kind: "medical", side: "red", unit: 1, x: 500, y: 200, sitedTick: 0, checkTick: 0, placed: true });
    const m = nestMarkers(st, "blue");
    expect(m).toEqual([{ point: 999, unit: top, x: 100, y: 200, count: 1, placed: false }]);
    expect(nestAt(m, 104, 203, 6)?.point).toBe(999);
    expect(nestAt(m, 120, 200, 6)).toBeNull();
  });
});
