// The safety layer inside the real controller, against the fake game: eating, running, stopping,
// the watchdog, and the failure caps. The model policy is scripted, so every result is exact.

import { describe, expect, test } from "bun:test";
import { runController } from "../controller";
import { memorySink } from "../logger";
import { summarizeDecisions } from "../metrics";
import { FixedPolicy } from "../policy";
import { replayRecords, summarizeReplay } from "../replay";
import { createLiveAdapter } from "../runAction";
import { cow, createFakeGame } from "./fakeGame";

const LOBSTER = { id: 379, name: "Lobster", count: 2, options: ["Eat", "Drop"], heal: 6 };

function setup(init: Parameters<typeof createFakeGame>[0] = {}) {
    const game = createFakeGame(init);
    const diagnostics = memorySink();
    const decisions = memorySink();
    const adapter = createLiveAdapter({ bot: game.bot, sdk: game.sdk, diagnostics });
    return { ...game, diagnostics, decisions, adapter };
}
type S = ReturnType<typeof setup>;

/** Every tick spent in a fight costs 1 HP (never below 1, so nothing dies in these tests). */
function bleedInFights(s: S) {
    s.world.onTick.push(() => {
        if (s.world.player.combat.inCombat) s.world.player.hp = Math.max(1, s.world.player.hp - 1);
    });
}

/** attack when idle, otherwise wait: the model just fights. Records what it was asked at each step. */
function fighter() {
    const inputs: any[] = [];
    const policy = new FixedPolicy((input) => {
        inputs.push(input);
        return input.view.player.combat === "idle" && input.view.npcs.length
            ? { type: "attack", target: input.view.npcs[0].h }
            : { type: "wait", ticks: 2 };
    });
    return { policy, inputs, steps: () => inputs.map((i) => i.step) };
}

const longFight = () => cow(5, { hp: 100 });
const run = (s: S, policy: any, cfg: any = {}) => runController(s.adapter, policy, { goal: "g", ...cfg }, s.decisions);

describe("low HP with food", () => {
    test("eats instead of asking the model, even when the goal does not allow eating", async () => {
        const s = setup({ npcs: [longFight()], inv: [{ ...LOBSTER }] });
        bleedInFights(s);
        const f = fighter();
        const r = await run(s, f.policy, { maxSteps: 8, allowedActions: ["attack", "wait"] });

        // attack, then waits: 10 -> 8 -> 6 -> 4 -> 2 HP (low). Step 6 belongs to the safety layer.
        expect(f.steps()).toEqual([1, 2, 3, 4, 5, 7, 8]);
        expect(s.world.calls.filter((c) => c === "eatFood")).toHaveLength(1);
        expect(s.world.inv.find((i) => i.name === "Lobster")!.count).toBe(1);
        expect(r.safetyInterventions).toEqual({ low_hp_eat: 1 });

        const eat = r.history.find((h) => h.source === "safety")!;
        expect(eat).toMatchObject({ step: 6, status: "confirmed_success", reason: "food_consumed", action: { type: "eat" } });
        expect(r.stopReason).toBe("max_steps");
    });

    test("the override is logged as such, and the model is told what happened", async () => {
        const s = setup({ npcs: [longFight()], inv: [{ ...LOBSTER }] });
        bleedInFights(s);
        const f = fighter();
        await run(s, f.policy, { maxSteps: 8 });

        const safetyDecision = s.decisions.records.find((d) => d.kind === "safety")!;
        expect(safetyDecision).toMatchObject({ step: 6, rule: "low_hp_eat", status: "confirmed_success", dispatched: true });
        expect(safetyDecision.reason).toContain("HP 2/10");

        const diag = s.diagnostics.records.filter((d) => d.source === "safety");
        expect(diag).toHaveLength(1);
        expect(diag[0]).toMatchObject({ safetyRule: "low_hp_eat", resolved: { type: "eat" } });
        expect(s.diagnostics.records.filter((d) => d.source === "model").length).toBeGreaterThan(0);

        const next = f.inputs.find((i) => i.step === 7)!;
        expect(next.memory.some((m: string) => m.includes("[auto] eat") && m.includes("confirmed_success"))).toBe(true);
        expect(next.view.player.hp).toBe(8);
    });

    test("the logs still replay exactly (eat records validate and classify the same way)", async () => {
        const s = setup({ npcs: [longFight()], inv: [{ ...LOBSTER }] });
        bleedInFights(s);
        await run(s, fighter().policy, { maxSteps: 8 });
        const summary = summarizeReplay(replayRecords(s.diagnostics.records, "t"));
        expect(summary).toMatchObject({ changed: 0, skipped: 0 });
        expect(summary.same).toBe(s.diagnostics.records.length);
    });

    test("safety turns are not counted as model calls in the metrics", async () => {
        const s = setup({ npcs: [longFight()], inv: [{ ...LOBSTER }] });
        bleedInFights(s);
        const f = fighter();
        await run(s, f.policy, { maxSteps: 8 });
        const m = summarizeDecisions(s.decisions.records);
        expect(m.safetyOverrides).toBe(1);
        expect(m.modelCalls).toBe(f.inputs.length);
    });
});

