import { describe, expect, test } from "bun:test";
import { classifyOutcome } from "../classify";
import { SAFETY_DEFAULTS, SafetyMonitor, fleeActions, isLowHp, progressSignature, safetyFromEnv } from "../safety";
import { validateAction } from "../validate";
import { toModelView } from "../view";
import { ground, makeObs, npc } from "./helpers";

const fighting = (index = 5) => ({ inCombat: true, targetIndex: index, targetType: "npc" });
const lowFight = (over: Record<string, unknown> = {}) =>
    makeObs({
        player: { name: "T", x: 3200, z: 3200, level: 0, hp: 2, maxHp: 10, isDead: false, combat: fighting() },
        nearbyNpcs: [npc(5, "Cow", { x: 3203, z: 3200 })],
        ...over,
    });
const food = { slot: 0, id: 379, name: "Lobster", quantity: 1, edible: true };

describe("low HP threshold", () => {
    test("20% of max HP by default, inclusive", () => {
        const at = (hp: number, maxHp: number) => makeObs({ player: { ...makeObs().player, hp, maxHp } });
        expect(isLowHp(at(2, 10), 0.2)).toBe(true);
        expect(isLowHp(at(3, 10), 0.2)).toBe(false);
        expect(isLowHp(at(12, 60), 0.2)).toBe(true);
        expect(isLowHp(at(13, 60), 0.2)).toBe(false);
        expect(isLowHp(at(0, 0), 0.2)).toBe(false);     // unknown max: never "low"
    });
});

describe("low HP decisions", () => {
    test("healthy: the model keeps control", () => {
        expect(new SafetyMonitor().check(makeObs()).kind).toBe("none");
    });

    test("low HP with food eats, in a fight or not", () => {
        for (const obs of [lowFight({ inventory: [food] }), makeObs({ player: { ...makeObs().player, hp: 1 }, inventory: [food] })]) {
            const v = new SafetyMonitor().check(obs);
            expect(v.kind).toBe("act");
            if (v.kind === "act") expect(v).toMatchObject({ rule: "low_hp_eat", actions: [{ type: "eat" }] });
        }
    });

    test("low HP, no food, in a fight: run away from the enemy (not toward it)", () => {
        const v = new SafetyMonitor().check(lowFight());     // cow is 3 tiles east
        expect(v.kind).toBe("act");
        if (v.kind !== "act") return;
        expect(v.rule).toBe("low_hp_flee");
        const first = v.actions[0] as any;
        expect(first.type).toBe("walk_to");
        expect(first.x).toBeLessThan(3200 - 5);              // west
        expect(Math.abs(first.z - 3200)).toBeLessThanOrEqual(1);
    });

    test("low HP, no food, NOT fighting (e.g. just killed it): stop instead of starting another fight", () => {
        const v = new SafetyMonitor().check(makeObs({ player: { ...makeObs().player, hp: 2 } }));
        expect(v).toMatchObject({ kind: "stop", stopReason: "safety_low_hp" });
    });

    test("the lingering post-kill combat flag (target none) counts as not fighting", () => {
        const obs = makeObs({ player: { ...makeObs().player, hp: 2, combat: { inCombat: true, targetIndex: -1, targetType: "none" } } });
        expect(new SafetyMonitor().check(obs)).toMatchObject({ kind: "stop", stopReason: "safety_low_hp" });
    });

    test("fleeing is bounded: after maxFleeAttempts the fight goes on (default) or stops (option)", () => {
        for (const [onFleeFailed, expected] of [["continue", "none"], ["stop", "stop"]] as const) {
            const m = new SafetyMonitor({ onFleeFailed });
            const kinds: string[] = [];
            for (let i = 0; i < 5; i++) kinds.push(m.check(lowFight()).kind);
            expect(kinds).toEqual(["act", "act", "act", expected, expected]);
            expect(m.interventions.low_hp_flee).toBe(3);
        }
    });

    test("after HP recovers the flee budget resets", () => {
        const m = new SafetyMonitor();
        for (let i = 0; i < 4; i++) m.check(lowFight());
        m.check(makeObs());                                   // healthy
        expect(m.check(lowFight()).kind).toBe("act");
    });

    test("eating that keeps failing is abandoned: falls back to fleeing", () => {
        const m = new SafetyMonitor();
        const obs = lowFight({ inventory: [food] });
        expect(m.check(obs).kind).toBe("act");
        m.noteSafetyResult("low_hp_eat", "confirmed_failure");
        expect(m.check(obs).kind).toBe("act");
        m.noteSafetyResult("low_hp_eat", "not_executed");
        const third = m.check(obs);
        expect(third.kind === "act" && third.rule).toBe("low_hp_flee");
    });

    test("threshold and eating are configurable", () => {
        const half = makeObs({ player: { ...makeObs().player, hp: 5 } });
        expect(new SafetyMonitor({ lowHpFraction: 0.5 }).check(half).kind).toBe("stop");
        expect(new SafetyMonitor().check(half).kind).toBe("none");
        const noEat = lowFight({ inventory: [food] });
        const v = new SafetyMonitor({ eat: false }).check(noEat);
        expect(v.kind === "act" && v.rule).toBe("low_hp_flee");
    });
});

