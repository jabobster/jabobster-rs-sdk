import { describe, expect, test } from "bun:test";
import {
    runMineSmeltBank, pickSmeltOption, type MineSmeltOps, type SmeltSite,
    FALADOR_BRONZE, ARDOUGNE_IRON, FALADOR_FURNACE, FALADOR_WEST_BANK, ARDOUGNE_FURNACE, ARDOUGNE_WEST_BANK,
    FALADOR_COPPER_ROCKS, FALADOR_TIN_ROCKS, ARDOUGNE_IRON_ROCKS,
} from "../mineSmelt";
import { SMELT_MAX_COUNT, smeltCount } from "../smeltRules";
import { makeObs } from "./helpers";

interface FakeOpts {
    site?: SmeltSite;
    pickaxe?: boolean;
    /** Mining level the bot has; the site's rock level must be met. */
    miningLevel?: number;
    /** false: mineAt() adds no ore. */
    mineWorks?: boolean;
    /** false: smelt() makes no bar. */
    smeltWorks?: boolean;
    /** false: no bank booth in the snapshot after walking to the bank. */
    bankInView?: boolean;
    bankWorks?: boolean;
    depositWorks?: boolean;
    /** A level-up dialog opens after the first mine, as in the live run. */
    levelUpAfterFirstMine?: boolean;
    /** The first N smelt attempts use the ore and make no bar (iron's game-side failure chance). */
    smeltFailures?: number;
}

/** A tiny game for one site: each action changes state only if its flag says so. */
function fakeGame(opts: FakeOpts = {}) {
    const site = opts.site ?? FALADOR_BRONZE;
    const g = {
        ore: Object.fromEntries(site.ores.map((s) => [s.name, 0])) as Record<string, number>,
        bars: 0, bankBars: 0, bankOpen: false, tick: 100, dialogOpen: false, mines: 0, failuresLeft: opts.smeltFailures ?? 0,
    };
    const calls: string[] = [];
    const records: any[] = [];
    const obs = () => makeObs({
        tick: g.tick,
        inventory: [
            ...((opts.pickaxe ?? true) ? [{ id: 1, slot: 0, name: "Bronze pickaxe", quantity: 1 }] : []),
            ...site.ores.map((s, i) => g.ore[s.name] > 0 ? { id: 10 + i, slot: 1 + i, name: s.name, quantity: g.ore[s.name] } : null)
                .filter((x): x is { id: number; slot: number; name: string; quantity: number } => x != null),
            ...(g.bars > 0 ? [{ id: 4, slot: 5, name: site.barName, quantity: g.bars }] : []),
        ],
        bankOpen: g.bankOpen,
        interfaceOpen: g.bankOpen,
        bankItems: g.bankOpen ? [{ id: 4, name: site.barName, quantity: g.bankBars }] : null,
        dialog: { isOpen: g.dialogOpen, isWaiting: false, pageId: null, text: g.dialogOpen ? "Congratulations, you just advanced a Mining level." : "", options: [] },
        locs: {
            trees: [],
            bankBooths: (opts.bankInView ?? true) ? [{ id: 8, name: "Bank booth", x: site.bank.x, z: site.bank.z, distance: 4 }] : [],
        },
    });
    const ops: MineSmeltOps = {
        observe: async () => { g.tick++; return obs(); },
        startProblems: (s) => {
            const problems: string[] = [];
            if (!(opts.pickaxe ?? true)) problems.push("no pickaxe in inventory or equipment");
            if ((opts.miningLevel ?? 99) < s.miningLevel) problems.push(`Mining below ${s.miningLevel}`);
            return problems;
        },
        walkTo: async (x, z) => { calls.push(`walk ${x},${z}`); return { success: true }; },
        mineAt: async (x, z) => {
            calls.push(`mine ${x},${z}`);
            const spec = site.ores.find((s) => s.rocks.some((r) => r.x === x && r.z === z));
            if (spec && (opts.mineWorks ?? true)) g.ore[spec.name]++;
            g.mines++;
            if (opts.levelUpAfterFirstMine && g.mines === 1) g.dialogOpen = true;
            return { success: true };
        },
        smelt: async (product, batch) => {
            calls.push(`smelt ${product} ${batch}`);
            if (!(opts.smeltWorks ?? true)) return { success: true };
            // One batch uses up to `batch` of each ore; each ore used either makes a bar or is a failed smelt.
            const n = Math.min(batch, ...site.ores.map((s) => g.ore[s.name]));
            if (n <= 0) return { success: true };
            for (const s of site.ores) g.ore[s.name] -= n;
            for (let i = 0; i < n; i++) {
                if (g.failuresLeft > 0) g.failuresLeft--;
                else g.bars++;
            }
            return { success: true };
        },
        scanLocs: async () => { calls.push("scan"); return {}; },
        openBank: async () => {
            calls.push("openBank");
            if (opts.bankWorks ?? true) g.bankOpen = true;
            return { success: opts.bankWorks ?? true };
        },
        deposit: async () => {
            calls.push("deposit");
            if ((opts.depositWorks ?? true) && g.bankOpen) { g.bankBars += g.bars; g.bars = 0; }
            return { success: true };
        },
        closeBank: async () => { calls.push("closeBank"); g.bankOpen = false; return { success: true }; },
        clearBlocking: async () => { calls.push("clearBlocking"); g.dialogOpen = false; return {}; },
        settle: async () => { g.tick++; return obs(); },
        record: async (entry) => { records.push(entry); },
    };
    return { ops, g, calls, records };
}