describe("low HP, no food", () => {
    test("in a fight: runs away from the enemy, then stops once it is no longer fighting", async () => {
        const s = setup({ npcs: [longFight()] });           // cow stands 3 tiles east
        bleedInFights(s);
        const f = fighter();
        const r = await run(s, f.policy, { maxSteps: 20 });

        expect(r.stopReason).toBe("safety_low_hp");
        expect(r.detail).toContain("HP");
        expect(f.steps()).toEqual([1, 2, 3, 4, 5]);          // step 6 = run, step 7 = stop
        expect(s.world.calls.filter((c) => c === "walkTo")).toHaveLength(1);
        expect(s.world.player.worldX).toBeLessThan(3200);    // west, away from the cow
        expect(r.history.at(-1)).toMatchObject({ source: "safety", action: { type: "walk_to" }, status: "confirmed_success" });
        expect(r.safetyInterventions).toEqual({ low_hp_flee: 1 });
        expect(r.steps).toBe(6);

        const stop = s.decisions.records.filter((d) => d.kind === "safety").at(-1)!;
        expect(stop).toMatchObject({ rule: "safety_low_hp", action: "stop" });
    });

    test("not in a fight (just killed it): stops at once, nothing is sent to the game", async () => {
        const s = setup();
        s.world.player.hp = 2;
        const f = fighter();
        const r = await run(s, f.policy);
        expect(r.stopReason).toBe("safety_low_hp");
        expect(r.steps).toBe(0);
        expect(s.world.calls).toEqual([]);
        expect(f.inputs).toHaveLength(0);
    });

    test("cannot get away: fights on after the flee attempts (default)", async () => {
        const s = setup({ npcs: [longFight()] });
        s.world.walkBreaksCombat = false;                    // the enemy keeps hold of us
        bleedInFights(s);
        const f = fighter();
        const r = await run(s, f.policy, { maxSteps: 14 });

        expect(s.world.calls.filter((c) => c === "walkTo")).toHaveLength(3);
        expect(r.safetyInterventions).toEqual({ low_hp_flee: 3 });
        expect(r.stopReason).toBe("max_steps");              // the model kept control afterwards
        expect(f.steps().filter((n) => n > 8).length).toBeGreaterThan(0);
    });

    test("cannot get away: stops when configured to", async () => {
        const s = setup({ npcs: [longFight()] });
        s.world.walkBreaksCombat = false;
        bleedInFights(s);
        const r = await run(s, fighter().policy, { maxSteps: 30, safety: { onFleeFailed: "stop" } });
        expect(r.stopReason).toBe("safety_low_hp");
        expect(r.detail).toContain("could not get away");
        expect(s.world.calls.filter((c) => c === "walkTo")).toHaveLength(3);
    });

    test("a blocked route falls through to the next direction at no game-time cost", async () => {
        const s = setup({ npcs: [longFight()] });
        bleedInFights(s);
        let probes = 0;
        // Only the second direction has a path.
        s.sdk.findPath = (x: number, z: number) => ({ success: ++probes > 1 && x > 0 && z !== 3200 - 12 });
        const r = await run(s, fighter().policy, { maxSteps: 20 });
        const flee = r.history.find((h) => h.source === "safety" && (h.action as any).type === "walk_to")!;
        expect(flee.status).toBe("confirmed_success");
        expect(s.world.calls.filter((c) => c === "walkTo")).toHaveLength(1);
    });

    test("eating that fails falls back to running", async () => {
        const s = setup({ npcs: [longFight()], inv: [{ ...LOBSTER }] });
        s.world.eatSwallowed = true;
        bleedInFights(s);
        const r = await run(s, fighter().policy, { maxSteps: 20 });
        expect(s.world.calls.filter((c) => c === "eatFood")).toHaveLength(2);   // two tries, then give up on food
        expect(r.safetyInterventions.low_hp_flee).toBeGreaterThanOrEqual(1);
        expect(r.stopReason).toBe("safety_low_hp");
    });
});

