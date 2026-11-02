// Outcome classification: state evidence first, then scoped game messages,
// then the SDK result. Uncertainty is reported as `unconfirmed`, never as success.
//
// Changes from Phase 1 (each is covered by a test):
//  - Game messages are scoped per action type. Phase 1 ran one global regex
//    set first, so a stray "you attack" could override real state evidence.
//  - State evidence now comes before messages (except pickpocket, where a
//    message is the primary evidence).
//  - pickup compares the targeted item ID only, not any inventory change.
//  - SDK failure reasons that are decisive (cant_reach, taken_by_other, ...)
//    map to confirmed_failure; timeouts map to partial_progress_or_timeout.
//  - walk_to tolerance is explicit on the action; a plane change is flagged.

import { exactItem } from "./resources";
import type { ClassifiedStatus, Observation, ResolvedAction } from "./contract";
import { getCapability } from "./capabilities";
import { dialogSignature, quantityById } from "./observe";

export interface Classification {
    outcome: ClassifiedStatus;
    reason: string;
    evidence?: Record<string, unknown>;
}

const ok = (reason: string, evidence?: Record<string, unknown>): Classification => ({
    outcome: "confirmed_success", reason, evidence,
});
const fail = (reason: string, evidence?: Record<string, unknown>): Classification => ({
    outcome: "confirmed_failure", reason, evidence,
});
const unconfirmed = (reason: string, evidence?: Record<string, unknown>): Classification => ({
    outcome: "unconfirmed", reason, evidence,
});

// SDK `reason` values that are decisive: the SDK itself observed the failure.
const DECISIVE_FAILURE_REASONS = new Set([
    "cant_reach", "out_of_reach", "taken_by_other", "inventory_full", "item_not_found",
    "npc_not_found", "no_matching_option", "no_attack_option", "no_pickpocket_option",
    "not_attackable", "stunned", "died", "target_not_found",
]);
// SDK reasons that mean "sent, but we can't tell what happened".
const UNCERTAIN_REASONS = new Set(["rejected", "dispatch_failed", "not_started", "threw_exception"]);

interface MessagePatterns { success?: RegExp; failure?: RegExp }

