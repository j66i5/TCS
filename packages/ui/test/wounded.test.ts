/** M10.5: the Wounded tab's rows and the Verwundetennest markers (pure, from the read-only view). */
import { describe, expect, it } from "vitest";
import { createSim, simHash } from "@tcs/sim";
import { getScenario, loadData } from "../../tools/src/scenarios";
import { ambulanceRows, nestAt, nestMarkers, woundedRows } from "../src/wounded";

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

  it("M10.6a: the side's ambulances: waiting ones counted, runs listed with the minutes left and the men aboard; evacuated men listed without Back", () => {
    const sim2 = createSim(getScenario("platoon").build(loadData(), 1, 600));
    const s2 = sim2.state;
    // (M11.9b: the military police wait off the map too; ambulances only here.)
    const own = [...s2.vehicle.entries()].filter(([, v]) => v.side === "blue" && v.offMap?.kind === "ambulance");
    expect(own.length).toBe(2);
    expect(ambulanceRows(s2, "blue")).toEqual({ rows: [], ready: 2 });
    const [vid, v] = own[0]!;
    v.offMap = { kind: "ambulance", phase: "called", callTick: 0, enterTick: 60 * 125 };
    const h = simHash(sim2);
    const r = ambulanceRows(s2, "blue");
    expect(simHash(sim2)).toBe(h);
    expect(r.ready).toBe(1);
    expect(r.rows).toEqual([{ id: vid, callsign: s2.unit.get(v.unit!)!.callsign, phase: "called", dueS: 125, aboard: 0 }]);
    // A man evacuated: listed as such, no Back.
    const m = [...s2.identity.entries()].find(([, i]) => i.side === "blue")![0];
    const sm = s2.soldier.req(m);
    sm.wounds.push(hurt(0.5)); sm.evacuated = { tick: 0, vehicle: vid };
    const row = woundedRows(s2, "blue").find((x) => x.id === m)!;
    expect(row.status).toBe("evacuated");
    expect(row.canEvacuate).toBe(false);
  });
});
