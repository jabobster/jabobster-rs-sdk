// Phase 3 step 6a: fixed routine (no model). Bank oak logs, fletch them into unstrung bows, bank the bows.
// Runs through the capability registry like chopBank.ts: each step checks its preconditions, makes one SDK
// call, waits for the state (in game ticks), then the capability's completion check decides.
//
// Confirmed live: the menu labels ("Oak Long Bow"), one bow per menu line click, and the pack name "Oak longbow".
// Unverified: the shortbow name and the level requirements below.

import { getCapability, type Capability, type CapResult } from "./capabilities";
import type { Observation, ObsStack } from "./contract";
import { isContinueOnly, observe } from "./observe";
import { fileLoggers } from "./logger";
import { HANG_GUARD_MS, OAK_LOG_NAME, VARROCK_WEST_BANK, withTimeout } from "./chopBank";

/** Confirmed in the live game: the longbow is called "Oak longbow" in the pack. The shortbow name is unverified. */
export const SHORTBOW_PRODUCT = "Oak shortbow";
export const LONGBOW_PRODUCT = "Oak longbow";
/** Make 10 fletches ten logs in one call. The routine uses it when it has at least this many logs. */
export const MENU_BATCH = 10;
export const MENU_BATCH_SMALL = 5;

/**
 * The menu quantity for the logs left in the pack. "Make 10" with fewer logs makes what is there, so it is used
 * for every call (confirmed live by hand); Make 5 and the product line are no longer needed.
 */
export function batchFor(logs: number): number {
    return logs > 0 ? MENU_BATCH : 0;
}

/** Menu text as the SDK gives it: literal backslash-n sequences and spaces collapsed to single spaces. */
export function normMenuText(t: string): string {
    return t.replace(/\\n|\s/g, " ").replace(/\s+/g, " ").trim();
}
/**
 * The label the skill menu lists for each bow (the SDK matches against these, as the live reply showed:
 * "Oak Short Bow", "Oak Long Bow"). The item name above is what the bow is called in the pack, unverified.
 */
export const MENU_LABEL: Record<string, string> = {
    [SHORTBOW_PRODUCT]: "Oak Short Bow",
    [LONGBOW_PRODUCT]: "Oak Long Bow",
};
/** Unverified: the Fletching level each unstrung bow needs. */
export const SHORTBOW_LEVEL = 20;
export const LONGBOW_LEVEL = 25;
export const DEFAULT_LOGS = 10;
export const MAX_CONSECUTIVE_UNCONFIRMED = 3;
const INVENTORY_SLOTS = 28;

export type FletchStop =
    | "goal_met" | "start_blocked" | "no_bank_in_view" | "open_bank_failed" | "no_logs_in_bank"
    | "withdraw_failed" | "close_bank_failed" | "fletch_blocked" | "fletch_unconfirmed"
    | "deposit_failed" | "error";

export interface FletchOps {
    observe(): Promise<Observation>;
    /** Fletching level, or null when the skill was not observed. */
    fletchingLevel(): number | null;
    walkToBank(): Promise<unknown>;
    scanLocs(): Promise<unknown>;
    openBank(): Promise<unknown>;
    withdraw(item: RegExp, amount: number): Promise<unknown>;
    closeBank(): Promise<unknown>;
    /** Use the knife on the logs and pick the menu line for `label`; `batch` 10 = "Make 10", 1 = the product line. */
    fletch(label: string, batch: number): Promise<unknown>;
    /** Click away "Click here to continue" pages. `blocking` describes a real choice left open, or null. */
    clearPrompt?(): Promise<{ cleared: number; blocking: string | null; menusClosed?: number }>;
    deposit(item: RegExp, amount: -1): Promise<unknown>;
    /** Wait game ticks until pred holds, up to maxTicks. Returns the last observation either way. */
    settle(pred: (o: Observation) => boolean, maxTicks: number): Promise<Observation>;
    /** One record per step, plus one at the end. */
    record(entry: Record<string, unknown>): Promise<void>;
}

