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
  // The proof holds for the data it was recorded with. Since 2026-11-13 (the BMP-2's missile, stress aboard: owner
  // decisions) the data differ, so these replays cannot match any more and are skipped while the catalog differs;
  // the files stay unchanged (never regenerated) and the proof stands for commits 6717b28..76f13d9 (DECISIONS.md
  // "BMP-2 missile, dead-ground start, stress aboard").
  // (The current data's fingerprint: that of the regular golden of the same name, recorded with today's data.)
  const current = new Map(readGoldens().map((x) => [x.name, x.catalogFingerprint]));
  for (const g of goldens) {
    it.skipIf(current.has(g.name) && current.get(g.name) !== g.catalogFingerprint)(`${g.name} (interiors off)`, () => {
      const r = replayGolden(g, { interiors: false });
      expect(r.catalogFingerprint).toBe(g.catalogFingerprint);
      expect(r.checkpoints).toEqual(g.checkpoints);
    });
  }
});
