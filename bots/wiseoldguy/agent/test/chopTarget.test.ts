import { describe, expect, test } from "bun:test";
import { chopBankGoal, parseChopTarget, resolveChopTarget } from "../goals";
import { buildEpisodeRecord } from "../episode";
import { makeObs } from "./helpers";

const withSlots = (used: number) => makeObs({
    inventory: Array.from({ length: used }, (_, i) => ({ id: 2, slot: i, name: "Bronze axe", quantity: 1 })),
});
const bank = (oak: number, open = true) => makeObs({
    bankOpen: open,
    bankItems: open ? [{ id: 1, name: "Oak logs", quantity: oak }] : null,
});

describe("chop target", () => {
    test("parses a number, 'full', or the default", () => {
        expect(parseChopTarget(undefined)).toBe(5);
        expect(parseChopTarget("")).toBe(5);
        expect(parseChopTarget("7")).toBe(7);
        expect(parseChopTarget("Full")).toBe("full");
    });

    test("rejects anything else", () => {
        for (const bad of ["0", "29", "abc", "2.5"]) expect(() => parseChopTarget(bad)).toThrow();
    });

    test("'full' is the free slots at the start: 28 minus the slots already used", () => {
        expect(resolveChopTarget("full", withSlots(3))).toBe(25);
        expect(resolveChopTarget("full", withSlots(28))).toBe(1);   // never 0, the start check refuses a full pack anyway
        expect(resolveChopTarget(9, withSlots(3))).toBe(9);
    });

    test("the goal text and the completion check use the same number", () => {
        const goal = chopBankGoal({ target: 7 });
        expect(goal.goal).toContain("until you carry 7 oak logs");
        expect(goal.verifyDone(bank(0))).toMatchObject({ done: false });
        expect(goal.verifyDone(bank(5))).toMatchObject({ done: false });         // 5 is not enough for a target of 7
        expect(goal.verifyDone(bank(7))).toMatchObject({ done: false, missing: "the bank closed" });
        expect(goal.verifyDone(bank(7, false))).toEqual({ done: true });
    });

    test("the default target is 5", () => {
        const goal = chopBankGoal();
        expect(goal.goal).toContain("until you carry 5 oak logs");
        expect(goal.verifyDone(bank(0))).toMatchObject({ done: false });
        expect(goal.verifyDone(bank(5))).toMatchObject({ done: false, missing: "the bank closed" });
        expect(goal.verifyDone(bank(5, false))).toEqual({ done: true });
    });
});

describe("bank trips", () => {
    test("counts successful bank openings in the episode record", () => {
        const step = (type: string, status: string, n: number) => ({ step: n, action: { type }, status, reason: "", source: "model", ticks: 3 });
        const result = {
            stopReason: "goal_met", detail: undefined, steps: 4,
            history: [
                step("open_bank", "confirmed_success", 1),
                step("open_bank", "unconfirmed", 2),
                step("open_bank", "confirmed_success", 3),
                step("chop_tree", "confirmed_success", 4),
            ],
            baseline: null, finalObservation: null, finalCheck: null,
        } as any;
        const rec = buildEpisodeRecord({ runId: "r", startedAt: new Date(), endedAt: new Date(), task: { goal: "g" }, agent: {}, result });
        expect(rec.counts.bankTrips).toBe(2);
    });
});
