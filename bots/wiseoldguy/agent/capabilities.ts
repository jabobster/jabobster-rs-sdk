// Capability registry (Phase 3, step 4). Each capability names:
//   - the SDK call that performs it (documentation: nothing here calls the game),
//   - preconditions checked on the observation before the call,
//   - completion evidence checked on the observations before and after it.
//
// Completion is judged from state, never from the call's return value or from movement alone.
// Results use the same vocabulary as classify.ts, with one addition: `partial` (some of the
// requested quantity happened). Built capabilities have an evidence check the game state supports
// today; provisional ones have a check but no verified end-to-end run yet.

import type { Observation, ObsStack } from "./contract";

export type CapabilityStatus = "built" | "provisional";

export type CapResult =
    | { status: "confirmed_success"; reason: string; evidence: Record<string, unknown> }
    | { status: "partial"; reason: string; evidence: Record<string, unknown> }
    | { status: "unconfirmed"; reason: string; evidence: Record<string, unknown> };

export interface Capability<A = any> {
    id: string;
    status: CapabilityStatus;
    sdkCall: string;
    /** What must hold before the call is worth making. */
    requires: string;
    /** What the completion check accepts as proof. */
    evidence: string;
    note?: string;
    /** Problems that block the call. Empty = ok to attempt. */
    preconditions(obs: Observation, args: A): string[];
    completion(before: Observation, after: Observation, args: A): CapResult;
}

// ------------------------------------------------------------------ helpers

const COINS = "Coins";

/** Total quantity of an item by name (case-insensitive). null when that list was not observed. */
function count(stacks: ObsStack[] | null | undefined, name: string): number | null {
    if (stacks == null) return null;
    return stacks.filter((s) => s.name.toLowerCase() === name.toLowerCase()).reduce((t, s) => t + s.quantity, 0);
}
const inv = (o: Observation, name: string) => count(o.inventory, name);
const bank = (o: Observation, name: string) => count(o.bankItems, name);

/** Experience of one skill. null when skill XP was not observed. */
const xp = (o: Observation, skill: string): number | null =>
    o.skillXp == null ? null : (o.skillXp[skill] ?? 0);

const delta = (a: number | null, b: number | null): number | null => (a == null || b == null ? null : b - a);

const ok = (reason: string, evidence: Record<string, unknown> = {}): CapResult => ({ status: "confirmed_success", reason, evidence });
const partial = (reason: string, evidence: Record<string, unknown> = {}): CapResult => ({ status: "partial", reason, evidence });
const unconfirmed = (reason: string, evidence: Record<string, unknown> = {}): CapResult => ({ status: "unconfirmed", reason, evidence });

/** Shared blockers: a dialog or an open shop/bank/interface makes most actions meaningless. */
function blockers(obs: Observation): string[] {
    const out: string[] = [];
    if (!obs.inGame) out.push("not in game");
    if (obs.player.isDead) out.push("player is dead");
    if (obs.dialog.isOpen) out.push("a dialog is open");
    return out;
}
const freeInventorySlot = (obs: Observation) =>
    obs.inventory.length >= 28 ? ["inventory is full"] : [];

/** Quantity check for a deposit/withdraw/buy/sell-style transfer. `amount` "all" means no fixed target. */
function transferResult(moved: number, requested: number | "all", reason: string, evidence: Record<string, unknown>): CapResult {
    if (moved <= 0) return unconfirmed(`no_${reason}`, evidence);
    if (requested === "all") return ok(reason, { ...evidence, moved });
    if (moved >= requested) return ok(reason, { ...evidence, moved, requested });
    return partial(`partial_${reason}`, { ...evidence, moved, requested });
}

// ------------------------------------------------------ obstacle table (empty)

/**
 * Agility obstacles need a verified location and interaction option before the capability can run.
 * None are verified yet, so the table is empty on purpose: a guessed coordinate would be a
 * hallucination in code. Add entries from a live probe, with the evidence.
 */
export const KNOWN_OBSTACLES: Record<string, { x: number; z: number; option: string }> = {};

// -------------------------------------------------------------- registry

