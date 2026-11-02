// Phase 2 model <-> game contract. Pure types and constants; no SDK imports.
//
// Two versions, deliberately separate:
//   CONTRACT_VERSION   - what the model sees (view / action / result shapes)
//   LOG_SCHEMA_VERSION - the developer JSONL record (Phase 1 wrote 2)

export const CONTRACT_VERSION = 1;
export const LOG_SCHEMA_VERSION = 8; // v4: step, view, handles, allowed; v5: source/safetyRule; v6: bank/shop/skill XP observed; v7: tree/bank/fletch actions (names come from the task); v8: mine/smelt actions, rocks and furnaces observed

export const LIMITS = {
    maxNpcs: 8,
    maxItems: 8,
    maxDialogOptions: 8,
    maxDialogChars: 200,
    maxOptionChars: 80,
    maxInventoryLines: 20,
    inventorySlots: 28,
    /** Longer walks are clamped to this many tiles along the line; the next walk_to continues. */
    maxWalkDistance: 128,
    maxCoord: 16383,
    maxTolerance: 10,
    defaultTolerance: 2,
    maxWaitTicks: 3,
    maxWhyChars: 80,
} as const;

// ---------------------------------------------------------------- statuses

export const STATUSES = [
    "confirmed_success",
    "confirmed_failure",
    "unconfirmed",
    "partial_progress_or_timeout",
    // Rejected by validation; nothing was sent to the SDK.
    "not_executed",
] as const;
export type Status = (typeof STATUSES)[number];
export type ClassifiedStatus = Exclude<Status, "not_executed">;

// ------------------------------------------------------------ model actions

/**
 * Required/optional fields per action type. `why` (debug note) is optional
 * on every action and is ignored by execution.
 */
export const ACTION_SPEC = {
    walk_to: { required: ["x", "z"], optional: ["tolerance"] },
    interact_npc: { required: ["target", "option"], optional: [] },
    pickpocket: { required: ["target"], optional: [] },
    attack: { required: ["target"], optional: [] },
    dialog_continue: { required: [], optional: [] },
    dialog_select: { required: ["choice"], optional: [] },
    pickup: { required: ["target"], optional: [] },
    eat: { required: [], optional: [] },
    // Woodcutting, bank and fletching steps (no handles: the SDK finds the target). Which tree, logs and bow
    // they use is fixed by the task (see resources.ts), never by the model.
    chop_tree: { required: [], optional: [] },
    open_bank: { required: [], optional: [] },
    withdraw_logs: { required: [], optional: [] },
    deposit_items: { required: [], optional: [] },
    close_bank: { required: [], optional: [] },
    fletch: { required: [], optional: [] },
    // Mining and smelting (no handles: the task's site fixes the rocks, ores and furnace; see mineSmelt.ts).
    mine_rock: { required: [], optional: [] },
    smelt: { required: [], optional: [] },
    // Controller-level actions (not SDK operations):
    wait: { required: [], optional: ["ticks"] },
    stop: { required: ["outcome"], optional: [] },
} as const;

export type ActionType = keyof typeof ACTION_SPEC;
export const ACTION_TYPES = Object.keys(ACTION_SPEC) as ActionType[];

/**
 * What the model returns. Targets are per-observation handles (n1, g1),
 * dialog options are 1-based `choice` numbers shown in the observation.
 */
export type ModelAction = (
    | { type: "walk_to"; x: number; z: number; tolerance?: number }
    | { type: "interact_npc"; target: string; option: string }
    | { type: "pickpocket"; target: string }
    | { type: "attack"; target: string }
    | { type: "dialog_continue" }
    | { type: "dialog_select"; choice: number }
    | { type: "pickup"; target: string }
    | { type: "eat" }
    | { type: "chop_tree" }
    | { type: "open_bank" }
    | { type: "withdraw_logs" }
    | { type: "deposit_items" }
    | { type: "close_bank" }
    | { type: "fletch" }
    | { type: "mine_rock" }
    | { type: "smelt" }
    | { type: "wait"; ticks?: number }
    | { type: "stop"; outcome: "done" | "blocked" }
) & { why?: string };

