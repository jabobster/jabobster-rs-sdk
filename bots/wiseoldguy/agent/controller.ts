// The decision loop: observe -> ask policy for ONE action -> validate/execute/verify
// -> feed the result and a FRESH observation back. Bounded in steps, time, and
// repeated failures. The model never sees the SDK, only views, handles and results.

import { CONTRACT_VERSION, type ActionOutcome, type ActionType, type HandleMap, type ModelAction, type Observation } from "./contract";
import { nullSink, type JsonlSink } from "./logger";
import type { GameAdapter, ActOutput } from "./runAction";
import type { Policy } from "./policy";
import { SafetyMonitor, type SafetyConfig, type SafetyStop } from "./safety";
import type { StartCheck } from "./goals";
import { actionKey, parseModelOutput } from "./validate";
import { buildSystemPrompt, describeAction, renderTurn, summarizeOutcome, toModelView, type ViewOptions } from "./view";

export type StopReason =
    | "model_done" | "model_blocked" | "max_steps" | "timeout"
    | "player_dead" | "left_game" | "repeat_guard" | "invalid_streak" | "error" | "tick_budget"
    | SafetyStop | "start_check_failed" | "goal_met";

export interface ControllerConfig {
    goal: string;
    maxSteps?: number;        // default 30
    maxAttempts?: number;     // tries per step (first + retries after a rejected reply), default 2
    maxInvalidStreak?: number;// consecutive steps with no executable reply, default 3
    repeatLimit?: number;     // same non-success action this many times in a row, default 3
    memorySize?: number;      // result lines carried into the prompt, default 3
    /** Game ticks this run may use (measured from the first observation). Default 3000 (30 game minutes). */
    maxTicks?: number;
    /** Narrow the action set to what the goal needs (`stop` is always allowed). */
    allowedActions?: readonly ActionType[];
    /**
     * Optional per-step narrowing from the game state. Returns the actions allowed for this step, or undefined to
     * keep `allowedActions`. The model's schema, its prompt and validation all use the narrowed list.
     */
    allowedFor?: (obs: Observation) => readonly ActionType[] | undefined;
    /**
     * Game-side check run when the model says "done". A small model often claims
     * success early; this makes completion depend on evidence, not on the claim.
     * `baseline` is the observation from before the first action.
     */
    verifyDone?: (current: Observation, baseline: Observation) => { done: true } | { done: false; missing: string };
    /**
     * Optional: after a rejected "done", say where the missing thing is, using the handles the model
     * can act on (e.g. "The Cowhide is on the ground at g1: pick it up"). Returns undefined for no hint.
     */
    hintFor?: (current: Observation, baseline: Observation, handles: HandleMap) => string | undefined;
    /** What the model is shown: the global filter (default on) and an optional task filter. See view.ts. */
    view?: ViewOptions;
    /**
     * Deterministic safety layer (eat / flee at low HP, no-progress watchdog, failure caps).
     * On by default with SAFETY_DEFAULTS; pass `false` to switch it off.
     */
    safety?: SafetyConfig | false;
    /** Checked once before the first action (see TaskSpec.startCheck). Failing ends the run with start_check_failed. */
    startCheck?: (obs: Observation) => StartCheck;
}

/** Game ticks an outcome took, or undefined when the outcome carries no tick readings. */
const ticksOf = (o: { tickBefore?: number | null; tickAfter?: number | null }) =>
    o.tickBefore != null && o.tickAfter != null ? o.tickAfter - o.tickBefore : undefined;

export interface StepRecord {
    step: number;
    action: unknown;
    status: ActionOutcome["status"] | "invalid_reply";
    reason: string;
    /** Game ticks the action took (tickAfter - tickBefore). Absent for steps that never reached the game. */
    ticks?: number;
    /** Set when the safety layer, not the model, chose this action. */
    source?: "safety";
}

export interface ControllerResult {
    stopReason: StopReason;
    detail?: string;
    steps: number;
    history: StepRecord[];
    finalObservation: Observation | null;
    /** Observation before the first action. */
    baseline: Observation | null;
    /** The goal's own check applied to the final state, whatever the stop reason (null if the goal has none). */
    finalCheck: { done: true } | { done: false; missing: string } | null;
    /** How often each safety rule took over a turn. */
    safetyInterventions: Record<string, number>;
    /** Result of the start-state check; null when the task has none. A run with problems is invalid. */
    startCheck: StartCheck | null;
}

