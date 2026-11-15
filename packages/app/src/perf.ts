/**
 * D3 phone pass: frame timing for `__tcs.perf()` and the `?perf=1` read-out.
 *
 * `main.ts` stamps `performance.now()` round the parts of its frame and hands one sample per frame to the recorder
 * (`FrameRecorder`, packages/ui/src/perf.ts); Pixi's own `app.render` is timed by a ticker listener that runs after it.
 * Real time only: nothing here reaches the simulation (and perf mode never computes the state hash).
 */
import { deviceTier, type BattleRenderer, type Look } from "@tcs/render";
import { FrameRecorder, perfLine, type PerfStats } from "@tcs/ui";
import type { Strings } from "@tcs/data";

/** The read-out's window (s), and how often it refreshes (ms). */
const WINDOW_S = 5;
const REFRESH_MS = 500;
/** Pixi's UPDATE_PRIORITY.UTILITY: runs after the app's render (UPDATE_PRIORITY.LOW). */
const AFTER_RENDER = -50;

export interface PerfReport {
  /** The last WINDOW_S seconds, and everything still in the ring buffer (since the reset, up to 1200 frames). */
  window: PerfStats;
  all: PerfStats;
  tilesPending: number;
  speed: number;
  dpr: number;
  resolution: number;
  look: Look;
  tier: { phone: boolean; strong: boolean; workers: number };
  gl: string;
  viewport: { w: number; h: number };
  ua: string;
}

/** The GPU's name, where the browser tells it (WEBGL_debug_renderer_info), else the GL renderer string. */
function glName(renderer: BattleRenderer): string {
  try {
    const gl = (renderer.app.renderer as unknown as { gl?: WebGLRenderingContext }).gl;
    if (!gl) return "?";
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    return String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
  } catch { return "?"; }
}

export class FramePerf {
  readonly recorder = new FrameRecorder();
  private readonly gl: string;
  /** The frame being timed: recorded once Pixi has rendered it. */
  private pending = { at: 0, frame: 0, sim: 0, know: 0, ui: 0, draw: 0, gpu: 0, steps: 0, dropped: 0 };
  private open = false;
  private endAt = 0;

  constructor(private readonly renderer: BattleRenderer, private readonly look: Look, private readonly speed: () => number) {
    this.gl = glName(renderer);
    renderer.app.ticker.add(() => {
      if (!this.open) return;
      this.pending.gpu = performance.now() - this.endAt;
      this.recorder.record(this.pending);
      this.open = false;
    }, undefined, AFTER_RENDER);
  }

  /** The app's frame callback is done (its parts in ms); Pixi renders next. */
  frameDone(at: number, frame: number, sim: number, know: number, ui: number, draw: number, steps: number, dropped: number): void {
    const p = this.pending;
    p.at = at; p.frame = frame; p.sim = sim; p.know = know; p.ui = ui; p.draw = draw; p.steps = steps; p.dropped = dropped; p.gpu = 0;
    this.open = true;
    this.endAt = performance.now();
  }

  report(reset = false): PerfReport {
    const r = this.renderer;
    const out: PerfReport = {
      window: this.recorder.stats(WINDOW_S), all: this.recorder.stats(1e9),
      tilesPending: r.tilesPending(), speed: this.speed(), dpr: globalThis.devicePixelRatio || 1, resolution: r.app.renderer.resolution,
      look: this.look, tier: deviceTier(), gl: this.gl, viewport: { w: innerWidth, h: innerHeight }, ua: navigator.userAgent,
    };
    if (reset) this.recorder.reset();
    return out;
  }
}

/** The `?perf=1` read-out: a small box in the top-left corner, refreshed twice a second; copy and reset buttons. */
export function attachPerfOverlay(root: HTMLElement, perf: FramePerf, strings: Strings): void {
  const box = document.createElement("div");
  box.className = "hud-perf";
  const pre = document.createElement("pre");
  const bar = document.createElement("div");
  const copy = document.createElement("button");
  copy.textContent = strings.t("perf.copy");
  const reset = document.createElement("button");
  reset.textContent = strings.t("perf.reset");
  bar.append(copy, reset);
  box.append(pre, bar);
  root.append(box);
  const L = (k: string) => strings.t(`perf.${k}`);
  const show = () => {
    const r = perf.report();
    const w = r.window;
    pre.textContent = [
      strings.t("perf.title", { s: WINDOW_S, n: w.frames }),
      perfLine(L("frame"), w.frame), `${L("slow")} ${Math.round(w.over33 * 100)} %  ${L("dropped")} ${Math.round(w.droppedMs)}`,
      perfLine(L("sim"), w.sim), perfLine(L("know"), w.know), perfLine(L("ui"), w.ui), perfLine(L("draw"), w.draw), perfLine(L("gpu"), w.gpu),
      `${L("steps")} ${w.steps.avg.toFixed(1)}/${w.steps.max}`,
      `${L("tiles")} ${r.tilesPending}  ${L("speed")} ${r.speed}x`,
      `dpr ${r.dpr.toFixed(2)}  res ${r.resolution}  ${r.look}  ${r.tier.phone ? "phone" : r.tier.strong ? "strong" : "desk"}/${r.tier.workers}w`,
      r.gl.slice(0, 40),
    ].join("\n");
  };
  copy.addEventListener("click", () => {
    const json = JSON.stringify(perf.report(), null, 1);
    const done = () => { copy.textContent = strings.t("perf.copied"); setTimeout(() => { copy.textContent = strings.t("perf.copy"); }, 1500); };
    navigator.clipboard?.writeText(json).then(done, () => { pre.textContent = json; });
  });
  reset.addEventListener("click", () => { perf.recorder.reset(); show(); });
  let lastTap = 0;
  pre.addEventListener("pointerdown", (e) => { if (e.timeStamp - lastTap < 350) { perf.recorder.reset(); show(); } lastTap = e.timeStamp; });
  setInterval(show, REFRESH_MS);
  show();
}
