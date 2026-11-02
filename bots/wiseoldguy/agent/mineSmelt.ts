// Phase 3 step 6: a fixed mine -> smelt -> bank routine, run through the capability registry.
//
// The model is not involved. Every step checks the capability's preconditions, makes one SDK call,
// waits for the state to settle, and asks the capability's completion check whether it really
// happened. The SDK's own return value is recorded but never used as proof. The routine stops on the
// first blocker, or after repeated unconfirmed steps, instead of looping.
//
// A site says where the ores are, where the furnace and bank are, and which levels it needs.
//   falador-bronze: copper + tin -> bronze bars (one of each per bar). Falador mine, Falador furnace, Falador west bank.
//   ardougne-iron:  iron ore -> iron bars (one per bar, smithing 15). Ardougne south mine, Ardougne west furnace, Ardougne west bank.
//
// Locations come from the game's map data (server/content/maps/*.jm2, loc ids checked against
// loc.pack), not from a live probe. Falador bronze has been run live end to end. The Ardougne site
// is new: its rock tiles, furnace and bank are from the map data and have not been run live yet.
//
//   Falador copper rocks (loc 2091 = copperrock2): (2907,3361), (2909,3364)
//   Falador tin rocks (loc 2094/2095): six tiles from (2904,3357) to (2908,3362)
//   Falador furnace (loc 2781 = furnace1): (2975,3368). Bank: Falador west (2948,3368).
//   Ardougne iron rocks (loc 2092/2093 = ironrock1/2, mining level 15): 13 tiles from (2581,3229) to (2605,3237)
//   Ardougne furnace (loc 2781): (2601,3310). Bank: Ardougne west (2616,3332), about 27 tiles from the furnace.

import { getCapability, type Capability, type CapResult } from "./capabilities";
import type { Observation } from "./contract";
import { fileLoggers } from "./logger";
import { observe } from "./observe";
import { HANG_GUARD_MS, withTimeout, type RoutineStop } from "./chopBank";
import { SMELT_MAX_COUNT, countItems, oreTargetFor, smeltableOre, smeltCount } from "./smeltRules";

export interface Tile { x: number; z: number }

export interface OreSpec {
    /** Inventory name, e.g. "Copper ore". */
    name: string;
    re: RegExp;
    /** Rock tiles for this ore. Every rock is named just "Rocks", so the tile is what picks the ore. */
    rocks: Tile[];
}

export interface SmeltSite {
    id: string;
    /** Ores mined. A bar takes one of each, so bronze is copper + tin and iron is iron alone. */
    ores: OreSpec[];
    /** The product name on the smelting menu, e.g. "Bronze" (the product line reads "\n\n\n\nBronze"). */
    product: string;
    /** Inventory name of the bar, e.g. "Bronze bar". */
    barName: string;
    barRe: RegExp;
    furnace: Tile;
    bank: Tile;
    miningLevel: number;
    smithingLevel: number;
    /**
     * Chance a smelt attempt makes a bar (the ore is lost otherwise). Bronze never fails. Iron is about 50%:
     * two live runs made 11 bars from 20 ore. The routine mines ore / chance so the bar target is still met.
     */
    smeltChance: number;
}

export const FALADOR_COPPER_ROCKS: Tile[] = [
    { x: 2907, z: 3361 },
    { x: 2909, z: 3364 },
];
export const FALADOR_TIN_ROCKS: Tile[] = [
    { x: 2904, z: 3357 },
    { x: 2905, z: 3358 },
    { x: 2905, z: 3359 },
    { x: 2906, z: 3360 },
    { x: 2908, z: 3360 },
    { x: 2908, z: 3362 },
];
export const FALADOR_FURNACE: Tile = { x: 2975, z: 3368 };
export const FALADOR_WEST_BANK: Tile = { x: 2948, z: 3368 };

