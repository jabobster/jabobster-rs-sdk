// Score a local model against the eval cases. Needs LM Studio running; NOT the game.
// Run from the rs-sdk project root:
//   bun .\bots\wiseoldguy\agent\run-evals.ts
//
// Environment variables (same as run-model.ts, plus):
//   LMSTUDIO_URL / LMSTUDIO_MODEL / LMSTUDIO_API_KEY / AGENT_THINK=1 / AGENT_WHY=1
//   AGENT_GOAL_VERSION   1 = original cow wording, 2 (default) = clarified wording
//   AGENT_EVAL_RUNS      replies per case (default 1; use with AGENT_EVAL_TEMP > 0)
//   AGENT_EVAL_TEMP      temperature (default 0 = deterministic)
//   AGENT_EVAL_CASE      only run cases whose id contains this text
//   AGENT_EVAL_SPLIT     dev | frozen: only run that split (default: all)
//   AGENT_EVAL_MIN       exit code 1 if the pass rate is below this (0..1)
//   AGENT_EVAL_OUT       results file (default bots/wiseoldguy/logs/evals/<model>-v<goal>-t<temp>-r<runs>-<think>-<time>.json)
//
// Compare result files side by side with compare-evals.ts.

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { makeRunId } from "./episode";
import { buildEvalFile, evalFileName } from "./evalReport";
import { CASES } from "./evalCases";
import { formatEvalReport, runEvals, summarizeEvals } from "./evalRunner";
import { cowGoal } from "./goals";
import { LocalModelPolicy } from "./localModel";

const version = process.env.AGENT_GOAL_VERSION === "1" ? 1 : 2;
const goal = cowGoal(version);
const runs = Number(process.env.AGENT_EVAL_RUNS ?? 1);
const only = process.env.AGENT_EVAL_CASE;
const split = process.env.AGENT_EVAL_SPLIT;
const cases = CASES.filter((c) => (!only || c.id.includes(only)) && (!split || c.split === split));
if (!cases.length) {
    console.error(`No eval case matches case "${only ?? "*"}" split "${split ?? "*"}". Cases: ${CASES.map((c) => `${c.id} (${c.split})`).join(", ")}`);
    process.exit(2);
}
const startedAt = new Date();
const runId = makeRunId(startedAt);

const policy = new LocalModelPolicy({
    baseUrl: process.env.LMSTUDIO_URL,
    model: process.env.LMSTUDIO_MODEL,
    apiKey: process.env.LMSTUDIO_API_KEY,
    withWhy: process.env.AGENT_WHY === "1",
    thinking: process.env.AGENT_THINK === "1",
    temperature: Number(process.env.AGENT_EVAL_TEMP ?? 0),
});

const model = await policy.ensureModel();
console.log(`Model: ${model} | goal wording v${version} | thinking ${process.env.AGENT_THINK === "1" ? "ON" : "off"} | temperature ${process.env.AGENT_EVAL_TEMP ?? 0} | ${cases.length} cases x ${runs} run(s)\n`);

const results = await runEvals(policy, cases, goal, { runs });
console.log(formatEvalReport(results));

const summary = summarizeEvals(results);
const config = {
    model, goalVersion: version, runs, split: split ?? null,
    thinking: process.env.AGENT_THINK === "1", temperature: Number(process.env.AGENT_EVAL_TEMP ?? 0),
    withWhy: process.env.AGENT_WHY === "1",
};
const out = process.env.AGENT_EVAL_OUT ?? `bots/wiseoldguy/logs/evals/${evalFileName(config, startedAt)}`;
await mkdir(dirname(out), { recursive: true });
const file = buildEvalFile({
    runId, startedAt, config, goal: goal.goal, results,
    caseSplits: Object.fromEntries(cases.map((c) => [c.id, c.split])), stats: policy.stats,
});
await writeFile(out, JSON.stringify(file, null, 2));
console.log(`\nResults: ${out}`);

const min = process.env.AGENT_EVAL_MIN;
if (min !== undefined && summary.passRate < Number(min)) process.exit(1);
