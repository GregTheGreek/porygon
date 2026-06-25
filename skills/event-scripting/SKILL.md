---
name: event-scripting
description: >
  Add or edit pokeemerald event scripts (NPCs, signs, triggers) and validate
  them. Use when the user wants to "add an NPC/sign/trigger", "make a sign say
  X", "give an item when...", "wire a script to this event", or asks to check /
  fix a map's scripts. Adaptive: works with hand-written .inc (what these repos
  use) and with Poryscript if a project has it. Augments - Claude writes the
  logic; porygon handles wiring + validation. Human approves.
allowed-tools:
  - Read
  - Edit
  - Grep
  - Glob
  - Agent
  - mcp__porygon__read_map
  - mcp__porygon__read_map_events
  - mcp__porygon__validate_scripts
  - mcp__porygon__list_macros
  - mcp__porygon__lookup_macro
  - mcp__porygon__add_object_event
  - mcp__porygon__add_sign
  - mcp__porygon__add_trigger
  - mcp__porygon__remove_event
  - mcp__porygon__scaffold_script
  - mcp__porygon__poryscript_status
  - mcp__porygon__compile_poryscript
---

# event-scripting

Scripts live in each map's `scripts.inc` as `Label::` (global) labels; map events
(`object_events`/`bg_events`/`coord_events`) reference them by **bare label name**.
A typo'd label silently breaks the event; an undefined `FLAG_/VAR_/ITEM_` fails
the build. porygon owns the wiring + validation; you write the script logic.

## Check first

At the start, call `mcp__porygon__poryscript_status`. If `project_uses_poryscript`
is true and a binary is available, author/compile `.pory` (use `compile_poryscript`).
Otherwise work with hand-written `.inc` (the default for these repos).

## Adding a scripted event (NPC / sign / trigger)

1. **Write the script** into the map's `scripts.inc`:
   - For boilerplate, call `mcp__porygon__scaffold_script` (kind `sign` or `npc`)
     to drop a correct skeleton + a wired label, then **refine the logic** with
     Edit (dialogue, conditionals, item gives). Use `mcp__porygon__lookup_macro`
     to get real argument signatures (e.g. `msgbox(text, type=MSGBOX_DEFAULT)`,
     `applymovement(localId, movements, map?)`) instead of guessing.
   - Use only constants that exist (the validator checks this).
2. **Wire it into the map**: `add_sign` (bg_event), `add_object_event` (NPC), or
   `add_trigger` (coord_event), with the `script` field set to your label. These
   validate required fields. (Read the schema via `read_map_events` first.)
3. **Validate**: `mcp__porygon__validate_scripts <map>` - confirm zero errors
   (dangling labels, unknown constants). Fix anything it flags.
4. **Build** (debug-loop skill / `build` tool) to confirm it compiles.

## Auditing / fixing existing scripts

Run `validate_scripts` on a map. For a non-trivial report (multiple dangling
labels or unknown constants), spawn the `script-doctor` agent to explain and
propose fixes. Apply with the user's approval, then re-validate.

## Notes

- `0x0` is a valid "no script" sentinel - not a dangling label.
- Unused-label warnings are informational (a label may be reached via cross-map
  `goto`/`call`, which this map-scoped check doesn't track).
- Expansion forks (e.g. platinum) add macros; `list_macros`/`lookup_macro` read
  the project's own `asm/macros`, so they're always correct for that repo.