export const ARDOUGNE_IRON_ROCKS: Tile[] = [
    { x: 2581, z: 3231 }, { x: 2583, z: 3235 }, { x: 2589, z: 3229 }, { x: 2589, z: 3238 },
    { x: 2590, z: 3230 }, { x: 2591, z: 3232 }, { x: 2592, z: 3234 }, { x: 2602, z: 3233 },
    { x: 2602, z: 3234 }, { x: 2602, z: 3236 }, { x: 2605, z: 3233 }, { x: 2605, z: 3235 },
    { x: 2605, z: 3237 },
];
export const ARDOUGNE_FURNACE: Tile = { x: 2601, z: 3310 };
export const ARDOUGNE_WEST_BANK: Tile = { x: 2616, z: 3332 };

export const FALADOR_BRONZE: SmeltSite = {
    id: "falador-bronze",
    ores: [
        { name: "Copper ore", re: /^copper ore$/i, rocks: FALADOR_COPPER_ROCKS },
        { name: "Tin ore", re: /^tin ore$/i, rocks: FALADOR_TIN_ROCKS },
    ],
    product: "Bronze",
    barName: "Bronze bar",
    barRe: /^bronze bar$/i,
    furnace: FALADOR_FURNACE,
    bank: FALADOR_WEST_BANK,
    miningLevel: 1,
    smithingLevel: 1,
    smeltChance: 1,
};

export const ARDOUGNE_IRON: SmeltSite = {
    id: "ardougne-iron",
    ores: [{ name: "Iron ore", re: /^iron ore$/i, rocks: ARDOUGNE_IRON_ROCKS }],
    product: "Iron",
    barName: "Iron bar",
    barRe: /^iron bar$/i,
    furnace: ARDOUGNE_FURNACE,
    bank: ARDOUGNE_WEST_BANK,
    miningLevel: 15,
    smithingLevel: 15,
    smeltChance: 0.5,
};

export const SITES: Record<string, SmeltSite> = {
    [FALADOR_BRONZE.id]: FALADOR_BRONZE,
    [ARDOUGNE_IRON.id]: ARDOUGNE_IRON,
};

/** Bars per run for the default target. Bronze mines this many of each ore; iron mines ~2x (see smeltChance). */
export const DEFAULT_PAIRS = 10;
export const MAX_CONSECUTIVE_UNCONFIRMED = 3;

export type MineSmeltStop = Extract<RoutineStop, "goal_met" | "start_blocked" | "error">
    | "mine_blocked" | "mine_unconfirmed" | "smelt_blocked" | "smelt_unconfirmed"
    | "no_bank_in_view" | "open_bank_failed" | "deposit_failed" | "close_bank_failed";

/** What the routine needs from the outside world. Live runs use liveMineSmeltOps(); tests pass stubs. */
export interface MineSmeltOps {
    observe(): Promise<Observation>;
    /** Problems that stop the routine before anything is done (pickaxe, levels). Empty = fine. */
    startProblems(site: SmeltSite): string[];
    walkTo(x: number, z: number, tolerance: number): Promise<unknown>;
    /** Mine the rock at this tile. Resolves once the SDK's own check finishes; the routine still judges state. */
    mineAt(x: number, z: number): Promise<unknown>;
    /** Clear a blocking dialog or level-up screen (the SDK's dismissBlockingUI). Does not answer multi-option choices. */
    clearBlocking(): Promise<unknown>;
    /** Smelt `count` bars: Make-X ("Smelt X Iron") and the count dialog, or the one-bar product line when count is 1. */
    smelt(product: string, count: number): Promise<unknown>;
    /** Fresh location scan around the player, so the next observe() sees booths. */
    scanLocs(): Promise<unknown>;
    openBank(): Promise<unknown>;
    deposit(item: RegExp, amount: -1): Promise<unknown>;
    closeBank(): Promise<unknown>;
    settle(pred: (o: Observation) => boolean, maxTicks: number): Promise<Observation>;
    record(entry: Record<string, unknown>): Promise<void>;
}

export interface MineSmeltOptions {
    site?: SmeltSite;
    /** Ores of each kind gathered before smelting (bronze: pairs; iron: bars). */
    pairs?: number;
    /** Game ticks to wait for a mine or smelt step before judging it. */
    stepSettleTicks?: number;
    /** Game ticks to wait for a bank step before judging it. */
    bankSettleTicks?: number;
    runId?: string;
}