/**
 * What the game state looks like for the repeat block: position, inventory, combat, and which windows are open.
 * NPC and ground positions are left out, so a monster walking about does not count as progress.
 */
export function stateFingerprint(o: Observation): string {
    const inv = o.inventory.map((i) => `${i.name}x${i.quantity}`).sort().join(",");
    const combat = o.player.combat ? `${o.player.combat.inCombat}:${o.player.combat.targetType}:${o.player.combat.targetIndex}` : "-";
    return [o.player.x, o.player.z, o.player.level, inv, combat, o.bankOpen, o.shopOpen, o.interfaceOpen, o.dialog.isOpen].join("|");
}

interface StuckAction {
    key: string;
    type: string;
    fp: string;          // state fingerprint after the last failure
    count: number;       // consecutive identical failures with no state change in between
    message: string;     // SDK message or reason from the last failure, clipped
}

const clipText = (s: string, n: number) => {
    const flat = s.replace(/\s+/g, " ").trim();
    return flat.length > n ? flat.slice(0, n - 1) + "…" : flat;
};

export const UNCERTAIN_NOTE =
    "The last action's result was not confirmed: it may or may not have happened. Check the state before repeating it.";

export async function runController(
    adapter: GameAdapter,
    policy: Policy,
    config: ControllerConfig,
    decisions: JsonlSink = nullSink,
    now: () => number = Date.now,
): Promise<ControllerResult> {
    const maxSteps = config.maxSteps ?? 30;
    const maxAttempts = config.maxAttempts ?? 2;
    const maxInvalidStreak = config.maxInvalidStreak ?? 3;
    const repeatLimit = config.repeatLimit ?? 3;
    const memorySize = config.memorySize ?? 3;
    const maxTicks = config.maxTicks ?? 3000;

    const monitor = config.safety === false ? null : new SafetyMonitor(config.safety ?? {});
    const allowed = config.allowedActions;
    const system = buildSystemPrompt(config.goal, allowed);
    const memory: string[] = [];
    const history: StepRecord[] = [];

    let obs: Observation | null = null;
    let baseline: Observation | null = null;
    let note: string | undefined;
    let invalidStreak = 0;
    let falseDoneStreak = 0;   // consecutive "done" claims rejected by verifyDone
    let repeatKey: string | null = null;
    let repeatCount = 0;
    let stuck = null as StuckAction | null;

    let startCheck: StartCheck | null = null;
    const finish = (stopReason: StopReason, steps: number, detail?: string): ControllerResult => {
        let finalCheck: ControllerResult["finalCheck"] = null;
        if (config.verifyDone && obs && baseline) {
            try { finalCheck = config.verifyDone(obs, baseline); } catch { finalCheck = null; }
        }
        return {
            stopReason, detail, steps, history, finalObservation: obs, baseline, finalCheck,
            safetyInterventions: { ...(monitor?.interventions ?? {}) }, startCheck,
        };
    };

    try {
        obs = await adapter.observe();
        baseline = obs;
        const base = obs;
        const startTick = obs.tick;

        if (config.startCheck) {
            startCheck = config.startCheck(obs);
            if (!startCheck.ok) {
                await decisions.write({
                    schemaVersion: CONTRACT_VERSION, timestamp: new Date().toISOString(),
                    kind: "start_check", ok: false, problems: startCheck.problems, warnings: startCheck.warnings,
                });
                return finish("start_check_failed", 0, startCheck.problems.join("; "));
            }
            if (startCheck.warnings.length) {
                await decisions.write({
                    schemaVersion: CONTRACT_VERSION, timestamp: new Date().toISOString(),
                    kind: "start_check", ok: true, warnings: startCheck.warnings,
                });
            }
        }

        for (let step = 1; step <= maxSteps; step++) {
            if (obs.tick - startTick > maxTicks) return finish("tick_budget", step - 1, `${obs.tick - startTick} ticks used`);
            if (!obs.inGame) return finish("left_game", step - 1);
            if (obs.player.isDead) return finish("player_dead", step - 1);

            // -------- safety layer: may take this turn from the model
            if (monitor) {
                const verdict = monitor.check(obs);
                if (verdict.kind === "stop") {
                    await decisions.write({
                        schemaVersion: CONTRACT_VERSION, timestamp: new Date().toISOString(),
                        kind: "safety", step, rule: verdict.stopReason, action: "stop", detail: verdict.detail,
                    });
                    return finish(verdict.stopReason, step - 1, verdict.detail);
                }
                if (verdict.kind === "act") {
                    let tried: ModelAction = verdict.actions[0];
                    let out: ActOutput | null = null;
                    let handlesUsed = toModelView(obs, undefined, config.view).handles;
                    for (const candidate of verdict.actions) {
                        const v = toModelView(obs, undefined, config.view);
                        handlesUsed = v.handles;
                        tried = candidate;
                        // allowedActions is deliberately not passed: the goal narrows the MODEL, not the safety layer.
                        out = await adapter.act(candidate, { view: v.view, handles: v.handles, step, source: "safety", safetyRule: verdict.rule });
                        obs = out.after;
                        // Rejections cost no game time; fall through to the next candidate.
                        if (out.outcome.status !== "not_executed") break;
                    }
                    const o = out!.outcome;
                    await decisions.write({
                        schemaVersion: CONTRACT_VERSION, timestamp: new Date().toISOString(),
                        kind: "safety", step, rule: verdict.rule, reason: verdict.reason, action: tried,
                        status: o.status, outcomeReason: o.reason, dispatched: o.dispatched, message: o.message,
                    });
                    monitor.noteSafetyResult(verdict.rule, o.status);
                    history.push({ step, action: tried, status: o.status, reason: o.reason, source: "safety", ticks: ticksOf(o) });
                    memory.push(summarizeOutcome(step, `[auto] ${describeAction(tried, handlesUsed)}`, o));
                    note = undefined;
                    continue;
                }
            }

            // Per-step action set: the goal may narrow it to what this state needs. The prompt lists only those.
            const stepAllowed = config.allowedFor?.(obs) ?? allowed;
            const stepSystem = stepAllowed === allowed ? system : buildSystemPrompt(config.goal, stepAllowed);

            let { view, handles } = toModelView(obs, undefined, config.view);
            let previousError: string | undefined;
            let final: ActOutput | null = null;
            let finalRaw: unknown = null;
            let lastReason = "no_valid_reply";

            // Repeat block: after two identical failures with nothing changed, that action is rejected this turn.
            const fpBefore = stateFingerprint(obs);
            const blockNow = stuck && stuck.count >= 2 && stuck.fp === fpBefore ? stuck : null;
            const blocked = blockNow
                ? { key: blockNow.key, message: `${blockNow.type} failed twice with "${blockNow.message}" and nothing changed. Choose a different action.` }
                : undefined;

            for (let attempt = 0; attempt < maxAttempts; attempt++) {
                const user = renderTurn(view, memory.slice(-memorySize), note, previousError);
                const askedAt = now();
                const raw = await policy.decide({
                    goal: config.goal, allowed: stepAllowed, step, attempt, view, system: stepSystem, user,
                    memory: memory.slice(-memorySize), note, previousError,
                });
                const rawText = typeof raw === "string" ? raw : JSON.stringify(raw);
                const why = typeof (raw as { why?: unknown } | null)?.why === "string" ? (raw as { why: string }).why : undefined;
                const decision = {
                    schemaVersion: CONTRACT_VERSION, timestamp: new Date().toISOString(),
                    step, attempt, tick: view.tick, promptChars: stepSystem.length + user.length, rawOutput: rawText,
                    allowed: stepAllowed ?? null,
                    ...(why !== undefined ? { why } : {}),
                    latencyMs: now() - askedAt, ...(policy.lastMeta ? { meta: policy.lastMeta } : {}),
                } as Record<string, unknown>;

                const parsed = parseModelOutput(raw);
                if (!parsed.ok) {
                    previousError = parsed.message;
                    lastReason = parsed.code;
                    await decisions.write({ ...decision, parse: "failed", reason: parsed.code, message: parsed.message });
                    continue;
                }

                const stopCheck = (o: Observation) => (config.verifyDone ? config.verifyDone(o, base) : ({ done: true } as const));
                const out = await adapter.act(parsed.value, { view, handles, allowed: stepAllowed, step, stopCheck, blocked });
                await decisions.write({
                    ...decision, parse: "ok", status: out.outcome.status, reason: out.outcome.reason,
                    dispatched: out.outcome.dispatched, message: out.outcome.message,
                });

                // A rejected "done" is handled once, in the goal-check branch below, not retried as a bad action.
                if (out.outcome.status === "not_executed" && out.resolved?.type !== "stop") {
                    previousError = `${out.outcome.reason}: ${out.outcome.message}`;
                    lastReason = out.outcome.reason;
                    finalRaw = parsed.value;
                    // Rejections cost no game time: rebuild the view from the fresh state so a
                    // stale-handle retry sees current handles.
                    obs = out.after;
                    ({ view, handles } = toModelView(obs, undefined, config.view));
                    final = out;
                    continue;
                }
                final = out;
                finalRaw = parsed.value;
                previousError = undefined;
                break;
            }

            // -------- step ended: nothing executable
            if (!final || (final.outcome.status === "not_executed" && final.resolved?.type !== "stop")) {
                invalidStreak++;
                const desc = finalRaw ? describeAction(finalRaw, handles) : "invalid reply";
                memory.push(summarizeOutcome(step, desc, { status: "not_executed", reason: lastReason, message: previousError }));
                history.push({ step, action: finalRaw, status: "invalid_reply", reason: lastReason });
                note = undefined;
                if (invalidStreak >= maxInvalidStreak) return finish("invalid_streak", step, lastReason);
                continue;
            }

            // -------- step ended: something ran (or stop was requested)
            invalidStreak = 0;
            const { outcome, resolved } = final;
            history.push({ step, action: finalRaw, status: outcome.status, reason: outcome.reason, ticks: ticksOf(outcome) });
            obs = final.after;

            if (resolved?.type === "stop") {
                if (resolved.outcome === "blocked") return finish("model_blocked", step);

                const check = config.verifyDone ? config.verifyDone(obs, base) : ({ done: true } as const);
                if (check.done) return finish("model_done", step);

                // The model claimed success without evidence: reject the claim, keep going.
                await decisions.write({
                    schemaVersion: CONTRACT_VERSION, timestamp: new Date().toISOString(),
                    kind: "goal_check", step, done: false, missing: check.missing,
                });
                history[history.length - 1] = { step, action: finalRaw, status: "not_executed", reason: "goal_not_met" };
                const hint = config.hintFor?.(obs, base, toModelView(obs, undefined, config.view).handles);
                memory.push(`step ${step}: stop done -> rejected: goal not complete, still need ${check.missing}${hint ? `. ${hint}` : ""}`);
                note = `Your "done" was rejected. The goal is NOT complete: still need ${check.missing}.${hint ? ` ${hint}` : ""}`;
                falseDoneStreak++;
                if (falseDoneStreak >= maxInvalidStreak) return finish("invalid_streak", step, `goal_not_met: ${check.missing}`);
                continue;
            }
            falseDoneStreak = 0;

            // Repeat block bookkeeping: a failure that leaves the state unchanged counts toward the block.
            const changed = stateFingerprint(obs) !== fpBefore;
            if (outcome.status === "confirmed_success" || changed) {
                stuck = null;
            } else {
                const key = actionKey(finalRaw);
                const message = clipText(String(outcome.message ?? outcome.reason), 100);
                const type = String((finalRaw as any)?.type ?? "action");
                const prev: StuckAction | null = stuck;
                stuck = prev && prev.key === key
                    ? { ...prev, fp: stateFingerprint(obs), count: prev.count + 1, message }
                    : { key, type, fp: stateFingerprint(obs), count: 1, message };
            }

            monitor?.noteModelResult(outcome.status);
            memory.push(summarizeOutcome(step, describeAction(finalRaw, handles), outcome));
            note = outcome.status === "unconfirmed" || outcome.status === "partial_progress_or_timeout" ? UNCERTAIN_NOTE : undefined;

            // The game-side check is the authority. Once it passes, end the run instead of asking the model
            // to say so: a real run sat in 22 "wait 1 tick" turns after its goal was already met.
            if (config.verifyDone && config.verifyDone(obs, base).done) return finish("goal_met", step);

            // Repeat guard: the same action keeps failing to confirm.
            if (outcome.status === "confirmed_success") {
                repeatKey = null; repeatCount = 0;
            } else {
                const { why: _why, ...rest } = (finalRaw ?? {}) as Record<string, unknown>;
                // The resolved target is part of the key: "mine_rock" on a different rock is a different attempt.
                const target = resolved && "x" in resolved && "z" in resolved ? { at: [resolved.x, resolved.z] } : {};
                const key = JSON.stringify({ ...rest, ...target });
                repeatCount = key === repeatKey ? repeatCount + 1 : 1;
                repeatKey = key;
                if (repeatCount >= repeatLimit) return finish("repeat_guard", step, `${key} x${repeatCount}`);
            }
        }
        return finish("max_steps", maxSteps);
    } catch (error: any) {
        return finish("error", history.length, error?.message ?? String(error));
    }
}
