// Replay logged diagnostics records through the CURRENT code and compare with what was logged.
// Pure: no game, no model. It answers "if I change classify/validate/view, which past
// decisions change?"
//
//  - classification: classifyOutcome(resolved, before, after, result, messages) is deterministic
//    given a record, so it replays for every log version.
//  - validation: needs the exact view/handles the model saw. Log schema v4 records them; older
//    records cannot be replayed faithfully (handles are rebuilt per turn), so they are `skipped`.

import { classifyOutcome } from "./classify";
import { validateAction, validateSchema } from "./validate";

export type ReplayKind = "same" | "changed" | "skipped";

export interface Outcome { status: string; reason: string }

export interface ReplayRow {
    key: string;
    step: number | null;
    action: unknown;
    kind: ReplayKind;
    logged: Outcome;
    replayed: Outcome | null;
    note?: string;
}

const stable = (v: unknown): string =>
    JSON.stringify(v, (_k, val) =>
        val && typeof val === "object" && !Array.isArray(val)
            ? Object.fromEntries(Object.entries(val as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)))
            : val);

export const sameJson = (a: unknown, b: unknown) => stable(a) === stable(b);

export function replayRecord(rec: any, key: string): ReplayRow {
    const logged: Outcome = { status: rec.classification?.outcome ?? "?", reason: rec.classification?.reason ?? "?" };
    const make = (kind: ReplayKind, replayed: Outcome | null, note?: string): ReplayRow => ({
        key, step: rec.step ?? null, action: rec.modelAction, kind, logged, replayed, ...(note ? { note } : {}),
    });
    const compare = (replayed: Outcome, note?: string) =>
        make(replayed.status === logged.status && replayed.reason === logged.reason ? "same" : "changed", replayed, note);

    const hasCtx = Boolean(rec.view && rec.handles);
    const validate = () =>
        validateAction(rec.modelAction, { view: rec.view, handles: rec.handles }, rec.before, { allowed: rec.allowed ?? undefined });

    // 1. The action was rejected before reaching the SDK.
    if (logged.status === "not_executed") {
        if (!hasCtx) return make("skipped", null, "legacy log: the view the model saw was not recorded");
        if (logged.reason === "no_path") return make("skipped", null, "path check depends on the live map");
        const v = validate();
        return compare(v.ok ? { status: "validated_ok", reason: "ok" } : { status: "not_executed", reason: v.code });
    }

    // 2. stop is a controller signal; only its schema can change.
    if (rec.resolved?.type === "stop") {
        const s = validateSchema(rec.modelAction);
        return s.ok ? compare({ status: "confirmed_success", reason: "stop_requested" })
                    : make("changed", { status: "not_executed", reason: s.code }, "stop no longer passes the schema");
    }

    // 3. Executed: validation (v4 only) must still resolve to the same action...
    if (hasCtx) {
        const v = validate();
        if (!v.ok) return make("changed", { status: "not_executed", reason: v.code }, "would now be rejected by validation");
        if (!sameJson(v.action, rec.resolved)) return make("changed", null, "validation now resolves a different action");
    }

    // ...and the outcome must classify the same way.
    const c = classifyOutcome(rec.resolved, rec.before, rec.after, rec.result, rec.messages ?? []);
    return compare({ status: c.outcome, reason: c.reason });
}

export function parseJsonl(text: string): any[] {
    return text.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
}

/** `label` prefixes each key, e.g. "model-empty-pen-a#3". Keys use 1-based record numbers. */
export function replayRecords(records: any[], label: string): ReplayRow[] {
    return records.map((rec, i) => replayRecord(rec, `${label}#${i + 1}`));
}

export function summarizeReplay(rows: ReplayRow[]) {
    const count = (k: ReplayKind) => rows.filter((r) => r.kind === k).length;
    return { total: rows.length, same: count("same"), changed: count("changed"), skipped: count("skipped") };
}

export function formatReplay(rows: ReplayRow[], opts: { all?: boolean } = {}): string {
    const out: string[] = [];
    for (const r of rows) {
        if (!opts.all && r.kind === "same") continue;
        const a = JSON.stringify(r.action);
        const was = `${r.logged.status}/${r.logged.reason}`;
        const now = r.replayed ? `${r.replayed.status}/${r.replayed.reason}` : "n/a";
        out.push(`${r.kind.toUpperCase().padEnd(7)} ${r.key} ${a}\n         logged ${was}  ->  now ${now}${r.note ? `  (${r.note})` : ""}`);
    }
    const s = summarizeReplay(rows);
    out.push(`${s.total} records: ${s.same} same, ${s.changed} changed, ${s.skipped} skipped`);
    return out.join("\n");
}
