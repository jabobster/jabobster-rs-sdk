import { describe, expect, test } from "bun:test";
import { runFletchBank, chooseProduct, fletchWithMenu, LONGBOW_PRODUCT, SHORTBOW_PRODUCT, type FletchOps } from "../fletchBank";
import { makeObs } from "./helpers";

interface FakeOpts {
    knife?: boolean;
    level?: number;
    bankLogs?: number;
    startLogs?: number;
    invUsed?: number;
    bankInView?: boolean;
    bankWorks?: boolean;
    withdrawWorks?: boolean;
    fletchWorks?: boolean;
    /** A batch of ten uses only one log, as if a level-up interrupted it. */
    batchTenInterrupted?: boolean;
    depositWorks?: boolean;
}

/** A small game: logs and bows are one inventory entry each (they do not stack), like the real pack. */
function fakeGame(opts: FakeOpts = {}) {
    const product = chooseProduct(opts.level ?? 25);
    const g = { bankLogs: opts.bankLogs ?? 10, logs: opts.startLogs ?? 0, bows: 0, bankBows: 0, bankOpen: false, interfaceOpen: false, tick: 100, xp: 0 };
    const calls: string[] = [];
    const records: any[] = [];
    const fletchCalls: Array<{ label: string; batch: number }> = [];
    const obs = () => makeObs({
        tick: g.tick,
        inventory: [
            ...((opts.knife ?? true) ? [{ id: 946, slot: 0, name: "Knife", quantity: 1 }] : []),
            ...Array.from({ length: opts.invUsed ?? 0 }, (_, i) => ({ id: 2, slot: 30 + i, name: "Bronze axe", quantity: 1 })),
            ...Array.from({ length: g.logs }, (_, i) => ({ id: 1, slot: 1 + i, name: "Oak logs", quantity: 1 })),
            ...(product ? Array.from({ length: g.bows }, (_, i) => ({ id: 3, slot: 10 + i, name: product, quantity: 1 })) : []),
        ],
        bankOpen: g.bankOpen,
        interfaceOpen: g.interfaceOpen,
        bankItems: g.bankOpen && product
            ? [{ id: 1, name: "Oak logs", quantity: g.bankLogs }, { id: 3, name: product, quantity: g.bankBows }]
            : null,
        skillXp: { Fletching: g.xp },
        locs: {
            trees: [],
            bankBooths: (opts.bankInView ?? true) ? [{ id: 8, name: "Bank booth", x: 3185, z: 3436, distance: 6 }] : [],
        },
    });
    const ops: FletchOps = {
        observe: async () => { g.tick++; return obs(); },
        fletchingLevel: () => opts.level ?? 25,
        walkToBank: async () => { calls.push("walk"); return { success: true }; },
        scanLocs: async () => ({ success: true }),
        openBank: async () => {
            calls.push("openBank");
            const ok = opts.bankWorks ?? true;
            if (ok) { g.bankOpen = true; g.interfaceOpen = true; }
            return { success: ok };
        },
        withdraw: async (_item, amount) => {
            calls.push("withdraw");
            if (opts.withdrawWorks ?? true) { const n = Math.min(amount, g.bankLogs); g.bankLogs -= n; g.logs += n; }
            return { success: true };
        },
        closeBank: async () => {
            calls.push("closeBank");
            g.bankOpen = false; g.interfaceOpen = false;
            return { success: true };
        },
        fletch: async (label, batch) => {
            calls.push("fletch");
            fletchCalls.push({ label, batch });
            if (opts.fletchWorks ?? true) {
                const used = opts.batchTenInterrupted && batch >= 10 ? Math.min(1, g.logs) : Math.min(batch, g.logs);
                g.logs -= used; g.bows += used; g.xp += 5 * used;
            }
            return { success: true };
        },
        deposit: async () => {
            calls.push("deposit");
            if (opts.depositWorks ?? true) { g.bankBows += g.bows; g.bows = 0; }
            return { success: true };
        },
        settle: async () => obs(),
        record: async (e) => { records.push(e); },
    };
    return { ops, g, calls, records, product, fletchCalls };
}

