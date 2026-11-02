// Print one table from several eval result files (what run-evals.ts wrote).
// Run from the rs-sdk project root:
//   bun .\bots\wiseoldguy\agent\compare-evals.ts                       (all files in bots\wiseoldguy\logs\evals)
//   bun .\bots\wiseoldguy\agent\compare-evals.ts a.json b.json         (just these)
//   bun .\bots\wiseoldguy\agent\compare-evals.ts --split dev           (only dev-set cases)
//
// "NEVER" in the last column = no run in any file passed that case: a systematic failure, not noise.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { formatComparison, type EvalFile } from "./evalReport";

const args = process.argv.slice(2);
let split: string | undefined;
const paths: string[] = [];
for (let i = 0; i < args.length; i++) {
    if (args[i] === "--split") split = args[++i];
    else paths.push(args[i]);
}

const DEFAULT_DIR = "bots/wiseoldguy/logs/evals";
const files = paths.length
    ? paths
    : readdirSync(DEFAULT_DIR).filter((f) => f.endsWith(".json")).map((f) => join(DEFAULT_DIR, f));

const loaded = files
    .filter((p) => statSync(p).isFile())
    .map((p) => ({ path: p, file: JSON.parse(readFileSync(p, "utf8")) as EvalFile }))
    .filter((x) => Array.isArray(x.file.results))
    // oldest first, so columns read in the order the runs were made
    .sort((a, b) => (a.file.startedAt ?? a.path).localeCompare(b.file.startedAt ?? b.path));

console.log(formatComparison(loaded, { split }));
