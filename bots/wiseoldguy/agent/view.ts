// Compact, model-facing view of an Observation, plus prompt rendering.
// Handles (n1, g1, dialog choice numbers) are only valid for the observation
// they were built from; they are re-assigned every turn.

import {
    ACTION_TYPES, CONTRACT_VERSION, LIMITS,
    type ActionOutcome, type ActionType, type Blocking, type HandleMap, type ModelView, type ObsGroundItem, type ObsNpc,
    type Observation,
} from "./contract";
import { isContinueOnly, isFighting } from "./observe";

const BIG = Number.MAX_SAFE_INTEGER;
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

// Reachable first (unknown counts as reachable), then nearest, then stable by key.
function byProximity<T extends { reachable: boolean | null; distance: number | null }>(a: T, b: T) {
    const ra = a.reachable === false ? 1 : 0;
    const rb = b.reachable === false ? 1 : 0;
    if (ra !== rb) return ra - rb;
    return (a.distance ?? BIG) - (b.distance ?? BIG);
}

/**
 * What the model is shown. A hidden entry stays in the observation, the logs and the checks; it only
 * leaves the prompt and the handle list. Hiding never changes what the validator or the goal check see.
 */
export interface ViewFilter {
    npc?: (npc: ObsNpc) => boolean;
    item?: (item: ObsGroundItem) => boolean;
}

/**
 * Always on. An NPC with no options cannot be used, and an entry the player cannot reach right now is
 * rejected by validation anyway ("unreachable"), so offering it only wastes a choice (a real run attacked
 * an unreachable Duck because Ducks took the handle slots in front of the Cows).
 */
export const GLOBAL_VIEW_FILTER: Required<ViewFilter> = {
    npc: (npc) => (npc.options?.length ?? 0) > 0 && npc.reachable !== false,
    item: (item) => item.reachable !== false,
};

export interface ViewOptions {
    /** Default true. false shows everything the observation has (useful for an A/B comparison). */
    global?: boolean;
    /** Task-specific filter, ANDed with the global one. */
    task?: ViewFilter;
}

