/**
 * PixiJS battle renderer. READS simulation state and events; NEVER writes simulation state (SPEC 4.2).
 *
 * Interpolation: the simulation runs at a fixed 60 Hz while the screen may refresh at any rate. The app
 * calls `capturePrevious` before each step; `draw(alpha)` blends previous and current positions.
 */
import { Application, Container, Graphics, Text } from "pixi.js";
import { DT, type Catalog, type EntityId, type MapDef, type NavGrid, type SimEvent, type SimView } from "@tcs/sim";
import { Sprite, Texture } from "pixi.js";
import { buildTerrain } from "./terrain";
import { fitCamera, worldToScreen, type Camera, type Insets } from "./camera";

/** Below this many pixels per metre the map is shown as an overview with unit symbols. */
export const OVERVIEW_SCALE = 0.35;

/** Colours per side INDEX (scenario order), never per faction. */
export const SIDE_COLOURS = [0x3b82f6, 0xef4444, 0x22c55e, 0xeab308];
const GROUND = 0x2b3a2a;
const GRID = 0x3a4b38;

export interface Overlay {
  /** Side whose own units are fully shown (waypoints etc.). */
  playerSide: string;
  selectedUnit: EntityId | null;
  /** Debug drawing: entity IDs, all sides' waypoints. */
  debug: boolean;
}

/** A short-lived mark where a projectile struck. */
interface Puff { x: number; y: number; untilTick: number; result: "stopped" | "penetrated" | "ricochet" | "flash" }
const FLASH_TICKS = 5;
const PUFF_TICKS = 24;
const MAX_PUFFS = 600;
/** Most non-tracer bullets drawn per frame (they are nearly invisible anyway). */
const MAX_FAINT = 4000;

interface Marker { x: number; y: number; untilTick: number; seq: number; delivered: boolean }

export class BattleRenderer {
  readonly app: Application;
  camera: Camera = { x: 0, y: 0, scale: 1 };
  /** World-space layer (metres); the camera moves and scales it. */
  private worldLayer = new Container();
  private terrain: Container | null = null;
  private navOverlay: Sprite | null = null;
  private world = new Graphics();
  private units = new Graphics();
  private labels = new Container();
  private prev = new Map<EntityId, { x: number; y: number }>();
  private markers: Marker[] = [];
  private puffs: Puff[] = [];
  /** Per ammunition index: is it a tracer, and how far does the trace burn (m). */
  private tracer: boolean[] = [];
  private burnoutM: number[] = [];
  private labelPool: Text[] = [];

  private constructor(app: Application) {
    this.app = app;
    app.stage.addChild(this.worldLayer, this.world, this.units, this.labels);
  }

  static async create(host: HTMLElement): Promise<BattleRenderer> {
    const app = new Application();
    await app.init({
      resizeTo: host,
      background: GROUND,
      antialias: true,
      autoDensity: true,
      resolution: Math.min(globalThis.devicePixelRatio || 1, 2),
      preference: "webgl",
    });
    host.appendChild(app.canvas);
    return new BattleRenderer(app);
  }

  get width(): number { return this.app.renderer.width / this.app.renderer.resolution; }
  get height(): number { return this.app.renderer.height / this.app.renderer.resolution; }

  /** Build the terrain picture for a map (once per map). */
  setMap(map: MapDef, catalog: Catalog): void {
    if (this.terrain) { this.worldLayer.removeChild(this.terrain); this.terrain.destroy({ children: true, texture: true }); }
    this.tracer = catalog.ammoIds.map((id) => catalog.ammo[id]!.tracer);
    this.burnoutM = catalog.ammoIds.map((id) => catalog.ammo[id]!.tracerBurnoutM ?? 600);
    this.terrain = buildTerrain(map, catalog.terrain);
    this.worldLayer.addChild(this.terrain);
  }

  /**
   * Debug overlay of a navigation grid: red = blocked (buildings, deep water), orange = walls/fences/hedges
   * (crossing costs time), yellow = slow ground (cost > 1.2). Pass null to remove it.
   */
  setNavOverlay(nav: NavGrid | null): void {
    if (this.navOverlay) { this.worldLayer.removeChild(this.navOverlay); this.navOverlay.destroy({ texture: true }); this.navOverlay = null; }
    if (!nav) return;
    const canvas = document.createElement("canvas");
    canvas.width = nav.cols; canvas.height = nav.rows;
    const ctx = canvas.getContext("2d")!;
    const img = ctx.createImageData(nav.cols, nav.rows);
    for (let i = 0; i < nav.cost.length; i++) {
      const o = i * 4, k = nav.cost[i]!;
      if (k <= 0) { img.data[o] = 230; img.data[o + 1] = 40; img.data[o + 2] = 40; img.data[o + 3] = 150; }
      else if (nav.wall[i] === 1) { img.data[o] = 255; img.data[o + 1] = 150; img.data[o + 2] = 0; img.data[o + 3] = 200; }
      else if (k > 1.2) { img.data[o] = 255; img.data[o + 1] = 230; img.data[o + 2] = 0; img.data[o + 3] = Math.min(140, 40 + (k - 1.2) * 120); }
    }
    ctx.putImageData(img, 0, 0);
    const tex = Texture.from(canvas);
    tex.source.scaleMode = "nearest";
    this.navOverlay = new Sprite(tex);
    this.navOverlay.width = nav.cols * nav.cellM;
    this.navOverlay.height = nav.rows * nav.cellM;
    this.worldLayer.addChild(this.navOverlay);
  }

