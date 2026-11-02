import { describe, expect, test } from "bun:test";
import { runController } from "../controller";
import { LocalModelPolicy } from "../localModel";
import { memorySink } from "../logger";
import { formatMetrics, summarizeDecisions } from "../metrics";
import { createLiveAdapter } from "../runAction";
import { cow, createFakeGame } from "./fakeGame";

/** A fake LM Studio. `replies` are returned as message content, in order. */
function fakeServer(replies: string[], opts: { status?: number; models?: string[] } = {}) {
    const calls: { url: string; method: string; body: any }[] = [];
    let i = 0;
    const fetchImpl = (async (url: string, init: any) => {
        const body = init?.body ? JSON.parse(init.body) : undefined;
        calls.push({ url, method: init?.method, body });
        if (opts.status) return new Response("boom", { status: opts.status });
        if (url.endsWith("/models")) {
            return Response.json({ data: (opts.models ?? ["text-embedding-nomic", "qwen3.5-4b"]).map((id) => ({ id })) });
        }
        const content = replies[Math.min(i++, replies.length - 1)];
        return Response.json({
            choices: [{ message: { content }, finish_reason: "stop" }],
            usage: { prompt_tokens: 480, completion_tokens: 18 },
        });
    }) as unknown as typeof fetch;
    return { fetchImpl, calls };
}

const input = (over = {}) => ({
    goal: "g", step: 1, attempt: 0, system: "SYS", user: "STATE:\nx", memory: [], view: {} as any, ...over,
});

describe("LocalModelPolicy request", () => {
    test("sends system+user, temperature 0, small max_tokens and the action schema", async () => {
        const s = fakeServer(['{"type":"wait"}']);
        const p = new LocalModelPolicy({ fetchImpl: s.fetchImpl });
        const out = await p.decide(input());
        expect(out).toBe('{"type":"wait"}');

        const post = s.calls.find((c) => c.method === "POST")!;
        expect(post.url).toBe("http://localhost:1234/v1/chat/completions");
        expect(post.body.model).toBe("qwen3.5-4b");           // embedding model skipped
        expect(post.body.temperature).toBe(0);
        expect(post.body.max_tokens).toBe(100);
        expect(post.body.messages).toEqual([{ role: "system", content: "SYS" }, { role: "user", content: "STATE:\nx" }]);
        expect(post.body.response_format.type).toBe("json_schema");
        const schema = post.body.response_format.json_schema.schema;
        expect(schema.additionalProperties).toBe(false);
        expect(schema.properties.type.enum).toContain("attack");
        expect(schema.properties.why).toBeUndefined();
    });

    test("withWhy adds the field; structured:false omits the schema; extraBody is merged", async () => {
        const a = fakeServer(["{}"]);
        await new LocalModelPolicy({ fetchImpl: a.fetchImpl, withWhy: true, model: "m" }).decide(input());
        expect(a.calls[0].body.response_format.json_schema.schema.properties.why).toBeDefined();

        const b = fakeServer(["{}"]);
        await new LocalModelPolicy({ fetchImpl: b.fetchImpl, model: "m", structured: false, extraBody: { chat_template_kwargs: { enable_thinking: false } } }).decide(input());
        expect(b.calls[0].body.response_format).toBeUndefined();
        expect(b.calls[0].body.chat_template_kwargs).toEqual({ enable_thinking: false });
    });

    test("an explicit model skips discovery; usage is recorded", async () => {
        const s = fakeServer(["{}"]);
        const p = new LocalModelPolicy({ fetchImpl: s.fetchImpl, model: "mine" });
        await p.decide(input());
        expect(s.calls.every((c) => c.method === "POST")).toBe(true);
        expect(p.lastMeta).toMatchObject({ model: "mine", promptTokens: 480, completionTokens: 18, finishReason: "stop" });
        expect(p.stats.calls).toBe(1);
    });
});