export interface FletchOptions {
    targetLogs?: number;
    /** Game ticks to wait for a fletch to show in the state before judging it. */
    settleTicks?: number;
    /** Game ticks to wait for a bank step before judging it. */
    bankSettleTicks?: number;
    runId?: string;
}

export interface FletchResult {
    stopReason: FletchStop;
    detail?: string;
    product: string | null;
    logsWithdrawn: number;
    bowsMade: number;
    bowsDeposited: number;
    steps: number;
}

/** The product for a Fletching level, or null when the level is too low for any bow. */
export function chooseProduct(level: number | null): string | null {
    if (level == null) return null;
    if (level >= LONGBOW_LEVEL) return LONGBOW_PRODUCT;
    if (level >= SHORTBOW_LEVEL) return SHORTBOW_PRODUCT;
    return null;
}

const countOf = (stacks: ObsStack[] | null | undefined, name: string) =>
    (stacks ?? []).filter((s) => s.name.toLowerCase() === name.toLowerCase()).reduce((t, s) => t + s.quantity, 0);

/** Matches exactly one item name, case-insensitive. */
export const exactName = (name: string) => new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i");

const nearestBooth = (o: Observation) => {
    const booths = (o.locs?.bankBooths ?? []).filter((b) => b.distance != null);
    if (booths.length === 0) return null;
    const b = booths.reduce((a, c) => ((c.distance as number) < (a.distance as number) ? c : a));
    return { name: b.name, x: b.x, z: b.z, distance: b.distance };
};

const sdkSummary = (r: any) =>
    r == null ? null : { success: r.success ?? null, reason: r.reason ?? null, message: r.message ?? null };

type Judged = { blocked: string } | { result: CapResult; before: Observation; after: Observation; sdk: unknown };

