import { describe, expect, test } from "bun:test";
import { CAPABILITIES, CAPABILITY_BY_ID, capabilityMatrix, getCapability } from "../capabilities";
import { observe } from "../observe";
import { makeObs } from "./helpers";

const item = (name: string, quantity: number, id = 1000 + name.length) => ({ slot: 0, id, name, quantity });
const inv = (...items: [string, number][]) => items.map(([n, q], i) => ({ ...item(n, q), slot: i }));
const xp = (skills: Record<string, number>) => skills;
/** A shop or bank stack: id, name, quantity. */
const stack = (name: string, quantity: number) => ({ id: 1000 + name.length, name, quantity });

const at = (over: Parameters<typeof makeObs>[0] = {}) => makeObs({ skillXp: xp({}), ...over });

describe("registry", () => {
    test("every capability has a unique id, an SDK call, requirements, evidence, and a status", () => {
        const ids = CAPABILITIES.map((c) => c.id);
        expect(new Set(ids).size).toBe(ids.length);
        for (const c of CAPABILITIES) {
            expect(c.sdkCall.length).toBeGreaterThan(3);
            expect(c.requires.length).toBeGreaterThan(3);
            expect(c.evidence.length).toBeGreaterThan(3);
            expect(["built", "provisional"]).toContain(c.status);
        }
    });

    test("the user's matrix rows, with the added capabilities, are all present", () => {
        for (const id of ["woodcutting", "firemaking", "mining", "fletching", "cooking", "agility_obstacle",
            "open_shop", "buy", "sell", "open_bank", "deposit", "withdraw", "close_bank", "smelt"]) {
            expect(CAPABILITY_BY_ID[id], id).toBeDefined();
        }
    });

    test("cooking, agility and smelting are provisional; the rest are built", () => {
        const provisional = CAPABILITIES.filter((c) => c.status === "provisional").map((c) => c.id).sort();
        expect(provisional).toEqual(["agility_obstacle", "cooking", "smelt"]);
    });

    test("getCapability fails loudly on an unknown id; the matrix lists every row", () => {
        expect(() => getCapability("teleport")).toThrow(/Unknown capability/);
        const table = capabilityMatrix().split("\n");
        expect(table).toHaveLength(2 + CAPABILITIES.length);
    });
});

describe("gathering", () => {
    test("woodcutting: a log gain is success; a tree vanishing alone is not", () => {
        const c = getCapability("woodcutting");
        const before = at({ inventory: inv(["Oak logs", 2]) });
        expect(c.completion(before, at({ inventory: inv(["Oak logs", 3]) }), { logs: "Oak logs" }).status).toBe("confirmed_success");
        expect(c.completion(before, at({ inventory: inv(["Oak logs", 2]) }), { logs: "Oak logs" }))
            .toMatchObject({ status: "unconfirmed", reason: "no_log_gain_yet" });
    });

    test("mining: matching ore gain is success; XP without ore is not", () => {
        const c = getCapability("mining");
        const before = at({ inventory: inv(["Copper ore", 1]), skillXp: xp({ Mining: 100 }) });
        expect(c.completion(before, at({ inventory: inv(["Copper ore", 2]), skillXp: xp({ Mining: 117 }) }), { ore: "Copper ore" }))
            .toMatchObject({ status: "confirmed_success", reason: "ore_gained" });
        expect(c.completion(before, at({ inventory: inv(["Copper ore", 1]), skillXp: xp({ Mining: 117 }) }), { ore: "Copper ore" }))
            .toMatchObject({ status: "unconfirmed", reason: "xp_without_ore" });
    });

    test("firemaking: XP is the completion; logs burned is recorded", () => {
        const c = getCapability("firemaking");
        const before = at({ inventory: inv(["Logs", 3]), skillXp: xp({ Firemaking: 10 }) });
        const after = at({ inventory: inv(["Logs", 2]), skillXp: xp({ Firemaking: 50 }) });
        expect(c.completion(before, after, { logs: "Logs" })).toMatchObject({ status: "confirmed_success", evidence: { gainedXp: 40, burned: 1 } });
        expect(c.completion(before, at({ inventory: inv(["Logs", 2]), skillXp: xp({ Firemaking: 10 }) }), { logs: "Logs" }).status).toBe("unconfirmed");
    });

    test("fletching: XP is required; a named product must also appear", () => {
        const c = getCapability("fletching");
        const before = at({ inventory: inv(["Logs", 5]), skillXp: xp({ Fletching: 0 }) });
        const xpOnly = at({ inventory: inv(["Logs", 4]), skillXp: xp({ Fletching: 5 }) });
        expect(c.completion(before, xpOnly, {})).toMatchObject({ status: "confirmed_success" });
        expect(c.completion(before, xpOnly, { product: "Shortbow (u)" })).toMatchObject({ reason: "xp_without_product" });
        const made = at({ inventory: inv(["Logs", 4], ["Shortbow (u)", 1]), skillXp: xp({ Fletching: 5 }) });
        expect(c.completion(before, made, { product: "Shortbow (u)" })).toMatchObject({ status: "confirmed_success" });
    });
});

