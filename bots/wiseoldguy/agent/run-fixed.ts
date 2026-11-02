// Live smoke run: the deterministic cow policy drives the real SDK through the
// Phase 2 controller. No model involved; this validates the contract itself.
//
// Run from the rs-sdk project root (lite client must already be running):
//   bun --env-file=.\bots\wiseoldguy\.env .\bots\wiseoldguy\agent\run-fixed.ts

import { runScript } from "../../../sdk/runner";
import { runController } from "./controller";
import { cowPolicy } from "./fixedPolicies";
import { buildEpisodeRecord, makeRunId } from "./episode";
import { cowGoal } from "./goals";
import { fileLoggers, nullSink } from "./logger";
import { safetyFromEnv } from "./safety";
import { createLiveAdapter } from "./runAction";

const GOAL = "Kill a cow, then pick up its cowhide and bones.";
const LOG_DIR = process.env.AGENT_LOG_DIR ?? "bots/wiseoldguy/logs/phase2-fixed";
const SAFETY = safetyFromEnv(process.env);   // same AGENT_SAFETY / AGENT_LOW_HP / ... variables as run-model.ts

await runScript(async ({ bot, sdk }) => {
    const startedAt = new Date();
    const runId = makeRunId(startedAt);
    const task = cowGoal(2);
    const loggers = fileLoggers(LOG_DIR, { runId });
    const adapter = createLiveAdapter({ bot, sdk, diagnostics: process.env.AGENT_DIAGNOSTICS === "0" ? nullSink : loggers.diagnostics });

    const result = await runController(
        adapter,
        cowPolicy(),
        { goal: GOAL, maxSteps: 25, maxTicks: 1500, verifyDone: task.verifyDone, hintFor: task.hintFor, startCheck: task.startCheck, safety: SAFETY,
          view: { global: process.env.AGENT_VIEW_GLOBAL !== "0", task: task.viewFilter } },
        loggers.decisions,
    );
    await loggers.episode.write(buildEpisodeRecord({
        runId, startedAt, endedAt: new Date(), result,
        task: { id: task.id, goal: GOAL, goalVersion: 2, allowedActions: null },
        agent: { kind: "fixed", policy: "cowPolicy" }, safety: SAFETY,
    }));

    // Runs share the game account, so each run starts from whatever the last one left. Compare runs only when this matches.
    console.log(`\nStart inventory: ${(result.baseline?.inventory ?? []).map((i) => `${i.name} x${i.quantity}`).join(", ") || "empty"}`);
    console.log("\n--- CONTROLLER RESULT ---");
    console.log(JSON.stringify({ stopReason: result.stopReason, detail: result.detail, steps: result.steps, goalMet: result.finalCheck?.done ?? null, safetyInterventions: result.safetyInterventions, history: result.history }, null, 2));
    console.log(`Run ${runId}. Logs: ${LOG_DIR}/diagnostics.jsonl, decisions.jsonl, episode.jsonl`);
    return result.stopReason;
}, { timeout: 6 * 60_000 });