// Deliberately conservative: a generic message about an action is not proof
// that its intended effect occurred.
const MESSAGE_PATTERNS: Partial<Record<ResolvedAction["type"], MessagePatterns>> = {
    pickup: {
        success: /you pick up|you take the/i,
        failure: /you can't reach|too far away|inventory is too full|cannot reach/i,
    },
    pickpocket: {
        success: /you pickpocket|you steal|you successfully/i,
        failure: /you can't reach|too far away|you can't do that|cannot reach/i,
    },
    // "Someone else is fighting that." appeared in a real run alongside a transient
    // combat-state flip that had cleared two ticks later.
    attack: { failure: /you can't reach|too far away|you can't attack|cannot reach|someone else is fighting that/i },
    eat: { success: /^you (eat|drink)\b/i },
    walk_to: { failure: /you can't reach|cannot reach/i },
    interact_npc: { failure: /you can't reach|too far away|cannot reach/i },
};

function scopedMessages(type: ResolvedAction["type"], messages: any[]) {
    const patterns = MESSAGE_PATTERNS[type] ?? {};
    const lines = messages.map((m) => m?.text ?? "").filter(Boolean) as string[];
    return {
        success: patterns.success ? (lines.find((l) => patterns.success!.test(l)) ?? null) : null,
        failure: patterns.failure ? (lines.find((l) => patterns.failure!.test(l)) ?? null) : null,
    };
}

function stateEvidence(
    action: ResolvedAction,
    before: Observation,
    after: Observation,
    result: any,
): Classification | null {
    switch (action.type) {
        case "walk_to": {
            const distance = Math.max(
                Math.abs(after.player.x - action.x),
                Math.abs(after.player.z - action.z),
            );
            if (after.player.level !== before.player.level) {
                return unconfirmed("plane_changed", { distance, levelBefore: before.player.level, levelAfter: after.player.level });
            }
            if (distance <= action.tolerance) return ok("destination_reached", { distance });
            const moved = before.player.x !== after.player.x || before.player.z !== after.player.z;
            if (moved) {
                return { outcome: "partial_progress_or_timeout", reason: "player_moved_but_destination_not_reached", evidence: { distance } };
            }
            return null;
        }
        case "attack": {
            const b = before.player.combat;
            const a = after.player.combat;
            if (a?.inCombat && (!b?.inCombat || a.targetIndex !== b.targetIndex || a.targetType !== b.targetType)) {
                return ok("combat_state_changed", { combat: a });
            }
            return null;
        }
        case "pickup": {
            const beforeQuantity = quantityById(before.inventory, action.item.id);
            const afterQuantity = quantityById(after.inventory, action.item.id);
            if (afterQuantity > beforeQuantity) {
                return ok("inventory_quantity_increased", { itemId: action.item.id, quantityBefore: beforeQuantity, quantityAfter: afterQuantity });
            }
            return null;
        }
        case "eat": {
            // Food consumed is the strongest evidence; HP going up alone could be natural regeneration.
            const foodBefore = quantityById(before.inventory, action.food.id);
            const foodAfter = quantityById(after.inventory, action.food.id);
            if (foodAfter < foodBefore) {
                return ok("food_consumed", { itemId: action.food.id, quantityBefore: foodBefore, quantityAfter: foodAfter, hpBefore: before.player.hp, hpAfter: after.player.hp });
            }
            return null;
        }
        case "dialog_continue":
        case "dialog_select":
            // The SDK's own report comes first: a click it says failed is not progress, even if the dialog
            // text changed (a real run logged "Failed to click dialog option" as a success).
            if (result?.success === false || /fail/i.test(String(result?.message ?? ""))) return null;
            return dialogSignature(before.dialog) !== dialogSignature(after.dialog) ? ok("dialog_page_changed") : null;
        case "interact_npc": {
            if (
                action.option.toLowerCase() === "talk-to" &&
                dialogSignature(before.dialog) !== dialogSignature(after.dialog) &&
                after.dialog.isOpen
            ) {
                return ok("dialog_opened_or_changed");
            }
            return null;
        }
        case "wait":
            return after.tick > before.tick ? ok("waited", { ticks: after.tick - before.tick }) : null;
        default:
            return null;
    }
}

// Bank and woodcutting steps are judged by the capability registry, the same check the routine uses.
/** The capability and its arguments for each bank and woodcutting action. Names come from the resolved action (the task's). */
function capabilityFor(action: ResolvedAction): { cap: string; args: Record<string, unknown> } | null {
    switch (action.type) {
        case "chop_tree": return { cap: "woodcutting", args: { logs: action.logs } };
        case "open_bank": return { cap: "open_bank", args: {} };
        case "withdraw_logs": return { cap: "withdraw", args: { item: action.item, amount: action.count } };
        case "deposit_items": return { cap: "deposit", args: { item: action.item, amount: "all" } };
        case "close_bank": return { cap: "close_bank", args: {} };
        case "fletch": return { cap: "fletching", args: { logs: action.logs, product: action.product } };
        case "mine_rock": return { cap: "mining", args: { ore: action.ore } };
        case "smelt": return { cap: "smelt", args: { ore: action.ores[0], bar: action.bar } };
        default: return null;
    }
}

function capabilityClassification(action: ResolvedAction, before: Observation, after: Observation): Classification | null {
    const spec = capabilityFor(action);
    if (!spec) return null;
    const r = getCapability(spec.cap).completion(before, after, spec.args);
    if (action.type === "fletch" && r.status === "confirmed_success") {
        // Bows are made one at a time over many ticks: a call that stopped early made only part of its batch.
        const logsIn = (o: Observation) => (o.inventory ?? []).filter((i) => exactItem(action.logs).test(i.name)).reduce((t, i) => t + i.quantity, 0);
        const was = logsIn(before), left = logsIn(after);
        const used = was - left;
        if (used < Math.min(action.batch, was)) {
            return { outcome: "partial_progress_or_timeout", reason: "fletch_batch_unfinished", evidence: { ...r.evidence, logsUsed: used, batch: action.batch } };
        }
    }
    if (r.status === "confirmed_success") return ok(r.reason, r.evidence);
    if (r.status === "partial") return { outcome: "partial_progress_or_timeout", reason: r.reason, evidence: r.evidence };
    return unconfirmed(r.reason, r.evidence);
}

export function classifyOutcome(
    action: ResolvedAction,
    before: Observation,
    after: Observation,
    result: any,
    messages: any[],
): Classification {
    const msg = scopedMessages(action.type, messages);

    const byCapability = capabilityClassification(action, before, after);
    if (byCapability) return byCapability;

    // Pickpocket: the game message is the primary evidence; stun is decisive.
    if (action.type === "pickpocket") {
        if (msg.success) return ok("game_message", { message: msg.success });
        if (msg.failure) return fail("game_failure_message", { message: msg.failure });
    }

    const state = stateEvidence(action, before, after, result);
    if (state) {
        // State says success but the game said otherwise: report the conflict, not a winner.
        if (state.outcome === "confirmed_success" && msg.failure) {
            return unconfirmed("state_and_message_conflict", { stateReason: state.reason, message: msg.failure });
        }
        return state;
    }

    if (msg.success) return ok("game_message", { message: msg.success });
    if (msg.failure) return fail("game_failure_message", { message: msg.failure });

    const reason: string | undefined = result?.reason;
    if (reason === "timeout") return { outcome: "partial_progress_or_timeout", reason: "sdk_timeout" };
    if (reason && DECISIVE_FAILURE_REASONS.has(reason)) return fail(`sdk_${reason}`, { sdkMessage: result?.message });
    if (reason && UNCERTAIN_REASONS.has(reason)) return unconfirmed(`sdk_${reason}_without_stronger_evidence`);

    if (action.type === "dialog_continue" || action.type === "dialog_select") {
        return unconfirmed("dialog_page_unchanged");
    }
    if (action.type === "pickup") {
        const still = after.nearbyGroundItems.some(
            (i) => i.id === action.item.id && i.x === action.item.x && i.z === action.item.z,
        );
        // A same-named stack or pile may remain, so never claim failure from this alone.
        if (still) return unconfirmed("inventory_unchanged_item_still_visible");
    }
    // eatFood waits for the HP/food change itself, so its own "failed" is meaningful.
    if (action.type === "eat" && result?.success === false) return fail("sdk_eat_failed", { sdkMessage: result?.message });
    if (result?.success === false) return unconfirmed("sdk_reported_failure_without_decisive_state_evidence");
    return unconfirmed("no_decisive_evidence");
}
