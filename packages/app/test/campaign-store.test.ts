/** M12.1b: the campaign store (slots, the automatic slot, export / import) on the in-memory backend, and the
 *  mid-battle save's campaign-slot tag (plan Q-E (a)). */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AUTO_SLOT, CAMPAIGN_VERSION, hashRecord, newCampaign, SaveError } from "@tcs/campaign";
import { loadData } from "../../tools/src/scenarios";
import { CampaignStore, exportFileName, memoryBackend, validSlotName } from "../src/campaign-store";
import { campaignSlotOf, saveMatchesSlot } from "../src/save";

const data = loadData(true);
const FIXTURE = new URL("../../campaign/test/fixtures/campaign-v1.json", import.meta.url);

describe("M12.1b campaign store", () => {
  it("several named slots and the automatic one; load gives the record back; remove", async () => {
    const store = new CampaignStore(memoryBackend(), data);
    const a = newCampaign(data, { seed: 1, faction: "xf", enemy: "xf" });
    const b = newCampaign(data, { seed: 2, faction: "xf", enemy: "de", mode: "endless" });
    await store.save("zulu", a, "2026-11-19T10:00:00Z");
    await store.save("alpha", b, "2026-11-19T11:00:00Z");
    await store.saveAuto(a, "2026-11-19T12:00:00Z");
    const slots = await store.slots();
    expect(slots.map((s) => s.slotName)).toEqual([AUTO_SLOT, "alpha", "zulu"]);
    expect(slots[1]).toMatchObject({ faction: "xf", enemy: "de", mode: "endless", battles: 0, operation: 1, savedAt: "2026-11-19T11:00:00Z", auto: false });
    expect(slots[0]!.auto).toBe(true);
    const back = await store.load("alpha");
    expect(hashRecord(back.save.record)).toBe(hashRecord(b));
    expect(back.repairs).toEqual([]);
    // Overwrite, then remove.
    await store.save("alpha", a, "later");
    expect(hashRecord((await store.load("alpha")).save.record)).toBe(hashRecord(a));
    await store.remove("alpha");
    expect((await store.slots()).map((s) => s.slotName)).toEqual([AUTO_SLOT, "zulu"]);
    await expect(store.load("alpha")).rejects.toThrow(/no save/);
    // Slot names: not empty, not the automatic slot, at most 40 characters.
    expect(validSlotName("  ")).toBe(false);
    expect(validSlotName(AUTO_SLOT)).toBe(false);
    expect(validSlotName("x".repeat(41))).toBe(false);
    await expect(store.save(AUTO_SLOT, a, "")).rejects.toThrow(/invalid slot/);
  });

  it("export -> import -> export is byte-identical; an old file imports migrated and then round-trips too", async () => {
    const store = new CampaignStore(memoryBackend(), data);
    await store.save("mine", newCampaign(data, { seed: 3, faction: "de", enemy: "ru" }), "2026-11-19T10:00:00Z");
    const text = await store.exportText("mine");
    const other = new CampaignStore(memoryBackend(), data);
    const imp = await other.importText(text);
    expect(imp.repairs).toEqual([]);
    expect(imp.save.slotName).toBe("mine");
    expect(await other.exportText("mine")).toBe(text);
    // Imported under another name.
    await other.importText(text, "copy");
    expect((await other.load("copy")).save.slotName).toBe("copy");
    // The version-1 fixture: migrated once, stable after.
    const v1 = readFileSync(FIXTURE, "utf8");
    const m = await other.importText(v1);
    expect(m.fromVersion).toBe(1);
    expect(m.save.version).toBe(CAMPAIGN_VERSION);
    const once = await other.exportText("imported");
    expect(once).not.toBe(v1);
    const third = new CampaignStore(memoryBackend(), data);
    await third.importText(once);
    expect(await third.exportText("imported")).toBe(once);
    expect(exportFileName(m.save)).toBe(`tcs-campaign-imported-b${m.save.record.battles}.json`);
    // Not a save: refused, nothing stored.
    await expect(third.importText("{\"hello\":1}")).rejects.toBeInstanceOf(SaveError);
    expect((await third.slots()).map((s) => s.slotName)).toEqual(["imported"]);
  });

  it("the mid-battle save is tagged with its campaign slot and loads only into a battle of that slot", () => {
    expect(campaignSlotOf("?scenario=platoon")).toBeNull();
    expect(campaignSlotOf("?scenario=platoon&campaign=alpha")).toBe("alpha");
    expect(saveMatchesSlot({}, null)).toBe(true);
    expect(saveMatchesSlot({ campaignSlot: null }, null)).toBe(true);
    expect(saveMatchesSlot({ campaignSlot: "alpha" }, "alpha")).toBe(true);
    expect(saveMatchesSlot({ campaignSlot: "alpha" }, null)).toBe(false);
    expect(saveMatchesSlot({}, "alpha")).toBe(false);
    expect(saveMatchesSlot({ campaignSlot: "alpha" }, "beta")).toBe(false);
  });
});
