// Model-facing mine_rock and smelt actions: validation (state checks) and the Make-X count.
import { describe, expect, test } from "bun:test";
import type { HandleMap, ModelView } from "../contract";
import { validateAction } from "../validate";
import { DEFAULT_RESOURCES, type TaskResources } from "../resources";
import { ARDOUGNE_IRON, FALADOR_BRONZE, FALADOR_COPPER_ROCKS, FALADOR_TIN_ROCKS, FALADOR_FURNACE } from "../mineSmelt";
import { DEPLETED_TICKS, DepletedRocks, batchOreTarget } from "../smeltRules";
import { classifyOutcome } from "../classify";
import { fillSmeltTemplate, mineSmeltGoal } from "../goals";
import { makeObs } from "./helpers";

const ctx = { view: {} as ModelView, handles: { npcs: {}, items: {}, dialogOptions: {} } as unknown as HandleMap };
const bronzeTask: TaskResources = { ...DEFAULT_RESOURCES, smelt: { site: FALADOR_BRONZE, bars: 10 } };
const ironTask: TaskResources = { ...DEFAULT_RESOURCES, smelt: { site: ARDOUGNE_IRON, bars: 10 } };

const ore = (name: string, quantity: number) => ({ id: 900, slot: 1, name, quantity });
const rock = (x: number, z: number, distance = 5) => ({ id: 2091, name: "Rocks", x, z, distance });
const furnace = (x: number, z: number) => ({ id: 2781, name: "Furnace", x, z, distance: 3 });

describe("mine_rock validation", () => {
    test("rejected when the task does not mine", () => {
        expect(validateAction({ type: "mine_rock" }, ctx, makeObs(), {}))
            .toMatchObject({ ok: false, code: "action_not_allowed" });
    });

    test("picks the ore furthest behind and a rock on that ore's tiles", () => {
        const fresh = makeObs({
            inventory: [ore("Copper ore", 3)],
            locs: { trees: [], bankBooths: [], rocks: [rock(FALADOR_TIN_ROCKS[0].x, FALADOR_TIN_ROCKS[0].z), rock(FALADOR_COPPER_ROCKS[0].x, FALADOR_COPPER_ROCKS[0].z)] },
        });
        const v = validateAction({ type: "mine_rock" }, ctx, fresh, { resources: bronzeTask });
        // No tin yet, so tin is furthest behind.
        expect(v).toMatchObject({ ok: true, action: { type: "mine_rock", ore: "Tin ore", x: FALADOR_TIN_ROCKS[0].x, z: FALADOR_TIN_ROCKS[0].z } });
    });

    test("no rock on this site in view is rejected", () => {
        const fresh = makeObs({ locs: { trees: [], bankBooths: [], rocks: [rock(3000, 3000)] } });
        expect(validateAction({ type: "mine_rock" }, ctx, fresh, { resources: bronzeTask }))
            .toMatchObject({ ok: false, code: "no_rock_in_view" });
    });

    test("nearest in-site rock wins when several are in view", () => {
        const near = FALADOR_COPPER_ROCKS[1];
        const far = FALADOR_COPPER_ROCKS[0];
        const fresh = makeObs({
            locs: { trees: [], bankBooths: [], rocks: [rock(far.x, far.z, 9), rock(near.x, near.z, 2)] },
        });
        const v = validateAction({ type: "mine_rock" }, ctx, fresh, { resources: bronzeTask });
        expect(v).toMatchObject({ ok: true, action: { x: near.x, z: near.z } });
    });

    test("nothing to mine once every ore is at target", () => {
        // 10 bars of bronze: a batch is 14 copper and 14 tin (10 plus the smelt margin).
        const fresh = makeObs({ inventory: [ore("Copper ore", 14), ore("Tin ore", 14)] });
        expect(validateAction({ type: "mine_rock" }, ctx, fresh, { resources: bronzeTask }))
            .toMatchObject({ ok: false, code: "nothing_to_mine" });
    });

    test("iron target is doubled for the 50% smelt chance", () => {
        // 10 bars of iron at 50% needs 20 ore; with the margin a batch is 28. 27 is still short.
        const fresh = makeObs({ inventory: [ore("Iron ore", 27)], locs: { trees: [], bankBooths: [], rocks: [] } });
        expect(validateAction({ type: "mine_rock" }, ctx, fresh, { resources: ironTask }))
            .toMatchObject({ ok: false, code: "no_rock_in_view" });
        const done = makeObs({ inventory: [ore("Iron ore", 28)] });
        expect(validateAction({ type: "mine_rock" }, ctx, done, { resources: ironTask }))
            .toMatchObject({ ok: false, code: "nothing_to_mine" });
    });

    test("a full pack blocks mining", () => {
        const full = Array.from({ length: 28 }, (_, i) => ({ slot: i, id: 100 + i, name: `Item${i}`, quantity: 1 }));
        expect(validateAction({ type: "mine_rock" }, ctx, makeObs({ inventory: full }), { resources: bronzeTask }))
            .toMatchObject({ ok: false, code: "inventory_full" });
    });

    test("an open bank blocks mining (modal)", () => {
        expect(validateAction({ type: "mine_rock" }, ctx, makeObs({ bankOpen: true, bankItems: [] }), { resources: bronzeTask }))
            .toMatchObject({ ok: false, code: "modal_open" });
    });
});

