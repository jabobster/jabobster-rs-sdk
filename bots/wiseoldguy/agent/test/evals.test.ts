// Tests of the eval harness itself. No model involved: each case's good/bad examples must
// score as intended, so a wrong case is caught here instead of blaming the model later.

import { describe, expect, test } from "bun:test";
import { CASES } from "../evalCases";
import { formatEvalReport, judge, prepare, runEvals, summarizeEvals } from "../evalRunner";
import { cowGoal } from "../goals";
import { LocalModelPolicy } from "../localModel";
import { FixedPolicy } from "../policy";
import { buildSystemPrompt, renderTurn } from "../view";

const goal = cowGoal();

describe("eval cases are internally consistent", () => {
    test("ids are unique and there are cases", () => {
        const ids = CASES.map((c) => c.id);
        expect(new Set(ids).size).toBe(ids.length);
        expect(ids.length).toBeGreaterThanOrEqual(8);
    });

    for (const c of CASES) {
        test(`${c.id}: good examples pass, bad examples do not`, () => {
            const p = prepare(c);
            const { good, bad } = c.examples(p.view, p.handles);
            expect(good.length).toBeGreaterThan(0);
            expect(bad.length).toBeGreaterThan(0);
            for (const g of good) expect(judge(g, c, p, goal), `good ${JSON.stringify(g)}`).toMatchObject({ verdict: "pass" });
            for (const b of bad) expect(judge(b, c, p, goal).verdict, `bad ${JSON.stringify(b)}`).not.toBe("pass");
        });

        test(`${c.id}: prompt stays small`, () => {
            const p = prepare(c);
            const chars = buildSystemPrompt(goal.goal, goal.allowedActions).length + renderTurn(p.view, p.memory, p.note).length;
            expect(chars / 4).toBeLessThan(800);
        });

        test(`${c.id}: build() returns an independent copy`, () => {
            const a = c.build();
            a.obs.player.x = -5;
            expect(c.build().obs.player.x).not.toBe(-5);
        });
    }

    test("the cases cover each real failure we pinned", () => {
        const ids = CASES.map((c) => c.id).join(" ");
        for (const needle of ["lingering_combat", "loot_visible_idle", "hide_still_on_ground", "busy_cow", "no_cow", "goal_complete"]) expect(ids).toContain(needle);
    });
});

describe("scoring", () => {
    test("an oracle that answers each case correctly scores 100%", async () => {
        let i = 0;
        const oracle = new FixedPolicy(() => {
            const p = prepare(CASES[i++]);
            return JSON.stringify(CASES[i - 1].examples(p.view, p.handles).good[0]);
        });
        const results = await runEvals(oracle, CASES, goal);
        expect(summarizeEvals(results)).toMatchObject({ passRate: 1, wrong: 0, invalid: 0 });
    });

    test("always saying 'done' (the habit seen in the real runs) fails nearly everything", async () => {
        const lazy = new FixedPolicy(() => '{"type":"stop","outcome":"done"}');
        const s = summarizeEvals(await runEvals(lazy, CASES, goal));
        expect(s.pass).toBe(1); // only goal_complete
        expect(s.wrong).toBe(CASES.length - 1);
    });

    test("unparseable output and disallowed actions count as invalid, not wrong", async () => {
        const s1 = summarizeEvals(await runEvals(new FixedPolicy(() => "I will attack the cow"), CASES, goal));
        expect(s1.invalid).toBe(CASES.length);
        const s2 = summarizeEvals(await runEvals(new FixedPolicy(() => ({ type: "walk_to", x: 3200, z: 3200 })), CASES, goal));
        expect(s2.invalid).toBe(CASES.length);
    });

    test("a policy that throws is recorded, and the run continues", async () => {
        const broken = new FixedPolicy(() => { throw new Error("server down"); });
        const results = await runEvals(broken, CASES.slice(0, 2), goal);
        expect(results).toHaveLength(2);
        expect(results[0].outputs[0].raw).toContain("server down");
        expect(results[0].invalid).toBe(1);
    });

    test("repeated runs are counted per run", async () => {
        const results = await runEvals(new FixedPolicy(() => ({ type: "wait" })), [CASES[1]], goal, { runs: 4 });
        expect(results[0]).toMatchObject({ runs: 4, pass: 4 });
    });

    test("the report names each case and shows an example of what went wrong", async () => {
        const report = formatEvalReport(await runEvals(new FixedPolicy(() => ({ type: "wait" })), CASES, goal));
        expect(report).toContain("fresh_start");
        expect(report).toContain("FAIL");
        expect(report).toContain("PASS"); // mid_fight_wait
        expect(report).toMatch(/pass \d+%/);
    });
});

describe("with the LM Studio client", () => {
    test("the prompt the server receives is the controller's prompt, with the narrowed schema", async () => {
        const calls: any[] = [];
        const fetchImpl = (async (_u: string, init: any) => {
            calls.push(JSON.parse(init.body));
            return Response.json({ choices: [{ message: { content: '{"type":"stop","outcome":"done"}' }, finish_reason: "stop" }] });
        }) as any;
        const policy = new LocalModelPolicy({ fetchImpl, model: "qwen3.5-4b" });
        const complete = CASES.filter((c) => c.id === "goal_complete");
        const [r] = await runEvals(policy, complete, goal);

        expect(r.pass).toBe(1);
        const p = prepare(complete[0]);
        expect(calls[0].messages[0].content).toBe(buildSystemPrompt(goal.goal, goal.allowedActions));
        expect(calls[0].messages[1].content).toBe(renderTurn(p.view, p.memory, p.note));
        expect(calls[0].response_format.json_schema.schema.properties.type.enum).toEqual(["attack", "pickup", "wait", "stop"]);
    });
});
