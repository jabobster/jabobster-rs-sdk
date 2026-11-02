// Pure smelting rules, shared by the fixed mine-smelt routine and the model's mine/smelt actions.
// No SDK imports, so validation can use it without pulling in the routine.

import type { SmeltSite } from "./mineSmelt";
import { LIMITS } from "./contract";

/** The smelting dialog's Make-X quantity is capped here: one call can smelt a whole pack of ore. */
export const SMELT_MAX_COUNT = 28;

/**
 * How many a single Smelt call should make, given the ore available: all of it, up to the cap.
 * Make-X takes the number as a count dialog answer, so 28 ore is one call, not 10 + 10 + 8.
 */
export function smeltCount(oresAvailable: number): number {
    return Math.max(0, Math.min(SMELT_MAX_COUNT, Math.floor(oresAvailable)));
}

/** Ore of each kind to gather so that `bars` bars can be made, given the chance a smelt makes a bar. */
export function oreTargetFor(bars: number, smeltChance: number): number {
    return Math.ceil(bars / smeltChance);
}

/**
 * Extra ore mined on top of the expected need, because a smelt can fail (iron about half the time). A bigger batch
 * means fewer furnace and bank trips, which cost the most game time.
 */
export const SMELT_ORE_MARGIN = 1.4;

/**
 * Ore of each kind for one model batch: the expected need plus the margin, capped at one Make-X call and at
 * the room the pack has for that ore (`room`, per ore type).
 */
export function batchOreTarget(bars: number, smeltChance: number, room: number = SMELT_MAX_COUNT): number {
    return Math.max(0, Math.min(room, SMELT_MAX_COUNT, Math.ceil(oreTargetFor(bars, smeltChance) * SMELT_ORE_MARGIN)));
}

/** Quantity of items whose name matches a pattern. */
export function countItems(inventory: ReadonlyArray<{ name: string; quantity: number }>, re: RegExp): number {
    return inventory.filter((i) => re.test(i.name)).reduce((t, i) => t + i.quantity, 0);
}

/**
 * True when a bank trip should happen: the bars still needed are carried, or the pack is full and holds some bars.
 * A full pack cannot take more, so waiting for the full amount would stall a long run. Ore in the pack never blocks it.
 */
export function bankReady(
    inventory: ReadonlyArray<{ name: string; quantity: number }>,
    barRe: RegExp,
    need: number,
    slots: number,
): boolean {
    const held = countItems(inventory, barRe);
    return held >= need || (held > 0 && inventory.length >= slots);
}

/** Ore still short of target for a site, by inventory name. Empty when every ore is at target. */
export function oresShort(
    site: SmeltSite,
    inventory: ReadonlyArray<{ name: string; quantity: number }>,
    bars: number,
): { name: string; have: number; target: number }[] {
    // Room for ore: the pack's slots less everything that is not this site's ore (tools, bars). Ore takes a slot each,
    // so a fixed 28 can never be reached with tools in the pack.
    const others = inventory
        .filter((i) => !site.ores.some((o) => o.re.test(i.name)))
        .reduce((t, i) => t + i.quantity, 0);
    const perOre = Math.floor((LIMITS.inventorySlots - others) / site.ores.length);
    const target = batchOreTarget(bars, site.smeltChance, perOre);
    return site.ores
        .map((s) => ({ name: s.name, have: countItems(inventory, s.re), target }))
        .filter((s) => s.have < s.target);
}

/** The ore count a Smelt call can use: the smallest pile among the site's ores (a bar takes one of each). */
export function smeltableOre(site: SmeltSite, inventory: ReadonlyArray<{ name: string; quantity: number }>): number {
    return Math.min(...site.ores.map((s) => countItems(inventory, s.re)));
}

/** A batch may be this many ore short and still go to the furnace (the last ore can be slow to mine). */
export const SHORT_SLACK = 2;

/** True when some ore is short by more than SHORT_SLACK. */
export function shortBeyondSlack(short: ReadonlyArray<{ have: number; target: number }>): boolean {
    return short.some((s) => s.target - s.have > SHORT_SLACK);
}

/**
 * Ticks a rock is skipped for after a mine on it. A rock gives one ore and is empty until it respawns: in the
 * 2026-11-01 Ardougne logs, successive ore from one rock came about 70 ticks apart, and a mine within that window
 * reports "no ore currently available". 60 is a little under that; tune from the logs.
 */
export const DEPLETED_TICKS = 60;

/**
 * Rocks that just gave no ore, with the tick they did. Mining skips them for DEPLETED_TICKS, so the model
 * moves to another rock instead of retrying the same empty one. If every candidate is marked, the one marked
 * longest ago is used (it is the nearest to respawning).
 */
export class DepletedRocks {
    private at = new Map<string, number>();

    private key(x: number, z: number) { return `${x},${z}`; }

    mark(x: number, z: number, tick: number): void { this.at.set(this.key(x, z), tick); }

    clear(x: number, z: number): void { this.at.delete(this.key(x, z)); }

    /** True when a rock may be mined now: never marked, or marked at least DEPLETED_TICKS ago. */
    available(x: number, z: number, tick: number): boolean {
        const t = this.at.get(this.key(x, z));
        return t === undefined || tick - t >= DEPLETED_TICKS;
    }

    /** The rock to mine next: the nearest candidate not marked recently, else the one marked longest ago. */
    pick<T extends { x: number; z: number; distance: number | null }>(candidates: T[], tick: number): T {
        const dist = (r: T) => r.distance ?? Infinity;
        const free = candidates.filter((r) => this.available(r.x, r.z, tick));
        if (free.length) return free.reduce((a, c) => (dist(c) < dist(a) ? c : a));
        const oldest = (r: T) => this.at.get(this.key(r.x, r.z)) ?? 0;
        return candidates.reduce((a, c) => (oldest(c) < oldest(a) ? c : a));
    }
}
