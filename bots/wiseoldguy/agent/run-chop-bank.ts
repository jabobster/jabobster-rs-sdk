// Phase 3 step 5a live run: the fixed chop -> bank routine on the real SDK. No model involved.
//
// Run from the rs-sdk project root (lite client must already be running):
//   bun --env-file=.\bots\wiseoldguy\.env .\bots\wiseoldguy\agent\run-chop-bank.ts

import { runScript } from "../../../sdk/runner";
import { runChopBank, liveOps, DEFAULT_TARGET_LOGS } from "./chopBank";
import { makeRunId } from "./episode";

const LOG_DIR = process.env.AGENT_LOG_DIR ?? "bots/wiseoldguy/logs/chop-bank";

await runScript(async ({ bot, sdk }) => {
    const startedAt = new Date();
    const runId = makeRunId(startedAt);
    const ops = liveOps({ bot, sdk, logDir: LOG_DIR, runId });
    const result = await runChopBank(ops, { targetLogs: DEFAULT_TARGET_LOGS, runId });

    console.log("\n--- CHOP -> BANK RESULT ---");
    console.log(JSON.stringify(result, null, 2));
    console.log(`Run ${runId}. Logs: ${LOG_DIR}/decisions.jsonl, episode.jsonl`);
    return result.stopReason;
}, { timeout: 8 * 60_000 });
