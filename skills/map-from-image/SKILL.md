---
name: map-from-image
description: >
  Turn an image into a pokeemerald tileset + map layout, reviewable in Porymap.
  Use when the user wants to "make a map from this image/PNG", "turn this picture
  into a map", "generate a tileset from an image", or drops an image and asks for
  a map. Augments - porygon builds the tileset+layout; the human reviews collision
  in Porymap and decides whether to wire it into the ROM.
allowed-tools:
  - Read
  - Bash
  - Agent
  - mcp__porygon__porytiles_status
  - mcp__porygon__validate_image
  - mcp__porygon__image_to_map
  - mcp__porygon__read_blockdata
  - mcp__porygon__get_layout
---

# map-from-image

Pipeline: porygon dedups the image's 16x16 cells into unique metatiles + records
placement; **Porytiles** compiles the tileset binaries; porygon writes the map.bin
+ registers a new layout. Best for **tile-aligned / pixel-art** images.

## Workflow

1. **Check Porytiles**: `mcp__porygon__porytiles_status`. If not available, tell the
   user to `brew install grunt-lucas/porytiles/porytiles` and stop until installed
   (it's required for the tileset binaries).
2. **Validate the image**: `mcp__porygon__validate_image`. Both dimensions must be a
   multiple of 16px. If not, tell the user to crop/pad to a 16px grid (don't silently
   resize - it would smear a pixel-art map).
3. **Generate**: `mcp__porygon__image_to_map(image_path, name)`. Leave `full_auto`
   off so collision starts passable for human review. On success you get the new
   layout id + tileset; on a Porytiles failure (`stage: "porytiles"`) the output
   usually says palette overflow - relay it and suggest simplifying the image's
   colors (the MVP targets few-color/pixel-art images).
4. **Review in Porymap**: tell the user to open the new layout in Porymap, load
   `porymap-scripts/porygon-collision-overlay.js` (Options -> Custom Scripts), use
   Tools -> "porygon: Toggle Collision Overlay" (Ctrl+Shift+C) to see/confirm
   collision, paint fixes, and save. For collision/behavior advice on a tricky map,
   spawn the `map-architect` agent.

## Be honest about the ROM-build gap

The generated tileset is **viewable in Porymap immediately**, but to **build into the
ROM** the new primary tileset must be registered in C
(`src/data/tilesets/headers.h` / `graphics.h` / `metatiles.h` + the tileset tables).
That step is not automated here - say so. If the user just wants something that
boots now, suggest reusing an existing tileset instead.

## Notes
- Vanilla uses 8 tiles/metatile (dual-layer), expansion forks 12 (triple-layer);
  porygon reads `NUM_TILES_PER_METATILE` and passes the right Porytiles flag.
- `full_auto: true` applies the coarse collision heuristic (dark = wall) without a
  review pause - lossy; only suggest it for throwaway/preview maps.