describe("provisional capabilities", () => {
    test("cooking: starting the interaction is not completion; cooked food or Cooking XP is", () => {
        const c = getCapability("cooking");
        const before = at({ inventory: inv(["Raw beef", 2]), skillXp: xp({ Cooking: 0 }) });
        expect(c.completion(before, at({ inventory: inv(["Raw beef", 2]), skillXp: xp({ Cooking: 0 }) }), { raw: "Raw beef", cooked: "Cooked beef" }).status).toBe("unconfirmed");
        expect(c.completion(before, at({ inventory: inv(["Raw beef", 1], ["Cooked beef", 1]), skillXp: xp({ Cooking: 0 }) }), { raw: "Raw beef", cooked: "Cooked beef" }).status).toBe("confirmed_success");
        expect(c.completion(before, at({ inventory: inv(["Raw beef", 2]), skillXp: xp({ Cooking: 30 }) }), { raw: "Raw beef", cooked: "Cooked beef" }).status).toBe("confirmed_success");
    });

    test("agility: blocked for any obstacle not in the verified table; XP is the only completion", () => {
        const c = getCapability("agility_obstacle");
        expect(c.preconditions(at(), { obstacle: "Gnome log" })).toContain('obstacle "Gnome log" is not in KNOWN_OBSTACLES');
        const before = at({ skillXp: xp({ Agility: 10 }) });
        expect(c.completion(before, at({ skillXp: xp({ Agility: 10 }) }), { obstacle: "x" })).toMatchObject({ reason: "no_agility_xp_yet" });
        expect(c.completion(before, at({ skillXp: xp({ Agility: 18 }) }), { obstacle: "x" })).toMatchObject({ status: "confirmed_success" });
    });

    test("smelting: the bar or Smithing XP is accepted; neither is not", () => {
        const c = getCapability("smelt");
        const before = at({ inventory: inv(["Copper ore", 1]), skillXp: xp({ Smithing: 0 }) });
        const args = { ore: "Copper ore", bar: "Bronze bar" };
        expect(c.completion(before, at({ inventory: inv(["Bronze bar", 1]), skillXp: xp({ Smithing: 0 }) }), args).status).toBe("confirmed_success");
        expect(c.completion(before, at({ inventory: inv(["Copper ore", 1]), skillXp: xp({ Smithing: 13 }) }), args)).toMatchObject({ reason: "smithing_xp_gained" });
        expect(c.completion(before, at({ inventory: inv(["Copper ore", 1]), skillXp: xp({ Smithing: 0 }) }), args).status).toBe("unconfirmed");
        expect(c.preconditions(at({ inventory: [] }), args)).toContain("no Copper ore in the inventory");
    });
});

