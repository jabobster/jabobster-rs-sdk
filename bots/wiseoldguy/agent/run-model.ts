// Live run: a local model (LM Studio) drives the game through the Phase 2 controller.
//
// Prereqs: lite client running; LM Studio local server started with a model loaded.
// Run from the rs-sdk project root:
//   bun --env-file=.\bots\wiseoldguy\.env .\bots\wiseoldguy\agent\run-model.ts
//
// Optional environment variables:
//   LMSTUDIO_URL     default http://localhost:1234/v1
//   LMSTUDIO_MODEL   default: first chat model LM Studio reports
//   LMSTUDIO_API_KEY sent as a Bearer token if LM Studio requires auth
//   AGENT_TASK       chop-bank = chop logs and bank them; fletch-bank = withdraw logs, fletch bows, bank the bows
//                    (default: the cow goal)
//   AGENT_TREE       oak (default), willow or maple: the tree, logs and bows the task uses (not chosen by the model)
//   AGENT_BOW        fletch-bank only: shortbow or longbow (default longbow)
//   AGENT_LOG_COUNT  fletch-bank only: logs to withdraw and fletch, 1 to 28 (default 10)
//   AGENT_CHOP_TARGET  chop-bank only: a number of logs (default 5), or "full" = every free slot at the start
//   AGENT_GOAL       default: the cow goal
//   AGENT_GOAL_VERSION 1 = original cow goal wording, 2 (default) = clarified wording
//   AGENT_SMELT_GOAL  mine-smelt-bank only: goal wording template. Placeholders {bars} {ore} {barItem} {mine} {furnace} {bank}. Completion check unchanged.
//   AGENT_MAX_STEPS  default 30
//   AGENT_WHY=1      ask the model for a short `why` (debugging)
//   AGENT_THINK=1    allow thinking (default off: Qwen's thinking uses up the 100-token budget)
//   AGENT_SAFETY=0   switch the safety layer off (default on)
//   AGENT_LOW_HP     low-HP threshold as a fraction of max HP (default 0.2)
//   AGENT_SAFE_POINT x,z  where to run when low on HP and out of food (default: away from nearby enemies)
//   AGENT_ON_FLEE_FAILED=stop  stop instead of fighting on when running away did not work
//   AGENT_LOG_DIR    default bots/wiseoldguy/logs/phase2-model-<timestamp>

import { runScript } from "../../../sdk/runner";
import { runController } from "./controller";
import { chopBankGoal, cowGoal, fletchBankGoal, mineSmeltGoal, parseChopTarget, resolveChopTarget } from "./goals";
import { DEFAULT_PAIRS, SITES, type SmeltSite } from "./mineSmelt";
import { DepletedRocks } from "./smeltRules";
import { nearestBank } from "./places";
import { DEFAULT_RESOURCES, parseBow, parseTree, type TaskResources } from "./resources";
import { LocalModelPolicy } from "./localModel";
import { buildEpisodeRecord, makeRunId } from "./episode";
import { fileLoggers, memorySink, nullSink, type JsonlSink } from "./logger";
import { safetyFromEnv } from "./safety";
import { formatMetrics, summarizeDecisions } from "./metrics";
import { createLiveAdapter } from "./runAction";

// A custom AGENT_GOAL runs with all actions and no completion check.
// The chop-bank goal is built inside the run, once the start state is known (AGENT_CHOP_TARGET=full needs it).
const CHOP_BANK = !process.env.AGENT_GOAL && process.env.AGENT_TASK === "chop-bank";
const FLETCH_BANK = !process.env.AGENT_GOAL && process.env.AGENT_TASK === "fletch-bank";
const MINE_SMELT = !process.env.AGENT_GOAL && process.env.AGENT_TASK === "mine-smelt-bank";
// Mine-smelt: the site fixes the rocks, furnace and bank. AGENT_SMELT_BARS is the bar target (1 to 28; the pack limits it).
const SMELT_SITE: SmeltSite | null = MINE_SMELT ? (() => {
    const id = process.env.AGENT_SMELT_SITE ?? "falador-bronze";
    if (!(id in SITES)) throw new Error(`AGENT_SMELT_SITE must be one of ${Object.keys(SITES).join(", ")}, got "${id}"`);
    return SITES[id];
})() : null;
const SMELT_BARS = (() => {
    const n = Number(process.env.AGENT_SMELT_BARS ?? DEFAULT_PAIRS);
    if (!Number.isInteger(n) || n < 1 || n > 28) throw new Error(`AGENT_SMELT_BARS must be a whole number from 1 to 28, got "${process.env.AGENT_SMELT_BARS}"`);
    return n;
})();
const presetTask = process.env.AGENT_GOAL || CHOP_BANK || FLETCH_BANK || MINE_SMELT ? null
    : cowGoal(process.env.AGENT_GOAL_VERSION === "1" ? 1 : 2);
const CHOP_SPEC = parseChopTarget(process.env.AGENT_CHOP_TARGET);
const CHOP_SPOT = { x: 3166, z: 3416 }; // the oak spot the chop goal walks to
const TREE = parseTree(process.env.AGENT_TREE);
const BOW = parseBow(process.env.AGENT_BOW);
// The actions run against the tree, logs and bow the task names; the model cannot change them. Chopping needs no count.
const LOG_COUNT = (() => {
    const n = Number(process.env.AGENT_LOG_COUNT ?? 10);
    if (!Number.isInteger(n) || n < 1 || n > 28) throw new Error(`AGENT_LOG_COUNT must be a whole number from 1 to 28, got "${process.env.AGENT_LOG_COUNT}"`);
    return n;
})();
// One rock memory per run, shared by the mining code and the goal's action rule.
const DEPLETED = new DepletedRocks();
const resources: TaskResources = FLETCH_BANK
    ? { resource: TREE, logCount: LOG_COUNT, bow: BOW }
    : SMELT_SITE
        ? { resource: TREE, logCount: 0, smelt: { site: SMELT_SITE, bars: SMELT_BARS, depleted: DEPLETED } }
        : { resource: TREE, logCount: 0 };