export interface MineSmeltResult {
    stopReason: MineSmeltStop;
    detail?: string;
    /** Ores gained this run, by inventory name. */
    mined: Record<string, number>;
    barsSmelted: number;
    /** Smelt attempts that used the ore but made no bar. Iron can fail this way by the game's own chance; the ore is lost. */
    smeltFailed: number;
    barsDeposited: number;
    steps: number;
}

/** Quantity of an item in the inventory matching a pattern. */
const invCount = (o: Observation, re: RegExp) =>
    o.inventory.filter((i) => re.test(i.name)).reduce((t, i) => t + i.quantity, 0);

/** The closest bank booth in the observation, or null. */
const nearestBooth = (o: Observation) => {
    const booths = (o.locs?.bankBooths ?? []).filter((b) => b.distance != null);
    if (booths.length === 0) return null;
    const b = booths.reduce((a, c) => ((c.distance as number) < (a.distance as number) ? c : a));
    return { name: b.name, x: b.x, z: b.z, distance: b.distance };
};

/** Short, log-safe summary of an SDK return value. */
const sdkSummary = (r: any) =>
    r == null ? null : { success: r.success ?? null, reason: r.reason ?? null, message: r.message ?? null };

type Judged = { blocked: string } | { result: CapResult; before: Observation; after: Observation; sdk: unknown };

