/**
 * BATTERIES (M11.6): the battery fitted in each powered device a man carries (radio, goggle, thermal sight).
 *
 * A device item with `power` runs on a battery item (charge in Wh) and draws `battery.chargeCapacity / hours` W. The
 * battery in use sits in a `PowerSlot` on the man (outside his container, like the magazine in his weapon); his spares
 * are counted items in his load (rule 9). The charge is not stepped every tick: a slot holds the charge `wh0` at tick
 * `since`, and `chargeAt` works out the charge now while the device is on. Switching a device on or off, or changing
 * its battery, restamps the slot. Plain arithmetic only (no transcendental maths).
 */
import type { Catalog, ItemTypeDef, PowerDef } from "./catalog";
import type { PowerSlot, SoldierState } from "./components";
import { TICK_HZ, type DefId, type EntityId } from "./ids";
import { removeItems, type Container, type ItemStack } from "./items";
import { nextFloat, Streams, type RngState } from "./rng";
import type { SimView } from "./state";

/** "Never" as a tick: finite, so it survives JSON (Infinity would not). */
export const NEVER_TICK = 1e9;

/** Ticks per watt-hour per watt: a battery of `wh` lasts wh * TICKS_PER_WH / W ticks. */
const TICKS_PER_WH = 3600 * TICK_HZ;

/** A charge as it is booked when a battery goes back into a load: rounded down to 0.01 (stacks stay mergeable). */
export function settle(x: number): number {
  return Math.floor(x * 100 + 1e-9) / 100;
}

/** The device's power definition and its draw (W), or null for an unpowered item (or a battery missing from the catalog). */
export function powerOf(catalog: Catalog, device: DefId): { def: PowerDef; drawW: number; capWh: number } | null {
  const d = catalog.items[device]?.power;
  if (!d) return null;
  const cap = catalog.items[d.battery]?.chargeCapacity;
  if (cap === undefined) return null;
  return { def: d, drawW: cap / d.hours, capWh: cap };
}

/** The slot's battery charge (Wh) at `tick`. */
export function chargeAt(slot: Readonly<PowerSlot>, tick: number): number {
  if (!slot.on || slot.battery === null) return slot.wh0;
  const left = slot.wh0 - (slot.drawW * (tick - slot.since)) / TICKS_PER_WH;
  return left > 0 ? left : 0;
}

/** Restamp a slot at `tick` with charge `wh` and on/off state `on` (recomputes its flat tick). */
export function stampSlot(slot: PowerSlot, wh: number, on: boolean, tick: number): void {
  slot.wh0 = wh;
  slot.since = tick;
  slot.on = on;
  slot.flatTick = on && slot.battery !== null && slot.drawW > 0 ? tick + Math.ceil((wh * TICKS_PER_WH) / slot.drawW) : NEVER_TICK;
}

/** True when the slot's device works at `tick`: switched on, with a battery that has charge left (a device switched
 *  off gives nothing: review fix 2026-11-16, or a night device off by day would work free). */
export function slotLive(slot: Readonly<PowerSlot>, tick: number): boolean {
  return slot.battery !== null && slot.on && tick < slot.flatTick;
}

/**
 * Whether man `id`'s device `device` has power at `tick`: true for an unpowered item and for a man without a slot for
 * it (a save from before M11.6); else his slot's battery has charge left. One lookup and an integer compare.
 */
export function deviceLive(catalog: Catalog, state: SimView, id: EntityId, device: DefId, tick: number): boolean {
  if (!catalog.items[device]?.power) return true;
  const slots = state.soldier.get(id)?.power;
  if (!slots) return true;
  for (const s of slots) if (s.device === device) return slotLive(s, tick);
  return true;
}

/** Whether a device with this definition wants to be on at light `light`. */
export function wantOn(def: PowerDef, light: number): boolean {
  return def.onBelowLight === undefined || light < def.onBelowLight;
}

/** The fullest charge among the spares of `battery` in a container (-1: none). No allocation. */
export function fullestSpare(c: Container | undefined, battery: DefId): number {
  let best = -1;
  if (!c) return best;
  for (const s of c.stacks) if (s.type === battery && s.count > 0 && (s.charge ?? 0) > best) best = s.charge ?? 0;
  return best;
}

/**
 * Setup (setup.ts): one slot per powered device type in the man's load (more than one of a type share it), its fullest
 * battery taken out of the load into the slot. A fresh record (`fitted` false: not out of an earlier battle) has that
 * battery partly used: a share of full drawn from [installedMin, 1] (stream "power"; spares stay full). No battery:
 * the slot is empty (a dead device). `tick`: when he enters the battle (0 at the start; a unit arriving late, M11.1,
 * at its arrival, so its batteries do not drain before it is there).
 */
export function fitBatteries(catalog: Catalog, rng: RngState, s: SoldierState, c: Container, light: number, fitted: boolean, tick = 0): void {
  let slots: PowerSlot[] | undefined;
  const P = catalog.behaviour.soldier.power;
  for (const st of c.stacks) {
    if (st.count <= 0) continue;
    const pw = powerOf(catalog, st.type);
    if (!pw || slots?.some((x) => x.device === st.type)) continue;
    (slots ??= []).push({ device: st.type, battery: null, wh0: 0, since: 0, on: false, flatTick: NEVER_TICK, drawW: pw.drawW });
  }
  if (!slots) return;
  slots.sort((a, b) => (a.device < b.device ? -1 : a.device > b.device ? 1 : 0));
  for (const slot of slots) {
    const pw = powerOf(catalog, slot.device)!;
    const taken = removeItems(c, pw.def.battery, 1)[0];
    let wh = 0;
    if (taken) {
      slot.battery = taken.type;
      wh = taken.charge ?? 0;
      if (!fitted && P !== undefined && P.installedMin < 1) wh = settle(Math.min(wh, pw.capWh * (P.installedMin + (1 - P.installedMin) * nextFloat(rng, Streams.power))));
    }
    stampSlot(slot, wh, wantOn(pw.def, light), tick);
  }
  s.power = slots;
}

/** Mass of the batteries fitted in a man's devices, kg. */
export function slotsMassKg(catalog: Catalog, s: Readonly<SoldierState> | undefined): number {
  if (!s?.power) return 0;
  let kg = 0;
  for (const slot of s.power) {
    if (slot.battery === null) continue;
    const d: ItemTypeDef | undefined = catalog.items[slot.battery];
    if (d) kg += d.massKg + slot.wh0 * (d.chargeMassKg ?? 0);
  }
  return kg;
}

/** Roster out: the batteries in his devices go back into his load at their settled charge at `tick`. */
export function loadWithBatteries(stacks: ItemStack[], s: Readonly<SoldierState>, tick: number): ItemStack[] {
  if (!s.power) return stacks;
  for (const slot of s.power) {
    if (slot.battery === null) continue;
    const wh = settle(chargeAt(slot, tick));
    const same = stacks.find((x) => x.type === slot.battery && x.charge === wh);
    if (same) same.count++;
    else stacks.push({ type: slot.battery, count: 1, charge: wh });
  }
  return stacks.sort((a, b) => (a.type !== b.type ? (a.type < b.type ? -1 : 1) : (a.charge ?? -1) - (b.charge ?? -1)));
}
