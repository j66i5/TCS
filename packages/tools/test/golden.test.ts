/** Golden replays (SPEC 5.3): stored order streams must reproduce the stored hashes. */
import { describe, expect, it } from "vitest";
import { GOLDEN_NO_INTERIORS_DIR, GOLDEN_SPECS, readGoldens, replayGolden } from "../src/golden";

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

describe("golden replays without interiors (M7.5c equivalence proof)", () => {
  // The goldens recorded before interiors existed, never regenerated: with interiors off the map, the catalog and
  // every checkpoint hash must be exactly as they were.
  const goldens = readGoldens(GOLDEN_NO_INTERIORS_DIR);
  it("every golden of before M7.5c is kept", () => {
    expect(goldens.length).toBeGreaterThanOrEqual(6);
  });
  for (const g of goldens) {
    it(`${g.name} (interiors off)`, () => {
      const r = replayGolden(g, { interiors: false });
      expect(r.catalogFingerprint).toBe(g.catalogFingerprint);
      expect(r.checkpoints).toEqual(g.checkpoints);
    });
  }
});