export async function runMineSmeltBank(ops: MineSmeltOps, opts: MineSmeltOptions = {}): Promise<MineSmeltResult> {
    const site = opts.site ?? FALADOR_BRONZE;
    const pairs = opts.pairs ?? DEFAULT_PAIRS;
    // Ore to mine for each ore type: the bar target divided by the chance a smelt makes a bar.
    const oreTarget = oreTargetFor(pairs, site.smeltChance);
    const stepSettle = opts.stepSettleTicks ?? 20;
    const bankSettle = opts.bankSettleTicks ?? 15;
    const mining = getCapability("mining");
    const smelt = getCapability("smelt");
    const openBankCap = getCapability("open_bank");
    const depositCap = getCapability("deposit");
    const closeBankCap = getCapability("close_bank");

    let steps = 0;
    let startTick: number | null = null;
    let lastTick: number | null = null;
    let mined: Record<string, number> = Object.fromEntries(site.ores.map((s) => [s.name, 0]));
    let barsSmelted = 0;
    let smeltFailed = 0;
    let barsDeposited = 0;

    const finish = async (stopReason: MineSmeltStop, detail?: string): Promise<MineSmeltResult> => {
        const ticks = startTick != null && lastTick != null ? lastTick - startTick : null;
        await ops.record({
            kind: "routine_end", runId: opts.runId, site: site.id, stopReason, detail: detail ?? null,
            steps, mined, barsSmelted, smeltFailed, barsDeposited, ticks,
        });
        return { stopReason, detail, mined, barsSmelted, smeltFailed, barsDeposited, steps };
    };

    // One judged step: check preconditions, act, wait for the state, then let the capability judge.
    const step = async (
        name: string,
        capability: Capability<any>,
        args: Record<string, unknown>,
        act: () => Promise<unknown>,
        settled: (o: Observation) => boolean,
        settleTicks: number,
    ): Promise<Judged> => {
        steps++;
        // A level-up or other dialog left open by the last step blocks every action, so clear it first.
        let before = await ops.observe();
        if (before.dialog.isOpen) {
            await ops.record({ kind: "routine_prompt", runId: opts.runId, step: steps + 1, action: "clear_blocking", dialog: before.dialog.text });
            await ops.clearBlocking();
            before = await ops.observe();
        }
        const blockers = capability.preconditions(before, args);
        if (blockers.length) {
            await ops.record({ kind: "routine_step", runId: opts.runId, step: steps, capability: name, args, status: "blocked", blockers });
            return { blocked: blockers.join("; ") };
        }
        let sdk: unknown = null;
        let sdkError: string | null = null;
        try { sdk = await act(); } catch (e: any) { sdkError = e?.message ?? String(e); }
        const after = await ops.settle(settled, settleTicks);
        lastTick = after.tick;
        const result = capability.completion(before, after, args);
        await ops.record({
            kind: "routine_step", runId: opts.runId, step: steps, capability: name, args,
            tickBefore: before.tick, tickAfter: after.tick, ticks: after.tick - before.tick,
            sdk: sdkSummary(sdk), sdkError, status: result.status, reason: result.reason, evidence: result.evidence,
        });
        return { result, before, after, sdk };
    };

    try {
        const startProblems = ops.startProblems(site);
        if (startProblems.length) return finish("start_blocked", startProblems.join("; "));

        const startObs = await ops.observe();
        startTick = startObs.tick;
        lastTick = startObs.tick;
        const start: Record<string, number> = Object.fromEntries(site.ores.map((s) => [s.name, invCount(startObs, s.re)]));
        let cur: Record<string, number> = { ...start };
        const rockIdx: Record<string, number> = Object.fromEntries(site.ores.map((s) => [s.name, 0]));

        // Mine until every ore has `pairs`. Each step takes the ore that is furthest behind.
        let unconfirmed = 0;
        let walked = false;
        while (site.ores.some((s) => cur[s.name] < oreTarget)) {
            const spec = site.ores.filter((s) => cur[s.name] < oreTarget).sort((a, b) => cur[a.name] - cur[b.name])[0];
            const rock = spec.rocks[rockIdx[spec.name] % spec.rocks.length];
            rockIdx[spec.name]++;
            if (!walked) {
                const walk = await ops.walkTo(rock.x, rock.z, 2);
                await ops.record({ kind: "routine_prep", runId: opts.runId, action: "walk_to_mine", sdk: sdkSummary(walk) });
                walked = true;
            }
            const before = invCount(await ops.observe(), spec.re);
            const out = await step("mining", mining, { ore: spec.name },
                () => ops.mineAt(rock.x, rock.z), (o) => invCount(o, spec.re) > before, stepSettle);
            if ("blocked" in out) return finish("mine_blocked", out.blocked);
            if (out.result.status === "confirmed_success") {
                unconfirmed = 0;
                cur = Object.fromEntries(site.ores.map((s) => [s.name, invCount(out.after, s.re)]));
                mined = Object.fromEntries(site.ores.map((s) => [s.name, cur[s.name] - start[s.name]]));
            } else if (++unconfirmed >= MAX_CONSECUTIVE_UNCONFIRMED) {
                return finish("mine_unconfirmed", out.result.reason);
            }
        }

        // Smelt with Make-X: one call per pile, up to 28 at a time, until one of the ores runs out.
        const walkFurnace = await ops.walkTo(site.furnace.x, site.furnace.z, 3);
        await ops.record({ kind: "routine_prep", runId: opts.runId, action: "walk_to_furnace", sdk: sdkSummary(walkFurnace) });
        await ops.scanLocs();
        unconfirmed = 0;
        const first = site.ores[0];
        while (site.ores.every((s) => cur[s.name] > 0)) {
            const nowObs = await ops.observe();
            const count = smeltCount(smeltableOre(site, nowObs.inventory));
            const barsBefore = invCount(nowObs, site.barRe);
            const oresBefore = Object.fromEntries(site.ores.map((s) => [s.name, invCount(nowObs, s.re)]));
            const out = await step("smelt", smelt, { ore: first.name, bar: site.barName, count },
                () => ops.smelt(site.product, count),
                (o) => invCount(o, site.barRe) > barsBefore || site.ores.some((s) => invCount(o, s.re) < oresBefore[s.name]),
                stepSettle);
            if ("blocked" in out) return finish("smelt_blocked", out.blocked);
            // Ore used by this call, from the observation before it. Bars made by it are what came out.
            const used = invCount(out.before, first.re) - invCount(out.after, first.re);
            const barsMade = invCount(out.after, site.barRe) - barsBefore;
            if (used > 0) {
                // Each ore used that made no bar is a failed smelt (the game's chance). Not a stall.
                const failed = Math.max(0, used - Math.max(0, barsMade));
                smeltFailed += failed;
                await ops.record({ kind: "routine_prep", runId: opts.runId, action: "smelt_batch", count, used, barsMade, failed, smeltFailed });
                unconfirmed = 0;
            } else if (++unconfirmed >= MAX_CONSECUTIVE_UNCONFIRMED) {
                return finish("smelt_unconfirmed", out.result.reason);
            }
            barsSmelted = invCount(out.after, site.barRe);
            cur = Object.fromEntries(site.ores.map((s) => [s.name, invCount(out.after, s.re)]));
        }

        // Bank: walk, check a booth is in view, open, deposit the bars, close.
        const toBank = await ops.walkTo(site.bank.x, site.bank.z, 4);
        await ops.record({ kind: "routine_prep", runId: opts.runId, action: "walk_to_bank", sdk: sdkSummary(toBank) });
        await ops.scanLocs();
        const atBank = await ops.observe();
        const booth = nearestBooth(atBank);
        await ops.record({ kind: "routine_prep", runId: opts.runId, action: "booth_check", nearestBooth: booth });
        if (!booth) return finish("no_bank_in_view", "no bank booth in the scan after walking to the bank");

        const opened = await step("open_bank", openBankCap, {},
            () => ops.openBank(), (o) => o.bankOpen && o.bankItems != null, bankSettle);
        if ("blocked" in opened) return finish("open_bank_failed", opened.blocked);
        if (opened.result.status !== "confirmed_success") return finish("open_bank_failed", opened.result.reason);

        const dep = await step("deposit", depositCap, { item: site.barName, amount: "all" },
            () => ops.deposit(site.barRe, -1), (o) => invCount(o, site.barRe) === 0, bankSettle);
        if ("blocked" in dep) return finish("deposit_failed", dep.blocked);
        if (dep.result.status === "confirmed_success" || dep.result.status === "partial") {
            barsDeposited = Number(dep.result.evidence.moved ?? 0);
        }
        if (dep.result.status !== "confirmed_success") return finish("deposit_failed", dep.result.reason);

        const closed = await step("close_bank", closeBankCap, {},
            () => ops.closeBank(), (o) => !o.bankOpen && o.interfaceOpen === false, bankSettle);
        if ("blocked" in closed) return finish("close_bank_failed", closed.blocked);
        if (closed.result.status !== "confirmed_success") return finish("close_bank_failed", closed.result.reason);

        return finish("goal_met");
    } catch (e: any) {
        return finish("error", e?.message ?? String(e));
    }
}