describe("shops", () => {
    test("open_shop: needs the shop open with stock visible; a wrong title is rejected", () => {
        const c = getCapability("open_shop");
        expect(c.completion(at(), at({ shopOpen: true, shopItems: [], shopTitle: "General store" }), {})).toMatchObject({ reason: "shop_open_but_no_items" });
        expect(c.completion(at(), at({ shopOpen: true, shopItems: null }), {})).toMatchObject({ reason: "shop_contents_not_observed" });
        const open = at({ shopOpen: true, shopItems: [stack("Bronze axe", 5)], shopTitle: "Bob's Brilliant Axes" });
        expect(c.completion(at(), open, {})).toMatchObject({ status: "confirmed_success" });
        expect(c.completion(at(), open, { title: /general/i })).toMatchObject({ reason: "wrong_shop" });
        expect(c.completion(at(), open, { title: /axes/i }).status).toBe("confirmed_success");
    });

    test("open_shop does not trust stock that is left over from a closed shop", () => {
        const c = getCapability("open_shop");
        expect(c.completion(at(), at({ shopOpen: false, shopItems: [stack("Bronze axe", 5)] }), {}))
            .toMatchObject({ reason: "shop_not_open" });
    });

    test("open_shop is blocked by an open bank or another interface", () => {
        const c = getCapability("open_shop");
        expect(c.preconditions(at({ bankOpen: true }), {})).toContain("the bank is open");
        expect(c.preconditions(at({ interfaceOpen: true }), {})).toContain("another interface is open");
    });

    test("buy: full amount is success, less is partial, nothing is unconfirmed", () => {
        const c = getCapability("buy");
        const before = at({ inventory: inv(["Coins", 500]), shopOpen: true });
        const got = (n: number) => at({ inventory: inv(["Coins", 500], ["Bronze axe", n]), shopOpen: true });
        expect(c.completion(before, got(3), { item: "Bronze axe", amount: 3 })).toMatchObject({ status: "confirmed_success" });
        expect(c.completion(before, got(2), { item: "Bronze axe", amount: 3 })).toMatchObject({ status: "partial", evidence: { moved: 2, requested: 3 } });
        expect(c.completion(before, got(0), { item: "Bronze axe", amount: 3 })).toMatchObject({ status: "unconfirmed" });
        expect(c.preconditions(at({ shopOpen: false }), { item: "x", amount: 1 })).toContain("the shop is not open");
    });

    test("sell: needs coins up AND the item down; coins alone or the item alone is not", () => {
        const c = getCapability("sell");
        const before = at({ inventory: inv(["Coins", 10], ["Shortbow", 2]), shopOpen: true });
        const sold = at({ inventory: inv(["Coins", 60], ["Shortbow", 1]), shopOpen: true });
        expect(c.completion(before, sold, { item: "Shortbow", amount: 1 })).toMatchObject({ status: "confirmed_success", evidence: { coinsGained: 50 } });
        expect(c.completion(before, at({ inventory: inv(["Coins", 60], ["Shortbow", 2]) }), { item: "Shortbow", amount: 1 }))
            .toMatchObject({ reason: "coins_without_item_decrease" });
        expect(c.completion(before, at({ inventory: inv(["Coins", 10], ["Shortbow", 1]) }), { item: "Shortbow", amount: 1 }))
            .toMatchObject({ reason: "item_gone_no_coins" });
        expect(c.completion(before, at({ inventory: inv(["Coins", 60], ["Shortbow", 1]) }), { item: "Shortbow", amount: 2 }))
            .toMatchObject({ status: "partial" });
        expect(c.completion(before, at({ inventory: inv(["Coins", 60]) }), { item: "Shortbow", amount: "all" }).status).toBe("confirmed_success");
    });
});