export async function runFletchBank(ops: FletchOps, opts: FletchOptions = {}): Promise<FletchResult> {
    const target = opts.targetLogs ?? DEFAULT_LOGS;
    // A batch takes game time after the first log is used: about 12-14 ticks per bow, measured live.
    const settleFor = (batch: number) => opts.settleTicks ?? 10 + batch * 14;
    const bankSettle = opts.bankSettleTicks ?? 15;
    const openCap = getCapability("open_bank");
    const withdrawCap = getCapability("withdraw");
    const closeCap = getCapability("close_bank");
    const fletchCap = getCapability("fletching");
    const depositCap = getCapability("deposit");

    let steps = 0;
    let startTick: number | null = null;
    let lastTick: number | null = null;
    let product: string | null = null;
    let logsWithdrawn = 0, bowsMade = 0, bowsDeposited = 0;

    const finish = async (stopReason: FletchStop, detail?: string): Promise<FletchResult> => {
        const ticks = startTick != null && lastTick != null ? lastTick - startTick : null;
        await ops.record({
            kind: "routine_end", stopReason, detail: detail ?? null, steps, product,
            logsWithdrawn, bowsMade, bowsDeposited, ticks,
        });
        return { stopReason, detail, product, logsWithdrawn, bowsMade, bowsDeposited, steps };
    };

    // One judged step: check preconditions, act, wait for the state, then let the capability judge.
    const step = async (
        name: string,
        capability: Capability<any>,
        args: Record<string, unknown>,
        act: () => Promise<unknown>,
        settled: (o: Observation) => boolean,
        settleTicks: number | ((sdk: unknown) => number),
    ): Promise<Judged> => {
        steps++;
        const before = await ops.observe();
        const blockers = capability.preconditions(before, args);
        if (blockers.length) {
            await ops.record({ kind: "routine_step", step: steps, capability: name, args, status: "blocked", blockers });
            return { blocked: blockers.join("; ") };
        }
        let sdk: unknown = null;
        let sdkError: string | null = null;
        try { sdk = await act(); } catch (e: any) { sdkError = e?.message ?? String(e); }
        const after = await ops.settle(settled, typeof settleTicks === "function" ? settleTicks(sdk) : settleTicks);
        lastTick = after.tick;
        const result = capability.completion(before, after, args);
        await ops.record({
            kind: "routine_step", step: steps, capability: name, args,
            tickBefore: before.tick, tickAfter: after.tick, ticks: after.tick - before.tick,
            sdk: sdkSummary(sdk), sdkError, status: result.status, reason: result.reason, evidence: result.evidence,
        });
        return { result, before, after, sdk };
    };

    try {
        const start = await ops.observe();
        startTick = start.tick;
        lastTick = start.tick;

        const problems: string[] = [];
        if (!start.inventory.some((i) => /knife/i.test(i.name))) problems.push("no knife in the inventory");
        const carried = countOf(start.inventory, OAK_LOG_NAME);
        if (carried > 0) problems.push(`already carrying ${carried} oak logs: they would be fletched and counted`);
        if (start.inventory.length >= INVENTORY_SLOTS) problems.push("inventory is full");
        const level = ops.fletchingLevel();
        product = chooseProduct(level);
        if (!product) problems.push(`Fletching ${level ?? "unknown"} is below the bow requirement (${SHORTBOW_LEVEL})`);
        if (problems.length) return finish("start_blocked", problems.join("; "));
        const bow = product as string;   // non-null: the start checks above return when there is no product

        // Walk to the bank first: openBank() only finds a booth that is already nearby.
        const walk = await ops.walkToBank();
        await ops.record({ kind: "routine_prep", action: "walk_to_bank", sdk: sdkSummary(walk) });
        await ops.scanLocs();
        const atBank = await ops.observe();
        const booth = nearestBooth(atBank);
        await ops.record({ kind: "routine_prep", action: "booth_check", nearestBooth: booth });
        if (!booth) return finish("no_bank_in_view", "no bank booth in the scan after walking to the bank");

        const opened = await step("open_bank", openCap, {},
            () => ops.openBank(), (o) => o.bankOpen && o.bankItems != null, bankSettle);
        if ("blocked" in opened) return finish("open_bank_failed", opened.blocked);
        if (opened.result.status !== "confirmed_success") return finish("open_bank_failed", opened.result.reason);

        // Take as many logs as the target, the bank holds, and the free slots allow (logs do not stack).
        const inBank = countOf(opened.after.bankItems, OAK_LOG_NAME);
        if (inBank === 0) return finish("no_logs_in_bank", "no oak logs in the bank");
        const freeSlots = INVENTORY_SLOTS - opened.after.inventory.length;
        const amount = Math.min(target, inBank, freeSlots);
        if (amount < 1) return finish("start_blocked", "no free inventory slot for the logs");

        const wd = await step("withdraw", withdrawCap, { item: OAK_LOG_NAME, amount },
            () => ops.withdraw(exactName(OAK_LOG_NAME), amount),
            (o) => countOf(o.inventory, OAK_LOG_NAME) >= amount, bankSettle);
        if ("blocked" in wd) return finish("withdraw_failed", wd.blocked);
        logsWithdrawn = countOf(wd.after.inventory, OAK_LOG_NAME);
        if (wd.result.status !== "confirmed_success" && !(wd.result.status === "partial" && logsWithdrawn > 0)) {
            return finish("withdraw_failed", wd.result.reason);
        }

        const closed = await step("close_bank", closeCap, {},
            () => ops.closeBank(), (o) => !o.bankOpen && o.interfaceOpen === false, bankSettle);
        if ("blocked" in closed) return finish("close_bank_failed", closed.blocked);
        if (closed.result.status !== "confirmed_success") return finish("close_bank_failed", closed.result.reason);

        // Fletch one batch per call until the logs are used up. Each call is judged by XP, product and the log count.
        let carriedLogs = logsWithdrawn;
        let unconfirmed = 0;
        // Dismissals do not use up a try, so the bound counts them separately.
        for (let i = 0; carriedLogs > 0 && i < logsWithdrawn * 2 + MAX_CONSECUTIVE_UNCONFIRMED; i++) {
            const prompt = await ops.clearPrompt?.();
            if (prompt && (prompt.cleared > 0 || prompt.blocking)) {
                await ops.record({ kind: "routine_prompt", step: steps + 1, cleared: prompt.cleared, menusClosed: prompt.menusClosed ?? 0, blocking: prompt.blocking });
            }
            const logsBefore = carriedLogs;
            const batch = batchFor(logsBefore);
            // A dialog that opens partway through the batch (a level-up) ends the wait early, once the batch has begun.
            const t0 = (await ops.observe()).tick;
            const out = await step("fletching", fletchCap, { logs: OAK_LOG_NAME, product },
                () => ops.fletch(MENU_LABEL[product!] ?? product!, batch),
                (o) => countOf(o.inventory, OAK_LOG_NAME) <= logsBefore - Math.min(batch, logsBefore)
                    // only a level-up style "continue" page ends the wait early; a knife menu left in the state does not,
                    // because the batch keeps running in the game while it is shown
                    || (o.dialog?.isOpen === true && isContinueOnly(o.dialog) && o.tick >= t0 + 3),
                // a click that failed has nothing to wait for: settle briefly instead of the whole batch budget
                (sdkResult) => ((sdkResult as any)?.success === false ? 3 : settleFor(batch)));
            if ("blocked" in out) return finish("fletch_blocked", out.blocked);
            carriedLogs = countOf(out.after.inventory, OAK_LOG_NAME);
            if (out.result.status === "confirmed_success") {
                unconfirmed = 0;
                bowsMade += Number(out.result.evidence.made ?? 0);
            } else if ((out.sdk as any)?.reason === "continue_dismissed") {
                // a level-up prompt was cleared in the menu; the next call starts again from the pack
            } else if (++unconfirmed >= MAX_CONSECUTIVE_UNCONFIRMED) {
                return finish("fletch_unconfirmed", out.result.reason);
            }
        }
        if (carriedLogs > 0) return finish("fletch_unconfirmed", `${carriedLogs} oak logs left after fletching`);

        // Bank the bows. A level-up or menu can open after the last bow, so clear it before the bank is opened.
        const finalPrompt = await ops.clearPrompt?.();
        if (finalPrompt && (finalPrompt.cleared > 0 || finalPrompt.blocking)) {
            await ops.record({ kind: "routine_prompt", step: steps + 1, cleared: finalPrompt.cleared, menusClosed: finalPrompt.menusClosed ?? 0, blocking: finalPrompt.blocking });
        }
        const reopened = await step("open_bank", openCap, {},
            () => ops.openBank(), (o) => o.bankOpen && o.bankItems != null, bankSettle);
        if ("blocked" in reopened) return finish("open_bank_failed", reopened.blocked);
        if (reopened.result.status !== "confirmed_success") return finish("open_bank_failed", reopened.result.reason);

        const bowsCarried = countOf(reopened.after.inventory, bow);
        if (bowsCarried === 0) return finish("deposit_failed", "no bows in the pack after fletching");
        const dep = await step("deposit", depositCap, { item: bow, amount: "all" },
            () => ops.deposit(exactName(bow), -1), (o) => countOf(o.inventory, bow) === 0, bankSettle);
        if ("blocked" in dep) return finish("deposit_failed", dep.blocked);
        bowsDeposited = bowsCarried - countOf(dep.after.inventory, bow);
        if (dep.result.status !== "confirmed_success") return finish("deposit_failed", dep.result.reason);

        const closedAgain = await step("close_bank", closeCap, {},
            () => ops.closeBank(), (o) => !o.bankOpen && o.interfaceOpen === false, bankSettle);
        if ("blocked" in closedAgain) return finish("close_bank_failed", closedAgain.blocked);
        if (closedAgain.result.status !== "confirmed_success") return finish("close_bank_failed", closedAgain.result.reason);

        return finish("goal_met");
    } catch (e: any) {
        return finish("error", e?.message ?? String(e));
    }
}