/**
 * The smelting menu line for a count. Make-X ("Smelt X Bronze") for anything over one bar, which then asks
 * for the count; the product line ("Bronze") for a single bar. Exact matches only, so "Smelt X Bronze" is
 * never mistaken for the product line.
 */
export function pickSmeltOption(
    options: Array<{ index: number; text: string }>,
    product = "Bronze",
    count = 1,
): { index: number; text: string } | null {
    // The live menu lists "Smelt X Bronze", "Smelt 10 Bronze", "Smelt 5 Bronze", then the product line as
    // "\\n\\n\\n\\nBronze" (the escape text, not real newlines). Strip the escapes before matching.
    const clean = (text: string) => text.replace(/\\[nrt]/g, "").replace(/\s+/g, " ").trim();
    const want = count > 1 ? new RegExp(`^Smelt X ${product}$`, "i") : new RegExp(`^${product}$`, "i");
    return options.find((o) => want.test(clean(o.text))) ?? null;
}

/**
 * Wait for a smelt batch to finish: until the ore count stops falling (after it has started), or the budget runs out.
 * Budget follows fletching's settle: 10 ticks plus about 4 per bar in the batch.
 */
async function waitForSmeltBatch(sdk: any, batch: number): Promise<void> {
    const oreTotal = () => (sdk.getInventory?.() ?? []).filter((i: any) => /ore$/i.test(i.name)).reduce((t: number, i: any) => t + (i.count ?? 0), 0);
    const budget = 10 + batch * 4;
    let last = oreTotal();
    let changed = false;
    let quiet = 0;
    for (let i = 0; i < budget; i++) {
        await withTimeout(sdk.waitForTicks(1), HANG_GUARD_MS);
        const now = oreTotal();
        if (now !== last) { last = now; changed = true; quiet = 0; } else if (changed && ++quiet >= 8) break;
        if (now === 0) break;
    }
}

