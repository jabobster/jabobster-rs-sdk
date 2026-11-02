// A task bundles everything the controller needs for one job: the text the model sees, the actions it
// may use, a start-state check (refuse to run from a bad state), and a game-side check that "done" is
// actually true. Phase 3 calls this a TaskSpec; GoalSpec is kept as an alias for existing code.

import { LIMITS, type ActionType, type Observation, type ObsStack } from "./contract";
import type { ControllerConfig } from "./controller";
import type { ViewFilter } from "./view";
import { isFighting } from "./observe";
import { isLowHp } from "./safety";
import { RESOURCES, bowName, exactItem, type BowKind, type Resource } from "./resources";
import { DEFAULT_BANK, type Bank } from "./places";
import type { SmeltSite } from "./mineSmelt";
import { DepletedRocks, bankReady, oresShort, shortBeyondSlack } from "./smeltRules";


export type StartCheck =
    /** `warnings` are recorded in the episode but do not block the run. */
    | { ok: true; warnings: string[] }
    /** `problems` block the run. Nothing is sent to the game and the run is marked invalid. */
    | { ok: false; problems: string[]; warnings: string[] };

export interface TaskSpec {
    /** Stable id, written to every episode record. */
    id: string;
    goal: string;
    allowedActions: readonly ActionType[];
    /** Optional per-step narrowing of allowedActions from the game state (see ControllerConfig.allowedFor). */
    allowedFor?: NonNullable<ControllerConfig["allowedFor"]>;
    verifyDone: NonNullable<ControllerConfig["verifyDone"]>;
    /** Checked once, before the first action. A failing check ends the run before it starts. */
    startCheck?: (obs: Observation) => StartCheck;
    /** Optional hint after a rejected "done" (see ControllerConfig.hintFor). */
    hintFor?: NonNullable<ControllerConfig["hintFor"]>;
    /** Optional: narrows what the model is shown, on top of the global filter (see view.ts). */
    viewFilter?: ViewFilter;
}

export type GoalSpec = TaskSpec;

const countByName = (obs: Observation, re: RegExp) =>
    obs.inventory.filter((i) => re.test(i.name)).reduce((t, i) => t + i.quantity, 0);

/** Start checks shared by every combat task. */
export function combatStartCheck(obs: Observation, opts: { targetName: RegExp; lowHpFraction?: number }): StartCheck {
    const problems: string[] = [];
    const warnings: string[] = [];
    if (!obs.inGame) problems.push("not in game");
    if (obs.player.isDead) problems.push("player is dead");
    if (obs.dialog.isOpen) problems.push("a dialog is open");
    if (obs.shopOpen || obs.bankOpen || obs.interfaceOpen) problems.push("a shop, bank or interface is open");
    if (isFighting(obs)) problems.push("already fighting something");
    if (isLowHp(obs, opts.lowHpFraction ?? 0.2)) {
        problems.push(`HP ${obs.player.hp}/${obs.player.maxHp} is low; heal or rest before starting`);
    }
    if (obs.inventory.length >= 28) problems.push("inventory is full (no room for drops)");
    const targets = obs.nearbyNpcs.filter((n) => opts.targetName.test(n.name));
    if (!targets.length) problems.push("no matching target is nearby");
    else if (targets.every((n) => n.inCombat === true)) problems.push("every matching target is already in combat");
    return problems.length ? { ok: false, problems, warnings } : { ok: true, warnings };
}

/**
 * Kill a cow, then pick up its cowhide and bones.
 * Completion is "more Cowhide AND more Bones than at the start". It cannot prove the
 * items came from this particular cow (a stray pile would also count), but a hide
 * only shows up after a kill, so a false "done" with nothing picked up is caught.
 */
