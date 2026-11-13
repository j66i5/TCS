/**
 * The photo painter in a worker (plan "photo" decision 6): `init` carries the map and the prepared colours, the
 * worker prepares once; each `tile` message is answered with the painted bytes (the buffer is transferred, not
 * copied). The same code paints on the main thread when there are no workers (tests, Node).
 */
import { PhotoPainter, type PhotoInit } from "./paint";

export type PhotoRequest =
  | { type: "init"; init: PhotoInit }
  | { type: "tile"; id: number; x0: number; y0: number; w: number; h: number; ppm: number };
export interface PhotoReply { id: number; data: ArrayBuffer | null; error?: string }

interface WorkerScope { onmessage: ((e: { data: PhotoRequest }) => void) | null; postMessage(m: PhotoReply, transfer: ArrayBuffer[]): void }
const scope = globalThis as unknown as WorkerScope;
let painter: PhotoPainter | null = null;

scope.onmessage = (e) => {
  const m = e.data;
  if (m.type === "init") { painter = new PhotoPainter(m.init); return; }
  try {
    if (!painter) throw new Error("photo worker: tile before init");
    const bytes = painter.paint(m.x0, m.y0, m.w, m.h, m.ppm);
    scope.postMessage({ id: m.id, data: bytes.buffer as ArrayBuffer }, [bytes.buffer as ArrayBuffer]);
  } catch (err) {
    scope.postMessage({ id: m.id, data: null, error: String(err) }, []);
  }
};
