// Scores a Policy against the eval cases. It builds exactly the prompt the controller would
// (system prompt + rendered turn), validates the reply the same way, then asks the case
// whether the resulting action is acceptable.

import type { GoalSpec } from "./goals";
import type { BuiltCase, EvalCase } from "./evalCases";
import type { HandleMap, ModelView } from "./contract";
import type { Policy } from "./policy";
import { parseModelOutput, validateAction } from "./validate";
import { buildSystemPrompt, describeAction, renderTurn, toModelView } from "./view";

/** pass: valid and acceptable. wrong: valid but not what the case wants. invalid: unparseable or rejected. */
export type Verdict = "pass" | "wrong" | "invalid";

export interface Prepared extends BuiltCase {
    view: ModelView;
    handles: HandleMap;
}

export function prepare(c: EvalCase): Prepared {
    const built = c.build();
    return { ...built, ...toModelView(built.obs) };
}

export function judge(raw: unknown, c: EvalCase, p: Prepared, goal: GoalSpec): { verdict: Verdict; detail: string } {
    const parsed = parseModelOutput(raw);
    if (!parsed.ok) return { verdict: "invalid", detail: parsed.message };
    const v = validateAction(parsed.value, { view: p.view, handles: p.handles }, p.obs, { allowed: goal.allowedActions });
    if (!v.ok) return { verdict: "invalid", detail: `${v.code}: ${v.message}` };
    const detail = describeAction(parsed.value, p.handles);
    return { verdict: c.accept(v.action) ? "pass" : "wrong", detail };
}

export interface CaseResult {
    id: string;
    runs: number;
    pass: number;
    wrong: number;
    invalid: number;
    outputs: { raw: string; verdict: Verdict; detail: string; latencyMs: number }[];
}

export async function runEvals(
    policy: Policy,
    cases: EvalCase[],
    goal: GoalSpec,
    opts: { runs?: number; onResult?: (r: CaseResult) => void } = {},
): Promise<CaseResult[]> {
    const runs = opts.runs ?? 1;
    const system = buildSystemPrompt(goal.goal, goal.allowedActions);
    const results: CaseResult[] = [];

    for (const c of cases) {
        const p = prepare(c);
        const user = renderTurn(p.view, p.memory, p.note);
        const r: CaseResult = { id: c.id, runs, pass: 0, wrong: 0, invalid: 0, outputs: [] };

        for (let i = 0; i < runs; i++) {
            const started = Date.now();
            let raw: unknown;
            try {
                raw = await policy.decide({
                    goal: goal.goal, allowed: goal.allowedActions, step: 1, attempt: 0,
                    view: p.view, system, user, memory: p.memory, note: p.note,
                });
            } catch (error: any) {
                raw = `ERROR: ${error?.message ?? error}`;
            }
            const { verdict, detail } = judge(raw, c, p, goal);
            r[verdict]++;
            r.outputs.push({ raw: typeof raw === "string" ? raw : JSON.stringify(raw), verdict, detail, latencyMs: Date.now() - started });
        }
        results.push(r);
        opts.onResult?.(r);
    }
    return results;
}

export function summarizeEvals(results: CaseResult[]) {
    const runs = results.reduce((t, r) => t + r.runs, 0);
    const pass = results.reduce((t, r) => t + r.pass, 0);
    const invalid = results.reduce((t, r) => t + r.invalid, 0);
    return { cases: results.length, runs, pass, wrong: runs - pass - invalid, invalid, passRate: runs ? pass / runs : 0 };
}

export function formatEvalReport(results: CaseResult[]): string {
    const pct = (x: number) => `${Math.round(x * 100)}%`;
    const lines = results.map((r) => {
        const mark = r.pass === r.runs ? "PASS" : r.pass === 0 ? "FAIL" : "MIXED";
        const first = r.outputs.find((o) => o.verdict !== "pass") ?? r.outputs[0];
        const shown = r.pass === r.runs ? "" : `   e.g. ${first.verdict}: ${first.detail}`;
        return `${mark.padEnd(5)} ${r.id.padEnd(36)} ${r.pass}/${r.runs}${shown}`;
    });
    const s = summarizeEvals(results);
    lines.push("", `pass ${pct(s.passRate)} (${s.pass}/${s.runs})  wrong ${s.wrong}  invalid ${s.invalid}`);
    return lines.join("\n");
}
