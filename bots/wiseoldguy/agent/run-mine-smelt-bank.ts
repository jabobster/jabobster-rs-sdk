// Phase 3 step 6 live run: the fixed mine -> smelt -> bank routine on the real SDK. No model involved.
//
// Pick the site with AGENT_SMELT_SITE: falador-bronze (default) or ardougne-iron.
//
// Run from the rs-sdk project root (lite client must already be running):
//   bun --env-file=.\bots\wiseoldguy\.env .\bots\wiseoldguy\agent\run-mine-smelt-bank.ts

import { runScript } from "../../../sdk/runner";
import { runMineSmeltBank, liveMineSmeltOps, DEFAULT_PAIRS, SITES, FALADOR_BRONZE } from "./mineSmelt";
import { makeRunId } from "./episode";

const LOG_DIR = process.env.AGENT_LOG_DIR ?? "bots/wiseoldguy/logs/mine-smelt-bank";
const siteId = (process.env.AGENT_SMELT_SITE ?? FALADOR_BRONZE.id).trim().toLowerCase();
const site = SITES[siteId];
if (!site) throw new Error(`AGENT_SMELT_SITE must be one of ${Object.keys(SITES).join(", ")}, got "${siteId}"`);

await runScript(async ({ bot, sdk }) => {
    const startedAt = new Date();
    const runId = makeRunId(startedAt);
    const ops = liveMineSmeltOps({ bot, sdk, logDir: LOG_DIR, runId });
    const result = await runMineSmeltBank(ops, { site, pairs: DEFAULT_PAIRS, runId });

    console.log(`\n--- MINE -> SMELT -> BANK RESULT (${site.id}) ---`);
    console.log(JSON.stringify(result, null, 2));
    console.log(`Run ${runId}. Logs: ${LOG_DIR}/decisions.jsonl, episode.jsonl`);
    return result.stopReason;
}, { timeout: 12 * 60_000 });
