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
