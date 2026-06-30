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

A full-chain replay (fresh reset → replay 4 hand-recorded segments back-to-back,
**no** checkpoint reloads between them) landed frame-exact on both
navigation/dialogue segments and **diverged on the segment containing the
legendary battle**. The GBA RNG advances every frame, so reaching a point via a
replay-chain leaves RNG in a different phase than when the savestate was
captured; the encounter then resolves differently and inputs desync.

Takeaway:
- **Savestates are the deterministic anchors** — they capture exact RNG state.
- **Replay is reliable only from a loaded checkpoint**, never chained from a
  replayed predecessor.
- **The agent owns RNG events.** Replay can't reproduce them across a chain, so
  the agent plays them live.

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
