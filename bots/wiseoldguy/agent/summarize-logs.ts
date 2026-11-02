// Summarize one or more decisions.jsonl files (no game or model needed).
//   bun bots/wiseoldguy/agent/summarize-logs.ts bots/wiseoldguy/logs/phase2-fixed/decisions.jsonl

import { readFileSync } from "node:fs";
import { formatMetrics, summarizeDecisions } from "./metrics";

const files = process.argv.slice(2);
if (!files.length) {
    console.error("usage: bun summarize-logs.ts <decisions.jsonl> [more.jsonl ...]");
    process.exit(2);
}
const records = files.flatMap((f) =>
    readFileSync(f, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l)),
);
console.log(formatMetrics(summarizeDecisions(records)));
