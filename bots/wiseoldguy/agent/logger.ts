// Three JSONL streams, one record per line:
//   diagnostics - full before/after record for every action attempt
//   decisions   - one record per model turn (raw output, validation, result), plus safety overrides
//   episode     - ONE record per run: task, config, start/end state, stop reason, counts

import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export interface JsonlSink {
    write(record: unknown): Promise<void>;
}

export function fileSink(path: string): JsonlSink {
    let ready: Promise<unknown> | null = null;
    return {
        async write(record) {
            ready ??= mkdir(dirname(path), { recursive: true });
            await ready;
            await appendFile(path, JSON.stringify(record) + "\n", "utf8");
        },
    };
}

/** For tests: keeps records in memory. */
export function memorySink(): JsonlSink & { records: any[] } {
    const records: any[] = [];
    return { records, async write(record) { records.push(record); } };
}

export const nullSink: JsonlSink = { async write() {} };

/** Adds fixed fields (e.g. runId) to every record, so streams from one run can be joined later. */
export function tagSink(sink: JsonlSink, tags: Record<string, unknown>): JsonlSink {
    return {
        async write(record) {
            await sink.write(record && typeof record === "object" && !Array.isArray(record) ? { ...tags, ...(record as object) } : record);
        },
    };
}

export interface Loggers {
    diagnostics: JsonlSink;
    decisions: JsonlSink;
}

export interface RunLoggers extends Loggers {
    episode: JsonlSink;
}

/** One directory per run. With a runId, every record carries it. */
export function fileLoggers(dir: string, opts: { runId?: string } = {}): RunLoggers {
    const tag = (sink: JsonlSink) => (opts.runId ? tagSink(sink, { runId: opts.runId }) : sink);
    return {
        diagnostics: tag(fileSink(`${dir}/diagnostics.jsonl`)),
        decisions: tag(fileSink(`${dir}/decisions.jsonl`)),
        episode: fileSink(`${dir}/episode.jsonl`),
    };
}
