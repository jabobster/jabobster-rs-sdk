import { describe, expect, test } from "bun:test";
import { parseModelOutput, validateAction } from "../validate";
import { toModelView } from "../view";
import { ground, makeObs, npc } from "./helpers";

const scene = (over = {}) =>
    makeObs({
        nearbyNpcs: [npc(5, "Cow"), npc(6, "Man", { options: ["Talk-to", "Pickpocket", "Attack"], distance: 5 })],
        nearbyGroundItems: [ground(526, "Bones")],
        ...over,
    });

function check(raw: unknown, obs = scene(), freshObs = obs, opts = {}) {
    return validateAction(raw, toModelView(obs, undefined, { global: false }), freshObs, opts);
}
const rejected = (v: any) => (v.ok ? "ok" : v.code);

describe("parseModelOutput", () => {
    test("plain JSON", () => expect(parseModelOutput('{"type":"wait"}')).toEqual({ ok: true, value: { type: "wait" } }));
    test("strips <think> and fences", () => {
        const r = parseModelOutput('<think>hmm {"a":1}</think>\n```json\n{"type":"wait","ticks":2}\n```');
        expect(r).toEqual({ ok: true, value: { type: "wait", ticks: 2 } });
    });
    test("braces inside strings", () => {
        const r = parseModelOutput('ok {"type":"stop","outcome":"done","why":"a } b"} trailing');
        expect(r.ok).toBe(true);
    });
    test("rejects prose", () => expect(parseModelOutput("I will attack").ok).toBe(false));
    test("rejects truncated JSON", () => expect(parseModelOutput('{"type":"wait"').ok).toBe(false));
    test("passes objects through", () => expect(parseModelOutput({ type: "wait" }).ok).toBe(true));
});

describe("schema stage", () => {
    test.each([
        [[], "not_object"],
        [{ type: "dance" }, "unknown_type"],
        [{ type: "attack" }, "missing_field"],
        [{ type: "attack", target: "n1", x: 3 }, "extra_field"],
        [{ type: "attack", target: "Cow" }, "bad_field_type"],
        [{ type: "pickup", target: "n1" }, "bad_field_type"],
        [{ type: "walk_to", x: "3200", z: 3200 }, "bad_field_type"],
        [{ type: "walk_to", x: 3200.5, z: 3200 }, "bad_field_type"],
        [{ type: "walk_to", x: -1, z: 3200 }, "out_of_range"],
        [{ type: "wait", ticks: 9 }, "out_of_range"],
        [{ type: "stop", outcome: "maybe" }, "bad_field_type"],
        [{ type: "dialog_select", choice: 0 }, "out_of_range"],
    ])("%j -> %s", (raw, code) => expect(rejected(check(raw))).toBe(code));

    test("schema rejections are stage=schema", () => {
        const v: any = check({ type: "attack" });
        expect(v.stage).toBe("schema");
    });
    test("why is kept but truncated", () => {
        const v: any = check({ type: "wait", why: "x".repeat(200) });
        expect(v.ok && v.model.why.length).toBe(80);
    });
});

