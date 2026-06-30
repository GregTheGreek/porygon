# pokeemerald project guide (for Claude)

This is a **pokeemerald** decompilation project (pret). The `porygon` toolkit is
installed to augment map editing, scripting, and debugging. Keep a human in the
loop for design decisions; use the deterministic `mcp__porygon__*` tools for the
binary/format work.

## Build

- `make` - build with `agbcc` (requires agbcc cloned/built/installed; see `INSTALL.md`).
- `make modern` - build with `arm-none-eabi-gcc` (devkitARM). Preferred when available.
- `make modern DINFO=1` - include debug symbols (produces `.elf` + symbol info).
- Output: `pokeemerald.gba` (ROM), plus `.map`/`.sym` for symbol resolution.
- Test the ROM in mGBA (`/Applications/mGBA.app`).

## Where things live

- `data/layouts/layouts.json` - layout table: id, name, width, height, tilesets, and paths to `map.bin`/`border.bin`.
- `data/layouts/<Layout>/map.bin` - **binary** blockdata. Each block is 16-bit LE:
  metatile id (bits 0-9), collision (10-11), elevation (12-15). Do **not** hand-edit;
  use `mcp__porygon__read_blockdata` / `write_blockdata`.
- `data/layouts/<Layout>/border.bin` - the map border (emerald: 2x2 blocks = 8 bytes).
- `data/maps/<Map>/map.json` - map metadata + object/warp/coord/bg events (script refs).
- `data/maps/<Map>/scripts.inc` - event scripts (or `scripts.pory` if using Poryscript).
- `data/tilesets/{primary,secondary}/<name>/` - tiles.png, palettes, `metatiles.bin`,
  `metatile_attributes.bin` (emerald: 2 bytes/metatile - behavior bits 0-7, layer 12-15).
- `include/global.fieldmap.h` - the canonical PACK/UNPACK macros for the formats above.
- `asm/macros/event.inc` - the scripting command vocabulary (msgbox, applymovement, setflag, ...).

## Conventions

- Edit C in `src/`, headers in `include/`. Constants live in `include/constants/`.
- After editing data or code, rebuild and verify it compiles before claiming done.
- Prefer Poryscript (`.pory`) for new event scripts where the project uses it.
- For map edits: use `porygon` to read/write `map.bin`, then have the human review in
  Porymap (the toolkit can drive a live preview via Porymap's custom-scripts bridge).

## Diagnosing & fixing bugs

- **Fix at the narrowest scope.** Runtime field bugs (warps, escape rope/dig, movement,
  overworld effects) almost always live in **map data or map scripts**, not the shared
  engine in `src/`. The engine encodes conventions that per-map data must satisfy - so a
  map that misbehaves usually *violates a convention*, it doesn't expose an engine bug.
  Diagnose by asking "which convention does this map break?" Fix in this order: map data
  (collision/warps/events) → a per-map map script → and only edit shared `src/` as a last
  resort (it runs for **every** map).
- **Match vanilla precedent by archetype.** Before choosing a mechanism (which map-script
  hook, which script command, which macro form), grep `data/maps` for existing usages and
  copy the closest map of the **same archetype** (cave, town, harbor, gym, house...). The
  same command is hooked differently by kind - e.g. `setescapewarp` runs from
  `MAP_SCRIPT_ON_RESUME` in caves (CaveOfOrigin_Entrance, SeafloorCavern_Entrance) but from
  `MAP_SCRIPT_ON_TRANSITION` in ferry/cable-car hubs (LilycoveCity_Harbor, SlateportCity_Harbor).
- **Map-script hooks fire at different times - and re-firing hooks need idempotent scripts.**

  | Hook | When it runs |
  |------|------|
  | `ON_LOAD` | when map tile data loads |
  | `ON_TRANSITION` | once, during warp-in, before fade-in |
  | `ON_WARP_INTO_MAP_TABLE` | on warp-in, var-gated (reposition objects) |
  | `ON_FRAME_TABLE` | every frame, var-gated |
  | `ON_RESUME` | on warp-in **and** every return-to-field (menu close, battle end) |

  Scripts on re-firing hooks (`ON_RESUME`, `ON_FRAME_TABLE`) run repeatedly - write them
  **idempotent**: use absolute setters (`setescapewarp MAP, x, y` to a fixed tile), never
  relative mutations (a decrement drifts further on every re-fire). `ON_RESUME` is the
  defensive "keep this state correct" choice; `ON_TRANSITION` is "set once on entry."

## Gotchas

- **Event-script macros are variadic - arg count changes their meaning.** Read the macro in
  `asm/macros/event.inc` to confirm what a given arg count expands to; don't assume positional
  meaning. E.g. `formatwarp`/`setescapewarp` with a trailing coord pair defaults `warpId` to
  `WARP_ID_NONE` (lands on the literal tile); with one arg it's a warpId.
- **`SaveBlock1` state persists across maps and save/reload.** Fields like `escapeWarp`
  (used by Dig and Escape Rope), flags, and vars keep their value until something explicitly
  overwrites them. Reason about lifetime when deciding whether/where state must be (re)set.
- **`validate_scripts` has cross-file blind spots.** It flags `Common_EventScript_*` (defined
  in shared files) as `dangling_label`, and map-header-referenced `*_MapScripts` labels as
  `unused_label` - both are false positives. Trust the **build** as the source of truth for
  linkage, not the validator's findings.

## porygon tools (MCP)

Maps/data: `project_info`, `list_maps`, `list_layouts`, `get_layout`, `read_map`,
`read_blockdata` (set `include_grid=true` for per-tile data), `write_blockdata`,
`read_metatile_attributes`.

Build/debug (use the `debug-loop` skill): `build` (runs `make modern`; override
with `$PORYGON_BUILD_CMD`), `parse_build_log`, `resolve_address` (address ->
function + file:line), `lookup_symbol`, `emu_launch_command`. Note: function
names come from the symbol table, but source `file:line` resolution needs a
`DINFO=1` build (DWARF).

Event scripting (use the `event-scripting` skill): `validate_scripts` (map ↔
scripts.inc labels + constant cross-refs), `read_map_events`, `add_object_event`/
`add_sign`/`add_trigger`/`remove_event`, `scaffold_script`, `list_macros`/
`lookup_macro`, `poryscript_status`/`compile_poryscript`. Scripts are referenced
by bare global label from map.json events; validate before building.
