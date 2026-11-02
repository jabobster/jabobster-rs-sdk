import { describe, expect, test } from "bun:test";
import { runController } from "../controller";
import { cowPolicy } from "../fixedPolicies";
import { memorySink } from "../logger";
import { FixedPolicy, sequencePolicy } from "../policy";
import { createLiveAdapter } from "../runAction";
import { cowGoal } from "../goals";
import { cow, createFakeGame } from "./fakeGame";

function setup(init: Parameters<typeof createFakeGame>[0] = {}, extra: { timeouts?: Record<string, number> } = {}) {
    const game = createFakeGame(init);
    const diagnostics = memorySink();
    const decisions = memorySink();
    const adapter = createLiveAdapter({ bot: game.bot, sdk: game.sdk, diagnostics, ...extra });
    return { ...game, diagnostics, decisions, adapter };
}
const run = (s: ReturnType<typeof setup>, policy: any, cfg: any = {}) =>
    runController(s.adapter, policy, { goal: "test goal", ...cfg }, s.decisions);

describe("end to end: kill a cow, take its cowhide and bones", () => {
    test("deterministic policy completes the goal on evidence", async () => {
        const s = setup({ npcs: [cow()], inv: [{ id: 526, name: "Bones", count: 1 }] });
        const r = await run(s, cowPolicy());

        expect(r.stopReason).toBe("model_done");
        expect(r.history.map((h) => (h.action as any).type)).toEqual(["attack", "wait", "wait", "pickup", "pickup", "stop"]);
        expect(r.history.slice(0, 5).every((h) => h.status === "confirmed_success")).toBe(true);
        expect(s.world.inv.map((i) => i.name).sort()).toEqual(["Bones", "Bones", "Cowhide"]);
        // one diagnostic record per attempt (including the stop), decisions logged per model reply
        expect(s.diagnostics.records.length).toBe(6);
        expect(s.decisions.records.every((d) => d.parse === "ok")).toBe(true);
    });
});

describe("safety", () => {
    test("rejected action never reaches the SDK, and the retry sees a correction", async () => {
        const s = setup({ npcs: [cow()] });
        const inputs: any[] = [];
        const policy = new FixedPolicy((input) => {
            inputs.push(input);
            if (input.step === 1 && input.attempt === 0) return { type: "attack", target: "n9" };
            if (input.step === 1 && input.attempt === 1) return { type: "stop", outcome: "blocked" };
            return { type: "stop", outcome: "blocked" };
        });
        const r = await run(s, policy);
        expect(s.world.calls).toEqual([]);                       // nothing dispatched
        expect(inputs[1].previousError).toContain("unknown_handle");
        expect(inputs[1].user).toContain("YOUR LAST REPLY WAS REJECTED");
        expect(r.stopReason).toBe("model_blocked");
    });

    test("malformed output gets one retry, then recovers", async () => {
        const s = setup();
        const r = await run(s, sequencePolicy(["I think I should attack", { type: "stop", outcome: "done" }]));
        expect(r.stopReason).toBe("model_done");
        expect(s.decisions.records.map((d) => d.parse)).toEqual(["failed", "ok"]);
    });

    test("repeated unusable replies end the run", async () => {
        const s = setup();
        const r = await run(s, new FixedPolicy(() => "nonsense"), { maxInvalidStreak: 3 });
        expect(r.stopReason).toBe("invalid_streak");
        expect(r.steps).toBe(3);
        expect(s.world.calls).toEqual([]);
    });

    test("step limit", async () => {
        const s = setup();
        const r = await run(s, new FixedPolicy(() => ({ type: "wait" })), { maxSteps: 4 });
        expect(r.stopReason).toBe("max_steps");
        expect(r.history).toHaveLength(4);
    });

    test("tick budget: stops once the game-tick budget is spent", async () => {
        const s = setup();
        const r = await run(s, new FixedPolicy(() => ({ type: "wait", ticks: 3 })), { maxTicks: 5 });
        expect(r.stopReason).toBe("tick_budget");
        // each 3-tick wait is recorded with its tick cost; the run stops once the total passes 5
        expect(r.history.map((h) => h.ticks)).toEqual([3, 3]);
    });

    test("player already dead / leaves the game / dies mid-run", async () => {
        const dead = setup(); dead.world.player.isDead = true;
        expect((await run(dead, sequencePolicy([]))).stopReason).toBe("player_dead");

        const out = setup(); out.world.inGame = false;
        expect((await run(out, sequencePolicy([]))).stopReason).toBe("left_game");

        const mid = setup();
        const policy = new FixedPolicy(({ step }) => {
            if (step === 2) mid.world.player.isDead = true; // dies before the second action resolves
            return { type: "wait" };
        });
        const r = await run(mid, policy);
        expect(r.stopReason).toBe("player_dead");
    });

    test("shop open: actions are rejected, wait still works", async () => {
        const s = setup({ npcs: [cow()] });
        s.world.shopOpen = true;
        const r = await run(s, sequencePolicy([{ type: "attack", target: "n1" }, { type: "wait" }, { type: "stop", outcome: "blocked" }]));
        expect(s.world.calls).toEqual([]);
        expect(r.history.map((h) => h.status)).toEqual(["confirmed_success", "confirmed_success"]);
    });
});

