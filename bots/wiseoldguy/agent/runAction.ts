// One action cycle: observe -> validate -> execute -> wait -> classify -> log.
// SDK objects are injected, so the whole cycle runs against a fake in tests.

import {
    CONTRACT_VERSION, LOG_SCHEMA_VERSION,
    type ActionOutcome, type ActionType, type HandleMap, type ModelView, type Observation, type ResolvedAction,
} from "./contract";
import { classifyOutcome } from "./classify";
import { performAction } from "./execute";
import { nullSink, type JsonlSink } from "./logger";
import { collectNewMessages, observe, type ObserveStats } from "./observe";
import { validateAction } from "./validate";

type ObsItem = { name: string; quantity: number };
import type { TaskResources } from "./resources";

export const MAX_EXTRA_WAIT_TICKS = 3;
/** A mine can land several ticks after the SDK reports it rejected, so mining waits longer before giving up. */
export const MINE_EXTRA_WAIT_TICKS = 12;

/**
 * Hang guards in wall-clock ms, not game time. They only stop an SDK call that never returns; whether an
 * action worked is judged from game ticks and state. SDK calls cannot be cancelled; see withTimeout.
 * Set well above real-speed walking, so a slow but working action is never cut off.
 */
export const HANG_GUARD_MS = 120_000;
export const DEFAULT_TIMEOUTS: Record<string, number> = { default: HANG_GUARD_MS };

export interface ActOutput {
    outcome: ActionOutcome;
    /** Fresh observation after the action (or the pre-action one if nothing ran). */
    after: Observation;
    resolved: ResolvedAction | null;
}

export interface ActContext {
    view: ModelView;
    handles: HandleMap;
    /** Actions the current goal permits (undefined = all). */
    allowed?: readonly ActionType[];
    /** Controller step number, recorded in the diagnostics log. */
    step?: number;
    /** Who chose the action. Safety overrides are logged as such. Default "model". */
    source?: "model" | "safety";
    safetyRule?: string;
    /** Repeat block from the controller: this exact action is rejected (see controller.ts). */
    blocked?: { key: string; message: string };
    /**
     * Completion check for a "done" stop. When it is not done, the stop is logged as
     * not_executed (reason goal_not_met), not as a success, in every log stream.
     */
    stopCheck?: (obs: Observation) => { done: true } | { done: false; missing: string };
}

export interface GameAdapter {
    observe(): Promise<Observation>;
    act(raw: unknown, ctx: ActContext): Promise<ActOutput>;
}

/**
 * When to run the slow explicit ground scan.
 *  view   (default): only for the observation the model will see next (after each action, and at the start).
 *                    Pre-dispatch validation and extra-wait re-checks read the published mirror.
 *  always: every observation (the old behavior, ~2+ scans per action).
 *  never:  mirror only. Fastest; use once probe-scan.ts shows the mirror matches the scan.
 */
export type GroundScanMode = "view" | "always" | "never";

export interface LiveDeps {
    bot: any;
    sdk: any;
    diagnostics?: JsonlSink;
    timeouts?: Record<string, number>;
    extraWaitTicks?: number;
    groundScan?: GroundScanMode;
    /** Filled in as the run goes; read it for the episode record. */
    stats?: ObserveStats;
    /** Tree, logs and bow the task works with (see resources.ts). Default: oak. */
    resources?: TaskResources;
}

/**
 * An SDK call that never returns must not hang the loop. The underlying
 * promise keeps running (it cannot be cancelled), so after a timeout the
 * caller re-observes instead of trusting any later result.
 */
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

function actionTypeOf(raw: unknown): string | undefined {
    return (raw as { type?: string } | null)?.type;
}

function pathExistsFor(sdk: any) {
    return (x: number, z: number) => {
        if (typeof sdk.findPath !== "function") return true; // cannot check: do not block
        try {
            const p = sdk.findPath(x, z);
            return p?.success !== false;
        } catch {
            return true;
        }
    };
}