describe("mine -> smelt -> bank routine, Falador bronze", () => {
    test("happy path: pairs of copper and tin, bars smelted and banked", async () => {
        const game = fakeGame();
        const result = await runMineSmeltBank(game.ops, { site: FALADOR_BRONZE, pairs: 3 });
        expect(result.stopReason).toBe("goal_met");
        expect(result.mined["Copper ore"]).toBe(3);
        expect(result.mined["Tin ore"]).toBe(3);
        expect(game.g.bankBars).toBe(3);
        expect(game.g.bars).toBe(0);
        expect(game.g.bankOpen).toBe(false);
    });

    test("mines copper and tin in turn, using the Falador rock tiles", async () => {
        const game = fakeGame();
        await runMineSmeltBank(game.ops, { site: FALADOR_BRONZE, pairs: 2 });
        const mines = game.calls.filter((c) => c.startsWith("mine"));
        expect(mines.length).toBe(4);
        expect(mines[0]).toBe(`mine ${FALADOR_COPPER_ROCKS[0].x},${FALADOR_COPPER_ROCKS[0].z}`);
        expect(mines[1]).toBe(`mine ${FALADOR_TIN_ROCKS[0].x},${FALADOR_TIN_ROCKS[0].z}`);
    });

    test("routine walks to the Falador furnace and west bank", async () => {
        const game = fakeGame();
        await runMineSmeltBank(game.ops, { site: FALADOR_BRONZE, pairs: 1 });
        expect(game.calls).toContain(`walk ${FALADOR_FURNACE.x},${FALADOR_FURNACE.z}`);
        expect(game.calls).toContain(`walk ${FALADOR_WEST_BANK.x},${FALADOR_WEST_BANK.z}`);
    });

    test("no pickaxe stops at start, before any action", async () => {
        const game = fakeGame({ pickaxe: false });
        const result = await runMineSmeltBank(game.ops, { site: FALADOR_BRONZE, pairs: 2 });
        expect(result.stopReason).toBe("start_blocked");
        expect(game.calls.length).toBe(0);
    });

    test("mining that never gives ore stops as unconfirmed, not after the full quota", async () => {
        const game = fakeGame({ mineWorks: false });
        const result = await runMineSmeltBank(game.ops, { site: FALADOR_BRONZE, pairs: 5 });
        expect(result.stopReason).toBe("mine_unconfirmed");
        expect(game.calls.filter((c) => c.startsWith("mine")).length).toBe(3);
    });

    test("smelting that never makes a bar stops as unconfirmed", async () => {
        const game = fakeGame({ smeltWorks: false });
        const result = await runMineSmeltBank(game.ops, { site: FALADOR_BRONZE, pairs: 2 });
        expect(result.stopReason).toBe("smelt_unconfirmed");
        expect(game.calls.filter((c) => c.startsWith("smelt")).length).toBe(3);
    });

    test("no bank booth in view stops before opening the bank", async () => {
        const game = fakeGame({ bankInView: false });
        const result = await runMineSmeltBank(game.ops, { site: FALADOR_BRONZE, pairs: 1 });
        expect(result.stopReason).toBe("no_bank_in_view");
        expect(game.calls).not.toContain("openBank");
    });

    test("failed bank open stops the routine and the bars stay in the pack", async () => {
        const game = fakeGame({ bankWorks: false });
        const result = await runMineSmeltBank(game.ops, { site: FALADOR_BRONZE, pairs: 1 });
        expect(result.stopReason).toBe("open_bank_failed");
        expect(game.g.bars).toBe(1);
        expect(game.calls).not.toContain("deposit");
    });

    test("failed deposit stops the routine before closing the bank", async () => {
        const game = fakeGame({ depositWorks: false });
        const result = await runMineSmeltBank(game.ops, { site: FALADOR_BRONZE, pairs: 1 });
        expect(result.stopReason).toBe("deposit_failed");
        expect(game.calls).not.toContain("closeBank");
    });

    test("a level-up dialog after a mine is cleared before the next step, not a stop", async () => {
        const game = fakeGame({ levelUpAfterFirstMine: true });
        const result = await runMineSmeltBank(game.ops, { site: FALADOR_BRONZE, pairs: 2 });
        expect(result.stopReason).toBe("goal_met");
        expect(game.calls).toContain("clearBlocking");
        expect(game.calls.indexOf("clearBlocking")).toBeGreaterThan(game.calls.indexOf(`mine ${FALADOR_COPPER_ROCKS[0].x},${FALADOR_COPPER_ROCKS[0].z}`));
    });
});

