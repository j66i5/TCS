/**
 * D3 "roof atlas off the main thread": the roof worker's job (`handleRoofs`) gives byte for byte the atlas the main
 * thread paints; a BuildingLayers whose atlas comes from a (fake) worker ends with the same sprites and frames as one
 * painted at once; it falls back to painting here when the worker cannot be made, fails or is too slow; a reply after
 * `destroy()` is ignored and the worker is terminated.
 */
import { describe, expect, it } from "vitest";
import type { Sprite } from "pixi.js";
import { buildAppearance, buildCatalog } from "@tcs/data";
import { generateMap } from "@tcs/scenario";
import { type Building, type MapDef } from "@tcs/sim";
import { buildRoofAtlas } from "../src/photo/roof";
import { handleRoofs, type RoofReply, type RoofRequest } from "../src/photo/roof-worker";
import { BuildingLayers } from "../src/buildings";
import { loadData } from "../../tools/src/scenarios";

const data = loadData();
const cat = buildCatalog(data, ["de", "ru"]);
const app = buildAppearance(data, ["de", "ru"]);
const hexN = (h: string) => parseInt(h.replace("#", ""), 16);
/** The colour rule of BuildingLayers (photo palette, then the map palette, then the building's own colour). */
const colourOf = (b: Building) => app.photo?.roofs[b.kind] ?? app.map.roofs[b.kind] ?? hexN(b.roofColour);
const maps: Record<string, MapDef> = {};
const mapOf = (kind: "village" | "industrial", seed: number) => (maps[`${kind}${seed}`] ??= generateMap(cat.terrain, { kind, seed, widthM: 1200, heightM: 900 }));

