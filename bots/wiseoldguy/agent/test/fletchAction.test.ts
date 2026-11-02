import { describe, expect, test } from "bun:test";
import { validateAction } from "../validate";
import { performAction } from "../execute";
import { classifyOutcome } from "../classify";
import { fletchBankGoal } from "../goals";
import { RESOURCES, parseBow, parseTree, bowName, menuLabel } from "../resources";
import { batchFor } from "../fletchBank";
import type { HandleMap, ModelView, ObsInventoryItem, ObsStack, ResolvedAction } from "../contract";
import { makeObs } from "./helpers";

const ctx = { view: {} as ModelView, handles: { npcs: {}, items: {}, dialogOptions: {} } as unknown as HandleMap };
const logs = (quantity: number, name = "Oak logs", slot = 1): ObsInventoryItem => ({ slot, id: 1, name, quantity });
const knife: ObsInventoryItem = { slot: 0, id: 2, name: "Knife", quantity: 1 };
const bank = (name: string, quantity: number): ObsStack[] => [{ id: 9, name, quantity }];
const oakTask = { resource: RESOURCES.oak, logCount: 10, bow: "longbow" as const };

describe("resources", () => {
    test("tree and bow come from the task settings; unknown values are refused", () => {
        expect(parseTree(undefined).tree).toBe("Oak");
        expect(parseTree("Willow").logs).toBe("Willow logs");
        expect(() => parseTree("yew")).toThrow(/AGENT_TREE/);
        expect(parseBow(undefined)).toBe("longbow");
        expect(() => parseBow("crossbow")).toThrow(/AGENT_BOW/);
    });

    test("oak bow names match the names the live game uses", () => {
        expect(bowName(RESOURCES.oak, "longbow")).toBe("Oak longbow");
        expect(menuLabel(RESOURCES.oak, "longbow")).toBe("Oak Long Bow");
        expect(menuLabel(RESOURCES.oak, "shortbow")).toBe("Oak Short Bow");
    });
});

describe("withdraw_logs and deposit_items", () => {
    test("withdraw takes the task's logs and count, and needs logs in the open bank", () => {
        expect(validateAction({ type: "withdraw_logs" }, ctx, makeObs({ bankOpen: true, bankItems: bank("Oak logs", 25) }), { resources: oakTask }))
            .toMatchObject({ ok: true, action: { type: "withdraw_logs", item: "Oak logs", count: 10 } });
        expect(validateAction({ type: "withdraw_logs" }, ctx, makeObs({ bankOpen: true, bankItems: bank("Oak logs", 4) }), { resources: oakTask }))
            .toMatchObject({ ok: true, action: { count: 4 } });
        expect(validateAction({ type: "withdraw_logs" }, ctx, makeObs({ bankOpen: true, bankItems: [] }), { resources: oakTask }))
            .toMatchObject({ ok: false, code: "logs_not_in_bank" });
        expect(validateAction({ type: "withdraw_logs" }, ctx, makeObs({ bankItems: bank("Oak logs", 9) }), { resources: oakTask }))
            .toMatchObject({ ok: false, code: "bank_not_open" });
    });

    test("deposit names the bow in a fletch task and the logs in a chop task", () => {
        const bows = makeObs({ bankOpen: true, bankItems: [], inventory: [{ slot: 1, id: 3, name: "Oak longbow", quantity: 10 }] });
        expect(validateAction({ type: "deposit_items" }, ctx, bows, { resources: oakTask }))
            .toMatchObject({ ok: true, action: { type: "deposit_items", item: "Oak longbow" } });
        expect(validateAction({ type: "deposit_items" }, ctx, makeObs({ bankOpen: true, bankItems: [], inventory: [logs(3)] }), {}))
            .toMatchObject({ ok: true, action: { item: "Oak logs" } });
    });

    test("the model cannot pass a tree, log or item name: the schema refuses extra fields", () => {
        expect(validateAction({ type: "chop_tree", tree: "Willow" }, ctx, makeObs(), {}))
            .toMatchObject({ ok: false, code: "extra_field" });
    });
});

