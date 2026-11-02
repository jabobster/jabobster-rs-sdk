// Parse and validate model output BEFORE anything reaches the SDK.
// Two stages: schema (shape of the JSON) and state (does it make sense now).

import {
    ACTION_SPEC, ACTION_TYPES, LIMITS,
    type ActionType, type HandleMap, type ModelAction, type ModelView, type NpcRef, type RejectCode,
    type Observation, type Validation,
} from "./contract";
import { isContinuePrompt } from "./observe";
import { batchFor } from "./fletchBank";
import { DEFAULT_RESOURCES, bowName, exactItem, menuLabel, type TaskResources } from "./resources";
import { DepletedRocks, countItems, oresShort, shortBeyondSlack, smeltableOre, smeltCount, bankReady } from "./smeltRules";

// ------------------------------------------------------------------ parsing

export type ParseResult = { ok: true; value: unknown } | { ok: false; code: "not_json"; message: string };

/** First balanced {...} in the text, string-aware. */
function extractJsonObject(text: string): string | null {
    const start = text.indexOf("{");
    if (start < 0) return null;
    let depth = 0, inString = false, escaped = false;
    for (let i = start; i < text.length; i++) {
        const c = text[i];
        if (inString) {
            if (escaped) escaped = false;
            else if (c === "\\") escaped = true;
            else if (c === '"') inString = false;
            continue;
        }
        if (c === '"') inString = true;
        else if (c === "{") depth++;
        else if (c === "}" && --depth === 0) return text.slice(start, i + 1);
    }
    return null;
}

