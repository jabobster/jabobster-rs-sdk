import { describe, expect, test } from "bun:test";
import { runController } from "../controller";
import { cowPolicy } from "../fixedPolicies";
import { cowGoal, combatStartCheck } from "../goals";
import { memorySink } from "../logger";
import { buildEpisodeRecord } from "../episode";
import { FixedPolicy } from "../policy";
import { createLiveAdapter } from "../runAction";
import { cow, createFakeGame } from "./fakeGame";
import { makeObs, npc } from "./helpers";

const task = cowGoal(2);
const cowObs = (over: Parameters<typeof makeObs>[0] = {}) =>
    makeObs({ nearbyNpcs: [npc(5, "Cow", { x: 3203 })], ...over });

describe("cow task start check", () => {
    test("a clean start passes with no problems", () => {
        const r = task.startCheck!(cowObs());
        expect(r).toEqual({ ok: true, warnings: [] });
    });

    test("blocks: no cow nearby, low HP, dialog open, shop open, already fighting", () => {
        const cases: [string, Parameters<typeof makeObs>[0], RegExp][] = [
            ["no cow", { nearbyNpcs: [npc(5, "Farmer")] }, /no matching target/],
            ["low hp", { player: { ...makeObs().player, hp: 2, maxHp: 10 }, nearbyNpcs: [npc(5, "Cow")] }, /HP 2\/10 is low/],
            ["dialog", { dialog: { isOpen: true, isWaiting: false, pageId: "p", text: "hi", options: [] }, nearbyNpcs: [npc(5, "Cow")] }, /dialog is open/],
            ["shop", { shopOpen: true, nearbyNpcs: [npc(5, "Cow")] }, /shop, bank or interface/],
            ["fighting", { player: { ...makeObs().player, combat: { inCombat: true, targetIndex: 5, targetType: "npc" } }, nearbyNpcs: [npc(5, "Cow")] }, /already fighting/],
        ];
        for (const [, over, msg] of cases) {
            const r = task.startCheck!(makeObs(over));
            expect(r.ok, JSON.stringify(over)).toBe(false);
            if (!r.ok) expect(r.problems.join(" | ")).toMatch(msg);
        }
    });

    test("every cow already in combat blocks; one free cow is enough", () => {
        const busy = makeObs({ nearbyNpcs: [npc(5, "Cow", { inCombat: true }), npc(6, "Cow", { inCombat: true })] });
        expect(task.startCheck!(busy).ok).toBe(false);
        const oneFree = makeObs({ nearbyNpcs: [npc(5, "Cow", { inCombat: true }), npc(6, "Cow", { inCombat: false })] });
        expect(task.startCheck!(oneFree).ok).toBe(true);
    });

    test("a full inventory blocks: there would be no room for the drops", () => {
        const full = makeObs({
            nearbyNpcs: [npc(5, "Cow")],
            inventory: Array.from({ length: 28 }, (_, i) => ({ slot: i, id: 1000 + i, name: `Junk ${i}`, quantity: 1 })),
        });
        expect(task.startCheck!(full).ok).toBe(false);
    });

    test("carried loot is a warning, not a block; it is what made earlier runs say done too early", () => {
        const r = task.startCheck!(cowObs({
            inventory: [
                { slot: 0, id: 1739, name: "Cowhide", quantity: 3 },
                { slot: 1, id: 526, name: "Bones", quantity: 11 },
            ],
        }));
        expect(r.ok).toBe(true);
        expect(r.warnings).toEqual([
            "already carrying 3 Cowhide: carried items do not count toward the goal",
            "already carrying 11 Bones: carried items do not count toward the goal",
        ]);
    });

    test("combatStartCheck is reusable for other combat tasks with a different target", () => {
        const goblin = makeObs({ nearbyNpcs: [npc(5, "Goblin")] });
        expect(combatStartCheck(goblin, { targetName: /^goblin$/i }).ok).toBe(true);
        expect(combatStartCheck(goblin, { targetName: /^cow$/i }).ok).toBe(false);
    });
});