/**
 * Mine the rock at a tile. Every rock is named just "Rocks", so it is found by its tile in a fresh scan.
 * Shared by the fixed routine and the model's mine_rock action.
 */
export async function mineRockAt(bot: any, sdk: any, x: number, z: number): Promise<unknown> {
    await withTimeout(sdk.scanNearbyLocs(15), HANG_GUARD_MS);
    const rock = (sdk.getNearbyLocs?.() ?? []).find((l: any) => l.x === x && l.z === z && /rock/i.test(l.name));
    if (!rock) return { success: false, reason: "loc_not_found", message: `no rock at (${x}, ${z}) in the scan` };
    return withTimeout(bot.mineRock(rock, { timeout: 30_000 }), HANG_GUARD_MS);
}

/**
 * Smelt `count` bars at the furnace in view: open its Smelt menu, pick the line for the count, answer the
 * count prompt for Make-X, then wait until the ore stops going down. Shared by the fixed routine and the
 * model's smelt action. The menu is logged through `log` before a click, because its index order is not the product order.
 */
export async function smeltAtFurnace(
    bot: any,
    sdk: any,
    product: string,
    count: number,
    log?: (entry: Record<string, unknown>) => Promise<void>,
    oreLeft?: () => number,
): Promise<any> {
    const trail: string[] = [];
    const before = oreLeft?.() ?? 0;
    let result = await smeltOneBatch(bot, sdk, product, count, log);
    if (!oreLeft) return result;
    // A level-up dialog stops a batch part way. Clear it and smelt what is left, up to a few batches.
    let batches = 1;
    trail.push(`batch 1 count ${count}: ore ${before} -> ${oreLeft()}`);
    for (; batches < SMELT_BATCHES_MAX && result?.success; batches++) {
        const left = oreLeft();
        if (left <= 0) break;
        if (sdk.getState?.()?.dialog?.isOpen) await withTimeout(bot.dismissBlockingUI(), HANG_GUARD_MS);
        const n = Math.min(SMELT_MAX_COUNT, left);
        result = await smeltOneBatch(bot, sdk, product, n, log);
        trail.push(`batch ${batches + 1} count ${n}: ore ${left} -> ${oreLeft()}`);
    }
    return { ...result, message: `${result?.message ?? ""} [${trail.join("; ")}]` };
}

/** Most batches one model smelt action will run before it returns. */
export const SMELT_BATCHES_MAX = 6;

