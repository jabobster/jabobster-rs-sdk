import { describe, expect, test } from "bun:test";
import { banks, nearestBank, DEFAULT_BANK } from "../places";
import placesData from "../data/places.json";
import { fletchBankGoal, chopBankGoal } from "../goals";

describe("banks", () => {
    test("every bank in places.json is used, including Al Kharid (long way round the toll gate) and East Falador", () => {
        const names = banks().map((b) => b.id);
        expect(names).toContain("varrock-west-bank");
        expect(names).toContain("draynor-bank");
        expect(names).toContain("al-kharid-bank");
        expect(names).toContain("falador-east-bank");
        expect(names).toContain("varrock-east-bank");
        expect(names).toContain("ardougne-west-bank");
        expect(names).toContain("ardougne-east-bank");
    });

    test("each bank centre lies inside its game bank zone", () => {
        for (const id of ["varrock-east-bank", "ardougne-west-bank", "ardougne-east-bank", "falador-east-bank"]) {
            const b = placesData.places[id as keyof typeof placesData.places] as { x: number; z: number; zone: number[] };
            expect(b.x >= b.zone[0] && b.x <= b.zone[2] && b.z >= b.zone[1] && b.z <= b.zone[3]).toBe(true);
        }
    });

    test("names are readable for goal text", () => {
        expect(banks().find((b) => b.id === "varrock-west-bank")?.name).toBe("Varrock west bank");
    });
});

describe("nearestBank", () => {
    test("picks the bank closest to the position", () => {
        expect(nearestBank({ x: 3100, z: 3240 })?.id).toBe("draynor-bank");   // Draynor Village
        expect(nearestBank({ x: 3190, z: 3440 })?.id).toBe("varrock-west-bank");
        expect(nearestBank({ x: 2720, z: 3480 })?.id).toBe("seers-bank");
    });

    test("returns the Al Kharid bank when standing next to it", () => {
        expect(nearestBank({ x: 3270, z: 3160 })?.id).toBe("al-kharid-bank");
    });

    test("returns null for an empty list", () => {
        expect(nearestBank({ x: 0, z: 0 }, [])).toBeNull();
    });
});

describe("goal text uses the bank passed in", () => {
    test("fletch goal names the bank and its coordinates; default is Varrock west", () => {
        const edge = banks().find((b) => b.id === "edgeville-bank")!;
        expect(fletchBankGoal({ logCount: 10, bank: edge }).goal).toContain("Walk to the Edgeville bank at x 3095 z 3495");
        expect(fletchBankGoal({ logCount: 10 }).goal).toContain(`Walk to the ${DEFAULT_BANK.name} at x 3185 z 3436`);
    });

    test("chop goal names the bank too", () => {
        const draynor = banks().find((b) => b.id === "draynor-bank")!;
        expect(chopBankGoal({ target: 5, bank: draynor }).goal).toContain("walk to the Draynor bank at x 3092 z 3243");
    });
});
