# wiseoldguy agent (Phase 2)

A small local model picks ONE action per turn; this code validates it, runs it through the SDK,
and verifies what actually happened. All commands run from the rs-sdk project root.

## Run

| What | Command |
|---|---|
| Unit + regression tests (no game, no model) | `bun test bots/wiseoldguy/agent` |
| Single manual action | `bun --env-file=.\bots\wiseoldguy\.env .\bots\wiseoldguy\phase1-action-interface.ts` |
| Deterministic policy, live game | `bun --env-file=.\bots\wiseoldguy\.env .\bots\wiseoldguy\agent\run-fixed.ts` |
| Local model, live game | `bun --env-file=.\bots\wiseoldguy\.env .\bots\wiseoldguy\agent\run-model.ts` |
| Score a model on the eval cases (LM Studio only) | `bun .\bots\wiseoldguy\agent\run-evals.ts` |
| Replay old logs through current code | `bun .\bots\wiseoldguy\agent\replay-logs.ts <diagnostics.jsonl> [--all]` |
| Compare eval result files side by side | `bun .\bots\wiseoldguy\agent\compare-evals.ts [files...] [--split dev]` |
| Summarize decision logs | `bun .\bots\wiseoldguy\agent\summarize-logs.ts <decisions.jsonl>` |
| Model chops and banks oak logs (`AGENT_TASK=chop-bank`) | `bun --env-file=.\bots\wiseoldguy\.env .\bots\wiseoldguy\agent\run-model.ts` (set `$env:AGENT_TASK="chop-bank"` first) |
| Chop 5 oak logs and bank them (fixed routine, live) | `bun --env-file=.\bots\wiseoldguy\.env .\bots\wiseoldguy\agent\run-chop-bank.ts` |

LM Studio settings (environment variables): `LMSTUDIO_URL`, `LMSTUDIO_MODEL`, `LMSTUDIO_API_KEY`,
`AGENT_THINK=1` (thinking is off by default for Qwen), `AGENT_WHY=1`, `AGENT_GOAL_VERSION=1|2`.
Eval-only: `AGENT_EVAL_RUNS`, `AGENT_EVAL_TEMP`, `AGENT_EVAL_CASE`, `AGENT_EVAL_SPLIT=dev|frozen`, `AGENT_EVAL_MIN`, `AGENT_EVAL_OUT`.
Safety layer (live runs): `AGENT_SAFETY=0` (off), `AGENT_LOW_HP` (default `0.2`), `AGENT_SAFE_POINT=x,z`,
`AGENT_ON_FLEE_FAILED=stop`.

PowerShell: set a variable for one session with `$env:AGENT_GOAL_VERSION = "1"`, remove it with
`Remove-Item Env:AGENT_GOAL_VERSION`. Compare both wordings, 5 samples each:

```powershell
foreach ($v in "1","2") { $env:AGENT_GOAL_VERSION=$v; $env:AGENT_EVAL_RUNS="5"; $env:AGENT_EVAL_TEMP="0.4"; bun .\bots\wiseoldguy\agent\run-evals.ts }
bun .\bots\wiseoldguy\agent\compare-evals.ts
```

## Capabilities (step 4)

`capabilities.ts` is the registry of what the SDK can do, with the state evidence that proves each
action worked. Nothing there calls the game yet. Each capability has preconditions (checked before the
call) and a completion check (run on the observations before and after). The completion check never
uses the call's return value or movement alone.

Built: woodcutting, firemaking, mining, fletching, open_shop, buy, sell, open_bank, deposit, withdraw,
close_bank. Provisional: cooking, agility_obstacle (no obstacle is verified, so `KNOWN_OBSTACLES` is
empty and every call is blocked), smelt.

Results: `confirmed_success`, `partial` (some of the requested quantity arrived), or `unconfirmed`.
An unobserved list (bank closed, skill XP missing from an older log) is always `unconfirmed`, never zero.

Observations gained `bankItems`, `shopItems`, `shopTitle` and `skillXp` (schema v6). They are null when
not observed, so older logs still replay.

## Tasks and start checks

A task (`TaskSpec`, `goals.ts`) bundles the goal text, the allowed actions, the game-side completion
check (`verifyDone`) and a start-state check (`startCheck`). The start check runs once, before the first
action. If it finds a problem, the run ends with `start_check_failed` before anything is sent to the game,
and its episode record has `valid: false`. Such runs should not be counted in comparisons.

The cow task blocks a start when: a dialog, shop, bank or interface is open; already fighting; HP is at
or below 20%; no Cow is nearby; every Cow is already in combat; or the inventory is full. Carried
Cowhide or Bones only produce a warning, because the test account holds stray loot. They are recorded so
results can be read in context, and the completion check counts only new items.