export function cowGoal(version: 1 | 2 = 2): TaskSpec {
    return {
        id: "cow-hide-and-bones",
        // v2 (default): in real runs the test inventory already held a Cowhide and Bones, so the model
        // saw both and said "done" before touching the drops. v2 says that carried items do not count.
        goal: version === 1
            ? "Kill a cow, then pick up its cowhide and bones. Cows are the npcs named Cow."
            : "Kill a cow, then pick up the Cowhide and Bones it drops on the ground. Items you already carry do not count. Cows are the npcs named Cow.",
        // Walking is deliberately excluded: the model starts in the cow pen, and a free
        // coordinate is the easiest thing for a small model to hallucinate.
        allowedActions: ["attack", "pickup", "wait"],
        // The model only needs cows and the drops it is after. Other NPCs and items stay in the logs.
        viewFilter: {
            npc: (npc) => /^cow$/i.test(npc.name),
            item: (item) => /^(cow ?hide|bones)$/i.test(item.name),
        },
        verifyDone(current, baseline) {
            const missing: string[] = [];
            if (countByName(current, /^cow ?hide$/i) <= countByName(baseline, /^cow ?hide$/i)) {
                missing.push("a Cowhide in your inventory (kill a cow, then pick up its hide)");
            }
            if (countByName(current, /^bones$/i) <= countByName(baseline, /^bones$/i)) {
                missing.push("Bones in your inventory (pick up the bones the cow dropped)");
            }
            return missing.length ? { done: false, missing: missing.join(" and ") } : { done: true };
        },
        // Only names what is actually on the ground and reachable, so the model is pointed at a real handle.
        hintFor(obs, baseline, handles) {
            const hints: string[] = [];
            const point = (re: RegExp, label: string) => {
                if (countByName(obs, re) > countByName(baseline, re)) return;
                const found = Object.entries(handles.items).find(([, item]) => re.test(item.name) && item.reachable);
                if (found) hints.push(`The ${label} is on the ground at ${found[0]}: pick it up with {"type":"pickup","target":"${found[0]}"}.`);
            };
            point(/^cow ?hide$/i, "Cowhide");
            point(/^bones$/i, "Bones");
            return hints.length ? hints.join(" ") : undefined;
        },
        startCheck(obs) {
            const result = combatStartCheck(obs, { targetName: /^cow$/i });
            // Carried loot does not block the run (the test account holds stray items), but it is
            // recorded: those items are what made earlier runs say "done" too early.
            const carried = [
                ["Cowhide", countByName(obs, /^cow ?hide$/i)],
                ["Bones", countByName(obs, /^bones$/i)],
            ] as const;
            const warnings = [...result.warnings];
            for (const [name, n] of carried) {
                if (n > 0) warnings.push(`already carrying ${n} ${name}: carried items do not count toward the goal`);
            }
            return result.ok ? { ok: true, warnings } : { ok: false, problems: result.problems, warnings };
        },
    };
}

export const CHOP_BANK_TARGET = 5;
export const INVENTORY_SLOTS = 28;

/** A number of logs, or "full": every free inventory slot at the start (oak logs do not stack). */
export type ChopTargetSpec = number | "full";

/** Reads AGENT_CHOP_TARGET: "full", a whole number from 1 to 28, or unset (the default target). */
export function parseChopTarget(raw: string | undefined): ChopTargetSpec {
    if (raw == null || raw.trim() === "") return CHOP_BANK_TARGET;
    if (raw.trim().toLowerCase() === "full") return "full";
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > INVENTORY_SLOTS) {
        throw new Error(`AGENT_CHOP_TARGET must be "full" or a whole number from 1 to ${INVENTORY_SLOTS}, got "${raw}"`);
    }
    return n;
}

/** The number of logs a run aims for. "full" is resolved from the start state, so it is fixed for the run. */
export function resolveChopTarget(spec: ChopTargetSpec, start: Observation): number {
    return spec === "full" ? Math.max(1, INVENTORY_SLOTS - start.inventory.length) : spec;
}
const countOf = (stacks: ObsStack[] | null | undefined, re: RegExp) =>
    (stacks ?? []).filter((s) => re.test(s.name)).reduce((t, s) => t + s.quantity, 0);

/**
 * Chop a tree and bank its logs. The bank contents are only visible while the bank is open, so the
 * completion check remembers the log count it saw in the open bank. Create one per run: that memory is per run.
 */
