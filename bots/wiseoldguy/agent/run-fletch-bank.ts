// Phase 3 step 6a live run: the fixed bank -> fletch -> bank routine on the real SDK. No model involved.
//
// Run from the rs-sdk project root (lite client must already be running):
//   bun --env-file=.\bots\wiseoldguy\.env .\bots\wiseoldguy\agent\run-fletch-bank.ts
// Needs: a knife in the pack, Fletching 20+, and oak logs in the Varrock west bank.

import { runScript } from "../../../sdk/runner";
import { runFletchBank, liveOps, DEFAULT_LOGS } from "./fletchBank";
import { makeRunId } from "./episode";

const LOG_DIR = process.env.AGENT_LOG_DIR ?? "bots/wiseoldguy/logs/fletch-bank";

await runScript(async ({ bot, sdk }) => {
    const runId = makeRunId(new Date());
    const ops = liveOps({ bot, sdk, logDir: LOG_DIR, runId });
    const result = await runFletchBank(ops, { targetLogs: DEFAULT_LOGS, runId });

    console.log("\n--- BANK -> FLETCH -> BANK RESULT ---");
    console.log(JSON.stringify(result, null, 2));
    console.log(`Run ${runId}. Logs: ${LOG_DIR}/decisions.jsonl, episode.jsonl`);
    return result.stopReason;
}, { timeout: 8 * 60_000 });
