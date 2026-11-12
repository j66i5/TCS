import { describe, expect, it } from "vitest";
import { FOOT_PACES, ordersFor, paceToWaypoint } from "../src/index";

const modes = {
  walk: { class: "foot" }, run: { class: "foot" }, sneak: { class: "foot" }, crawl: { class: "foot" },
  "drive-slow": { class: "tracked", speedFraction: 0.3 }, drive: { class: "tracked", speedFraction: 0.7 }, "drive-fast": { class: "tracked", speedFraction: 1 },
  "wdrive-slow": { class: "wheeled", speedFraction: 0.3 }, wdrive: { class: "wheeled", speedFraction: 0.7 },
};

describe("ordersFor (M7.1c)", () => {
  it("men on foot get every order and the foot paces", () => {
    const o = ordersFor(null, modes);
    expect(o.modes).toContain("assault");
    expect(o.posture).toBe(true);
    expect(o.paces).toEqual(FOOT_PACES);
  });

  it("a tracked vehicle gets move, halt, cease fire and rules; its own paces (drive first) and reverse", () => {
    const o = ordersFor("tracked", modes);
    expect(o.modes).toEqual(["move"]);
    expect(o.posture).toBe(false);
    expect(o.halt && o.ceaseFire && o.rules).toBe(true);
    expect(o.paces).toEqual(["drive", "drive-slow", "drive-fast", "reverse"]);
    expect(paceToWaypoint("reverse", o)).toEqual({ mode: "drive-slow", reverse: true });
    expect(paceToWaypoint("drive", o)).toEqual({ mode: "drive" });
  });

  it("a wheeled vehicle gets the wheeled paces", () => {
    expect(ordersFor("wheeled", modes).paces).toEqual(["wdrive-slow", "wdrive", "reverse"]);
    expect(ordersFor("wheeled", modes).reversePace).toBe("wdrive-slow");
  });

  it("mount and dismount (M7.2): offered as the unit's state allows; a crew can only let its passengers out", () => {
    expect(ordersFor(null, modes)).toMatchObject({ mount: false, dismount: false });
    expect(ordersFor(null, modes, { mount: true, dismount: false })).toMatchObject({ mount: true, dismount: false });
    expect(ordersFor(null, modes, { mount: false, dismount: true })).toMatchObject({ mount: false, dismount: true });
    expect(ordersFor("tracked", modes, { mount: true, dismount: true })).toMatchObject({ mount: false, dismount: true });
  });
});
