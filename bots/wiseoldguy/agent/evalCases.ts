// Prompt-quality eval cases. Each is a game state a policy must respond to, built from the
// REAL observations in test/fixtures (your logged runs) so they test what actually happened.
//
// `accept` says which resolved actions are right. `examples` gives raw model replies that must
// pass and must fail; test/evals.test.ts checks those, so a mistake in a case shows up offline,
// before any model is asked.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { HandleMap, ModelView, Observation, ResolvedAction } from "./contract";
import { UNCERTAIN_NOTE } from "./controller";
import { parseJsonl } from "./replay";

export interface BuiltCase {
    obs: Observation;
    memory: string[];
    note?: string;
}

/**
 * dev: cases used while tuning prompts and policies. frozen: cases written down once and never tuned
 * against, so they can answer "did this really get better, or did we overfit the dev set?".
 */
export type EvalSplit = "dev" | "frozen";

export interface EvalCase {
    id: string;
    split: EvalSplit;
    /** What a good policy does here, and which real failure this guards against. */
    description: string;
    build(): BuiltCase;
    accept(action: ResolvedAction): boolean;
    examples(view: ModelView, handles: HandleMap): { good: unknown[]; bad: unknown[] };
}

// ---------------------------------------------------------------- fixtures

const FIXTURES = join(import.meta.dir, "test", "fixtures");
const cache = new Map<string, any[]>();

function fixture(name: string): any[] {
    if (!cache.has(name)) cache.set(name, parseJsonl(readFileSync(join(FIXTURES, `${name}.diagnostics.jsonl`), "utf8")));
    return cache.get(name)!;
}

/** `n` is the 1-based record number. Always returns a fresh copy so cases can edit it. */
function before(name: string, n: number): Observation {
    const rec = fixture(name)[n - 1];
    if (!rec) throw new Error(`fixture ${name} has no record ${n}`);
    return structuredClone(rec.before);
}

const A = "model-empty-pen-a";

// ---------------------------------------------------------------- helpers

/** Handle of the nearest listed npc with this name that is not busy. */
const npcHandle = (view: ModelView, name: string) => view.npcs.find((n) => n.name === name && !n.busy)?.h ?? "n1";
const itemHandle = (view: ModelView, re: RegExp) => view.items.find((i) => re.test(i.name))?.h ?? "g1";

const isAttackOnCow = (a: ResolvedAction) => a.type === "attack" && a.npc.name === "Cow";
const isPickupOf = (re: RegExp) => (a: ResolvedAction) => a.type === "pickup" && re.test(a.item.name);

const DONE = { type: "stop", outcome: "done" };
const BLOCKED = { type: "stop", outcome: "blocked" };

// ------------------------------------------------------------------- cases