/** Accepts an object, or text that may contain <think> blocks and code fences. */
export function parseModelOutput(raw: unknown): ParseResult {
    if (raw && typeof raw === "object") return { ok: true, value: raw };
    if (typeof raw !== "string") return { ok: false, code: "not_json", message: "Reply was empty." };
    const text = raw
        .replace(/<think>[\s\S]*?<\/think>/gi, "")
        .replace(/```(?:json)?/gi, "")
        .trim();
    const candidate = extractJsonObject(text);
    if (!candidate) return { ok: false, code: "not_json", message: "Reply contained no JSON object." };
    try {
        return { ok: true, value: JSON.parse(candidate) };
    } catch (e: any) {
        return { ok: false, code: "not_json", message: `Invalid JSON: ${e?.message ?? e}` };
    }
}

// ------------------------------------------------------------------ schema

type Rejection = { ok: false; code: RejectCode; message: string; stage: "schema" | "state" };
const reject = (code: RejectCode, message: string, stage: "schema" | "state"): Rejection => ({ ok: false, code, message, stage });

const NPC_HANDLE = /^n\d{1,2}$/;
const ITEM_HANDLE = /^g\d{1,2}$/;

export function validateSchema(raw: unknown): { ok: true; action: ModelAction } | Rejection {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        return reject("not_object", "Reply must be a single JSON object.", "schema");
    }
    const obj = raw as Record<string, unknown>;
    const type = obj.type;
    if (typeof type !== "string" || !(type in ACTION_SPEC)) {
        return reject("unknown_type", `Unknown action type. Use one of: ${ACTION_TYPES.join(", ")}.`, "schema");
    }
    const spec = ACTION_SPEC[type as ActionType];
    const allowed = new Set<string>(["type", "why", ...spec.required, ...spec.optional]);
    for (const key of Object.keys(obj)) {
        if (!allowed.has(key)) return reject("extra_field", `"${key}" is not a field of ${type}.`, "schema");
    }
    for (const key of spec.required) {
        if (obj[key] === undefined || obj[key] === null) return reject("missing_field", `${type} requires "${key}".`, "schema");
    }

    const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);
    const inRange = (key: string, v: unknown, min: number, max: number) =>
        !isInt(v) ? reject("bad_field_type", `"${key}" must be an integer.`, "schema")
        : v < min || v > max ? reject("out_of_range", `"${key}" must be between ${min} and ${max}.`, "schema")
        : null;

    for (const key of ["x", "z"] as const) {
        if (obj[key] !== undefined) {
            const bad = inRange(key, obj[key], 0, LIMITS.maxCoord);
            if (bad) return bad;
        }
    }
    if (obj.tolerance !== undefined) {
        const bad = inRange("tolerance", obj.tolerance, 0, LIMITS.maxTolerance);
        if (bad) return bad;
    }
    if (obj.ticks !== undefined) {
        const bad = inRange("ticks", obj.ticks, 1, LIMITS.maxWaitTicks);
        if (bad) return bad;
    }
    if (obj.choice !== undefined) {
        const bad = inRange("choice", obj.choice, 1, 99);
        if (bad) return bad;
    }
    if (obj.target !== undefined) {
        const re = type === "pickup" ? ITEM_HANDLE : NPC_HANDLE;
        if (typeof obj.target !== "string" || !re.test(obj.target)) {
            return reject("bad_field_type", `"target" must be a handle like ${type === "pickup" ? "g1" : "n1"} from the current state.`, "schema");
        }
    }
    if (obj.option !== undefined && (typeof obj.option !== "string" || !obj.option.trim() || obj.option.length > 40)) {
        return reject("bad_field_type", '"option" must be a short non-empty string.', "schema");
    }
    if (obj.outcome !== undefined && obj.outcome !== "done" && obj.outcome !== "blocked") {
        return reject("bad_field_type", '"outcome" must be "done" or "blocked".', "schema");
    }

    const model = { ...obj } as Record<string, unknown>;
    if (typeof model.why === "string") model.why = model.why.slice(0, LIMITS.maxWhyChars);
    else delete model.why;
    return { ok: true, action: model as unknown as ModelAction };
}

// ------------------------------------------------------------------- state

/** Identity of an action for repeat checks: its JSON without the debug `why` note. */
export function actionKey(raw: unknown): string {
    if (!raw || typeof raw !== "object") return String(raw);
    const { why: _why, ...rest } = raw as Record<string, unknown>;
    return JSON.stringify(rest);
}

export interface ValidateOpts {
    /** Injected so validation stays pure; return false only on a definite "no path". */
    pathExists?: (x: number, z: number) => boolean;
    /** Actions the goal permits (undefined = all). `stop` is always permitted. */
    allowed?: readonly ActionType[];
    /** An action that keeps failing with nothing changed; the same action is rejected until the state changes. */
    blocked?: { key: string; message: string };
    /** Which tree, logs and bow the task works with. Default: oak, 10 logs, no bow. */
    resources?: TaskResources;
}

const listHandles = (map: Record<string, unknown>) => {
    const keys = Object.keys(map);
    return keys.length ? keys.join(", ") : "none";
};

/**
 * @param view/handles what the model was shown when it chose the action
 * @param fresh        observation taken right before dispatch; the target must
 *                     still exist in it, so a stale handle is caught here
 */
export function validateAction(
    raw: unknown,
    ctx: { view: ModelView; handles: HandleMap },
    fresh: Observation,
    opts: ValidateOpts = {},
): Validation {
    const schema = validateSchema(raw);
    if (!schema.ok) return schema;
    const a = schema.action;
    const model = a;

    if (opts.allowed && a.type !== "stop" && !opts.allowed.includes(a.type)) {
        const names = Array.from(new Set([...opts.allowed, "stop"])).join(", ");
        return reject("action_not_allowed", `"${a.type}" is not available for this goal. Use one of: ${names}.`, "schema");
    }

    if (a.type === "stop") return { ok: true, action: { type: "stop", outcome: a.outcome }, model };
    if (opts.blocked && actionKey(a) === opts.blocked.key) return reject("repeat_blocked", opts.blocked.message, "state");

    if (!fresh.inGame) return reject("not_in_game", "You are not in the game.", "state");
    if (fresh.player.isDead) return reject("player_dead", "The player is dead.", "state");
    if (a.type === "wait") {
        return { ok: true, action: { type: "wait", ticks: a.ticks ?? 1 }, model };
    }
    // Bank steps are valid while the bank is open (they are the point of it); everything else is blocked.
    const bankStep = a.type === "deposit_items" || a.type === "withdraw_logs" || a.type === "close_bank" || a.type === "open_bank";
    if ((fresh.shopOpen || fresh.bankOpen) && !bankStep) {
        if (fresh.bankOpen && !fresh.shopOpen && a.type === "fletch") {
            return reject("modal_open", "The bank is open. Close it (close_bank) before you fletch.", "state");
        }
        const which = fresh.shopOpen ? "shop" : "bank";
        return reject("modal_open", `A ${which} window is open and blocks actions. Wait or stop.`, "state");
    }

    switch (a.type) {
        case "walk_to": {
            const tolerance = a.tolerance ?? LIMITS.defaultTolerance;
            const dist = Math.max(Math.abs(a.x - fresh.player.x), Math.abs(a.z - fresh.player.z));
            // Walking to where you already stand is a no-op: refuse it, so the model must choose something else.
            if (dist <= tolerance) {
                const next = opts.allowed?.filter((t) => t !== "walk_to" && t !== "stop" && t !== "wait");
                const hint = next?.length ? ` Do not walk there again. Choose another action: ${next.join(", ")}.` : " Choose the next step.";
                return reject("already_there", `You are already at ${a.x},${a.z} (within ${tolerance} tiles).${hint}`, "state");
            }
            // Smelt-and-bank tasks: the furnace is for a full batch, the bank is for the bars the goal still needs.
            // Refusing these walks stops the trip-and-turn-back loop (the model walks, gets refused, walks back).
            const smeltTask = opts.resources?.smelt;
            if (smeltTask) {
                const near = (t: { x: number; z: number }) => Math.max(Math.abs(a.x - t.x), Math.abs(a.z - t.z)) <= 3;
                if (near(smeltTask.site.furnace)) {
                    const short = oresShort(smeltTask.site, fresh.inventory, smeltTask.bars);
                    if (shortBeyondSlack(short) && fresh.inventory.length < LIMITS.inventorySlots) {
                        const need = short.map((s) => `${s.target - s.have} more ${s.name.toLowerCase()}`).join(" and ");
                        return reject("ore_not_gathered", `Not yet: you still need ${need}. Mine more with mine_rock first, then walk to the furnace.`, "state");
                    }
                }
                if (near(smeltTask.site.bank)) {
                    const need = Math.max(0, smeltTask.bars - (smeltTask.banked ?? 0));
                    const held = countItems(fresh.inventory, smeltTask.site.barRe);
                    if (!bankReady(fresh.inventory, smeltTask.site.barRe, need, LIMITS.inventorySlots)) {
                        return reject("bars_short_before_bank", `You carry ${held} ${smeltTask.site.barName.toLowerCase()}s and the goal still needs ${need} banked. Smelt and mine first, then walk to the bank.`, "state");
                    }
                }
            }
            // A longer walk is clamped to the point maxWalkDistance tiles along the line. The next walk_to continues it.
            let x = a.x;
            let z = a.z;
            if (dist > LIMITS.maxWalkDistance) {
                const f = LIMITS.maxWalkDistance / dist;
                x = fresh.player.x + Math.round((a.x - fresh.player.x) * f);
                z = fresh.player.z + Math.round((a.z - fresh.player.z) * f);
            }
            if (opts.pathExists && !opts.pathExists(x, z)) {
                return reject("no_path", `No walkable path to ${x},${z}.`, "state");
            }
            return { ok: true, action: { type: "walk_to", x, z, tolerance }, model };
        }

        case "interact_npc":
        case "attack":
        case "pickpocket": {
            const npc = ctx.handles.npcs[a.target];
            if (!npc) return reject("unknown_handle", `No ${a.target} in the current state. Valid npcs: ${listHandles(ctx.handles.npcs)}.`, "state");
            const now = fresh.nearbyNpcs.find((n) => n.index === npc.index && n.name === npc.name);
            if (!now) return reject("target_gone", `${npc.name} (${a.target}) is no longer nearby.`, "state");
            if (now.reachable === false) return reject("unreachable", `${npc.name} cannot be reached.`, "state");

            const wanted = a.type === "interact_npc" ? a.option : a.type === "attack" ? "Attack" : "Pickpocket";
            const offered = now.options.find((o) => o.toLowerCase() === wanted.toLowerCase());
            if (!offered) {
                return reject("option_not_offered", `${npc.name} does not offer "${wanted}". It offers: ${now.options.join(", ") || "nothing"}.`, "state");
            }
            const ref: NpcRef = { index: now.index, id: now.id, name: now.name, x: now.x, z: now.z };

            if (a.type === "attack") {
                const c = fresh.player.combat;
                if (c?.inCombat && c.targetType === "npc" && c.targetIndex === now.index) {
                    return reject("already_attacking", `You are already fighting ${now.name}.`, "state");
                }
                return { ok: true, action: { type: "attack", npc: ref }, model };
            }
            if (a.type === "pickpocket") return { ok: true, action: { type: "pickpocket", npc: ref }, model };
            return { ok: true, action: { type: "interact_npc", npc: ref, option: offered }, model };
        }

        case "pickup": {
            const item = ctx.handles.items[a.target];
            if (!item) return reject("unknown_handle", `No ${a.target} in the current state. Valid items: ${listHandles(ctx.handles.items)}.`, "state");
            const now = fresh.nearbyGroundItems.find((i) => i.id === item.id && i.x === item.x && i.z === item.z);
            if (!now) return reject("target_gone", `${item.name} (${a.target}) is no longer on the ground.`, "state");
            if (now.reachable === false) return reject("unreachable", `${item.name} cannot be reached.`, "state");
            const slotsUsed = fresh.inventory.length;
            const hasStack = fresh.inventory.some((i) => i.id === item.id);
            // A held stack can absorb a stackable item; a full pack cannot take a new one.
            if (slotsUsed >= LIMITS.inventorySlots && !hasStack) {
                return reject("inventory_full", "The inventory is full.", "state");
            }
            return { ok: true, action: { type: "pickup", item: { id: now.id, name: now.name, x: now.x, z: now.z } }, model };
        }

        case "eat": {
            const food = fresh.inventory.find((i) => i.edible === true);
            if (!food) return reject("no_food", "You have no food to eat.", "state");
            return { ok: true, action: { type: "eat", food: { slot: food.slot, id: food.id, name: food.name } }, model };
        }

        case "chop_tree": {
            if (fresh.inventory.length >= LIMITS.inventorySlots) return reject("inventory_full", "The inventory is full.", "state");
            const res = (opts.resources ?? DEFAULT_RESOURCES).resource;
            return { ok: true, action: { type: "chop_tree", tree: res.tree, logs: res.logs }, model };
        }

        case "open_bank": {
            if (fresh.bankOpen) return reject("bank_already_open", "The bank is already open.", "state");
            if (fresh.shopOpen) return reject("modal_open", "A shop window is open and blocks actions. Wait or stop.", "state");
            if (fresh.interfaceOpen) return reject("modal_open", "Another window is open and blocks actions. Wait or stop.", "state");
            // Smelt-and-bank tasks: go to the bank once the pack holds the bars the goal still needs. Extra ore in the pack is fine.
            const smelt = opts.resources?.smelt;
            if (smelt) {
                const need = Math.max(0, smelt.bars - (smelt.banked ?? 0));
                const held = countItems(fresh.inventory, smelt.site.barRe);
                if (!bankReady(fresh.inventory, smelt.site.barRe, need, LIMITS.inventorySlots)) {
                    return reject("bars_short_before_bank", `You carry ${held} ${smelt.site.barName.toLowerCase()}s and the goal still needs ${need} banked. Smelt and mine until you carry ${need}, then walk to the bank.`, "state");
                }
            }
            return { ok: true, action: { type: "open_bank" }, model };
        }

        case "withdraw_logs": {
            if (!fresh.bankOpen) return reject("bank_not_open", "Open the bank first.", "state");
            const task = opts.resources ?? DEFAULT_RESOURCES;
            const logs = task.resource.logs;
            const carried = fresh.inventory.filter((i) => exactItem(logs).test(i.name)).reduce((t, i) => t + i.quantity, 0);
            if (carried > 0) {
                return reject("logs_already_carried", `You already carry ${carried} ${logs}. Fletch them before you take more from the bank.`, "state");
            }
            const inBank = (fresh.bankItems ?? []).filter((i) => exactItem(logs).test(i.name)).reduce((t, i) => t + i.quantity, 0);
            if (inBank <= 0) return reject("logs_not_in_bank", `There are no ${logs} in the bank.`, "state");
            if (fresh.inventory.length >= LIMITS.inventorySlots) return reject("inventory_full", "The inventory is full.", "state");
            const count = Math.min(task.logCount, inBank);
            return { ok: true, action: { type: "withdraw_logs", item: logs, count }, model };
        }

        case "deposit_items": {
            if (!fresh.bankOpen) return reject("bank_not_open", "Open the bank first.", "state");
            const task = opts.resources ?? DEFAULT_RESOURCES;
            // Mine-smelt banks the bars; fletch banks the bows; chop banks the logs.
            const item = task.smelt ? task.smelt.site.barName : task.bow ? bowName(task.resource, task.bow) : task.resource.logs;
            if (!fresh.inventory.some((i) => exactItem(item).test(i.name))) {
                const hint = task.bow ? " Fletch the logs first; the bows come from the knife." : task.smelt ? " Smelt the ore first." : "";
                return reject("nothing_to_deposit", `You have no ${item} in your pack to deposit.${hint}`, "state");
            }
            return { ok: true, action: { type: "deposit_items", item }, model };
        }

        case "fletch": {
            const task = opts.resources ?? DEFAULT_RESOURCES;
            if (!task.bow) return reject("no_bow_set", "This task does not say which bow to make.", "state");
            if (!fresh.inventory.some((i) => /knife/i.test(i.name))) return reject("no_knife", "You have no knife to fletch with.", "state");
            const logs = task.resource.logs;
            const held = fresh.inventory.filter((i) => exactItem(logs).test(i.name)).reduce((t, i) => t + i.quantity, 0);
            if (held <= 0) return reject("no_logs", `You have no ${logs} to fletch.`, "state");
            return {
                ok: true,
                action: { type: "fletch", logs, product: bowName(task.resource, task.bow), menuLabel: menuLabel(task.resource, task.bow), batch: batchFor(held) },
                model,
            };
        }

        case "close_bank": {
            if (!fresh.bankOpen) return reject("bank_not_open", "The bank is not open.", "state");
            return { ok: true, action: { type: "close_bank" }, model };
        }

        case "mine_rock": {
            const smelt = opts.resources?.smelt;
            if (!smelt) return reject("action_not_allowed", "This task does not mine.", "state");
            const site = smelt.site;
            if (fresh.inventory.length >= LIMITS.inventorySlots) return reject("inventory_full", "The inventory is full.", "state");
            const short = oresShort(site, fresh.inventory, smelt.bars);
            if (short.length === 0) return reject("nothing_to_mine", "Every ore is at target. Smelt them now.", "state");
            // The ore furthest behind goes first. A rock must be one of this site's tiles for that ore.
            const spec = site.ores
                .filter((s) => short.some((x) => x.name === s.name))
                .sort((a, b) => countItems(fresh.inventory, a.re) - countItems(fresh.inventory, b.re))[0];
            const inSite = (fresh.locs?.rocks ?? []).filter((r) => spec.rocks.some((t) => t.x === r.x && t.z === r.z));
            if (inSite.length === 0) {
                // Name the nearest tile of this ore, so the next step is a walk to a real coordinate.
                const near = spec.rocks.reduce((a, c) => (Math.max(Math.abs(c.x - fresh.player.x), Math.abs(c.z - fresh.player.z)) <
                    Math.max(Math.abs(a.x - fresh.player.x), Math.abs(a.z - fresh.player.z)) ? c : a));
                return reject("no_rock_in_view", `No ${spec.name} rock is in view. The nearest is at x ${near.x} z ${near.z}: walk_to there first.`, "state");
            }
            // Skip rocks that just gave no ore; with no memory given, every rock is fresh.
            const memory = smelt.depleted ?? new DepletedRocks();
            if (!inSite.some((r) => memory.available(r.x, r.z, fresh.tick))) {
                // Everything in view is empty for now: send the model to the nearest rock of this ore that is not.
                const elsewhere = spec.rocks.filter((t) => memory.available(t.x, t.z, fresh.tick));
                if (elsewhere.length) {
                    const d = (t: { x: number; z: number }) => Math.max(Math.abs(t.x - fresh.player.x), Math.abs(t.z - fresh.player.z));
                    const t = elsewhere.reduce((a, c) => (d(c) < d(a) ? c : a));
                    return reject("no_rock_in_view", `The ${spec.name.toLowerCase()} rocks in view are empty for now. The nearest rock that is not is at x ${t.x} z ${t.z}: walk_to there first.`, "state");
                }
            }
            const rock = memory.pick(inSite, fresh.tick);
            return { ok: true, action: { type: "mine_rock", ore: spec.name, x: rock.x, z: rock.z }, model };
        }

        case "smelt": {
            const smelt = opts.resources?.smelt;
            if (!smelt) return reject("action_not_allowed", "This task does not smelt.", "state");
            const site = smelt.site;
            const furnace = (fresh.locs?.furnaces ?? []).find((f) => f.x === site.furnace.x && f.z === site.furnace.z);
            if (!furnace) {
                return reject("no_furnace_in_view", `The furnace is not in view. It is at x ${site.furnace.x} z ${site.furnace.z}: walk_to there first.`, "state");
            }
            // Make-X takes the whole pile the pack allows (up to 28) in one call.
            const count = smeltCount(smeltableOre(site, fresh.inventory));
            if (count <= 0) {
                return reject("no_ore_to_smelt", `You have no ${site.ores.map((o) => o.name).join(" and ")} to smelt.`, "state");
            }
            // One furnace trip should smelt the whole batch. Refuse a smelt while the target is still short and the
            // pack has room to mine more; the message says what to mine.
            const short = oresShort(site, fresh.inventory, smelt.bars);
            if (shortBeyondSlack(short) && fresh.inventory.length < LIMITS.inventorySlots) {
                const need = short.map((s) => `${s.target - s.have} more ${s.name.toLowerCase()}`).join(" and ");
                return reject("ore_not_gathered", `Not yet: you still need ${need}. Mine more with mine_rock, then come back to smelt them all at once.`, "state");
            }
            return {
                ok: true,
                action: { type: "smelt", product: site.product, bar: site.barName, ores: site.ores.map((o) => o.name), count },
                model,
            };
        }

        case "dialog_continue": {
            if (!fresh.dialog.isOpen) return reject("dialog_closed", "No dialog is open.", "state");
            const opts2 = fresh.dialog.options;
            const continueOnly = opts2.length === 0 || (opts2.length === 1 && isContinuePrompt(opts2[0].text));
            if (!continueOnly) return reject("dialog_requires_choice", "This dialog has choices. Use dialog_select with a choice number.", "state");
            return { ok: true, action: { type: "dialog_continue" }, model };
        }

        case "dialog_select": {
            if (!fresh.dialog.isOpen) return reject("dialog_closed", "No dialog is open.", "state");
            const text = ctx.handles.dialogOptions[a.choice];
            if (text === undefined) {
                const valid = Object.keys(ctx.handles.dialogOptions).join(", ") || "none";
                return reject("bad_choice", `No choice ${a.choice}. Valid choices: ${valid}.`, "state");
            }
            const matches = fresh.dialog.options.filter((o) => o.text.toLowerCase() === text.toLowerCase());
            if (matches.length === 0) return reject("target_gone", "The dialog changed; that choice is no longer shown.", "state");
            if (matches.length > 1) return reject("ambiguous_option", `Several choices read "${text}"; cannot pick safely.`, "state");
            if (isContinuePrompt(text)) return reject("use_dialog_continue", "That is the continue prompt. Use dialog_continue.", "state");
            return { ok: true, action: { type: "dialog_select", optionText: text }, model };
        }
    }
}