export function chopBankGoal(opts: { target?: number; resource?: Resource; bank?: Bank } = {}): TaskSpec {
    const res = opts.resource ?? RESOURCES.oak;
    const bank = opts.bank ?? DEFAULT_BANK;
    const logs = exactItem(res.logs);
    const target = opts.target ?? CHOP_BANK_TARGET;
    let bankBefore: number | null = null;   // first log count seen in the open bank
    let bankLatest: number | null = null;   // most recent log count seen in the open bank
    return {
        id: "chop-oak-and-bank",
        goal: `Keep chopping ${res.noun} near x 3166 z 3416 until you carry ${target} ${res.logs.toLowerCase()}. Then walk to the ${bank.name} at x ${bank.x} z ${bank.z}, open the bank, deposit the ${res.logs.toLowerCase()}, and close the bank.`,
        allowedActions: ["chop_tree", "walk_to", "open_bank", "deposit_items", "close_bank", "wait"],
        verifyDone(current) {
            if (current.bankOpen && current.bankItems) {
                const n = countOf(current.bankItems, logs);
                bankBefore ??= n;
                bankLatest = n;
            }
            const deposited = bankBefore != null && bankLatest != null ? bankLatest - bankBefore : 0;
            const missing: string[] = [];
            if (deposited < target) {
                missing.push(`${target} ${res.logs.toLowerCase()} deposited in the bank (deposited so far: ${deposited})`);
            }
            if (current.bankOpen) missing.push("the bank closed");
            return missing.length ? { done: false, missing: missing.join(" and ") } : { done: true };
        },
        startCheck(obs) {
            const problems: string[] = [];
            if (!obs.inGame) problems.push("not in game");
            if (obs.player.isDead) problems.push("player is dead");
            if (obs.dialog.isOpen) problems.push("a dialog is open");
            if (obs.shopOpen || obs.bankOpen || obs.interfaceOpen) problems.push("a shop, bank or interface is open");
            if (obs.inventory.length >= 28) problems.push("inventory is full");
            // Logs already carried would be deposited and counted, so the run would not measure chopping.
            const carried = countOf(obs.inventory, logs);
            if (carried > 0) problems.push(`already carrying ${carried} ${res.logs.toLowerCase()}: deposit or drop them first`);
            return problems.length ? { ok: false, problems, warnings: [] } : { ok: true, warnings: [] };
        },
    };
}

/**
 * Bank logs, fletch them into bows with a knife, and bank the bows. The bank is only visible while open, so the
 * completion check counts bows from the first bank view (before the withdraw) and needs `logCount` more when the bank
 * is closed again. Create one per run.
 */
export function fletchBankGoal(opts: { logCount: number; resource?: Resource; bow?: BowKind; bank?: Bank }): TaskSpec {
    const res = opts.resource ?? RESOURCES.oak;
    const bank = opts.bank ?? DEFAULT_BANK;
    const bow = opts.bow ?? "longbow";
    const bowItem = bowName(res, bow);
    const bowRe = exactItem(bowItem);
    const logs = exactItem(res.logs);
    const n = opts.logCount;
    let bankBefore: number | null = null;   // bows in the bank the first time it was seen open
    let bankLatest: number | null = null;   // most recent bow count seen in the open bank
    let bankOpenSeen = false;
    return {
        id: "fletch-bank",
        goal: `Walk to the ${bank.name} at x ${bank.x} z ${bank.z}. Open the bank, withdraw ${n} ${res.logs.toLowerCase()}, and close the bank. Use your knife on the ${res.logs.toLowerCase()} to fletch them into ${bowItem.toLowerCase()}s. Then open the bank again, deposit the ${bowItem.toLowerCase()}s, and close the bank.`,
        allowedActions: ["walk_to", "open_bank", "withdraw_logs", "close_bank", "fletch", "deposit_items", "wait"],
        verifyDone(current) {
            if (current.bankOpen && current.bankItems) {
                bankOpenSeen = true;
                const b = countOf(current.bankItems, bowRe);
                bankBefore ??= b;
                bankLatest = b;
            }
            const deposited = bankBefore != null && bankLatest != null ? bankLatest - bankBefore : 0;
            const missing: string[] = [];
            if (!bankOpenSeen || deposited < n) {
                missing.push(`${n} ${bowItem.toLowerCase()}s deposited in the bank (deposited so far: ${deposited})`);
            }
            const logsLeft = countOf(current.inventory, logs);
            if (logsLeft > 0) missing.push(`${logsLeft} ${res.logs.toLowerCase()} still to fletch`);
            if (current.bankOpen) missing.push("the bank closed");
            return missing.length ? { done: false, missing: missing.join(" and ") } : { done: true };
        },
        hintFor(current) {
            // Only used after a rejected "done": say which step is left, using the actions the task allows.
            const logsLeft = countOf(current.inventory, logs);
            const bows = countOf(current.inventory, bowRe);
            if (logsLeft > 0) {
                return current.bankOpen
                    ? `${logsLeft} ${res.logs.toLowerCase()} are still in your pack. Close the bank (close_bank), then fletch.`
                    : `${logsLeft} ${res.logs.toLowerCase()} are still in your pack. Use fletch.`;
            }
            if (bows > 0) {
                return current.bankOpen
                    ? `${bows} ${bowItem.toLowerCase()}s are in your pack. Use deposit_items.`
                    : `${bows} ${bowItem.toLowerCase()}s are in your pack. Open the bank (open_bank), then deposit_items.`;
            }
            return undefined;
        },
        startCheck(obs) {
            const problems: string[] = [];
            const warnings: string[] = [];
            if (!obs.inGame) problems.push("not in game");
            if (obs.player.isDead) problems.push("player is dead");
            if (obs.dialog.isOpen) problems.push("a dialog is open");
            if (obs.shopOpen || obs.bankOpen || obs.interfaceOpen) problems.push("a shop, bank or interface is open");
            if (!obs.inventory.some((i) => /knife/i.test(i.name))) problems.push("no knife in the pack");
            // Logs or bows already carried would skew the count of what this run banked.
            const carried = countOf(obs.inventory, logs);
            const bows = countOf(obs.inventory, bowRe);
            if (carried > 0) problems.push(`already carrying ${carried} ${res.logs.toLowerCase()}: deposit or drop them first`);
            if (bows > 0) problems.push(`already carrying ${bows} ${bowItem.toLowerCase()}s: deposit or drop them first`);
            warnings.push(`Fletching level ${res.fletchLevel[bow]} is needed; the start check does not read it`);
            if (!res.verified) warnings.push(`${res.name} bows are not verified in the live game`);
            return problems.length ? { ok: false, problems, warnings } : { ok: true, warnings };
        },
    };
}