describe("fletch", () => {
    const fletchable = (over: Parameters<typeof makeObs>[0] = {}) => makeObs({ inventory: [knife, logs(10)], ...over });

    test("uses the task's logs, bow and menu label, with a batch sized from the pack", () => {
        expect(validateAction({ type: "fletch" }, ctx, fletchable(), { resources: oakTask }))
            .toMatchObject({ ok: true, action: { type: "fletch", logs: "Oak logs", product: "Oak longbow", menuLabel: "Oak Long Bow", batch: 10 } });
        expect(batchFor(3)).toBe(10); // Make 10 with fewer logs makes what is there (confirmed by hand)
    });

    test("refused without a knife, without logs, with the bank open, or with no bow set", () => {
        expect(validateAction({ type: "fletch" }, ctx, makeObs({ inventory: [logs(10)] }), { resources: oakTask }))
            .toMatchObject({ ok: false, code: "no_knife" });
        expect(validateAction({ type: "fletch" }, ctx, makeObs({ inventory: [knife] }), { resources: oakTask }))
            .toMatchObject({ ok: false, code: "no_logs" });
        expect(validateAction({ type: "fletch" }, ctx, fletchable({ bankOpen: true, bankItems: [] }), { resources: oakTask }))
            .toMatchObject({ ok: false, code: "modal_open" });
        expect(validateAction({ type: "fletch" }, ctx, fletchable(), { resources: { resource: RESOURCES.oak, logCount: 10 } }))
            .toMatchObject({ ok: false, code: "no_bow_set" });
    });

    test("fletch is confirmed by logs used up for bows, not by the call's return value", async () => {
        const before = fletchable({ skillXp: { Fletching: 0 } });
        const after = makeObs({ inventory: [knife, { slot: 1, id: 3, name: "Oak longbow", quantity: 10 }], skillXp: { Fletching: 6250 } });
        const out = classifyOutcome({ type: "fletch", logs: "Oak logs", product: "Oak longbow", menuLabel: "Oak Long Bow", batch: 10 }, before, after, { success: false, reason: "menu_left_open" }, []);
        expect(out.outcome).toBe("confirmed_success");
    });

    test("execution clicks the menu line through the shared knife step", async () => {
        const calls: string[] = [];
        let menuOpen = true;
        const sdk = {
            findInventoryItem: (re: RegExp) => (re.test("Knife") ? { slot: 0 } : re.test("Oak logs") ? { slot: 1 } : null),
            sendUseItemOnItem: async () => { calls.push("knife"); return { success: true }; },
            waitForCondition: async () => {},
            waitForTicks: async () => {},
            getDialog: () => (menuOpen ? { isOpen: true, options: [{ index: 1, text: "Make X" }, { index: 2, text: "Make 10" }, { index: 3, text: "Make 5" }, { index: 4, text: "Oak Long Bow" }] } : { isOpen: false, options: [] }),
            sendClickDialog: async (i: number) => { calls.push(`click:${i}`); menuOpen = false; return { success: true }; },
            countInventoryItems: () => 10,
        };
        const action: ResolvedAction = { type: "fletch", logs: "Oak logs", product: "Oak longbow", menuLabel: "Oak Long Bow", batch: 10 };
        const out = await performAction({}, sdk, action, makeObs());
        expect(calls).toEqual(["knife", "click:2"]);
        expect(out.success).toBe(true);
    });
});

describe("fletch-bank goal: game-side check", () => {
    test("done only after the bows reach the open bank and the bank is closed", () => {
        const goal = fletchBankGoal({ logCount: 10 });
        const at = (over: Parameters<typeof makeObs>[0]) => makeObs(over);
        expect(goal.verifyDone(at({ bankOpen: true, bankItems: bank("Oak longbow", 0) }), at({})).done).toBe(false);
        expect(goal.verifyDone(at({ bankOpen: true, bankItems: bank("Oak longbow", 10) }), at({})).done).toBe(false);
        expect(goal.verifyDone(at({ bankOpen: true, bankItems: bank("Oak longbow", 10) }), at({}))).toMatchObject({ done: false, missing: "the bank closed" });
        expect(goal.verifyDone(at({}), at({})).done).toBe(true);
    });

    test("the goal text names the logs and the bow, and the allowed actions are the fletch set", () => {
        const goal = fletchBankGoal({ logCount: 10 });
        expect(goal.goal).toContain("withdraw 10 oak logs");
        expect(goal.goal).toContain("oak longbows");
        expect([...goal.allowedActions].sort()).toEqual(["close_bank", "deposit_items", "fletch", "open_bank", "wait", "walk_to", "withdraw_logs"]);
    });
});

