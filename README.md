<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)"  srcset="assets/porygon-lockup-dark.png">
    <source media="(prefers-color-scheme: light)" srcset="assets/porygon-lockup-light.png">
    <img alt="Porygon" src="assets/porygon-lockup-light.png" width="320">
  </picture>
</p>

porygon is an **AI-first** toolkit for pokeemerald decomp ROM hacking. Describe the
bug, the event, or the map connection you want, and let your agent do the fiddly
decomp work - binary map I/O, build and crash debugging, event scripts, warps and
connections - with byte-exact tooling underneath and you reviewing every change.
It's **MCP-native**, so it works with any compatible agent, and ships a first-class
Claude Code plugin. Not an autonomous game builder - you stay in the loop.

The value is in the things an LLM can't do reliably by hand:

- **Binary blockdata I/O** - `map.bin` / `border.bin` / `metatile_attributes.bin`
  are packed 16-bit formats. porygon reads and writes them exactly (byte-identical
  round-trip, verified against the full upstream layout set).
- **Build / debug loop** - build (stock `make` / `make modern`), parse compiler
  errors to `file:line`, resolve crash addresses via `.sym`/`.map`, capture mGBA logs.
- **Event scripting** - generate/validate Poryscript and wire it into map events.
- **Map wiring** - warps, edge connections, signs, and map properties as
  minimal-diff `map.json` edits with round-trip tests.
- **Live Porymap bridge** - JavaScript scripts (via Porymap's custom-scripts API)
  so AI-generated blockdata/collision shows up in the editor for review.

## Layout

```
.claude-plugin/   plugin + marketplace manifests
mcp/              Python MCP server + CLI over a pure-core library (uv)
skills/           workflow skills (debug-loop, event-scripting)
agents/           build-doctor, script-doctor
commands/         /em-build, /em-debug, /em-script
porymap-scripts/  JS bridge loaded via Porymap Options -> Custom Scripts
playtester/       experimental: drive mGBA from an agent over a Lua socket bridge
templates/        CLAUDE.md to drop into a pokeemerald checkout
```

## Capabilities

- **Build & debug** - toolchain-agnostic `build` (stock `make` / `make modern`),
  compiler-error parsing to `file:line`, and symbol/crash-address resolution
  (function names from the symbol table; source `file:line` via DWARF when built
  with `DINFO=1`), plus a thin mGBA launch/GDB helper. Driven by the `debug-loop`
  skill and `build-doctor` agent.
- **Event scripting** - `map.json` ↔ `scripts.inc` cross-ref validation (dangling
  labels, undefined constants), structured event editing (add/remove NPCs, signs,
  triggers), `.inc` scaffolding, macro-vocabulary lookup, and optional Poryscript
  compile when it's available. Adapts to hand-written `.inc` or Poryscript.
  `event-scripting` skill + `script-doctor` agent.
- **Map wiring** - the navigation plumbing that ties maps together: `add_warp`
  (doors/exits, validating the destination map exists and `dest_warp_id` indexes a
  real warp), `get_connections` / `edit_connection` (stitch N/S/E/W/dive/emerge
  neighbours, with offset and dest-map validation), `set_map_properties` (weather,
  music, map_type, battle_scene, flags - rejecting unknown/structural keys), and
  `add_bg_event` (signs, hidden items, secret-base entrances; fork-custom types
  pass through). All minimal-diff `map.json` edits with round-trip tests.

Works with stock pokeemerald and pokeemerald-expansion forks (e.g. platinum).

## Quickstart

```bash
cd mcp && uv sync
# Then either:
#   - register the MCP server with your agent (command: `uv run python -m porygon.server`), or
#   - install the Claude Code plugin (.claude-plugin/) for the turnkey experience.
# From a pokeemerald checkout, the CLI works standalone too:
uv run porygon info
```

This is an unofficial community tool; it is not affiliated with or endorsed by
pret or the Porymap project.
