# Execution model: replay spans + agent spans

A playthrough is a sequence of **spans** separated by **savestate checkpoints**.
Each span is one of three types; checkpoints are the seams between them.

```
[script] ─◆─ [replay] ─◆─ [agent: RNG] ─◆─ [replay] ─◆─ ...
```

| Span type | How it runs | Use for |
|---|---|---|
| `script` | a named deterministic routine (e.g. `intro_to_first_move`) | the fixed intro |
| `replay` | load `from` checkpoint, replay a recorded input file frame-accurately | navigation, dialogue, menus (the bulk of the game) |
| `agent`  | load `from` checkpoint, run the observe→act→converge loop | battles, wild encounters, anything RNG-driven |

## Why the split (validated)

Two replay experiments:

1. **Full-chain replay** (fresh reset → replay 4 recorded segments back-to-back,
   no reloads): frame-exact on both navigation/dialogue segments, **diverged on
   the segment containing the legendary battle**.
2. **Battle segment from its own loaded savestate** (`02_after_starter.ss` →
   replay): **also diverged** (ended on a different map entirely). Savestate
   anchoring was NOT enough to reproduce the battle.

Meanwhile the first navigation segment replayed **exactly** from its savestate.
The difference: that segment was recorded right after *loading* its checkpoint
(recording frame-aligned with the savestate), whereas the battle segment was
recorded a few frames after *saving* its checkpoint. For navigation a few frames
of phase error is harmless (position re-converges); for a battle it changes when
the wild encounter triggers and how rolls resolve, and that cascades.

Takeaways:
- **RNG spans don't reliably replay, even from a savestate.** Small phase/timing
  error doesn't re-converge in a battle — it diverges. **The agent must own RNG
  events** and play them live to the target. (This is the core of the model.)
- **Deterministic spans (navigation/dialogue) replay reliably**, and are
  tolerant of minor start misalignment because position/dialogue re-converges.
- **Record deterministic spans frame-aligned with their anchor**: load the
  checkpoint, *then* start recording, *then* play. Saves you from latent phase
  drift. (seg1 did this and was exact; seg3 didn't and wasn't.)
- **Savestates are the seams**, but they are reliable replay *starts* only for
  deterministic spans; for RNG spans they are the agent's *handoff* and *target*
  points, not a guarantee of replay.

## The agent-span contract

Every agent span declares a **target state** — the next checkpoint's known
state (map_group/map_num/coords, plus relevant flags). The agent runs:

```
observe (state + screenshot + battle state) → act → check against target → repeat
```

and is "done" only when the live state matches the target. "Get back on track"
== converge to the next checkpoint, so the following replay span resumes from
solid ground. A flaky battle costs a few extra agent turns, not a derailed run.

On success the runner SAVES the checkpoint, re-anchoring the timeline (fresh
RNG state) for the next span.

## Open pieces to build

1. **`battle` flag in STATE** — the trigger to switch replay→agent. Needs a WRAM
   read (battle-active, e.g. via `gMain`/`gBattleTypeFlags`); address TBD per build.
2. **Battle/RNG state surface** — HP, whose turn, menu cursor, enemy species,
   party — exposed only while `battle == true` (the one extension to the
   otherwise-minimal state).
3. **Recordings that contain RNG should be re-split** at the RNG boundary into
   `replay → agent → replay`. The current `afterstarter_to_sandgem` recording
   bundles the legendary battle inline; it works only when replayed from its own
   savestate, so it is modeled as an `agent` span (recording kept as reference).

See `manifest.example.json` for the span schema and `runner.py` for the loop.