/** Flat JSON schema for constrained decoding (LM Studio json_schema mode). */
export function actionJsonSchema(opts: { withWhy?: boolean; allowed?: readonly ActionType[] } = {}) {
    // `stop` is always available; a goal can narrow the rest so the model cannot pick irrelevant actions.
    const types = ACTION_TYPES.filter((t) => t === "stop" || !opts.allowed || opts.allowed.includes(t));
    const properties: Record<string, unknown> = {
        type: { type: "string", enum: types },
        target: { type: "string", pattern: "^[ng][0-9]{1,2}$" },
        option: { type: "string", maxLength: 40 },
        choice: { type: "integer", minimum: 1, maximum: 12 },
        x: { type: "integer", minimum: 0, maximum: LIMITS.maxCoord },
        z: { type: "integer", minimum: 0, maximum: LIMITS.maxCoord },
        tolerance: { type: "integer", minimum: 0, maximum: LIMITS.maxTolerance },
        ticks: { type: "integer", minimum: 1, maximum: LIMITS.maxWaitTicks },
        outcome: { type: "string", enum: ["done", "blocked"] },
    };
    // Keep only the fields some allowed action actually uses.
    const used = new Set<string>(["type"]);
    for (const t of types) for (const k of [...ACTION_SPEC[t].required, ...ACTION_SPEC[t].optional]) used.add(k);
    for (const k of Object.keys(properties)) if (!used.has(k)) delete properties[k];
    if (opts.withWhy) properties.why = { type: "string", maxLength: LIMITS.maxWhyChars };
    return { type: "object", properties, required: ["type"], additionalProperties: false };
}

// ------------------------------------------------------- resolved (internal)

export interface NpcRef {
    index: number;
    id: number;
    name: string;
    x: number;
    z: number;
}
export interface GroundRef {
    id: number;
    name: string;
    x: number;
    z: number;
}

/** A validated action with handles resolved to concrete entities. */
export type ResolvedAction =
    | { type: "walk_to"; x: number; z: number; tolerance: number }
    | { type: "interact_npc"; npc: NpcRef; option: string }
    | { type: "pickpocket"; npc: NpcRef }
    | { type: "attack"; npc: NpcRef }
    | { type: "dialog_continue" }
    | { type: "dialog_select"; optionText: string }
    | { type: "pickup"; item: GroundRef }
    | { type: "eat"; food: { slot: number; id: number; name: string } }
    | { type: "chop_tree"; tree: string; logs: string }
    | { type: "open_bank" }
    | { type: "withdraw_logs"; item: string; count: number }
    | { type: "deposit_items"; item: string }
    | { type: "close_bank" }
    | { type: "fletch"; logs: string; product: string; menuLabel: string; batch: number }
    | { type: "mine_rock"; ore: string; x: number; z: number }
    /** `count` is the Make-X quantity (capped at 28): one call smelts the whole batch the pack allows. */
    | { type: "smelt"; product: string; bar: string; ores: string[]; count: number }
    | { type: "wait"; ticks: number }
    | { type: "stop"; outcome: "done" | "blocked" };

// -------------------------------------------------------------- validation

export type RejectCode =
    | "not_json" | "not_object" | "unknown_type" | "missing_field" | "bad_field_type"
    | "extra_field" | "out_of_range"
    | "not_in_game" | "player_dead" | "modal_open"
    | "unknown_handle" | "target_gone" | "option_not_offered"
    | "dialog_closed" | "dialog_requires_choice" | "bad_choice" | "use_dialog_continue"
    | "ambiguous_option" | "unreachable" | "no_path" | "too_far"
    | "inventory_full" | "already_attacking" | "action_not_allowed" | "no_food"
    | "bank_not_open" | "bank_already_open" | "no_logs" | "no_knife" | "logs_not_in_bank" | "nothing_to_deposit" | "logs_already_carried" | "no_bow_set" | "repeat_blocked"
    | "no_rock_in_view" | "no_furnace_in_view" | "no_ore_to_smelt" | "nothing_to_mine" | "already_there" | "ore_not_gathered" | "bars_short_before_bank";

export type Validation =
    | { ok: true; action: ResolvedAction; model: ModelAction }
    | { ok: false; code: RejectCode; message: string; stage: "schema" | "state" };

// ------------------------------------------------- full diagnostic observation

