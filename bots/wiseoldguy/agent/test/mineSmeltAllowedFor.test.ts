import { describe, expect, test } from "bun:test";
import { makeObs } from "./helpers";
import { ARDOUGNE_IRON } from "../mineSmelt";
import { DepletedRocks, bankReady } from "../smeltRules";
import { mineSmeltGoal } from "../goals";
import { runController } from "../controller";
import { FixedPolicy } from "../policy";
import { memorySink } from "../logger";

// Ardougne iron: 10 bars means a 28-ore batch with an empty pack, so "short beyond slack" is below 26 ore.
const MINE = ["mine_rock", "wait"];
const MINE_WALK = ["walk_to", "mine_rock", "wait"];
const FURNACE = ["walk_to", "smelt", "wait"];
const BANK = ["walk_to", "open_bank", "deposit_items", "close_bank", "wait"];

const ore = (quantity: number) => ({ id: 1, name: "Iron ore", quantity, slot: 0 }) as any;
const junk = (n: number) => Array.from({ length: n }, (_, i) => ({ id: 100 + i, name: "Knife", quantity: 1, slot: i })) as any[];
const bars = (quantity: number) => ({ id: 2, name: "Iron bar", quantity, slot: 1 }) as any;
const rock = (x: number, z: number) => ({ id: 3, name: "Rock", x, z, distance: 2 }) as any;

function stage(over: Parameters<typeof makeObs>[0] = {}, depleted?: DepletedRocks) {
    const goal = mineSmeltGoal({ site: ARDOUGNE_IRON, bars: 10, depleted });
    return goal.allowedFor!(makeObs(over));
}

describe("mine-smelt allowedFor: stage by state", () => {
    test("short of ore with a usable rock in view: mine only", () => {
        expect(stage({ inventory: [], locs: { trees: [], bankBooths: [], rocks: [rock(2581, 3231)] } })).toEqual(MINE);
    });

    test("short of ore with no site rock in view: mining may walk", () => {
        expect(stage({ inventory: [ore(10)], locs: { trees: [], bankBooths: [], rocks: [] } })).toEqual(MINE_WALK);
    });

    test("a rock in view that was just mined is on cooldown: mining may walk", () => {
        const depleted = new DepletedRocks();
        depleted.mark(2581, 3231, 100);
        expect(stage({ tick: 100, inventory: [], locs: { trees: [], bankBooths: [], rocks: [rock(2581, 3231)] } }, depleted)).toEqual(MINE_WALK);
    });

    test("ore within slack of target goes to the furnace", () => {
        expect(stage({ inventory: [ore(26)], locs: { trees: [], bankBooths: [], rocks: [rock(2581, 3231)] } })).toEqual(FURNACE);
    });

    test("bars carried reach the bars still needed: bank", () => {
        expect(stage({ inventory: [bars(10), ore(4)] })).toEqual(BANK);
    });

    test("pack full of bars below the amount needed: bank, so a long run does not stall", () => {
        const fullOfBars = [...Array.from({ length: 26 }, (_, i) => ({ id: 300 + i, name: "Iron bar", quantity: 1, slot: i })) as any[], ...junk(2)];
        expect(stage({ inventory: fullOfBars })).toEqual(BANK);
    });

    test("bars short of what is needed, batch ready: furnace", () => {
        expect(stage({ inventory: [bars(8), ore(28)] })).toEqual(FURNACE);
    });

    test("pack full with ore short: furnace (mining is refused for a full pack)", () => {
        expect(stage({ inventory: [...junk(23), ore(5)] })).toEqual(FURNACE);
    });

    test("bank progress from open-bank observations ends the rule (need reached)", () => {
        const goal = mineSmeltGoal({ site: ARDOUGNE_IRON, bars: 10 });
        goal.allowedFor!(makeObs({ bankOpen: true, bankItems: [] as any, inventory: [bars(10)] }));
        // Deposit done: 10 bars now in the bank, none carried. Need is zero, so the rule defers to allowedActions.
        expect(goal.allowedFor!(makeObs({ bankOpen: true, bankItems: [bars(10)] as any, inventory: [] }))).toBeUndefined();
    });
});

describe("controller: allowedFor narrows what the policy is offered", () => {
    test("the policy sees the per-step list, not the static one", async () => {
        const obs = makeObs();
        const seen: unknown[] = [];
        const policy = new FixedPolicy((input: any) => {
            seen.push(input.allowed);
            return { type: "stop" };
        });
        const adapter = {
            observe: async () => obs,
            act: async () => ({ outcome: { status: "confirmed_success", reason: "stop", dispatched: true, message: "" }, after: obs, resolved: null }),
        } as any;
        await runController(adapter, policy, {
            goal: "g", maxSteps: 2,
            allowedActions: ["walk_to", "mine_rock", "smelt", "stop"] as any,
            allowedFor: () => ["wait"] as any,
        }, memorySink());
        expect(seen[0]).toEqual(["wait"]);
    });
});

describe("bankReady", () => {
    const bar = { name: "Iron bar", quantity: 8 };
    test("carried bars reach the need", () => {
        expect(bankReady([bar], /^iron bar$/i, 8, 28)).toBe(true);
        expect(bankReady([bar], /^iron bar$/i, 9, 28)).toBe(false);
    });
    test("a full pack with some bars is ready even below the need", () => {
        const full = [bar, ...Array.from({ length: 27 }, (_, i) => ({ name: "Knife", quantity: 1 }))];
        expect(bankReady(full, /^iron bar$/i, 1000, 28)).toBe(true);
    });
    test("a full pack with no bars is not ready", () => {
        const full = Array.from({ length: 28 }, () => ({ name: "Knife", quantity: 1 }));
        expect(bankReady(full, /^iron bar$/i, 1000, 28)).toBe(false);
    });
});
