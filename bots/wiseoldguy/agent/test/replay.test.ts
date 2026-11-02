import { describe, expect, test } from "bun:test";
import { LOG_SCHEMA_VERSION } from "../contract";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runController } from "../controller";
import { memorySink } from "../logger";
import { FixedPolicy } from "../policy";
import { parseJsonl, replayRecord, replayRecords, summarizeReplay } from "../replay";
import { createLiveAdapter } from "../runAction";
import { cow, createFakeGame } from "./fakeGame";

const FIXTURES = join(import.meta.dir, "fixtures");
const diagnosticsFiles = readdirSync(FIXTURES).filter((f) => f.endsWith(".diagnostics.jsonl")).sort();

const loadRows = () =>
    diagnosticsFiles.flatMap((f) =>
        replayRecords(parseJsonl(readFileSync(join(FIXTURES, f), "utf8")), f.replace(/\.jsonl$/, "")));

// Every difference between a logged outcome and today's code must be listed and explained here.
// A new unexplained change fails the test; so does an entry that no longer differs.
const KNOWN_CHANGES: Record<string, { now: string; why: string }> = {
    "fixed-policy.diagnostics#34": {
        now: "unconfirmed/state_and_message_conflict",
        why: "Combat state flipped on, but the game said 'Someone else is fighting that.' and the fight was gone two ticks later. " +
             "It was logged as success; it is now reported as a conflict instead of a win.",
    },
};

// Old logs that cannot be replayed faithfully because they did not record the view the model saw.
const KNOWN_SKIPPED = ["model-crowded.diagnostics#8", "model-crowded.diagnostics#14"];

describe("replay of your real logs", () => {
    const rows = loadRows();

    test("fixtures are present", () => {
        expect(diagnosticsFiles.length).toBe(4);
        expect(rows.length).toBe(74);
    });

    test("every changed outcome is a known, explained change", () => {
        const changed = rows.filter((r) => r.kind === "changed");
        const unexplained = changed.filter((r) => !KNOWN_CHANGES[r.key]).map((r) => `${r.key} ${r.logged.status}/${r.logged.reason} -> ${r.replayed?.status}/${r.replayed?.reason}`);
        expect(unexplained).toEqual([]);

        for (const [key, k] of Object.entries(KNOWN_CHANGES)) {
            const row = changed.find((r) => r.key === key);
            expect(row, `${key} no longer changes; remove it from KNOWN_CHANGES`).toBeDefined();
            expect(`${row!.replayed?.status}/${row!.replayed?.reason}`).toBe(k.now);
        }
    });

    test("only the known legacy records are skipped", () => {
        expect(rows.filter((r) => r.kind === "skipped").map((r) => r.key)).toEqual(KNOWN_SKIPPED);
    });
});

describe("log schema v4 round trip (controller -> diagnostics -> replay)", () => {
    async function recordRun() {
        const game = createFakeGame({ npcs: [cow(5), cow(6)] });
        const diagnostics = memorySink();
        const adapter = createLiveAdapter({ bot: game.bot, sdk: game.sdk, diagnostics });
        let call = 0;
        const policy = new FixedPolicy(({ view }) => {
            switch (call++) {
                case 0: return { type: "attack", target: "n9" };                       // unknown handle
                case 1:                                                                // handle goes stale before dispatch
                    game.world.npcs = game.world.npcs.filter((n) => n.index !== 5);
                    return { type: "attack", target: "n1" };
                case 2: return { type: "attack", target: view.npcs[0].h };
                case 3: return { type: "wait", ticks: 3 };
                case 4: case 5: return { type: "pickup", target: view.items[0].h };
                default: return { type: "stop", outcome: "done" };
            }
        });
        const result = await runController(adapter, policy, { goal: "g", allowedActions: ["attack", "pickup", "wait"] });
        return { records: diagnostics.records, result };
    }

    test("records carry step, view, handles and allowed", async () => {
        const { records } = await recordRun();
        expect(records.every((r) => r.schemaVersion === LOG_SCHEMA_VERSION && r.view && r.handles)).toBe(true);
        expect(records.map((r) => r.step)).toEqual([1, 1, 2, 3, 4, 5, 6]);
        expect(records[0].allowed).toEqual(["attack", "pickup", "wait"]);
    });

    test("the run is as designed", async () => {
        const { records, result } = await recordRun();
        expect(result.stopReason).toBe("model_done");
        expect(records.filter((r) => r.classification.outcome === "not_executed").map((r) => r.classification.reason)).toEqual(["unknown_handle", "target_gone"]);
    });

    test("replaying it through today's code changes nothing and skips nothing", async () => {
        const { records } = await recordRun();
        const rows = replayRecords(JSON.parse(JSON.stringify(records)), "run");
        expect(rows.filter((r) => r.kind !== "same")).toEqual([]);
        expect(summarizeReplay(rows)).toMatchObject({ total: 7, same: 7, changed: 0, skipped: 0 });
    });

    test("tampering is detected: a different resolved action", async () => {
        const { records } = await recordRun();
        const pickup = JSON.parse(JSON.stringify(records.find((r) => r.resolved?.type === "pickup")));
        pickup.resolved.item.id = 999;
        const row = replayRecord(pickup, "t");
        expect(row.kind).toBe("changed");
        expect(row.note).toContain("different action");
    });

    test("tampering is detected: a rejection that would now be accepted", async () => {
        const { records } = await recordRun();
        const rejected = JSON.parse(JSON.stringify(records.find((r) => r.classification.reason === "target_gone")));
        // pretend the cow had still been there: validation would now accept the action
        rejected.before.nearbyNpcs = rejected.view.npcs.map((n: any) => ({
            index: rejected.handles.npcs[n.h].index, id: 1, name: n.name, x: 0, z: 0, distance: n.dist, reachable: true, inCombat: false, options: n.options,
        }));
        const row = replayRecord(rejected, "t");
        expect(row.kind).toBe("changed");
        expect(row.replayed?.status).toBe("validated_ok");
    });

    test("tampering is detected: an outcome that classifies differently", async () => {
        const { records } = await recordRun();
        const waited = JSON.parse(JSON.stringify(records.find((r) => r.resolved?.type === "wait")));
        waited.after.tick = waited.before.tick; // no time passed -> no longer 'waited'
        expect(replayRecord(waited, "t").kind).toBe("changed");
    });
});