export function toModelView(
    obs: Observation, limits = LIMITS, opts: ViewOptions = {},
): { view: ModelView; handles: HandleMap } {
    const handles: HandleMap = { npcs: {}, items: {}, dialogOptions: {} };

    // An NPC fighting something other than us cannot be attacked ("Someone else is fighting that.").
    const playerTarget = obs.player.combat?.inCombat && obs.player.combat.targetType === "npc" ? obs.player.combat.targetIndex : null;
    const isBusy = (n: { index: number; inCombat: boolean | null }) => n.inCombat === true && n.index !== playerTarget;

    // Always visible: what the player is fighting, and anything already in combat (a monster hitting us
    // must not be hidden by a task filter that only wants cows).
    const useGlobal = opts.global !== false;
    const keepNpc = (npc: ObsNpc) =>
        npc.index === playerTarget || npc.inCombat === true ||
        ((!useGlobal || GLOBAL_VIEW_FILTER.npc(npc)) && (opts.task?.npc?.(npc) ?? true));
    const keepItem = (item: ObsGroundItem) =>
        (!useGlobal || GLOBAL_VIEW_FILTER.item(item)) && (opts.task?.item?.(item) ?? true);
    const visibleNpcs = obs.nearbyNpcs.filter(keepNpc);
    const visibleItems = obs.nearbyGroundItems.filter(keepItem);
    const hiddenNpcs = obs.nearbyNpcs.length - visibleNpcs.length;
    const hiddenItems = obs.nearbyGroundItems.length - visibleItems.length;

    // Unreachable last, then busy, then nearest.
    const rank = (n: { reachable: boolean | null; index: number; inCombat: boolean | null }) =>
        (n.reachable === false ? 2 : 0) + (isBusy(n) ? 1 : 0);
    const sortedNpcs = [...visibleNpcs].sort(
        (a, b) => rank(a) - rank(b) || (a.distance ?? BIG) - (b.distance ?? BIG) || a.index - b.index,
    );
    const shownNpcs = sortedNpcs.slice(0, limits.maxNpcs);
    const npcs = shownNpcs.map((npc, i) => {
        const h = `n${i + 1}`;
        handles.npcs[h] = {
            index: npc.index, id: npc.id, name: npc.name, x: npc.x, z: npc.z,
            options: npc.options, reachable: npc.reachable,
        };
        return { h, name: npc.name, dist: npc.distance, options: npc.options, reachable: npc.reachable, busy: isBusy(npc) };
    });

    const sortedItems = [...visibleItems].sort((a, b) => byProximity(a, b) || a.id - b.id);
    const shownItems = sortedItems.slice(0, limits.maxItems);
    const items = shownItems.map((item, i) => {
        const h = `g${i + 1}`;
        handles.items[h] = { id: item.id, name: item.name, x: item.x, z: item.z, reachable: item.reachable };
        return { h, name: item.name, qty: item.quantity, dist: item.distance, reachable: item.reachable };
    });

    // Merge inventory by item ID.
    const merged = new Map<number, { id: number; name: string; qty: number }>();
    for (const item of obs.inventory) {
        const entry = merged.get(item.id);
        if (entry) entry.qty += item.quantity;
        else merged.set(item.id, { id: item.id, name: item.name, qty: item.quantity });
    }

    const dialogOptionsAll = obs.dialog.isOpen ? obs.dialog.options : [];
    const shownOptions = dialogOptionsAll.slice(0, limits.maxDialogOptions);
    const dialogOptions = shownOptions.map((opt, i) => {
        handles.dialogOptions[i + 1] = opt.text;
        return { n: i + 1, text: clip(opt.text, limits.maxOptionChars) };
    });
    const continueOnly = obs.dialog.isOpen && isContinueOnly(obs.dialog);

    const blocking: Blocking = obs.shopOpen ? "shop" : obs.bankOpen ? "bank" : obs.interfaceOpen ? "interface" : "none";

    const combat = obs.player.combat;
    let combatState: ModelView["player"]["combat"] = "idle";
    let combatTarget: string | undefined;
    // After a kill the game keeps inCombat=true with targetType "none"/targetIndex -1 for ~10
    // ticks (real log). That is not a fight: treating it as one made the model wait with loot on the ground.
    if (combat && isFighting(obs)) {
        combatState = combat.targetType === "player" ? "player" : "npc";
        if (combat.targetType === "npc") {
            combatTarget = obs.nearbyNpcs.find((n) => n.index === combat.targetIndex)?.name;
        }
    }

    const view: ModelView = {
        v: CONTRACT_VERSION,
        tick: obs.tick,
        inGame: obs.inGame,
        player: {
            x: obs.player.x, z: obs.player.z, level: obs.player.level,
            hp: obs.player.hp, maxHp: obs.player.maxHp, dead: obs.player.isDead,
            combat: combatState, ...(combatTarget ? { combatTarget } : {}),
        },
        blocking,
        inventory: [...merged.values()],
        inventoryUsed: obs.inventory.length,
        npcs,
        items,
        dialog: {
            open: obs.dialog.isOpen,
            text: clip(obs.dialog.text, limits.maxDialogChars),
            continueOnly,
            options: continueOnly ? [] : dialogOptions,
        },
        omitted: {
            npcs: sortedNpcs.length - shownNpcs.length,
            items: sortedItems.length - shownItems.length,
            dialogOptions: continueOnly ? 0 : dialogOptionsAll.length - shownOptions.length,
        },
        ...(hiddenNpcs || hiddenItems ? { hidden: { npcs: hiddenNpcs, items: hiddenItems } } : {}),
    };
    return { view, handles };
}

// ------------------------------------------------------------------ prompts

