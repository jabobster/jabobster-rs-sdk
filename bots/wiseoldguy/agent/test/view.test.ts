import { describe, expect, test } from "bun:test";
import { buildSystemPrompt, describeAction, renderState, renderTurn, summarizeOutcome, toModelView } from "../view";
import { ground, makeObs, npc } from "./helpers";

describe("toModelView", () => {
    test("handles are nearest-first with unreachable last", () => {
        const obs = makeObs({
            nearbyNpcs: [
                npc(1, "Far", { distance: 9 }),
                npc(2, "Blocked", { distance: 1, reachable: false }),
                npc(3, "Near", { distance: 2 }),
            ],
        });
        const { view, handles } = toModelView(obs, undefined, { global: false });
        expect(view.npcs.map((n) => n.name)).toEqual(["Near", "Far", "Blocked"]);
        expect(handles.npcs.n1.index).toBe(3);
    });

    test("global filter hides unreachable and option-less entries, and counts them", () => {
        const obs = makeObs({
            nearbyNpcs: [
                npc(1, "Cow", { distance: 4 }),
                npc(2, "Duck", { distance: 8, reachable: false }),
                npc(3, "Signpost", { distance: 2, options: [] }),
            ],
            nearbyGroundItems: [ground(10, "Cowhide", { reachable: true }), ground(11, "Shears", { reachable: false })],
        });
        const { view, handles } = toModelView(obs);
        expect(view.npcs.map((n) => n.name)).toEqual(["Cow"]);
        expect(view.items.map((i) => i.name)).toEqual(["Cowhide"]);
        expect(handles.npcs.n1.index).toBe(1);
        expect(view.hidden).toEqual({ npcs: 2, items: 1 });
    });

    test("a task filter narrows the view, but never hides what the player is fighting or what is in combat", () => {
        const obs = makeObs({
            player: { ...makeObs().player, combat: { inCombat: true, targetIndex: 1, targetType: "npc" } },
            nearbyNpcs: [
                npc(1, "Cow", { distance: 2 }),
                npc(2, "Chicken", { distance: 3 }),
                npc(3, "Imp", { distance: 4, inCombat: true }),
            ],
            nearbyGroundItems: [ground(10, "Cowhide", { reachable: true }), ground(11, "Raw beef", { reachable: true })],
        });
        const { view } = toModelView(obs, undefined, {
            task: { npc: (n) => /^cow$/i.test(n.name), item: (i) => /^cowhide$/i.test(i.name) },
        });
        expect(view.npcs.map((n) => n.name).sort()).toEqual(["Cow", "Imp"]);
        expect(view.items.map((i) => i.name)).toEqual(["Cowhide"]);
    });

    test("caps entities and reports what was omitted", () => {
        const obs = makeObs({
            nearbyNpcs: Array.from({ length: 20 }, (_, i) => npc(i, "Chicken", { distance: i + 1 })),
            nearbyGroundItems: Array.from({ length: 12 }, (_, i) => ground(i, "Feather", { distance: i + 1 })),
        });
        const { view, handles } = toModelView(obs);
        expect(view.npcs).toHaveLength(8);
        expect(view.omitted.npcs).toBe(12);
        expect(view.items).toHaveLength(8);
        expect(Object.keys(handles.npcs)).toHaveLength(8);
    });

    test("inventory merges by item ID but counts occupied slots", () => {
        const obs = makeObs({
            inventory: [
                { slot: 0, id: 526, name: "Bones", quantity: 1 },
                { slot: 1, id: 526, name: "Bones", quantity: 1 },
                { slot: 2, id: 995, name: "Coins", quantity: 900 },
            ],
        });
        const { view } = toModelView(obs);
        expect(view.inventory).toEqual([{ id: 526, name: "Bones", qty: 2 }, { id: 995, name: "Coins", qty: 900 }]);
        expect(view.inventoryUsed).toBe(3);
    });

    test("dialog: text clipped, continue-only has no options, options numbered", () => {
        const long = "x".repeat(500);
        const cont = toModelView(makeObs({ dialog: { isOpen: true, isWaiting: false, pageId: "a", text: long, options: [{ index: 1, text: "Click here to continue" }] } }));
        expect(cont.view.dialog.continueOnly).toBe(true);
        expect(cont.view.dialog.options).toEqual([]);
        expect(cont.view.dialog.text.length).toBeLessThanOrEqual(200);

        const choice = toModelView(makeObs({ dialog: { isOpen: true, isWaiting: false, pageId: "b", text: "?", options: [{ index: 1, text: "Yes" }, { index: 2, text: "No" }] } }));
        expect(choice.view.dialog.options).toEqual([{ n: 1, text: "Yes" }, { n: 2, text: "No" }]);
        expect(choice.handles.dialogOptions[2]).toBe("No");
    });

    test("blocking ui and combat target name", () => {
        const obs = makeObs({
            shopOpen: true,
            nearbyNpcs: [npc(5, "Cow")],
            player: { ...makeObs().player, combat: { inCombat: true, targetIndex: 5, targetType: "npc" } },
        });
        const { view } = toModelView(obs);
        expect(view.blocking).toBe("shop");
        expect(view.player.combatTarget).toBe("Cow");
    });

    test("view carries no SDK internals", () => {
        const json = JSON.stringify(toModelView(makeObs({ nearbyNpcs: [npc(5, "Cow")] })).view);
        for (const leak of ["opRejected", "isWaiting", "pageId", "index"]) expect(json).not.toContain(leak);
    });
});