export const CAPABILITIES: Capability[] = [
    // ---------------------------------------------------------- gathering

    {
        id: "woodcutting",
        status: "built",
        sdkCall: "bot.chopTree(target?)",
        requires: "a free inventory slot; a matching tree in view",
        evidence: "the matching log count in the inventory increases (tree despawn alone is not enough)",
        preconditions: (obs) => [...blockers(obs), ...freeInventorySlot(obs)],
        completion(before, after, a: { logs: string }) {
            const gained = delta(inv(before, a.logs), inv(after, a.logs));
            if (gained == null) return unconfirmed("inventory_not_observed");
            return gained > 0 ? ok("log_gained", { gained }) : unconfirmed("no_log_gain_yet");
        },
    },
    {
        id: "firemaking",
        status: "built",
        sdkCall: "bot.burnLogs(logsTarget?)",
        requires: "logs in the inventory; a free tile to light a fire on",
        evidence: "Firemaking XP increases (logs consumed is recorded as extra evidence)",
        preconditions: (obs, a: { logs: string }) =>
            [...blockers(obs), ...((inv(obs, a.logs) ?? 0) > 0 ? [] : [`no ${a.logs} in the inventory`])],
        completion(before, after, a: { logs: string }) {
            const gainedXp = delta(xp(before, "Firemaking"), xp(after, "Firemaking"));
            const burned = -(delta(inv(before, a.logs), inv(after, a.logs)) ?? 0);
            if (gainedXp == null) return unconfirmed("xp_not_observed");
            return gainedXp > 0 ? ok("firemaking_xp_gained", { gainedXp, burned }) : unconfirmed("no_firemaking_xp_yet");
        },
    },
    {
        id: "mining",
        status: "built",
        sdkCall: "bot.mineRock(target?, { timeout? })",
        requires: "a free inventory slot; a matching rock in view",
        evidence: "the matching ore count increases. Mining XP alone is not accepted (it can come from a tick that never gave ore)",
        preconditions: (obs) => [...blockers(obs), ...freeInventorySlot(obs)],
        completion(before, after, a: { ore: string }) {
            const gained = delta(inv(before, a.ore), inv(after, a.ore));
            const gainedXp = delta(xp(before, "Mining"), xp(after, "Mining"));
            if (gained == null) return unconfirmed("inventory_not_observed");
            if (gained > 0) return ok("ore_gained", { gained, gainedXp });
            if ((gainedXp ?? 0) > 0) return unconfirmed("xp_without_ore", { gainedXp });
            return unconfirmed("no_ore_yet");
        },
    },
    {
        id: "fletching",
        status: "built",
        sdkCall: "bot.fletchLogs(product?)",
        requires: "a knife and the logs in the inventory",
        evidence: "Fletching XP increases; when a product is named, that product must also appear",
        note: "One call makes one batch.",
        preconditions: (obs, a: { logs: string }) =>
            [...blockers(obs), ...((inv(obs, a.logs) ?? 0) > 0 ? [] : [`no ${a.logs} in the inventory`])],
        completion(before, after, a: { product?: string }) {
            const gainedXp = delta(xp(before, "Fletching"), xp(after, "Fletching"));
            if (gainedXp == null) return unconfirmed("xp_not_observed");
            if (gainedXp <= 0) return unconfirmed("no_fletching_xp_yet");
            if (a.product) {
                const made = delta(inv(before, a.product), inv(after, a.product));
                if (made == null) return unconfirmed("inventory_not_observed");
                if (made <= 0) return unconfirmed("xp_without_product", { gainedXp, product: a.product });
                return ok("fletched", { gainedXp, made, product: a.product });
            }
            return ok("fletching_xp_gained", { gainedXp });
        },
    },

    // -------------------------------------------------------- provisional

    {
        id: "cooking",
        status: "provisional",
        sdkCall: "bot.useItemOnLoc(rawFood, range) plus dialog / interface handling",
        requires: "raw food in the inventory; a range or fire in view",
        evidence: "cooked food increases in the inventory, or Cooking XP increases. Starting the interaction is not completion",
        note: "Multi-step: the interaction only starts the flow; the completion check decides whether it finished.",
        preconditions: (obs, a: { raw: string }) =>
            [...blockers(obs), ...((inv(obs, a.raw) ?? 0) > 0 ? [] : [`no ${a.raw} in the inventory`])],
        completion(before, after, a: { raw: string; cooked: string }) {
            const cookedGained = delta(inv(before, a.cooked), inv(after, a.cooked));
            const gainedXp = delta(xp(before, "Cooking"), xp(after, "Cooking"));
            if (cookedGained == null) return unconfirmed("inventory_not_observed");
            if (cookedGained > 0) return ok("cooked", { cookedGained, gainedXp });
            if ((gainedXp ?? 0) > 0) return ok("cooking_xp_gained", { gainedXp });
            return unconfirmed("cooking_not_completed_yet");
        },
    },
    {
        id: "agility_obstacle",
        status: "provisional",
        sdkCall: "bot.interactLoc(...) on a known obstacle",
        requires: "an obstacle in KNOWN_OBSTACLES (verified location and option)",
        evidence: "Agility XP increases. Movement or a successful dispatch is not completion",
        note: "No obstacle is verified yet, so every call is blocked.",
        preconditions: (obs, a: { obstacle: string }) => [
            ...blockers(obs),
            ...(KNOWN_OBSTACLES[a.obstacle] ? [] : [`obstacle "${a.obstacle}" is not in KNOWN_OBSTACLES`]),
        ],
        completion(before, after) {
            const gainedXp = delta(xp(before, "Agility"), xp(after, "Agility"));
            if (gainedXp == null) return unconfirmed("xp_not_observed");
            return gainedXp > 0 ? ok("agility_xp_gained", { gainedXp }) : unconfirmed("no_agility_xp_yet");
        },
    },
    {
        id: "smelt",
        status: "provisional",
        sdkCall: "sdk.sendUseItemOnLoc(...) plus dialog option selection",
        requires: "the ore in the inventory; a furnace in view (not observed yet)",
        evidence: "the expected bar appears in the inventory, or Smithing XP increases",
        note: "Needs a valid ore and furnace pair and the smelting dialog. No high-level helper was found in the SDK.",
        preconditions: (obs, a: { ore: string }) =>
            [...blockers(obs), ...((inv(obs, a.ore) ?? 0) > 0 ? [] : [`no ${a.ore} in the inventory`])],
        completion(before, after, a: { ore: string; bar: string }) {
            const barGained = delta(inv(before, a.bar), inv(after, a.bar));
            const gainedXp = delta(xp(before, "Smithing"), xp(after, "Smithing"));
            if (barGained == null) return unconfirmed("inventory_not_observed");
            if (barGained > 0) return ok("bar_gained", { barGained, gainedXp });
            if ((gainedXp ?? 0) > 0) return ok("smithing_xp_gained", { gainedXp });
            return unconfirmed("no_bar_or_xp_yet");
        },
    },

    // ------------------------------------------------------------- shops

    {
        id: "open_shop",
        status: "built",
        sdkCall: "bot.openShop(target?)",
        requires: "no bank or other interface open; a shopkeeper in view",
        evidence: "the shop interface is open and its stock is visible (and the title matches, when given)",
        preconditions: (obs) => [
            ...blockers(obs),
            ...(obs.bankOpen ? ["the bank is open"] : []),
            ...(obs.interfaceOpen ? ["another interface is open"] : []),
        ],
        completion(_before, after, a: { title?: RegExp | string } = {}) {
            if (!after.shopOpen) return unconfirmed("shop_not_open");
            if (after.shopItems == null) return unconfirmed("shop_contents_not_observed");
            if (after.shopItems.length === 0) return unconfirmed("shop_open_but_no_items");
            if (a.title && !(a.title instanceof RegExp ? a.title.test(after.shopTitle ?? "") : (after.shopTitle ?? "").includes(a.title))) {
                return unconfirmed("wrong_shop", { title: after.shopTitle });
            }
            return ok("shop_open_with_stock", { items: after.shopItems.length, title: after.shopTitle });
        },
    },
    {
        id: "buy",
        status: "built",
        sdkCall: "bot.buyFromShop(item, amount)",
        requires: "the shop is open and stocks the item; enough coins",
        evidence: "the inventory quantity of the item increases; partial when less than requested arrives",
        preconditions: (obs) => (obs.shopOpen ? [] : ["the shop is not open"]),
        completion(before, after, a: { item: string; amount: number }) {
            const gained = delta(inv(before, a.item), inv(after, a.item));
            if (gained == null) return unconfirmed("inventory_not_observed");
            return transferResult(gained, a.amount, "items_bought", { item: a.item });
        },
    },
    {
        id: "sell",
        status: "built",
        sdkCall: "bot.sellToShop(item, amount)",
        requires: "the shop is open and buys the item",
        evidence: "coins increase AND the sold item's quantity decreases. The helper's own return value is not used (it gave a false negative for unstackable shortbows)",
        note: "The helper can report failure on a sale that happened. The state check decides.",
        preconditions: (obs) => (obs.shopOpen ? [] : ["the shop is not open"]),
        completion(before, after, a: { item: string; amount: number | "all" }) {
            const coinsGained = delta(inv(before, COINS), inv(after, COINS));
            const sold = -(delta(inv(before, a.item), inv(after, a.item)) ?? NaN);
            if (coinsGained == null || Number.isNaN(sold)) return unconfirmed("inventory_not_observed");
            if (coinsGained > 0 && sold > 0) {
                return transferResult(sold, a.amount, "items_sold", { item: a.item, coinsGained });
            }
            if (coinsGained > 0) return unconfirmed("coins_without_item_decrease", { coinsGained });
            if (sold > 0) return unconfirmed("item_gone_no_coins", { sold });
            return unconfirmed("no_sale_yet");
        },
    },

    // -------------------------------------------------------------- bank

    {
        id: "open_bank",
        status: "built",
        sdkCall: "bot.openBank()",
        requires: "a bank booth or banker in view; no other interface open",
        evidence: "the bank interface is open and its contents are visible",
        preconditions: (obs) => [...blockers(obs), ...(obs.interfaceOpen ? ["another interface is open"] : [])],
        completion(_before, after) {
            if (!after.bankOpen) return unconfirmed("bank_not_open");
            if (after.bankItems == null) return unconfirmed("bank_contents_not_observed");
            return ok("bank_open", { items: after.bankItems.length });
        },
    },
    {
        id: "deposit",
        status: "built",
        sdkCall: "bot.depositItem(target, amount)  (amount -1 = all)",
        requires: "the bank is open; the item is in the inventory",
        evidence: "the inventory quantity decreases AND the bank quantity increases by the same amount",
        preconditions: (obs, a: { item: string }) => [
            ...blockers(obs),
            ...(obs.bankOpen ? [] : ["the bank is not open"]),
            ...((inv(obs, a.item) ?? 0) > 0 ? [] : [`no ${a.item} in the inventory`]),
        ],
        completion(before, after, a: { item: string; amount: number | "all" }) {
            const invDown = -(delta(inv(before, a.item), inv(after, a.item)) ?? NaN);
            const bankUp = delta(bank(before, a.item), bank(after, a.item));
            if (Number.isNaN(invDown) || bankUp == null) return unconfirmed("inventory_or_bank_not_observed");
            if (invDown <= 0) return unconfirmed("nothing_left_inventory");
            if (bankUp <= 0) return unconfirmed("inventory_down_bank_not_up", { invDown });
            const moved = Math.min(invDown, bankUp);
            if (a.amount === "all" && (inv(after, a.item) ?? 0) > 0) {
                return partial("partial_deposit_all", { moved, left: inv(after, a.item) });
            }
            return transferResult(moved, a.amount, "deposited", { item: a.item });
        },
    },
    {
        id: "withdraw",
        status: "built",
        sdkCall: "bot.withdrawItem(target, amount?, { asNote? })",
        requires: "the bank is open and holds the item",
        evidence: "the inventory quantity increases AND the bank quantity decreases by the same amount",
        note: "A noted withdrawal changes the item name, so check the item the call asks for.",
        preconditions: (obs, a: { item: string }) => [
            ...blockers(obs),
            ...(obs.bankOpen ? [] : ["the bank is not open"]),
            ...((bank(obs, a.item) ?? 0) > 0 ? [] : [`no ${a.item} in the bank`]),
        ],
        completion(before, after, a: { item: string; amount: number | "all" }) {
            const invUp = delta(inv(before, a.item), inv(after, a.item));
            const bankDown = -(delta(bank(before, a.item), bank(after, a.item)) ?? NaN);
            if (invUp == null || Number.isNaN(bankDown)) return unconfirmed("inventory_or_bank_not_observed");
            if (invUp <= 0) return unconfirmed("nothing_arrived_inventory");
            if (bankDown <= 0) return unconfirmed("inventory_up_bank_not_down", { invUp });
            return transferResult(Math.min(invUp, bankDown), a.amount, "withdrawn", { item: a.item });
        },
    },
    {
        id: "close_bank",
        status: "built",
        sdkCall: "bot.closeBank()",
        requires: "the bank is open",
        evidence: "the bank AND the interface are both closed in the observed state",
        preconditions: () => [],
        completion(_before, after) {
            const stillOpen = [after.bankOpen && "bank", after.interfaceOpen && "interface"].filter(Boolean);
            if (after.interfaceOpen == null) return unconfirmed("interface_state_not_observed");
            if (stillOpen.length) return unconfirmed(`still_open:${stillOpen.join("+")}`);
            return ok("bank_and_interface_closed");
        },
    },
];

export const CAPABILITY_BY_ID: Record<string, Capability> = Object.fromEntries(CAPABILITIES.map((c) => [c.id, c]));

export function getCapability(id: string): Capability {
    const c = CAPABILITY_BY_ID[id];
    if (!c) throw new Error(`Unknown capability "${id}". Known: ${Object.keys(CAPABILITY_BY_ID).join(", ")}`);
    return c;
}

/** Plain-text matrix (for the docs). Same rows, same order as CAPABILITIES. */
export function capabilityMatrix(): string {
    const rows = CAPABILITIES.map((c) => `| ${c.id} | ${c.status} | \`${c.sdkCall}\` | ${c.requires} | ${c.evidence}${c.note ? ` (${c.note})` : ""} |`);
    return ["| id | status | SDK call | requires | completion evidence |", "|---|---|---|---|---|", ...rows].join("\n");
}
