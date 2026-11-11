/** Golden replays (SPEC 5.3): stored order streams must reproduce the stored hashes. */
import { describe, expect, it } from "vitest";
import { GOLDEN_SPECS, readGoldens, replayGolden } from "../src/golden";

describe("golden replays", () => {
  const goldens = readGoldens();
  it("every golden spec has a stored file", () => {
    expect(goldens.map((g) => g.name).sort()).toEqual(GOLDEN_SPECS.map((s) => s.name).sort());
  });
  for (const g of goldens) {
    it(`${g.name}: ${g.description}`, () => {
      const r = replayGolden(g);
      expect(r.catalogFingerprint, "data changed since the golden was recorded").toBe(g.catalogFingerprint);
      expect(r.checkpoints).toEqual(g.checkpoints);
    });
  }
});