describe("LocalModelPolicy thinking and schema", () => {
    test("Qwen models get thinking disabled by default (real log: 100 tokens of thinking, empty reply)", async () => {
        const s = fakeServer(["{}"]);
        await new LocalModelPolicy({ fetchImpl: s.fetchImpl, model: "qwen3.5-4b" }).decide(input());
        expect(s.calls[0].body.chat_template_kwargs).toEqual({ enable_thinking: false });
    });
    test("thinking:true leaves it alone; non-Qwen models are untouched", async () => {
        const a = fakeServer(["{}"]);
        await new LocalModelPolicy({ fetchImpl: a.fetchImpl, model: "qwen3.5-4b", thinking: true }).decide(input());
        expect(a.calls[0].body.chat_template_kwargs).toBeUndefined();
        const b = fakeServer(["{}"]);
        await new LocalModelPolicy({ fetchImpl: b.fetchImpl, model: "llama-3.2-1b" }).decide(input());
        expect(b.calls[0].body.chat_template_kwargs).toBeUndefined();
    });
    test("empty reply cut off by max_tokens is flagged in meta", async () => {
        const fetchImpl = (async () => Response.json({ choices: [{ message: { content: "" }, finish_reason: "length" }] })) as any;
        const p = new LocalModelPolicy({ fetchImpl, model: "m" });
        const warn = console.warn; console.warn = () => {};
        try { await p.decide(input()); } finally { console.warn = warn; }
        expect(String(p.lastMeta?.hint)).toContain("thinking");
    });
    test("the schema is narrowed to the goal's actions and their fields", async () => {
        const s = fakeServer(["{}"]);
        await new LocalModelPolicy({ fetchImpl: s.fetchImpl, model: "m" }).decide(input({ allowed: ["attack", "pickup", "wait"] }));
        const schema = s.calls[0].body.response_format.json_schema.schema;
        expect(schema.properties.type.enum).toEqual(["attack", "pickup", "wait", "stop"]);
        expect(Object.keys(schema.properties).sort()).toEqual(["outcome", "target", "ticks", "type"]);
    });
});

describe("LocalModelPolicy auth", () => {
    test("apiKey is sent as a Bearer header on both /models and /chat/completions", async () => {
        const seen: any[] = [];
        const fetchImpl = (async (url: string, init: any) => {
            seen.push({ url, auth: init.headers.Authorization });
            return url.endsWith("/models")
                ? Response.json({ data: [{ id: "qwen" }] })
                : Response.json({ choices: [{ message: { content: "{}" } }] });
        }) as any;
        await new LocalModelPolicy({ fetchImpl, apiKey: "sk-lm-test" }).decide(input());
        expect(seen).toHaveLength(2);
        expect(seen.every((s) => s.auth === "Bearer sk-lm-test")).toBe(true);
    });
    test("no key means no Authorization header", async () => {
        let headers: any;
        const fetchImpl = (async (_u: string, init: any) => { headers = init.headers; return Response.json({ choices: [{ message: { content: "{}" } }] }); }) as any;
        await new LocalModelPolicy({ fetchImpl, model: "m" }).decide(input());
        expect(headers.Authorization).toBeUndefined();
    });
    test("401 explains how to fix it and does not echo the key", async () => {
        const p = new LocalModelPolicy({ fetchImpl: fakeServer([], { status: 401 }).fetchImpl, model: "m", apiKey: "sk-secret" });
        const err: any = await p.decide(input()).catch((e) => e);
        expect(err.message).toContain("LMSTUDIO_API_KEY");
        expect(err.message).not.toContain("sk-secret");
    });
});

