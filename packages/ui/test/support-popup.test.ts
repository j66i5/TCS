/** M8.6: the fire support pop-up's buttons per asset row. */
import { describe, expect, it } from "vitest";
import { rowButtons, type SupportAssetOffer } from "../src/support";

const base: SupportAssetOffer = { asset: "artillery", onMap: false, he: 8, smoke: 4, illum: 2, etaS: 240, dangerClose: false, airburst: true, inRange: true, moving: false };

describe("fire support pop-up (M8.6)", () => {
  it("offers HE, airburst (where the asset has the fuse), smoke and a flare at a point; only a screen on a line", () => {
    expect(rowButtons(base, false).map((b) => `${b.ammo}${b.airburst ? "+air" : ""}`)).toEqual(["he", "he+air", "smoke", "illum"]);
    expect(rowButtons({ ...base, airburst: false }, false).map((b) => b.ammo)).toEqual(["he", "smoke", "illum"]);
    const line = rowButtons(base, true);
    expect(line).toHaveLength(1);
    expect(line[0]).toMatchObject({ ammo: "smoke", key: "support.screen", n: 4 });
  });
});