describe("flee destinations", () => {
    test("opposite side of the threats, a configured distance away, several fallbacks", () => {
        const obs = lowFight({ nearbyNpcs: [npc(5, "Cow", { x: 3200, z: 3203 })] }); // enemy to the south
        const a = fleeActions(obs, { fleeDistance: 10 }) as any[];
        expect(a.length).toBeGreaterThanOrEqual(4);
        expect(a[0]).toMatchObject({ type: "walk_to", x: 3200, tolerance: 2 });
        expect(a[0].z).toBe(3190);                        // north, 10 away
        expect(new Set(a.map((x) => `${x.x},${x.z}`)).size).toBe(a.length);   // all different
    });

    test("a safe point comes first", () => {
        const a = fleeActions(lowFight(), { safePoint: { x: 3180, z: 3210 } }) as any[];
        expect(a[0]).toMatchObject({ x: 3180, z: 3210 });
    });

    test("an unreachable safe point (too far) is skipped, not fatal", () => {
        const a = fleeActions(lowFight(), { safePoint: { x: 3500, z: 3200 } }) as any[];
        expect(a[0].x).not.toBe(3500);
    });

    test("never leaves the map", () => {
        const obs = makeObs({
            player: { name: "T", x: 4, z: 4, level: 0, hp: 1, maxHp: 10, isDead: false, combat: fighting() },
            nearbyNpcs: [npc(5, "Cow", { x: 8, z: 8 })],
        });
        for (const a of fleeActions(obs) as any[]) {
            expect(a.x).toBeGreaterThanOrEqual(0);
            expect(a.z).toBeGreaterThanOrEqual(0);
        }
    });

    test("all produced actions pass the normal walk_to validation", () => {
        const obs = lowFight();
        const { view, handles } = toModelView(obs);
        for (const a of fleeActions(obs)) expect(validateAction(a, { view, handles }, obs).ok).toBe(true);
    });
});

describe("no-progress watchdog", () => {
    const quiet = (tick: number) => makeObs({ tick });

    test("stops only when BOTH the step and the tick thresholds are reached", () => {
        const m = new SafetyMonitor({ noProgressSteps: 4, noProgressTicks: 20 });
        const kinds: string[] = [];
        // 7 checks, 1 tick apart: enough steps, not enough ticks
        for (let i = 0; i < 7; i++) kinds.push(m.check(quiet(100 + i)).kind);
        expect(kinds.every((k) => k === "none")).toBe(true);
        expect(m.check(quiet(130))).toMatchObject({ kind: "stop", stopReason: "no_progress" });
    });

    test("any visible change resets it", () => {
        const m = new SafetyMonitor({ noProgressSteps: 3, noProgressTicks: 0 });
        expect(m.check(quiet(1)).kind).toBe("none");
        expect(m.check(quiet(2)).kind).toBe("none");
        expect(m.check(quiet(3)).kind).toBe("none");
        // something appears: a new ground item
        expect(m.check(makeObs({ tick: 4, nearbyGroundItems: [ground(526, "Bones")] })).kind).toBe("none");
        expect(m.check(makeObs({ tick: 5, nearbyGroundItems: [ground(526, "Bones")] })).kind).toBe("none");
        expect(m.check(makeObs({ tick: 6, nearbyGroundItems: [ground(526, "Bones")] })).kind).toBe("none");
        expect(m.check(makeObs({ tick: 7, nearbyGroundItems: [ground(526, "Bones")] })).kind).toBe("stop");
    });

    test("wandering npcs are not progress; a new npc is", () => {
        const a = makeObs({ nearbyNpcs: [npc(5, "Cow", { x: 3203 })] });
        const b = makeObs({ nearbyNpcs: [npc(5, "Cow", { x: 3204 })] });
        const c = makeObs({ nearbyNpcs: [npc(5, "Cow"), npc(6, "Cow")] });
        expect(progressSignature(a)).toBe(progressSignature(b));
        expect(progressSignature(a)).not.toBe(progressSignature(c));
    });

    test("a fight where HP changes is progress", () => {
        const hp = (n: number) => makeObs({ player: { ...makeObs().player, hp: n, combat: fighting() } });
        expect(progressSignature(hp(10))).not.toBe(progressSignature(hp(9)));
    });
});