  /** Centre the camera on a point showing `widthM` metres across the free area. */
  focus(x: number, y: number, widthM: number, insets?: Insets): void {
    const top = insets?.top ?? 0, bottom = insets?.bottom ?? 0;
    const scale = this.width / widthM;
    const cy = top + (this.height - top - bottom) / 2;
    this.camera = { scale, x: x - this.width / 2 / scale, y: y - cy / scale };
  }

  fitToMap(map: MapDef, insets?: Insets): void {
    this.camera = fitCamera(map.widthM, map.heightM, this.width, this.height, insets);
  }

  /** Remember positions before a simulation step (for interpolation). */
  capturePrevious(state: SimView): void {
    for (const [id, t] of state.transform.entries()) {
      const p = this.prev.get(id);
      if (p) { p.x = t.x; p.y = t.y; } else this.prev.set(id, { x: t.x, y: t.y });
    }
  }

  /** Feed events (e.g. to show where an order was sent). */
  onEvents(events: readonly SimEvent[], state: SimView, overlay: Overlay): void {
    for (const e of events) {
      if (e.kind === "order.received" && e.issuer === overlay.playerSide) {
        const p = state.pendingOrders.find((o) => o.seq === e.seq);
        const wp = p && p.order.kind === "move" ? p.order.waypoints.at(-1) : undefined;
        if (wp) this.markers.push({ x: wp.x, y: wp.y, seq: e.seq, untilTick: e.deliverTick + 120, delivered: false });
      } else if (e.kind === "order.delivered") {
        for (const m of this.markers) if (m.seq === e.seq) m.delivered = true;
      } else if (e.kind === "shot.fired") {
        if (this.puffs.length >= MAX_PUFFS) this.puffs.shift();
        this.puffs.push({ x: e.x, y: e.y, untilTick: e.tick + FLASH_TICKS, result: "flash" });
      } else if (e.kind === "impact") {
        if (this.puffs.length >= MAX_PUFFS) this.puffs.shift();
        this.puffs.push({ x: e.x, y: e.y, untilTick: e.tick + PUFF_TICKS, result: e.result });
      }
    }
    this.markers = this.markers.filter((m) => m.untilTick > state.tick);
    if (this.puffs.some((p) => p.untilTick <= state.tick)) this.puffs = this.puffs.filter((p) => p.untilTick > state.tick);
  }