**Start from the same inventory for every run you plan to compare.** Runs share one game account, so each
run starts from what the last one left behind (the Cowhide and Bones from a fixed run were carried into
the next two model runs). Before a comparison batch, drop any Cowhide and Bones by hand. Each runner prints
`Start inventory:` so mismatched starts are visible, and `episode.jsonl` records `start.inventory`.

A rejected "done" is logged as `not_executed` with reason `goal_not_met`, in both `decisions.jsonl` and
`diagnostics.jsonl`. It is never logged as `confirmed_success`. The next prompt names the missing item and,
when it lies on the ground within reach, its handle (for example `g1`).

## What the model is shown (view filters)

The model sees a compact list of NPCs and ground items. `view.ts` filters that list before handles are
assigned. Hidden entries stay in the observation, the logs and the checks; only the prompt and the handles
change.

- **Global (always on, `GLOBAL_VIEW_FILTER`):** hide NPCs with no options, and anything the player cannot
  reach right now. Validation would reject those anyway ("unreachable"), and a real run attacked an
  unreachable Duck because Ducks took the handle slots in front of the Cows.
- **Task (`TaskSpec.viewFilter`, ANDed with the global one):** the cow task shows only Cows and
  Cowhide/Bones. Players are not filtered yet, because the observation does not include them.
- **Always kept, whatever the filter:** the NPC the player is fighting, and any NPC already in combat (so a
  monster hitting the player is never hidden).
- `hidden: {npcs, items}` in the view records how many entries were filtered out.
- A/B: `AGENT_VIEW_GLOBAL=0` turns the global filter off for a run.

## Safety layer

Runs before every model call and may take the turn away from the model (`safety.ts`, on by default).
Everything it does goes through the normal validate / execute / classify / log path.

| Situation | What happens |
|---|---|
| HP at or below 20% of max, food in the pack | `eat` (also when the goal does not allow eating) |
| Low HP, no food, **in a fight** | run: `walk_to` about 12 tiles away from nearby enemies (a configured `safePoint` first). After 3 flee attempts that did not end the fight it fights on (or stops, with `onFleeFailed: "stop"`) |
| Low HP, no food, **not in a fight** (e.g. just killed the monster) | stop with `safety_low_hp`; it never starts another fight |
| Nothing observable changed for 10 steps and 50 ticks | stop with `no_progress` |
| 6 model actions in a row (or 20 in total) did not confirm success | stop with `too_many_failures` |

Overrides are marked everywhere: a `kind: "safety"` line in `decisions.jsonl`, `source: "safety"` and
`safetyRule` in `diagnostics.jsonl`, `[auto]` in the result lines the model sees, `source: "safety"` in
the step history, and `safetyInterventions` in the episode record. Tune per run through
`ControllerConfig.safety` (`false` turns it off) or the environment variables above.

Not covered yet: run energy, praying, choosing a smarter safe spot than "away from enemies", and
starting a fight at low HP when a routine decides to (the layer only stops at low HP; it does not heal up).

## Logs

Each live runner appends to one folder (`logs/phase2-model`, `logs/phase2-fixed`, or `AGENT_LOG_DIR`). Every
line carries the run's `runId`, which is how runs are told apart. Which files to read:

- **Comparing runs:** `episode.jsonl` only (one line per run; `valid`, `stopReason`, `goalMet`, `counts`).
- **Why the model did something:** add `decisions.jsonl` (one line per model reply).
- **Debugging a run or building a replay fixture:** add `diagnostics.jsonl`. It is the largest file (about
  550 KB for a 19-step run), so set `AGENT_DIAGNOSTICS=0` for routine batches.

Stop reasons: `goal_met` means the game-side check passed, so the run ended without waiting for the model to
say "done". `model_done` means the model said "done" and the check agreed.

Each live run writes three JSONL files. `decisions` and `diagnostics` lines carry the
run's `runId`, so a run can be joined across all three.

- `episode.jsonl`: ONE line per run: task, model and its settings, start and end state, stop reason,
  whether the goal's own check passes on the final state (`goalMet`), step counts by action and
  status, safety interventions.
- `decisions.jsonl`: one line per model reply (raw text, parse result, status, latency, tokens).
  `kind: "goal_check"` marks a "done" the game refused; `kind: "safety"` marks a safety override.
- `diagnostics.jsonl`: one line per action attempt. Schema v5 records `step`, the exact `view` and
  `handles` the model saw, `allowed`, `source` (`model` or `safety`) and `safetyRule`, plus full
  before/after observations, so the line can be replayed and also reused as a
  (state, action, verified outcome) example. Older versions still replay.

