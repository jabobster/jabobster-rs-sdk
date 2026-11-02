// Eval result files: what run-evals.ts writes, and the table compare-evals.ts prints from many of them.
// The file records every setting that changes results (model, goal wording, thinking, temperature),
// because two runs that differ in a setting nobody wrote down cannot be compared honestly.

import type { CaseResult } from "./evalRunner";
import { summarizeEvals } from "./evalRunner";

export const EVAL_FILE_VERSION = 2;

export interface EvalRunConfig {
    model: string;
    goalVersion: number;
    thinking: boolean | null;     // null = unknown (files written before version 2)
    temperature: number | null;
    runs: number;
    withWhy?: boolean | null;
    split?: string | null;        // "dev" | "frozen" | null (all)
}

export interface EvalFile {
    fileVersion?: number;
    runId?: string;
    startedAt?: string;
    model: string;
    goalVersion: number;
    runs: number;
    goal: string;
    config?: EvalRunConfig;
    caseSplits?: Record<string, string>;
    summary: ReturnType<typeof summarizeEvals>;
    results: CaseResult[];
    stats?: { calls: number; promptTokens: number; completionTokens: number; totalLatencyMs: number };
}

const slug = (s: string) => s.replace(/[^\w.-]+/g, "_");

/** e.g. qwen3.5-4b-v2-t0.4-r5-nothink-2026-10-29T18-43-40Z.json */
export function evalFileName(c: EvalRunConfig, startedAt: Date): string {
    const t = c.temperature ?? 0;
    const stamp = startedAt.toISOString().replace(/[:.]/g, "-").replace(/-\d{3}Z$/, "Z");
    return `${slug(c.model)}-v${c.goalVersion}-t${t}-r${c.runs}-${c.thinking ? "think" : "nothink"}-${stamp}.json`;
}

export function buildEvalFile(input: {
    runId: string;
    startedAt: Date;
    config: EvalRunConfig;
    goal: string;
    results: CaseResult[];
    caseSplits: Record<string, string>;
    stats: EvalFile["stats"];
}): EvalFile {
    return {
        fileVersion: EVAL_FILE_VERSION,
        runId: input.runId,
        startedAt: input.startedAt.toISOString(),
        model: input.config.model,
        goalVersion: input.config.goalVersion,
        runs: input.config.runs,
        goal: input.goal,
        config: input.config,
        caseSplits: input.caseSplits,
        summary: summarizeEvals(input.results),
        results: input.results,
        stats: input.stats,
    };
}

// ------------------------------------------------------------------ comparison

/** Short column label. Files from before version 2 do not know thinking/temperature. */
export function columnLabel(f: EvalFile): string {
    const c = f.config;
    const think = c ? (c.thinking === null ? "think?" : c.thinking ? "think" : "nothink") : "think?";
    const temp = c?.temperature != null ? `t${c.temperature}` : "t?";
    return `${f.model} v${f.goalVersion} ${temp} x${f.runs} ${think}`;
}

export interface CompareOpts { split?: string }

export function formatComparison(files: { label?: string; file: EvalFile }[], opts: CompareOpts = {}): string {
    if (!files.length) return "No result files.";
    const cols = files.map((f, i) => ({ label: f.label ?? columnLabel(f.file), file: f.file, n: i + 1 }));

    // Every case that appears in any file, in first-seen order.
    const ids: string[] = [];
    for (const c of cols) for (const r of c.file.results) if (!ids.includes(r.id)) ids.push(r.id);
    const splitOf = (id: string) => cols.map((c) => c.file.caseSplits?.[id]).find(Boolean) ?? "dev";
    const shown = ids.filter((id) => !opts.split || splitOf(id) === opts.split);

    const cell = (c: (typeof cols)[number], id: string) => {
        const r = c.file.results.find((x) => x.id === id);
        if (!r) return "-";
        const bad = r.invalid ? ` (${r.invalid} inv)` : "";
        return `${r.pass}/${r.runs}${bad}`;
    };

    const idW = Math.max(4, ...shown.map((s) => s.length));
    const lines: string[] = [];
    lines.push("Columns:");
    for (const c of cols) lines.push(`  [${c.n}] ${c.label}${c.file.startedAt ? `  (${c.file.startedAt})` : ""}`);
    lines.push("");

    const head = ["case".padEnd(idW), ...cols.map((c) => `[${c.n}]`.padStart(11)), "  all runs"];
    lines.push(head.join(" "));
    lines.push("-".repeat(head.join(" ").length + 8));

    for (const id of shown) {
        let pass = 0, total = 0;
        for (const c of cols) {
            const r = c.file.results.find((x) => x.id === id);
            if (r) { pass += r.pass; total += r.runs; }
        }
        // never = a systematic failure worth fixing; mixed = noise or a borderline decision.
        const tag = total === 0 ? "" : pass === 0 ? "  NEVER" : pass === total ? "  always" : "  mixed";
        lines.push([id.padEnd(idW), ...cols.map((c) => cell(c, id).padStart(11)), `  ${pass}/${total}${tag}`].join(" "));
    }

    const rateOf = (f: EvalFile) => {
        const rs = f.results.filter((r) => shown.includes(r.id));
        const runs = rs.reduce((t, r) => t + r.runs, 0), pass = rs.reduce((t, r) => t + r.pass, 0);
        return { runs, pass, inv: rs.reduce((t, r) => t + r.invalid, 0) };
    };
    lines.push("-".repeat(head.join(" ").length + 8));
    lines.push(["pass rate".padEnd(idW), ...cols.map((c) => { const s = rateOf(c.file); return `${s.runs ? Math.round((100 * s.pass) / s.runs) : 0}%`.padStart(11); })].join(" "));
    lines.push(["invalid".padEnd(idW), ...cols.map((c) => String(rateOf(c.file).inv).padStart(11))].join(" "));
    lines.push(["ms/call".padEnd(idW), ...cols.map((c) => {
        const s = c.file.stats;
        return (s && s.calls ? String(Math.round(s.totalLatencyMs / s.calls)) : "?").padStart(11);
    })].join(" "));
    return lines.join("\n");
}
