// Run metrics from decisions.jsonl records. These are the numbers to track while
// tuning prompts or comparing models: invalid-reply rate, unconfirmed rate, steps.

export interface RunMetrics {
    runs: number;
    modelCalls: number;
    parseFailures: number;
    rejected: number;          // parsed but refused by validation (not_executed)
    goalRejected: number;      // "done" claimed but the game-side check said the goal was not met
    safetyOverrides: number;   // turns the safety layer took from the model (eat / flee) or ended the run with
    executed: number;
    statusCounts: Record<string, number>;
    rejectReasons: Record<string, number>;
    invalidReplyRate: number;  // (parseFailures + rejected) / modelCalls
    unconfirmedRate: number;   // (unconfirmed + partial) / executed
    avgLatencyMs: number | null;
    maxPromptChars: number;
    completionTokens: number;
}

const bump = (o: Record<string, number>, k: string) => { o[k] = (o[k] ?? 0) + 1; };

export function summarizeDecisions(all: any[]): RunMetrics {
    // goal_check and safety records are not model calls.
    const records = all.filter((r) => r.kind !== "goal_check" && r.kind !== "safety" && r.kind !== "start_check");
    const m: RunMetrics = {
        runs: 0, modelCalls: records.length, parseFailures: 0, rejected: 0, executed: 0,
        goalRejected: all.filter((r) => r.kind === "goal_check").length,
        safetyOverrides: all.filter((r) => r.kind === "safety").length,
        statusCounts: {}, rejectReasons: {}, invalidReplyRate: 0, unconfirmedRate: 0,
        avgLatencyMs: null, maxPromptChars: 0, completionTokens: 0,
    };
    let latencySum = 0, latencyN = 0, uncertain = 0;
    for (const r of records) {
        if (r.step === 1 && r.attempt === 0) m.runs++;
        m.maxPromptChars = Math.max(m.maxPromptChars, r.promptChars ?? 0);
        if (typeof r.latencyMs === "number") { latencySum += r.latencyMs; latencyN++; }
        m.completionTokens += r.meta?.completionTokens ?? 0;
        if (r.parse === "failed") { m.parseFailures++; bump(m.rejectReasons, r.reason ?? "parse_failed"); continue; }
        bump(m.statusCounts, r.status);
        if (r.status === "not_executed") { m.rejected++; bump(m.rejectReasons, r.reason); continue; }
        m.executed++;
        if (r.status === "unconfirmed" || r.status === "partial_progress_or_timeout") uncertain++;
    }
    m.invalidReplyRate = m.modelCalls ? (m.parseFailures + m.rejected) / m.modelCalls : 0;
    m.unconfirmedRate = m.executed ? uncertain / m.executed : 0;
    m.avgLatencyMs = latencyN ? Math.round(latencySum / latencyN) : null;
    return m;
}

export function formatMetrics(m: RunMetrics): string {
    const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
    return [
        `runs ${m.runs} | model calls ${m.modelCalls} | executed ${m.executed}`,
        `invalid replies ${m.parseFailures + m.rejected} (${pct(m.invalidReplyRate)}): ${m.parseFailures} unparseable, ${m.rejected} rejected`,
        `false "done" claims rejected by the goal check: ${m.goalRejected}`,
        `safety layer took over ${m.safetyOverrides} time(s)`,
        `unconfirmed/partial ${pct(m.unconfirmedRate)} of executed`,
        `statuses ${JSON.stringify(m.statusCounts)}`,
        `reject reasons ${JSON.stringify(m.rejectReasons)}`,
        `avg model latency ${m.avgLatencyMs ?? "n/a"}ms | max prompt ${m.maxPromptChars} chars | completion tokens ${m.completionTokens}`,
    ].join("\n");
}