describe("state stage", () => {
    test("valid attack resolves the handle to the real entity", () => {
        const v: any = check({ type: "attack", target: "n1" });
        expect(v.ok).toBe(true);
        expect(v.action.npc).toMatchObject({ index: 5, name: "Cow" });
    });
    test("unknown handle lists valid ones", () => {
        const v: any = check({ type: "attack", target: "n9" });
        expect(v.code).toBe("unknown_handle");
        expect(v.message).toContain("n1, n2");
    });
    test("npc vanished between observation and dispatch", () => {
        const fresh = scene({ nearbyNpcs: [npc(6, "Man")] });
        expect(rejected(check({ type: "attack", target: "n1" }, scene(), fresh))).toBe("target_gone");
    });
    test("same index but different name (slot reused) is target_gone", () => {
        const fresh = scene({ nearbyNpcs: [npc(5, "Goblin")] });
        expect(rejected(check({ type: "attack", target: "n1" }, scene(), fresh))).toBe("target_gone");
    });
    test("option not offered", () => {
        expect(rejected(check({ type: "pickpocket", target: "n1" }))).toBe("option_not_offered");
        expect(rejected(check({ type: "interact_npc", target: "n1", option: "Talk-to" }))).toBe("option_not_offered");
    });
    test("option match is case-insensitive and normalised", () => {
        const v: any = check({ type: "interact_npc", target: "n2", option: "talk-to" });
        expect(v.ok && v.action.option).toBe("Talk-to");
    });
    test("unreachable npc", () => {
        const obs = scene({ nearbyNpcs: [npc(5, "Cow", { reachable: false })] });
        expect(rejected(check({ type: "attack", target: "n1" }, obs))).toBe("unreachable");
    });
    test("already attacking the same npc", () => {
        const obs = scene({ player: { ...makeObs().player, combat: { inCombat: true, targetIndex: 5, targetType: "npc" } } });
        expect(rejected(check({ type: "attack", target: "n1" }, obs))).toBe("already_attacking");
    });
    test("pickup: stale and full-inventory cases", () => {
        expect(rejected(check({ type: "pickup", target: "g1" }))).toBe("ok");
        expect(rejected(check({ type: "pickup", target: "g1" }, scene(), scene({ nearbyGroundItems: [] })))).toBe("target_gone");
        const full = scene({ inventory: Array.from({ length: 28 }, (_, i) => ({ slot: i, id: 1000 + i, name: "Junk", quantity: 1 })) });
        expect(rejected(check({ type: "pickup", target: "g1" }, full))).toBe("inventory_full");
    });
    test("walk_to bounds and path", () => {
        expect(rejected(check({ type: "walk_to", x: 3210, z: 3200 }))).toBe("ok");
        // 100 tiles is inside the 128 cap. Beyond it, the walk is clamped to 128 tiles along the line.
        expect(rejected(check({ type: "walk_to", x: 3300, z: 3200 }))).toBe("ok");
        const far: any = check({ type: "walk_to", x: 3400, z: 3200 });
        expect(far).toMatchObject({ ok: true, action: { type: "walk_to", x: 3328, z: 3200 } });
        // Already within tolerance of where the player stands: refused.
        expect(rejected(check({ type: "walk_to", x: 3200, z: 3200 }))).toBe("already_there");
        expect(rejected(check({ type: "walk_to", x: 3202, z: 3200 }))).toBe("already_there");
        expect(rejected(check({ type: "walk_to", x: 3210, z: 3200 }, scene(), scene(), { pathExists: () => false }))).toBe("no_path");
        const v: any = check({ type: "walk_to", x: 3210, z: 3200 });
        expect(v.action.tolerance).toBe(2); // explicit default
    });
    test("blocked states", () => {
        expect(rejected(check({ type: "attack", target: "n1" }, scene(), scene({ inGame: false })))).toBe("not_in_game");
        expect(rejected(check({ type: "attack", target: "n1" }, scene(), scene({ player: { ...makeObs().player, isDead: true } })))).toBe("player_dead");
        expect(rejected(check({ type: "attack", target: "n1" }, scene(), scene({ shopOpen: true })))).toBe("modal_open");
        expect(rejected(check({ type: "wait" }, scene(), scene({ shopOpen: true })))).toBe("ok");
        expect(rejected(check({ type: "stop", outcome: "blocked" }, scene(), scene({ bankOpen: true })))).toBe("ok");
    });
});

describe("dialog actions", () => {
    const open = (options: string[]) =>
        scene({ dialog: { isOpen: true, isWaiting: false, pageId: "p1", text: "Hello", options: options.map((t, i) => ({ index: i + 1, text: t })) } });

    test("closed dialog", () => {
        expect(rejected(check({ type: "dialog_continue" }))).toBe("dialog_closed");
        expect(rejected(check({ type: "dialog_select", choice: 1 }))).toBe("dialog_closed");
    });
    test("continue allowed only without choices", () => {
        expect(rejected(check({ type: "dialog_continue" }, open(["Click here to continue"])))).toBe("ok");
        expect(rejected(check({ type: "dialog_continue" }, open([])))).toBe("ok");
        expect(rejected(check({ type: "dialog_continue" }, open(["Yes", "No"])))).toBe("dialog_requires_choice");
    });
    test("select resolves choice number to text", () => {
        const v: any = check({ type: "dialog_select", choice: 2 }, open(["Yes", "No"]));
        expect(v.action).toEqual({ type: "dialog_select", optionText: "No" });
    });
    test("bad choice number", () => {
        expect(rejected(check({ type: "dialog_select", choice: 5 }, open(["Yes", "No"])))).toBe("bad_choice");
    });
    test("duplicate option text is ambiguous", () => {
        expect(rejected(check({ type: "dialog_select", choice: 1 }, open(["Ok", "Ok"])))).toBe("ambiguous_option");
    });
    test("dialog page changed between view and dispatch", () => {
        const fresh = open(["Something else"]);
        expect(rejected(check({ type: "dialog_select", choice: 1 }, open(["Yes", "No"]), fresh))).toBe("target_gone");
    });
});

describe("allowed actions", () => {
    const only = { allowed: ["attack", "pickup", "wait"] as const };
    test("an action outside the goal's set is rejected before any state check", () => {
        const v: any = check({ type: "walk_to", x: 3210, z: 3200 }, scene(), scene(), only);
        expect(v.code).toBe("action_not_allowed");
        expect(v.message).toContain("attack, pickup, wait, stop");
    });
    test("allowed actions and stop still pass", () => {
        expect(rejected(check({ type: "attack", target: "n1" }, scene(), scene(), only))).toBe("ok");
        expect(rejected(check({ type: "stop", outcome: "done" }, scene(), scene(), only))).toBe("ok");
    });
});