/**
 * Mine ore at a site, smelt it at the furnace with Make-X, and bank the bars. The site fixes the rocks, furnace and
 * bank, so the goal text gives coordinates, not names. The completion check counts bars from the first bank view
 * (before the deposit) and needs `bars` more when the bank is closed again. Create one per run.
 */
/**
 * Fill a goal template for mine-smelt. Placeholders: {bars} {ore} {barItem} {mine} {furnace} {bank}.
 * Used by AGENT_SMELT_GOAL so the wording can be tested without a code change. The completion check is unchanged.
 */
export function fillSmeltTemplate(template: string, vars: Record<string, string | number>): string {
    return template.replace(/\{(\w+)\}/g, (whole, key) => (key in vars ? String(vars[key]) : whole));
}

/** Actions for each stage of mine-smelt (see `allowedFor` below). Each stage withholds the actions that cannot help. */
const SMELT_BANK_STAGE: readonly ActionType[] = ["walk_to", "open_bank", "deposit_items", "close_bank", "wait"];
const SMELT_MINE_STAGE: readonly ActionType[] = ["mine_rock", "wait"];
const SMELT_MINE_WALK_STAGE: readonly ActionType[] = ["walk_to", "mine_rock", "wait"];
const SMELT_FURNACE_STAGE: readonly ActionType[] = ["walk_to", "smelt", "wait"];