/** Plain text rendering of the view: fewer tokens than JSON, easier for small models. */
export function renderState(view: ModelView, limits = LIMITS): string {
    const p = view.player;
    const lines: string[] = [];
    const fighting = p.combat === "idle" ? "idle" : `fighting ${p.combatTarget ?? p.combat}`;
    lines.push(`tick ${view.tick} | pos ${p.x},${p.z} plane ${p.level} | hp ${p.hp}/${p.maxHp} | ${fighting}`);
    if (!view.inGame) lines.push("NOT IN GAME");
    if (p.dead) lines.push("PLAYER IS DEAD");
    lines.push(`blocking ui: ${view.blocking}`);

    const inv = view.inventory.slice(0, limits.maxInventoryLines).map((i) => (i.qty > 1 ? `${i.name} x${i.qty}` : i.name));
    const more = view.inventory.length - inv.length;
    lines.push(`inventory ${view.inventoryUsed}/${limits.inventorySlots}: ${inv.length ? inv.join(", ") : "empty"}${more > 0 ? `, +${more} more` : ""}`);

    lines.push("npcs:" + (view.npcs.length ? "" : " none"));
    for (const n of view.npcs) {
        const flag = n.reachable === false ? " (unreachable)" : n.busy ? " (in combat)" : "";
        lines.push(`  ${n.h} ${n.name} dist ${n.dist ?? "?"} [${n.options.join(", ")}]${flag}`);
    }
    if (view.omitted.npcs) lines.push(`  (+${view.omitted.npcs} farther npcs not shown)`);

    lines.push("ground items:" + (view.items.length ? "" : " none"));
    for (const g of view.items) {
        const flag = g.reachable === false ? " (unreachable)" : "";
        lines.push(`  ${g.h} ${g.name}${g.qty > 1 ? ` x${g.qty}` : ""} dist ${g.dist ?? "?"}${flag}`);
    }
    if (view.omitted.items) lines.push(`  (+${view.omitted.items} farther items not shown)`);

    if (!view.dialog.open) {
        lines.push("dialog: closed");
    } else {
        lines.push("dialog: open");
        if (view.dialog.text) lines.push(`  text: ${view.dialog.text}`);
        if (view.dialog.continueOnly) lines.push("  (no choices: use dialog_continue)");
        for (const o of view.dialog.options) lines.push(`  ${o.n}. ${o.text}`);
        if (view.omitted.dialogOptions) lines.push(`  (+${view.omitted.dialogOptions} more options not shown)`);
    }
    return lines.join("\n");
}

const ACTION_HELP: Record<ActionType, string> = {
    walk_to: '{"type":"walk_to","x":<number>,"z":<number>}',
    interact_npc: '{"type":"interact_npc","target":"n1","option":"Talk-to"}',
    attack: '{"type":"attack","target":"n1"}',
    pickpocket: '{"type":"pickpocket","target":"n1"}',
    pickup: '{"type":"pickup","target":"g1"}',
    eat: '{"type":"eat"}  (eat food to heal)',
    chop_tree: '{"type":"chop_tree"}  (chop the tree the goal names; the logs go to your pack)',
    open_bank: '{"type":"open_bank"}  (open the bank; it must be in reach)',
    withdraw_logs: '{"type":"withdraw_logs"}  (take the logs the goal names out of the open bank)',
    deposit_items: '{"type":"deposit_items"}  (deposit everything the goal says to bank, into the open bank)',
    close_bank: '{"type":"close_bank"}  (close the bank)',
    fletch: '{"type":"fletch"}  (use your knife on the logs in your pack to make the bow the goal names; one call makes up to 10)',
    mine_rock: '{"type":"mine_rock"}  (mine the ore the goal needs most from a rock in view; walk to the mine first; the rock is chosen for you)',
    smelt: '{"type":"smelt"}  (smelt all the ore in your pack at the furnace in view, using the Make-X option; one call does the whole pile, up to 28)',
    dialog_continue: '{"type":"dialog_continue"}',
    dialog_select: '{"type":"dialog_select","choice":<number>}',
    wait: '{"type":"wait","ticks":<1 to 3>}',
    stop: '{"type":"stop","outcome":"done"}  (goal complete)  or  "blocked"  (cannot progress)',
};

/**
 * Static per run (goal and action set included) so the model server's KV cache
 * stays warm. Only the allowed actions are described: a small model cannot
 * choose an action it was never shown.
 */
