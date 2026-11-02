// Replay diagnostics logs through the current code (no game, no model needed).
//   bun bots/wiseoldguy/agent/replay-logs.ts <diagnostics.jsonl> [more.jsonl ...] [--all]
// Exit code 1 if any record's outcome changed, so it can gate a change.

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { formatReplay, parseJsonl, replayRecords, summarizeReplay, type ReplayRow } from "./replay";

const args = process.argv.slice(2);
const all = args.includes("--all");
const files = args.filter((a) => !a.startsWith("--"));
if (!files.length) {
    console.error("usage: bun replay-logs.ts <diagnostics.jsonl> [more.jsonl ...] [--all]");
    process.exit(2);
}

const rows: ReplayRow[] = files.flatMap((f) => replayRecords(parseJsonl(readFileSync(f, "utf8")), basename(f).replace(/\.jsonl$/, "")));
console.log(formatReplay(rows, { all }));
process.exit(summarizeReplay(rows).changed > 0 ? 1 : 0);
