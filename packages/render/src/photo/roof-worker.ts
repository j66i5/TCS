/**
 * The roof atlas in a worker (D3 "roof atlas off the main thread"): one short-lived worker per map, one message
 * (the buildings and their roof colours, worked out on the main thread so nothing but plain data crosses), one reply
 * (the atlas pages, their buffers transferred, not copied), then the main thread terminates it. A worker of its own
 * rather than the photo worker: a phone has one photo worker, and the atlas in its queue would hold back the opening
 * view's tiles. `handleRoofs` is the whole job (pure; tests call it in Node and compare it with `buildRoofAtlas`).
 */
import type { Building } from "@tcs/sim";
import { buildRoofAtlas, type RoofAtlas } from "./roof";

export interface RoofRequest { type: "roofs"; id: number; buildings: readonly Building[]; colours: readonly number[] }
export interface RoofReply { id: number; atlas: RoofAtlas | null; error?: string }

/** Paint the atlas for one request; returns the reply and the buffers to transfer with it. */
export function handleRoofs(m: RoofRequest): { reply: RoofReply; transfer: ArrayBuffer[] } {
  try {
    const colours = m.colours;
    const atlas = buildRoofAtlas(m.buildings, (_b, i) => colours[i]!);
    return { reply: { id: m.id, atlas }, transfer: atlas.pages.map((p) => p.data.buffer as ArrayBuffer) };
  } catch (err) {
    return { reply: { id: m.id, atlas: null, error: String(err) }, transfer: [] };
  }
}

interface WorkerScope { WorkerGlobalScope?: unknown; onmessage: ((e: { data: RoofRequest }) => void) | null; postMessage(m: RoofReply, transfer: ArrayBuffer[]): void }
const scope = globalThis as unknown as WorkerScope;
// Only inside a worker (a test importing `handleRoofs` must not install a message handler on its own global).
if (scope.WorkerGlobalScope !== undefined) {
  scope.onmessage = (e) => {
    const { reply, transfer } = handleRoofs(e.data);
    scope.postMessage(reply, transfer);
  };
}
