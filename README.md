# Porygon

Gold-standard tooling for **AI-augmented** pokeemerald decomp ROM hacking. It
makes Claude a strong copilot for the workflows that matter - **debugging**,
**creating maps from images**, and **writing event scripts** - while keeping a
human in the loop. It is not an autonomous game builder.

The value is in the things an LLM can't do reliably by hand:

- **Binary blockdata I/O** - `map.bin` / `border.bin` / `metatile_attributes.bin`
  are packed 16-bit formats. porygon reads and writes them exactly (byte-identical
  round-trip, verified against the full upstream layout set).
- **Image -> map** (phased) - palette quantization, tile dedup, metatile assembly,
  collision suggestions; human reviews in Porymap.
- **Build / debug loop** - build (stock `make` / `make modern`), parse compiler
  errors to `file:line`, resolve crash addresses via `.sym`/`.map`, capture mGBA logs.
- **Event scripting** - generate/validate Poryscript and wire it into map events.
- **Live Porymap bridge** - JavaScript scripts (via Porymap's custom-scripts API)
  so AI-generated blockdata/collision shows up in the editor for review.

## Layout

```
.claude-plugin/   plugin + marketplace manifests
mcp/              Python MCP server + CLI over a pure-core library (uv)
skills/           workflow skills (debug-loop, event-scripting, map-from-image)
agents/           build-doctor, map-architect
commands/         /em-build, /em-debug, /em-map, /em-script
porymap-scripts/  JS bridge loaded via Porymap Options -> Custom Scripts
templates/        CLAUDE.md to drop into a pokeemerald checkout
```

## Status

- **Phase 0 (foundation)** - binary codecs, project parsing, MCP server + CLI, byte-identical round-trip tests.
- **Phase 1 (build/debug loop)** - toolchain-agnostic `build`, compiler-error parsing, and symbol/crash-address resolution (function names from the symbol table; source `file:line` via DWARF when built with `DINFO=1`), plus a thin mGBA launch/GDB helper. `debug-loop` skill + `build-doctor` agent.

Scripting (Phase 2) and image-to-map (Phases 3-4) follow (see the plan).

## Quickstart

```bash
cd mcp && uv sync
# point Claude Code at the plugin, then from a pokeemerald checkout:
uv run porygon info
```

This is an unofficial community tool; it is not affiliated with or endorsed by
pret or the Porymap project.
