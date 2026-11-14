/**
 * PixiJS battle renderer. READS simulation state and events; NEVER writes simulation state (SPEC 4.2).
 *
 * Interpolation: the simulation runs at a fixed 60 Hz while the screen may refresh at any rate. The app
 * calls `capturePrevious` before each step; `draw(alpha)` blends previous and current positions.
 */
import { Application, Container, Graphics, Text } from "pixi.js";
import { DT, floorAtZ, type Catalog, type EntityId, type MapDef, type NavGrid, type SimEvent, type SimView, type SoldierState, type DeepReadonly } from "@tcs/sim";
import { BufferImageSource, Sprite, Texture, TilingSprite } from "pixi.js";
import { lookOf, type Appearance } from "@tcs/data";
import { buildTerrain } from "./terrain";
import { fitCamera, worldToScreen, type Camera, type Insets } from "./camera";
import { placeLabels, shownCallsigns, type LabelRequest, type Rect } from "./labels";
import { flatColours, paintRegion } from "./flat/paint";
import { TerrainTiles, WorkerSource, basePpm, photoBasePpm, type TerrainTilesOptions } from "./terrain-tiles";
import { TileQueue } from "./tile-queue";
import { PhotoPainter, photoInit } from "./photo/paint";
import { contactShadow, grainTile, scorchDecal } from "./photo/decals";
import { shadowOffset } from "./photo/light";
import { BuildingLayers, interiorGraphOverlay } from "./buildings";
import { LOD_CLOSE, LOD_DOTS, LOD_FIGURE, LOD_SYMBOLS, lodFor, type Lod } from "./lod";
import { CELL, PIVOT, SoldierAtlas, facingOf, weaponLook, type FrameKey, type WeaponLook } from "./sprites/atlas";
import { SPRITE_M, type FrameId } from "./sprites/soldier-art";

/** Classic look (`?look=classic`, kept for one milestone): below this many px/m the overview with unit symbols. */
export const OVERVIEW_SCALE = 0.35;

/**
 * "photo" (the default from the photo plan: the map like a soft, low-resolution aerial photograph), "flat" (M7.5b:
 * the flat pixel map; `?look=pixel` is its old name) or the classic look before them. Pixel soldiers, roofs that
 * fade and the zoom levels belong to both photo and flat (`look !== "classic"`).
 */
export type Look = "photo" | "flat" | "classic";

/** The flat look's tiles: today's M7.5b map (64 m detail tiles at 4 px/m from the figure zoom, painted here). */
const FLAT_TILES: TerrainTilesOptions = {
  levels: [{ tileM: 64, ppm: 4, minPx: 0 }], sampling: "nearest", mipmaps: false, budgetBytes: 48 * 256 * 256 * 4, fadeFrames: 0,
  dpr: 1, maxLevel: 1, byBand: true, strips: 0, stripPpm: 1, maxInFlight: 1, maxUploads: 1,
};

/**
 * What this device can afford (plan "photo" decision 5, review fix). A phone or tablet (no fine pointer) is never the
 * strong tier, whatever cores and memory it reports (mid-range Android reports 8 cores and 4-8 GB): one worker, the
 * small budget, and levels chosen by CSS px per metre rather than device px, so it paints fewer, coarser tiles while
 * zoomed out, but its 8 px/m tiles start at the opening zoom (they started at 11 device px/m and were cut off on
 * phones, which left the figure and close zooms a smear on every iPhone). Desktop: strong with > 4 cores and > 2 GB
 * (unknown memory counts as 8).
 */
export function deviceTier(): { phone: boolean; strong: boolean; workers: number } {
  const nav = (globalThis as { navigator?: { hardwareConcurrency?: number; deviceMemory?: number } }).navigator;
  const cores = nav?.hardwareConcurrency ?? 4;
  const fine = typeof globalThis.matchMedia === "function" && globalThis.matchMedia("(pointer: fine)").matches;
  if (!fine) return { phone: true, strong: false, workers: 1 };
  const mem = nav?.deviceMemory ?? 8;
  return { phone: false, strong: cores > 4 && mem > 2, workers: cores <= 4 ? 1 : 2 };
}

/** The photo look's tile options for a device tier (budgets count the GPU texture and the CPU copy of each tile). */
export function photoTileOptions(map: MapDef, tier: { phone: boolean; strong: boolean }, dpr: number): TerrainTilesOptions {
  return {
    levels: tier.phone
      ? [{ tileM: 128, ppm: 2, minPx: 2 }, { tileM: 64, ppm: 4, minPx: 3.5 }, { tileM: 32, ppm: 8, minPx: 7 }]
      : [{ tileM: 128, ppm: 2, minPx: 2 }, { tileM: 64, ppm: 4, minPx: 4.5 }, { tileM: 32, ppm: 8, minPx: 11 }],
    sampling: "linear", mipmaps: true, budgetBytes: (tier.strong ? 40 : tier.phone ? 20 : 28) * 1024 * 1024, fadeFrames: 9,
    dpr: tier.phone ? 1 : dpr, pixelRatio: dpr, maxLevel: tier.strong || tier.phone ? 3 : 2, byBand: false, strips: 4, stripPpm: photoBasePpm(map),
    maxInFlight: 4, maxUploads: 2, contourAlphas: [0.3, 0.5], vectorContours: true,
  };
}
/** Ticks a man shows his firing frame after a shot. */
const FIRE_FRAME_TICKS = 6;

/** Colours per side INDEX (scenario order), never per faction. */
export const SIDE_COLOURS = [0x3b82f6, 0xef4444, 0x22c55e, 0xeab308];
const GROUND = 0x2b3a2a;
const GRID = 0x3a4b38;

export interface Overlay {
  /** Side whose own units are fully shown (waypoints etc.). */
  playerSide: string;
  selectedUnit: EntityId | null;
  /** Debug drawing: entity IDs, all sides' waypoints — and the enemy as he really is (no fog of war). */
  debug: boolean;
  /** Screenshots (M7.5e): the enemy as he really is, without Debug's other drawing. */
  reveal?: boolean;
  /**
   * Fog of war (M3.4): what the player's side knows of the enemy (from `sideKnowledge`). When given and debug is
   * off, enemy soldiers, their muzzle flashes and hits on them are not drawn; these contacts are drawn instead.
   */
  known?: readonly {
    target: EntityId; x: number; y: number; errM: number; kind: "seen" | "heard" | "reported"; ageS: number; /** Known to have surrendered (M6.6). */ surrendered?: boolean;
    /** A vehicle (M7.3): drawn as a hull outline, its type's size once identified (owner Q6), facing as last seen. */
    cls?: "vehicle"; vtype?: string; heading?: number;
  }[] | null;
  /** Debug, a vehicle selected (M7.3): its turret, target and reasons (text lines), and where its stations aim. */
  vehicleDebug?: { vehicle: EntityId; lines: string[]; targets: { x: number; y: number }[] } | null;
  /** The order being planned (M5): route with its pace per leg, the formation marker with its handles. */
  plan?: PlanOverlay | null;
  /** Objectives (M6) as the player's side sees them (holders are public: who stands on them is visible). */
  objectives?: readonly { x: number; y: number; radiusM: number; holder: string | null; contested: boolean; label: string }[];
  /** After-action heat map (M6): shots as (x, y, side index) triples, men fallen as (x, y, side index). */
  heat?: { shots: readonly number[]; falls: readonly number[] } | null;
  /** The floor shown in buildings (M7.5d floor switch; 0 / absent = ground). Men inside on another floor are
   *  drawn faint with a floor badge. */
  floor?: number;
  /** Order gestures on the map (the "controls" step): see GestureOverlay. */
  gesture?: GestureOverlay | null;
  /**
   * S7 (the "map-feel" step): one line per own unit on the move, faint, to its destination (the selected unit's
   * bright, along its route ahead), and fire missions from the caller to the target in their own colour. Given (and
   * Debug off), these replace the selected leaders' route lines.
   */
  intents?: readonly IntentLineView[] | null;
  /**
   * S8: "last seen" pins of lost contacts, with their age label (string table). Given, a contact seen or reported
   * longer ago than `PIN_AFTER_S` is drawn only as its pin (or not at all once its spot was seen empty).
   */
  pins?: readonly { target: EntityId; x: number; y: number; label: string; cls?: "vehicle"; vtype?: string; heading?: number }[] | null;
}

/** A line of the S7 overlay (see Overlay.intents). */
export interface IntentLineView {
  x0: number; y0: number; x1: number; y1: number; kind: "move" | "fire"; selected: boolean;
  route?: readonly { x: number; y: number }[];
  /** A fire mission (S11): its phase and where its ranging rounds fell (oldest first). */
  phase?: "called" | "ranging" | "effect";
  falls?: readonly { x: number; y: number; seen: boolean }[];
}

/** S8: a known contact unseen this long (s) is a "last seen" pin (when the app gives pins). */
export const PIN_AFTER_S = 6;

/**
 * Order gestures (owner choices S1, S2, S9, S10): the selected unit's active move marker (drag it to re-target, onto
 * the unit to halt), its facing handle while halted, the line-of-sight preview of a fire order being held, and a
 * cancel mark while the pointer is back on the unit (releasing there sends nothing, or Halt for a marker).
 */
export interface GestureOverlay {
  marker?: { x: number; y: number; from: { x: number; y: number } | null; dragging: boolean } | null;
  facing?: { centre: { x: number; y: number }; handle: { x: number; y: number }; dragging: boolean } | null;
  los?: readonly { x0: number; y0: number; x1: number; y1: number; stopAt: number; clear: boolean }[] | null;
  target?: { x: number; y: number } | null;
  cancelAt?: { x: number; y: number } | null;
  /** The man whose detail box is open (S6, the "bar-card" step): a ring round him. */
  man?: { x: number; y: number } | null;
  /** S11: the point held for fire support (while it is held and its pop-up is open), joined to the caller. */
  support?: { x: number; y: number; from: { x: number; y: number } | null } | null;
}

export interface PlanOverlay {
  kind: "move" | "assault" | "withdraw";
  from: { x: number; y: number };
  points: readonly { x: number; y: number; mode: string }[];
  marker: { centre: { x: number; y: number }; men: readonly { x: number; y: number }[]; arrowTip: { x: number; y: number }; rotate: { x: number; y: number }; resize: { x: number; y: number } | null } | null;
  /** A move being dragged out from the unit (S1) or a turn in place (S9): no handles, no route points. */
  ghost?: boolean;
}

/** S7: the lines to where own units go (pale), and fire missions (amber); S8: the pins' age labels. */
const INTENT_COLOUR = 0xeef3e2;
const FIRE_COLOUR = 0xffa23a;
const PIN_LABEL_COLOUR = 0xd9cfc4;

/** Colour of a route leg by its pace. */
const PACE_COLOURS: Record<string, number> = { walk: 0xffffff, run: 0xffc23d, sneak: 0x7fd7ff, crawl: 0xb08cff };

/** A short-lived mark where a projectile struck. */
interface Puff { x: number; y: number; untilTick: number; result: "stopped" | "penetrated" | "ricochet" | "flash" | "hit" }
const FLASH_TICKS = 5;
const BURST_TICKS = 50;
const PUFF_TICKS = 24;
const MAX_PUFFS = 600;
/** Most non-tracer bullets drawn per frame (they are nearly invisible anyway). */
const MAX_FAINT = 4000;

interface Marker { x: number; y: number; untilTick: number; seq: number; delivered: boolean }

export class BattleRenderer {
  readonly app: Application;
  camera: Camera = { x: 0, y: 0, scale: 1 };
  /** The ground floor's label on floor badges (M7.5 review fix, Rule 12: set by the app from "ui.floor.ground"). */
  groundFloorLabel = "";
  /** World-space layer (metres); the camera moves and scales it. */
  private worldLayer = new Container();
  private terrain: Container | null = null;
  private navOverlay: Sprite | null = null;
  private interiorOverlay: Graphics | null = null;
  private sightOverlay: Sprite | null = null;
  private world = new Graphics();
  private units = new Graphics();
  private labels = new Container();
  private prev = new Map<EntityId, { x: number; y: number }>();
  private markers: Marker[] = [];
  private puffs: Puff[] = [];
  /** Per ammunition index: is it a tracer, and how far does the trace burn (m). */
  private tracer: boolean[] = [];
  private burnoutM: number[] = [];
  /** Per ammunition index: 1 = a grenade or shell (drawn as a dot), 2 = a fragment (not drawn). */
  private special: number[] = [];
  private bursts: { x: number; y: number; untilTick: number; radiusM: number }[] = [];
  private labelPool: Text[] = [];
  /** This frame's label requests (M7.5a: placed by `placeLabels`, never overlapping). */
  private reqs: LabelRequest[] = [];
  private nReqs = 0;
  /** Vehicle label requests by vehicle entity this frame (a dismounted squad near its vehicle joins its label). */
  private vehReq = new Map<EntityId, number>();
  /** Callsigns as shown (duplicates told apart, review fix), rebuilt when the number of units changes. */
  private shown = new Map<EntityId, string>();
  private shownFor = -1;
  private shownStore: unknown = null;
  private callsign(uid: EntityId): string { return this.shown.get(uid) ?? ""; }
  /** Uniform tones and vehicle paint (M7.5a), outside the catalog. */
  private appearance: Appearance | null = null;
  private hudRects: Rect[] = [];
  /** Vehicle types (hull and turret boxes) from the catalog. */
  private vehicleDefs: Catalog["vehicles"] = {};
  /** M7.5b: the look, the zoom level shown last, the flat map, building floors and roofs, the soldier sprites. */
  private look: Look = "photo";
  private lod: Lod | null = null;
  private contoursAlways = false;
  private tiles: TerrainTiles | null = null;
  private bld: BuildingLayers | null = null;
  /** Men sprites (screen space) between the floors and the roofs; roofs follow the camera like the map. */
  private menLayer = new Container();
  private roofLayer = new Container();
  /**
   * Photo look (plan "photo", step "polish"): under the men, in screen space — wreck scorch decals, soft contact
   * shadows of the men, then their dark outer rims. Pools, hidden when unused; empty in the flat and classic looks.
   */
  private shadowLayer = new Container();
  private scorchC = new Container();
  private contactC = new Container();
  private rimC = new Container();
  private contacts: Sprite[] = [];
  private rims: Sprite[] = [];
  private scorches: Sprite[] = [];
  private nScorch = 0;
  private decalTex: { contact: Texture; scorch: Texture; grain: Texture } | null = null;
  /** Close-zoom grain over the photo map (world-anchored, fades in from GRAIN_FROM px/m). */
  private grain: TilingSprite | null = null;
  private atlas: SoldierAtlas | null = null;
  private figures: Sprite[] = [];
  private outlines: Sprite[] = [];
  private nSprites = 0;
  private key: FrameKey = { frame: "stand", weapon: "rifle", launcher: false, firing: false, wounded: false, facing: 0 };
  /** Last shot per shooter (from `shot.fired` events): the firing frame. */
  private firedAt = new Map<EntityId, number>();
  /** Weapon type per weapon id, and which ids are anti-tank launchers (carried on the back). */
  private weaponType: Record<string, string> = {};
  private launchers = new Set<string>();
  private carriesLauncher = new Map<EntityId, { tick: number; yes: boolean }>();
  private roofMen = new Float64Array(64);
  private map: MapDef | null = null;
  private insets: Insets = { top: 0, right: 0, bottom: 0, left: 0 };