/** A stand-in for a module Worker: records the request; the test answers it with `handleRoofs`. */
class FakeWorker {
  onmessage: ((e: MessageEvent<RoofReply>) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  sent: RoofRequest[] = [];
  terminated = false;
  postMessage(m: RoofRequest): void { this.sent.push(structuredClone(m)); }
  terminate(): void { this.terminated = true; }
  /** Answer the last request as the worker would (the reply cloned as postMessage would). */
  answer(): RoofReply {
    const { reply } = handleRoofs(this.sent[this.sent.length - 1]!);
    this.onmessage?.({ data: reply } as MessageEvent<RoofReply>);
    return reply;
  }
}
const asWorker = (w: FakeWorker) => w as unknown as Worker;

function spriteView(l: BuildingLayers, n: number) {
  const out: { frame: number[]; src: [number, number]; pos: number[]; size: number[]; renderable: boolean }[] = [];
  for (let i = 0; i < n; i++) {
    const s = l.roofObject(i) as Sprite;
    const f = s.texture.frame;
    out.push({ frame: [f.x, f.y, f.width, f.height], src: [s.texture.source.width, s.texture.source.height], pos: [s.position.x, s.position.y], size: [s.width, s.height], renderable: s.renderable });
  }
  return out;
}

describe("roof atlas worker (D3)", () => {
  it("handleRoofs gives the same atlas, byte for byte, as buildRoofAtlas (village and industrial), pages transferred", () => {
    for (const [kind, seed] of [["village", 1], ["village", 3], ["industrial", 3]] as const) {
      const m = mapOf(kind, seed);
      const want = buildRoofAtlas(m.buildings, colourOf);
      // The request as it crosses to the worker: plain data, cloned.
      const req: RoofRequest = structuredClone({ type: "roofs", id: 7, buildings: m.buildings, colours: m.buildings.map(colourOf) });
      const { reply, transfer } = handleRoofs(req);
      expect(reply.id).toBe(7);
      expect(reply.error).toBeUndefined();
      const got = reply.atlas!;
      expect(got.ppm).toBe(want.ppm);
      expect(got.bytes).toBe(want.bytes);
      expect(got.items).toEqual(want.items);
      expect(got.pages.length).toBe(want.pages.length);
      for (let i = 0; i < want.pages.length; i++) {
        expect([got.pages[i]!.w, got.pages[i]!.h]).toEqual([want.pages[i]!.w, want.pages[i]!.h]);
        expect(Buffer.from(got.pages[i]!.data).equals(Buffer.from(want.pages[i]!.data))).toBe(true);
      }
      expect(transfer).toEqual(got.pages.map((p) => p.data.buffer));
    }
  });

  it("a failing job answers with an error, not a throw", () => {
    const { reply, transfer } = handleRoofs({ type: "roofs", id: 3, buildings: [{ kind: "house" } as unknown as Building], colours: [0] });
    expect(reply).toMatchObject({ id: 3, atlas: null });
    expect(reply.error).toBeTruthy();
    expect(transfer).toEqual([]);
  });

  it("a deferred BuildingLayers has the same sprites and frames after the atlas arrives as one painted at once", async () => {
    for (const [kind, seed] of [["village", 3], ["industrial", 3]] as const) {
      const m = mapOf(kind, seed), n = m.buildings.length;
      const sync = new BuildingLayers(m, app, true);
      const w = new FakeWorker();
      const def = new BuildingLayers(m, app, true, { roofWorker: () => asWorker(w) });
      // Pending: the sprites are there (the fade rule needs them) but empty and not rendered.
      expect(def.roofsPending()).toBe(true);
      expect(def.atlas).toBeNull();
      expect(w.sent).toHaveLength(1);
      expect(w.sent[0]!.colours).toEqual(m.buildings.map(colourOf));
      for (let i = 0; i < n; i++) expect(def.roofObject(i)!.renderable).toBe(false);
      let ready = false;
      void def.roofsReady().then(() => { ready = true; });
      w.answer();
      await Promise.resolve();
      expect(ready).toBe(true);
      expect(def.roofsPending()).toBe(false);
      expect(w.terminated).toBe(true);
      expect(def.atlas!.items).toEqual(sync.atlas!.items);
      for (let p = 0; p < sync.atlas!.pages.length; p++) expect(Buffer.from(def.atlas!.pages[p]!.data).equals(Buffer.from(sync.atlas!.pages[p]!.data))).toBe(true);
      expect(spriteView(def, n)).toEqual(spriteView(sync, n));
      expect(spriteView(def, n).every((s) => s.renderable)).toBe(true);
      // The fade rule works the same on both.
      const men = [m.buildings[0]!.footprint[0]! + 0.5, m.buildings[0]!.footprint[1]! + 0.5];
      for (let f = 0; f < 4; f++) { sync.update(men, 1, false); def.update(men, 1, false); }
      for (let i = 0; i < n; i++) expect(def.roofAlpha(i)).toBe(sync.roofAlpha(i));
      sync.destroy(); def.destroy();
    }
  });

  it("paints here when the worker cannot be made, fails or is too slow", async () => {
    const m = mapOf("industrial", 3), n = m.buildings.length;
    const sync = new BuildingLayers(m, app, true);
    // The factory throws: painted at once.
    const a = new BuildingLayers(m, app, true, { roofWorker: () => { throw new Error("no workers here"); } });
    expect(a.roofsPending()).toBe(false);
    expect(spriteView(a, n)).toEqual(spriteView(sync, n));
    // The worker reports an error: painted here, worker terminated.
    const wb = new FakeWorker();
    const b = new BuildingLayers(m, app, true, { roofWorker: () => asWorker(wb) });
    wb.onerror?.(new Error("boom"));
    expect(b.roofsPending()).toBe(false);
    expect(wb.terminated).toBe(true);
    expect(spriteView(b, n)).toEqual(spriteView(sync, n));
    // No answer in time: painted here, worker terminated; a late answer changes nothing.
    const wc = new FakeWorker();
    const c = new BuildingLayers(m, app, true, { roofWorker: () => asWorker(wc), roofTimeoutMs: 5 });
    await c.roofsReady();
    expect(c.roofsPending()).toBe(false);
    expect(wc.terminated).toBe(true);
    const atlas = c.atlas;
    wc.answer();
    expect(c.atlas).toBe(atlas);
    expect(spriteView(c, n)).toEqual(spriteView(sync, n));
    for (const l of [sync, a, b, c]) l.destroy();
  });

  it("destroy() stops a pending worker and a late reply is ignored", async () => {
    const m = mapOf("village", 3);
    const w = new FakeWorker();
    const l = new BuildingLayers(m, app, true, { roofWorker: () => asWorker(w) });
    const onmessage = w.onmessage!;
    l.destroy();
    expect(w.terminated).toBe(true);
    expect(l.roofsPending()).toBe(false);
    await l.roofsReady(); // settles (primeDetail must not hang on a map that was replaced)
    const { reply } = handleRoofs(w.sent[0]!);
    expect(() => onmessage({ data: reply } as MessageEvent<RoofReply>)).not.toThrow();
    expect(l.atlas).toBeNull();
  });

  it("the flat look makes no worker", () => {
    const m = mapOf("village", 3);
    let made = 0;
    const l = new BuildingLayers(m, app, false, { roofWorker: () => { made++; return asWorker(new FakeWorker()); } });
    expect(made).toBe(0);
    expect(l.roofsPending()).toBe(false);
    l.destroy();
  });
});
