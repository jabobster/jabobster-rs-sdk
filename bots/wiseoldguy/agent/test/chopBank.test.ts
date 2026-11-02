import { describe, expect, test } from "bun:test";
import { runChopBank, type RoutineOps } from "../chopBank";
import { makeObs } from "./helpers";

interface FakeOpts {
    chopWorks?: boolean;
    /** What chop() reports to the routine, independent of what happened in the game. */
    chopReport?: unknown;
    bankWorks?: boolean;
    depositWorks?: boolean;
    startProblems?: string[];
    dialogOpen?: boolean;
    target?: number;
    /** false: no oak tree in the location snapshot. */
    oakInView?: boolean;
    /** false: no bank booth in the location snapshot after the walk to the bank. */
    bankInView?: boolean;
    /** Logs already in the pack at the start. */
    startLogs?: number;
    /** Distance to the closest bank booth in the snapshot. */
    boothDistance?: number;
}

/** A tiny game: each stub action changes state only if its flag says the action works. */
function fakeGame(opts: FakeOpts = {}) {
    const g = { logs: opts.startLogs ?? 0, bankLogs: 0, bankOpen: false, interfaceOpen: false, tick: 100 };
    const calls: string[] = [];
    const records: any[] = [];
    const obs = () => makeObs({
        tick: g.tick,
        inventory: [
            { id: 2, slot: 0, name: "Bronze axe", quantity: 1 },
            ...(g.logs > 0 ? [{ id: 1, slot: 1, name: "Oak logs", quantity: g.logs }] : []),
        ],
        bankOpen: g.bankOpen,
        interfaceOpen: g.interfaceOpen,
        bankItems: g.bankOpen ? [{ id: 1, name: "Oak logs", quantity: g.bankLogs }] : null,
        dialog: { isOpen: opts.dialogOpen ?? false, isWaiting: false, pageId: null, text: "", options: [] },
        locs: {
            trees: (opts.oakInView ?? true) ? [{ id: 9, name: "Oak", x: 3166, z: 3416, distance: 3 }] : [],
            bankBooths: (opts.bankInView ?? true)
                ? [{ id: 8, name: "Bank booth", x: 3185, z: 3436, distance: opts.boothDistance ?? 12 }]
                : [],
        },
    });
    const ops: RoutineOps = {
        observe: async () => { g.tick++; return obs(); },
        startProblems: () => opts.startProblems ?? [],
        walkToOakSpot: async () => { calls.push("walk"); return { success: true }; },
        chop: async () => {
            calls.push("chop");
            if (opts.chopWorks ?? true) g.logs++;
            return opts.chopReport ?? { success: true };
        },
        openBank: async () => {
            calls.push("openBank");
            if (opts.bankWorks ?? true) { g.bankOpen = true; g.interfaceOpen = true; }
            return { success: opts.bankWorks ?? true };
        },
        deposit: async () => {
            calls.push("deposit");
            if (opts.depositWorks ?? true) { g.bankLogs += g.logs; g.logs = 0; }
            return { success: true };
        },
        closeBank: async () => {
            calls.push("closeBank");
            g.bankOpen = false; g.interfaceOpen = false;
            return { success: true };
        },
        scanLocs: async () => { return { success: true }; },
        walkToBank: async () => { calls.push("walkBank"); return { success: true }; },
        settle: async () => obs(),
        record: async (e) => { records.push(e); },
    };
    return { ops, g, calls, records };
}

const opts = { targetLogs: 5, chopSettleTicks: 0, bankSettleTicks: 0 };