describe("uncertainty is surfaced, never invented", () => {
    test("unconfirmed pickup adds a verify note, and the repeat block rejects the third identical try", async () => {
        const s = setup({ ground: [{ id: 526, name: "Bones", x: 3202, z: 3200, count: 1 }] });
        s.world.swallowPickup = true;
        const notes: (string | undefined)[] = [];
        const errors: (string | undefined)[] = [];
        const policy = new FixedPolicy(({ view, note, previousError }) => {
            notes.push(note);
            errors.push(previousError);
            return { type: "pickup", target: view.items[0].h };
        });
        const r = await run(s, policy, { maxInvalidStreak: 3 });
        expect(r.history[0].status).toBe("unconfirmed");
        expect(notes[0]).toBeUndefined();
        expect(notes[1]).toContain("not confirmed");
        // Two identical failures with nothing changed: the next identical try is refused, not sent to the game.
        expect(errors.some((e) => e?.startsWith("repeat_blocked"))).toBe(true);
        expect(s.world.calls.filter((c) => c === "pickupItem")).toHaveLength(2);
        expect(r.stopReason).toBe("invalid_streak");
    });

    test("SDK call that never returns becomes a timeout, not a hang", async () => {
        const s = setup({ npcs: [cow()] }, { timeouts: { attack: 30 } });
        s.world.hangAttack = true;
        const r = await run(s, sequencePolicy([{ type: "attack", target: "n1" }, { type: "stop", outcome: "blocked" }]));
        expect(r.history[0].status).toBe("partial_progress_or_timeout");
        expect(r.history[0].reason).toBe("sdk_timeout");
    });

    test("stale handle: npc dies between observation and dispatch", async () => {
        const s = setup({ npcs: [cow()] });
        const policy = new FixedPolicy(({ step, attempt, view }) => {
            if (step === 1 && attempt === 0) {
                s.world.npcs = []; // gone before dispatch
                return { type: "attack", target: view.npcs[0].h };
            }
            return { type: "stop", outcome: "blocked" };
        });
        const r = await run(s, policy);
        expect(s.world.calls).toEqual([]);
        expect(s.decisions.records[0].reason).toBe("target_gone");
        expect(r.stopReason).toBe("model_blocked");
    });
});

describe("dialog flow", () => {
    test("talk, continue, choose, finish", async () => {
        const s = setup({ npcs: [{ index: 9, id: 1, name: "Hassan", x: 3201, z: 3200, options: ["Talk-to"], hp: 5 }] });
        s.world.dialogScript = [
            { text: "Greetings", options: [{ index: 1, text: "Click here to continue" }] },
            { text: "Need anything?", options: [{ index: 1, text: "Yes" }, { index: 2, text: "No" }] },
            { text: "Fine.", options: [{ index: 1, text: "Click here to continue" }] },
        ];
        const r = await run(s, sequencePolicy([
            { type: "interact_npc", target: "n1", option: "Talk-to" },
            { type: "dialog_continue" },
            { type: "dialog_select", choice: 2 },
            { type: "dialog_continue" },
            { type: "stop", outcome: "done" },
        ]));
        expect(r.stopReason).toBe("model_done");
        expect(r.history.slice(0, 4).map((h) => h.status)).toEqual(Array(4).fill("confirmed_success"));
        expect(s.world.calls).toEqual(["talkTo", "sendClickDialog", "clickDialogByText", "sendClickDialog"]);
    });

    test("choice page rejects dialog_continue and tells the model why", async () => {
        const s = setup();
        s.world.dialog = { isOpen: true, isWaiting: false, pageId: "p1", text: "?", options: [{ index: 1, text: "Yes" }, { index: 2, text: "No" }] };
        const policy = sequencePolicy([{ type: "dialog_continue" }, { type: "stop", outcome: "blocked" }]);
        await run(s, policy);
        expect(s.decisions.records[0].reason).toBe("dialog_requires_choice");
        expect(s.world.calls).toEqual([]);
    });
});

