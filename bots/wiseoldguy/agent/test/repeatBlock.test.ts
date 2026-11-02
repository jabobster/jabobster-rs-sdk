import { describe, expect, test } from "bun:test";
import { runController } from "../controller";
import { actionKey, validateAction } from "../validate";
import { FixedPolicy } from "../policy";
import type { GameAdapter } from "../runAction";
import type { HandleMap, ModelView, Observation } from "../contract";
import { makeObs } from "./helpers";

const ctx = { view: {} as ModelView, handles: { npcs: {}, items: {}, dialogOptions: {} } as unknown as HandleMap };

describe("repeat block: validation", () => {
    test("the blocked action is rejected whatever its why note says; other actions pass", () => {
        const blocked = { key: actionKey({ type: "chop_tree" }), message: "chop_tree failed twice" };
        expect(validateAction({ type: "chop_tree", why: "again" }, ctx, makeObs(), { blocked }))
            .toMatchObject({ ok: false, code: "repeat_blocked" });
        expect(validateAction({ type: "close_bank" }, ctx, makeObs(), { blocked }).ok).toBe(false); // not open: a different reason
        const r = validateAction({ type: "close_bank" }, ctx, makeObs(), { blocked });
        expect(r.ok === false && r.code).not.toBe("repeat_blocked");
    });
});

/** A stub game: chop never gets a log; walk moves the player; chop optionally moves the player (state change). */
function stubGame(opts: { moveOnChop?: boolean } = {}) {
    let o: Observation = makeObs();
    const calls: string[] = [];
    const adapter: GameAdapter = {
        observe: async () => o,
        act: async (raw: any, c: any) => {
            if (c.blocked && actionKey(raw) === c.blocked.key) {
                return { outcome: { status: "not_executed", reason: "repeat_blocked", message: c.blocked.message, dispatched: false }, after: o, resolved: null } as any;
            }
            calls.push(raw.type);
            if (raw.type === "walk_to") {
                o = makeObs({ player: { ...o.player, x: raw.x, z: raw.z } });
                return { outcome: { status: "confirmed_success", reason: "destination_reached", message: "Arrived", dispatched: true }, after: o, resolved: { type: "walk_to", x: raw.x, z: raw.z, tolerance: 2 } } as any;
            }
            if (raw.type === "chop_tree") {
                if (opts.moveOnChop) o = makeObs({ player: { ...o.player, x: o.player.x + 1 } });
                return { outcome: { status: "unconfirmed", reason: "no_log_gain_yet", message: "No tree found", dispatched: true }, after: o, resolved: { type: "chop_tree", tree: "Oak", logs: "Oak logs" } } as any;
            }
            throw new Error(`unexpected ${raw.type}`);
        },
    };
    return { adapter, calls };
}

describe("repeat block: controller", () => {
    test("after two identical failures with nothing changed, the SDK reason reaches the model and the action is refused", async () => {
        const game = stubGame();
        const errors: (string | undefined)[] = [];
        const policy = new FixedPolicy(({ previousError }) => {
            errors.push(previousError);
            return previousError?.startsWith("repeat_blocked") ? { type: "walk_to", x: 3190, z: 3190 } : { type: "chop_tree" };
        });
        const r = await runController(game.adapter, policy, { goal: "test", maxSteps: 4 });
        expect(game.calls).toEqual(["chop_tree", "chop_tree", "walk_to", "chop_tree"]);
        expect(r.stopReason).toBe("max_steps");
        const refusal = errors.find((e) => e?.startsWith("repeat_blocked"));
        expect(refusal).toContain('chop_tree failed twice with "No tree found" and nothing changed');
    });

    test("a failure that changes the state does not arm the block, so the old repeat guard still applies", async () => {
        const game = stubGame({ moveOnChop: true });
        const errors: (string | undefined)[] = [];
        const policy = new FixedPolicy(({ previousError }) => {
            errors.push(previousError);
            return { type: "chop_tree" };
        });
        const r = await runController(game.adapter, policy, { goal: "test", maxSteps: 10, repeatLimit: 3 });
        expect(errors.some((e) => e?.startsWith("repeat_blocked"))).toBe(false);
        expect(game.calls).toHaveLength(3);
        expect(r.stopReason).toBe("repeat_guard");
    });
});
