// Places the bot walks to. Data: agent/data/places.json (bank centres from the game's bank_zones file in rs-sdk).
// Only banks are used here. A bank with an area (Al Kharid, behind the toll gate) is included: the walk goes the
// long way round the gate, so it depends on the game's pathing (to be checked live).

import placesData from "./data/places.json";

export interface Bank {
    /** Key in places.json, e.g. "varrock-west-bank". */
    id: string;
    /** Name for goal text, e.g. "Varrock west bank". */
    name: string;
    x: number;
    z: number;
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Banks the bot may walk to: every entry with kind "bank". */
export function banks(data: { places: Record<string, { x: number; z: number; kind: string; area?: string }> } = placesData): Bank[] {
    return Object.entries(data.places)
        .filter(([, p]) => p.kind === "bank")
        .map(([id, p]) => ({ id, name: capitalize(id.replace(/-/g, " ")), x: p.x, z: p.z }));
}

/** The bank closest to a position (straight-line distance on the ground). Null when the list is empty. */
export function nearestBank(pos: { x: number; z: number }, list: Bank[] = banks()): Bank | null {
    let best: Bank | null = null;
    let bestD = Infinity;
    for (const b of list) {
        const d = (b.x - pos.x) ** 2 + (b.z - pos.z) ** 2;
        if (d < bestD) {
            best = b;
            bestD = d;
        }
    }
    return best;
}

/** Varrock west: the bank the fixed routines and the first model tasks were built around. */
export const DEFAULT_BANK: Bank = { id: "varrock-west-bank", name: "Varrock west bank", x: 3185, z: 3436 };