describe("goal check (real log: model said done after picking up one stray Bones)", () => {
    const goal = cowGoal();
    const cfg = { allowedActions: goal.allowedActions, verifyDone: goal.verifyDone };

    test("a false done is rejected with the missing items, then the real completion is accepted", async () => {
        const s = setup({ npcs: [cow()], ground: [{ id: 526, name: "Bones", x: 3202, z: 3200, count: 1 }] });
        const notes: (string | undefined)[] = [];
        const replies = [
            { type: "pickup", target: "g1" },            // stray bones only
            { type: "stop", outcome: "done" },           // false claim
            { type: "attack", target: "n1" },
            { type: "wait", ticks: 3 },
            { type: "pickup", target: "g1" },
            { type: "pickup", target: "g1" },
            { type: "stop", outcome: "done" },
        ];
        let i = 0;
        const policy = new FixedPolicy(({ note }) => { notes.push(note); return replies[i++]; });
        const r = await run(s, policy, cfg);

        expect(r.stopReason).toBe("goal_met");
        expect(r.history[1]).toMatchObject({ status: "not_executed", reason: "goal_not_met" });
        expect(notes[2]).toContain("NOT complete");
        expect(notes[2]).toContain("Cowhide");
        expect(s.decisions.records.some((d) => d.kind === "goal_check" && d.done === false)).toBe(true);
    });

    test("a rejected done is logged as not_executed, and the hint names the reachable item's handle", async () => {
        const s = setup({ npcs: [cow()], ground: [{ id: 1739, name: "Cowhide", x: 3202, z: 3200, count: 1 }] });
        const notes: (string | undefined)[] = [];
        const policy = new FixedPolicy(({ note }) => { notes.push(note); return { type: "stop", outcome: "done" }; });
        await run(s, policy, { ...cfg, hintFor: goal.hintFor, maxInvalidStreak: 2 });

        // The stop itself must not be logged as a success: that is what made the real logs look like "done" was accepted.
        const rejected = s.decisions.records.filter((d) => d.reason === "goal_not_met");
        expect(rejected.length).toBeGreaterThan(0);
        expect(rejected.every((d) => d.status === "not_executed")).toBe(true);
        expect(s.decisions.records.some((d) => d.reason === "stop_requested")).toBe(false);
        expect(notes[1]).toContain('"target":"g1"');
        expect(notes[1]).toContain("Cowhide");
    });

    test("repeating the false claim ends the run instead of looping forever", async () => {
        const s = setup({ npcs: [cow()] });
        const r = await run(s, new FixedPolicy(() => ({ type: "stop", outcome: "done" })), { ...cfg, maxInvalidStreak: 3 });
        expect(r.stopReason).toBe("invalid_streak");
        expect(r.steps).toBe(3);
    });

    test("'blocked' is never second-guessed", async () => {
        const s = setup();
        const r = await run(s, sequencePolicy([{ type: "stop", outcome: "blocked" }]), cfg);
        expect(r.stopReason).toBe("model_blocked");
    });

    test("goal check metrics are not counted as model calls", async () => {
        const { summarizeDecisions } = await import("../metrics");
        const s = setup({ npcs: [cow()] });
        await run(s, new FixedPolicy(() => ({ type: "stop", outcome: "done" })), { ...cfg, maxInvalidStreak: 2 });
        const m = summarizeDecisions(s.decisions.records);
        expect(m.goalRejected).toBe(2);
        expect(m.modelCalls).toBe(2);
    });
});

describe("allowed actions through the loop", () => {
    test("a disallowed action reaches the policy as a rejection and never the SDK", async () => {
        const s = setup({ npcs: [cow()] });
        const seen: any[] = [];
        const replies = [{ type: "walk_to", x: 3205, z: 3200 }, { type: "stop", outcome: "blocked" }];
        let i = 0;
        const policy = new FixedPolicy((input) => { seen.push(input); return replies[i++]; });
        await run(s, policy, { allowedActions: ["attack", "wait"] });
        expect(seen[0].allowed).toEqual(["attack", "wait"]);
        expect(seen[0].system).not.toContain("walk_to");
        expect(seen[1].previousError).toContain("action_not_allowed");
        expect(s.world.calls).toEqual([]);
    });
});