describe("smelt validation", () => {
    test("rejected when the task does not smelt", () => {
        expect(validateAction({ type: "smelt" }, ctx, makeObs(), {})).toMatchObject({ ok: false, code: "action_not_allowed" });
    });

    test("needs the site furnace in view", () => {
        const fresh = makeObs({ inventory: [ore("Copper ore", 4), ore("Tin ore", 4)], locs: { trees: [], bankBooths: [], furnaces: [] } });
        expect(validateAction({ type: "smelt" }, ctx, fresh, { resources: bronzeTask }))
            .toMatchObject({ ok: false, code: "no_furnace_in_view" });
    });

    test("needs ore; bronze needs both copper and tin", () => {
        const onlyCopper = makeObs({ inventory: [ore("Copper ore", 4)], locs: { trees: [], bankBooths: [], furnaces: [furnace(FALADOR_FURNACE.x, FALADOR_FURNACE.z)] } });
        expect(validateAction({ type: "smelt" }, ctx, onlyCopper, { resources: bronzeTask }))
            .toMatchObject({ ok: false, code: "no_ore_to_smelt" });
    });

    test("Make-X count is the smallest ore pile, so bronze smelts pairs", () => {
        const fresh = makeObs({
            inventory: [ore("Copper ore", 8), ore("Tin ore", 7)],
            locs: { trees: [], bankBooths: [], furnaces: [furnace(FALADOR_FURNACE.x, FALADOR_FURNACE.z)] },
        });
        const fiveBars: TaskResources = { ...DEFAULT_RESOURCES, smelt: { site: FALADOR_BRONZE, bars: 5 } };
        // 5 bars: batch target 7 each. The smallest pile (tin, 7) sets the count.
        expect(validateAction({ type: "smelt" }, ctx, fresh, { resources: fiveBars })).toMatchObject({
            ok: true,
            action: { type: "smelt", product: "Bronze", bar: "Bronze bar", ores: ["Copper ore", "Tin ore"], count: 7 },
        });
    });

    test("smelt goes ahead with ore within slack of the batch (25 of 27 iron ore): no mine/smelt loop", () => {
        // Regression, 2026-11-02 runs bc13 and 44f2: 25 ore with a bronze pickaxe in the pack. The stage rule allowed
        // smelt, but the smelt gate refused on any shortage ("need 2 more") while mining was not allowed at the furnace.
        const fresh = makeObs({
            inventory: [{ id: 1, name: "Bronze pickaxe", quantity: 1, slot: 0 } as any, ore("Iron ore", 25)],
            locs: { trees: [], bankBooths: [], furnaces: [furnace(ARDOUGNE_IRON.furnace.x, ARDOUGNE_IRON.furnace.z)] },
        });
        expect(validateAction({ type: "smelt" }, ctx, fresh, { resources: ironTask })).toMatchObject({
            ok: true,
            action: { type: "smelt", product: "Iron", count: 25 },
        });
    });

    test("Make-X count is capped at 28 for a big pile", () => {
        const fresh = makeObs({
            inventory: [ore("Iron ore", 40)],
            locs: { trees: [], bankBooths: [], furnaces: [furnace(ARDOUGNE_IRON.furnace.x, ARDOUGNE_IRON.furnace.z)] },
        });
        expect(validateAction({ type: "smelt" }, ctx, fresh, { resources: ironTask })).toMatchObject({
            ok: true,
            action: { type: "smelt", product: "Iron", count: 28 },
        });
    });
});

