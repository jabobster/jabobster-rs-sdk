// Route probe: asks the SDK for the walking path from the bot's current tile to each target, without walking.
// Run it with the bot standing at the start of a leg (the mine for mine->furnace, the furnace for furnace->bank).
//
//   bun --env-file=.\bots\wiseoldguy\.env .\bots\wiseoldguy\agent\probe-routes.ts

import { runScript } from "../../../sdk/runner";

const TARGETS: Record<string, { x: number; z: number }> = {
    "falador furnace": { x: 2975, z: 3368 },
    "falador west bank": { x: 2948, z: 3368 },
    "falador copper rock": { x: 2907, z: 3361 },
    "al kharid furnace": { x: 3273, z: 3184 },
    "al kharid bank": { x: 3269, z: 3167 },
    "al kharid copper rock": { x: 3296, z: 3314 },
};

await runScript(async ({ sdk }) => {
    const here = sdk.getState()?.player;
    console.log(`From (${here?.worldX}, ${here?.worldZ})`);
    for (const [name, t] of Object.entries(TARGETS)) {
        const path = await sdk.sendFindPath(t.x, t.z, 500);
        const straight = here ? Math.round(Math.hypot(t.x - here.worldX, t.z - here.worldZ)) : null;
        console.log(`${name.padEnd(24)} path=${path.success ? path.waypoints.length : "none"} waypoints, reached=${path.reachedDestination ?? false}, straight=${straight}`);
    }
    return "probed";
}, { timeout: 60_000 });