const opts = { targetLogs: 10, settleTicks: 0, bankSettleTicks: 0 };

/** Fake SDK for the knife menu: a knife, logs, and a dialog with the given options. */
function menuSdk(options: Array<{ index: number; text: string }>) {
    const clicked: number[] = [];
    return {
        clicked,
        findInventoryItem: (p: RegExp) => (/knife/i.test(p.source) ? { slot: 0 } : { slot: 1 }),
        sendUseItemOnItem: async () => ({ success: true, message: "used" }),
        waitForCondition: async () => ({}),
        getDialog: () => ({ isOpen: true, options }),
        sendClickDialog: async (index: number) => { clicked.push(index); return { success: true, message: "" }; },
    };
}

describe("bank -> fletch -> bank routine", () => {
    test("happy path: withdraws, fletches each log, banks every bow, and reports goal_met", async () => {
        const game = fakeGame();
        const result = await runFletchBank(game.ops, opts);
        expect(result.stopReason).toBe("goal_met");
        expect(result.product).toBe(LONGBOW_PRODUCT);
        expect(result.logsWithdrawn).toBe(10);
        expect(result.bowsMade).toBe(10);
        expect(result.bowsDeposited).toBe(10);
        expect(game.g.bankBows).toBe(10);
        expect(game.g.bankLogs).toBe(0);
        expect(game.g.logs).toBe(0);
        expect(game.g.bankOpen).toBe(false);
        // ten logs at once: one "Make 10" call
        expect(game.fletchCalls).toEqual([{ label: "Oak Long Bow", batch: 10 }]);
        expect(game.calls).toEqual(["walk", "openBank", "withdraw", "closeBank", "fletch", "openBank", "deposit", "closeBank"]);
    });

    test("takes only what the bank holds when it has fewer logs than the target", async () => {
        const game = fakeGame({ bankLogs: 4 });
        const result = await runFletchBank(game.ops, opts);
        expect(result.stopReason).toBe("goal_met");
        expect(result.bowsDeposited).toBe(4);
    });

    test("fewer than ten logs still uses Make 10: one call makes what is in the pack", async () => {
        const game = fakeGame({ bankLogs: 7 });
        const result = await runFletchBank(game.ops, opts);
        expect(result.stopReason).toBe("goal_met");
        expect(game.fletchCalls).toEqual([{ label: "Oak Long Bow", batch: 10 }]);
    });

    test("an interrupted Make 10 is simply called again for the logs left", async () => {
        const game = fakeGame({ bankLogs: 10, batchTenInterrupted: true });
        const result = await runFletchBank(game.ops, opts);
        expect(result.stopReason).toBe("goal_met");
        expect(game.fletchCalls.length).toBe(10);
        expect(game.fletchCalls.every((c) => c.batch === 10)).toBe(true);
    });


    test("a level-up prompt cleared between calls is written to the decisions log", async () => {
        const game = fakeGame({ bankLogs: 4 });
        let once = true;
        game.ops.clearPrompt = async () => (once ? (once = false, { cleared: 1, blocking: null }) : { cleared: 0, blocking: null });
        await runFletchBank(game.ops, opts);
        expect(game.records.some((r) => r.kind === "routine_prompt" && r.cleared === 1)).toBe(true);
    });

    test("a dialog left open after the last bow is cleared before the bank is opened", async () => {
        const game = fakeGame({ bankLogs: 4 });
        game.ops.clearPrompt = async () => { game.calls.push("clearPrompt"); return { cleared: 0, blocking: null }; };
        await runFletchBank(game.ops, opts);
        const lastFletch = game.calls.lastIndexOf("fletch");
        const clearBeforeBank = game.calls.indexOf("clearPrompt", lastFletch);
        const bankAfter = game.calls.indexOf("openBank", lastFletch);
        expect(clearBeforeBank).toBeGreaterThan(-1);
        expect(clearBeforeBank).toBeLessThan(bankAfter);
    });

    test("the under-ten case also uses Make 10 for every call", async () => {
        const game = fakeGame({ bankLogs: 4 });
        await runFletchBank(game.ops, opts);
        expect(game.fletchCalls).toEqual([{ label: "Oak Long Bow", batch: 10 }]);
    });

    test("takes only the free slots when the pack is nearly full", async () => {
        // knife + 25 axes = 26 entries, so 2 slots are free
        const game = fakeGame({ invUsed: 25 });
        const result = await runFletchBank(game.ops, opts);
        expect(result.stopReason).toBe("goal_met");
        expect(result.logsWithdrawn).toBe(2);
    });

    test("level 20 to 24 makes shortbows; 25 and up makes longbows", () => {
        expect(chooseProduct(19)).toBeNull();
        expect(chooseProduct(20)).toBe(SHORTBOW_PRODUCT);
        expect(chooseProduct(24)).toBe(SHORTBOW_PRODUCT);
        expect(chooseProduct(25)).toBe(LONGBOW_PRODUCT);
        expect(chooseProduct(null)).toBeNull();
    });

    test("a shortbow level uses the shortbow product for the fletch step", async () => {
        const game = fakeGame({ level: 22 });
        const result = await runFletchBank(game.ops, opts);
        expect(result.product).toBe(SHORTBOW_PRODUCT);
        const fletchStep = game.records.find((r) => r.capability === "fletching");
        expect(fletchStep.args.product).toBe(SHORTBOW_PRODUCT);
    });

    test("fletch asks the menu by the label the SDK lists, not the item name", async () => {
        const game = fakeGame({ level: 25 });
        await runFletchBank(game.ops, opts);
        expect(game.fletchCalls.every((c) => c.label === "Oak Long Bow")).toBe(true);
    });

    test("menu: clicks Make 10 (two lines above the product) for a batch of ten", async () => {
        const menu = [
            { index: 1, text: "Make X" }, { index: 2, text: "Make 10" }, { index: 3, text: "Make 5" }, { index: 4, text: "\n\n\n\nOak Short Bow" },
            { index: 5, text: "Make X" }, { index: 6, text: "Make 10" }, { index: 7, text: "Make 5" }, { index: 8, text: "\n\n\n\nOak Long Bow" },
        ];
        const fake = menuSdk(menu);
        const result = await fletchWithMenu(fake, "Oak Long Bow", 10);
        expect(result.success).toBe(true);
        expect(fake.clicked).toEqual([6]);
    });

    test("menu: clicks the product line itself for a single bow", async () => {
        const fake = menuSdk([{ index: 1, text: "Make X" }, { index: 2, text: "Make 10" }, { index: 3, text: "Make 5" }, { index: 4, text: "Oak Long Bow" }]);
        await fletchWithMenu(fake, "Oak Long Bow", 1);
        expect(fake.clicked).toEqual([4]);
    });

    test("menu: clicks Make 5 (one line above the product) for a batch of five", async () => {
        const fake = menuSdk([
            { index: 1, text: "Make X" }, { index: 2, text: "Make 10" }, { index: 3, text: "Make 5" }, { index: 4, text: "Oak Short Bow" },
            { index: 5, text: "Make X" }, { index: 6, text: "Make 10" }, { index: 7, text: "Make 5" }, { index: 8, text: "Oak Long Bow" },
        ]);
        const result = await fletchWithMenu(fake, "Oak Long Bow", 5);
        expect(result.success).toBe(true);
        expect(fake.clicked).toEqual([7]);
    });

    test("menu: a level-up prompt is clicked away and nothing else is picked", async () => {
        const fake = menuSdk([{ index: 9, text: "\\n\\nClick here to continue" }]);
        const result = await fletchWithMenu(fake, "Oak Long Bow", 10);
        expect(result.reason).toBe("continue_dismissed");
        expect(fake.clicked).toEqual([9]);
    });

    test("menu: the live text with literal backslash-n sequences still matches", async () => {
        // exactly as the SDK reported it in the live run: the characters \ and n, not newlines
        const literal = "\\n\\n\\n\\nOak Long Bow";
        const fake = menuSdk([
            { index: 1, text: "Make X" }, { index: 2, text: "Make 10" }, { index: 3, text: "Make 5" }, { index: 4, text: "\\n\\n\\n\\nOak Short Bow" },
            { index: 5, text: "Make X" }, { index: 6, text: "Make 10" }, { index: 7, text: "Make 5" }, { index: 8, text: literal },
        ]);
        const result = await fletchWithMenu(fake, "Oak Long Bow", 10);
        expect(result.success).toBe(true);
        expect(fake.clicked).toEqual([6]);
    });

    test("menu: a different layout stops before any click", async () => {
        const fake = menuSdk([{ index: 1, text: "Oak Long Bow" }]);
        const result = await fletchWithMenu(fake, "Oak Long Bow", 10);
        expect(result.reason).toBe("menu_mismatch");
        expect(fake.clicked).toEqual([]);
    });

    test("menu: a product not in the menu stops before any click", async () => {
        const fake = menuSdk([{ index: 1, text: "Make 10" }, { index: 2, text: "Oak Short Bow" }]);
        const result = await fletchWithMenu(fake, "Oak Long Bow", 10);
        expect(result.reason).toBe("product_not_listed");
        expect(fake.clicked).toEqual([]);
    });

    test("blocked start: no knife means nothing is sent to the game", async () => {
        const game = fakeGame({ knife: false });
        const result = await runFletchBank(game.ops, opts);
        expect(result.stopReason).toBe("start_blocked");
        expect(result.detail).toContain("no knife");
        expect(game.calls).toEqual([]);
    });

    test("blocked start: Fletching below the bow level", async () => {
        const game = fakeGame({ level: 19 });
        const result = await runFletchBank(game.ops, opts);
        expect(result.stopReason).toBe("start_blocked");
        expect(result.detail).toContain("Fletching 19");
        expect(game.calls).toEqual([]);
    });

    test("blocked start: logs already carried would be fletched and counted", async () => {
        const game = fakeGame({ startLogs: 2 });
        const result = await runFletchBank(game.ops, opts);
        expect(result.stopReason).toBe("start_blocked");
        expect(result.detail).toContain("already carrying 2 oak logs");
    });

    test("stops with no_bank_in_view when no booth is in the scan", async () => {
        const game = fakeGame({ bankInView: false });
        const result = await runFletchBank(game.ops, opts);
        expect(result.stopReason).toBe("no_bank_in_view");
        expect(game.calls).toEqual(["walk"]);
    });

    test("stops when the bank does not open", async () => {
        const game = fakeGame({ bankWorks: false });
        const result = await runFletchBank(game.ops, opts);
        expect(result.stopReason).toBe("open_bank_failed");
        expect(game.calls).not.toContain("withdraw");
    });

    test("stops when the bank holds no oak logs", async () => {
        const game = fakeGame({ bankLogs: 0 });
        const result = await runFletchBank(game.ops, opts);
        expect(result.stopReason).toBe("no_logs_in_bank");
        expect(game.calls).not.toContain("withdraw");
    });

    test("stops when the withdraw moves nothing", async () => {
        const game = fakeGame({ withdrawWorks: false });
        const result = await runFletchBank(game.ops, opts);
        expect(result.stopReason).toBe("withdraw_failed");
        expect(game.calls).not.toContain("fletch");
    });

    test("stops after three fletches in a row that make nothing", async () => {
        const game = fakeGame({ fletchWorks: false });
        const result = await runFletchBank(game.ops, opts);
        expect(result.stopReason).toBe("fletch_unconfirmed");
        expect(game.calls.filter((c) => c === "fletch")).toHaveLength(3);
        expect(game.calls).not.toContain("deposit");
    });

    test("stops when the deposit moves nothing, and keeps the bows in the pack", async () => {
        const game = fakeGame({ depositWorks: false });
        const result = await runFletchBank(game.ops, opts);
        expect(result.stopReason).toBe("deposit_failed");
        expect(game.g.bows).toBe(10);
    });
});