describe("depleted rocks", () => {
    const near = FALADOR_COPPER_ROCKS[0];
    const other = FALADOR_COPPER_ROCKS[1];
    const twoRocks = () => makeObs({
        tick: 200,
        locs: { trees: [], bankBooths: [], rocks: [rock(near.x, near.z, 2), rock(other.x, other.z, 9)] },
    });
    const copperTask = (depleted: DepletedRocks): TaskResources => ({ ...DEFAULT_RESOURCES, smelt: { site: FALADOR_BRONZE, bars: 10, depleted } });

    test("a rock that just gave no ore is skipped for the next mine", () => {
        const memory = new DepletedRocks();
        memory.mark(near.x, near.z, 199);
        const v: any = validateAction({ type: "mine_rock" }, ctx, twoRocks(), { resources: copperTask(memory) });
        expect(v).toMatchObject({ ok: true, action: { x: other.x, z: other.z } });
    });

    test("the skip ends after DEPLETED_TICKS, and the nearest rock is chosen again", () => {
        const memory = new DepletedRocks();
        memory.mark(near.x, near.z, 200 - DEPLETED_TICKS);
        const v: any = validateAction({ type: "mine_rock" }, ctx, twoRocks(), { resources: copperTask(memory) });
        expect(v).toMatchObject({ ok: true, action: { x: near.x, z: near.z } });
    });

    test("when every rock is marked, the one marked longest ago is used", () => {
        const memory = new DepletedRocks();
        memory.mark(near.x, near.z, 199);
        memory.mark(other.x, other.z, 150);
        expect(memory.pick([rock(near.x, near.z), rock(other.x, other.z)], 200)).toMatchObject({ x: other.x, z: other.z });
    });

    test("every rock in view is empty: walk to the free one out of view, do not mine the empty one", () => {
        const memory = new DepletedRocks();
        memory.mark(near.x, near.z, 199);
        const inView = makeObs({ tick: 200, locs: { trees: [], bankBooths: [], rocks: [rock(near.x, near.z, 2)] } });
        const v: any = validateAction({ type: "mine_rock" }, ctx, inView, { resources: copperTask(memory) });
        expect(v).toMatchObject({ ok: false, code: "no_rock_in_view" });
        expect(v.message).toContain(`x ${other.x} z ${other.z}`);
    });

    test("clearing a rock (it gave ore) makes it fresh again", () => {
        const memory = new DepletedRocks();
        memory.mark(near.x, near.z, 199);
        memory.clear(near.x, near.z);
        expect(memory.pick([rock(near.x, near.z, 2), rock(other.x, other.z, 9)], 200)).toMatchObject({ x: near.x, z: near.z });
    });
});

describe("mine-smelt bank step and rejection messages (from the 2026-11-01 model runs)", () => {
    test("deposit banks the bars on a mine-smelt task, not oak logs", () => {
        const bars = makeObs({ bankOpen: true, bankItems: [], inventory: [{ id: 4, slot: 0, name: "Iron bar", quantity: 3 }] });
        expect(validateAction({ type: "deposit_items" }, ctx, bars, { resources: ironTask }))
            .toMatchObject({ ok: true, action: { type: "deposit_items", item: "Iron bar" } });
    });

    test("deposit with no bars says so, and names the bar, not the logs", () => {
        const none = makeObs({ bankOpen: true, bankItems: [], inventory: [ore("Iron ore", 5)] });
        const v: any = validateAction({ type: "deposit_items" }, ctx, none, { resources: ironTask });
        expect(v).toMatchObject({ ok: false, code: "nothing_to_deposit" });
        expect(v.message).toContain("Iron bar");
        expect(v.message).not.toContain("Oak");
    });

    test("walking to the spot you are on names the actions to take instead", () => {
        const here = makeObs({ inventory: [ore("Iron ore", 5)] });
        const v: any = validateAction({ type: "walk_to", x: here.player.x, z: here.player.z }, ctx, here,
            { allowed: ["walk_to", "mine_rock", "smelt", "open_bank", "deposit_items", "close_bank", "wait"] });
        expect(v).toMatchObject({ ok: false, code: "already_there" });
        expect(v.message).toContain("smelt");
        expect(v.message).not.toContain("walk_to,");
    });

    test("no rock in view names the nearest rock tile to walk to", () => {
        const far = makeObs({ inventory: [], locs: { trees: [], bankBooths: [], rocks: [] } });
        const v: any = validateAction({ type: "mine_rock" }, ctx, far, { resources: ironTask });
        expect(v).toMatchObject({ ok: false, code: "no_rock_in_view" });
        expect(v.message).toMatch(/x \d+ z \d+/);
    });

    test("no furnace in view names the furnace tile", () => {
        const v: any = validateAction({ type: "smelt" }, ctx, makeObs({ inventory: [ore("Iron ore", 5)], locs: { trees: [], bankBooths: [], furnaces: [] } }), { resources: ironTask });
        expect(v).toMatchObject({ ok: false, code: "no_furnace_in_view" });
        expect(v.message).toContain(`x ${ARDOUGNE_IRON.furnace.x} z ${ARDOUGNE_IRON.furnace.z}`);
    });
});

