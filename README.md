<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)"  srcset="assets/porygon-lockup-dark.png">
    <source media="(prefers-color-scheme: light)" srcset="assets/porygon-lockup-light.png">
    <img alt="Porygon" src="assets/porygon-lockup-light.png" width="320">
  </picture>
</p>

Tooling for **AI-augmented** pokeemerald decomp ROM hacking. It makes Claude a
capable copilot for the workflows that matter - **debugging**, **creating maps
from images**, and **writing event scripts** - while keeping a human in the
loop. It is not an autonomous game builder.

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
- **Phase 2 (event scripting)** - map.json ↔ scripts.inc cross-ref validation (dangling labels, undefined constants), structured event editing (add/remove NPCs/signs/triggers), `.inc` scaffolding, macro-vocabulary lookup, and detected-optional Poryscript compile. Adaptive to hand-written `.inc` or Poryscript. `event-scripting` skill + `script-doctor` agent.
- **Phase 3 (maps from images)** - `image_to_map`: porygon dedups 16×16 cells → metatiles + placement, **Porytiles** compiles the tileset, and a new tileset + layout are written, reviewable in Porymap (with a collision-overlay bridge script). Heuristic collision the human confirms; fork-aware (8 vs 12 tiles/metatile). `map-from-image` skill + `map-architect` agent. Needs `brew install grunt-lucas/porytiles`. Note: viewable in Porymap immediately; building into the ROM needs the new tileset registered in C (not automated).

That completes the three workflows the toolkit set out to augment: **debug, scripting, maps**.

## Quickstart

```bash
cd mcp && uv sync
# point Claude Code at the plugin, then from a pokeemerald checkout:
uv run porygon info
```

This is an unofficial community tool; it is not affiliated with or endorsed by
pret or the Porymap project.
