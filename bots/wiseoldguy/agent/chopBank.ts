// Phase 3 step 5a: a fixed chop -> bank routine, run through the capability registry.
//
// The model is not involved. Each step checks the capability's preconditions, makes one SDK call,
// waits for the state to settle, and asks the capability's completion check whether it really
// happened. The SDK's own return value is recorded but never used as proof. The routine stops on
// the first blocker, or after repeated unconfirmed chops, instead of looping.
//
// Pathing: walk to the oak spot (chopTree needs a tree in range), then walk to the Varrock west bank
// booth before openBank(), because openBank() only finds a booth that is already nearby.

import { getCapability, type Capability, type CapResult } from "./capabilities";
import type { Observation } from "./contract";
import { fileLoggers } from "./logger";
import { observe } from "./observe";


/** An SDK call that never returns must not hang the routine. Same behavior as runAction's helper. */
export async function withTimeout(promise: Promise<any>, ms: number): Promise<any> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    promise.catch(() => {});
    const timeout = new Promise((resolve) => {
        timer = setTimeout(() => resolve({ success: false, reason: "timeout", message: `no result within ${ms}ms` }), ms);
    });
    try {
        return await Promise.race([promise, timeout]);
    } finally {
        clearTimeout(timer);
    }
}

export const OAK_LOG_NAME = "Oak logs";
export const OAK_TREE = /^oak$/i;
export const OAK_LOG = /^oak logs$/i;
// Oak cluster west and south of Varrock west bank. At least three oaks stand around this tile.
export const OAK_SPOT = { x: 3166, z: 3416 };
// Varrock west bank booth (from the probe). openBank() only searches what is nearby, so the routine walks here first.
export const VARROCK_WEST_BANK = { x: 3185, z: 3436 };
export const DEFAULT_TARGET_LOGS = 5;
export const MAX_CONSECUTIVE_UNCONFIRMED = 3;
/** Wall-clock hang guard for an SDK call that never returns. Not game time; judgement comes from ticks and state. */
export const HANG_GUARD_MS = 120_000;

export type RoutineStop =
    | "goal_met" | "start_blocked" | "no_oak_in_view" | "chop_blocked" | "chop_unconfirmed"
    | "no_bank_in_view"
    | "open_bank_failed" | "deposit_failed" | "close_bank_failed" | "error";

/** What the routine needs from the outside world. Live runs use liveOps(); tests pass stubs. */
export interface RoutineOps {
    observe(): Promise<Observation>;
    /** Problems that stop the routine before anything is done (axe, level). Empty = fine. */
    startProblems(): string[];
    walkToOakSpot(): Promise<unknown>;
    walkToBank(): Promise<unknown>;
    /** Fresh location scan around the player, so the next observe() sees trees and booths. */
    scanLocs(): Promise<unknown>;
    chop(): Promise<unknown>;
    openBank(): Promise<unknown>;
    deposit(item: RegExp, amount: -1): Promise<unknown>;
    closeBank(): Promise<unknown>;
    /** Wait game ticks until pred holds, up to maxTicks. Returns the last observation either way. */
    settle(pred: (o: Observation) => boolean, maxTicks: number): Promise<Observation>;
    /** One record per step, plus one at the end. */
    record(entry: Record<string, unknown>): Promise<void>;
}

export interface RoutineOptions {
    targetLogs?: number;
    /** Game ticks to wait for a chop's log before judging it. */
    chopSettleTicks?: number;
    /** Game ticks to wait for a bank step before judging it. */
    bankSettleTicks?: number;
    runId?: string;
}

export interface RoutineResult {
    stopReason: RoutineStop;
    detail?: string;
    logsGathered: number;
    logsDeposited: number;
    steps: number;
}

/** Quantity of an item in the inventory (case-insensitive). */
const invCount = (o: Observation, name: string) =>
    o.inventory.filter((i) => i.name.toLowerCase() === name.toLowerCase()).reduce((t, i) => t + i.quantity, 0);

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