  draw(state: SimView, map: MapDef, alpha: number, overlay: Overlay): void {
    const c = this.camera;
    this.drawGround(map);
    const g = this.units;
    g.clear();
    const sideIndex = new Map(state.sides.map((s, i) => [s.id, i]));
    const r = Math.max(3, 0.6 * c.scale); // a man is ~0.6 m radius; never smaller than 3 px

    // Waypoint lines (own side; all sides in debug).
    for (const [id, m] of state.mover.entries()) {
      if (m.waypoints.length === 0) continue;
      const ident = state.identity.get(id);
      if (!ident || (!overlay.debug && ident.side !== overlay.playerSide)) continue;
      const p = this.pos(state, id, alpha);
      let a = worldToScreen(c, p.x, p.y);
      for (const w of m.waypoints) {
        const b = worldToScreen(c, w.x, w.y);
        g.moveTo(a.x, a.y).lineTo(b.x, b.y);
        a = b;
      }
      g.stroke({ width: 1, color: 0xffffff, alpha: 0.25 });
    }

    // Order markers: hollow while the order is still on its way, filled once acknowledged.
    for (const m of this.markers) {
      const s = worldToScreen(c, m.x, m.y);
      g.circle(s.x, s.y, 8).stroke({ width: 2, color: 0xffffff, alpha: 0.8 });
      if (m.delivered) g.circle(s.x, s.y, 3).fill({ color: 0xffffff, alpha: 0.8 });
    }

    this.drawProjectiles(g, state, alpha, overlay);
    // Overview zoom (far out): one infantry symbol per top-level unit instead of individual men.
    let label = 0;
    if (c.scale < OVERVIEW_SCALE) {
      for (const [uid, u] of state.unit.entries()) {
        if (u.parent !== null) continue;
        let sx = 0, sy = 0, n = 0;
        const walk = (x: EntityId) => {
          const uu = state.unit.get(x);
          if (!uu) return;
          for (const m of uu.members) { const p = this.pos(state, m, alpha); sx += p.x; sy += p.y; n++; }
          for (const ch of uu.children) walk(ch);
        };
        walk(uid);
        if (n === 0) continue;
        const s = worldToScreen(c, sx / n, sy / n);
        const colour = SIDE_COLOURS[(sideIndex.get(u.side) ?? 0) % SIDE_COLOURS.length]!;
        const w = 22, h = 15;
        g.rect(s.x - w / 2, s.y - h / 2, w, h).fill({ color: 0x10140f, alpha: 0.75 }).stroke({ width: 2, color: colour });
        g.moveTo(s.x - w / 2, s.y - h / 2).lineTo(s.x + w / 2, s.y + h / 2).moveTo(s.x + w / 2, s.y - h / 2).lineTo(s.x - w / 2, s.y + h / 2).stroke({ width: 1.5, color: colour });
        if (overlay.selectedUnit === uid) g.rect(s.x - w / 2 - 3, s.y - h / 2 - 3, w + 6, h + 6).stroke({ width: 2, color: 0xffffff });
        this.label(label++, u.callsign, s.x + w / 2 + 4, s.y - 7, colour);
      }
      for (let i = label; i < this.labelPool.length; i++) this.labelPool[i]!.visible = false;
      return;
    }
    // Soldiers.
    for (const [id, ident] of state.identity.entries()) {
      const p = this.pos(state, id, alpha);
      const t = state.transform.req(id);
      const s = worldToScreen(c, p.x, p.y);
      const colour = SIDE_COLOURS[(sideIndex.get(ident.side) ?? 0) % SIDE_COLOURS.length]!;
      const selected = overlay.selectedUnit !== null && unitIsOrContains(state, overlay.selectedUnit, ident.unit);
      // Posture: full disc standing, smaller crouching, a flat oval along the heading when prone.
      const sol = state.soldier.get(id);
      const posture = sol?.posture ?? "standing";
      const pr = posture === "crouching" ? r * 0.8 : r;
      if (selected) g.circle(s.x, s.y, pr + 4).stroke({ width: 2, color: 0xffffff });
      if (posture === "prone") {
        const ux = Math.cos(t.heading), uy = Math.sin(t.heading);
        const L = r * 1.5, Wd = r * 0.6;
        g.poly([s.x + ux * L, s.y + uy * L, s.x - uy * Wd, s.y + ux * Wd, s.x - ux * L, s.y - uy * L, s.x + uy * Wd, s.y - ux * Wd]).fill({ color: colour });
      } else {
        g.circle(s.x, s.y, pr).fill({ color: colour });
      }
      if (sol?.postureTo) g.circle(s.x, s.y, pr + 2).stroke({ width: 1, color: 0xffffff, alpha: 0.6 });
      const hx = Math.cos(t.heading) * (r + 4), hy = Math.sin(t.heading) * (r + 4);
      g.moveTo(s.x, s.y).lineTo(s.x + hx, s.y + hy).stroke({ width: 2, color: colour });
      const unit = state.unit.get(ident.unit);
      if (unit && unit.leader === id && c.scale > 0.5) {
        this.label(label++, unit.callsign, s.x + r + 4, s.y - r - 14, colour);
      }
      if (overlay.debug && sol && c.scale > 1.5) { // only when zoomed in enough to read
        // Debug: id, fatigue and heart rate per man.
        this.label(label++, `${id} f${sol.physical.fatigue.toFixed(2)} ${Math.round(sol.physical.heartRateBpm)}bpm`, s.x + r + 2, s.y + 2, 0xffffff);
      }
    }
    for (let i = label; i < this.labelPool.length; i++) this.labelPool[i]!.visible = false;
  }

