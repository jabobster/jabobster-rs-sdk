// Deterministic safety layer. It runs BEFORE every model call and may take the turn away from the
// model. The model never sees these decisions as choices; it only sees a result line tagged [auto].
//
// Rules, in priority order:
//   1. Low HP (default: at or below 20% of max HP)
//        food in the pack            -> eat
//        no food, fighting           -> flee (walk away from the threats); after a few failed
//                                       attempts either fight on (default) or stop
//        no food, not fighting       -> stop (don't start another fight on low HP)
//   2. No progress: nothing the agent can observe changed for a while -> stop
//   3. Too many failed/unconfirmed actions in a row (or in total) -> stop
//
// Pure logic over Observations: no SDK, no I/O. The controller executes whatever it returns through
// the normal validate/execute/classify/log path, so every override is verified and logged.

import type { ModelAction, Observation, Status } from "./contract";
import { LIMITS } from "./contract";
import { dialogSignature, isFighting } from "./observe";

export type SafetyRule = "low_hp_eat" | "low_hp_flee";
export type SafetyStop = "safety_low_hp" | "no_progress" | "too_many_failures";

export interface SafetyConfig {
    /** Low HP means hp / maxHp <= this. Default 0.2. */
    lowHpFraction?: number;
    /** Eat when low on HP and food is available. Default true. */
    eat?: boolean;
    /** How far (tiles) to run from the threats. Default 12. */
    fleeDistance?: number;
    /** Preferred flee destination (tried before "away from threats"). */
    safePoint?: { x: number; z: number };
    /** Flee steps in a row while still low and still fighting before giving up. Default 3. */
    maxFleeAttempts?: number;
    /** After fleeing fails: "continue" (fight on, default) or "stop". */
    onFleeFailed?: "continue" | "stop";
    /** No-progress watchdog: unchanged for this many steps AND this many game ticks. Defaults 10 / 50. */
    noProgressSteps?: number;
    noProgressTicks?: number;
    /** Consecutive / total model actions that did not confirm success. Defaults 6 / 20. */
    maxFailureStreak?: number;
    maxTotalFailures?: number;
}

export type SafetyVerdict =
    | { kind: "none" }
    /** Try `actions` in order; the first one that is not rejected by validation is the one that runs. */
    | { kind: "act"; rule: SafetyRule; reason: string; actions: ModelAction[] }
    | { kind: "stop"; stopReason: SafetyStop; detail: string };

export const SAFETY_DEFAULTS = {
    lowHpFraction: 0.2,
    eat: true,
    fleeDistance: 12,
    maxFleeAttempts: 3,
    onFleeFailed: "continue" as "continue" | "stop",
    noProgressSteps: 10,
    noProgressTicks: 50,
    maxFailureStreak: 6,
    maxTotalFailures: 20,
};

export function isLowHp(obs: Observation, fraction: number): boolean {
    const { hp, maxHp } = obs.player;
    return maxHp > 0 && hp / maxHp <= fraction;
}

/** Everything the agent can observe that signals "something happened". NPC positions are excluded: wandering cows are not progress. */
export function progressSignature(obs: Observation): string {
    const inv = obs.inventory.map((i) => `${i.id}:${i.quantity}`).sort();
    const ground = obs.nearbyGroundItems.map((g) => `${g.id}@${g.x},${g.z}x${g.quantity}`).sort();
    const c = obs.player.combat;
    return JSON.stringify({
        pos: [obs.player.x, obs.player.z, obs.player.level],
        hp: obs.player.hp,
        inv, ground,
        fighting: isFighting(obs) ? [c?.targetType, c?.targetIndex] : null,
        npcs: obs.nearbyNpcs.length,
        dialog: dialogSignature(obs.dialog),
        ui: [obs.shopOpen, obs.bankOpen, obs.interfaceOpen],
    });
}

// ------------------------------------------------------------------- fleeing

const clamp = (v: number) => Math.max(0, Math.min(LIMITS.maxCoord, Math.round(v)));

/**
 * Walk targets away from whatever could be hurting us, best first. Threats are the NPC we are fighting
 * plus nearby NPCs that offer "Attack". Alternatives rotate the direction so that a blocked path
 * (rejected by validation, which costs no game time) falls through to the next candidate.
 */
export function fleeActions(obs: Observation, cfg: SafetyConfig = {}): ModelAction[] {
    const dist = cfg.fleeDistance ?? SAFETY_DEFAULTS.fleeDistance;
    const out: ModelAction[] = [];
    const seen = new Set<string>();
    const add = (x: number, z: number) => {
        const cx = clamp(x), cz = clamp(z);
        const key = `${cx},${cz}`;
        const far = Math.max(Math.abs(cx - obs.player.x), Math.abs(cz - obs.player.z));
        if (seen.has(key) || far < 3 || far > LIMITS.maxWalkDistance) return;
        seen.add(key);
        out.push({ type: "walk_to", x: cx, z: cz, tolerance: 2 });
    };

    if (cfg.safePoint) add(cfg.safePoint.x, cfg.safePoint.z);

    const target = obs.player.combat?.targetType === "npc" ? obs.player.combat.targetIndex : -1;
    const threats = obs.nearbyNpcs.filter((n) => {
        const near = Math.max(Math.abs(n.x - obs.player.x), Math.abs(n.z - obs.player.z)) <= 8;
        return n.index === target || (near && n.options.some((o) => o.toLowerCase() === "attack"));
    });

    let dx = 1, dz = 0; // no threats known: arbitrary but deterministic
    if (threats.length) {
        const cx = threats.reduce((t, n) => t + n.x, 0) / threats.length;
        const cz = threats.reduce((t, n) => t + n.z, 0) / threats.length;
        const vx = obs.player.x - cx, vz = obs.player.z - cz;
        const len = Math.hypot(vx, vz);
        if (len > 0) { dx = vx / len; dz = vz / len; }
    }
    for (const degrees of [0, 45, -45, 90, -90]) {
        const a = (degrees * Math.PI) / 180;
        const rx = dx * Math.cos(a) - dz * Math.sin(a);
        const rz = dx * Math.sin(a) + dz * Math.cos(a);
        add(obs.player.x + rx * dist, obs.player.z + rz * dist);
    }
    return out;
}

