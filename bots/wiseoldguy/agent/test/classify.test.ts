import { describe, expect, test } from "bun:test";
import { classifyOutcome } from "../classify";
import type { ResolvedAction } from "../contract";
import { ground, makeObs } from "./helpers";

const npcRef = { index: 5, id: 2005, name: "Cow", x: 3203, z: 3200 };
const dlg = (pageId: string, text = "hi", options: string[] = []) => ({
    isOpen: true, isWaiting: false, pageId, text, options: options.map((t, i) => ({ index: i + 1, text: t })),
});

describe("walk_to", () => {
    const action: ResolvedAction = { type: "walk_to", x: 3210, z: 3200, tolerance: 2 };
    test("within tolerance is success", () => {
        const after = makeObs({ player: { ...makeObs().player, x: 3209 } });
        expect(classifyOutcome(action, makeObs(), after, { success: true }, []).outcome).toBe("confirmed_success");
    });
    test("moved but short is partial", () => {
        const after = makeObs({ player: { ...makeObs().player, x: 3205 } });
        expect(classifyOutcome(action, makeObs(), after, { success: false }, []).outcome).toBe("partial_progress_or_timeout");
    });
    test("plane change is flagged, not success", () => {
        const after = makeObs({ player: { ...makeObs().player, x: 3210, level: 1 } });
        const c = classifyOutcome(action, makeObs(), after, { success: true }, []);
        expect(c.reason).toBe("plane_changed");
        expect(c.outcome).toBe("unconfirmed");
    });
});

describe("attack", () => {
    const action: ResolvedAction = { type: "attack", npc: npcRef };
    const inCombat = makeObs({ player: { ...makeObs().player, combat: { inCombat: true, targetIndex: 5, targetType: "npc" } } });
    test("combat state change is success", () => {
        expect(classifyOutcome(action, makeObs(), inCombat, { success: true }, []).outcome).toBe("confirmed_success");
    });
    test("a stray 'you attack' message does not create success without state", () => {
        const c = classifyOutcome(action, makeObs(), makeObs(), { success: false }, [{ text: "You attack the cow." }]);
        expect(c.outcome).toBe("unconfirmed");
    });
    test("combat flip + 'Someone else is fighting that' is a conflict, not success (real log, step 34)", () => {
        const c = classifyOutcome(action, makeObs(), inCombat, { success: true, message: "Already fighting Cow" },
            [{ text: "Someone else is fighting that." }, { text: "Someone else is fighting that." }]);
        expect(c.outcome).toBe("unconfirmed");
        expect(c.reason).toBe("state_and_message_conflict");
    });
    test("decisive SDK reason is a confirmed failure", () => {
        const c = classifyOutcome(action, makeObs(), makeObs(), { success: false, reason: "not_attackable" }, []);
        expect(c.outcome).toBe("confirmed_failure");
    });
});

describe("pickup", () => {
    const action: ResolvedAction = { type: "pickup", item: { id: 526, name: "Bones", x: 3202, z: 3200 } };
    const inv = (n: number) => makeObs({ inventory: [{ slot: 0, id: 526, name: "Bones", quantity: n }] });
    test("quantity of the TARGET id increased", () => {
        const c = classifyOutcome(action, inv(1), inv(2), { success: true }, []);
        expect(c.outcome).toBe("confirmed_success");
        expect(c.evidence).toMatchObject({ quantityBefore: 1, quantityAfter: 2 });
    });
    test("a different item increasing is NOT evidence", () => {
        const after = makeObs({ inventory: [{ slot: 0, id: 995, name: "Coins", quantity: 50 }] });
        expect(classifyOutcome(action, makeObs(), after, { success: true }, []).outcome).not.toBe("confirmed_success");
    });
    test("unchanged with item still visible stays unconfirmed", () => {
        const after = makeObs({ nearbyGroundItems: [ground(526, "Bones")] });
        const c = classifyOutcome(action, makeObs(), after, { success: true }, []);
        expect(c.reason).toBe("inventory_unchanged_item_still_visible");
    });
    test("taken_by_other is a confirmed failure", () => {
        expect(classifyOutcome(action, makeObs(), makeObs(), { success: false, reason: "taken_by_other" }, []).outcome).toBe("confirmed_failure");
    });
    test("sdk timeout is partial, not failure", () => {
        expect(classifyOutcome(action, makeObs(), makeObs(), { success: false, reason: "timeout" }, []).outcome).toBe("partial_progress_or_timeout");
    });
    test("scoped failure message", () => {
        const c = classifyOutcome(action, makeObs(), makeObs(), { success: false }, [{ text: "You can't reach that!" }]);
        expect(c.outcome).toBe("confirmed_failure");
    });
});

describe("dialog", () => {
    test("a click the SDK reports as failed is not success, even when the page changed", () => {
        // Real run: "Failed to click dialog option" was logged as confirmed_success.
        const c = classifyOutcome({ type: "dialog_continue" }, makeObs({ dialog: dlg("p0") }), makeObs({ dialog: dlg("p1") }),
            { success: true, message: "Failed to click dialog option" }, []);
        expect(c.outcome).not.toBe("confirmed_success");
    });
    test("page change is success for continue", () => {
        const c = classifyOutcome({ type: "dialog_continue" }, makeObs({ dialog: dlg("p0") }), makeObs({ dialog: dlg("p1") }), { success: true }, []);
        expect(c.reason).toBe("dialog_page_changed");
    });
    test("isWaiting toggling alone is not progress", () => {
        const a = makeObs({ dialog: dlg("p0") });
        const b = makeObs({ dialog: { ...dlg("p0"), isWaiting: true } });
        expect(classifyOutcome({ type: "dialog_continue" }, a, b, { success: true }, []).outcome).toBe("unconfirmed");
    });
    test("talk-to opening a dialog is success", () => {
        const c = classifyOutcome({ type: "interact_npc", npc: npcRef, option: "Talk-to" }, makeObs(), makeObs({ dialog: dlg("p0") }), { success: true }, []);
        expect(c.reason).toBe("dialog_opened_or_changed");
    });
});

describe("pickpocket", () => {
    const action: ResolvedAction = { type: "pickpocket", npc: npcRef };
    test("game message is the primary evidence", () => {
        const c = classifyOutcome(action, makeObs(), makeObs(), { success: false, reason: "rejected" }, [{ text: "You pickpocket the man." }]);
        expect(c.outcome).toBe("confirmed_success");
    });
    test("stunned reason is decisive", () => {
        expect(classifyOutcome(action, makeObs(), makeObs(), { success: false, reason: "stunned" }, []).outcome).toBe("confirmed_failure");
    });
});

describe("generic", () => {
    test("exception is unconfirmed", () => {
        const c = classifyOutcome({ type: "attack", npc: npcRef }, makeObs(), makeObs(), { success: false, reason: "threw_exception" }, []);
        expect(c.outcome).toBe("unconfirmed");
    });
    test("wait confirms when ticks advanced", () => {
        expect(classifyOutcome({ type: "wait", ticks: 1 }, makeObs({ tick: 1 }), makeObs({ tick: 2 }), { success: true }, []).outcome).toBe("confirmed_success");
    });
});