/**
 * One fletch call through the knife menu. Uses the knife on the logs, then clicks the menu line for the bow:
 * "Make 10" (two lines above the product name, in the order Make X, Make 10, Make 5, product) or the product
 * line itself (one bow). Each click is checked against the menu text before it is sent, so a different layout
 * stops the call instead of clicking the wrong line.
 */
export async function fletchWithMenu(sdk: any, label: string, batch: number, logsName = OAK_LOG_NAME): Promise<{ success: boolean; message: string; reason?: string }> {
    const knife = sdk.findInventoryItem(/knife/i);
    const logs = sdk.findInventoryItem(exactName(logsName));
    if (!knife || !logs) return { success: false, reason: "item_not_found", message: "knife or oak logs not in the pack" };
    const sent = await sdk.sendUseItemOnItem(knife.slot, logs.slot);
    if (!sent?.success) return { success: false, reason: "dispatch_failed", message: sent?.message ?? "knife use was not sent" };
    try {
        await sdk.waitForCondition((s: any) => s.dialog?.isOpen === true, 10_000);
    } catch {
        return { success: false, reason: "menu_not_opened", message: "no menu after using the knife on the logs" };
    }
    const options: Array<{ index: number; text: string }> = sdk.getDialog()?.options ?? [];
    // A level-up prompt can cover the menu: clear it, and let the routine call again.
    const prompt = options.find((o) => /click here to continue/i.test(normMenuText(o.text)));
    if (prompt) {
        const dismissed = await sdk.sendClickDialog(prompt.index);
        return { success: false, reason: "continue_dismissed", message: dismissed?.success ? "dismissed a level-up prompt" : "could not dismiss the prompt" };
    }
    const at = options.findIndex((o) => normMenuText(o.text).toLowerCase() === label.toLowerCase());
    if (at < 0) {
        return { success: false, reason: "product_not_listed", message: `"${label}" not in the menu: ${options.map((o) => normMenuText(o.text)).join(" | ")}` };
    }
    // Menu order: Make X, Make 10, Make 5, then the product line.
    const pick = batch >= MENU_BATCH ? at - 2 : batch >= MENU_BATCH_SMALL ? at - 1 : at;
    const wanted = batch >= MENU_BATCH ? /^make\s*10$/i : batch >= MENU_BATCH_SMALL ? /^make\s*5$/i : null;
    const option = options[pick];
    if (wanted && (pick < 0 || !wanted.test(normMenuText(option.text)))) {
        return { success: false, reason: "menu_mismatch", message: `expected "Make ${batch}" before "${label}", found "${option ? normMenuText(option.text) : "nothing"}"` };
    }
    const clicked = await sdk.sendClickDialog(option.index);
    return { success: clicked?.success === true, reason: clicked?.success ? undefined : "click_failed", message: `clicked "${normMenuText(option.text)}" at index ${option.index}` };
}

