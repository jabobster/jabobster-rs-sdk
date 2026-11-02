import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runController } from "../controller";
import { buildEpisodeRecord, makeRunId, summarizeState } from "../episode";
import { cowGoal } from "../goals";
import { cowPolicy } from "../fixedPolicies";
import { fileLoggers, memorySink, tagSink } from "../logger";
import { createLiveAdapter } from "../runAction";
import { makeObs } from "./helpers";
import { cow, createFakeGame } from "./fakeGame";

describe("run ids", () => {
    test("sortable, unique-ish, and filename safe", () => {
        const a = makeRunId(new Date("2026-10-29T18:43:40.123Z"), () => 0.5);
        expect(a).toBe("2026-10-29T18-43-40Z-7fff");
        expect(makeRunId(new Date("2026-10-29T18:43:41Z"), () => 0.1) > a).toBe(true);
        expect(a).toMatch(/^[\w-]+$/);
    });
});

describe("tagSink", () => {
    test("adds the tags, never overwrites the record's own fields", async () => {
        const inner = memorySink();
        const s = tagSink(inner, { runId: "r1", step: "tag" });
        await s.write({ step: 3, x: 1 });
        expect(inner.records).toEqual([{ runId: "r1", step: 3, x: 1 }]);
    });

    test("fileLoggers tag decisions and diagnostics with the run id, in three separate files", async () => {
        const dir = mkdtempSync(join(tmpdir(), "agent-logs-"));
        try {
            const l = fileLoggers(dir, { runId: "run-42" });
            await l.decisions.write({ a: 1 });
            await l.diagnostics.write({ b: 2 });
            await l.episode.write({ kind: "episode" });
            const line = (f: string) => JSON.parse(readFileSync(join(dir, f), "utf8").trim());
            expect(line("decisions.jsonl")).toEqual({ runId: "run-42", a: 1 });
            expect(line("diagnostics.jsonl")).toEqual({ runId: "run-42", b: 2 });
            expect(line("episode.jsonl")).toEqual({ kind: "episode" });   // the episode record carries its own runId
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe("state summary", () => {
    test("compact: merged inventory counts and entity counts, no handles or coordinates of npcs", () => {
        const s = summarizeState(makeObs({
            inventory: [{ slot: 0, id: 1, name: "Bones", quantity: 1 }, { slot: 1, id: 1, name: "Bones", quantity: 2 }],
        }))!;
        expect(s.inventory).toEqual({ Bones: 3 });
        expect(s).toMatchObject({ hp: 10, maxHp: 10, npcsNearby: 0, groundItemsNearby: 0 });
        expect(summarizeState(null)).toBeNull();
    });
});

describe("episode record", () => {
    async function runCow(over: { stray?: boolean } = {}) {
        const game = createFakeGame({ npcs: [cow()], inv: over.stray ? [{ id: 1739, name: "Cowhide", count: 1 }, { id: 526, name: "Bones", count: 1 }] : [] });
        const adapter = createLiveAdapter({ bot: game.bot, sdk: game.sdk });
        const task = cowGoal(2);
        const result = await runController(adapter, cowPolicy(), { goal: task.goal, verifyDone: task.verifyDone, maxSteps: 20 });
        return { game, result, task };
    }

    test("describes a successful run", async () => {
        const { result, task } = await runCow();
        const rec = buildEpisodeRecord({
            runId: "r1", startedAt: new Date("2026-10-29T10:00:00Z"), endedAt: new Date("2026-10-29T10:00:05Z"),
            task: { goal: task.goal, goalVersion: 2, allowedActions: task.allowedActions },
            agent: { kind: "fixed", policy: "cowPolicy" }, result,
        });
        expect(rec).toMatchObject({
            kind: "episode", runId: "r1", durationMs: 5000, stopReason: "goal_met", goalMet: true, goalMissing: null,
            safetyInterventions: {},
        });
        expect(rec.start!.inventory).toEqual({});
        expect(rec.end!.inventory).toEqual({ Bones: 1, Cowhide: 1 });
        expect(rec.counts.byAction).toMatchObject({ attack: 1, pickup: 2, wait: 2 });
        expect(rec.counts.safetySteps).toBe(0);
        expect(rec.counts.modelSteps).toBe(rec.steps);
        expect(JSON.parse(JSON.stringify(rec))).toEqual(rec);          // plain JSON
    });

    test("goalMet reflects the game state, not the stop reason", async () => {
        const game = createFakeGame({ npcs: [cow()] });
        const adapter = createLiveAdapter({ bot: game.bot, sdk: game.sdk });
        const task = cowGoal(2);
        const { FixedPolicy } = await import("../policy");
        const result = await runController(adapter, new FixedPolicy(() => ({ type: "stop", outcome: "blocked" })),
            { goal: task.goal, verifyDone: task.verifyDone });
        const rec = buildEpisodeRecord({ runId: "r2", startedAt: new Date(), endedAt: new Date(), task: { goal: task.goal }, agent: {}, result });
        expect(rec.stopReason).toBe("model_blocked");
        expect(rec.goalMet).toBe(false);
        expect(rec.goalMissing).toContain("Cowhide");
    });

    test("goalMet is null when the task has no completion check", async () => {
        const game = createFakeGame();
        const adapter = createLiveAdapter({ bot: game.bot, sdk: game.sdk });
        const { FixedPolicy } = await import("../policy");
        const result = await runController(adapter, new FixedPolicy(() => ({ type: "stop", outcome: "done" })), { goal: "g" });
        expect(buildEpisodeRecord({ runId: "r3", startedAt: new Date(), endedAt: new Date(), task: { goal: "g" }, agent: {}, result }).goalMet).toBeNull();
    });

    test("safety turns are counted apart from model turns", async () => {
        const game = createFakeGame({ npcs: [cow(5, { hp: 100 })] });
        game.world.onTick.push(() => { if (game.world.player.combat.inCombat) game.world.player.hp = Math.max(1, game.world.player.hp - 1); });
        const adapter = createLiveAdapter({ bot: game.bot, sdk: game.sdk });
        const { FixedPolicy } = await import("../policy");
        const policy = new FixedPolicy((i) => (i.view.player.combat === "idle" ? { type: "attack", target: "n1" } : { type: "wait", ticks: 2 }));
        const result = await runController(adapter, policy, { goal: "g", maxSteps: 20 });
        const rec = buildEpisodeRecord({ runId: "r4", startedAt: new Date(), endedAt: new Date(), task: { goal: "g" }, agent: {}, result });
        expect(rec.stopReason).toBe("safety_low_hp");
        expect(rec.counts.safetySteps).toBe(1);
        expect(rec.counts.modelSteps).toBe(rec.steps - 1);
        expect(rec.safetyInterventions).toEqual({ low_hp_flee: 1 });
    });
});