export const CASES: EvalCase[] = [
    {
        id: "fresh_start",
        split: "dev",
        description: "Free cow nearby, nothing else going on: attack the Cow, not the Farmer.",
        build: () => ({ obs: before(A, 1), memory: [] }),
        accept: isAttackOnCow,
        examples: (v) => ({
            good: [{ type: "attack", target: npcHandle(v, "Cow") }],
            bad: [{ type: "attack", target: npcHandle(v, "Farmer") }, { type: "wait" }, DONE],
        }),
    },
    {
        id: "mid_fight_wait",
        split: "dev",
        description: "Already fighting the cow: wait for the fight to finish.",
        build: () => ({
            obs: before(A, 2),
            memory: ["step 1: attack Cow -> confirmed_success (combat_state_changed)"],
        }),
        accept: (a) => a.type === "wait",
        examples: () => ({ good: [{ type: "wait", ticks: 2 }], bad: [DONE, BLOCKED] }),
    },
    {
        id: "loot_after_kill_lingering_combat",
        split: "dev",
        description:
            "Cow is dead and the loot is on the ground, but the game still says inCombat (no target) for ~10 ticks. " +
            "Pick up the loot. Real failure: the model waited here (records 4 and 5) because the view said it was fighting.",
        build: () => ({
            obs: before(A, 4),
            memory: [
                "step 1: attack Cow -> confirmed_success (combat_state_changed)",
                "step 2: wait 1 -> confirmed_success (waited)",
                "step 3: wait 1 -> confirmed_success (waited)",
            ],
        }),
        accept: isPickupOf(/^(cow ?hide|bones)$/i),
        examples: (v) => ({
            good: [{ type: "pickup", target: itemHandle(v, /cowhide/i) }, { type: "pickup", target: itemHandle(v, /bones/i) }],
            bad: [{ type: "wait" }, { type: "pickup", target: itemHandle(v, /raw beef/i) }, DONE],
        }),
    },
    {
        id: "loot_visible_idle",
        split: "dev",
        description:
            "Not in combat at all and the loot is on the ground: pick it up. Real failure with NO flag problem: " +
            "the model waited twice here (records 6 and 7) before finally picking up.",
        build: () => ({
            obs: before(A, 6),
            memory: [
                "step 3: wait 1 -> confirmed_success (waited)",
                "step 4: wait 1 -> confirmed_success (waited)",
                "step 5: wait 1 -> confirmed_success (waited)",
            ],
        }),
        accept: isPickupOf(/^(cow ?hide|bones)$/i),
        examples: (v) => ({
            good: [{ type: "pickup", target: itemHandle(v, /bones/i) }, { type: "pickup", target: itemHandle(v, /cowhide/i) }],
            bad: [{ type: "wait" }, { type: "pickup", target: itemHandle(v, /raw beef/i) }, DONE],
        }),
    },
    {
        id: "bones_taken_hide_still_on_ground",
        split: "dev",
        description:
            "Bones are picked up, the Cowhide is still on the ground, and the inventory already shows a stray Cowhide. " +
            "Real failure: the model said done here (twice).",
        build: () => ({
            obs: before(A, 9),
            memory: ["step 8: pickup Bones -> confirmed_success (inventory_quantity_increased)"],
        }),
        accept: isPickupOf(/^cow ?hide$/i),
        examples: (v) => ({
            good: [{ type: "pickup", target: itemHandle(v, /cowhide/i) }],
            bad: [DONE, { type: "wait" }, { type: "pickup", target: itemHandle(v, /raw beef/i) }],
        }),
    },
    {
        id: "goal_complete",
        split: "dev",
        description: "Hide and bones were both picked up, nothing relevant left: say done.",
        build: () => ({
            obs: before(A, 11),
            memory: [
                "step 8: pickup Bones -> confirmed_success (inventory_quantity_increased)",
                "step 9: stop done -> rejected: goal not complete, still need a Cowhide in your inventory (kill a cow, then pick up its hide)",
                "step 10: pickup Cowhide -> confirmed_success (inventory_quantity_increased)",
            ],
        }),
        accept: (a) => a.type === "stop" && a.outcome === "done",
        examples: (v) => ({
            good: [DONE],
            bad: [{ type: "attack", target: npcHandle(v, "Cow") }, { type: "wait" }],
        }),
    },
    {
        id: "busy_cow_nearest",
        split: "dev",
        description:
            "The nearest cow is already fighting someone else. Attack the free cow. Real failure: attacking a busy " +
            "cow returns 'Someone else is fighting that.'",
        build: () => {
            const obs = before(A, 1);
            const nearest = obs.nearbyNpcs.filter((n) => n.name === "Cow").sort((a, b) => (a.distance ?? 99) - (b.distance ?? 99))[0];
            nearest.inCombat = true;
            return { obs, memory: [] };
        },
        accept: (a) => a.type === "attack" && a.npc.name === "Cow" && a.npc.index === 1794,
        examples: (v) => ({
            good: [{ type: "attack", target: npcHandle(v, "Cow") }],
            bad: [{ type: "attack", target: v.npcs.find((n) => n.busy)?.h ?? "n9" }, { type: "attack", target: npcHandle(v, "Farmer") }],
        }),
    },
    {
        id: "no_cow_nearby",
        split: "dev",
        description: "Only a Farmer is nearby. Do not attack it; wait or report blocked.",
        build: () => {
            const obs = before(A, 1);
            obs.nearbyNpcs = obs.nearbyNpcs.filter((n) => n.name === "Farmer");
            return { obs, memory: [] };
        },
        accept: (a) => a.type === "wait" || (a.type === "stop" && a.outcome === "blocked"),
        examples: (v) => ({
            good: [{ type: "wait", ticks: 3 }, BLOCKED],
            bad: [{ type: "attack", target: npcHandle(v, "Farmer") }, DONE],
        }),
    },
    {
        id: "retry_after_target_lost",
        split: "dev",
        description: "The last attack timed out because the cow wandered off. Look at the state and attack a cow again.",
        build: () => ({
            obs: before(A, 1),
            memory: ["step 1: attack Cow -> partial_progress_or_timeout (sdk_timeout): Failed to interact with NPC: target_not_found"],
            note: UNCERTAIN_NOTE,
        }),
        accept: isAttackOnCow,
        examples: (v) => ({
            good: [{ type: "attack", target: npcHandle(v, "Cow") }],
            bad: [DONE, { type: "attack", target: npcHandle(v, "Farmer") }],
        }),
    },
];
