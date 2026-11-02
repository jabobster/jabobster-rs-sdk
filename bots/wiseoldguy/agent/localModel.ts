// LocalModelPolicy: asks an OpenAI-compatible local server (LM Studio) for ONE action.
// The model only ever sees the compact text turn; replies are schema-constrained so
// malformed JSON should be rare, but the controller still validates everything.

import { actionJsonSchema } from "./contract";
import type { Policy, PolicyInput } from "./policy";

export interface LocalModelConfig {
    /** Default http://localhost:1234/v1 (LM Studio). */
    baseUrl?: string;
    /** If omitted, the first non-embedding model reported by GET /models is used. */
    model?: string;
    /** Sent as `Authorization: Bearer <key>` when LM Studio requires auth. Never logged. */
    apiKey?: string;
    temperature?: number;      // default 0
    maxTokens?: number;        // default 100 (an action is ~20 tokens)
    timeoutMs?: number;        // default 60_000 per request
    seed?: number;
    /** Ask for the optional short `why` field (debugging only; costs tokens). */
    withWhy?: boolean;
    /** Constrain output with a JSON schema. Turn off only to compare against free-form output. */
    structured?: boolean;      // default true
    /**
     * Let the model think before answering. Default false: for Qwen-family models the
     * request sends chat_template_kwargs.enable_thinking=false, because a ~100-token
     * budget is consumed entirely by thinking and the reply comes back empty.
     */
    thinking?: boolean;
    /** Merged into the request body (wins over the defaults above). */
    extraBody?: Record<string, unknown>;
    fetchImpl?: typeof fetch;
}

export class LocalModelPolicy implements Policy {
    lastMeta?: Record<string, unknown>;
    readonly stats = { calls: 0, promptTokens: 0, completionTokens: 0, totalLatencyMs: 0 };

    private model: string | undefined;
    private warned = false;
    private readonly baseUrl: string;
    private readonly f: typeof fetch;

    constructor(private readonly cfg: LocalModelConfig = {}) {
        this.baseUrl = (cfg.baseUrl ?? "http://localhost:1234/v1").replace(/\/+$/, "");
        this.model = cfg.model;
        this.f = cfg.fetchImpl ?? fetch;
    }

    /** The settings that affect results, for result files and episode logs. Never includes the API key. */
    describe() {
        return {
            kind: "model" as const,
            model: this.model ?? this.cfg.model ?? null,
            thinking: this.cfg.thinking === true,
            temperature: this.cfg.temperature ?? 0,
            maxTokens: this.cfg.maxTokens ?? 100,
            structured: this.cfg.structured !== false,
            withWhy: this.cfg.withWhy === true,
            seed: this.cfg.seed ?? null,
        };
    }

    /** Resolve (and cache) the model id. Call once up front to fail fast if the server is down. */
    async ensureModel(): Promise<string> {
        if (this.model) return this.model;
        const res = await this.request("GET", "/models");
        const ids: string[] = (res?.data ?? []).map((m: any) => m.id).filter(Boolean);
        const chosen = ids.find((id) => !/embed/i.test(id));
        if (!chosen) throw new Error(`No chat model reported by ${this.baseUrl}/models. Load one in LM Studio.`);
        this.model = chosen;
        return chosen;
    }

    async decide(input: PolicyInput): Promise<string> {
        const model = await this.ensureModel();
        const body: Record<string, unknown> = {
            model,
            messages: [
                { role: "system", content: input.system },
                { role: "user", content: input.user },
            ],
            temperature: this.cfg.temperature ?? 0,
            max_tokens: this.cfg.maxTokens ?? 100,
            stream: false,
            ...(this.cfg.seed !== undefined ? { seed: this.cfg.seed } : {}),
            ...(this.cfg.structured === false
                ? {}
                : {
                      response_format: {
                          type: "json_schema",
                          json_schema: {
                              name: "agent_action", strict: true,
                              schema: actionJsonSchema({ withWhy: this.cfg.withWhy, allowed: input.allowed }),
                          },
                      },
                  }),
            ...(!this.cfg.thinking && /qwen/i.test(model) ? { chat_template_kwargs: { enable_thinking: false } } : {}),
            ...(this.cfg.extraBody ?? {}),
        };

        const started = Date.now();
        const res = await this.request("POST", "/chat/completions", body);
        const latencyMs = Date.now() - started;

        const choice = res?.choices?.[0];
        const content: string = choice?.message?.content ?? "";
        this.stats.calls++;
        this.stats.totalLatencyMs += latencyMs;
        this.stats.promptTokens += res?.usage?.prompt_tokens ?? 0;
        this.stats.completionTokens += res?.usage?.completion_tokens ?? 0;
        this.lastMeta = {
            model,
            finishReason: choice?.finish_reason ?? null,
            promptTokens: res?.usage?.prompt_tokens ?? null,
            completionTokens: res?.usage?.completion_tokens ?? null,
            modelLatencyMs: latencyMs,
            ...(choice?.finish_reason === "length" && !content.trim()
                ? { hint: "Hit max_tokens with no content: thinking is probably using the budget. Disable thinking or raise maxTokens." }
                : {}),
        };
        if (this.lastMeta.hint && !this.warned) {
            this.warned = true;
            console.warn(`[LocalModelPolicy] ${this.lastMeta.hint}`);
        }
        return content;
    }

    private async request(method: "GET" | "POST", path: string, body?: unknown): Promise<any> {
        const timeoutMs = this.cfg.timeoutMs ?? 60_000;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const res = await this.f(`${this.baseUrl}${path}`, {
                method,
                headers: {
                    "Content-Type": "application/json",
                    ...(this.cfg.apiKey ? { Authorization: `Bearer ${this.cfg.apiKey}` } : {}),
                },
                body: body === undefined ? undefined : JSON.stringify(body),
                signal: controller.signal,
            });
            if (!res.ok) {
                const text = await res.text().catch(() => "");
                const hint = res.status === 401 || res.status === 403
                    ? " (authentication failed: set LMSTUDIO_API_KEY to the key from LM Studio's Developer settings)"
                    : "";
                throw new Error(`LM Studio ${method} ${path} failed: HTTP ${res.status} ${text.slice(0, 200)}${hint}`);
            }
            return await res.json();
        } catch (error: any) {
            if (controller.signal.aborted) throw new Error(`LM Studio ${method} ${path} timed out after ${timeoutMs}ms`);
            if (error?.message?.startsWith("LM Studio")) throw error;
            throw new Error(`Cannot reach LM Studio at ${this.baseUrl} (${error?.message ?? error}). Is the local server running?`);
        } finally {
            clearTimeout(timer);
        }
    }
}