describe("smelt waits for the whole batch", () => {
    const furnaces = { trees: [], bankBooths: [], furnaces: [furnace(ARDOUGNE_IRON.furnace.x, ARDOUGNE_IRON.furnace.z)] };

    test("a few ore with room in the pack is refused, and the message says what to mine", () => {
        const v: any = validateAction({ type: "smelt" }, ctx, makeObs({ inventory: [ore("Iron ore", 5)], locs: furnaces }), { resources: ironTask });
        expect(v).toMatchObject({ ok: false, code: "ore_not_gathered" });
        expect(v.message).toContain("23 more iron ore");
        expect(v.message).toContain("mine_rock");
    });

    test("once the target is carried, the smelt goes ahead as one batch", () => {
        const v: any = validateAction({ type: "smelt" }, ctx, makeObs({ inventory: [ore("Iron ore", 28)], locs: furnaces }), { resources: ironTask });
        expect(v).toMatchObject({ ok: true, action: { type: "smelt", count: 28 } });
    });

    test("a full pack is smelted even short of the target (nothing more can be carried)", () => {
        const full = [ore("Iron ore", 5), ...Array.from({ length: 27 }, (_, i) => ({ slot: i + 1, id: 300 + i, name: `Junk${i}`, quantity: 1 }))];
        const v: any = validateAction({ type: "smelt" }, ctx, makeObs({ inventory: full, locs: furnaces }), { resources: ironTask });
        expect(v).toMatchObject({ ok: true, action: { type: "smelt", count: 5 } });
    });
});

describe("goal wording template", () => {
    test("AGENT_SMELT_GOAL placeholders are filled and the completion check is kept", () => {
        const spec = mineSmeltGoal({ site: ARDOUGNE_IRON, bars: 10, template: "Make {bars} {barItem} from {ore} at {mine}; furnace {furnace}, bank {bank}." });
        expect(spec.goal).toBe("Make 10 iron bar from iron ore at iron ore rocks near x 2581 z 3231; furnace x 2601 z 3310, bank x 2616 z 3332.");
        expect(spec.verifyDone).toBeDefined();
    });

    test("unknown placeholders are left as written", () => {
        expect(fillSmeltTemplate("keep {nothing}", { bars: 1 })).toBe("keep {nothing}");
    });
});

describe("walks to the furnace and bank are gated", () => {
    test("a batch one or two ore short still goes to the furnace", () => {
        const walkFurnace = { type: "walk_to", x: ironTask.smelt!.site.furnace.x, z: ironTask.smelt!.site.furnace.z };
        expect(validateAction(walkFurnace, ctx, makeObs({ inventory: [ore("Iron ore", 26)] }), { resources: ironTask }))
            .toMatchObject({ ok: true });
    });

    const walkFurnace = { type: "walk_to", x: ironTask.smelt!.site.furnace.x, z: ironTask.smelt!.site.furnace.z };
    test("no walk to the furnace while the batch is short", () => {
        const v: any = validateAction(walkFurnace, ctx, makeObs({ inventory: [ore("Iron ore", 5)] }), { resources: ironTask });
        expect(v).toMatchObject({ ok: false, code: "ore_not_gathered" });
        expect(v.message).toContain("23 more iron ore");
    });
    test("the furnace walk is allowed once the batch is carried", () => {
        expect(validateAction(walkFurnace, ctx, makeObs({ inventory: [ore("Iron ore", 28)] }), { resources: ironTask }))
            .toMatchObject({ ok: true });
    });
    test("no walk to the bank while the bars still needed are not carried", () => {
        const walkBank = { type: "walk_to", x: ironTask.smelt!.site.bank.x, z: ironTask.smelt!.site.bank.z };
        const v: any = validateAction(walkBank, ctx, makeObs({ inventory: [ore("Iron bar", 8)] }), { resources: ironTask });
        expect(v).toMatchObject({ ok: false, code: "bars_short_before_bank" });
        expect(validateAction(walkBank, ctx, makeObs({ inventory: [ore("Iron bar", 10)] }), { resources: ironTask }))
            .toMatchObject({ ok: true });
    });
});