export async function runAction(
    deps: LiveDeps,
    raw: unknown,
    ctx: ActContext,
): Promise<ActOutput> {
    const { bot, sdk } = deps;
    const diagnostics = deps.diagnostics ?? nullSink;
    const timeouts = { ...DEFAULT_TIMEOUTS, ...deps.timeouts };
    const extraWaitTicks = deps.extraWaitTicks ?? (actionTypeOf(raw) === "mine_rock" ? MINE_EXTRA_WAIT_TICKS : MAX_EXTRA_WAIT_TICKS);
    const mode = deps.groundScan ?? "view";
    const viewScan = mode !== "never";                 // the observation the model will see
    const checkScan = mode === "always";               // internal checks
    const obsOf = (scan: boolean) => observe(sdk, { scan, stats: deps.stats });

    // Reset the chat cursor so older messages are not mistaken for evidence.
    await collectNewMessages(sdk);
    let before = await obsOf(checkScan);

    const pathExists = pathExistsFor(sdk);
    let validation = validateAction(raw, ctx, before, { pathExists, allowed: ctx.allowed, blocked: ctx.blocked, resources: deps.resources });
    // The mirror may lag the scan the model saw: before refusing a pickup as "gone", look once more with a real scan.
    if (!validation.ok && validation.code === "target_gone" && !checkScan && viewScan) {
        before = await obsOf(true);
        validation = validateAction(raw, ctx, before, { pathExists, allowed: ctx.allowed, blocked: ctx.blocked, resources: deps.resources });
    }

    const base = { schemaVersion: CONTRACT_VERSION, action: raw, tickBefore: before.tick };
    // Exactly what the model saw, so a replay can reproduce validation instead of guessing handles.
    const ctxLog = {
        step: ctx.step ?? null, view: ctx.view, handles: ctx.handles, allowed: ctx.allowed ?? null,
        source: ctx.source ?? "model", safetyRule: ctx.safetyRule ?? null,
    };

    // 1. Rejected: nothing is sent to the SDK.
    if (!validation.ok) {
        const outcome: ActionOutcome = {
            ...base, status: "not_executed", reason: validation.code, dispatched: false,
            message: validation.message, tickAfter: before.tick,
        };
        await diagnostics.write(diagRecord(raw, null, before, before, null, null, [], outcome, { ...ctxLog, stage: validation.stage }));
        return { outcome, after: before, resolved: null };
    }

    const action = validation.action;

    // 2. stop is a controller signal, not a game action.
    if (action.type === "stop") {
        const check = action.outcome === "done" && ctx.stopCheck ? ctx.stopCheck(before) : { done: true as const };
        const outcome: ActionOutcome = check.done
            ? { ...base, status: "confirmed_success", reason: "stop_requested", dispatched: false, tickAfter: before.tick }
            : {
                ...base, status: "not_executed", reason: "goal_not_met", dispatched: false,
                message: `the goal is not complete: still need ${check.missing}`, tickAfter: before.tick,
            };
        await diagnostics.write(diagRecord(raw, action, before, before, null, null, [], outcome, ctxLog));
        return { outcome, after: before, resolved: action };
    }

    // 3. Execute.
    let result: any;
    let thrownError: string | null = null;
    try {
        result = await withTimeout(performAction(bot, sdk, action, before), timeouts[action.type] ?? timeouts.default);
    } catch (error: any) {
        thrownError = error?.stack ?? error?.message ?? String(error);
        result = { success: false, reason: "threw_exception", message: error?.message ?? String(error) };
    }

    // 4. Observe; allow a few ticks for delayed state or messages.
    let messages = await collectNewMessages(sdk);
    let after = await obsOf(checkScan);
    let classification = classifyOutcome(action, before, after, result, messages);

    for (let i = 0; i < extraWaitTicks; i++) {
        if (classification.outcome === "confirmed_success" || classification.outcome === "confirmed_failure") break;
        if (action.type === "wait") break;
        await sdk.waitForTicks(1);
        messages = messages.concat(await collectNewMessages(sdk));
        after = await obsOf(checkScan);
        classification = classifyOutcome(action, before, after, result, messages);
    }

    // The observation handed back to the controller (and so to the model) gets the real scan, once.
    // Classify again from it so the logged outcome always matches the logged `after` (replay depends on that).
    if (viewScan && !checkScan) {
        messages = messages.concat(await collectNewMessages(sdk));
        after = await obsOf(true);
        classification = classifyOutcome(action, before, after, result, messages);
    }

    // A rock gives one ore and is empty for a while, so every mine (ore or not) marks its rock for DEPLETED_TICKS.
    const smeltTask = deps.resources?.smelt;
    if (action.type === "mine_rock" && smeltTask?.depleted) smeltTask.depleted.mark(action.x, action.z, after.tick);

    // Bars banked so far on a smelt task: the bars that left the pack on a confirmed deposit. The bank gate uses it.
    if (action.type === "deposit_items" && smeltTask && classification.outcome === "confirmed_success") {
        const barsIn = (inv: ObsItem[]) => inv.filter((i) => smeltTask.site.barRe.test(i.name)).reduce((t, i) => t + i.quantity, 0);
        const left = barsIn(after.inventory);
        smeltTask.banked = (smeltTask.banked ?? 0) + Math.max(0, barsIn(before.inventory) - left);
    }

    const outcome: ActionOutcome = {
        ...base,
        status: classification.outcome,
        reason: classification.reason,
        dispatched: true,
        evidence: classification.evidence,
        message: result?.message,
        tickAfter: after.tick,
    };
    await diagnostics.write(diagRecord(raw, action, before, after, result, thrownError, messages, outcome, ctxLog));
    return { outcome, after, resolved: action };
}

function diagRecord(
    raw: unknown, resolved: ResolvedAction | null, before: Observation, after: Observation,
    result: any, thrownError: string | null, messages: any[], outcome: ActionOutcome,
    extra: Record<string, unknown> = {},
) {
    return {
        schemaVersion: LOG_SCHEMA_VERSION,
        timestamp: new Date().toISOString(),
        modelAction: raw,
        resolved,
        before,
        result: result ?? null,
        thrownError,
        after,
        messages: messages.map((m: any) => ({
            type: m.type, text: m.text, sender: m.sender ?? null, tick: m.tick ?? null, fromSelf: m.fromSelf ?? null,
        })),
        classification: { outcome: outcome.status, reason: outcome.reason, evidence: outcome.evidence },
        dispatched: outcome.dispatched,
        diagnostics: {
            opRejectedCountBefore: before.opRejectedCount,
            opRejectedCountAfter: after.opRejectedCount,
            opRejectedCountDelta:
                before.opRejectedCount != null && after.opRejectedCount != null
                    ? after.opRejectedCount - before.opRejectedCount
                    : null,
        },
        ...extra,
    };
}

export function createLiveAdapter(deps: LiveDeps): GameAdapter {
    return {
        observe: () => observe(deps.sdk, { scan: (deps.groundScan ?? "view") !== "never", stats: deps.stats }),
        act: (raw, ctx) => runAction(deps, raw, ctx),
    };
}
