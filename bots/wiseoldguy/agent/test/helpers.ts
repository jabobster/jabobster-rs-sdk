import type { Observation } from "../contract";

/** A minimal valid observation; override only what a test cares about. */
export function makeObs(over: Partial<Observation> = {}): Observation {
    return {
        tick: 100,
        inGame: true,
        player: {
            name: "Tester", x: 3200, z: 3200, level: 0, hp: 10, maxHp: 10, isDead: false,
            combat: { inCombat: false, targetIndex: -1, targetType: "none" },
        },
        inventory: [],
        nearbyNpcs: [],
        nearbyGroundItems: [],
        dialog: { isOpen: false, isWaiting: false, pageId: null, text: "", options: [] },
        interfaceOpen: false,
        shopOpen: false,
        bankOpen: false,
        opRejectedCount: 0,
        ...over,
    };
}

export const npc = (index: number, name: string, over: Record<string, unknown> = {}) => ({
    index, id: 100 + index, name, x: 3203, z: 3200, distance: 3, reachable: true as boolean | null,
    inCombat: false as boolean | null, options: ["Attack"], ...over,
});

export const ground = (id: number, name: string, over: Record<string, unknown> = {}) => ({
    id, name, x: 3202, z: 3200, distance: 2, quantity: 1, reachable: true as boolean | null, ...over,
});