describe("batch size, bank gate and rejected mines", () => {
    test("a batch is the expected need plus the margin, capped at one Make-X call", () => {
        expect(batchOreTarget(10, 0.5)).toBe(28);   // 20 * 1.4
        expect(batchOreTarget(10, 1)).toBe(14);     // 10 * 1.4
        expect(batchOreTarget(1, 1)).toBe(2);
        expect(batchOreTarget(40, 0.5)).toBe(28);   // capped
    });

    test("the bank stays shut while the pack holds fewer bars than the goal still needs", () => {
        const v: any = validateAction({ type: "open_bank" }, ctx, makeObs({ inventory: [ore("Iron bar", 3), ore("Iron ore", 9)] }), { resources: ironTask });
        expect(v).toMatchObject({ ok: false, code: "bars_short_before_bank" });
        expect(v.message).toContain("needs 10");
    });

    test("extra ore in the pack does not block the bank once the bars are carried", () => {
        expect(validateAction({ type: "open_bank" }, ctx, makeObs({ inventory: [ore("Iron bar", 10), ore("Iron ore", 9)] }), { resources: ironTask }))
            .toMatchObject({ ok: true, action: { type: "open_bank" } });
    });

    test("bars already banked lower what the goal still needs", () => {
        const banked: TaskResources = { ...DEFAULT_RESOURCES, smelt: { site: ARDOUGNE_IRON, bars: 10, banked: 6 } };
        expect(validateAction({ type: "open_bank" }, ctx, makeObs({ inventory: [ore("Iron bar", 4)] }), { resources: banked }))
            .toMatchObject({ ok: true });
    });

    test("tools in the pack leave room: with a knife and axe, 26 iron ore is a full batch", () => {
        const tools = [{ slot: 0, id: 1, name: "Knife", quantity: 1 }, { slot: 1, id: 2, name: "Steel axe", quantity: 1 }];
        const full = makeObs({ inventory: [...tools, ore("Iron ore", 26)], locs: { trees: [], bankBooths: [], rocks: [] } });
        expect(validateAction({ type: "mine_rock" }, ctx, full, { resources: ironTask }))
            .toMatchObject({ ok: false, code: "nothing_to_mine" });
        const short = makeObs({ inventory: [...tools, ore("Iron ore", 25)], locs: { trees: [], bankBooths: [], rocks: [] } });
        expect(validateAction({ type: "mine_rock" }, ctx, short, { resources: ironTask }))
            .toMatchObject({ ok: false, code: "no_rock_in_view" });
    });

    test("a mine that reports rejected but gains ore is a success: the ore is the evidence", () => {
        const before = makeObs({ inventory: [] });
        const after = makeObs({ inventory: [ore("Iron ore", 1)] });
        const action = { type: "mine_rock" as const, ore: "Iron ore", x: 2581, z: 3231 };
        const c = classifyOutcome(action, before, after, { success: false, message: "Mining operation was rejected" }, []);
        expect(c.outcome).toBe("confirmed_success");
    });

    test("a mine that reports rejected and gains no ore is not a success", () => {
        const before = makeObs({ inventory: [] });
        const action = { type: "mine_rock" as const, ore: "Iron ore", x: 2581, z: 3231 };
        const c = classifyOutcome(action, before, makeObs({ inventory: [] }), { success: false, message: "Mining operation was rejected" }, []);
        expect(c.outcome).not.toBe("confirmed_success");
    });

    test("a stuck mine with no ore is not a success", () => {
        const before = makeObs({ inventory: [] });
        const after = makeObs({ inventory: [] });
        const action = { type: "mine_rock" as const, ore: "Iron ore", x: 2581, z: 3231 };
        const c = classifyOutcome(action, before, after, { success: true, message: "Stuck at (2591, 3229)" }, []);
        expect(c.outcome).not.toBe("confirmed_success");
    });
});