export async function runChopBank(ops: RoutineOps, opts: RoutineOptions = {}): Promise<RoutineResult> {
    const target = opts.targetLogs ?? DEFAULT_TARGET_LOGS;
    const chopSettle = opts.chopSettleTicks ?? 30;
    const bankSettle = opts.bankSettleTicks ?? 15;
    const woodcutting = getCapability("woodcutting");
    const openBankCap = getCapability("open_bank");
    const depositCap = getCapability("deposit");
    const closeBankCap = getCapability("close_bank");

    let steps = 0;
    let gathered = 0;
    let deposited = 0;
    let startTick: number | null = null;
    let lastTick: number | null = null;

    const finish = async (stopReason: RoutineStop, detail?: string): Promise<RoutineResult> => {
        const ticks = startTick != null && lastTick != null ? lastTick - startTick : null;
        await ops.record({
            kind: "routine_end", runId: opts.runId, stopReason, detail: detail ?? null,
            steps, logsGathered: gathered, logsDeposited: deposited, ticks,
        });
        return { stopReason, detail, logsGathered: gathered, logsDeposited: deposited, steps };
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
        const before = await ops.observe();
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
        const startProblems = ops.startProblems();
        if (startProblems.length) return finish("start_blocked", startProblems.join("; "));

        // Logs already in the pack do not count: only logs gained during this run.
        const startObs = await ops.observe();
        startTick = startObs.tick;
        lastTick = startObs.tick;
        const startLogs = invCount(startObs, OAK_LOG_NAME);

        const walk = await ops.walkToOakSpot();
        await ops.record({ kind: "routine_prep", runId: opts.runId, action: "walk_to_oak_spot", sdk: sdkSummary(walk) });

        await ops.scanLocs();
        const seen = await ops.observe();
        const oaksInView = seen.locs?.trees.length ?? 0;
        await ops.record({
            kind: "routine_prep", runId: opts.runId, action: "scan_oaks",
            oaksInView, bankBoothsInView: seen.locs?.bankBooths.length ?? null,
        });
        if (oaksInView === 0) return finish("no_oak_in_view", "no oak tree in the nearby-location snapshot");

        // Chop until `target` logs are gathered. Each chop is judged on its own state change.
        let unconfirmed = 0;
        while (gathered < target) {
            const logsBefore = invCount(await ops.observe(), OAK_LOG_NAME);
            const out = await step("woodcutting", woodcutting, { logs: OAK_LOG_NAME },
                () => ops.chop(), (o) => invCount(o, OAK_LOG_NAME) > logsBefore, chopSettle);
            if ("blocked" in out) return finish("chop_blocked", out.blocked);
            if (out.result.status === "confirmed_success") {
                unconfirmed = 0;
                gathered = invCount(out.after, OAK_LOG_NAME) - startLogs;
            } else if (++unconfirmed >= MAX_CONSECUTIVE_UNCONFIRMED) {
                return finish("chop_unconfirmed", out.result.reason);
            }
        }

        // Walk to the bank first: openBank() only finds a booth that is already nearby.
        const toBank = await ops.walkToBank();
        await ops.record({ kind: "routine_prep", runId: opts.runId, action: "walk_to_bank", sdk: sdkSummary(toBank) });
        await ops.scanLocs();
        const atBank = await ops.observe();
        const booth = nearestBooth(atBank);
        await ops.record({ kind: "routine_prep", runId: opts.runId, action: "booth_check", nearestBooth: booth });
        if (!booth) return finish("no_bank_in_view", "no bank booth in the scan after walking to the bank");

        // Bank: open, deposit all oak logs, close. Each step is judged by its own completion check.
        const opened = await step("open_bank", openBankCap, {},
            () => ops.openBank(), (o) => o.bankOpen && o.bankItems != null, bankSettle);
        if ("blocked" in opened) return finish("open_bank_failed", opened.blocked);
        if (opened.result.status !== "confirmed_success") return finish("open_bank_failed", opened.result.reason);

        const dep = await step("deposit", depositCap, { item: OAK_LOG_NAME, amount: "all" },
            () => ops.deposit(OAK_LOG, -1), (o) => invCount(o, OAK_LOG_NAME) === 0, bankSettle);
        if ("blocked" in dep) return finish("deposit_failed", dep.blocked);
        if (dep.result.status === "confirmed_success" || dep.result.status === "partial") {
            deposited = Number(dep.result.evidence.moved ?? 0);
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
 * Live ops: the SDK helpers. A timed-out SDK call comes back as { success: false, reason: "timeout" }
 * rather than an exception; the step still checks state, so the timeout is recorded but not trusted.
 */
export function liveOps(args: { bot: any; sdk: any; logDir: string; runId: string }): RoutineOps {
    const { bot, sdk } = args;
    const loggers = fileLoggers(args.logDir, { runId: args.runId });
    const look = () => observe(sdk, { scan: false });
    return {
        observe: look,
        startProblems() {
            const problems: string[] = [];
            const inv = sdk.getInventory?.() ?? [];
            const equip = sdk.getEquipment?.() ?? [];
            if (![...inv, ...equip].some((i: any) => /axe/i.test(i.name))) problems.push("no axe in inventory or equipment");
            const wc = sdk.getSkill?.("Woodcutting");
            if (wc && wc.level < 15) problems.push(`Woodcutting ${wc.level} is below the oak requirement (15)`);
            return problems;
        },
        walkToOakSpot: () => withTimeout(bot.walkTo(OAK_SPOT.x, OAK_SPOT.z, 4), HANG_GUARD_MS),
        scanLocs: () => withTimeout(sdk.scanNearbyLocs(15), HANG_GUARD_MS),
        walkToBank: () => withTimeout(bot.walkTo(VARROCK_WEST_BANK.x, VARROCK_WEST_BANK.z, 4), HANG_GUARD_MS),
        chop: () => withTimeout(bot.chopTree(OAK_TREE), HANG_GUARD_MS),
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