describe("the layer can be configured or switched off", () => {
    test("safety: false leaves a low-HP player to the model", async () => {
        const s = setup();
        s.world.player.hp = 2;
        const r = await run(s, new FixedPolicy(() => ({ type: "stop", outcome: "done" })), { safety: false });
        expect(r.stopReason).toBe("model_done");
        expect(r.safetyInterventions).toEqual({});
    });

    test("a lower threshold lets it keep fighting at 2 HP", async () => {
        const s = setup();
        s.world.player.hp = 2;
        const r = await run(s, new FixedPolicy(() => ({ type: "stop", outcome: "done" })), { safety: { lowHpFraction: 0.1 } });
        expect(r.stopReason).toBe("model_done");
    });

    test("a healthy player is never interfered with", async () => {
        const s = setup({ npcs: [cow(5, { hp: 3 })] });
        const f = fighter();
        const r = await run(s, f.policy, { maxSteps: 4 });
        expect(r.safetyInterventions).toEqual({});
        expect(r.history.every((h) => h.source === undefined)).toBe(true);
    });
});

describe("no-progress watchdog", () => {
    const waiter = () => new FixedPolicy(() => ({ type: "wait", ticks: 3 }));

    test("a model that keeps waiting while nothing changes is stopped", async () => {
        const s = setup();
        const r = await run(s, waiter(), { maxSteps: 50, safety: { noProgressSteps: 5, noProgressTicks: 10 } });
        expect(r.stopReason).toBe("no_progress");
        expect(r.steps).toBe(5);
        expect(r.detail).toContain("nothing changed");
    });

    test("something appearing (a cow respawning) restarts the clock", async () => {
        const s = setup();
        s.world.onTick.push(() => { if (s.world.tick === 108) s.world.npcs.push(cow(7)); });
        const r = await run(s, waiter(), { maxSteps: 50, safety: { noProgressSteps: 5, noProgressTicks: 10 } });
        expect(r.stopReason).toBe("no_progress");
        expect(r.steps).toBe(8);   // would have been 5 without the spawn
    });

    test("with the layer off, the same model just burns its step budget", async () => {
        const r = await run(setup(), waiter(), { maxSteps: 12, safety: false });
        expect(r.stopReason).toBe("max_steps");
    });
});

describe("failure caps", () => {
    test("a model that keeps failing in different ways is stopped, even though no single action repeats", async () => {
        const s = setup({
            ground: [
                { id: 526, name: "Bones", x: 3201, z: 3200, count: 1 },
                { id: 1739, name: "Cowhide", x: 3202, z: 3200, count: 1 },
            ],
        });
        s.world.swallowPickup = true;                        // pickup "succeeds" but nothing changes: unconfirmed
        let n = 0;
        const alternate = new FixedPolicy(() => ({ type: "pickup", target: ++n % 2 ? "g1" : "g2" }));
        const r = await run(s, alternate, { maxSteps: 30, safety: { maxFailureStreak: 4 } });
        expect(r.stopReason).toBe("too_many_failures");
        expect(r.steps).toBe(4);
        expect(r.detail).toContain("4 actions in a row");
    });
});