/**
 * Live ops: the SDK helpers. A timed-out SDK call comes back as { success: false, reason: "timeout" }
 * rather than an exception; the step still checks state, so the timeout is recorded but not trusted.
 */
/** The knife menu: a dialog whose options include a "Make 10" line. */
function knifeMenuOpen(sdk: any): boolean {
    const dialog = sdk.getDialog?.();
    return dialog?.isOpen === true && (dialog.options ?? []).some((o: { text: string }) => /make\s*10/i.test(normMenuText(o.text)));
}

/** Close the menu: the modal close first, then the blocking-UI dismiss. True once the state shows it closed. */
async function closeKnifeMenu(sdk: any, bot: any): Promise<boolean> {
    await withTimeout(Promise.resolve(sdk.sendCloseModal?.()), HANG_GUARD_MS);
    await withTimeout(sdk.waitForTicks(1), HANG_GUARD_MS);
    if (!knifeMenuOpen(sdk)) return true;
    await withTimeout(Promise.resolve(bot.dismissBlockingUI?.()), HANG_GUARD_MS);
    await withTimeout(sdk.waitForTicks(1), HANG_GUARD_MS);
    return !knifeMenuOpen(sdk);
}

/**
 * One knife use on the logs: the menu line is clicked (one call makes the whole batch), the menu is closed if a click
 * did not register, and the result says what happened. Shared by the fixed routine and the model's fletch action.
 */
