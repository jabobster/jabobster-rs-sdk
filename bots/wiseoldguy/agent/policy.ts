// A Policy turns the current turn's input into ONE raw action (object or text).
// The controller parses and validates whatever comes back; policies never touch the game.

import type { ActionType, ModelView } from "./contract";

export interface PolicyInput {
    goal: string;
    /** Actions this goal permits (undefined = all). `stop` is always permitted. */
    allowed?: readonly ActionType[];
    step: number;
    /** 0 for the first try this step, 1 for the retry after a rejected reply. */
    attempt: number;
    view: ModelView;
    /** Static per run (cache-friendly). */
    system: string;
    /** Volatile per turn: recent results, notes, state. */
    user: string;
    memory: string[];
    note?: string;
    previousError?: string;
}

export interface Policy {
    decide(input: PolicyInput): Promise<unknown>;
    /** Optional per-call info (tokens, finish reason) the controller copies into the decision log. */
    lastMeta?: Record<string, unknown>;
}

/** A deterministic policy backed by a function. Used for tests and the live smoke run. */
export class FixedPolicy implements Policy {
    constructor(private readonly fn: (input: PolicyInput) => unknown | Promise<unknown>) {}
    async decide(input: PolicyInput) {
        return await this.fn(input);
    }
}

/**
 * Replays a fixed list, one entry per decide() call (retries consume entries
 * too). When the list runs out it stops as "blocked".
 */
export function sequencePolicy(items: unknown[]): FixedPolicy {
    let i = 0;
    return new FixedPolicy(() => (i < items.length ? items[i++] : { type: "stop", outcome: "blocked" }));
}
