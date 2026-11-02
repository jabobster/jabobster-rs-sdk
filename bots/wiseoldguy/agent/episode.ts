// One record per run ("episode"), written to <log dir>/episode.jsonl. It answers "what was this run,
// how did it start, how did it end" without scanning the per-step logs, and its runId joins the
// decisions and diagnostics streams. Later phases (teacher demonstrations, evaluation against
// baselines) group and filter runs by these records.

import type { ControllerResult } from "./controller";
import type { Observation } from "./contract";

export const EPISODE_SCHEMA_VERSION = 2; // v2: task id, start check, and `valid` (a run that failed its start check does not count)

export function makeRunId(now: Date = new Date(), rand: () => number = Math.random): string {
    const stamp = now.toISOString().replace(/[:.]/g, "-").replace(/-\d{3}Z$/, "Z");
    return `${stamp}-${Math.floor(rand() * 0xffff).toString(16).padStart(4, "0")}`;
}

export interface StateSummary {
    tick: number;
    x: number;
    z: number;
    hp: number;
    maxHp: number;
    inventory: Record<string, number>;
    npcsNearby: number;
    groundItemsNearby: number;
}

export function summarizeState(obs: Observation | null): StateSummary | null {
    if (!obs) return null;
    const inventory: Record<string, number> = {};
    for (const i of obs.inventory) inventory[i.name] = (inventory[i.name] ?? 0) + i.quantity;
    return {
        tick: obs.tick, x: obs.player.x, z: obs.player.z, hp: obs.player.hp, maxHp: obs.player.maxHp,
        inventory, npcsNearby: obs.nearbyNpcs.length, groundItemsNearby: obs.nearbyGroundItems.length,
    };
}

export interface EpisodeInput {
    runId: string;
    startedAt: Date;
    endedAt: Date;
    task: { id?: string | null; goal: string; goalVersion?: number | null; allowedActions?: readonly string[] | null };
    /** Who drove: the model and its settings, or the deterministic baseline. */
    agent: Record<string, unknown>;
    result: ControllerResult;
    safety?: unknown;
}

export function buildEpisodeRecord(input: EpisodeInput) {
    const { result } = input;
    const byStatus: Record<string, number> = {};
    const byAction: Record<string, number> = {};
    const ticksByAction: Record<string, number> = {};
    let modelSteps = 0, safetySteps = 0;
    // Successful bank openings: a run that banks early makes more of these (each costs a walk there and back).
    let bankTrips = 0;
    for (const h of result.history) {
        if ((h.action as any)?.type === "open_bank" && h.status === "confirmed_success") bankTrips++;
        byStatus[h.status] = (byStatus[h.status] ?? 0) + 1;
        const type = (h.action as any)?.type ?? "none";
        byAction[type] = (byAction[type] ?? 0) + 1;
        ticksByAction[type] = (ticksByAction[type] ?? 0) + (h.ticks ?? 0);
        if (h.source === "safety") safetySteps++; else modelSteps++;
    }
    return {
        schemaVersion: EPISODE_SCHEMA_VERSION,
        kind: "episode",
        runId: input.runId,
        startedAt: input.startedAt.toISOString(),
        endedAt: input.endedAt.toISOString(),
        // Game time: the measure to compare runs by. Wall-clock durationMs depends on the server speed.
        ticks: result.baseline && result.finalObservation ? result.finalObservation.tick - result.baseline.tick : null,
        durationMs: input.endedAt.getTime() - input.startedAt.getTime(),
        task: { ...input.task, id: input.task.id ?? null },
        // A run that failed its start check never started; it is excluded from comparisons.
        valid: result.stopReason !== "start_check_failed",
        startCheck: result.startCheck
            ? { ok: result.startCheck.ok, problems: result.startCheck.ok ? [] : result.startCheck.problems, warnings: result.startCheck.warnings }
            : null,
        agent: input.agent,
        safety: input.safety ?? null,
        start: summarizeState(result.baseline),
        end: summarizeState(result.finalObservation),
        stopReason: result.stopReason,
        detail: result.detail ?? null,
        steps: result.steps,
        // The goal's own check on the final state, whatever the stop reason. null = the goal has no check.
        goalMet: result.finalCheck ? result.finalCheck.done : null,
        goalMissing: result.finalCheck && !result.finalCheck.done ? result.finalCheck.missing : null,
        counts: { modelSteps, safetySteps, byStatus, byAction, ticksByAction, bankTrips },
        safetyInterventions: result.safetyInterventions,
    };
}