describe("mine -> smelt -> bank routine, Ardougne iron", () => {
    test("happy path: iron ore mined, smelted one-for-one, banked", async () => {
        const game = fakeGame({ site: ARDOUGNE_IRON });
        const result = await runMineSmeltBank(game.ops, { site: ARDOUGNE_IRON, pairs: 4 });
        expect(result.stopReason).toBe("goal_met");
        // 4 bars at a 50% chance needs 8 ore.
        expect(result.mined["Iron ore"]).toBe(8);
        expect(game.g.bankBars).toBe(8);
        // Make-X: all 8 ore go in one call, with the count set to 8.
        expect(game.calls.filter((c) => c.startsWith("smelt Iron")).length).toBe(1);
        expect(game.calls).toContain("smelt Iron 8");
    });

    test("mines only the Ardougne iron rock tiles, and walks to the Ardougne furnace and bank", async () => {
        const game = fakeGame({ site: ARDOUGNE_IRON });
        await runMineSmeltBank(game.ops, { site: ARDOUGNE_IRON, pairs: 2 });
        const mines = game.calls.filter((c) => c.startsWith("mine"));
        expect(mines.length).toBe(4);
        for (const m of mines) {
            const [x, z] = m.replace("mine ", "").split(",").map(Number);
            expect(ARDOUGNE_IRON_ROCKS.some((r) => r.x === x && r.z === z)).toBe(true);
        }
        expect(game.calls).toContain(`walk ${ARDOUGNE_FURNACE.x},${ARDOUGNE_FURNACE.z}`);
        expect(game.calls).toContain(`walk ${ARDOUGNE_WEST_BANK.x},${ARDOUGNE_WEST_BANK.z}`);
    });

    test("failed iron smelts lose the ore, are counted, and do not stop the routine", async () => {
        const game = fakeGame({ site: ARDOUGNE_IRON, smeltFailures: 2 });
        const result = await runMineSmeltBank(game.ops, { site: ARDOUGNE_IRON, pairs: 4 });
        expect(result.stopReason).toBe("goal_met");
        expect(result.smeltFailed).toBe(2);
        expect(result.barsDeposited).toBe(6);
        expect(game.g.ore["Iron ore"]).toBe(0);
    });

    test("mining level below 15 stops at start for iron, before any action", async () => {
        const game = fakeGame({ site: ARDOUGNE_IRON, miningLevel: 14 });
        const result = await runMineSmeltBank(game.ops, { site: ARDOUGNE_IRON, pairs: 2 });
        expect(result.stopReason).toBe("start_blocked");
        expect(game.calls.length).toBe(0);
    });
});

describe("pickSmeltOption", () => {
    // The live menu, as logged: escaped newlines in the product lines.
    const live = [
        { index: 1, text: "Smelt X Bronze" },
        { index: 2, text: "Smelt 10 Bronze" },
        { index: 3, text: "Smelt 5 Bronze" },
        { index: 4, text: "\\n\\n\\n\\nBronze" },
        { index: 5, text: "Smelt X Iron" },
        { index: 6, text: "Smelt 10 Iron" },
        { index: 7, text: "Smelt 5 Iron" },
        { index: 8, text: "\\n\\n\\n\\nIron" },
    ];

    test("picks the bronze product line, not a Smelt X / 10 / 5 line", () => {
        expect(pickSmeltOption(live, "Bronze")?.index).toBe(4);
        expect(pickSmeltOption([{ index: 1, text: "Smelt X Bronze" }, { index: 2, text: "Smelt 10 Bronze" }], "Bronze")).toBeNull();
    });

    test("picks the iron product line for an iron site", () => {
        expect(pickSmeltOption(live, "Iron")?.index).toBe(8);
    });

    test("any count above one picks Make-X (Smelt X), not the fixed 10 or 5 lines", () => {
        expect(pickSmeltOption(live, "Iron", 10)?.index).toBe(5);
        expect(pickSmeltOption(live, "Iron", 28)?.index).toBe(5);
        expect(pickSmeltOption(live, "Bronze", 7)?.index).toBe(1);
    });

    test("a count of one picks the product line", () => {
        expect(pickSmeltOption(live, "Iron", 1)?.index).toBe(8);
    });
});

describe("smeltCount (Make-X quantity)", () => {
    test("takes all the ore the pack has, up to the 28 cap", () => {
        expect(SMELT_MAX_COUNT).toBe(28);
        expect(smeltCount(20)).toBe(20);
        expect(smeltCount(28)).toBe(28);
        expect(smeltCount(40)).toBe(28);
        expect(smeltCount(1)).toBe(1);
        expect(smeltCount(0)).toBe(0);
    });
});
