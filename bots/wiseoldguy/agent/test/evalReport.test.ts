import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { CASES } from "../evalCases";
import { buildEvalFile, columnLabel, evalFileName, formatComparison, type EvalFile } from "../evalReport";

const DIR = join(import.meta.dir, "fixtures", "evals");
const load = (name: string) => JSON.parse(readFileSync(join(DIR, name), "utf8")) as EvalFile;
const names = readdirSync(DIR).filter((f) => f.endsWith(".json")).sort();

describe("eval cases", () => {
    test("every case belongs to a split, and the current nine are the dev set", () => {
        expect(CASES.every((c) => c.split === "dev" || c.split === "frozen")).toBe(true);
        expect(CASES.filter((c) => c.split === "dev")).toHaveLength(9);
        expect(new Set(CASES.map((c) => c.id)).size).toBe(CASES.length);
    });
});

describe("result files", () => {
    const config = { model: "qwen3.5-4b", goalVersion: 2, thinking: false, temperature: 0.4, runs: 5 };

    test("the file name carries every setting that changes results", () => {
        const at = new Date("2026-10-29T18:43:40.123Z");
        expect(evalFileName(config, at)).toBe("qwen3.5-4b-v2-t0.4-r5-nothink-2026-10-29T18-43-40Z.json");
        expect(evalFileName({ ...config, thinking: true, model: "org/Some Model" }, at)).toContain("org_Some_Model-v2-t0.4-r5-think-");
    });

    test("built files record config, splits, summary, and a run id", () => {
        const results = [{ id: "a", runs: 2, pass: 1, wrong: 1, invalid: 0, outputs: [] }];
        const f = buildEvalFile({ runId: "r", startedAt: new Date("2026-01-01T00:00:00Z"), config, goal: "g", results, caseSplits: { a: "dev" }, stats: { calls: 2, promptTokens: 1, completionTokens: 1, totalLatencyMs: 10 } });
        expect(f).toMatchObject({ fileVersion: 2, runId: "r", model: "qwen3.5-4b", goalVersion: 2, config, caseSplits: { a: "dev" }, summary: { runs: 2, pass: 1 } });
        expect(columnLabel(f)).toBe("qwen3.5-4b v2 t0.4 x5 nothink");
    });

    test("files from before the config was recorded are labelled honestly as unknown", () => {
        expect(columnLabel(load(names[0]))).toContain("think?");
        expect(columnLabel(load(names[0]))).toContain("t?");
    });
});

describe("comparison table over the real result files", () => {
    const all = names.map((n) => ({ file: load(n) }));
    const table = formatComparison(all);
    const row = (id: string) => table.split("\n").find((l) => l.startsWith(id))!;

    test("one column per file and one row per case, with an all-runs total", () => {
        expect(names).toHaveLength(8);
        for (const c of CASES) expect(row(c.id)).toBeTruthy();
        expect(table).toContain("[8]");
        expect(table).toContain("pass rate");
    });

    test("systematic failures are marked NEVER; stable successes always; the rest mixed", () => {
        expect(row("busy_cow_nearest")).toMatch(/0\/24\s+NEVER/);
        expect(row("no_cow_nearby")).toMatch(/24\/24\s+always/);
        expect(row("bones_taken_hide_still_on_ground")).toMatch(/1\/24\s+mixed/);
    });

    test("invalid replies are visible per cell and per column", () => {
        expect(table).toMatch(/0\/5 \(5 inv\)/);
        expect(row("invalid")).toMatch(/7/);
    });

    test("pass rates and latency match the files", () => {
        const rates = row("pass rate").trim().split(/\s+/).slice(2);
        expect(rates).toEqual(["22%", "22%", "78%", "78%", "53%", "76%", "67%", "69%"]);
        expect(row("ms/call")).toMatch(/108\s+135\s+249/);
    });

    test("a split filter hides cases from other splits; empty input is handled", () => {
        const withSplit = all.map(({ file }) => ({ file: { ...file, caseSplits: { fresh_start: "frozen" } } }));
        const filtered = formatComparison(withSplit, { split: "frozen" });
        expect(filtered).toContain("fresh_start");
        expect(filtered).not.toContain("busy_cow_nearest");
        expect(formatComparison([])).toBe("No result files.");
    });
});