  /**
   * Bullets in flight and impact marks (owner decision 2026-11-11): tracer rounds as clear streaks, all other
   * bullets as very faint streaks (clear in the debug view), plus a puff where each one strikes.
   */
  private drawProjectiles(g: Graphics, state: SimView, alpha: number, overlay: Overlay): void {
    const c = this.camera, W = this.width, H = this.height;
    for (const p of this.puffs) {
      const sx = (p.x - c.x) * c.scale, sy = (p.y - c.y) * c.scale;
      if (sx < -10 || sy < -10 || sx > W + 10 || sy > H + 10) continue;
      if (p.result === "flash") { // muzzle flash: brief and bright
        g.circle(sx, sy, Math.max(2.5, 0.5 * c.scale)).fill({ color: 0xfff2b0, alpha: 0.9 });
        continue;
      }
      const age = 1 - (p.untilTick - state.tick) / PUFF_TICKS; // 0 new .. 1 gone
      const colour = p.result === "ricochet" ? 0xffe27a : p.result === "penetrated" ? 0xffffff : 0xcdb894;
      g.circle(sx, sy, 1.5 + 4 * age).fill({ color: colour, alpha: 0.55 * (1 - age) });
    }
    const P = state.projectiles;
    if (P.count === 0) return;
    const back = (1 - alpha) * DT; // the picture is drawn between two simulation ticks
    for (let pass = 0; pass < 2; pass++) {
      const wantTracer = pass === 0;
      let drawn = 0;
      for (let i = 0; i < P.count; i++) {
        const isTracer = this.tracer[P.ammo[i]!] === true
          && ((state.tick - P.bornTick[i]!) / 60) * 800 < this.burnoutM[P.ammo[i]!]! && state.tick - P.bornTick[i]! >= 2;
        if (isTracer !== wantTracer) continue;
        const vx = P.vx[i]!, vy = P.vy[i]!;
        const sx = (P.x[i]! - vx * back - c.x) * c.scale, sy = (P.y[i]! - vy * back - c.y) * c.scale;
        if (sx < -40 || sy < -40 || sx > W + 40 || sy > H + 40) continue;
        if (!wantTracer && ++drawn > MAX_FAINT) break;
        // Streak: where the bullet was over the last ~1/80 s, at least a few pixels long.
        const speed = Math.hypot(vx, vy) || 1;
        const len = Math.max(wantTracer ? 6 : 4, speed * 0.0125 * c.scale);
        g.moveTo(sx, sy).lineTo(sx - (vx / speed) * len, sy - (vy / speed) * len);
      }
      if (wantTracer) g.stroke({ width: 2, color: 0xffb347, alpha: 0.95 });
      else g.stroke({ width: 1, color: 0xffffff, alpha: overlay.debug ? 0.7 : 0.28 });
    }
  }

  private label(i: number, text: string, x: number, y: number, colour: number): void {
    let t = this.labelPool[i];
    if (!t) {
      t = new Text({ text, style: { fontFamily: "system-ui, sans-serif", fontSize: 12, fill: colour } });
      this.labelPool.push(t);
      this.labels.addChild(t);
    }
    if (t.text !== text) t.text = text;
    t.style.fill = colour;
    t.visible = true;
    t.position.set(Math.round(x), Math.round(y));
  }

  private pos(state: SimView, id: EntityId, alpha: number): { x: number; y: number } {
    const t = state.transform.req(id);
    const p = this.prev.get(id);
    if (!p) return t;
    return { x: p.x + (t.x - p.x) * alpha, y: p.y + (t.y - p.y) * alpha };
  }

  private drawGround(map: MapDef): void {
    const c = this.camera;
    this.worldLayer.scale.set(c.scale);
    this.worldLayer.position.set(-c.x * c.scale, -c.y * c.scale);
    const g = this.world;
    g.clear();
    if (this.terrain) {
      // Terrain picture present: only a thin map border.
      const tl = worldToScreen(c, 0, 0);
      g.rect(tl.x, tl.y, map.widthM * c.scale, map.heightM * c.scale).stroke({ width: 2, color: 0x1f2a1d });
      return;
    }
    const tl = worldToScreen(c, 0, 0);
    g.rect(tl.x, tl.y, map.widthM * c.scale, map.heightM * c.scale).fill({ color: 0x324530 });
    // Grid every 50 m (every 500 m when zoomed far out).
    const step = c.scale < 0.4 ? 500 : 50;
    for (let x = 0; x <= map.widthM; x += step) {
      const a = worldToScreen(c, x, 0), b = worldToScreen(c, x, map.heightM);
      g.moveTo(a.x, a.y).lineTo(b.x, b.y);
    }
    for (let y = 0; y <= map.heightM; y += step) {
      const a = worldToScreen(c, 0, y), b = worldToScreen(c, map.widthM, y);
      g.moveTo(a.x, a.y).lineTo(b.x, b.y);
    }
    g.stroke({ width: 1, color: GRID });
    g.rect(tl.x, tl.y, map.widthM * c.scale, map.heightM * c.scale).stroke({ width: 2, color: 0x6b7f69 });
  }
}

function unitIsOrContains(state: SimView, ancestor: EntityId, unit: EntityId): boolean {
  let u: EntityId | null = unit;
  while (u !== null) {
    if (u === ancestor) return true;
    u = state.unit.get(u)?.parent ?? null;
  }
  return false;
}