Eval runs write one result file each (`logs/evals`), named with every setting that changes results
(`qwen3.5-4b-v2-t0.4-r5-nothink-<time>.json`) and recording them inside. Cases carry a `split`:
`dev` (tuned against) or `frozen` (written once, never tuned against, to catch overfitting).
`compare-evals.ts` prints all files as one table; `NEVER` in the last column means no run in any file
passed that case, which points at a systematic problem rather than noise. Files written before
version 2 do not know their thinking/temperature settings and are labelled `think?` / `t?`.

## Time is measured in game ticks

Anything that measures time in a run is in game ticks (600 ms each), so results are the same on a fast local
server and on the live one, and tick costs can be compared between actions later:

- **Run budget:** `maxTicks` in the controller (3000 for the model run, 1500 for the fixed run). The run stops
  with `tick_budget` once the game has advanced that far from the first observation.
- **Per step:** `ticks` on each step record (`tickAfter - tickBefore`). The episode record has `ticks` for the
  whole run and `counts.ticksByAction` for the total per action type.
- **Settling:** the routine waits by `sdk.waitForTicks(1)` and re-reads state, up to a tick limit. It never
  waits on the clock.
- **Wall-clock only in two places, neither is game time:** `durationMs` in the episode (labelled as wall-clock,
  varies with server speed), `latencyMs` on model replies (model time). Hang guards (`HANG_GUARD_MS`, 120 s)
  only stop an SDK call that never returns; a working action is never judged by them.

## Local server

The code runs against any bot. `run-model.ts`, `run-fixed.ts` and `run-chop-bank.ts` read the server address
from the `--env-file` you pass, so the local test server needs no code change:

- Use another bot's env file: `bun --env-file=.\bots\localman1\.env .\bots\wiseoldguy\agent\run-model.ts`.
  The code stays in `bots/wiseoldguy/agent`; nothing is copied into `localman1`.
- Keep logs per bot with `AGENT_LOG_DIR` (for example `$env:AGENT_LOG_DIR="logs\localman1"`), so runs don't mix.
- The local `.env` sets `SERVER=localhost:8888` and `GATEWAY_URL=ws://localhost:7780`.
- Local runs are the default for testing (the game speed is set on the server, roughly 10x). Live runs are for
  final checks only. Model behaviour does not depend on the server speed, because nothing is judged by the clock.

## Chop -> bank routine (step 5a)

`chopBank.ts` is a fixed routine (no model) that chops 5 oak logs at the Varrock oak spot and banks them.
It runs through the capability registry: each step checks its preconditions, makes one SDK call, waits for
the state to change (up to 30 game ticks for a chop, 15 for a bank step), then the capability's completion
check decides. The SDK's return value is logged but never used as proof, so a call that reports a timeout
still counts when the logs arrive.

- Live: `bun --env-file=.\bots\wiseoldguy\.env .\bots\wiseoldguy\agent\run-chop-bank.ts` (logs in `logs/chop-bank`)
- Tests: `test/chopBank.test.ts` runs the routine against a fake game (happy path, chops that never gain logs,
  bank that does not open, deposit that moves nothing, blocked start, dialog open).

Stop reasons: `goal_met`, `start_blocked` (no axe, or Woodcutting below 15), `chop_blocked`,
`chop_unconfirmed` (3 chops in a row with no log gained), `open_bank_failed`, `deposit_failed`,
`close_bank_failed`, `error`. Each step writes a `routine_step` line to `decisions.jsonl`, and the run ends
with a `routine_end` line in `episode.jsonl`.

Locations (5b): the observation carries `locs`, the oak trees and bank booths from `sdk.getNearbyLocs()`
(a snapshot, so the routine scans first with `scanNearbyLocs`). The routine stops with `no_oak_in_view`
when no oak is in the snapshot, and logs the closest booth before `openBank()` (`booth_check`), so a failed
open shows how far away the booth was. The oak spot is (3166,3416), the oak cluster west and south of
Varrock west bank.

Walking to the bank (live log 19fe): from the oak spot the booth is about 27 tiles away, outside the 15-tile
scan, and `openBank()` answered `no_bank_found`. So the routine walks to the Varrock west bank booth
(3185,3436) first, scans again, and stops with `no_bank_in_view` if no booth shows up.

Each `routine_step` records `ticks` (the game ticks the step took) and `routine_end` records the total.

## Model run: chop and bank (step 5c)