describe("fletch: partial batches and clearer steps (live run 2026-11-01)", () => {
    const fletchable = (over: Parameters<typeof makeObs>[0] = {}) => makeObs({ inventory: [knife, logs(10)], ...over });

    test("a fletch that made only 3 of 10 bows is partial, not confirmed", () => {
        const before = fletchable({ skillXp: { Fletching: 0 } });
        const after = makeObs({ inventory: [knife, logs(7), { slot: 2, id: 3, name: "Oak longbow", quantity: 3 }], skillXp: { Fletching: 1875 } });
        const out = classifyOutcome({ type: "fletch", logs: "Oak logs", product: "Oak longbow", menuLabel: "Oak Long Bow", batch: 10 }, before, after, { success: true }, []);
        expect(out.outcome).toBe("partial_progress_or_timeout");
        expect(out.reason).toBe("fletch_batch_unfinished");
    });

    test("the fletch action waits until the logs stop going down, so one call makes the batch", async () => {
        let ticks = 0;
        let left = 10;
        const sdk = {
            findInventoryItem: (re: RegExp) => (re.test("Knife") ? { slot: 0 } : re.test("Oak logs") ? { slot: 1 } : null),
            sendUseItemOnItem: async () => ({ success: true }),
            waitForCondition: async () => {},
            waitForTicks: async (n: number) => {
                for (let i = 0; i < n; i++) {
                    ticks++;
                    if (ticks % 4 === 0 && left > 0) left--; // one bow every 4 ticks, as in the live logs
                }
            },
            getDialog: () => (ticks < 3 ? { isOpen: true, options: [{ index: 1, text: "Make X" }, { index: 2, text: "Make 10" }, { index: 3, text: "Make 5" }, { index: 4, text: "Oak Long Bow" }] } : { isOpen: false, options: [] }),
            sendClickDialog: async () => ({ success: true }),
            countInventoryItems: () => left,
        };
        const action: ResolvedAction = { type: "fletch", logs: "Oak logs", product: "Oak longbow", menuLabel: "Oak Long Bow", batch: 10 };
        const out = await performAction({}, sdk, action, makeObs());
        expect(out.success).toBe(true);
        expect(left).toBe(0);
        expect(ticks).toBeGreaterThanOrEqual(40);
    });

    test("messages say what to do next", () => {
        expect(validateAction({ type: "fletch" }, ctx, makeObs({ inventory: [knife, logs(10)], bankOpen: true, bankItems: [] }), { resources: oakTask }))
            .toMatchObject({ ok: false, code: "modal_open", message: expect.stringContaining("Close it (close_bank)") });
        expect(validateAction({ type: "withdraw_logs" }, ctx, makeObs({ bankOpen: true, bankItems: bank("Oak logs", 10), inventory: [logs(7)] }), { resources: oakTask }))
            .toMatchObject({ ok: false, code: "logs_already_carried" });
        expect(validateAction({ type: "deposit_items" }, ctx, makeObs({ bankOpen: true, bankItems: [], inventory: [logs(7)] }), { resources: oakTask }))
            .toMatchObject({ ok: false, code: "nothing_to_deposit", message: expect.stringContaining("Fletch the logs first") });
    });

    test("the done check names the logs still to fletch, and the hint names the next step", () => {
        const goal = fletchBankGoal({ logCount: 10 });
        const left = makeObs({ bankOpen: true, bankItems: [], inventory: [knife, logs(7)] });
        expect(goal.verifyDone(left, makeObs({}))).toMatchObject({ done: false, missing: expect.stringContaining("7 oak logs still to fletch") });
        expect(goal.hintFor?.(left, makeObs({}), {} as HandleMap)).toContain("Close the bank (close_bank), then fletch");
        const bowsOut = makeObs({ bankOpen: false, inventory: [knife, { slot: 1, id: 3, name: "Oak longbow", quantity: 3 }] });
        expect(goal.hintFor?.(bowsOut, makeObs({}), {} as HandleMap)).toContain("Open the bank (open_bank), then deposit_items");
    });
});
