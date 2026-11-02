// Deterministic reference policies. They read the same compact ModelView a
// model would, so they exercise the full contract with no model in the loop.

import { FixedPolicy } from "./policy";

/** Goal: kill a cow, then pick up its cowhide and bones. */
export function cowPolicy(): FixedPolicy {
    let startBones: number | null = null;
    let startHides: number | null = null;
    return new FixedPolicy(({ view }) => {
        const count = (re: RegExp) =>
            view.inventory.filter((i) => re.test(i.name)).reduce((t, i) => t + i.qty, 0);

        // Items already carried do not count: completion means MORE of each than at the start,
        // the same rule as cowGoal().verifyDone. (A plain "> 0" check said done with a stray hide.)
        startBones ??= count(/^bones$/i);
        startHides ??= count(/^cow ?hide$/i);
        if (count(/^cow ?hide$/i) > startHides && count(/^bones$/i) > startBones) {
            return { type: "stop", outcome: "done" };
        }

        if (view.dialog.open) {
            return view.dialog.continueOnly ? { type: "dialog_continue" } : { type: "wait" };
        }
        if (view.player.combat !== "idle") return { type: "wait", ticks: 2 };

        const loot = view.items.find((i) => /^(cow ?hide|bones)$/i.test(i.name) && i.reachable !== false);
        if (loot) return { type: "pickup", target: loot.h };

        const cow = view.npcs.find(
            (n) => /^cow$/i.test(n.name) && n.reachable !== false && n.options.some((o) => /^attack$/i.test(o)),
        );
        if (cow) return { type: "attack", target: cow.h };

        return { type: "wait", ticks: 3 };
    });
}
