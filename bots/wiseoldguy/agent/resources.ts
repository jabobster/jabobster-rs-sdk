// Which tree (and so which logs and bows) a task works with. The model never picks these: the task
// fixes them from AGENT_TREE / AGENT_BOW (or the defaults), the goal text states them, and the actions
// run against them. Oak is the default and the only tree tested live.

import type { SmeltSite } from "./mineSmelt";
import type { DepletedRocks } from "./smeltRules";

export type TreeKey = "oak" | "willow" | "maple";
export type BowKind = "shortbow" | "longbow";

export interface Resource {
    key: TreeKey;
    /** Name the SDK chops (chopTree matches this, case-insensitive). */
    tree: string;
    /** Name of the logs in the pack and the bank. */
    logs: string;
    /** Prefix of the bow names, e.g. "Oak" gives "Oak longbow". */
    name: string;
    /** Plural for goal text, e.g. "oak trees". */
    noun: string;
    /** Fletching level for each bow. Oak is verified live; the others are not yet. */
    fletchLevel: Record<BowKind, number>;
    verified: boolean;
}

export const RESOURCES: Record<TreeKey, Resource> = {
    oak: { key: "oak", tree: "Oak", logs: "Oak logs", name: "Oak", noun: "oak trees", fletchLevel: { shortbow: 20, longbow: 25 }, verified: true },
    willow: { key: "willow", tree: "Willow", logs: "Willow logs", name: "Willow", noun: "willow trees", fletchLevel: { shortbow: 35, longbow: 40 }, verified: false },
    maple: { key: "maple", tree: "Maple tree", logs: "Maple logs", name: "Maple", noun: "maple trees", fletchLevel: { shortbow: 50, longbow: 55 }, verified: false },
};

/** Reads AGENT_TREE. Unset means oak. Anything else is an error, so a typo cannot silently chop the wrong tree. */
export function parseTree(raw: string | undefined): Resource {
    const key = (raw ?? "").trim().toLowerCase() || "oak";
    if (!(key in RESOURCES)) {
        throw new Error(`AGENT_TREE must be one of ${Object.keys(RESOURCES).join(", ")}, got "${raw}"`);
    }
    return RESOURCES[key as TreeKey];
}

/** Reads AGENT_BOW. Unset means longbow. */
export function parseBow(raw: string | undefined): BowKind {
    const kind = (raw ?? "").trim().toLowerCase() || "longbow";
    if (kind !== "shortbow" && kind !== "longbow") {
        throw new Error(`AGENT_BOW must be shortbow or longbow, got "${raw}"`);
    }
    return kind;
}

/** Full item name of the bow made from a resource, e.g. "Oak longbow". */
export const bowName = (res: Resource, bow: BowKind) => `${res.name} ${bow}`;

/** The skill-menu line for a bow, e.g. "Oak Long Bow" (the SDK matches menu text against this). */
export const menuLabel = (res: Resource, bow: BowKind) => `${res.name} ${bow === "longbow" ? "Long Bow" : "Short Bow"}`;

/** Regex that matches exactly one item name, case-insensitive (the SDK takes regexes). */
export const exactItem = (name: string) => new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i");

/** What a task works with, passed to validation and execution. */
export interface TaskResources {
    resource: Resource;
    /** Logs the run handles: the withdraw count for fletching, the target for chopping. */
    logCount: number;
    /** Set for fletch tasks: the bow the logs become. */
    bow?: BowKind;
    /** Set for mine-smelt-bank tasks: the site (rocks, furnace, bank) and the bars to make. */
    /** Bars deposited so far on a smelt task (counted from confirmed deposits). */
    smelt?: { site: SmeltSite; bars: number; depleted?: DepletedRocks; banked?: number };
}

export const DEFAULT_RESOURCES: TaskResources = { resource: RESOURCES.oak, logCount: 10 };