describe("bank", () => {
    test("open_bank: the interface and its contents must be visible", () => {
        const c = getCapability("open_bank");
        expect(c.completion(at(), at({ bankOpen: false }), {})).toMatchObject({ reason: "bank_not_open" });
        expect(c.completion(at(), at({ bankOpen: true, bankItems: null }), {})).toMatchObject({ reason: "bank_contents_not_observed" });
        expect(c.completion(at(), at({ bankOpen: true, bankItems: [stack("Oak logs", 4)] }), {})).toMatchObject({ status: "confirmed_success" });
    });

    test("deposit: inventory down AND bank up by the same amount; a mismatch is unconfirmed", () => {
        const c = getCapability("deposit");
        const before = at({ bankOpen: true, inventory: inv(["Oak logs", 5]), bankItems: [stack("Oak logs", 10)] });
        const deposited = at({ bankOpen: true, inventory: [], bankItems: [stack("Oak logs", 15)] });
        expect(c.completion(before, deposited, { item: "Oak logs", amount: -1 })).toMatchObject({ status: "confirmed_success", evidence: { moved: 5 } });
        expect(c.completion(before, at({ bankOpen: true, inventory: [], bankItems: [stack("Oak logs", 10)] }), { item: "Oak logs", amount: -1 }))
            .toMatchObject({ reason: "inventory_down_bank_not_up" });
        expect(c.completion(before, at({ bankOpen: true, inventory: inv(["Oak logs", 5]), bankItems: [stack("Oak logs", 15)] }), { item: "Oak logs", amount: -1 }))
            .toMatchObject({ reason: "nothing_left_inventory" });
        const partialMove = at({ bankOpen: true, inventory: inv(["Oak logs", 2]), bankItems: [stack("Oak logs", 13)] });
        expect(c.completion(before, partialMove, { item: "Oak logs", amount: 5 })).toMatchObject({ status: "partial", evidence: { moved: 3, requested: 5 } });
        expect(c.preconditions(at({ bankOpen: false, inventory: inv(["Oak logs", 1]) }), { item: "Oak logs" })).toContain("the bank is not open");
    });

    test("deposit all: leftovers in the pack are reported as partial, not success", () => {
        const c = getCapability("deposit");
        const before = at({ bankOpen: true, inventory: inv(["Oak logs", 5]), bankItems: [stack("Oak logs", 10)] });
        const left = at({ bankOpen: true, inventory: inv(["Oak logs", 2]), bankItems: [stack("Oak logs", 13)] });
        expect(c.completion(before, left, { item: "Oak logs", amount: "all" })).toMatchObject({ status: "partial", evidence: { left: 2 } });
    });

    test("withdraw: inventory up AND bank down by the same amount", () => {
        const c = getCapability("withdraw");
        const before = at({ bankOpen: true, inventory: [], bankItems: [stack("Oak logs", 10)] });
        const got = at({ bankOpen: true, inventory: inv(["Oak logs", 4]), bankItems: [stack("Oak logs", 6)] });
        expect(c.completion(before, got, { item: "Oak logs", amount: 4 })).toMatchObject({ status: "confirmed_success" });
        expect(c.completion(before, at({ bankOpen: true, inventory: inv(["Oak logs", 4]), bankItems: [stack("Oak logs", 10)] }), { item: "Oak logs", amount: 4 }))
            .toMatchObject({ reason: "inventory_up_bank_not_down" });
        expect(c.completion(before, at({ bankOpen: true, inventory: inv(["Oak logs", 2]), bankItems: [stack("Oak logs", 8)] }), { item: "Oak logs", amount: 4 }))
            .toMatchObject({ status: "partial" });
    });

    test("close_bank: both the bank and the interface must be closed", () => {
        const c = getCapability("close_bank");
        expect(c.completion(at(), at({ bankOpen: false, interfaceOpen: false }), {})).toMatchObject({ status: "confirmed_success" });
        expect(c.completion(at(), at({ bankOpen: false, interfaceOpen: true }), {})).toMatchObject({ reason: "still_open:interface" });
        expect(c.completion(at(), at({ bankOpen: true, interfaceOpen: false }), {})).toMatchObject({ reason: "still_open:bank" });
        expect(c.completion(at(), at({ bankOpen: false, interfaceOpen: null }), {})).toMatchObject({ reason: "interface_state_not_observed" });
    });
});

describe("observation: bank, shop and skill XP are read", () => {
    const stubSdk = (state: any) => ({
        getState: () => ({ tick: 5, inGame: true, player: { name: "T", worldX: 1, worldZ: 1, hp: 10, maxHp: 10, combat: null }, ...state }),
        getInventory: () => [{ slot: 0, id: 995, name: "Coins", count: 890 }],
        getNearbyNpcs: () => [],
        scanGroundItems: async () => [],
    });

    test("bank contents and skill XP are read when open; closed bank and shop read as null", async () => {
        const open = await observe(stubSdk({
            bank: { isOpen: true, items: [{ id: 1, name: "Oak logs", count: 12 }] },
            shop: { isOpen: false, title: "", shopItems: [] },
            skills: [{ name: "Woodcutting", level: 15, experience: 500 }],
        }), { scan: false });
        expect(open.bankItems).toEqual([{ id: 1, name: "Oak logs", quantity: 12 }]);
        expect(open.shopItems).toBeNull();
        expect(open.skillXp).toEqual({ Woodcutting: 500 });

        const closed = await observe(stubSdk({ bank: { isOpen: false, items: [] }, shop: { isOpen: false } }), { scan: false });
        expect(closed.bankItems).toBeNull();
        expect(closed.shopItems).toBeNull();
        expect(closed.skillXp).toBeNull();
    });

    test("an unobserved list reads as unconfirmed, never as zero", () => {
        const c = getCapability("open_bank");
        expect(c.completion(at(), at({ bankOpen: true }), {}).status).toBe("unconfirmed");
        const d = getCapability("deposit");
        expect(d.completion(at({ inventory: inv(["Oak logs", 1]) }), at({ inventory: [] }), { item: "Oak logs", amount: -1 }))
            .toMatchObject({ reason: "inventory_or_bank_not_observed" });
    });
});