export function mineSmeltGoal(opts: { site: SmeltSite; bars: number; template?: string; depleted?: DepletedRocks }): TaskSpec {
    const { site } = opts;
    const n = opts.bars;
    // Shared with the resources, so the rocks this run has just mined are on cooldown here too.
    const depleted = opts.depleted ?? new DepletedRocks();
    const barItem = site.barName.toLowerCase();
    const oreNames = site.ores.map((o) => o.name.toLowerCase());
    const minePoints = site.ores.map((o) => `${o.name.toLowerCase()} rocks near x ${o.rocks[0].x} z ${o.rocks[0].z}`).join("; ");
    let bankBefore: number | null = null;   // bars in the bank the first time it was seen open
    let bankLatest: number | null = null;   // most recent bar count seen in the open bank
    let bankOpenSeen = false;
    const bankSeen = (current: Observation) => {
        if (current.bankOpen && current.bankItems) {
            bankOpenSeen = true;
            const b = countOf(current.bankItems, site.barRe);
            bankBefore ??= b;
            bankLatest = b;
        }
    };
    const deposited = () => (bankBefore != null && bankLatest != null ? bankLatest - bankBefore : 0);
    const isSiteRock = (r: { x: number; z: number }) => site.ores.some((o) => o.rocks.some((t) => t.x === r.x && t.z === r.z));
    return {
        id: "mine-smelt-bank",
        goal: opts.template ? fillSmeltTemplate(opts.template, {
            bars: n, barItem, ore: oreNames.join(" and "), mine: minePoints,
            furnace: `x ${site.furnace.x} z ${site.furnace.z}`, bank: `x ${site.bank.x} z ${site.bank.z}`,
        }) : `Get ${n} ${barItem}s banked. (1) Mine ${oreNames.join(" and ")} at the ${minePoints}, until mine_rock says every ore is at target. (2) Walk to the furnace at x ${site.furnace.x} z ${site.furnace.z} and smelt: one smelt action smelts the whole pile. (3) When you carry the ${barItem}s still needed, walk to the bank at x ${site.bank.x} z ${site.bank.z}, open it, deposit the ${barItem}s, and close it. Repeat (1) to (3) until ${n} ${barItem}s are banked. If an action is refused, do what its message says. A level-up or other dialog does not stop the task: close it and carry on.`,
        allowedActions: ["walk_to", "mine_rock", "smelt", "open_bank", "deposit_items", "close_bank", "wait"],
        allowedFor(current) {
            bankSeen(current);
            const need = n - deposited();
            if (need <= 0) return undefined;
            // Bank: enough bars are carried. Ore left in the pack does not matter.
            if (bankReady(current.inventory, site.barRe, need, LIMITS.inventorySlots)) return SMELT_BANK_STAGE;
            // Mine: the batch is short and the pack has room. A usable rock of this site in view means no walk is
            // needed, so the furnace cannot be chosen by mistake while mining.
            const short = oresShort(site, current.inventory, n);
            const room = current.inventory.length < LIMITS.inventorySlots;
            if (room && shortBeyondSlack(short)) {
                const usable = (current.locs?.rocks ?? []).some((r) => isSiteRock(r) && depleted.available(r.x, r.z, current.tick));
                return usable ? SMELT_MINE_STAGE : SMELT_MINE_WALK_STAGE;
            }
            // Furnace: the batch is ready, or the pack is full.
            return SMELT_FURNACE_STAGE;
        },
        verifyDone(current) {
            bankSeen(current);
            const missing: string[] = [];
            if (!bankOpenSeen || deposited() < n) {
                missing.push(`${n} ${barItem}s deposited in the bank (deposited so far: ${deposited()})`);
            }
            const barsLeft = countOf(current.inventory, site.barRe);
            if (barsLeft > 0) missing.push(`${barsLeft} ${barItem}s still in your pack`);
            if (current.bankOpen) missing.push("the bank closed");
            return missing.length ? { done: false, missing: missing.join(" and ") } : { done: true };
        },
        hintFor(current) {
            // Only used after a rejected "done": say which step is left, using the actions the task allows.
            const bars = countOf(current.inventory, site.barRe);
            if (bars > 0) {
                return current.bankOpen
                    ? `${bars} ${barItem}s are in your pack. Use deposit_items.`
                    : `${bars} ${barItem}s are in your pack. Open the bank (open_bank), then deposit_items.`;
            }
            if (site.ores.every((o) => countOf(current.inventory, o.re) > 0)) {
                return "You have ore for a smelt. Walk to the furnace if needed, then use smelt.";
            }
            return "Mine more ore with mine_rock (walk to the rocks first if none are in view).";
        },
        startCheck(obs) {
            const problems: string[] = [];
            const warnings: string[] = [];
            if (!obs.inGame) problems.push("not in game");
            if (obs.player.isDead) problems.push("player is dead");
            if (obs.dialog.isOpen) problems.push("a dialog is open");
            if (obs.shopOpen || obs.bankOpen || obs.interfaceOpen) problems.push("a shop, bank or interface is open");
            // Ore or bars already carried are counted toward this run, so say so rather than block.
            for (const o of site.ores) {
                const held = countOf(obs.inventory, o.re);
                if (held > 0) warnings.push(`already carrying ${held} ${o.name.toLowerCase()}`);
            }
            const heldBars = countOf(obs.inventory, site.barRe);
            if (heldBars > 0) warnings.push(`already carrying ${heldBars} ${barItem}s`);
            warnings.push(`The start check does not read the pickaxe or levels: needs Mining ${site.miningLevel}, Smithing ${site.smithingLevel}, and a pickaxe`);
            return problems.length ? { ok: false, problems, warnings } : { ok: true, warnings };
        },
    };
}