`AGENT_TASK=chop-bank` runs the model on the chop-and-bank task instead of the cow task. The model picks
one step per turn from `chop_tree`, `walk_to`, `open_bank`, `withdraw_logs`, `deposit_items`, `fletch`, `close_bank`, `wait`, `stop`.
Each step is validated, run through the same SDK helper the routine uses, and judged by the same capability
check. `chop_tree`, `fletch` and the bank steps have no handles: the SDK finds the tree, booth and banker itself.

- Command (PowerShell): `$env:AGENT_TASK="chop-bank"; bun --env-file=.\bots\wiseoldguy\.env .\bots\wiseoldguy\agent\run-model.ts`
- Target: `$env:AGENT_CHOP_TARGET="7"` for seven logs, or `"full"` for every free inventory slot at the start
  (28 minus the slots in use). The goal text and the completion check read the same resolved number.
- The goal says to keep chopping until the target is carried, and only then walk to the bank.
- Episode `counts.bankTrips` counts successful bank openings. `ticksByAction` gives game ticks per action type.
- The goal text gives the coordinates: the oak trees around x 3166 z 3416 and the bank at x 3185 z 3436.
  `walk_to` is the only movement, so the model has to use those coordinates itself.
- The game-side check passes only after 5 oak logs have reached the open bank and the bank is closed. The bank
  contents are visible only while it is open, so the check remembers the count it saw.
- Start check: the run is refused when oak logs are already in the pack (they would be deposited and counted),
  when the pack is full, or when a dialog, shop, bank or interface is open. Deposit the logs by hand first.

Not run live yet. The model has to order five chops, one walk, and the bank steps correctly; the first live
runs will show where it gets stuck.

## Bank -> fletch -> bank routine (step 6a)

`fletchBank.ts` is a fixed routine (no model): it takes oak logs from the Varrock west bank, fletches them into
unstrung bows with a knife, and banks the bows. It uses the same capability registry and tick-based settling as
the chop routine. The chop -> fletch -> bank chain was left for later: it adds a third location and a new step
together, so this part is checked on its own first.

- Live: `bun --env-file=.\bots\wiseoldguy\.env .\bots\wiseoldguy\agent\run-fletch-bank.ts` (logs in `logs/fletch-bank`).
- Needs: a knife in the pack, Fletching 20 or higher, and oak logs in the bank. Carried logs or a full pack stop the run.
- Product: a longbow at Fletching 25 or higher, otherwise a shortbow at 20 or higher (`chooseProduct`).
  **Unverified:** the product labels (`Oak shortbow (u)`, `Oak longbow (u)`) and both level requirements. The
  first live run will show whether the labels match; a mismatch appears as `xp_without_product` in the fletch step.
- Amount: the target (default 10), capped by the logs in the bank and the free slots.
- Stop reasons: `goal_met`, `start_blocked`, `no_bank_in_view`, `open_bank_failed`, `no_logs_in_bank`,
  `withdraw_failed`, `close_bank_failed`, `fletch_blocked`, `fletch_unconfirmed`, `deposit_failed`, `error`.
- Tests: `test/fletchBank.test.ts` runs the routine against a fake game (14 cases).

## Repeat block

Applies to every task, not just one. After an action fails twice in a row and the game state does not change
(position, inventory, combat, open windows), the same action is refused on the next turn with the SDK's
message quoted, for example `chop_tree failed twice with "No tree found" and nothing changed. Choose a
different action.` The refusal is logged as `not_executed` / `repeat_blocked` and never reaches the game.

- The block clears as soon as the action succeeds or the state changes.
- The prompt and the allowed-action schema stay the same, so the server's prompt cache is not invalidated.
- The old repeat guard still ends the run when a repeated action keeps failing while the state changes.
  A run that ignores the block ends with `invalid_streak` instead, because refused replies count as invalid.

## Regression workflow

1. **Changed classify / validate / view?** Run `bun test bots/wiseoldguy/agent`. The replay test
   re-runs every logged record in `test/fixtures` through the new code. A changed outcome fails
   unless it is listed in `KNOWN_CHANGES` (`test/replay.test.ts`) with a reason. Add an entry only
   after deciding the new behavior is right.
2. **New live failure?** Copy its `diagnostics.jsonl` and `decisions.jsonl` into `test/fixtures`,
   pin it in `test/regressions.test.ts`, and, if it is a model mistake, add a case to
   `evalCases.ts` (with good/bad examples; `test/evals.test.ts` checks them offline).
3. **Changed the prompt or swapped the model?** Run `run-evals.ts` before and after and compare
   pass rates. Use `AGENT_EVAL_RUNS=5 AGENT_EVAL_TEMP=0.4` to see how stable a model is.

Old diagnostics (schema v3, no recorded view) replay their classification but skip validation
checks for rejected actions, because the handle mapping cannot be rebuilt faithfully.