const MAX_STEPS = Number(process.env.AGENT_MAX_STEPS ?? 60);
const startedAt = new Date();
const RUN_ID = makeRunId(startedAt);
// One folder for all model runs. Every line carries runId, so runs are told apart inside the files.
const LOG_DIR = process.env.AGENT_LOG_DIR ?? "bots/wiseoldguy/logs/phase2-model";
const SAFETY = safetyFromEnv(process.env);

const policy = new LocalModelPolicy({
    baseUrl: process.env.LMSTUDIO_URL,
    model: process.env.LMSTUDIO_MODEL,
    apiKey: process.env.LMSTUDIO_API_KEY,
    withWhy: process.env.AGENT_WHY === "1",
    thinking: process.env.AGENT_THINK === "1",
});

// Fail fast, before connecting to the game, if LM Studio is not reachable.
const modelId = await policy.ensureModel();
console.log(`Model: ${modelId}\nRun: ${RUN_ID}\nLogs: ${LOG_DIR}\nSafety: ${SAFETY === false ? "OFF" : JSON.stringify(SAFETY)}`);

await runScript(async ({ bot, sdk }) => {
    const loggers = fileLoggers(LOG_DIR, { runId: RUN_ID });
    const captured = memorySink();
    // Tee decisions: to disk for later replay, and to memory for the end-of-run summary.
    const decisions: JsonlSink = {
        async write(record) { await Promise.all([loggers.decisions.write(record), captured.write(record)]); },
    };

    // AGENT_DIAGNOSTICS=0 skips the per-action file (largest one). Keep it on when debugging a run.
    const adapter = createLiveAdapter({ bot, sdk, resources, diagnostics: process.env.AGENT_DIAGNOSTICS === "0" ? nullSink : loggers.diagnostics });

    // The chop-bank target is fixed from the start state: "full" becomes the free slots now, and the goal text
    // and the completion check both use that same number.
    const startObs = CHOP_BANK || FLETCH_BANK ? await adapter.observe() : null;
    const chopTarget = CHOP_BANK && startObs ? resolveChopTarget(CHOP_SPEC, startObs) : null;
    // The bank is resolved in code, not by the model. Chopping banks the logs from the oak spot, so the bank nearest
    // that spot is used; fletching starts wherever the player is, so the nearest bank to the start is used.
    const bank = CHOP_BANK ? nearestBank(CHOP_SPOT) : FLETCH_BANK && startObs ? nearestBank(startObs.player) : null;
    if (bank) console.log(`Bank: ${bank.name} (x ${bank.x} z ${bank.z})`);
    const task = presetTask
        ?? (chopTarget != null ? chopBankGoal({ target: chopTarget, resource: TREE, bank: bank ?? undefined })
        : FLETCH_BANK ? fletchBankGoal({ logCount: LOG_COUNT, resource: TREE, bow: BOW, bank: bank ?? undefined })
        : SMELT_SITE ? mineSmeltGoal({ site: SMELT_SITE, bars: SMELT_BARS, template: process.env.AGENT_SMELT_GOAL || undefined, depleted: DEPLETED })
        : null);
    const GOAL = process.env.AGENT_GOAL ?? task!.goal;
    console.log(`Goal: ${GOAL}`);
    const result = await runController(adapter, policy, {
        goal: GOAL, maxSteps: MAX_STEPS, maxTicks: 3000,
        allowedActions: task?.allowedActions, allowedFor: task?.allowedFor, verifyDone: task?.verifyDone, hintFor: task?.hintFor, startCheck: task?.startCheck, safety: SAFETY,
        // AGENT_VIEW_GLOBAL=0 shows the model everything (A/B check of the global filter).
        view: { global: process.env.AGENT_VIEW_GLOBAL !== "0", task: task?.viewFilter },
    }, decisions);

    await loggers.episode.write(buildEpisodeRecord({
        runId: RUN_ID, startedAt, endedAt: new Date(), result,
        task: { id: task?.id ?? null, goal: GOAL, goalVersion: task?.id === "cow-hide-and-bones" ? (process.env.AGENT_GOAL_VERSION === "1" ? 1 : 2) : null, allowedActions: task?.allowedActions ?? null },
        agent: policy.describe(), safety: SAFETY,
    }));

    // Runs share the game account, so each run starts from whatever the last one left. Compare runs only when this matches.
    console.log(`\nStart inventory: ${(result.baseline?.inventory ?? []).map((i) => `${i.name} x${i.quantity}`).join(", ") || "empty"}`);
    console.log("\n--- CONTROLLER RESULT ---");
    console.log(JSON.stringify({
        stopReason: result.stopReason, detail: result.detail, steps: result.steps,
        goalMet: result.finalCheck ? result.finalCheck.done : null, safetyInterventions: result.safetyInterventions,
    }, null, 2));
    console.log("\n--- METRICS ---");
    console.log(formatMetrics(summarizeDecisions(captured.records)));
    return result.stopReason;
}, { timeout: 12 * 60_000 });
