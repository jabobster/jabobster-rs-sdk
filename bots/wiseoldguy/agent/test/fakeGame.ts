// A tiny simulated world exposing the slice of the SDK that the agent modules use.
// It lets the REAL observe/validate/execute/classify/controller code run with no game.

export interface FakeNpc {
    index: number; id: number; name: string; x: number; z: number;
    options: string[]; hp: number; reachable?: boolean; attackable?: boolean; inCombat?: boolean;
    drops?: { id: number; name: string; count: number }[];
}
export interface FakeGround { id: number; name: string; x: number; z: number; count: number; reachable?: boolean }

export interface FakeInvItem { id: number; name: string; count: number; options?: string[]; heal?: number }

export function createFakeGame(init: {
    npcs?: FakeNpc[]; ground?: FakeGround[]; inv?: FakeInvItem[];
} = {}) {
    const w = {
        tick: 100,
        inGame: true,
        player: {
            name: "Tester", worldX: 3200, worldZ: 3200, level: 0, hp: 10, maxHp: 10, isDead: false,
            combat: { inCombat: false, targetIndex: -1, targetType: "none" as string },
        },
        npcs: init.npcs ?? [],
        ground: init.ground ?? [],
        inv: init.inv ?? [],
        dialog: { isOpen: false, isWaiting: false, pageId: undefined as string | undefined, text: "", options: [] as any[] },
        dialogScript: [] as { text: string; options: { index: number; text: string }[] }[],
        dialogPage: 0,
        chat: [] as any[],
        shopOpen: false,
        bankOpen: false,
        swallowPickup: false,   // pickup "succeeds" at the SDK but nothing changes
        pathBlocked: false,
        walkBreaksCombat: true, // walking away ends the fight (set false: the enemy keeps hold of us)
        eatSwallowed: false,    // eatFood fails: the SDK reports failure and nothing changes
        calls: [] as string[],  // every SDK/bot call that could affect the game
        hangAttack: false,      // bot.attack never resolves
        onTick: [] as (() => void)[],
    };

    const dist = (x: number, z: number) => Math.max(Math.abs(x - w.player.worldX), Math.abs(z - w.player.worldZ));

    function setDialogPage(page: number) {
        const p = w.dialogScript[page];
        if (!p) {
            w.dialog = { isOpen: false, isWaiting: false, pageId: undefined, text: "", options: [] };
            return;
        }
        w.dialogPage = page;
        w.dialog = { isOpen: true, isWaiting: false, pageId: `p${page}`, text: p.text, options: p.options };
    }

    function tickOnce() {
        w.tick++;
        const c = w.player.combat;
        if (c.inCombat) {
            const target = w.npcs.find((n) => n.index === c.targetIndex);
            if (!target) {
                c.inCombat = false; c.targetIndex = -1; c.targetType = "none";
            } else if (--target.hp <= 0) {
                w.npcs = w.npcs.filter((n) => n !== target);
                for (const d of target.drops ?? []) w.ground.push({ ...d, x: target.x, z: target.z });
                c.inCombat = false; c.targetIndex = -1; c.targetType = "none";
            }
        }
        w.onTick.forEach((f) => f());
    }

    const sdk = {
        getState: () => ({
            tick: w.tick, inGame: w.inGame, player: w.player, dialog: w.dialog,
            groundItems: w.ground.map((g) => ({ ...g, distance: dist(g.x, g.z), reachable: g.reachable ?? true })),
            interface: { isOpen: false }, shop: { isOpen: w.shopOpen }, bank: { isOpen: w.bankOpen },
            opFeedback: { opRejectedCount: 0 },
        }),
        getInventory: () =>
            w.inv.map((i, slot) => ({
                slot, id: i.id, name: i.name, count: i.count,
                optionsWithIndex: (i.options ?? []).map((text, k) => ({ text, opIndex: k + 1 })),
            })),
        getNearbyNpcs: () =>
            w.npcs.map((n) => ({
                ...n, distance: dist(n.x, n.z), reachable: n.reachable ?? true,
                optionsWithIndex: n.options.map((text, i) => ({ text, opIndex: i + 1 })),
            })),
        getGroundItems: () => w.ground.map((g) => ({ ...g, distance: dist(g.x, g.z), reachable: g.reachable ?? true })),
        scanGroundItems: async (_radius?: number) => sdk.getGroundItems(),
        getNewChat: () => w.chat.splice(0),
        waitForTicks: async (n = 1) => { for (let i = 0; i < n; i++) tickOnce(); },
        sendClickDialog: async (_o: number) => {
            w.calls.push("sendClickDialog");
            setDialogPage(w.dialogPage + 1);
            return { success: true, message: "clicked" };
        },
        clickDialogByText: async (text: string | RegExp) => {
            w.calls.push("clickDialogByText");
            const re = typeof text === "string" ? new RegExp(text, "i") : text;
            if (!w.dialog.options.some((o) => re.test(o.text))) return { success: false, reason: "no_match", message: "no option" };
            setDialogPage(w.dialogPage + 1);
            return { success: true, message: "clicked" };
        },
        findPath: (_x: number, _z: number) => ({ success: !w.pathBlocked, waypoints: [] }),
    };

    const bot = {
        attack: async (target: any) => {
            w.calls.push("attack");
            if (w.hangAttack) return new Promise(() => {});
            const npc = w.npcs.find((n) => n.index === target.index);
            if (!npc) return { success: false, reason: "npc_not_found", message: "gone" };
            if (npc.options.indexOf("Attack") < 0) return { success: false, reason: "no_attack_option", message: "no" };
            w.player.combat = { inCombat: true, targetIndex: npc.index, targetType: "npc" };
            return { success: true, message: "attacking" };
        },
        pickupItem: async (item: any) => {
            w.calls.push("pickupItem");
            if (w.swallowPickup) return { success: true, message: "dispatched" };
            const g = w.ground.find((x) => x.id === item.id && x.x === item.x && x.z === item.z);
            if (!g) return { success: false, reason: "item_not_found", message: "gone" };
            w.ground = w.ground.filter((x) => x !== g);
            w.inv.push({ id: g.id, name: g.name, count: g.count });
            return { success: true, message: "picked up" };
        },
        talkTo: async (target: any) => {
            w.calls.push("talkTo");
            if (!w.npcs.some((n) => n.index === target.index)) return { success: false, message: "gone" };
            setDialogPage(0);
            return { success: true, message: "talking" };
        },
        walkTo: async (x: number, z: number, _tol: number) => {
            w.calls.push("walkTo");
            w.player.worldX = x; w.player.worldZ = z;
            if (w.walkBreaksCombat) w.player.combat = { inCombat: false, targetIndex: -1, targetType: "none" };
            return { success: true, message: "walked" };
        },
        eatFood: async (target?: any) => {
            w.calls.push("eatFood");
            const food = target
                ? w.inv.find((i) => i.id === target.id && (i.options ?? []).includes("Eat"))
                : w.inv.find((i) => (i.options ?? []).includes("Eat"));
            if (!food) return { success: false, hpGained: 0, message: "No edible item in inventory" };
            if (w.eatSwallowed) return { success: false, hpGained: 0, message: "Failed to eat" };
            const before = w.player.hp;
            w.player.hp = Math.min(w.player.maxHp, w.player.hp + (food.heal ?? 3));
            food.count--;
            if (food.count <= 0) w.inv = w.inv.filter((i) => i !== food);
            return { success: true, hpGained: w.player.hp - before, message: `Ate ${food.name}` };
        },
        interactNpc: async () => { w.calls.push("interactNpc"); return { success: false, reason: "rejected", message: "rejected" }; },
        pickpocketNpc: async () => { w.calls.push("pickpocketNpc"); return { success: false, reason: "rejected", message: "rejected" }; },
    };

    return { world: w, sdk, bot };
}

/** A cow with drops, as in the first target goal. */
export function cow(index = 5, over: Partial<FakeNpc> = {}): FakeNpc {
    return {
        index, id: 2000 + index, name: "Cow", x: 3203, z: 3200, options: ["Attack"], hp: 3,
        drops: [{ id: 1739, name: "Cowhide", count: 1 }, { id: 526, name: "Bones", count: 1 }],
        ...over,
    };
}