describe("rendering", () => {
    const busy = makeObs({
        inventory: Array.from({ length: 20 }, (_, i) => ({ slot: i, id: 1000 + i, name: `Item number ${i}`, quantity: 1 })),
        nearbyNpcs: Array.from({ length: 8 }, (_, i) => npc(i, "Cow", { options: ["Attack", "Examine"], distance: i + 1 })),
        nearbyGroundItems: Array.from({ length: 8 }, (_, i) => ground(i, "Cowhide", { distance: i + 1 })),
        dialog: { isOpen: true, isWaiting: false, pageId: "x", text: "y".repeat(300), options: Array.from({ length: 6 }, (_, i) => ({ index: i + 1, text: `Option ${i + 1}` })) },
    });

    test("worst-case turn stays small (<= ~700 tokens)", () => {
        const text = renderTurn(toModelView(busy).view, ["step 1: a -> b (c)", "step 2: a -> b (c)", "step 3: a -> b (c)"], "note");
        expect(text.length / 4).toBeLessThan(700);
    });

    test("renders handles and numbered choices as text, not JSON", () => {
        const text = renderState(toModelView(busy).view);
        expect(text).toContain("n1 Cow");
        expect(text).toContain("g1 Cowhide");
        expect(text).toContain("1. Option 1");
        expect(text).not.toContain("{");
    });

    test("system prompt is static per goal and carries the goal", () => {
        expect(buildSystemPrompt("kill a cow")).toBe(buildSystemPrompt("kill a cow"));
        expect(buildSystemPrompt("kill a cow")).toContain("GOAL: kill a cow");
    });

    test("memory describes actions by name, not handle", () => {
        const { handles } = toModelView(makeObs({ nearbyNpcs: [npc(5, "Cow")] }));
        expect(describeAction({ type: "attack", target: "n1" }, handles)).toBe("attack Cow");
    });
});

describe("busy npcs (real log: attacked a cow another player was fighting)", () => {
    test("npc in combat with something else is flagged, rendered, and sorted after free ones", () => {
        const obs = makeObs({ nearbyNpcs: [npc(1, "Cow", { distance: 1, inCombat: true }), npc(2, "Cow", { distance: 6 })] });
        const { view, handles } = toModelView(obs);
        expect(view.npcs.map((n) => [n.h, n.busy])).toEqual([["n1", false], ["n2", true]]);
        expect(handles.npcs.n1.index).toBe(2);
        expect(renderState(view)).toContain("(in combat)");
    });
    test("an npc fighting US is not busy", () => {
        const obs = makeObs({
            nearbyNpcs: [npc(1, "Cow", { inCombat: true })],
            player: { ...makeObs().player, combat: { inCombat: true, targetIndex: 1, targetType: "npc" } },
        });
        expect(toModelView(obs).view.npcs[0].busy).toBe(false);
    });
});

describe("system prompt action set (real log: model copied the example walk_to 3200,3200)", () => {
    test("no concrete coordinates appear anywhere", () => {
        expect(buildSystemPrompt("g")).not.toMatch(/\b3200\b/);
    });
    test("only allowed actions are described; stop always is", () => {
        const p = buildSystemPrompt("g", ["attack", "pickup", "wait"]);
        expect(p).toContain('"type":"attack"');
        expect(p).toContain('"type":"stop"');
        for (const hidden of ["walk_to", "dialog_select", "pickpocket", "interact_npc"]) expect(p).not.toContain(hidden);
        expect(p).not.toContain("dialog_continue");
    });
    test("memory line carries the failure reason (real log: attack -> target_not_found)", () => {
        const line = summarizeOutcome(3, "attack Cow", { status: "partial_progress_or_timeout", reason: "sdk_timeout", message: "Failed to interact with NPC: target_not_found" });
        expect(line).toContain("target_not_found");
        expect(summarizeOutcome(4, "pickup Bones", { status: "confirmed_success", reason: "x", message: "Picked up Bones" })).not.toContain("Picked up");
    });
});

describe("lingering combat flag after a kill (real log c5c07a02, ticks 2063-2086)", () => {
    const base = makeObs().player;
    test("inCombat=true with no target is idle, so the model is not told it is fighting", () => {
        const obs = makeObs({ player: { ...base, combat: { inCombat: true, targetIndex: -1, targetType: "none" } }, nearbyGroundItems: [ground(526, "Bones")] });
        const { view } = toModelView(obs);
        expect(view.player.combat).toBe("idle");
        expect(renderState(view)).toContain("| idle");
    });
    test("a real target still counts as fighting, and names it", () => {
        const obs = makeObs({ nearbyNpcs: [npc(7, "Cow")], player: { ...base, combat: { inCombat: true, targetIndex: 7, targetType: "npc" } } });
        const { view } = toModelView(obs);
        expect(view.player.combat).toBe("npc");
        expect(renderState(view)).toContain("fighting Cow");
    });
});