export interface ObsNpc {
    index: number;
    id: number;
    name: string;
    x: number;
    z: number;
    distance: number | null;
    reachable: boolean | null;
    /** Client-observed: this NPC is in combat with something (maybe not us). */
    inCombat: boolean | null;
    options: string[];
}
export interface ObsGroundItem {
    id: number;
    name: string;
    x: number;
    z: number;
    distance: number | null;
    quantity: number;
    reachable: boolean | null;
}
export interface ObsInventoryItem {
    slot: number;
    id: number;
    name: string;
    quantity: number;
    /** Present (true) only when the item offers Eat/Drink. Absent in logs older than schema v5. */
    edible?: boolean;
}
/** A stack of one item as seen in the inventory, bank or shop. */
export interface ObsStack {
    id: number;
    name: string;
    quantity: number;
}
export interface ObsDialog {
    isOpen: boolean;
    isWaiting: boolean;
    pageId: string | null;
    text: string;
    options: { index: number; text: string }[];
}

/** A location (tree, bank booth) from the SDK's nearby-location snapshot. */
export interface ObsLoc {
    id: number;
    name: string;
    x: number;
    z: number;
    distance: number | null;
}

export interface ObsLocs {
    /** Oak trees in the snapshot. */
    trees: ObsLoc[];
    /** Bank booths and chests in the snapshot. */
    bankBooths: ObsLoc[];
    /** Rocks in the snapshot (named just "Rock" in game; the ore comes from the tile, see mineSmelt.ts). */
    rocks?: ObsLoc[];
    /** Furnaces in the snapshot. */
    furnaces?: ObsLoc[];
}

export interface Observation {
    tick: number;
    inGame: boolean;
    player: {
        name: string;
        x: number;
        z: number;
        level: number;
        hp: number;
        maxHp: number;
        isDead: boolean;
        combat: { inCombat: boolean; targetIndex: number; targetType: string } | null;
    };
    inventory: ObsInventoryItem[];
    nearbyNpcs: ObsNpc[];
    nearbyGroundItems: ObsGroundItem[];
    dialog: ObsDialog;
    interfaceOpen: boolean | null;
    shopOpen: boolean;
    bankOpen: boolean;
    /** Diagnostic counter only; not proof an action succeeded or failed. */
    opRejectedCount: number | null;
    /** Bank contents while the bank is open; null when closed or not observed (older logs). */
    bankItems?: ObsStack[] | null;
    /** Shop stock while a shop is open; null when closed or not observed. */
    shopItems?: ObsStack[] | null;
    shopTitle?: string | null;
    /** Experience by skill name, e.g. { Woodcutting: 1234 }; null when not observed. */
    skillXp?: Record<string, number> | null;
    /** Trees and bank booths from the nearby-location snapshot; null when not observed. */
    locs?: ObsLocs | null;
}

// ------------------------------------------------------- compact model view

export type Blocking = "none" | "shop" | "bank" | "interface";

export interface ModelView {
    v: number;
    tick: number;
    inGame: boolean;
    player: {
        x: number;
        z: number;
        level: number;
        hp: number;
        maxHp: number;
        dead: boolean;
        combat: "idle" | "npc" | "player";
        combatTarget?: string;
    };
    blocking: Blocking;
    inventory: { id: number; name: string; qty: number }[];
    inventoryUsed: number;
    /** `busy`: in combat with something other than the player. */
    npcs: { h: string; name: string; dist: number | null; options: string[]; reachable: boolean | null; busy: boolean }[];
    items: { h: string; name: string; qty: number; dist: number | null; reachable: boolean | null }[];
    dialog: {
        open: boolean;
        text: string;
        continueOnly: boolean;
        options: { n: number; text: string }[];
    };
    omitted: { npcs: number; items: number; dialogOptions: number };
    /** Entries the view filter kept out of the prompt (see view.ts). Absent when nothing was hidden. */
    hidden?: { npcs: number; items: number };
}

/** Handle -> entity, valid only for the observation the view was built from. */
export interface HandleMap {
    npcs: Record<string, NpcRef & { options: string[]; reachable: boolean | null }>;
    items: Record<string, GroundRef & { reachable: boolean | null }>;
    dialogOptions: Record<number, string>;
}

// ------------------------------------------------------------ action result

/** What the controller/logs get back for every action attempt. */
export interface ActionOutcome {
    schemaVersion: number;
    action: unknown;
    status: Status;
    reason: string;
    /** True only if something was actually sent to the SDK. */
    dispatched: boolean;
    evidence?: Record<string, unknown>;
    message?: string;
    tickBefore: number | null;
    tickAfter: number | null;
}
