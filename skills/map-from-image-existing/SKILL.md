---
name: map-from-image-existing
description: >
  Recreate a location from an image (e.g. a map/screenshot from another game) as a
  walkable pokeemerald map, reusing an EXISTING in-project tileset. Use when the user
  wants to "rebuild this map in pokeemerald", "recreate this town/area from this image",
  "turn this game map into a walkable map", or drops a non-pokeemerald-art image and
  wants to walk around in it. Unlike map-from-image (which generates a new tileset via
  Porytiles), this MATCHES the image to tiles you already have, so it builds into the
  ROM with no C edits.
allowed-tools:
  - Read
  - Bash
  - Agent
  - mcp__porygon__validate_image
  - mcp__porygon__list_tilesets
  - mcp__porygon__list_maps
  - mcp__porygon__image_to_existing_map
  - mcp__porygon__get_connections
  - mcp__porygon__read_blockdata
  - mcp__porygon__get_layout
---

# map-from-image-existing

Pipeline: porygon renders an existing tileset's metatiles back into images, matches each
16x16 cell of the source image to the visually-closest metatile (perceptual Lab distance),
writes the `map.bin` + layout referencing that **existing** tileset, registers a walkable
**map** in `map_groups.json`, and wires a connection so you can walk in and back out. No
Porytiles, no new tileset, no C registration - a normal `make` builds it into the ROM.

This is the deterministic core. Your job is the selection + review the core can't do.

## Workflow

1. **Validate the image**: `validate_image`. Both dimensions must be a multiple of 16px.
   If not, tell the user to crop/pad to a 16px grid (don't silently resize - it smears the
   grid). Remember the source is from another game, so the art will NOT byte-match
   pokeemerald; that's expected - we match by appearance, not exactly.
2. **Pick the asset pack (tileset)**: `list_tilesets` to see what's available, then choose a
   `primary_tileset` whose art covers the source's terrain (a grassy town -> `gTileset_General`
   + a town/route secondary; a cave -> a cave tileset). If unsure, render a preview with the
   `tileset-atlas` CLI (`porygon tileset-atlas gTileset_General /tmp/atlas.png`) and Read it.
3. **Pick the neighbour to link to**: `list_maps` to choose an existing map the new one should
   attach to, and the direction it sits relative to the new map (`link_dir`). This is what
   makes it walkable "back and forth".
4. **Generate**: `image_to_existing_map(image_path, name, primary_tileset=..., secondary_tileset=...,
   link_to="MAP_...", link_dir=...)`. Leave `full_auto` off so collision starts passable for
   human review.
5. **Review the match**: Read the returned `match_preview.png` and compare it to the source by
   eye. Relay the `low_confidence_count` / `low_confidence_cells` - those are cells the matcher
   was unsure about (often terrain the chosen tileset doesn't cover). If many cells are low
   confidence, suggest a different `primary_tileset`/`secondary_tileset` and re-run, or tell the
   user which regions to repaint in Porymap. For collision/structure advice, spawn the
   `map-architect` agent.
6. **Confirm walkability**: the result's `wiring` shows the reciprocal connection added on both
   maps. Tell the user to `make` and walk from the neighbour into the new map and back.

## Why this avoids the ROM-build gap

`map-from-image` generates a new tileset that still needs C registration before it builds.
This skill reuses tilesets that are **already registered**, and registers the map in
`map_groups.json` - from which the build auto-generates the `MAP_<NAME>` constant and map
tables. So nothing in C needs hand-editing; `make` just works.

## Notes
- Matching is perceptual, not semantic: a tile can match on average colour but be the wrong
  thing (a roof matched to grass). The `low_confidence_cells` report and `match_preview.png`
  are how you and the user catch that - always review before trusting it.
- Without `link_to` the map is created but **not reachable**; the result says so. Pass a
  neighbour to wire it.
- `full_auto: true` applies the coarse dark=wall collision heuristic with no review pause -
  lossy; only for throwaway/preview maps.