describe("chop -> bank routine", () => {
    test("happy path: gathers the target, banks it, closes the bank, and reports goal_met", async () => {
        const game = fakeGame();
        const result = await runChopBank(game.ops, opts);
        expect(result.stopReason).toBe("goal_met");
        expect(result.logsGathered).toBe(5);
        expect(result.logsDeposited).toBe(5);
        expect(game.g.bankLogs).toBe(5);
        expect(game.g.logs).toBe(0);
        expect(game.g.bankOpen).toBe(false);
        expect(game.calls).toEqual(["walk", "chop", "chop", "chop", "chop", "chop", "walkBank", "openBank", "deposit", "closeBank"]);
        expect(game.records.at(-1)).toMatchObject({ kind: "routine_end", stopReason: "goal_met" });
    });

    test("a chop whose SDK call times out still counts when the log arrives (state decides)", async () => {
        const game = fakeGame({ chopReport: { success: false, reason: "timeout" }, target: 2 });
        const result = await runChopBank(game.ops, { ...opts, targetLogs: 2 });
        expect(result.stopReason).toBe("goal_met");
        expect(game.records.find((r) => r.capability === "woodcutting")?.sdk).toMatchObject({ reason: "timeout" });
    });

    test("stops after three chops in a row that gain nothing", async () => {
        const game = fakeGame({ chopWorks: false });
        const result = await runChopBank(game.ops, opts);
        expect(result.stopReason).toBe("chop_unconfirmed");
        expect(game.calls.filter((c) => c === "chop")).toHaveLength(3);
        expect(game.calls).not.toContain("openBank");
    });

    test("stops before chopping when no oak is in the location snapshot", async () => {
        const game = fakeGame({ oakInView: false });
        const result = await runChopBank(game.ops, opts);
        expect(result.stopReason).toBe("no_oak_in_view");
        expect(game.calls).toEqual(["walk"]);
    });

    test("logs already in the pack do not count toward the target", async () => {
        const game = fakeGame({ startLogs: 16 });
        const result = await runChopBank(game.ops, opts);
        expect(result.stopReason).toBe("goal_met");
        expect(result.logsGathered).toBe(5);
        expect(game.calls.filter((c) => c === "chop")).toHaveLength(5);
    });

    test("stops when no bank booth is in view after walking to the bank", async () => {
        const game = fakeGame({ bankInView: false });
        const result = await runChopBank(game.ops, opts);
        expect(result.stopReason).toBe("no_bank_in_view");
        expect(game.calls).not.toContain("openBank");
    });

    test("logs the closest bank booth before opening the bank", async () => {
        const game = fakeGame({ boothDistance: 12 });
        await runChopBank(game.ops, opts);
        expect(game.records.find((r) => r.action === "booth_check")?.nearestBooth)
            .toMatchObject({ name: "Bank booth", distance: 12 });
    });

    test("stops when the bank does not open, and never tries to deposit", async () => {
        const game = fakeGame({ bankWorks: false });
        const result = await runChopBank(game.ops, opts);
        expect(result.stopReason).toBe("open_bank_failed");
        expect(game.calls).not.toContain("deposit");
    });

    test("stops when the deposit moves nothing", async () => {
        const game = fakeGame({ depositWorks: false });
        const result = await runChopBank(game.ops, opts);
        expect(result.stopReason).toBe("deposit_failed");
        expect(game.calls).not.toContain("closeBank");
        expect(game.g.logs).toBe(5);
    });

    test("records game ticks per step and for the whole run", async () => {
        const game = fakeGame();
        await runChopBank(game.ops, opts);
        const steps = game.records.filter((r) => r.kind === "routine_step" && r.status !== "blocked");
        expect(steps.length).toBeGreaterThan(0);
        for (const s of steps) expect(s.ticks).toBe(s.tickAfter - s.tickBefore);
        const end = game.records.at(-1);
        expect(typeof end.ticks).toBe("number");
        expect(end.ticks).toBeGreaterThan(0);
    });

    test("blocked start: nothing is sent to the game", async () => {
        const game = fakeGame({ startProblems: ["no axe in inventory or equipment"] });
        const result = await runChopBank(game.ops, opts);
        expect(result.stopReason).toBe("start_blocked");
        expect(result.detail).toContain("no axe");
        expect(game.calls).toEqual([]);
    });

    test("a dialog open before chopping blocks the chop", async () => {
        const game = fakeGame({ dialogOpen: true });
        const result = await runChopBank(game.ops, opts);
        expect(result.stopReason).toBe("chop_blocked");
        expect(result.detail).toContain("a dialog is open");
        expect(game.calls).toEqual(["walk"]);
    });
});