describe("start check inside the controller", () => {
    test("a failing start check ends the run before any action reaches the game", async () => {
        const game = createFakeGame({ npcs: [] });                    // no cow in view
        const decisions = memorySink();
        const adapter = createLiveAdapter({ bot: game.bot, sdk: game.sdk, diagnostics: memorySink() });
        const policy = new FixedPolicy(() => ({ type: "attack", target: "n1" }));
        const r = await runController(adapter, policy,
            { goal: task.goal, startCheck: task.startCheck, verifyDone: task.verifyDone }, decisions);

        expect(r.stopReason).toBe("start_check_failed");
        expect(r.steps).toBe(0);
        expect(game.world.calls).toEqual([]);
        expect(r.startCheck).toMatchObject({ ok: false });
        expect(decisions.records).toEqual([
            expect.objectContaining({ kind: "start_check", ok: false, problems: ["no matching target is nearby"] }),
        ]);
        expect(r.detail).toContain("no matching target");
    });

    test("a passing start check lets the run go ahead, and warnings are logged", async () => {
        const game = createFakeGame({ npcs: [cow()], inv: [{ id: 1739, name: "Cowhide", count: 1 }] });
        const decisions = memorySink();
        const adapter = createLiveAdapter({ bot: game.bot, sdk: game.sdk, diagnostics: memorySink() });
        const r = await runController(adapter, cowPolicy(),
            { goal: task.goal, startCheck: task.startCheck, verifyDone: task.verifyDone, maxSteps: 20 }, decisions);

        expect(r.stopReason).toBe("goal_met");
        expect(decisions.records[0]).toMatchObject({ kind: "start_check", ok: true });
        expect(decisions.records[0].warnings).toHaveLength(1);
        expect(r.startCheck).toMatchObject({ ok: true });
    });

    test("with stray loot carried, the goal check still refuses a 'done' that has nothing new on the ground", async () => {
        // Stray Cowhide and Bones already in the pack, no drops at all: the baseline already holds them.
        const game = createFakeGame({
            npcs: [cow(5, { drops: [] })],
            inv: [{ id: 1739, name: "Cowhide", count: 3 }, { id: 526, name: "Bones", count: 11 }],
        });
        const adapter = createLiveAdapter({ bot: game.bot, sdk: game.sdk, diagnostics: memorySink() });
        const r = await runController(adapter, new FixedPolicy(() => ({ type: "stop", outcome: "done" })),
            { goal: task.goal, startCheck: task.startCheck, verifyDone: task.verifyDone, maxSteps: 3 }, memorySink());
        expect(r.stopReason).toBe("invalid_streak");
        expect(r.detail).toContain("goal_not_met");
    });
});

describe("episode records use the start check", () => {
    test("a failed start is marked invalid; a passing run is valid and carries the task id", async () => {
        const game = createFakeGame({ npcs: [] });
        const adapter = createLiveAdapter({ bot: game.bot, sdk: game.sdk, diagnostics: memorySink() });
        const failed = await runController(adapter, new FixedPolicy(() => ({ type: "wait" })),
            { goal: task.goal, startCheck: task.startCheck }, memorySink());
        const bad = buildEpisodeRecord({
            runId: "a", startedAt: new Date(), endedAt: new Date(), task: { id: task.id, goal: task.goal }, agent: {}, result: failed,
        });
        expect(bad).toMatchObject({ valid: false, stopReason: "start_check_failed", task: { id: "cow-hide-and-bones" } });
        expect(bad.startCheck).toMatchObject({ ok: false });

        const good = createFakeGame({ npcs: [cow()] });
        const ok = await runController(createLiveAdapter({ bot: good.bot, sdk: good.sdk, diagnostics: memorySink() }),
            cowPolicy(), { goal: task.goal, startCheck: task.startCheck, verifyDone: task.verifyDone, maxSteps: 20 }, memorySink());
        const rec = buildEpisodeRecord({
            runId: "b", startedAt: new Date(), endedAt: new Date(), task: { id: task.id, goal: task.goal }, agent: {}, result: ok,
        });
        expect(rec).toMatchObject({ valid: true, goalMet: true });
    });

    test("a task without a start check records null", async () => {
        const game = createFakeGame();
        const r = await runController(createLiveAdapter({ bot: game.bot, sdk: game.sdk, diagnostics: memorySink() }),
            new FixedPolicy(() => ({ type: "stop", outcome: "done" })), { goal: "g" }, memorySink());
        expect(buildEpisodeRecord({ runId: "c", startedAt: new Date(), endedAt: new Date(), task: { goal: "g" }, agent: {}, result: r }))
            .toMatchObject({ valid: true, startCheck: null, task: { id: null } });
    });
});