// ------------------------------------------------------------------- monitor

export class SafetyMonitor {
    readonly cfg: typeof SAFETY_DEFAULTS & SafetyConfig;
    /** How many times each rule fired (for the episode log). */
    readonly interventions: Record<string, number> = {};

    private lastSignature: string | null = null;
    private unchangedSteps = 0;
    private unchangedSinceTick = 0;

    private failureStreak = 0;
    private totalFailures = 0;

    private fleeAttempts = 0;
    private fleeGaveUp = false;
    private eatFailures = 0;

    constructor(cfg: SafetyConfig = {}) {
        this.cfg = { ...SAFETY_DEFAULTS, ...cfg };
    }

    /** Call at the start of every step with the freshest observation. */
    check(obs: Observation): SafetyVerdict {
        this.trackProgress(obs);

        const low = isLowHp(obs, this.cfg.lowHpFraction);
        if (!low) {
            this.fleeAttempts = 0;
            this.fleeGaveUp = false;
            this.eatFailures = 0;
        } else {
            const { hp, maxHp } = obs.player;
            const hasFood = obs.inventory.some((i) => i.edible === true);
            const fighting = isFighting(obs);

            if (this.cfg.eat && hasFood && this.eatFailures < 2) {
                return this.act("low_hp_eat", `HP ${hp}/${maxHp}: eating`, [{ type: "eat" }]);
            }
            if (fighting) {
                if (!this.fleeGaveUp) {
                    if (this.fleeAttempts < this.cfg.maxFleeAttempts) {
                        const actions = fleeActions(obs, this.cfg);
                        if (actions.length) {
                            this.fleeAttempts++;
                            return this.act("low_hp_flee", `HP ${hp}/${maxHp}, no food: running (attempt ${this.fleeAttempts}/${this.cfg.maxFleeAttempts})`, actions);
                        }
                    }
                    this.fleeGaveUp = true;
                }
                if (this.cfg.onFleeFailed === "stop") {
                    return { kind: "stop", stopReason: "safety_low_hp", detail: `HP ${hp}/${maxHp}, still fighting and could not get away` };
                }
                // else: fight on; the model keeps control
            } else {
                const why = hasFood ? "eating failed" : "no food";
                return { kind: "stop", stopReason: "safety_low_hp", detail: `HP ${hp}/${maxHp} and not in a fight (${why}): stopping instead of starting another fight` };
            }
        }

        if (this.failureStreak >= this.cfg.maxFailureStreak) {
            return { kind: "stop", stopReason: "too_many_failures", detail: `${this.failureStreak} actions in a row did not confirm success` };
        }
        if (this.totalFailures >= this.cfg.maxTotalFailures) {
            return { kind: "stop", stopReason: "too_many_failures", detail: `${this.totalFailures} actions did not confirm success in this run` };
        }
        if (this.unchangedSteps >= this.cfg.noProgressSteps && obs.tick - this.unchangedSinceTick >= this.cfg.noProgressTicks) {
            return {
                kind: "stop", stopReason: "no_progress",
                detail: `nothing changed for ${this.unchangedSteps} steps (${obs.tick - this.unchangedSinceTick} ticks)`,
            };
        }
        return { kind: "none" };
    }

    /** Result of an action the MODEL chose. */
    noteModelResult(status: Status) {
        if (status === "confirmed_success") {
            this.failureStreak = 0;
        } else {
            this.failureStreak++;
            this.totalFailures++;
        }
    }

    /** Result of an action the safety layer chose. */
    noteSafetyResult(rule: SafetyRule, status: Status) {
        if (rule === "low_hp_eat") this.eatFailures = status === "confirmed_success" ? 0 : this.eatFailures + 1;
    }

    private act(rule: SafetyRule, reason: string, actions: ModelAction[]): SafetyVerdict {
        this.interventions[rule] = (this.interventions[rule] ?? 0) + 1;
        return { kind: "act", rule, reason, actions };
    }

    private trackProgress(obs: Observation) {
        const sig = progressSignature(obs);
        if (sig !== this.lastSignature) {
            this.lastSignature = sig;
            this.unchangedSteps = 0;
            this.unchangedSinceTick = obs.tick;
        } else {
            this.unchangedSteps++;
        }
    }
}

/** Build a config from environment variables; `false` means the layer is switched off. */
export function safetyFromEnv(env: Record<string, string | undefined>): SafetyConfig | false {
    if (env.AGENT_SAFETY === "0") return false;
    const cfg: SafetyConfig = {};
    if (env.AGENT_LOW_HP) cfg.lowHpFraction = Number(env.AGENT_LOW_HP);
    if (env.AGENT_SAFE_POINT) {
        const [x, z] = env.AGENT_SAFE_POINT.split(",").map(Number);
        if (Number.isFinite(x) && Number.isFinite(z)) cfg.safePoint = { x, z };
    }
    if (env.AGENT_ON_FLEE_FAILED === "stop") cfg.onFleeFailed = "stop";
    return cfg;
}
