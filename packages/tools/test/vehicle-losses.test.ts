/** The batch report's kills by shooter (M7.6b review fix): each hull lost counts once, to its last penetrating hit. */
import { describe, expect, it } from "vitest";
import { lossTally } from "../src/vehicle-losses";

describe("kills by shooter (batch)", () => {
  it("a hull abandoned, penetrated again and then destroyed is one loss, credited to the hit before it was abandoned", () => {
    const t = lossTally();
    t.hit(7, "de-leopard2a7v");
    t.lost(7, "ru-t72b3m"); // abandoned
    t.hit(7, "team"); // a missile already in flight
    t.hit(7, undefined); // a hit that did not get through
    t.lost(7, "ru-t72b3m"); // cooked off
    t.lost(9, "ru-bmp2"); // never penetrated (burnt out)
    expect(t.killers).toEqual({ "ru-t72b3m": { "de-leopard2a7v": 1 }, "ru-bmp2": { none: 1 } });
  });
});