  private constructor(app: Application) {
    this.app = app;
    this.shadowLayer.addChild(this.scorchC, this.contactC, this.rimC);
    app.stage.addChild(this.worldLayer, this.shadowLayer, this.menLayer, this.roofLayer, this.world, this.units, this.labels);
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

  /**
   * A renderer without a canvas or WebGL (M7.3: the render-cost test draws into it; Pixi builds its geometry in
   * plain JavaScript). Nothing is shown; `setCatalog` instead of `setMap` (no terrain picture).
   */
  static headless(width: number, height: number): BattleRenderer {
    const fake = { stage: new Container(), renderer: { width, height, resolution: 1 } } as unknown as Application;
    return new BattleRenderer(fake);
  }

  /** Screen size in CSS px: Pixi 8's `renderer.width` is already in CSS px (not device px), whatever the resolution. */
  get width(): number { return this.app.renderer.width; }
  get height(): number { return this.app.renderer.height; }

  /** The look (M7.5b): set before `setMap`. */
  setLook(look: Look): void {
    this.look = look; this.lod = null;
    for (const t of this.labelPool) t.destroy(); // (their stroke width depends on the look)
    this.labelPool = [];
  }

  /**
   * Stroke the path `draw` makes; in the photo look first a dark under-stroke 2 px wider, so overlay lines read on
   * a textured picture (plan "photo", step "polish"). Pixi starts a new path after each stroke, hence `draw` twice.
   */
  private inked(g: Graphics, draw: () => void, style: { width: number; color: number; alpha?: number }): void {
    if (this.look === "photo") { draw(); g.stroke({ width: style.width + 2, color: UNDER, alpha: 0.3 + 0.3 * (style.alpha ?? 1) }); }
    draw(); g.stroke(style);
  }
  /** S14: contour lines at every zoom (true) or only zoomed out (false, the automatic rule). */
  setContoursAlways(on: boolean): void { this.contoursAlways = on; }
  contoursShown(): boolean { return this.contoursAlways || (this.lod ?? 0) <= LOD_DOTS; }
  getLook(): Look { return this.look; }

  /** The photo look's small textures (contact shadow, wreck scorch, grain), made once. */
  private decals(): { contact: Texture; scorch: Texture; grain: Texture } {
    if (this.decalTex) return this.decalTex;
    const tex = (data: Uint8Array, n: number, mode: "linear" | "nearest", wrap = false) => new Texture({ source: new BufferImageSource({
      resource: data, width: n, height: n, format: "rgba8unorm", alphaMode: "premultiplied-alpha", scaleMode: mode, autoGenerateMipmaps: true,
      ...(wrap ? { addressMode: "repeat" as const } : {}),
    }) });
    this.decalTex = { contact: tex(contactShadow(16), 16, "linear"), scorch: tex(scorchDecal(64), 64, "linear"), grain: tex(grainTile(256), 256, "linear", true) };
    return this.decalTex;
  }
  /** The zoom level shown last (0 symbols, 1 dots, 2 figures, 3 close; M7.5b). */
  zoomLevel(): Lod | null { return this.lod; }

  /** Build the terrain picture for a map (once per map; set the look and the appearance first). */
  setMap(map: MapDef, catalog: Catalog): void {
    if (this.grain) { this.grain.parent?.removeChild(this.grain); this.grain.destroy(); this.grain = null; }
    if (this.terrain) { this.worldLayer.removeChild(this.terrain); this.terrain.destroy({ children: true, texture: true }); this.terrain = null; }
    if (this.tiles) { this.tiles.destroy(); this.tiles = null; }
    this.setCatalog(catalog);
    this.map = map;
    if (this.look === "classic") {
      this.terrain = buildTerrain(map, catalog.terrain);
      this.worldLayer.addChild(this.terrain);
      return;
    }
    const col = flatColours(map, catalog.terrain, this.appearance);
    const flatBase = paintRegion(map, col, 0, 0, map.widthM, map.heightM, basePpm(map));
    if (this.look === "flat") {
      this.tiles = new TerrainTiles(map, flatBase, (j) => paintRegion(map, col, j.x0, j.y0, j.w, j.h, j.ppm), null, FLAT_TILES);
    } else {
      // Photo (plan "photo"): the flat picture at once, the photo whole map in four strips over it, detail tiles by
      // screen px per metre; painted in workers where there are workers (the same code paints here otherwise).
      const init = photoInit(map, catalog.terrain, this.appearance);
      let painter: PhotoPainter | null = null;
      const tier = deviceTier();
      const o = photoTileOptions(map, tier, this.app.renderer.resolution || 1);
      const q = new TileQueue(o.maxInFlight, o.maxUploads);
      let source: WorkerSource | null = null;
      if (typeof Worker !== "undefined") {
        try { source = new WorkerSource(() => new Worker(new URL("./photo/worker.ts", import.meta.url), { type: "module" }), tier.workers, init, q); } catch { source = null; }
      }
      this.tiles = new TerrainTiles(map, flatBase, (j) => (painter ??= new PhotoPainter(init)).paint(j.x0, j.y0, j.w, j.h, j.ppm), source, o, q);
    }
    this.terrain = new Container();
    this.terrain.addChild(this.tiles.root);
    if (this.look === "photo") {
      // Neutral grain for close zoom: 256 px over 16 m, repeated over the map (no paint cost; under the floors).
      this.grain = new TilingSprite({ texture: this.decals().grain, width: map.widthM, height: map.heightM });
      this.grain.tileScale.set(GRAIN_TILE_M / 256);
      this.grain.visible = false;
      this.terrain.addChild(this.grain);
    }
    this.worldLayer.addChild(this.terrain);
    this.setBuildings(map);
  }

  /** Building floors and roofs (M7.5b; also used alone by the headless render-cost test). */
  setBuildings(map: MapDef): void {
    if (this.bld) { this.bld.floors.parent?.removeChild(this.bld.floors); this.bld.upper.parent?.removeChild(this.bld.upper); this.roofLayer.removeChild(this.bld.roofs); this.bld.destroy(); }
    this.map = map;
    this.bld = new BuildingLayers(map, this.appearance, this.look === "photo");
    if (this.terrain) this.terrain.addChild(this.bld.floors, this.bld.upper); else this.worldLayer.addChild(this.bld.floors, this.bld.upper);
    this.roofLayer.addChild(this.bld.roofs);
  }

  /**
   * Paint the detail tiles of the view now (the opening view: the first picture complete). Photo with workers:
   * resolves when they are painted (callers wait with a time limit).
   */
  primeDetail(): Promise<void> {
    const c = this.camera;
    if (!this.tiles) return Promise.resolve();
    return this.tiles.prime({ x: c.x, y: c.y, w: this.width / c.scale, h: this.height / c.scale }, c.scale, lodFor(c.scale, this.lod) >= LOD_FIGURE);
  }

  /** Terrain tiles still to paint or upload (the screenshot tool waits for 0). */
  tilesPending(): number { return this.tiles?.pending() ?? 0; }
  /** Terrain detail level shown last (0 whole map; photo 1..3 = 2, 4, 8 px/m). */
  terrainLevel(): number { return this.tiles?.shownLevel ?? 0; }

  /** Roof alpha of building i (screenshots). */
  roofAlpha(i: number): number { return this.bld?.roofAlpha(i) ?? 1; }

  /** The screen areas the HUD covers (top bar, order bar, sidebar): no label is placed there (M7.5a). */
  setHudInsets(i: Insets): void {
    this.insets = { ...i };
    const W = this.width, H = this.height;
    this.hudRects = [{ x: 0, y: 0, w: W, h: i.top }, { x: 0, y: H - i.bottom, w: W, h: i.bottom }, { x: 0, y: 0, w: i.left, h: H }, { x: W - i.right, y: 0, w: i.right, h: H }].filter((r) => r.w > 0 && r.h > 0);
  }

  /** How factions look (M7.5a: vehicle paint; uniforms from M7.5b). Absent: the neutral look. */
  setAppearance(app: Appearance | null): void { this.appearance = app; }

  /** What the renderer needs to know of the data: ammunition looks and vehicle shapes. */
  setCatalog(catalog: Catalog): void {
    this.tracer = catalog.ammoIds.map((id) => catalog.ammo[id]!.tracer);
    this.burnoutM = catalog.ammoIds.map((id) => catalog.ammo[id]!.tracerBurnoutM ?? 600);
    this.special = catalog.ammoIds.map((id) => (catalog.ammo[id]!.guided ? 3 : catalog.ammo[id]!.explosive ? 1 : catalog.ammo[id]!.kind === "fragment" ? 2 : 0));
    this.vehicleDefs = catalog.vehicles;
    this.weaponType = Object.fromEntries(Object.entries(catalog.weapons).map(([id, w]) => [id, w.type]));
    this.launchers = new Set(Object.entries(catalog.weapons).filter(([, w]) => w.type === "launcher").map(([id]) => id));
  }

  /**
   * Debug overlay of a navigation grid: red = blocked (buildings, deep water), orange = walls/fences/hedges
   * (crossing costs time), yellow = slow ground (cost > 1.2). Pass null to remove it.
   */
  setNavOverlay(nav: NavGrid | null): void {
    if (this.navOverlay) { this.worldLayer.removeChild(this.navOverlay); this.navOverlay.destroy({ texture: true }); this.navOverlay = null; }
    if (this.interiorOverlay) { this.worldLayer.removeChild(this.interiorOverlay); this.interiorOverlay.destroy(); this.interiorOverlay = null; }
    if (!nav) return;
    if (this.map) { this.interiorOverlay = interiorGraphOverlay(this.map); }
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
    if (this.interiorOverlay) this.worldLayer.addChild(this.interiorOverlay);
  }

  /**
   * Debug: what one man can see. `vis` holds one value per cell of a `cols` x `rows` grid of `cellM` cells whose
   * corner is at (x0, y0): 0 = cannot see, 1..255 = how much of a man there he would see. Hidden ground is
   * darkened, partly seen ground tinted.
   */
  setSightOverlay(view: { vis: Uint8Array; cols: number; rows: number; cellM: number; x0: number; y0: number } | null): void {
    if (this.sightOverlay) { this.worldLayer.removeChild(this.sightOverlay); this.sightOverlay.destroy({ texture: true }); this.sightOverlay = null; }
    if (!view) return;
    const canvas = document.createElement("canvas");
    canvas.width = view.cols; canvas.height = view.rows;
    const g = canvas.getContext("2d")!;
    const img = g.createImageData(view.cols, view.rows);
    for (let i = 0; i < view.vis.length; i++) {
      const o = i * 4, v = view.vis[i]! / 255;
      if (v === 0) { img.data[o] = 10; img.data[o + 1] = 10; img.data[o + 2] = 30; img.data[o + 3] = 150; }
      else if (v < 0.5) { img.data[o] = 60; img.data[o + 1] = 60; img.data[o + 2] = 140; img.data[o + 3] = Math.round(110 * (1 - v)); }
    }
    g.putImageData(img, 0, 0);
    const tex = Texture.from(canvas);
    tex.source.scaleMode = "nearest";
    this.sightOverlay = new Sprite(tex);
    this.sightOverlay.x = view.x0; this.sightOverlay.y = view.y0;
    this.sightOverlay.width = view.cols * view.cellM;
    this.sightOverlay.height = view.rows * view.cellM;
    this.worldLayer.addChild(this.sightOverlay);
  }

  /** Pixels per metre at the current zoom. */
  scale(): number { return this.camera.scale; }

  /** Centre the camera on a point showing `widthM` metres across the free area. */
  focus(x: number, y: number, widthM: number, insets?: Insets): void {
    const left = insets?.left ?? 0, right = insets?.right ?? 0;
    this.focusScale(x, y, Math.max(1, this.width - left - right) / widthM, insets);
  }

  /** Centre the camera on a point at `scale` px/m in the free area (never further out than the whole map). */
  focusScale(x: number, y: number, scale: number, insets?: Insets): void {
    const top = insets?.top ?? 0, bottom = insets?.bottom ?? 0, left = insets?.left ?? 0, right = insets?.right ?? 0;
    const cx = left + (this.width - left - right) / 2, cy = top + (this.height - top - bottom) / 2;
    this.camera = this.clampCamera({ scale, x: x - cx / scale, y: y - cy / scale }, insets);
  }

  fitToMap(map: MapDef, insets?: Insets): void {
    this.camera = fitCamera(map.widthM, map.heightM, this.width, this.height, insets);
  }

  /**
   * Zoomed out no further than the whole map in the free area (the parent's review: the overview left the map
   * tiny in the middle). A camera further out becomes the fitted one.
   */
  clampCamera(c: Camera, insets: Insets = this.insets): Camera {
    if (!this.map) return c;
    const fit = fitCamera(this.map.widthM, this.map.heightM, this.width, this.height, insets);
    if (c.scale < fit.scale) return fit;
    // The map stays in view: a map wider than the free area keeps its edges at or beyond it (a 40 px margin); a
    // narrower one is centred.
    const M = 40;
    const axis = (pos: number, lo: number, hi: number, worldM: number) => {
      const free = hi - lo, span = worldM * c.scale;
      if (span + 2 * M <= free) return -(lo + (free - span) / 2) / c.scale;
      const min = -(lo + M) / c.scale, max = worldM - (hi - M) / c.scale;
      return Math.min(max, Math.max(min, pos));
    };
    return { scale: c.scale, x: axis(c.x, insets.left, this.width - insets.right, this.map.widthM), y: axis(c.y, insets.top, this.height - insets.bottom, this.map.heightM) };
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
        this.firedAt.set(e.shooter, e.tick);
        if (!overlay.debug && state.identity.get(e.shooter)?.side !== overlay.playerSide) continue; // fog: an unseen flash
        if (this.puffs.length >= MAX_PUFFS) this.puffs.shift();
        this.puffs.push({ x: e.x, y: e.y, untilTick: e.tick + FLASH_TICKS, result: "flash" });
      } else if (e.kind === "impact") {
        if (this.puffs.length >= MAX_PUFFS) this.puffs.shift();
        this.puffs.push({ x: e.x, y: e.y, untilTick: e.tick + PUFF_TICKS, result: e.result });
      } else if (e.kind === "explosion") {
        this.bursts.push({ x: e.x, y: e.y, untilTick: e.tick + BURST_TICKS, radiusM: Math.max(1.5, e.stunRadiusM * 0.25) });
      } else if (e.kind === "vehicle.hit") {
        // One spark cluster per vehicle and tick (rifle hits come aggregated); a penetration flashes (M7.4a).
        if (e.result === "penetrated") this.bursts.push({ x: e.x, y: e.y, untilTick: e.tick + BURST_TICKS, radiusM: 2 });
        for (let k = 0; k < Math.min(4, e.rounds); k++) {
          if (this.puffs.length >= MAX_PUFFS) this.puffs.shift();
          this.puffs.push({ x: e.x + (k % 2) * 0.4 - 0.2, y: e.y + (k >> 1) * 0.4 - 0.2, untilTick: e.tick + PUFF_TICKS, result: "ricochet" });
        }
      } else if (e.kind === "hit") {
        if (!overlay.debug && state.identity.get(e.target)?.side !== overlay.playerSide) continue;
        const t = state.transform.get(e.target);
        if (t) { if (this.puffs.length >= MAX_PUFFS) this.puffs.shift(); this.puffs.push({ x: t.x, y: t.y, untilTick: e.tick + PUFF_TICKS, result: e.armour === "stopped" ? "ricochet" : "hit" }); }
      }
    }
    this.markers = this.markers.filter((m) => m.untilTick > state.tick);
    if (this.bursts.length > 0) this.bursts = this.bursts.filter((b) => b.untilTick > state.tick);
    if (this.puffs.some((p) => p.untilTick <= state.tick)) this.puffs = this.puffs.filter((p) => p.untilTick > state.tick);
  }

  draw(state: SimView, map: MapDef, alpha: number, overlay: Overlay): void {
    const c = this.camera;
    // Zoom level (M7.5b): the classic look keeps its single overview threshold.
    const lod: Lod = this.look === "classic" ? (c.scale < OVERVIEW_SCALE ? LOD_SYMBOLS : LOD_DOTS) : lodFor(c.scale, this.lod);
    this.lod = lod;
    if (state.unit.size !== this.shownFor || state.unit !== this.shownStore) { this.shown = shownCallsigns(state.unit.entries()); this.shownFor = state.unit.size; this.shownStore = state.unit; }
    this.drawGround(map, lod);
    this.bld?.setFloor(overlay.floor ?? 0);
    this.updateRoofs(state, overlay, lod);
    this.nSprites = 0;
    this.nScorch = 0;
    const g = this.units;
    g.clear();
    this.nReqs = 0;
    this.vehReq.clear();
    const sideIndex = new Map(state.sides.map((s, i) => [s.id, i]));
    const r = Math.max(3, 0.6 * c.scale); // a man is ~0.6 m radius; never smaller than 3 px

    // Route lines. In play only ONE per unit: the way of the leader of the selected unit (and of the leaders
    // of its sub-units) — not a trace for every man (owner, 2026-11-12). Debug shows every man's own path.
    const leaders = new Set<EntityId>();
    if (!overlay.debug && overlay.intents) this.drawIntents(g, overlay.intents);
    else if (!overlay.debug && overlay.selectedUnit !== null) {
      for (const [uid, u] of state.unit.entries()) {
        if (u.leader !== null && u.side === overlay.playerSide && unitIsOrContains(state, overlay.selectedUnit, uid)) leaders.add(u.leader);
      }
    }
    // mounted: ok men aboard have no waypoints
    for (const [id, m] of overlay.debug || !overlay.intents ? state.mover.entries() : []) {
      if (m.waypoints.length === 0) continue;
      if (!overlay.debug && !leaders.has(id)) continue;
      const ident = state.identity.get(id);
      if (!ident) continue;
      const p = this.pos(state, id, alpha);
      this.inked(g, () => {
        let a = worldToScreen(c, p.x, p.y);
        for (const w of m.waypoints) {
          const b = worldToScreen(c, w.x, w.y);
          g.moveTo(a.x, a.y).lineTo(b.x, b.y);
          a = b;
        }
      }, { width: 1, color: 0xffffff, alpha: 0.25 });
    }

    // Order markers: hollow while the order is still on its way, filled once acknowledged.
    for (const m of this.markers) {
      const s = worldToScreen(c, m.x, m.y);
      this.inked(g, () => g.circle(s.x, s.y, 8), { width: 2, color: 0xffffff, alpha: 0.8 });
      if (m.delivered) g.circle(s.x, s.y, 3).fill({ color: 0xffffff, alpha: 0.8 });
    }

    // Debug: who sees whom (a thin line from each man to every enemy he has in sight).
    if (overlay.debug) {
      for (const [id, s] of state.soldier.entries()) {
        if (s.seen.length === 0 || s.mount !== undefined) continue;
        const a = worldToScreen(c, this.pos(state, id, alpha).x, this.pos(state, id, alpha).y);
        for (const e of s.seen) {
          if (!state.transform.has(e.target)) continue;
          const p = this.pos(state, e.target, alpha), b = worldToScreen(c, p.x, p.y);
          g.moveTo(a.x, a.y).lineTo(b.x, b.y);
        }
      }
      g.stroke({ width: 1, color: 0xffe066, alpha: 0.5 });
    }

    // Fog of war is on whenever Debug is off (the app supplies what the side knows).
    const fog = !overlay.debug && overlay.reveal !== true;
    this.drawProjectiles(g, state, alpha, overlay, fog);
    // Overview zoom (far out): symbols instead of men and hulls (M7.5a: a vehicle symbol per vehicle — near ones
    // stacked into one — and an infantry symbol only for a unit with men on foot).
    if (lod === LOD_SYMBOLS) {
      this.drawOverview(g, state, alpha, overlay, sideIndex, fog);
      this.drawObjectives(g, overlay, sideIndex, state);
      if (fog) this.drawKnown(g, overlay, sideIndex);
      if (overlay.plan) this.drawPlan(g, overlay.plan);
      if (overlay.gesture) this.drawGesture(g, overlay.gesture);
      this.flushSprites();
      this.flushLabels();
      return;
    }
    // Pixel soldiers from the figure level in (M7.5b); discs at the dot level and in the classic look.
    const sprites = this.look !== "classic" && lod >= LOD_FIGURE;
    // Men always at true size (owner, 2026-11-13): below about 8 px the dot level takes over.
    const size = SPRITE_M * c.scale;
    this.drawVehicles(g, state, alpha, overlay, sideIndex, fog);
    // Soldiers (under fog of war only the player's own; the enemy as his men know him, below).
    for (const [id, ident] of state.identity.entries()) {
      if (fog && ident.side !== overlay.playerSide) continue;
      if (state.soldier.get(id)?.mount !== undefined) continue; // men aboard are inside their vehicle (drawn with it)
      const p = this.pos(state, id, alpha);
      const t = state.transform.req(id);
      const s = worldToScreen(c, p.x, p.y);
      const colour = SIDE_COLOURS[(sideIndex.get(ident.side) ?? 0) % SIDE_COLOURS.length]!;
      const selected = overlay.selectedUnit !== null && unitIsOrContains(state, overlay.selectedUnit, ident.unit);
      // Posture: full disc standing, smaller crouching, a flat oval along the heading when prone.
      const sol = state.soldier.get(id);
      const posture = sol?.posture ?? "standing";
      const pr = posture === "crouching" ? r * 0.8 : r;
      let lr = r + 2;
      if (sprites) {
        // A pixel soldier (M7.5b): his frame, facing (16 steps), weapon, firing, wounds; the side outline.
        lr = size * 0.45;
        // Inside a building on a floor other than the one shown (M7.5d): faint, with his floor's badge.
        const other = this.otherFloor(t);
        this.drawMan(state, id, ident.faction, sol, t.heading, s.x, s.y, size, colour, other < 0 ? 1 : GHOST_ALPHA);
        if (other >= 0) drawFloorBadge(g, s.x + size * 0.38, s.y - size * 0.4, other, Math.max(2, Math.round(size / 12)), this.groundFloorLabel);
        // (Review fix: the selected men's ring darker-edged and bolder, so the squad stands out on ploughed fields.)
        if (selected) { const rr = Math.max(6, size * 0.42 + 2); g.circle(s.x, s.y, rr).stroke({ width: 3.5, color: 0x0b0f0a, alpha: 0.5 }); g.circle(s.x, s.y, rr).stroke({ width: 1.75, color: 0xffffff, alpha: 0.95 }); }
        if (sol && (sol.casualty !== "none" || sol.captive !== null)) continue;
        const bh = sol?.mental.behaviour;
        if (bh === "pinned" || bh === "panicked" || bh === "shaken") {
          g.circle(s.x, s.y, size * 0.42 + 4).stroke({ width: bh === "shaken" ? 1 : 2, color: bh === "panicked" ? 0xff4a3d : 0xffd23d, alpha: bh === "shaken" ? 0.5 : 0.9 });
        }
      } else {
        if (selected) g.circle(s.x, s.y, pr + 4).stroke({ width: 2, color: 0xffffff });
        // Casualties stay on the map: a dead man is a dark shape outlined in his side's colour; an unconscious
        // man is a pale shape with a red cross. Neither shows a facing line.
        if (sol && sol.casualty !== "none") {
          const ux = Math.cos(t.heading), uy = Math.sin(t.heading);
          const L = r * 1.5, Wd = r * 0.6;
          const shape = [s.x + ux * L, s.y + uy * L, s.x - uy * Wd, s.y + ux * Wd, s.x - ux * L, s.y - uy * L, s.x + uy * Wd, s.y - ux * Wd];
          if (sol.casualty === "killed") g.poly(shape).fill({ color: 0x14110f, alpha: 0.85 }).stroke({ width: 1.5, color: colour, alpha: 0.8 });
          else {
            g.poly(shape).fill({ color: colour, alpha: 0.45 }).stroke({ width: 1, color: 0xffffff, alpha: 0.7 });
            const k = Math.max(3, r * 0.7);
            g.moveTo(s.x - k, s.y).lineTo(s.x + k, s.y).moveTo(s.x, s.y - k).lineTo(s.x, s.y + k).stroke({ width: 2, color: 0xff4a3d });
          }
          if (sol.captive !== null && sol.casualty !== "killed") drawWhiteFlag(g, s.x, s.y, r);
          continue;
        }
        // Photo look: a 1.5 px dark rim and a lighter core, so a dot reads on crops, plough, woods and roads.
        const photo = this.look === "photo", core = photo ? lighten(colour) : colour;
        if (posture === "prone") {
          const ux = Math.cos(t.heading), uy = Math.sin(t.heading);
          const L = r * 1.5, Wd = r * 0.6;
          const shape = [s.x + ux * L, s.y + uy * L, s.x - uy * Wd, s.y + ux * Wd, s.x - ux * L, s.y - uy * L, s.x + uy * Wd, s.y - ux * Wd];
          if (photo) g.poly(shape).stroke({ width: 3, color: RIM, alpha: 0.9 });
          g.poly(shape).fill({ color: core });
        } else {
          if (photo) g.circle(s.x, s.y, pr + 1.5).fill({ color: RIM, alpha: 0.9 });
          g.circle(s.x, s.y, pr).fill({ color: core });
        }
        if (sol?.postureTo) g.circle(s.x, s.y, pr + 2).stroke({ width: 1, color: 0xffffff, alpha: 0.6 });
        // A prisoner (M6.6): a white flag, a white square once taken; no rings, no facing line.
        if (sol && sol.captive !== null) {
          drawWhiteFlag(g, s.x, s.y, r);
          if (sol.captive.state === "captured") g.rect(s.x - pr - 3, s.y - pr - 3, 2 * pr + 6, 2 * pr + 6).stroke({ width: 1.5, color: 0xffffff, alpha: 0.9 });
          continue;
        }
        // Under fire (M4.1): a yellow ring when pinned, a red one when panicked, a faint ring when shaken.
        const bh = sol?.mental.behaviour;
        if (bh === "pinned" || bh === "panicked" || bh === "shaken") {
          g.circle(s.x, s.y, pr + 3.5).stroke({ width: bh === "shaken" ? 1 : 2, color: bh === "panicked" ? 0xff4a3d : 0xffd23d, alpha: bh === "shaken" ? 0.5 : 0.95 });
        }
        // Wounded but carrying on: a white spot with a red centre on him.
        if (sol && sol.wounds.some((w) => w.mechanism !== "blunt")) g.circle(s.x, s.y, Math.max(2.5, r * 0.55)).fill({ color: 0xffffff }).circle(s.x, s.y, Math.max(1.5, r * 0.33)).fill({ color: 0xd4141a });
        const hx = Math.cos(t.heading) * (r + 4), hy = Math.sin(t.heading) * (r + 4);
        g.moveTo(s.x, s.y).lineTo(s.x + hx, s.y + hy).stroke({ width: 2, color: colour });
      }
      const unit = state.unit.get(ident.unit);
      if (unit && unit.leader === id) {
        // Debug: the unit's drill (assault / withdraw: which half is running; broken and running back).
        const top = unit.parent === null ? unit : undefined;
        const d = unit.drill ?? top?.drill ?? null;
        const drill = !overlay.debug ? "" : unit.broken ? " BROKEN" : d ? ` ${d.kind}${d.kind === "rout" ? "" : d.final ? " final rush" : ` half ${d.mover + 1} runs`}` : "";
        // A squad got out next to its vehicle (within 15 m): one label for both (M7.5a).
        const vr = unit.carrier !== undefined ? this.vehReq.get(unit.carrier) : undefined;
        const vt = unit.carrier !== undefined ? state.transform.get(unit.carrier) : undefined;
        if (vr !== undefined && vt && (vt.x - t.x) ** 2 + (vt.y - t.y) ** 2 <= 15 * 15 && drill === "") {
          const q = this.reqs[vr]!;
          q.text = `${q.text} · ${this.callsign(ident.unit)}`;
          if (selected) q.priority = 0;
        } else this.request(this.callsign(ident.unit) + drill, s.x, s.y, lr, colour, selected ? 0 : 2, ident.unit);
      }
      // Debug: what he decided on his own (M4.2) — a line to the enemy he engages, the cover he runs to, the man
      // he brings ammunition to.
      if (overlay.debug && sol?.intent) {
        const it = sol.intent;
        const to = it.target !== undefined ? state.transform.get(it.target) : it.x !== undefined && it.y !== undefined ? { x: it.x, y: it.y } : undefined;
        if (to) {
          const q = worldToScreen(c, to.x, to.y);
          const col = it.kind === "engage" ? 0xff8a3d : it.kind === "cover" ? 0x6ad4ff : 0x9dff6a;
          g.moveTo(s.x, s.y).lineTo(q.x, q.y).stroke({ width: 1, color: col, alpha: 0.7 });
        }
      }
      if (overlay.debug && sol && c.scale > 1.5) { // only when zoomed in enough to read
        // Debug: id, fatigue and heart rate per man.
        this.force(`${id} f${sol.physical.fatigue.toFixed(2)} ${Math.round(sol.physical.heartRateBpm)}bpm s${sol.mental.suppression.toFixed(2)}/${sol.mental.stress.toFixed(2)}${sol.intent ? ` ${sol.intent.kind}` : ""}${sol.wounds.length > 0 ? ` w${sol.wounds.length} blood ${sol.physiology.bloodVolumeL.toFixed(1)}l` : ""}`, s.x + r + 2, s.y + 2, 0xffffff);
      }
    }
    this.drawObjectives(g, overlay, sideIndex, state);
    if (fog) this.drawKnown(g, overlay, sideIndex);
    if (overlay.plan) this.drawPlan(g, overlay.plan);
    if (overlay.gesture) this.drawGesture(g, overlay.gesture);
    this.flushSprites();
    this.flushLabels();
  }

  /**
   * S7: where own units are going — a faint straight line from each unit on the move to its destination with a small
   * dot there; the selected unit's bright, along its route ahead; fire missions as a broken amber line from the caller
   * to a ring on the target. Colours are TCS's own.
   */
  private drawIntents(g: Graphics, lines: readonly IntentLineView[]): void {
    const c = this.camera;
    this.inked(g, () => {
      for (const l of lines) {
        if (l.kind !== "move" || l.selected) continue;
        const a = worldToScreen(c, l.x0, l.y0), b = worldToScreen(c, l.x1, l.y1);
        g.moveTo(a.x, a.y).lineTo(b.x, b.y);
      }
    }, { width: 1.5, color: INTENT_COLOUR, alpha: 0.35 });
    for (const l of lines) {
      if (l.kind !== "move" || l.selected) continue;
      const b = worldToScreen(c, l.x1, l.y1);
      g.circle(b.x, b.y, 2.5);
    }
    g.fill({ color: INTENT_COLOUR, alpha: 0.5 });
    for (const l of lines) {
      if (l.kind !== "move" || !l.selected) continue;
      let a = worldToScreen(c, l.x0, l.y0);
      const a0 = a;
      this.inked(g, () => { a = a0; for (const p of l.route ?? [{ x: l.x1, y: l.y1 }]) { const b = worldToScreen(c, p.x, p.y); g.moveTo(a.x, a.y).lineTo(b.x, b.y); a = b; } }, { width: 2, color: INTENT_COLOUR, alpha: 0.9 });
      g.circle(a.x, a.y, 3.5).fill({ color: INTENT_COLOUR, alpha: 0.95 });
    }
    for (const l of lines) {
      if (l.kind !== "fire") continue;
      const a = worldToScreen(c, l.x0, l.y0), b = worldToScreen(c, l.x1, l.y1);
      const al = l.selected ? 0.95 : 0.6;
      this.inked(g, () => dashed(g, a.x, a.y, b.x, b.y, 9, 6), { width: l.selected ? 2.5 : 2, color: FIRE_COLOUR, alpha: al });
      // S11: the ranging rounds walking in (a small cross where each fell, a thin trail on to the point; unseen
      // falls hollow), and a second, wider ring once the battery fires for effect.
      if (l.falls && l.falls.length > 0) {
        let p = worldToScreen(c, l.falls[0]!.x, l.falls[0]!.y);
        for (let k = 1; k <= l.falls.length; k++) {
          const q = k < l.falls.length ? worldToScreen(c, l.falls[k]!.x, l.falls[k]!.y) : b;
          dashed(g, p.x, p.y, q.x, q.y, 4, 4);
          p = q;
        }
        g.stroke({ width: 2, color: FIRE_COLOUR, alpha: al * 0.85 });
        for (const f of l.falls) {
          const s = worldToScreen(c, f.x, f.y);
          g.moveTo(s.x - 7, s.y - 7).lineTo(s.x + 7, s.y + 7).moveTo(s.x + 7, s.y - 7).lineTo(s.x - 7, s.y + 7);
          g.stroke({ width: 4.5, color: 0x1b241a, alpha: 0.75 });
          g.moveTo(s.x - 7, s.y - 7).lineTo(s.x + 7, s.y + 7).moveTo(s.x + 7, s.y - 7).lineTo(s.x - 7, s.y + 7);
          g.stroke({ width: 2.5, color: f.seen ? FIRE_COLOUR : 0xd8cbb0, alpha: al });
        }
      }
      this.inked(g, () => g.circle(b.x, b.y, 9), { width: 2, color: FIRE_COLOUR, alpha: al });
      g.circle(b.x, b.y, 2.5).fill({ color: FIRE_COLOUR, alpha: al });
      if (l.phase === "effect") g.circle(b.x, b.y, 15).stroke({ width: 2, color: FIRE_COLOUR, alpha: al * 0.8 });
    }
  }

  /** Order gestures (the "controls" step): see GestureOverlay. Colours are TCS's own. */
  private drawGesture(g: Graphics, gs: GestureOverlay): void {
    const c = this.camera;
    // Line of sight (S2): solid where the view is clear, broken from where it is stopped.
    if (gs.los) {
      for (const l of gs.los) {
        const a = worldToScreen(c, l.x0, l.y0), b = worldToScreen(c, l.x1, l.y1);
        const mx = a.x + (b.x - a.x) * l.stopAt, my = a.y + (b.y - a.y) * l.stopAt;
        // (Review fix: a dark edge under each line keeps it readable on pale fields; the blocked part is thicker
        // and its cross bigger, so it shows at phone size.)
        if (l.stopAt > 0) {
          g.moveTo(a.x, a.y).lineTo(mx, my).stroke({ width: 4, color: 0x0b0f0a, alpha: 0.55 });
          g.moveTo(a.x, a.y).lineTo(mx, my).stroke({ width: 2, color: 0xd9f7ff, alpha: 0.95 });
        }
        if (l.stopAt < 1) {
          dashed(g, mx, my, b.x, b.y, 7, 5);
          g.stroke({ width: 4.5, color: 0x0b0f0a, alpha: 0.55 });
          dashed(g, mx, my, b.x, b.y, 7, 5);
          g.stroke({ width: 2.5, color: 0xff7a59, alpha: 0.95 });
          if (l.stopAt > 0) {
            g.moveTo(mx - 6, my - 6).lineTo(mx + 6, my + 6).moveTo(mx + 6, my - 6).lineTo(mx - 6, my + 6).stroke({ width: 4.5, color: 0x0b0f0a, alpha: 0.6 });
            g.moveTo(mx - 6, my - 6).lineTo(mx + 6, my + 6).moveTo(mx + 6, my - 6).lineTo(mx - 6, my + 6).stroke({ width: 2.5, color: 0xff7a59 });
          }
        }
      }
    }
    if (gs.target) {
      const s = worldToScreen(c, gs.target.x, gs.target.y);
      g.circle(s.x, s.y, 13).stroke({ width: 2.5, color: 0xff7a59, alpha: 0.95 });
      g.moveTo(s.x - 19, s.y).lineTo(s.x - 7, s.y).moveTo(s.x + 7, s.y).lineTo(s.x + 19, s.y)
        .moveTo(s.x, s.y - 19).lineTo(s.x, s.y - 7).moveTo(s.x, s.y + 7).lineTo(s.x, s.y + 19).stroke({ width: 2, color: 0xff7a59, alpha: 0.95 });
    }
    // The point held for fire support (S11): the mission line's colour, a ring with four ticks, joined to the caller.
    if (gs.support) {
      const s = worldToScreen(c, gs.support.x, gs.support.y);
      if (gs.support.from) {
        const f = worldToScreen(c, gs.support.from.x, gs.support.from.y);
        dashed(g, f.x, f.y, s.x, s.y, 9, 6);
        g.stroke({ width: 2, color: FIRE_COLOUR, alpha: 0.75 });
      }
      g.circle(s.x, s.y, 16).fill({ color: 0x1b241a, alpha: 0.35 }).stroke({ width: 2.5, color: FIRE_COLOUR, alpha: 0.95 });
      g.moveTo(s.x - 24, s.y).lineTo(s.x - 10, s.y).moveTo(s.x + 10, s.y).lineTo(s.x + 24, s.y)
        .moveTo(s.x, s.y - 24).lineTo(s.x, s.y - 10).moveTo(s.x, s.y + 10).lineTo(s.x, s.y + 24).stroke({ width: 2, color: FIRE_COLOUR, alpha: 0.95 });
      g.circle(s.x, s.y, 3).fill({ color: FIRE_COLOUR, alpha: 0.95 });
    }
    // An active move's marker (S10): a ring with a centre, joined to the unit while it is dragged.
    if (gs.marker) {
      const s = worldToScreen(c, gs.marker.x, gs.marker.y);
      if (gs.marker.from && gs.marker.dragging) {
        const f = worldToScreen(c, gs.marker.from.x, gs.marker.from.y);
        dashed(g, f.x, f.y, s.x, s.y, 8, 5);
        g.stroke({ width: 2, color: 0xffffff, alpha: 0.6 });
      }
      g.circle(s.x, s.y, 11).fill({ color: 0x1b241a, alpha: 0.65 }).stroke({ width: 2.5, color: 0xffffff, alpha: 0.95 });
      g.circle(s.x, s.y, 4).fill({ color: 0xffffff, alpha: 0.95 });
    }
    // The facing handle (S9): a line out of the unit and a round handle with an arrowhead.
    if (gs.facing) {
      const ce = worldToScreen(c, gs.facing.centre.x, gs.facing.centre.y), h = worldToScreen(c, gs.facing.handle.x, gs.facing.handle.y);
      const ang = Math.atan2(h.y - ce.y, h.x - ce.x);
      const col = 0x8fe3c0;
      dashed(g, ce.x, ce.y, h.x - Math.cos(ang) * 12, h.y - Math.sin(ang) * 12, 4, 4);
      g.stroke({ width: gs.facing.dragging ? 2.5 : 1.5, color: col, alpha: gs.facing.dragging ? 0.95 : 0.7 });
      g.circle(h.x, h.y, 11).fill({ color: 0x1b241a, alpha: 0.7 }).stroke({ width: 2.5, color: col });
      const tx = h.x + Math.cos(ang) * 5, ty = h.y + Math.sin(ang) * 5;
      g.poly([tx, ty, h.x + Math.cos(ang + 2.5) * 6, h.y + Math.sin(ang + 2.5) * 6, h.x + Math.cos(ang - 2.5) * 6, h.y + Math.sin(ang - 2.5) * 6]).fill({ color: col });
    }
    // The man whose box is open (S6): a bright ring with four ticks, sized to stay visible at any zoom.
    if (gs.man) {
      const s = worldToScreen(c, gs.man.x, gs.man.y), r = Math.max(9, 0.9 * c.scale);
      g.circle(s.x, s.y, r).stroke({ width: 2, color: 0xfff3a0, alpha: 0.95 });
      g.moveTo(s.x - r - 5, s.y).lineTo(s.x - r + 1, s.y).moveTo(s.x + r - 1, s.y).lineTo(s.x + r + 5, s.y)
        .moveTo(s.x, s.y - r - 5).lineTo(s.x, s.y - r + 1).moveTo(s.x, s.y + r - 1).lineTo(s.x, s.y + r + 5).stroke({ width: 2, color: 0xfff3a0, alpha: 0.95 });
    }
    // Back on the unit: letting go here cancels (a marker: halts).
    if (gs.cancelAt) {
      const s = worldToScreen(c, gs.cancelAt.x, gs.cancelAt.y);
      g.circle(s.x, s.y, 16).fill({ color: 0x1b241a, alpha: 0.6 }).stroke({ width: 2.5, color: 0xff5a4a });
      g.moveTo(s.x - 7, s.y - 7).lineTo(s.x + 7, s.y + 7).moveTo(s.x + 7, s.y - 7).lineTo(s.x - 7, s.y + 7).stroke({ width: 3, color: 0xff5a4a });
    }
  }

  /**
   * The overview (zoomed far out, M7.5a): one vehicle symbol per vehicle — an original design, a frame with a
   * track oval — and vehicles closer than a symbol stacked into one ("×n" on its label); one infantry symbol per
   * top-level unit at its men on foot (none while they all ride). Labels go through the decluttering.
   */
  private drawOverview(g: Graphics, state: SimView, alpha: number, overlay: Overlay, sideIndex: Map<string, number>, fog: boolean): void {
    const c = this.camera;
    const W = 22, H = 15;
    // Vehicles: greedy stacks in screen space (ID order), each drawn once.
    const stacks: { x: number; y: number; side: string; n: number; first: EntityId; unit: EntityId | null; wreck: boolean; selected: boolean; aboard: number }[] = [];
    for (const [vid, v] of state.vehicle.entries()) {
      if (fog && v.side !== overlay.playerSide && v.status !== "destroyed" && v.status !== "abandoned") continue;
      if (!state.transform.has(vid)) continue;
      const p = this.pos(state, vid, alpha), s = worldToScreen(c, p.x, p.y);
      const wreck = v.status === "destroyed" || v.status === "abandoned";
      const def = this.vehicleDefs[v.def];
      let aboard = 0, carries = false;
      v.seats.forEach((o, i) => {
        if (o === null || def?.seats[i]?.station !== "passenger") return;
        aboard++;
        const u = state.identity.get(o)?.unit;
        if (u !== undefined && overlay.selectedUnit !== null && unitIsOrContains(state, overlay.selectedUnit, u)) carries = true;
      });
      const selected = carries || (v.unit !== null && overlay.selectedUnit !== null && unitIsOrContains(state, overlay.selectedUnit, v.unit));
      const near = stacks.find((k) => k.side === v.side && k.wreck === wreck && Math.abs(k.x - s.x) < W && Math.abs(k.y - s.y) < H);
      if (near) { near.n++; near.selected ||= selected; near.aboard += aboard; continue; }
      stacks.push({ x: s.x, y: s.y, side: v.side, n: 1, first: vid, unit: v.unit, wreck, selected, aboard });
    }
    for (const k of stacks) {
      const colour = SIDE_COLOURS[(sideIndex.get(k.side) ?? 0) % SIDE_COLOURS.length]!;
      if (k.n > 1) g.rect(k.x - W / 2 + 3, k.y - H / 2 - 3, W, H).fill({ color: 0x10140f, alpha: 0.75 }).stroke({ width: 1.5, color: colour });
      g.rect(k.x - W / 2, k.y - H / 2, W, H).fill({ color: 0x10140f, alpha: 0.85 }).stroke({ width: 2, color: colour });
      g.roundRect(k.x - 7, k.y - 3.5, 14, 7, 3.5).stroke({ width: 1.8, color: colour });
      if (k.wreck) g.moveTo(k.x - W / 2, k.y - H / 2).lineTo(k.x + W / 2, k.y + H / 2).moveTo(k.x + W / 2, k.y - H / 2).lineTo(k.x - W / 2, k.y + H / 2).stroke({ width: 2, color: 0xff4a3d });
      if (k.selected) g.rect(k.x - W / 2 - 3, k.y - H / 2 - 3, W + 6, H + 6).stroke({ width: 2, color: 0xffffff });
      const call = k.unit !== null ? state.unit.get(k.unit)?.callsign : undefined;
      if (call === undefined) continue;
      const text = `${call}${k.n > 1 ? ` ×${k.n}` : ""}${k.aboard > 0 ? ` +${k.aboard}` : ""}`;
      this.request(text, k.x, k.y, W / 2, colour, k.selected ? 0 : 2, k.unit ?? k.first);
    }
    // Infantry: a symbol per top-level unit at its men on foot; one that would sit on a vehicle symbol (men just
    // out beside their vehicles) is lifted clear of it, with a line to where the men are.
    const taken = stacks.map((k) => ({ x: k.x, y: k.y }));
    for (const [uid, u] of state.unit.entries()) {
      if (u.parent !== null) continue;
      if (fog && u.side !== overlay.playerSide) continue;
      let sx = 0, sy = 0, n = 0;
      const walk = (x: EntityId) => {
        const uu = state.unit.get(x);
        if (!uu || uu.vehicle !== undefined) return; // crews are drawn with their vehicles
        for (const m of uu.members) {
          if (state.soldier.get(m)?.mount !== undefined) continue; // aboard: inside the vehicle symbol
          const p = this.pos(state, m, alpha); sx += p.x; sy += p.y; n++;
        }
        for (const ch of uu.children) walk(ch);
      };
      walk(uid);
      if (n === 0) continue;
      const at = worldToScreen(c, sx / n, sy / n);
      const s = { x: at.x, y: at.y };
      for (let k = 0; k < 6 && taken.some((q) => Math.abs(q.x - s.x) < W + 2 && Math.abs(q.y - s.y) < H + 2); k++) s.y -= H + 4;
      taken.push(s);
      const colour = SIDE_COLOURS[(sideIndex.get(u.side) ?? 0) % SIDE_COLOURS.length]!;
      if (s.y !== at.y) { g.moveTo(at.x, at.y).lineTo(s.x, s.y + H / 2).stroke({ width: 1.5, color: colour, alpha: 0.9 }); g.circle(at.x, at.y, 2.5).fill({ color: colour }); }
      g.rect(s.x - W / 2, s.y - H / 2, W, H).fill({ color: 0x10140f, alpha: 0.85 }).stroke({ width: 2, color: colour });
      g.moveTo(s.x - W / 2, s.y - H / 2).lineTo(s.x + W / 2, s.y + H / 2).moveTo(s.x + W / 2, s.y - H / 2).lineTo(s.x - W / 2, s.y + H / 2).stroke({ width: 1.5, color: colour });
      const sel = overlay.selectedUnit !== null && unitIsOrContains(state, overlay.selectedUnit, uid);
      if (overlay.selectedUnit === uid) g.rect(s.x - W / 2 - 3, s.y - H / 2 - 3, W + 6, H + 6).stroke({ width: 2, color: 0xffffff });
      this.request(this.callsign(uid), s.x, s.y, W / 2, colour, sel ? 0 : 2, uid);
    }
  }

  /**
   * Vehicles (M7.1c; M7.5 replaces the look): the hull at true size (never under 10 px long), a nose mark for its
   * heading, the turret and barrel; side colour; a ring when its unit is selected; its route (reverse legs orange);
   * the callsign when zoomed in. Under fog of war only the player's own (enemy vehicles come with contacts, M7.3).
   */
  private drawVehicles(g: Graphics, state: SimView, alpha: number, overlay: Overlay, sideIndex: Map<string, number>, fog: boolean): void {
    const c = this.camera;
    for (const [vid, v] of state.vehicle.entries()) {
      // (Owner Q8, M7.4a: both sides know of a wreck at once, so enemy wrecks are drawn under fog too.)
      if (fog && v.side !== overlay.playerSide && v.status !== "destroyed" && v.status !== "abandoned") continue;
      const def = this.vehicleDefs[v.def];
      const t = state.transform.get(vid);
      if (!def || !t) continue;
      const p = this.pos(state, vid, alpha);
      const colour = SIDE_COLOURS[(sideIndex.get(v.side) ?? 0) % SIDE_COLOURS.length]!;
      const len = def.body.lengthM * c.scale;
      const k = len < 10 ? 10 / len : 1; // minimum size on screen
      const ch = Math.cos(t.heading), sh = Math.sin(t.heading);
      const at = (f: number, r: number, ox = p.x, oy = p.y, cc = ch, ss = sh) => worldToScreen(c, ox + (cc * f - ss * r) * k, oy + (ss * f + cc * r) * k);
      const box = (f0: number, f1: number, r0: number, r1: number, ox?: number, oy?: number, cc?: number, ss?: number) => {
        const a = at(f0, r0, ox, oy, cc, ss), b = at(f1, r0, ox, oy, cc, ss), d = at(f1, r1, ox, oy, cc, ss), e = at(f0, r1, ox, oy, cc, ss);
        return [a.x, a.y, b.x, b.y, d.x, d.y, e.x, e.y];
      };
      const h = def.body.hull;
      const wreck = v.status === "destroyed" || v.status === "abandoned";
      // Men aboard (M7.2): how many passengers, and whether the selected unit rides in it.
      let aboard = 0, carriesSelected = false;
      v.seats.forEach((o, i) => {
        if (o === null || def.seats[i]?.station !== "passenger") return;
        aboard++;
        const u = state.identity.get(o)?.unit;
        if (!carriesSelected && u !== undefined && overlay.selectedUnit !== null && unitIsOrContains(state, overlay.selectedUnit, u)) carriesSelected = true;
      });
      const selected = (v.unit !== null && overlay.selectedUnit !== null && unitIsOrContains(state, overlay.selectedUnit, v.unit)) || carriesSelected;
      // Route of the selected vehicle (from where it is), reverse legs orange.
      if (selected && v.drive.route.length > v.drive.routeIdx) {
        let a = worldToScreen(c, p.x, p.y);
        for (let i = v.drive.routeIdx; i < v.drive.route.length; i++) {
          const w = v.drive.route[i]!, b = worldToScreen(c, w.x, w.y);
          const a1 = a;
          this.inked(g, () => g.moveTo(a1.x, a1.y).lineTo(b.x, b.y), { width: 2, color: w.reverse ? 0xff9a3d : 0xffffff, alpha: 0.6 });
          a = b;
        }
      }
      const look = lookOf(this.appearance, v.faction).vehicle;
      if (this.look === "photo") {
        // Photo look: scorched ground round a wreck, and the hull's shadow on the ground, down-sun (2 m high).
        if (wreck) { const sp = worldToScreen(c, p.x, p.y); this.scorch(sp.x, sp.y, SCORCH_M * c.scale * k, vid * 2.399); }
        g.poly(box(h.f[0], h.f[1], h.r[0], h.r[1], p.x + SHADOW_DIR.dx * HULL_SHADOW_M * k, p.y + SHADOW_DIR.dy * HULL_SHADOW_M * k)).fill({ color: 0x000000, alpha: 0.35 });
      }
      g.poly(box(h.f[0], h.f[1], h.r[0], h.r[1])).fill({ color: wreck ? 0x1a1714 : look.dark, alpha: 0.95 }).stroke({ width: 2, color: colour });
      // Tracks along both sides (a wheeled hull: four wheels a side), and the nose (a wedge at the front).
      const tw = (h.r[1] - h.r[0]) * 0.18;
      if (def.class === "wheeled") {
        const n = 4, span = (h.f[1] - h.f[0]) * 0.8, f0 = h.f[0] + (h.f[1] - h.f[0]) * 0.1, wl = span / n * 0.62;
        for (let q = 0; q < n; q++) {
          const fc = f0 + (span / n) * (q + 0.5);
          g.poly(box(fc - wl / 2, fc + wl / 2, h.r[0] - tw * 0.25, h.r[0] + tw * 0.75)).fill({ color: 0x111111, alpha: 0.85 });
          g.poly(box(fc - wl / 2, fc + wl / 2, h.r[1] - tw * 0.75, h.r[1] + tw * 0.25)).fill({ color: 0x111111, alpha: 0.85 });
        }
      } else {
        g.poly(box(h.f[0], h.f[1], h.r[0], h.r[0] + tw)).fill({ color: 0x111111, alpha: 0.8 });
        g.poly(box(h.f[0], h.f[1], h.r[1] - tw, h.r[1])).fill({ color: 0x111111, alpha: 0.8 });
      }
      // A painted emblem (M10.6-data, appearance data): the red cross on a white square on the roof.
      if (!wreck && this.appearance?.markings?.[v.def] === "red-cross") {
        const half = Math.min(h.f[1] - h.f[0], h.r[1] - h.r[0]) * 0.28, fc = (h.f[0] + h.f[1]) / 2 - (h.f[1] - h.f[0]) * 0.12, rc = (h.r[0] + h.r[1]) / 2;
        g.poly(box(fc - half, fc + half, rc - half, rc + half)).fill({ color: 0xf2f2ee });
        const arm = half * 0.28;
        g.poly(box(fc - half * 0.8, fc + half * 0.8, rc - arm, rc + arm)).fill({ color: 0xd2232a });
        g.poly(box(fc - arm, fc + arm, rc - half * 0.8, rc + half * 0.8)).fill({ color: 0xd2232a });
      }
      const n1 = at(h.f[1], h.r[0] + tw), n2 = at(h.f[1], h.r[1] - tw), n3 = at(h.f[1] - (h.f[1] - h.f[0]) * 0.18, 0);
      g.poly([n1.x, n1.y, n2.x, n2.y, n3.x, n3.y]).fill({ color: colour, alpha: 0.9 });
      const tr = def.body.turret;
      if (tr) {
        const az = t.heading + (v.stations[0]?.azimuth ?? 0), tc = Math.cos(az), ts = Math.sin(az);
        const px = p.x + ch * tr.pivotF * k, py = p.y + sh * tr.pivotF * k;
        g.poly(box(tr.f[0], tr.f[1], tr.r[0], tr.r[1], px, py, tc, ts)).fill({ color: wreck ? 0x2a2622 : look.hull }).stroke({ width: 1.5, color: colour });
        const b0 = at(tr.f[1], 0, px, py, tc, ts), b1 = at(tr.f[1] + tr.barrelM, 0, px, py, tc, ts);
        g.moveTo(b0.x, b0.y).lineTo(b1.x, b1.y).stroke({ width: Math.max(2, 0.15 * c.scale * k), color: 0x10140f });
      }
      // Burning (M7.4a): flames on the hull while the fire lasts (a destroyed hull that burnt out stays dark).
      if (v.fire !== null && (v.status !== "destroyed" || state.tick - v.fire.startTick < 7200)) {
        const ph = (state.tick % 20) / 20;
        for (let q = 0; q < 3; q++) {
          const fp = at(h.f[0] + (h.f[1] - h.f[0]) * (0.3 + 0.2 * q), ((q % 2) - 0.5) * (h.r[1] - h.r[0]) * 0.3);
          const rr = (0.9 + 0.5 * Math.sin((ph + q / 3) * 2 * Math.PI)) * c.scale * k;
          g.circle(fp.x, fp.y, Math.max(3, rr * 1.3)).fill({ color: 0xff7a1a, alpha: 0.75 });
          g.circle(fp.x, fp.y, Math.max(1.5, rr * 0.6)).fill({ color: 0xffe066, alpha: 0.9 });
        }
      }
      if (wreck) {
        const a = at(h.f[1], h.r[1]), b = at(h.f[0], h.r[0]), d = at(h.f[1], h.r[0]), e = at(h.f[0], h.r[1]);
        g.moveTo(a.x, a.y).lineTo(b.x, b.y).moveTo(d.x, d.y).lineTo(e.x, e.y).stroke({ width: 2, color: 0xff4a3d });
      }
      const s = worldToScreen(c, p.x, p.y);
      if (selected) g.circle(s.x, s.y, (def.body.lengthM / 2) * c.scale * k + 5).stroke({ width: 2, color: 0xffffff });
      const unit = v.unit !== null ? state.unit.get(v.unit) : undefined;
      if (unit && v.unit !== null) {
        this.vehReq.set(vid, this.nReqs);
        this.request(aboard > 0 ? `${this.callsign(v.unit)} +${aboard}` : this.callsign(v.unit), s.x, s.y, (def.body.lengthM / 2) * c.scale * k + 2, colour, selected ? 0 : 2, v.unit);
      }
      // Debug overlay (M7.3): the target line of each station and its reasons beside the hull.
      const dbg = overlay.vehicleDebug;
      if (overlay.debug && dbg && dbg.vehicle === vid) {
        for (const tg of dbg.targets) { const b = worldToScreen(c, tg.x, tg.y); g.moveTo(s.x, s.y).lineTo(b.x, b.y).stroke({ width: 1.5, color: 0xff6a4d, alpha: 0.8 }); g.circle(b.x, b.y, 6).stroke({ width: 1.5, color: 0xff6a4d }); }
        // On a dark panel to the right of the hull (the men's debug labels are beside them).
        const lx = s.x + (def.body.lengthM / 2) * c.scale * k + 170, ly = s.y - 20;
        const wpx = Math.max(...dbg.lines.map((ln) => ln.length)) * 6.6 + 10;
        g.rect(lx - 5, ly - 3, wpx, dbg.lines.length * 14 + 6).fill({ color: 0x10140f, alpha: 0.85 });
        dbg.lines.forEach((ln, i) => this.force(ln, lx, ly + i * 14, 0xffe066));
      }
    }
  }

  /**
   * The enemy as the player's side knows him (fog of war): a solid diamond where a man is in sight now, a hollow
   * one where he was last seen or reported, a circle for how far off that may be; a sound is a dashed ring with
   * a cross at the guessed place. Old contacts fade out over two minutes.
   */
  /**
   * Objectives (M6): a ring in the colour of the side that holds it (grey: nobody), dashed while contested, with
   * its name. After the battle, the heat map: where shots came from (small dots in the firing side's colour)
   * and where men fell (crosses).
   */
  private drawObjectives(g: Graphics, overlay: Overlay, sideIndex: Map<string, number>, state?: SimView): void {
    const c = this.camera;
    // Smoke (M6.5c): grey clouds, thin while they build up and as they clear (everyone can see smoke).
    if (state) for (const sm of state.smoke) {
      const s = worldToScreen(c, sm.x, sm.y);
      const grow = Math.min(1, (state.tick - sm.startTick) / 600), fade = Math.min(1, (sm.untilTick - state.tick) / 1200);
      const r = Math.max(6, sm.radiusM * (0.3 + 0.7 * grow) * c.scale);
      g.circle(s.x, s.y, r).fill({ color: 0xd8d8d0, alpha: 0.55 * fade });
      g.circle(s.x - r * 0.3, s.y - r * 0.2, r * 0.6).fill({ color: 0xeeeeea, alpha: 0.35 * fade });
    }
    let k = 0;
    for (const o of overlay.objectives ?? []) {
      const s = worldToScreen(c, o.x, o.y);
      const colour = o.holder === null ? 0xb0b0b0 : SIDE_COLOURS[(sideIndex.get(o.holder) ?? 0) % SIDE_COLOURS.length]!;
      const r = Math.max(10, o.radiusM * c.scale);
      if (o.contested) {
        for (let k = 0; k < 24; k += 2) {
          const a0 = (k / 24) * 2 * Math.PI, a1 = ((k + 1) / 24) * 2 * Math.PI;
          g.moveTo(s.x + Math.cos(a0) * r, s.y + Math.sin(a0) * r).lineTo(s.x + Math.cos(a1) * r, s.y + Math.sin(a1) * r);
        }
        g.stroke({ width: 3, color: colour, alpha: 0.95 });
      } else {
        g.circle(s.x, s.y, r).fill({ color: colour, alpha: 0.08 });
        this.inked(g, () => g.circle(s.x, s.y, r), { width: 3, color: colour, alpha: 0.9 });
      }
      this.request(o.label, s.x, s.y - r - 9, 4, colour, 1, k++);
    }
    const h = overlay.heat;
    if (h) {
      for (let i = 0; i < h.shots.length; i += 3) {
        const s = worldToScreen(c, h.shots[i]!, h.shots[i + 1]!);
        g.circle(s.x, s.y, 2.2).fill({ color: SIDE_COLOURS[h.shots[i + 2]! % SIDE_COLOURS.length]!, alpha: 0.5 });
      }
      for (let i = 0; i < h.falls.length; i += 3) {
        const s = worldToScreen(c, h.falls[i]!, h.falls[i + 1]!);
        const col = SIDE_COLOURS[h.falls[i + 2]! % SIDE_COLOURS.length]!;
        g.moveTo(s.x - 5, s.y - 5).lineTo(s.x + 5, s.y + 5).moveTo(s.x + 5, s.y - 5).lineTo(s.x - 5, s.y + 5).stroke({ width: 2.5, color: col });
      }
    }
  }

  /** The order being planned: route legs coloured by pace, the men's places, the facing arrow, the handles. */
  private drawPlan(g: Graphics, plan: PlanOverlay): void {
    const c = this.camera;
    const main = plan.kind === "assault" ? 0xff6a4d : plan.kind === "withdraw" ? 0x7fd7ff : 0xffffff;
    let a = worldToScreen(c, plan.from.x, plan.from.y);
    for (const p of plan.points) {
      const b = worldToScreen(c, p.x, p.y);
      if (plan.ghost) { dashed(g, a.x, a.y, b.x, b.y, 10, 6); g.stroke({ width: 3, color: plan.kind === "move" ? (PACE_COLOURS[p.mode] ?? 0xffffff) : main, alpha: 0.8 }); a = b; continue; }
      const a1 = a;
      this.inked(g, () => g.moveTo(a1.x, a1.y).lineTo(b.x, b.y), { width: 3, color: plan.kind === "move" ? (PACE_COLOURS[p.mode] ?? 0xffffff) : main, alpha: 0.85 });
      g.circle(b.x, b.y, 6).fill({ color: 0x1b241a, alpha: 0.6 }).stroke({ width: 2, color: 0xffffff });
      a = b;
    }
    const m = plan.marker;
    if (!m) {
      // Assault / withdraw: the men end spread round the point, facing as the fight takes them.
      const last = plan.points[plan.points.length - 1];
      if (last) { const s = worldToScreen(c, last.x, last.y); g.circle(s.x, s.y, Math.max(12, 5 * c.scale)).stroke({ width: 2, color: main, alpha: 0.9 }); }
      return;
    }
    const pts = m.men.map((p) => worldToScreen(c, p.x, p.y));
    // The formation's shape: each man's place, joined to the leader's.
    const lead = pts[0]!;
    for (const p of pts.slice(1)) g.moveTo(lead.x, lead.y).lineTo(p.x, p.y).stroke({ width: 1.5, color: main, alpha: 0.5 });
    for (const p of pts) g.circle(p.x, p.y, Math.max(4, 0.6 * c.scale)).stroke({ width: 2, color: main, alpha: 0.95 });
    const ce = worldToScreen(c, m.centre.x, m.centre.y), tip = worldToScreen(c, m.arrowTip.x, m.arrowTip.y);
    g.moveTo(ce.x, ce.y).lineTo(tip.x, tip.y).stroke({ width: 3, color: main });
    const ang = Math.atan2(tip.y - ce.y, tip.x - ce.x);
    g.poly([tip.x + Math.cos(ang) * 10, tip.y + Math.sin(ang) * 10, tip.x + Math.cos(ang + 2.4) * 9, tip.y + Math.sin(ang + 2.4) * 9, tip.x + Math.cos(ang - 2.4) * 9, tip.y + Math.sin(ang - 2.4) * 9]).fill({ color: main });
    if (plan.kind === "move" && !plan.ghost) {
      // Handles, big enough for a finger: turn (at the arrow), width (at the side).
      for (const h of [m.rotate, m.resize]) {
        if (!h) continue;
        const s = worldToScreen(c, h.x, h.y);
        g.circle(s.x, s.y, 11).fill({ color: 0x1b241a, alpha: 0.7 }).stroke({ width: 2.5, color: 0xffd23d });
      }
    }
  }

  /**
   * An enemy vehicle as the side knows it (M7.3): a hull outline at its true size (its type's, once identified,
   * else a generic 7 x 3.5 m box), facing as last seen; solid while in sight, hollow and fading after; a dashed
   * ring and a cross for one only heard.
   */
  private drawKnownVehicle(g: Graphics, k: NonNullable<Overlay["known"]>[number], s: { x: number; y: number }, colour: number, fade: number): void {
    const c = this.camera;
    const def = k.vtype !== undefined ? this.vehicleDefs[k.vtype] : undefined;
    const L = def ? def.body.lengthM : 7, W = def ? def.body.widthM : 3.5;
    const k2 = L * c.scale < 12 ? 12 / (L * c.scale) : 1;
    const h = k.heading ?? 0, ch = Math.cos(h), sh = Math.sin(h);
    const pt = (f: number, r: number) => [s.x + (ch * f - sh * r) * c.scale * k2, s.y + (sh * f + ch * r) * c.scale * k2];
    const box = [...pt(L / 2, -W / 2), ...pt(L / 2, W / 2), ...pt(-L / 2, W / 2), ...pt(-L / 2, -W / 2)];
    if (k.kind === "heard") {
      const rr = Math.max(8, k.errM * c.scale), n = 16;
      for (let q = 0; q < n; q += 2) {
        const a0 = (q / n) * Math.PI * 2, a1 = ((q + 1) / n) * Math.PI * 2;
        g.moveTo(s.x + Math.cos(a0) * rr, s.y + Math.sin(a0) * rr).lineTo(s.x + Math.cos(a1) * rr, s.y + Math.sin(a1) * rr);
      }
      g.stroke({ width: 1.5, color: colour, alpha: 0.7 * fade });
      g.poly(box).stroke({ width: 1.5, color: colour, alpha: 0.6 * fade });
      return;
    }
    const nose = [...pt(L / 2, -W / 3), ...pt(L / 2, W / 3), ...pt(L / 2 - L * 0.18, 0)];
    if (k.kind === "seen" && k.ageS < 2) { g.poly(box).fill({ color: colour, alpha: 0.85 }).stroke({ width: 1, color: 0x000000, alpha: 0.6 }); g.poly(nose).fill({ color: 0x10140f, alpha: 0.8 }); }
    else { g.poly(box).stroke({ width: 2, color: colour, alpha: fade }); g.poly(nose).stroke({ width: 1, color: colour, alpha: fade }); }
  }

  private drawKnown(g: Graphics, overlay: Overlay, sideIndex: Map<string, number>): void {
    const c = this.camera;
    let enemy = 0;
    for (const [id, i] of sideIndex) if (id !== overlay.playerSide) { enemy = i; break; }
    const colour = SIDE_COLOURS[enemy % SIDE_COLOURS.length]!;
    const d = Math.max(4, 0.7 * c.scale);
    const pinned = overlay.pins !== undefined && overlay.pins !== null;
    for (const k of overlay.known ?? []) {
      // S8: lost (unseen PIN_AFTER_S) contacts that were seen or reported are drawn as their pins below.
      if (pinned && k.kind !== "heard" && k.ageS >= PIN_AFTER_S) continue;
      const s = worldToScreen(c, k.x, k.y);
      const fade = Math.max(0.15, 1 - k.ageS / 120);
      if (k.cls === "vehicle") { this.drawKnownVehicle(g, k, s, colour, fade); continue; }
      const rr = k.errM * c.scale;
      const diamond = [s.x, s.y - d, s.x + d, s.y, s.x, s.y + d, s.x - d, s.y];
      if (k.kind === "heard") {
        const n = 16;
        for (let q = 0; q < n; q += 2) {
          const a0 = (q / n) * Math.PI * 2, a1 = ((q + 1) / n) * Math.PI * 2;
          g.moveTo(s.x + Math.cos(a0) * rr, s.y + Math.sin(a0) * rr).lineTo(s.x + Math.cos(a1) * rr, s.y + Math.sin(a1) * rr);
        }
        g.stroke({ width: 1.5, color: colour, alpha: 0.7 * fade });
        g.moveTo(s.x - d * 0.6, s.y - d * 0.6).lineTo(s.x + d * 0.6, s.y + d * 0.6).moveTo(s.x + d * 0.6, s.y - d * 0.6).lineTo(s.x - d * 0.6, s.y + d * 0.6).stroke({ width: 2, color: colour, alpha: fade });
        if (k.surrendered) drawWhiteFlag(g, s.x, s.y, d);
        continue;
      }
      if (k.surrendered) drawWhiteFlag(g, s.x, s.y, d);
      if (rr > d * 1.5) g.circle(s.x, s.y, rr).stroke({ width: 1, color: colour, alpha: 0.45 * fade });
      if (k.kind === "seen" && k.ageS < 2) g.poly(diamond).fill({ color: colour }).stroke({ width: 1, color: 0x000000, alpha: 0.6 });
      else g.poly(diamond).stroke({ width: 2, color: colour, alpha: fade });
    }
    // S8: "last seen" pins — a hollow pin standing on the spot (a hull: its hollow outline too), with the age.
    for (const p of overlay.pins ?? []) {
      const s = worldToScreen(c, p.x, p.y);
      if (p.cls === "vehicle") this.drawKnownVehicle(g, { target: p.target, x: p.x, y: p.y, errM: 0, kind: "seen", ageS: 1e9, cls: "vehicle", ...(p.vtype !== undefined ? { vtype: p.vtype } : {}), ...(p.heading !== undefined ? { heading: p.heading } : {}) }, s, colour, 0.55);
      const hy = s.y - 13;
      g.moveTo(s.x - 3.5, hy + 4).lineTo(s.x, s.y).lineTo(s.x + 3.5, hy + 4);
      g.stroke({ width: 1.5, color: colour, alpha: 0.85 });
      g.circle(s.x, hy, 5.5).fill({ color: 0x10140f, alpha: 0.55 }).stroke({ width: 2, color: colour, alpha: 0.9 });
      g.circle(s.x, s.y, 1.5).fill({ color: colour, alpha: 0.9 });
      this.request(p.label, s.x, hy, 6, PIN_LABEL_COLOUR, 3, 1_000_000 + p.target);
    }
  }

  /**
   * Bullets in flight and impact marks (owner decision 2026-11-11): tracer rounds as clear streaks, all other
   * bullets as very faint streaks (clear in the debug view), plus a puff where each one strikes.
   */
  private drawProjectiles(g: Graphics, state: SimView, alpha: number, overlay: Overlay, fog = false): void {
    const c = this.camera, W = this.width, H = this.height;
    // Craters stay (terrain damage is part of the battle state).
    for (const cr of state.terrain.craters) {
      const sx = (cr.x - c.x) * c.scale, sy = (cr.y - c.y) * c.scale;
      if (sx < -10 || sy < -10 || sx > W + 10 || sy > H + 10) continue;
      const rad = Math.max(2, cr.radiusM * 2.2 * c.scale);
      if (this.look === "photo") { this.scorch(sx, sy, rad * 2.3, cr.x * 7.1 + cr.y * 3.3); continue; } // soft, ragged
      g.circle(sx, sy, rad).fill({ color: 0x2b2018, alpha: 0.55 });
    }
    // Bursts: a bright flash that becomes a spreading grey-brown cloud.
    for (const b of this.bursts) {
      const sx = (b.x - c.x) * c.scale, sy = (b.y - c.y) * c.scale;
      if (sx < -80 || sy < -80 || sx > W + 80 || sy > H + 80) continue;
      const age = 1 - (b.untilTick - state.tick) / BURST_TICKS;
      const rad = Math.max(5, b.radiusM * c.scale * (0.5 + age));
      if (age < 0.12) g.circle(sx, sy, rad).fill({ color: 0xfff0a8, alpha: 0.95 });
      else g.circle(sx, sy, rad).fill({ color: 0x8a7c6a, alpha: 0.5 * (1 - age) });
    }
    for (const p of this.puffs) {
      const sx = (p.x - c.x) * c.scale, sy = (p.y - c.y) * c.scale;
      if (sx < -10 || sy < -10 || sx > W + 10 || sy > H + 10) continue;
      if (p.result === "flash") { // muzzle flash: brief and bright (pixel soldiers show their own, M7.5b)
        if (this.look !== "classic" && this.lod !== null && this.lod >= LOD_FIGURE) continue;
        g.circle(sx, sy, Math.max(2.5, 0.5 * c.scale)).fill({ color: 0xfff2b0, alpha: 0.9 });
        continue;
      }
      const age = 1 - (p.untilTick - state.tick) / PUFF_TICKS; // 0 new .. 1 gone
      const colour = p.result === "hit" ? 0xff4a3d : p.result === "ricochet" ? 0xffe27a : p.result === "penetrated" ? 0xffffff : 0xcdb894;
      g.circle(sx, sy, 1.5 + 4 * age).fill({ color: colour, alpha: 0.55 * (1 - age) });
    }
    const P = state.projectiles;
    if (P.count === 0) return;
    const back = (1 - alpha) * DT; // the picture is drawn between two simulation ticks
    const grenades: number[] = [];
    const missiles: number[] = [];
    for (let pass = 0; pass < 2; pass++) {
      const wantTracer = pass === 0;
      let drawn = 0;
      for (let i = 0; i < P.count; i++) {
        // Fog of war: of the enemy's projectiles only burning tracers are seen (not his bullets near the muzzle,
        // not his grenades in flight).
        const enemyOwned = fog && P.owner[i]! > 0 && state.identity.get(P.owner[i]!)?.side !== overlay.playerSide;
        const sp = this.special[P.ammo[i]!]!;
        if (enemyOwned && (sp !== 0 || !wantTracer)) continue;
        if (sp !== 0) {
          // Fragments are too many and too fast to draw; a grenade in flight or lying is a dark dot.
          if (sp === 1 && wantTracer) {
            const gx = (P.x[i]! - c.x) * c.scale, gy = (P.y[i]! - c.y) * c.scale;
            if (gx > -10 && gy > -10 && gx < W + 10 && gy < H + 10) grenades.push(gx, gy);
          }
          // A guided missile (owner 2026-11-13): its burning motor, a smoke trail behind it, and the wire back to
          // the launcher while its gunner guides it.
          if (sp === 3 && wantTracer) missiles.push(P.x[i]! - P.vx[i]! * back, P.y[i]! - P.vy[i]! * back, P.vx[i]!, P.vy[i]!, P.owner[i]!, P.bornTick[i]!);
          continue;
        }
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
    for (let k = 0; k < grenades.length; k += 2) g.circle(grenades[k]!, grenades[k + 1]!, Math.max(2.5, 0.15 * c.scale)).fill({ color: 0x1c1c1c }).stroke({ width: 1, color: 0xffd27a });
    for (let k = 0; k < missiles.length; k += 6) {
      const mx = missiles[k]!, my = missiles[k + 1]!, vx = missiles[k + 2]!, vy = missiles[k + 3]!, owner = missiles[k + 4]!, born = missiles[k + 5]!;
      const sx = (mx - c.x) * c.scale, sy = (my - c.y) * c.scale;
      for (const [vid, v] of state.vehicle.entries()) {
        const gd = v.stations.find((st) => st.guide && st.guide.gunner === owner && st.guide.launchTick === born)?.guide;
        const t = gd ? state.transform.get(vid) : undefined;
        if (t) g.moveTo((t.x - c.x) * c.scale, (t.y - c.y) * c.scale).lineTo(sx, sy).stroke({ width: 1, color: 0xe8e8e8, alpha: 0.35 });
      }
      const sp = Math.hypot(vx, vy) || 1, len = Math.max(10, 30 * c.scale);
      g.moveTo(sx, sy).lineTo(sx - (vx / sp) * len, sy - (vy / sp) * len).stroke({ width: Math.max(2, 0.5 * c.scale), color: 0xd8d2c4, alpha: 0.6 });
      g.circle(sx, sy, Math.max(3, 0.3 * c.scale)).fill({ color: 0xfff1a8 }).stroke({ width: 1.5, color: 0xff8a2a });
    }
  }

  /** Ask for a label beside an anchor point (placed at the end of the frame, M7.5a). */
  private request(text: string, x: number, y: number, r: number, colour: number, priority: number, id: number, force = false): void {
    let q = this.reqs[this.nReqs];
    if (!q) { q = { text, x, y, r, colour, priority, id }; this.reqs.push(q); }
    q.text = text; q.x = x; q.y = y; q.r = r; q.colour = colour; q.priority = priority; q.id = id; q.force = force;
    // Its symbol is kept clear of other labels (a small one: a big hull close up may carry labels over it).
    q.block = force || priority === 1 ? 0 : Math.min(r, 12);
    this.nReqs++;
  }

  /** Debug text at a fixed place (its top-left corner). */
  private force(text: string, x: number, y: number, colour: number): void { this.request(text, x, y, 0, colour, -1, 0, true); }

  /** Place this frame's labels without overlaps and show them (the rest of the pool hidden). */
  private flushLabels(): void {
    this.reqs.length = Math.max(this.reqs.length, this.nReqs);
    const live = this.nReqs === this.reqs.length ? this.reqs : this.reqs.slice(0, this.nReqs);
    const placed = placeLabels(live, this.width, this.height, this.hudRects);
    let i = 0;
    for (const p of placed) {
      const q = live[p.index]!;
      let t = this.labelPool[i];
      if (!t) {
        // (A dark outline keeps the side's colour readable on any ground, M7.5a.)
        // (Photo look: a 2 px stroke each side, the picture is busier than the flat map.)
        t = new Text({ text: q.text, style: { fontFamily: "system-ui, sans-serif", fontSize: 12, fill: q.colour, stroke: { color: 0x0b0f0a, width: this.look === "photo" ? 4 : 3, join: "round" } } });
        this.labelPool.push(t);
        this.labels.addChild(t);
      }
      if (t.text !== q.text) t.text = q.text;
      if (t.style.fill !== q.colour) t.style.fill = q.colour;
      t.visible = true;
      t.position.set(p.x, p.y);
      i++;
    }
    for (; i < this.labelPool.length; i++) this.labelPool[i]!.visible = false;
  }

  private pos(state: SimView, id: EntityId, alpha: number): { x: number; y: number } {
    const t = state.transform.req(id);
    const p = this.prev.get(id);
    if (!p) return t;
    return { x: p.x + (t.x - p.x) * alpha, y: p.y + (t.y - p.y) * alpha };
  }

  /**
   * One pixel soldier (M7.5b): the frame from his state (dead, down, captive, surrendered, posture; walking
   * frames while he moves, the firing frame just after a shot), his weapon's look, a launcher on his back, wound
   * marks; snapped to 16 facings. Two sprites from the pool: the figure, and the 1-px outline in the side's
   * colour (the selected unit gets a thin white ring, drawn by the caller).
   */
  /** The floor of a man inside a building when it is not the floor shown there (M7.5d), else -1. */
  private otherFloor(t: { x: number; y: number; z: number }): number {
    const b = this.bld;
    if (!b || !this.map) return -1;
    const bi = b.buildingAt(t.x, t.y);
    if (bi < 0) return -1;
    const bd = this.map.buildings[bi]!;
    if (!bd.interior || bd.storeys < 2) return -1;
    const f = floorAtZ(bd, t.z);
    return f === b.floorShown(bi) ? -1 : f;
  }

  private drawMan(state: SimView, id: EntityId, faction: string, sol: DeepReadonly<SoldierState> | undefined, heading: number, x: number, y: number, size: number, colour: number, alpha = 1): void {
    if (!this.atlas) this.atlas = new SoldierAtlas();
    const k = this.key;
    const t = state.transform.req(id), p = this.prev.get(id);
    const moving = p !== undefined && (Math.abs(p.x - t.x) > 1e-4 || Math.abs(p.y - t.y) > 1e-4);
    const step = ((state.tick + id * 7) / 12 | 0) & 1;
    let frame: FrameId;
    if (sol?.casualty === "killed") frame = "dead";
    else if (sol && sol.casualty !== "none") frame = "down";
    else if (sol?.captive) frame = sol.captive.state === "captured" ? "captive" : "surrender";
    else if (sol?.posture === "prone") frame = moving && step ? "crawl" : "prone";
    else if (sol?.posture === "crouching") frame = moving && step ? "crouchWalk" : "crouch";
    else frame = moving ? (step ? "walk2" : "walk1") : "stand";
    k.frame = frame;
    const w = state.weapon.get(id);
    k.weapon = (w ? weaponLook(this.weaponType[w.weapon]) : "rifle") as WeaponLook;
    k.firing = (this.firedAt.get(id) ?? -1e9) >= state.tick - FIRE_FRAME_TICKS;
    k.wounded = sol !== undefined && sol.wounds.some((wd) => wd.mechanism !== "blunt");
    // A launcher on his back (refreshed every 2 s of game time).
    let lc = this.carriesLauncher.get(id);
    if (!lc || state.tick - lc.tick >= 120 || state.tick < lc.tick) {
      let yes = false;
      if (this.launchers.size > 0) for (const st of state.container.get(id)?.stacks ?? []) if (st.count > 0 && this.launchers.has(st.type)) { yes = true; break; }
      lc = { tick: state.tick, yes };
      this.carriesLauncher.set(id, lc);
    }
    k.launcher = lc.yes;
    k.facing = facingOf(heading);
    const cell = this.atlas.get(this.atlas.slot(faction, lookOf(this.appearance, faction)), k);
    let fig = this.figures[this.nSprites], out = this.outlines[this.nSprites];
    if (!fig || !out) {
      fig = new Sprite(cell.figure); out = new Sprite(cell.outline);
      fig.anchor.set(PIVOT / CELL); out.anchor.set(PIVOT / CELL);
      this.figures.push(fig); this.outlines.push(out);
      // All outlines under all figures (a neighbour's outline never cuts into a man).
      this.menLayer.addChildAt(out, this.nSprites);
      this.menLayer.addChild(fig);
    }
    this.nSprites++;
    if (fig.texture !== cell.figure) fig.texture = cell.figure;
    if (out.texture !== cell.outline) out.texture = cell.outline;
    const sc = size / 16;
    fig.position.set(x, y); out.position.set(x, y);
    fig.scale.set(sc); out.scale.set(sc);
    const dead = frame === "dead";
    fig.tint = dead ? 0xa8a8a0 : 0xffffff;
    out.tint = colour;
    out.alpha = (dead ? 0.55 : 1) * alpha;
    fig.alpha = alpha;
    fig.visible = true; out.visible = true;
    if (this.look === "photo") {
      // A soft contact shadow under him (a little down-sun) and a dark rim outside the side-colour outline, so he
      // stands on the ground and reads on any field (plan "photo", step "polish").
      const i = this.nSprites - 1;
      let sh = this.contacts[i], rim = this.rims[i];
      if (!sh || !rim) {
        sh = new Sprite(this.decals().contact); sh.anchor.set(0.5);
        rim = new Sprite(cell.outline); rim.anchor.set(PIVOT / CELL); rim.tint = RIM;
        this.contacts.push(sh); this.rims.push(rim);
        this.contactC.addChild(sh); this.rimC.addChild(rim);
      }
      const lying = frame === "dead" || frame === "down" || frame === "prone" || frame === "crawl";
      const k2 = lying ? 1.35 : 1;
      sh.position.set(x + SHADOW_DIR.dx * size * 0.28, y + SHADOW_DIR.dy * size * 0.28);
      sh.width = size * CONTACT_W * k2; sh.height = size * CONTACT_H * k2;
      sh.alpha = CONTACT_ALPHA * alpha; sh.visible = true;
      if (rim.texture !== cell.outline) rim.texture = cell.outline;
      rim.scale.set(sc * (1 + Math.min(0.3, 1.2 / (0.3 * size))));
      rim.position.set(x, y);
      rim.alpha = (dead ? 0.4 : 0.8) * alpha; rim.visible = true;
    }
  }

  /** A scorch decal (photo: wrecks and craters) `d` px across at screen (x, y), turned by `turn` rad. */
  private scorch(x: number, y: number, d: number, turn: number): void {
    let sc = this.scorches[this.nScorch];
    if (!sc) { sc = new Sprite(this.decals().scorch); sc.anchor.set(0.5); this.scorches.push(sc); this.scorchC.addChild(sc); }
    sc.position.set(x, y); sc.width = sc.height = d; sc.rotation = turn % 6.283; sc.visible = true;
    this.nScorch++;
  }

  /** Hide the pool's unused sprites and upload new atlas cells. */
  private flushSprites(): void {
    for (let i = this.nSprites; i < this.figures.length; i++) { this.figures[i]!.visible = false; this.outlines[i]!.visible = false; }
    for (let i = this.look === "photo" ? this.nSprites : 0; i < this.contacts.length; i++) { this.contacts[i]!.visible = false; this.rims[i]!.visible = false; }
    for (let i = this.look === "photo" ? this.nScorch : 0; i < this.scorches.length; i++) this.scorches[i]!.visible = false;
    this.atlas?.flush();
  }

  /** The roof-fade rule (M7.5b): own able men on foot near a building, or zoomed in close. */
  private updateRoofs(state: SimView, overlay: Overlay, lod: Lod): void {
    if (!this.bld) return;
    this.roofLayer.visible = lod !== LOD_SYMBOLS || this.look !== "classic";
    let n = 0;
    for (const [id, ident] of state.identity.entries()) {
      if (ident.side !== overlay.playerSide) continue;
      const s = state.soldier.get(id);
      if (!s || s.mount !== undefined || s.casualty !== "none" || s.captive !== null) continue;
      const t = state.transform.get(id);
      if (!t) continue;
      if (2 * n + 2 > this.roofMen.length) { const b = new Float64Array(this.roofMen.length * 2); b.set(this.roofMen); this.roofMen = b; }
      this.roofMen[2 * n] = t.x; this.roofMen[2 * n + 1] = t.y; n++;
    }
    this.bld.update(this.roofMen, n, lod === LOD_CLOSE, this.camera.scale);
  }

  private drawGround(map: MapDef, lod: Lod = LOD_DOTS): void {
    const c = this.camera;
    this.worldLayer.scale.set(c.scale);
    this.worldLayer.position.set(-c.x * c.scale, -c.y * c.scale);
    this.roofLayer.scale.set(c.scale);
    this.roofLayer.position.set(-c.x * c.scale, -c.y * c.scale);
    // Flat map (M7.5b): detail tiles from the figure level in; contour lines only at the dot and symbol levels.
    // S14 (the "map-feel" step): the top-bar toggle shows them at every zoom (close up: fine tiles in a pale ink).
    this.tiles?.update({ x: c.x, y: c.y, w: this.width / c.scale, h: this.height / c.scale }, c.scale, lod >= LOD_FIGURE, lod <= LOD_DOTS || this.contoursAlways, this.contoursAlways);
    if (this.grain) {
      const a = GRAIN_ALPHA * Math.min(1, Math.max(0, (c.scale - GRAIN_FROM) / GRAIN_FROM));
      this.grain.visible = a > 0.01;
      this.grain.alpha = a;
    }
    const g = this.world;
    g.clear();
    if (this.terrain) {
      // Terrain picture present: only a thin map border. Photo, symbols zoom: a light veil so the symbols stand out
      // from the busy picture (plan "photo", step "polish").
      const tl = worldToScreen(c, 0, 0);
      if (this.look === "photo" && lod === LOD_SYMBOLS) g.rect(tl.x, tl.y, map.widthM * c.scale, map.heightM * c.scale).fill({ color: VEIL_COLOUR, alpha: VEIL_ALPHA });
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

/** A white flag on a pole beside a man who has surrendered (M6.6). */
/** A broken line (dash, gap) in screen pixels; the caller strokes it. */
function dashed(g: Graphics, ax: number, ay: number, bx: number, by: number, dash: number, gap: number): void {
  const len = Math.hypot(bx - ax, by - ay);
  if (len < 0.5) return;
  const ux = (bx - ax) / len, uy = (by - ay) / len;
  // (Long lines when zoomed in: at most 400 dashes.)
  const step = Math.max(dash + gap, len / 400);
  for (let d = 0; d < len; d += step) {
    const e = Math.min(len, d + dash * (step / (dash + gap)));
    g.moveTo(ax + ux * d, ay + uy * d).lineTo(ax + ux * e, ay + uy * e);
  }
}

function drawWhiteFlag(g: Graphics, x: number, y: number, r: number): void {
  const k = Math.max(r, 4);
  g.moveTo(x + 0.6 * k, y).lineTo(x + 0.6 * k, y - 2.6 * k).stroke({ width: 1.5, color: 0x2a2a2a });
  g.rect(x + 0.6 * k, y - 2.6 * k, 1.4 * k, 0.9 * k).fill({ color: 0xffffff }).stroke({ width: 1, color: 0x2a2a2a });
}

function unitIsOrContains(state: SimView, ancestor: EntityId, unit: EntityId): boolean {
  let u: EntityId | null = unit;
  while (u !== null) {
    if (u === ancestor) return true;
    u = state.unit.get(u)?.parent ?? null;
  }
  return false;
}

/** Photo look (plan "photo", step "polish"): close-zoom grain (256 px over GRAIN_TILE_M metres) fades in from
 *  GRAIN_FROM px/m to full GRAIN_ALPHA at twice that; the symbols-zoom veil. */
const GRAIN_TILE_M = 16, GRAIN_FROM = 12, GRAIN_ALPHA = 0.55;
const VEIL_COLOUR = 0xdedbd0, VEIL_ALPHA = 0.15;
/** A hull's shadow offset (m, down-sun) and a wreck's scorch decal size (m across). */
const HULL_SHADOW_M = 0.6, SCORCH_M = 8;
/** A man's contact shadow (photo): width and depth as a share of his 1 m sprite, alpha, rim colour of dots. */
const CONTACT_W = 1.4, CONTACT_H = 1.1, CONTACT_ALPHA = 0.5, RIM = 0x121410;
/** Where shadows fall (photo light): screen offset direction per metre of height. */
const SHADOW_DIR = shadowOffset(1 / 0.6);
/** Under-stroke of overlay lines on the photo map: dark, 2 px wider than the line. */
const UNDER = 0x0b0f0a;
/** A side colour 15 % toward white (the core of a photo-look dot). */
function lighten(c: number, k = 0.15): number {
  const r = (c >> 16) & 255, g = (c >> 8) & 255, b = c & 255;
  return (Math.round(r + (255 - r) * k) << 16) | (Math.round(g + (255 - g) * k) << 8) | Math.round(b + (255 - b) * k);
}

/** Men on another floor than the one shown (M7.5d) are drawn this faint. */
const GHOST_ALPHA = 0.35;

/** 3 x 5 pixel glyphs for the floor badge: G and the digits. */
const BADGE_GLYPHS: Record<string, string> = {
  G: "111100101101111", 0: "111101101101111", 1: "010110010010111", 2: "111001111100111", 3: "111001111001111",
  4: "101101111001001", 5: "111100111001111", 6: "111100111101111", 7: "111001001001001", 8: "111101111101111", 9: "111101111001111",
};

/**
 * A small dark badge with the floor's label at (x, y) (its bottom-left corner), pixel size `px`: the floor's number,
 * or `ground` (the string table's ground-floor label, Rule 12) for the ground floor. Characters without a pixel
 * glyph are drawn as the G glyph.
 */
export function drawFloorBadge(g: Graphics, x: number, y: number, floor: number, px: number, ground: string): void {
  const label = floor <= 0 ? ground.toUpperCase() : String(floor);
  const w = (label.length * 4 + 1) * px, h = 7 * px;
  g.rect(x, y - h, w, h).fill({ color: 0x10140f, alpha: 0.85 }).stroke({ width: 1, color: 0xe8e4d8, alpha: 0.8 });
  for (let c = 0; c < label.length; c++) {
    const gl = BADGE_GLYPHS[label[c]!] ?? BADGE_GLYPHS.G!;
    for (let k = 0; k < 15; k++) if (gl[k] === "1") g.rect(x + (1 + c * 4 + (k % 3)) * px, y - h + (1 + Math.floor(k / 3)) * px, px, px);
  }
  g.fill({ color: 0xe8e4d8 });
}
