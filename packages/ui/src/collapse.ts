/**
 * Collapsible sub-units in the unit sidebar (owner 2026-11-20, "make the subunits collapsable"). Pure: works on the
 * tile list `unitTiles` builds (depth first) and a set of collapsed keys; the sidebar only lays the rows out.
 *
 * A tile of kind "hq" (a unit with sub-units) can fold its sub-tree: every tile after it that is deeper than it
 * (its HQ group, its drone, its squads and vehicles and theirs). Its key is the callsign path from the top-level
 * unit down ("1. Kp/1. Zug"), so it is the same after a re-render or a save and load. A folded tile shows how many
 * sub-units it hides and the worst state among them (`alert`), so folding never hides trouble; its men count
 * (fit/total) already covers the whole sub-tree (`unitTiles` counts every man of the unit and below).
 */
import type { EntityId } from "@tcs/sim";
import { tilePart, type TilePart, type TileState, type UnitTile } from "./sidebar";

/** States worth flagging on a folded tile, worst first (pinned and damaged alike; firing = in contact). */
export const ALERT_ORDER: readonly TileState[] = ["broken", "pinned", "damaged", "firing", "lost"];

export interface TileRow {
  tile: UnitTile;
  /** Index in the full tile list. */
  index: number;
  /** The fold key (callsign path) of a tile that has sub-tiles; null otherwise. */
  fold: string | null;
  /** Folded now (only a tile with a fold key). */
  collapsed: boolean;
  /** Folded: sub-units hidden under it (units: squads, vehicles, platoons; not its HQ group or drone tiles). */
  hidden: number;
  /** Folded: the worst state among the hidden tiles (ALERT_ORDER; drones left out), or null if none is worth it. */
  alert: TileState | null;
  /** Folded with the selected tile somewhere below it. */
  holdsSelected: boolean;
}

/** The fold key of each tile (callsign path) for tiles with sub-tiles, null for the others; and each tile's
 *  enclosing foldable tiles (indices, outermost first). */
export function foldKeys(tiles: readonly UnitTile[]): { keys: (string | null)[]; ancestors: number[][] } {
  const keys: (string | null)[] = [], ancestors: number[][] = [];
  const stack: number[] = [];
  tiles.forEach((t, i) => {
    while (stack.length > 0 && tiles[stack[stack.length - 1]!]!.depth >= t.depth) stack.pop();
    ancestors.push([...stack]);
    const sub = tiles[i + 1] !== undefined && tiles[i + 1]!.depth > t.depth;
    if (t.kind === "hq" && sub) {
      keys.push([...stack.map((j) => tiles[j]!.callsign), t.callsign].join("/"));
      stack.push(i);
    } else keys.push(null);
  });
  return { keys, ancestors };
}

const isUnitTile = (t: UnitTile) => t.kind !== "drone" && t.kind !== "hqGroup";
const rank = (s: TileState) => { const r = ALERT_ORDER.indexOf(s); return r < 0 ? ALERT_ORDER.length : r; };

/** The tiles to show (those under a folded tile left out), each with its fold state and roll-up. `selected`: the
 *  selected unit and part, to mark the folded tile that holds it. */
export function visibleTiles(tiles: readonly UnitTile[], collapsed: ReadonlySet<string>, selected?: { unit: EntityId | null; part?: TilePart }): TileRow[] {
  const { keys, ancestors } = foldKeys(tiles);
  const rows: TileRow[] = [];
  tiles.forEach((t, i) => {
    if (ancestors[i]!.some((a) => collapsed.has(keys[a]!))) return;
    const fold = keys[i]!, folded = fold !== null && collapsed.has(fold);
    let hidden = 0, alert: TileState | null = null, holdsSelected = false;
    if (folded) {
      for (let j = i + 1; j < tiles.length && tiles[j]!.depth > t.depth; j++) {
        const u = tiles[j]!;
        if (isUnitTile(u)) hidden++;
        if (u.kind !== "drone" && rank(u.state) < ALERT_ORDER.length && (alert === null || rank(u.state) < rank(alert))) alert = u.state;
        if (selected && selected.unit === u.unit && selected.part === tilePart(u)) holdsSelected = true;
      }
    }
    rows.push({ tile: t, index: i, fold, collapsed: folded, hidden, alert, holdsSelected });
  });
  return rows;
}

/** The collapsed set with every fold above the given tile opened (a unit selected from the map, the keys, the card
 *  or an event shows its tile). The same set back if nothing above it was folded. */
export function expandTo(tiles: readonly UnitTile[], collapsed: ReadonlySet<string>, unit: EntityId, part?: TilePart): ReadonlySet<string> {
  const i = tiles.findIndex((t) => t.unit === unit && tilePart(t) === part);
  if (i < 0 || collapsed.size === 0) return collapsed;
  const { keys, ancestors } = foldKeys(tiles);
  const shut = ancestors[i]!.map((a) => keys[a]!).filter((k) => collapsed.has(k));
  if (shut.length === 0) return collapsed;
  const out = new Set(collapsed);
  for (const k of shut) out.delete(k);
  return out;
}