export async function fletchKnife(sdk: any, bot: any, label: string, batch: number, logsName = OAK_LOG_NAME): Promise<any> {
    // The bank closes on the same tick the knife would be used (the logs show close_bank ending on the tick
    // the knife starts): wait a couple of ticks so the game has finished closing before the knife goes out.
    await withTimeout(sdk.waitForTicks(2), HANG_GUARD_MS);
    const logsRe = exactName(logsName);
    const logsBefore = sdk.countInventoryItems?.(logsRe) ?? null;
    const result: any = await withTimeout(fletchWithMenu(sdk, label, batch, logsName), HANG_GUARD_MS);
    if (!result?.success) return result;
    // A click the game acted on closes the menu. Still open a few ticks later means the click did not register,
    // unless logs are already being used up (the batch is running): then leave it alone.
    await withTimeout(sdk.waitForTicks(3), HANG_GUARD_MS);
    if (!knifeMenuOpen(sdk)) return result;
    const logsNow = sdk.countInventoryItems?.(logsRe) ?? null;
    if (logsBefore != null && logsNow != null && logsNow < logsBefore) return result;
    const closed = await closeKnifeMenu(sdk, bot);
    return { success: false, reason: closed ? "menu_left_open" : "menu_stuck", message: closed ? "menu still open after the click; closed it" : "menu still open and would not close" };
}

export function liveOps(args: { bot: any; sdk: any; logDir: string; runId: string }): FletchOps {
    const { bot, sdk } = args;
    const loggers = fileLoggers(args.logDir, { runId: args.runId });
    const look = () => observe(sdk, { scan: false });
    return {
        observe: look,
        fletchingLevel: () => sdk.getSkill?.("Fletching")?.level ?? null,
        walkToBank: () => withTimeout(bot.walkTo(VARROCK_WEST_BANK.x, VARROCK_WEST_BANK.z, 4), HANG_GUARD_MS),
        scanLocs: () => withTimeout(sdk.scanNearbyLocs(15), HANG_GUARD_MS),
        openBank: () => withTimeout(bot.openBank(), HANG_GUARD_MS),
        withdraw: (item, amount) => withTimeout(bot.withdrawItem(item, amount), HANG_GUARD_MS),
        closeBank: () => withTimeout(bot.closeBank(), HANG_GUARD_MS),
        fletch(label, batch) {
            return fletchKnife(sdk, bot, label, batch);
        },
        async clearPrompt() {
            // Same rule as the chop routine: a page with no choice (no options, or only "Click here to continue") is clicked through.
            // A knife menu left open from an earlier call is closed, so the next knife use starts clean.
            let cleared = 0, menusClosed = 0;
            for (let i = 0; i < 5; i++) {
                const dialog = sdk.getDialog?.();
                if (!dialog?.isOpen) break;
                const options: Array<{ index: number; text: string }> = dialog.options ?? [];
                if (knifeMenuOpen(sdk)) {
                    if (!(await closeKnifeMenu(sdk, bot))) {
                        return { cleared, menusClosed, blocking: options.map((o) => `${o.index}=${normMenuText(o.text)}`).join(" | ") };
                    }
                    cleared++; menusClosed++;
                    continue;
                }
                const continueOnly = options.length === 0 || (options.length === 1 && /click here to continue/i.test(normMenuText(options[0].text)));
                if (!continueOnly) {
                    // index=text, so a log shows which server index each line had when it was left open
                    const blocking = options.map((o) => `${o.index}=${normMenuText(o.text)}`).join(" | ") || normMenuText(dialog.text ?? "");
                    return { cleared, menusClosed, blocking };
                }
                const clicked = await withTimeout(sdk.sendClickDialog(options.length ? options[0].index : 0), HANG_GUARD_MS);
                await withTimeout(sdk.waitForTicks(1), HANG_GUARD_MS);
                // a failed click on a page that has already gone is not a blocker: look again on the next pass
                if (clicked?.success !== true && sdk.getDialog?.()?.isOpen === true) {
                    return { cleared, menusClosed, blocking: "could not click the prompt" };
                }
                cleared++;
            }
            return { cleared, menusClosed, blocking: null };
        },
        deposit: (item, amount) => withTimeout(bot.depositItem(item, amount), HANG_GUARD_MS),
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
