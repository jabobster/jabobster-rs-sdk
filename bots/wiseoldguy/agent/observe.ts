// Full diagnostic observation (Phase 1's observe(), typed and extended).
// `sdk` is deliberately `any`: this module must run against a fake in tests.

import type { Observation, ObsDialog, ObsLoc, ObsLocs } from "./contract";

const EDIBLE_RE = /^(eat|drink)$/i;

export function inventorySnapshot(sdk: any) {
    return (sdk.getInventory() ?? []).map((item: any) => ({
        slot: item.slot,
        id: item.id,
        name: item.name,
        quantity: item.count ?? 1,
        // Only written when true, so non-food items keep their old shape.
        ...((item.optionsWithIndex ?? []).some((o: any) => EDIBLE_RE.test((o?.text ?? "").trim())) ? { edible: true } : {}),
    }));
}

/**
 * In a fight right now. After a kill the game keeps inCombat=true with targetType "none" and
 * targetIndex -1 for ~10 ticks (seen in real logs); that is NOT a fight.
 */
export function isFighting(obs: Pick<Observation, "player">): boolean {
    const c = obs.player.combat;
    return Boolean(c?.inCombat && c.targetType !== "none" && c.targetIndex >= 0);
}

/** Total quantity of one item ID across every slot (compare by ID, not name). */
export function quantityById(inventory: { id: number | string; quantity?: number }[], id: number | string) {
    return inventory
        .filter((item) => String(item.id) === String(id))
        .reduce((total, item) => total + (item.quantity ?? 1), 0);
}

export function dialogSnapshot(state: any): ObsDialog {
    const dialog = state?.dialog;
    return {
        isOpen: Boolean(dialog?.isOpen),
        isWaiting: Boolean(dialog?.isWaiting),
        pageId: dialog?.pageId ?? null,
        text: (dialog?.text ?? "").trim(),
        options: (dialog?.options ?? []).map((option: any) => ({
            index: option.index,
            text: (option.text ?? "").trim(),
        })),
    };
}

/**
 * Deliberately excludes isWaiting: that flag can toggle without the dialogue
 * advancing to a different page or choice.
 */
export function dialogSignature(dialog: Partial<ObsDialog> | null | undefined): string {
    return JSON.stringify({
        isOpen: dialog?.isOpen ?? false,
        pageId: dialog?.pageId ?? null,
        text: (dialog?.text ?? "").trim(),
        options: (dialog?.options ?? []).map((option) => (option.text ?? "").trim()),
    });
}

const CONTINUE_RE = /^click here to continue\.?$/i;

export function isContinuePrompt(text: string) {
    return CONTINUE_RE.test((text ?? "").trim());
}

/** True when the page has nothing to choose: no options, or only "Click here to continue". */
export function isContinueOnly(dialog: { options: { text: string }[] }) {
    const options = dialog.options ?? [];
    return options.length === 0 || (options.length === 1 && isContinuePrompt(options[0].text));
}

/** Counters for how much time observing costs (an explicit ground scan is a slow round trip). */
export interface ObserveStats { observes: number; scans: number; scanMs: number }
export const newObserveStats = (): ObserveStats => ({ observes: 0, scans: 0, scanMs: 0 });

/** The ground items the client already publishes every tick (what the SDK's own pickup helper relies on). */
export function groundMirror(sdk: any): any[] {
    return sdk.getState?.()?.groundItems ?? sdk.getGroundItems?.() ?? [];
}

/** Name -> total quantity; a stack is {id, name, quantity}. */
function stacksOf(items: any[] | undefined | null): { id: number; name: string; quantity: number }[] {
    return (items ?? []).map((i: any) => ({ id: i.id, name: i.name, quantity: i.count ?? i.quantity ?? 1 }));
}

function skillXpOf(state: any): Record<string, number> | null {
    if (!Array.isArray(state?.skills)) return null;
    return Object.fromEntries(state.skills.map((s: any) => [s.name, s.experience ?? 0]));
}

export interface ObserveOpts {
    /** true (default): run an explicit scanGroundItems(12) and wait for it. false: read the published mirror, no waiting. */
    scan?: boolean;
    stats?: ObserveStats;
}