export function buildSystemPrompt(goal: string, allowed?: readonly ActionType[]): string {
    const types = ACTION_TYPES.filter((t) => t === "stop" || !allowed || allowed.includes(t));
    const has = (...ts: ActionType[]) => ts.some((t) => types.includes(t));

    const rules: string[] = [];
    if (has("attack", "interact_npc", "pickpocket", "pickup")) {
        rules.push("- target is a handle (n1, g1) from the CURRENT state. Handles change every turn.");
    }
    if (has("interact_npc")) rules.push("- option must be one of that npc's listed options.");
    if (has("dialog_continue", "dialog_select")) {
        rules.push("- dialog_continue only when the dialog says there are no choices; otherwise dialog_select a numbered choice.");
    }
    if (has("attack")) {
        rules.push("- Do not attack an npc marked (in combat): someone else is fighting it.");
        if (has("wait")) rules.push("- While fighting (combat is not idle), use wait to let the fight finish. Defeated monsters drop items on the ground.");
    }
    rules.push(
        "- After an action, trust the result line and the new state. Do not repeat an action that already succeeded.",
        "- If a result failed or is unconfirmed, look at the state before repeating it.",
        "- Only choose stop with done when the goal is really complete. The game checks, and rejects a false done.",
    );

    return [
        "You control a character in a game. Each turn you see the current state and choose exactly ONE action.",
        `GOAL: ${goal}`,
        "",
        "Reply with ONE JSON object and nothing else. Allowed actions:",
        ...types.map((t) => ACTION_HELP[t]),
        "",
        "Rules:",
        ...rules,
    ].join("\n");
}

export function renderTurn(view: ModelView, memory: string[], note?: string, previousError?: string): string {
    const parts: string[] = [];
    if (memory.length) parts.push("RECENT:\n" + memory.map((m) => `  ${m}`).join("\n"));
    if (note) parts.push(`NOTE: ${note}`);
    if (previousError) parts.push(`YOUR LAST REPLY WAS REJECTED: ${previousError}\nReply again with one valid JSON action.`);
    parts.push("STATE:\n" + renderState(view));
    return parts.join("\n\n");
}

// ------------------------------------------------------------ memory lines

/** Describe an action by NAMES (handles change between turns, names don't). */
export function describeAction(raw: any, handles: HandleMap): string {
    if (!raw || typeof raw !== "object") return "invalid output";
    const t = raw.type;
    const npc = typeof raw.target === "string" ? handles.npcs[raw.target] : undefined;
    const item = typeof raw.target === "string" ? handles.items[raw.target] : undefined;
    switch (t) {
        case "walk_to": return `walk_to ${raw.x},${raw.z}`;
        case "interact_npc": return `${raw.option} ${npc?.name ?? raw.target}`;
        case "attack": return `attack ${npc?.name ?? raw.target}`;
        case "pickpocket": return `pickpocket ${npc?.name ?? raw.target}`;
        case "pickup": return `pickup ${item?.name ?? raw.target}`;
        case "dialog_select": return `dialog_select "${handles.dialogOptions[raw.choice] ?? raw.choice}"`;
        case "wait": return `wait ${raw.ticks ?? 1}`;
        case "eat": return "eat";
        case "chop_tree": return "chop tree";
        case "open_bank": return "open bank";
        case "withdraw_logs": return "withdraw logs";
        case "deposit_items": return "deposit items";
        case "close_bank": return "close bank";
        case "fletch": return "fletch logs";
        case "mine_rock": return "mine a rock";
        case "smelt": return "smelt ore at the furnace";
        default: return String(t ?? "unknown");
    }
}

export function summarizeOutcome(step: number, description: string, outcome: Pick<ActionOutcome, "status" | "reason" | "message">): string {
    // Show the reason text for anything that did not clearly succeed (e.g. "target_not_found").
    const extra = outcome.status !== "confirmed_success" && outcome.message ? `: ${clip(outcome.message, 100)}` : "";
    return `step ${step}: ${description} -> ${outcome.status} (${outcome.reason})${extra}`;
}
