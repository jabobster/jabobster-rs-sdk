// Executes ONE validated action through the existing SDK helpers.
// Targets arrive already resolved by validate.ts; here we only re-find the live
// SDK entity (so the helper gets a real NearbyNpc/GroundItem, not a snapshot).

import type { Observation, ResolvedAction } from "./contract";
import { fletchKnife } from "./fletchBank";
import { groundMirror } from "./observe";
import { exactItem } from "./resources";
import { mineRockAt, smeltAtFurnace } from "./mineSmelt";

export async function performAction(bot: any, sdk: any, action: ResolvedAction, before: Observation): Promise<any> {
    switch (action.type) {
        case "walk_to":
            return await bot.walkTo(action.x, action.z, action.tolerance);

        case "interact_npc": {
            const target = findLiveNpc(sdk, action.npc);
            if (!target) return targetNotFound(`NPC ${action.npc.name} is gone`);
            if (action.option.toLowerCase() === "talk-to") return await bot.talkTo(target);
            return await bot.interactNpc(target, action.option);
        }

        case "pickpocket": {
            const target = findLiveNpc(sdk, action.npc);
            if (!target) return targetNotFound(`NPC ${action.npc.name} is gone`);
            return await bot.pickpocketNpc(target);
        }

        case "attack": {
            const target = findLiveNpc(sdk, action.npc);
            if (!target) return targetNotFound(`NPC ${action.npc.name} is gone`);
            return await bot.attack(target);
        }

        case "dialog_continue":
            // 0 is the SDK's special continue/click-through value.
            return await sdk.sendClickDialog(0);

        case "dialog_select":
            // Bound to the visible text (and the observed page) by the SDK.
            return await sdk.clickDialogByText(action.optionText);

        case "pickup": {
            const live = groundMirror(sdk).find(
                (i: any) => i.id === action.item.id && i.x === action.item.x && i.z === action.item.z,
            );
            const snapshot = before.nearbyGroundItems.find(
                (i) => i.id === action.item.id && i.x === action.item.x && i.z === action.item.z,
            );
            const item = live ?? (snapshot ? { ...snapshot, count: snapshot.quantity } : null);
            if (!item) return targetNotFound(`Ground item ${action.item.name} is gone`);
            return await bot.pickupItem(item);
        }

        case "eat": {
            // Eat the exact item validation chose (first edible by slot); fall back to the SDK default.
            const live = (sdk.getInventory?.() ?? []).find((i: any) => i.slot === action.food.slot && i.id === action.food.id);
            return await bot.eatFood(live ?? undefined);
        }

        case "chop_tree":
            // The SDK walks into range of a tree itself. The tree comes from the task (resolved by validation).
            return await bot.chopTree(exactItem(action.tree));

        case "open_bank":
            return await bot.openBank();

        case "withdraw_logs":
            return await bot.withdrawItem(action.item, action.count);

        case "deposit_items":
            return await bot.depositItem(exactItem(action.item), -1);

        case "fletch": {
            // Same knife step as the fixed routine. Bows are made one at a time, so the action waits for the logs to
            // stop going down (or for the same budget the fixed routine uses) before it reports.
            const result: any = await fletchKnife(sdk, bot, action.menuLabel, action.batch, action.logs);
            if (result?.success) await settleFletch(sdk, action.logs, 10 + action.batch * 14);
            return result;
        }

        case "close_bank":
            return await bot.closeBank();

        case "mine_rock":
            // The rock tile comes from validation; the helper finds the live rock by that tile.
            return await mineRockAt(bot, sdk, action.x, action.z);

        case "smelt":
            // Make-X: one call for the whole pile (the helper answers the count prompt and waits for the batch).
            // Keeps smelting until the ore is gone: a level-up dialog can stop a batch part way.
            return await smeltAtFurnace(bot, sdk, action.product, action.count, undefined, () => oreLeft(sdk, action.ores));

        case "wait":
            await sdk.waitForTicks(action.ticks);
            return { success: true, message: `waited ${action.ticks} ticks` };

        case "stop":
            return { success: true, message: "stop is handled by the controller" };
    }
}

/** Waits until the logs stop going down for a while (one bow takes about 4 ticks, so the quiet period is longer), or the budget ends. */
export async function settleFletch(sdk: any, logs: string, maxTicks: number): Promise<void> {
    const count = () => sdk.countInventoryItems?.(exactItem(logs)) ?? null;
    let last = count();
    let quiet = 0;
    for (let t = 0; t < maxTicks; t++) {
        await sdk.waitForTicks(1);
        const now = count();
        if (now === 0) return;
        if (now === last) {
            if (++quiet >= 8) return;
        } else {
            quiet = 0;
            last = now;
        }
    }
}

function findLiveNpc(sdk: any, ref: { index: number; name: string }) {
    return (sdk.getNearbyNpcs() ?? []).find((n: any) => n.index === ref.index && n.name === ref.name) ?? null;
}

function targetNotFound(message: string) {
    return { success: false, reason: "target_not_found", message };
}

/** Ore still in the pack for a smelt: the smallest total among the named ores (a bar takes one of each). */
function oreLeft(sdk: any, ores: string[]): number {
    // The SDK's inventory items carry `count` (the observation uses `quantity`); read either, never NaN.
    const inv: Array<{ name: string; count?: number; quantity?: number }> = sdk.getState?.()?.inventory ?? [];
    return Math.min(...ores.map((name) => inv.filter((i) => i.name.toLowerCase() === name.toLowerCase())
        .reduce((t, i) => t + (i.count ?? i.quantity ?? 0), 0)));
}