export async function observe(sdk: any, opts: ObserveOpts = {}): Promise<Observation> {
    const state = sdk.getState();
    if (!state?.player) throw new Error("No player state available.");

    let groundItems: any[];
    if (opts.scan === false) {
        groundItems = groundMirror(sdk);
    } else {
        // Awaited so the observation includes current scan results. In a real run this took ~3-7 s each.
        const t0 = Date.now();
        groundItems = await sdk.scanGroundItems(12);
        if (opts.stats) { opts.stats.scans++; opts.stats.scanMs += Date.now() - t0; }
    }
    if (opts.stats) opts.stats.observes++;

    // Read state again after the asynchronous scan.
    const current = sdk.getState();
    const player = current?.player ?? state.player;

    return {
        tick: current?.tick ?? state.tick,
        inGame: Boolean(current?.inGame ?? state.inGame),
        player: {
            name: player.name,
            x: player.worldX,
            z: player.worldZ,
            level: player.level ?? 0,
            hp: player.hp,
            maxHp: player.maxHp,
            isDead: Boolean(player.isDead),
            combat: player.combat
                ? {
                      inCombat: Boolean(player.combat.inCombat),
                      targetIndex: player.combat.targetIndex,
                      targetType: player.combat.targetType,
                  }
                : null,
        },
        inventory: inventorySnapshot(sdk),
        nearbyNpcs: (sdk.getNearbyNpcs() ?? []).map((npc: any) => ({
            index: npc.index,
            id: npc.id,
            name: npc.name,
            x: npc.x,
            z: npc.z,
            distance: npc.distance ?? null,
            reachable: npc.reachable ?? null,
            inCombat: npc.inCombat ?? null,
            // NpcOption is { text, opIndex } in sdk/types.ts. (Phase 1 read
            // `option.index`, which does not exist on that type.)
            options: (npc.optionsWithIndex ?? [])
                .map((option: any) => (option.text ?? "").trim())
                .filter(Boolean),
        })),
        nearbyGroundItems: (groundItems ?? []).map((item: any) => ({
            id: item.id,
            name: item.name,
            x: item.x,
            z: item.z,
            distance: item.distance ?? null,
            quantity: item.count ?? item.quantity ?? 1,
            reachable: item.reachable ?? null,
        })),
        dialog: dialogSnapshot(current ?? state),
        interfaceOpen: current?.interface?.isOpen ?? null,
        shopOpen: Boolean(current?.shop?.isOpen),
        bankOpen: Boolean(current?.bank?.isOpen),
        opRejectedCount: current?.opFeedback?.opRejectedCount ?? null,
        // Only while open: a closed bank or shop has no contents to check against.
        bankItems: current?.bank?.isOpen ? stacksOf(current.bank.items) : null,
        shopItems: current?.shop?.isOpen ? stacksOf(current.shop.shopItems) : null,
        shopTitle: current?.shop?.isOpen ? (current.shop.title ?? null) : null,
        skillXp: skillXpOf(current ?? state),
        locs: locsOf(sdk),
    };
}

/** Oak trees and bank booths from the SDK's current nearby-location snapshot. null if the SDK has no such read. */
export function locsOf(sdk: any): ObsLocs | null {
    if (typeof sdk.getNearbyLocs !== "function") return null;
    let all: any[];
    try {
        all = sdk.getNearbyLocs() ?? [];
    } catch {
        return null;
    }
    const pick = (pattern: RegExp): ObsLoc[] =>
        all
            .filter((loc: any) => pattern.test(loc.name ?? ""))
            .map((loc: any) => ({ id: loc.id, name: loc.name, x: loc.x, z: loc.z, distance: loc.distance ?? null }));
    return {
        trees: pick(/^oak$/i),
        bankBooths: pick(/bank booth|bank chest/i),
        // Mine-smelt: every rock is named "Rocks" (the ore is the tile), and the furnace is named "Furnace".
        rocks: pick(/rock/i),
        furnaces: pick(/furnace/i),
    };
}

/** Messages that arrived since the last call (cursor is held by the SDK). */
export async function collectNewMessages(sdk: any): Promise<any[]> {
    try {
        return sdk.getNewChat({ types: [0], includeSelf: true }) ?? [];
    } catch {
        return [];
    }
}
