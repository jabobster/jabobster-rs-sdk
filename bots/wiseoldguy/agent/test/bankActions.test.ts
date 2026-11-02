import { describe, expect, test } from "bun:test";
import { validateAction } from "../validate";
import { classifyOutcome } from "../classify";
import { performAction } from "../execute";
import { chopBankGoal } from "../goals";
import type { HandleMap, ModelView, ObsInventoryItem, ObsStack, ResolvedAction } from "../contract";
import { makeObs } from "./helpers";

const ctx = { view: {} as ModelView, handles: { npcs: {}, items: {}, dialogOptions: {} } as unknown as HandleMap };
const oak = (quantity: number, slot = 1): ObsInventoryItem => ({ slot, id: 1, name: "Oak logs", quantity });
const axe: ObsInventoryItem = { slot: 0, id: 2, name: "Bronze axe", quantity: 1 };
const bankOak = (quantity: number): ObsStack[] => [{ id: 1, name: "Oak logs", quantity }];

describe("bank and oak actions: validation", () => {
    test("open_bank is valid with the bank closed and rejected when already open", () => {
        expect(validateAction({ type: "open_bank" }, ctx, makeObs(), {}).ok).toBe(true);
        const open = validateAction({ type: "open_bank" }, ctx, makeObs({ bankOpen: true, bankItems: [] }), {});
        expect(open).toMatchObject({ ok: false, code: "bank_already_open" });
    });

    test("deposit needs an open bank and oak logs in the pack", () => {
        expect(validateAction({ type: "deposit_items" }, ctx, makeObs({ inventory: [oak(3)] }), {}))
            .toMatchObject({ ok: false, code: "bank_not_open" });
        expect(validateAction({ type: "deposit_items" }, ctx, makeObs({ bankOpen: true, bankItems: [] }), {}))
            .toMatchObject({ ok: false, code: "nothing_to_deposit" });
        expect(validateAction({ type: "deposit_items" }, ctx, makeObs({ bankOpen: true, bankItems: [], inventory: [oak(3)] }), {}).ok)
            .toBe(true);
    });

    test("close_bank is allowed while the bank is open (not blocked as a modal)", () => {
        expect(validateAction({ type: "close_bank" }, ctx, makeObs({ bankOpen: true, bankItems: [] }), {}).ok).toBe(true);
        expect(validateAction({ type: "close_bank" }, ctx, makeObs(), {})).toMatchObject({ ok: false, code: "bank_not_open" });
    });

    test("chop_tree is blocked by a full pack and by an open bank", () => {
        const full = Array.from({ length: 28 }, (_, i) => ({ slot: i, id: 100 + i, name: `Item${i}`, quantity: 1 }));
        expect(validateAction({ type: "chop_tree" }, ctx, makeObs({ inventory: full }), {})).toMatchObject({ ok: false, code: "inventory_full" });
        expect(validateAction({ type: "chop_tree" }, ctx, makeObs({ bankOpen: true, bankItems: [] }), {})).toMatchObject({ ok: false, code: "modal_open" });
        expect(validateAction({ type: "chop_tree" }, ctx, makeObs({ inventory: [axe] }), {}).ok).toBe(true);
    });
});

describe("bank and oak actions: classification", () => {
    const at = (over: Parameters<typeof makeObs>[0]) => makeObs({ tick: 5, ...over });

    test("chop_tree is confirmed only by an oak log gained", () => {
        const act: ResolvedAction = { type: "chop_tree", tree: "Oak", logs: "Oak logs" };
        expect(classifyOutcome(act, at({ inventory: [axe] }), at({ inventory: [axe, oak(1)] }), { success: true }, []))
            .toMatchObject({ outcome: "confirmed_success", reason: "log_gained" });
        expect(classifyOutcome(act, at({ inventory: [axe] }), at({ inventory: [axe] }), { success: true, message: "Chopped Oak" }, []).outcome)
            .toBe("unconfirmed");
    });

    test("open_bank is confirmed only when the bank contents are visible", () => {
        const act: ResolvedAction = { type: "open_bank" };
        expect(classifyOutcome(act, at({}), at({ bankOpen: true, bankItems: [] }), { success: true }, []).outcome).toBe("confirmed_success");
        expect(classifyOutcome(act, at({}), at({}), { success: true }, []).outcome).toBe("unconfirmed");
    });

    test("deposit is confirmed when logs leave the pack and reach the bank", () => {
        const act: ResolvedAction = { type: "deposit_items", item: "Oak logs" };
        const before = at({ inventory: [oak(5)], bankOpen: true, bankItems: bankOak(10) });
        expect(classifyOutcome(act, before, at({ bankOpen: true, bankItems: bankOak(15) }), { success: true }, []).outcome)
            .toBe("confirmed_success");
        expect(classifyOutcome(act, before, at({ inventory: [oak(5)], bankOpen: true, bankItems: bankOak(10) }), { success: true }, []).outcome)
            .toBe("unconfirmed");
    });
});

describe("bank and oak actions: execution", () => {
    test("each action calls its SDK helper", async () => {
        const calls: string[] = [];
        const bot = {
            chopTree: async (t: unknown) => { calls.push(`chopTree:${String(t)}`); return { success: true }; },
            openBank: async () => { calls.push("openBank"); return { success: true }; },
            depositItem: async (t: unknown, n: number) => { calls.push(`depositItem:${String(t)}:${n}`); return { success: true }; },
            closeBank: async () => { calls.push("closeBank"); return { success: true }; },
        };
        const before = makeObs();
        for (const type of ["chop_tree", "open_bank", "deposit_items", "close_bank"] as const) {
            await performAction(bot, {}, ({ chop_tree: { type, tree: "Oak", logs: "Oak logs" }, deposit_items: { type, item: "Oak logs" } } as Record<string, ResolvedAction>)[type] ?? ({ type } as ResolvedAction), before);
        }
        expect(calls).toEqual(["chopTree:/^Oak$/i", "openBank", "depositItem:/^Oak logs$/i:-1", "closeBank"]);
    });
});

describe("chop and bank goal: game-side check", () => {
    test("done only after 5 oak logs reach the open bank and the bank is closed", () => {
        const goal = chopBankGoal();
        const at = (over: Parameters<typeof makeObs>[0]) => makeObs(over);
        expect(goal.verifyDone(at({ bankOpen: true, bankItems: bankOak(0) }), at({})).done).toBe(false);
        expect(goal.verifyDone(at({ bankOpen: true, bankItems: bankOak(5) }), at({})).done).toBe(false);
        // Deposited 5, but the bank is still open: not done yet.
        expect(goal.verifyDone(at({ bankOpen: true, bankItems: bankOak(5) }), at({}))).toMatchObject({ done: false, missing: "the bank closed" });
        // Bank closed after the deposit: done. Bank contents are not visible while closed, so the count is remembered.
        expect(goal.verifyDone(at({ bankOpen: false, bankItems: null }), at({})).done).toBe(true);
    });

    test("a closed bank with nothing deposited is not done", () => {
        const goal = chopBankGoal();
        expect(goal.verifyDone(makeObs({ inventory: [oak(5)] }), makeObs()).done).toBe(false);
    });

    test("start check blocks when oak logs are already carried", () => {
        const goal = chopBankGoal();
        const result = goal.startCheck!(makeObs({ inventory: [oak(2)] }));
        expect(result).toMatchObject({ ok: false });
        expect((result as any).problems[0]).toContain("already carrying 2 oak logs");
    });
});
