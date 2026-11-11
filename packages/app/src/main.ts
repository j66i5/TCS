/**
 * The browser app: wires data -> scenario -> simulation -> renderer + UI.
 *
 * Real time lives ONLY here. Each animation frame adds elapsed wall time to an accumulator and runs
 * as many fixed 1/60 s simulation steps as fit; the renderer interpolates between the last two.
 * Player input becomes ORDERS submitted to the simulation, exactly like an AI or a replay would.
 */
import { formatErrors, Strings } from "@tcs/data";
import { demoBattle, MAP_KINDS, type MapKind } from "@tcs/scenario";
import { wanderController } from "@tcs/ai";
import {
  eyeHeightM, heightAt, sight,
  buildSpatialHash, createSim, DT, navFor, queryRadius, simHash, step, submitOrder, ticksToSeconds,
  type EntityId, type Order, type Sim, type SimEvent,
} from "@tcs/sim";
import { BattleRenderer, SIDE_COLOURS, type Overlay } from "@tcs/render";
import { attachInput, createHud } from "@tcs/ui";
import { loadBundledData } from "./data";

const MAX_STEPS_PER_FRAME = 240; // never spiral: drop time instead

async function main(): Promise<void> {
  const hudRoot = document.getElementById("hud")!;
  const mapRoot = document.getElementById("map")!;
  const { data, errors } = loadBundledData();
  if (!data) {
    hudRoot.textContent = `Data failed to load:\n${formatErrors(errors)}`;
    return;
  }
  const strings = new Strings(data, "en");
  const params = new URLSearchParams(location.search);
  const seed = Number(params.get("seed") ?? 1) >>> 0;
  const factions = (params.get("factions") ?? "de,ru").split(",") as [string, string];
  const mapParam = params.get("map") ?? "village";
  const mapKind = (MAP_KINDS as readonly string[]).includes(mapParam) ? (mapParam as MapKind) : undefined;

  const input = demoBattle(data, { seed, factions, timeLimitSeconds: 3600, mapKind, mapSeed: seed });
  const sim: Sim = createSim(input);
  const playerSide = "blue";
  const ai = [wanderController("red", seed + 1000, input.map, 30)];
  const orderLog: Order[] = [];

  const renderer = await BattleRenderer.create(mapRoot);
  renderer.setMap(input.map, input.catalog);
  const topUnits = [...sim.state.unit.entries()].filter(([, u]) => u.side === playerSide && u.parent === null).map(([id]) => id);
  const overlay: Overlay = { playerSide, selectedUnit: topUnits[0] ?? null, debug: false };

  let speed = 1;
  let moveMode = "walk";
  let tapMode: "move" | "fire" | "grenade" | "grenades" = "move";
  /** Undefined until the player picks one: then the faction's doctrine default applies. */
  let formation: string | undefined;
  const kinds = [...MAP_KINDS, "flat"];
  const playerFaction = sim.state.sides.find((s) => s.id === playerSide)?.faction ?? "";
  const hud = createHud(hudRoot, strings, {
    formations: Object.keys(input.catalog.formations).sort(),
    defaultFormation: input.catalog.factions[playerFaction]?.defaultFormation ?? Object.keys(input.catalog.formations)[0] ?? "",
    mapLabel: `${strings.t(`map.${mapKind ?? "flat"}`)} ${seed}`,
    onNextMap: () => {
      const next = kinds[(kinds.indexOf(mapKind ?? "flat") + 1) % kinds.length]!;
      const q = new URLSearchParams(location.search);
      q.set("map", next);
      location.search = q.toString();
    },
    onSpeed: (v) => { speed = v; },
    onMoveMode: (m) => { moveMode = m; },
    onTapMode: (m) => { tapMode = m; },
    onCeaseFire: () => {
      if (overlay.selectedUnit !== null) issue({ tick: sim.state.tick, issuer: playerSide, target: overlay.selectedUnit, kind: "ceaseFire" });
    },
    onFormation: (f) => { formation = f; },
    onPosture: (p) => {
      if (overlay.selectedUnit !== null) issue({ tick: sim.state.tick, issuer: playerSide, target: overlay.selectedUnit, kind: "posture", posture: p });
    },
    onDebug: (on) => {
      overlay.debug = on;
      // Debug view shows the navigation grid soldiers plan their routes on.
      renderer.setNavOverlay(on ? navFor(sim.ctx, "foot").grid : null);
      // ... and what the selected unit's leader can see (refreshed every 2 s of game time).
      renderer.setSightOverlay(on ? sightView() : null);
      sightAt = sim.state.tick;
    },
  });

  // Fit the map into the area not covered by the top bar and the radio log.
  const barH = (hudRoot.querySelector(".hud-bar") as HTMLElement | null)?.offsetHeight ?? 50;
  const insets = { top: barH, right: 0, bottom: 64, left: 0 };
  // Start in the tactical view: about 500 m across, centred between your team and the map centre.
  const own = [...sim.state.identity.entries()].filter(([, i]) => i.side === playerSide).map(([id]) => sim.state.transform.req(id));
  if (own.length > 0 && input.map.widthM > 600) {
    const ox = own.reduce((a, t) => a + t.x, 0) / own.length, oy = own.reduce((a, t) => a + t.y, 0) / own.length;
    // Look from the team toward the map centre, 600 m across.
    renderer.focus(ox + 0.4 * (input.map.widthM / 2 - ox), oy + 0.4 * (input.map.heightM / 2 - oy), 600, insets);
  } else {
    renderer.fitToMap(input.map, insets);
  }

  const issue = (order: Order) => {
    orderLog.push(order);
    submitOrder(sim, order);
  };

  attachInput(mapRoot, {
    getCamera: () => renderer.camera,
    setCamera: (c) => { renderer.camera = c; },
    onTap: (w) => {
      // Tap on one of your men: select his top-level unit. Elsewhere: move the selected unit there.
      const hit = nearestSoldier(sim, w.x, w.y, 12 / renderer.camera.scale + 1);
      if (hit !== null && sim.state.identity.req(hit).side === playerSide) {
        overlay.selectedUnit = topUnitOf(sim, sim.state.identity.req(hit).unit);
        return;
      }
      if (overlay.selectedUnit === null) return;
      if (w.x < 0 || w.y < 0 || w.x > input.map.widthM || w.y > input.map.heightM) return;
      if (tapMode === "grenade" || tapMode === "grenades") {
        // "grenades": every man who can reach the point throws or fires, a moment apart.
        issue({ tick: sim.state.tick, issuer: playerSide, target: overlay.selectedUnit, kind: "grenade", x: w.x, y: w.y, ...(tapMode === "grenades" ? { count: 50 } : {}) });
        return;
      }
      if (tapMode === "fire") {
        issue({ tick: sim.state.tick, issuer: playerSide, target: overlay.selectedUnit, kind: "fire", x: w.x, y: w.y });
        return;
      }
      issue({ tick: sim.state.tick, issuer: playerSide, target: overlay.selectedUnit, kind: "move", waypoints: [{ x: w.x, y: w.y, mode: moveMode }], ...(formation ? { formation } : {}) });
    },
  });

  const sideColour = (side: string) => {
    const i = sim.state.sides.findIndex((s) => s.id === side);
    return `#${(SIDE_COLOURS[i] ?? 0xffffff).toString(16).padStart(6, "0")}`;
  };
  const handleEvents = (events: SimEvent[]) => {
    renderer.onEvents(events, sim.state, overlay);
    for (const e of events) {
      if (e.kind === "radio" && e.side === playerSide) {
        const faction = sim.state.identity.get(e.from)?.faction;
        hud.radio(strings.t(e.key, e.params, faction), ticksToSeconds(e.tick), sideColour(e.side));
      } else if (e.kind === "order.rejected" && e.issuer === playerSide) {
        hud.radio(strings.t("order.rejected", { reason: e.reason }), ticksToSeconds(e.tick), "#ffb4b4");
      }
    }
  };

  /** Advance the simulation by one tick: AI thinks, renderer remembers positions, step, events out. */
  /** Debug: what the selected unit's leader can see of a kneeling man, within 400 m, every 10 m. */
  const sightView = () => {
    const uid = overlay.selectedUnit;
    const u = uid === null ? undefined : sim.state.unit.get(uid);
    // The leader, or the first of the unit's men who is alive and conscious.
    const able = (id: EntityId) => { const x = sim.state.soldier.get(id); return x !== undefined && x.physiology.alive && x.physiology.consciousness >= 0.5; };
    const leader = u?.leader ?? u?.members.find(able);
    const t = leader === undefined ? undefined : sim.state.transform.get(leader);
    const s = leader === undefined ? undefined : sim.state.soldier.get(leader);
    if (!t || !s) return null;
    const R = 400, cellM = 10, n = (2 * R) / cellM;
    const x0 = t.x - R, y0 = t.y - R;
    const ez = heightAt(input.map, t.x, t.y) + eyeHeightM(sim.ctx, s.posture);
    const vis = new Uint8Array(n * n).fill(255); // beyond the radius: not tinted (not looked at)
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
      const x = x0 + (c + 0.5) * cellM, y = y0 + (r + 0.5) * cellM;
      if (x < 0 || y < 0 || x >= input.map.widthM || y >= input.map.heightM || (x - t.x) ** 2 + (y - t.y) ** 2 > R * R) continue;
      const v = sight(sim.ctx, t.x, t.y, ez, x, y, heightAt(input.map, x, y) + 0.75).visibility;
      vis[r * n + c] = Math.max(0, Math.min(255, Math.round(v * 255)));
    }
    return { vis, cols: n, rows: n, cellM, x0, y0 };
  };
  let sightAt = -1, sightFor: EntityId | null = null, sightReal = -1e9;
  const stepOnce = () => {
    for (const c of ai) for (const o of c.think(sim.state, sim.state.tick)) issue(o);
    renderer.capturePrevious(sim.state);
    handleEvents(step(sim));
  };

  // Hook for the headless screenshot script and for debugging in the browser console.
  (window as unknown as { __tcs: unknown }).__tcs = {
    sim,
    orderLog,
    stepTicks: (n: number) => { for (let i = 0; i < n; i++) stepOnce(); },
    grenadeAt: (x: number, y: number, count = 1) => issue({ tick: sim.state.tick, issuer: playerSide, target: overlay.selectedUnit as EntityId, kind: "grenade", x, y, count }),
    fireAt: (x: number, y: number) => issue({ tick: sim.state.tick, issuer: playerSide, target: overlay.selectedUnit as EntityId, kind: "fire", x, y }),
    posture: (p: "standing" | "crouching" | "prone") => issue({ tick: sim.state.tick, issuer: playerSide, target: overlay.selectedUnit as EntityId, kind: "posture", posture: p }),
    setDebug: (on: boolean) => { overlay.debug = on; renderer.setNavOverlay(on ? navFor(sim.ctx, "foot").grid : null); renderer.setSightOverlay(on ? sightView() : null); sightAt = sim.state.tick; },
    tap: (x: number, y: number) => issue({ tick: sim.state.tick, issuer: playerSide, target: overlay.selectedUnit as EntityId, kind: "move", waypoints: [{ x, y, mode: moveMode }], ...(formation ? { formation } : {}) }),
    setSpeed: (v: number) => { speed = v; },
    focus: (x: number, y: number, widthM: number) => renderer.focus(x, y, widthM),
    hash: () => simHash(sim),
    ready: true,
  };

  let acc = 0;
  let last = performance.now();
  let frames = 0, fpsT0 = last, fps = 0, ticksAtT0 = sim.state.tick, simRate = 0, hash = simHash(sim);
  renderer.app.ticker.add(() => {
    const now = performance.now();
    acc += Math.min(0.25, (now - last) / 1000) * speed;
    last = now;
    let steps = 0;
    while (acc >= DT && steps < MAX_STEPS_PER_FRAME) { stepOnce(); acc -= DT; steps++; }
    if (steps === MAX_STEPS_PER_FRAME) acc = 0;
    // Refreshed every 2 s of game time, when the selection changes (also while paused), at most once a second
    // of real time (a few thousand sight checks each).
    if (overlay.debug && (sim.state.tick - sightAt >= 120 || overlay.selectedUnit !== sightFor) && now - sightReal >= 1000) {
      sightAt = sim.state.tick; sightFor = overlay.selectedUnit; sightReal = now;
      renderer.setSightOverlay(sightView());
    }
    renderer.draw(sim.state, input.map, Math.min(1, acc / DT), overlay);
    frames++;
    if (now - fpsT0 >= 1000) {
      fps = (frames * 1000) / (now - fpsT0);
      simRate = ticksToSeconds(sim.state.tick - ticksAtT0) / ((now - fpsT0) / 1000);
      if (overlay.debug) hash = simHash(sim);
      frames = 0; fpsT0 = now; ticksAtT0 = sim.state.tick;
    }
    hud.update({ simSeconds: ticksToSeconds(sim.state.tick), tick: sim.state.tick, fps, simRate, hash, entities: sim.state.nextEntityId - 1 });
  });
}

function nearestSoldier(sim: Sim, x: number, y: number, radius: number): EntityId | null {
  const ids = queryRadius(buildSpatialHash(sim.state), sim.state, x, y, radius);
  let best: EntityId | null = null;
  let bestD = Infinity;
  for (const id of ids) {
    const t = sim.state.transform.req(id);
    const d = (t.x - x) ** 2 + (t.y - y) ** 2;
    if (d < bestD) { bestD = d; best = id; }
  }
  return best;
}

function topUnitOf(sim: Sim, unit: EntityId): EntityId {
  let u = unit;
  for (;;) {
    const p = sim.state.unit.get(u)?.parent ?? null;
    if (p === null) return u;
    u = p;
  }
}

main().catch((e: unknown) => {
  const pre = document.createElement("pre");
  pre.className = "hud-error";
  pre.textContent = `Startup failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`;
  document.body.append(pre);
});