describe("failure caps", () => {
    test("a streak of unconfirmed/failed actions stops the run; a success resets the streak", () => {
        const m = new SafetyMonitor({ maxFailureStreak: 3, maxTotalFailures: 99 });
        m.noteModelResult("confirmed_failure");
        m.noteModelResult("unconfirmed");
        m.noteModelResult("confirmed_success");
        m.noteModelResult("partial_progress_or_timeout");
        m.noteModelResult("confirmed_failure");
        expect(m.check(makeObs({ tick: 1 })).kind).toBe("none");
        m.noteModelResult("unconfirmed");
        expect(m.check(makeObs({ tick: 2 }))).toMatchObject({ kind: "stop", stopReason: "too_many_failures" });
    });

    test("a total cap catches failures that are interleaved with successes", () => {
        const m = new SafetyMonitor({ maxFailureStreak: 99, maxTotalFailures: 3 });
        for (let i = 0; i < 3; i++) { m.noteModelResult("confirmed_failure"); m.noteModelResult("confirmed_success"); }
        expect(m.check(makeObs()).kind).toBe("stop");
    });

    test("safety actions do not count against the model", () => {
        const m = new SafetyMonitor({ maxFailureStreak: 1 });
        m.noteSafetyResult("low_hp_eat", "confirmed_failure");
        expect(m.check(makeObs()).kind).toBe("none");
    });

    test("defaults are the documented ones", () => {
        expect(SAFETY_DEFAULTS).toMatchObject({ lowHpFraction: 0.2, maxFleeAttempts: 3, onFleeFailed: "continue", noProgressSteps: 10, noProgressTicks: 50, maxFailureStreak: 6, maxTotalFailures: 20 });
    });
});

describe("environment config", () => {
    test("AGENT_SAFETY=0 turns it off; other variables set options", () => {
        expect(safetyFromEnv({ AGENT_SAFETY: "0" })).toBe(false);
        expect(safetyFromEnv({})).toEqual({});
        expect(safetyFromEnv({ AGENT_LOW_HP: "0.3", AGENT_SAFE_POINT: "3150,3300", AGENT_ON_FLEE_FAILED: "stop" }))
            .toEqual({ lowHpFraction: 0.3, safePoint: { x: 3150, z: 3300 }, onFleeFailed: "stop" });
        expect(safetyFromEnv({ AGENT_SAFE_POINT: "garbage" })).toEqual({});
    });
});

describe("the eat action", () => {
    const withFood = makeObs({ inventory: [{ slot: 0, id: 1, name: "Coins", quantity: 5 }, { ...food, slot: 3 }] });

    test("validation picks the first edible item; no food is rejected before anything is sent", () => {
        const { view, handles } = toModelView(withFood);
        const ok = validateAction({ type: "eat" }, { view, handles }, withFood);
        expect(ok).toMatchObject({ ok: true, action: { type: "eat", food: { slot: 3, id: 379, name: "Lobster" } } });

        const empty = makeObs();
        const v2 = toModelView(empty);
        expect(validateAction({ type: "eat" }, v2, empty)).toMatchObject({ ok: false, code: "no_food" });
    });

    test("it is not available to the model unless the goal allows it", () => {
        const { view, handles } = toModelView(withFood);
        expect(validateAction({ type: "eat" }, { view, handles }, withFood, { allowed: ["attack", "pickup", "wait"] }))
            .toMatchObject({ ok: false, code: "action_not_allowed" });
    });

    test("classification: food consumed is success; a failed eat is a decisive failure; HP alone is not proof", () => {
        const action = { type: "eat" as const, food: { slot: 3, id: 379, name: "Lobster" } };
        const before = makeObs({ player: { ...makeObs().player, hp: 2 }, inventory: [{ ...food, quantity: 2 }] });
        const ate = makeObs({ player: { ...makeObs().player, hp: 10 }, inventory: [{ ...food, quantity: 1 }] });
        expect(classifyOutcome(action, before, ate, { success: true }, [])).toMatchObject({ outcome: "confirmed_success", reason: "food_consumed" });

        expect(classifyOutcome(action, before, before, { success: false, message: "Failed to eat" }, []))
            .toMatchObject({ outcome: "confirmed_failure", reason: "sdk_eat_failed" });

        const regen = makeObs({ player: { ...makeObs().player, hp: 3 }, inventory: [{ ...food, quantity: 2 }] });
        expect(classifyOutcome(action, before, regen, { success: true }, []).outcome).toBe("unconfirmed");
    });

    test("observe marks only Eat/Drink items as edible", async () => {
        const { observe } = await import("../observe");
        const { createFakeGame } = await import("./fakeGame");
        const g = createFakeGame({ inv: [{ id: 1, name: "Coins", count: 5 }, { id: 379, name: "Lobster", count: 1, options: ["Eat", "Drop"] }] });
        const obs = await observe(g.sdk);
        expect(obs.inventory[0]).not.toHaveProperty("edible");
        expect(obs.inventory[1].edible).toBe(true);
    });
});