async function smeltOneBatch(
    bot: any,
    sdk: any,
    product: string,
    count: number,
    log?: (entry: Record<string, unknown>) => Promise<void>,
): Promise<any> {
    // Only a furnace that offers Smelt is resolved (the Falador pair can overlap).
    const opened = await withTimeout(bot.interactLoc(/furnace/i, /^smelt$/i), HANG_GUARD_MS);
    if (!opened?.success) return opened;
    try {
        await sdk.waitForCondition((s: any) => s.dialog?.isOpen, 5000);
    } catch {
        return { success: false, reason: "no_dialog", message: "smelt dialog did not open" };
    }
    const options = (sdk.getState?.()?.dialog?.options ?? []) as Array<{ index: number; text: string }>;
    await log?.({ kind: "routine_prompt", action: "smelt_options", count, options: options.map((o) => ({ index: o.index, text: o.text })) });
    const line = pickSmeltOption(options, product, count);
    if (!line) return { success: false, reason: "no_product_option", message: `dialog: ${options.map((o) => o.text).join(" | ")}` };
    const clicked = await withTimeout(sdk.sendClickDialog(line.index), HANG_GUARD_MS);
    let countResult: unknown = null;
    if (count > 1) {
        // Make-X: the menu closes and the count prompt opens. Let a tick pass so the old menu is not what we wait on.
        await withTimeout(sdk.waitForTicks(1), HANG_GUARD_MS);
        try {
            await sdk.waitForCondition((s: any) => s.dialog?.isOpen, 5000);
        } catch {
            return { success: false, reason: "no_count_dialog", message: `Smelt X clicked; no count prompt for ${count}` };
        }
        countResult = await withTimeout(sdk.sendCountDialog(count), HANG_GUARD_MS);
    }
    // A batch runs on its own, a few ticks per bar. Wait until the ore stops going down, so the judgement sees the whole batch.
    await waitForSmeltBatch(sdk, count);
    // Say what was clicked and what the count prompt got, so a run log shows whether Make-X took the number.
    const base = typeof clicked === "object" && clicked !== null ? clicked : {};
    const countNote = count > 1 ? `; count ${count} sent: ${JSON.stringify(countResult ?? null).slice(0, 160)}` : "";
    return { ...base, message: `Clicked dialog option ${line.index} ("${line.text}")${countNote}` };
}

/**
 * Live ops: the SDK helpers. A timed-out SDK call comes back as { success: false, reason: "timeout" }
 * rather than an exception; the step still checks state, so the timeout is recorded but not trusted.
 */
export function liveMineSmeltOps(args: { bot: any; sdk: any; logDir: string; runId: string }): MineSmeltOps {
    const { bot, sdk } = args;
    const loggers = fileLoggers(args.logDir, { runId: args.runId });
    const look = () => observe(sdk, { scan: false });
    return {
        observe: look,
        startProblems(site) {
            const problems: string[] = [];
            const inv = sdk.getInventory?.() ?? [];
            const equip = sdk.getEquipment?.() ?? [];
            if (![...inv, ...equip].some((i: any) => /pickaxe/i.test(i.name))) problems.push("no pickaxe in inventory or equipment");
            const mining = sdk.getSkill?.("Mining");
            if (mining && mining.level < site.miningLevel) problems.push(`Mining ${mining.level} is below the ${site.id} rock requirement (${site.miningLevel})`);
            const smithing = sdk.getSkill?.("Smithing");
            if (smithing && smithing.level < site.smithingLevel) problems.push(`Smithing ${smithing.level} is below the ${site.id} smelt requirement (${site.smithingLevel})`);
            return problems;
        },
        walkTo: (x, z, tolerance) => withTimeout(bot.walkTo(x, z, tolerance), HANG_GUARD_MS),
        mineAt: (x, z) => mineRockAt(bot, sdk, x, z),
        smelt: (product, count) =>
            smeltAtFurnace(bot, sdk, product, count, (entry) => loggers.decisions.write({ schemaVersion: 1, ...entry })),
        scanLocs: () => withTimeout(sdk.scanNearbyLocs(15), HANG_GUARD_MS),
        clearBlocking: () => withTimeout(bot.dismissBlockingUI(), HANG_GUARD_MS),
        openBank: () => withTimeout(bot.openBank(), HANG_GUARD_MS),
        deposit: (item, amount) => withTimeout(bot.depositItem(item, amount), HANG_GUARD_MS),
        closeBank: () => withTimeout(bot.closeBank(), HANG_GUARD_MS),
        async settle(pred, maxTicks) {
            // Game time: wait one tick at a time and re-read state after each.
            let last = await look();
            for (let i = 0; i < maxTicks && !pred(last); i++) {
                await withTimeout(sdk.waitForTicks(1), HANG_GUARD_MS);
                last = await look();
            }
            return last;
        },
        async record(entry) {
            if (entry.kind === "routine_end") await loggers.episode.write({ schemaVersion: 1, kind: "routine", ...entry });
            else await loggers.decisions.write({ schemaVersion: 1, ...entry });
        },
    };
}