describe("LocalModelPolicy failures", () => {
    test("HTTP error is reported with the status", async () => {
        const p = new LocalModelPolicy({ fetchImpl: fakeServer([], { status: 500 }).fetchImpl, model: "m" });
        await expect(p.decide(input())).rejects.toThrow("HTTP 500");
    });
    test("unreachable server gives an actionable message", async () => {
        const p = new LocalModelPolicy({ fetchImpl: (async () => { throw new Error("ECONNREFUSED"); }) as any, model: "m" });
        await expect(p.decide(input())).rejects.toThrow("Is the local server running");
    });
    test("slow server times out instead of hanging", async () => {
        const slow = ((_u: string, init: any) =>
            new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted"))))) as any;
        const p = new LocalModelPolicy({ fetchImpl: slow, model: "m", timeoutMs: 20 });
        await expect(p.decide(input())).rejects.toThrow("timed out");
    });
    test("no chat model loaded", async () => {
        const p = new LocalModelPolicy({ fetchImpl: fakeServer([], { models: ["text-embedding-x"] }).fetchImpl });
        await expect(p.ensureModel()).rejects.toThrow("No chat model");
    });
});

describe("model in the loop (fake LM Studio + fake game)", () => {
    function setup(replies: string[], serverOpts = {}) {
        const game = createFakeGame({ npcs: [cow()] });
        const decisions = memorySink();
        const server = fakeServer(replies, serverOpts);
        const policy = new LocalModelPolicy({ fetchImpl: server.fetchImpl, model: "m" });
        const adapter = createLiveAdapter({ bot: game.bot, sdk: game.sdk });
        return { game, decisions, policy, adapter, server };
    }

    test("think-tags and fences in replies are tolerated; the goal completes", async () => {
        const s = setup([
            '<think>The cow is n1.</think>{"type":"attack","target":"n1"}',
            '```json\n{"type":"wait","ticks":3}\n```',
            '{"type":"pickup","target":"g1"}',
            '{"type":"pickup","target":"g1"}',
            '{"type":"stop","outcome":"done"}',
        ]);
        const r = await runController(s.adapter, s.policy, { goal: "kill a cow" }, s.decisions);
        expect(r.stopReason).toBe("model_done");
        expect(s.game.world.inv.map((i) => i.name).sort()).toEqual(["Bones", "Cowhide"]);
        // latency and token meta ride along in the decision log
        expect(s.decisions.records[0].meta).toMatchObject({ completionTokens: 18 });
        expect(typeof s.decisions.records[0].latencyMs).toBe("number");
    });

    test("a bad reply is retried once with the validation error in the NEXT prompt", async () => {
        const s = setup(['{"type":"attack","target":"n7"}', '{"type":"stop","outcome":"blocked"}']);
        await runController(s.adapter, s.policy, { goal: "g" }, s.decisions);
        const posts = s.server.calls.filter((c) => c.method === "POST");
        expect(posts[0].body.messages[1].content).not.toContain("REJECTED");
        expect(posts[1].body.messages[1].content).toContain("unknown_handle");
        expect(s.game.world.calls).toEqual([]);
    });

    test("system prompt is byte-identical across turns (KV-cache friendly)", async () => {
        const s = setup(['{"type":"wait"}', '{"type":"wait"}', '{"type":"stop","outcome":"blocked"}']);
        await runController(s.adapter, s.policy, { goal: "g" }, s.decisions);
        const systems = s.server.calls.filter((c) => c.method === "POST").map((c) => c.body.messages[0].content);
        expect(new Set(systems).size).toBe(1);
    });

    test("LM Studio down ends the run with stopReason=error, not a crash", async () => {
        const s = setup([], { status: 500 });
        const r = await runController(s.adapter, s.policy, { goal: "g" }, s.decisions);
        expect(r.stopReason).toBe("error");
        expect(r.detail).toContain("HTTP 500");
        expect(s.game.world.calls).toEqual([]);
    });
});

describe("metrics", () => {
    test("counts invalid replies, rejections and uncertainty", () => {
        const m = summarizeDecisions([
            { step: 1, attempt: 0, parse: "failed", reason: "not_json", promptChars: 1500, latencyMs: 900 },
            { step: 1, attempt: 1, parse: "ok", status: "not_executed", reason: "unknown_handle", promptChars: 1700, latencyMs: 1100 },
            { step: 1, attempt: 0, parse: "ok", status: "confirmed_success", promptChars: 1600, latencyMs: 1000, meta: { completionTokens: 20 } },
            { step: 2, attempt: 0, parse: "ok", status: "unconfirmed", promptChars: 1600, latencyMs: 1000 },
        ]);
        expect(m.runs).toBe(2);
        expect(m.invalidReplyRate).toBe(0.5);
        expect(m.unconfirmedRate).toBe(0.5);
        expect(m.rejectReasons).toEqual({ not_json: 1, unknown_handle: 1 });
        expect(m.avgLatencyMs).toBe(1000);
        expect(formatMetrics(m)).toContain("invalid replies 2 (50.0%)");
    });
});
