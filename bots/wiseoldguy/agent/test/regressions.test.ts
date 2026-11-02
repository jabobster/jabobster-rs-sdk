// Failures from the real live runs, pinned against the real logged observations.
// Fixture records are addressed as <file>#<1-based record number>.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cowGoal } from "../goals";
import { formatMetrics, summarizeDecisions } from "../metrics";
import { parseJsonl } from "../replay";
import { validateAction } from "../validate";
import { renderState, toModelView } from "../view";

const FIXTURES = join(import.meta.dir, "fixtures");
const load = (name: string) => parseJsonl(readFileSync(join(FIXTURES, name), "utf8"));
const rec = (name: string, n: number) => load(`${name}.diagnostics.jsonl`)[n - 1];

describe("false 'done' (empty-pen runs: model stopped after picking up the Bones)", () => {
    const goal = cowGoal();
    const baseline = rec("model-empty-pen-a", 1).before;

    test("the stray Cowhide already in the inventory is exactly why the model was confused", () => {
        const view = toModelView(rec("model-empty-pen-a", 9).before).view;
        expect(view.inventory.some((i) => /cowhide/i.test(i.name))).toBe(true); // it carried one all along
        expect(view.items.map((i) => i.name)).toContain("Cowhide");              // the real drop is still on the ground
    });
    test("the goal check rejects done at record 9: the Cowhide count has not risen", () => {
        const check = goal.verifyDone(rec("model-empty-pen-a", 9).before, baseline);
        expect(check).toMatchObject({ done: false });
        expect((check as any).missing).toContain("Cowhide");
        expect((check as any).missing).not.toContain("Bones");
    });
    test("and accepts done at record 11, after the drop was picked up", () => {
        expect(goal.verifyDone(rec("model-empty-pen-a", 11).before, baseline)).toEqual({ done: true });
    });
    test("same for the second run (record 5 rejected, record 7 accepted)", () => {
        const base = rec("model-empty-pen-b", 1).before;
        expect(goal.verifyDone(rec("model-empty-pen-b", 5).before, base)).toMatchObject({ done: false });
        expect(goal.verifyDone(rec("model-empty-pen-b", 7).before, base)).toEqual({ done: true });
    });
});

describe("lingering combat flag (empty-pen run A, ticks 2063-2072)", () => {
    test("record 3: flag lingers but the loot has not dropped yet", () => {
        const before = rec("model-empty-pen-a", 3).before;
        expect(before.player.combat).toMatchObject({ inCombat: true, targetType: "none", targetIndex: -1 });
        expect(before.nearbyGroundItems).toEqual([]);
        expect(toModelView(before).view.player.combat).toBe("idle");
    });
    // Records 4 and 5 are where the flag cost real steps: loot visible, but the view said "fighting".
    test.each([4, 5])("record %i: the game says inCombat with no target; the model must be told 'idle'", (n) => {
        const before = rec("model-empty-pen-a", n).before;
        expect(before.player.combat).toMatchObject({ inCombat: true, targetType: "none", targetIndex: -1 });
        const { view } = toModelView(before);
        expect(view.player.combat).toBe("idle");
        expect(view.items.map((i) => i.name)).toContain("Cowhide"); // loot was already there to pick up
        expect(renderState(view)).not.toContain("fighting");
    });
    test("record 2 is a real fight and still shows as one", () => {
        const { view } = toModelView(rec("model-empty-pen-a", 2).before);
        expect(view.player.combat).toBe("npc");
        expect(view.player.combatTarget).toBe("Cow");
    });
});

describe("dithering with no flag problem (empty-pen run A, records 6-7)", () => {
    // These two waits are NOT explained by the combat flag. Combat is already false.
    test.each([6, 7])("record %i: idle, loot on the ground, and the model still chose to wait", (n) => {
        const r = rec("model-empty-pen-a", n);
        expect(r.before.player.combat.inCombat).toBe(false);
        expect(toModelView(r.before).view.items.map((i) => i.name)).toContain("Cowhide");
        expect(r.modelAction).toMatchObject({ type: "wait" });
    });
});

describe("copied example coordinate (crowded run, record 8: walk_to 3200,3200)", () => {
    const before = rec("model-crowded", 8).before;
    const ctx = toModelView(before);
    const action = { type: "walk_to", x: 3200, z: 3200 };

    test("it is 80 tiles away: inside the 128 cap, so it is accepted (was refused at the old 64 cap)", () => {
        const v: any = validateAction(action, ctx, before);
        expect(v.ok).toBe(true);
        expect(v.action).toMatchObject({ type: "walk_to", x: 3200, z: 3200 });
    });
    test("with the cow goal's action set it is not even offered", () => {
        const v: any = validateAction(action, ctx, before, { allowed: cowGoal().allowedActions });
        expect(v.code).toBe("action_not_allowed");
    });
});

describe("busy cow (crowded run: 'Someone else is fighting that.')", () => {
    test("an npc fighting something else is flagged and sorted behind a free one", () => {
        const obs = rec("model-empty-pen-a", 1).before;
        const nearest = obs.nearbyNpcs.filter((n: any) => n.name === "Cow").sort((a: any, b: any) => a.distance - b.distance)[0];
        nearest.inCombat = true;
        const { view, handles } = toModelView(obs);
        const cows = view.npcs.filter((n) => n.name === "Cow");
        expect(cows[0].busy).toBe(false);
        expect(cows[cows.length - 1].busy).toBe(true);
        expect(handles.npcs[cows[0].h].index).not.toBe(nearest.index);
    });
});

describe("metrics on the real decision logs", () => {
    const decisions = (name: string) => summarizeDecisions(load(`${name}.decisions.jsonl`));

    test("thinking ate the token budget: every reply was empty", () => {
        const m = decisions("model-thinking-truncated");
        expect(m).toMatchObject({ modelCalls: 6, parseFailures: 6, executed: 0 });
        expect(m.invalidReplyRate).toBe(1);
        expect(m.completionTokens).toBe(600);
    });
    test("crowded run: two actions were refused before reaching the game", () => {
        const m = decisions("model-crowded");
        expect(m).toMatchObject({ modelCalls: 16, rejected: 2, parseFailures: 0 });
        expect(m.rejectReasons).toEqual({ too_far: 1, target_gone: 1 });
    });
    test("empty-pen runs: no invalid replies, one false 'done' each, all else executed", () => {
        for (const [name, calls] of [["model-empty-pen-a", 11], ["model-empty-pen-b", 7]] as const) {
            const m = decisions(name);
            expect(m).toMatchObject({ modelCalls: calls, executed: calls, parseFailures: 0, rejected: 0, goalRejected: 1 });
            expect(m.avgLatencyMs).toBeLessThan(1000);
        }
    });
    test("the fixed-policy run: 39 successes and one decisive failure", () => {
        expect(decisions("fixed-policy").statusCounts).toEqual({ confirmed_success: 39, confirmed_failure: 1 });
    });
    test("the report is readable", () => {
        expect(formatMetrics(decisions("model-empty-pen-a"))).toContain('false "done" claims rejected by the goal check: 1');
    });
});
