---
name: map-from-image-semantic
description: >
  Recreate a location from ANY image (a screenshot or map from another game, an upscaled
  or non-tile-aligned picture) as a coherent, walkable pokeemerald map by understanding
  the scene and placing equivalent assets. Use when the user wants to "make a town/map
  from this image", "recreate this place", or drops a foreign / imperfect image and
  map-from-image-existing gave fragmented results. This is the semantic counterpart to
  map-from-image-existing: instead of matching pixels, YOU read the structure and place
  multi-tile object stamps so buildings stay intact.
allowed-tools:
  - Read
  - Bash
  - Agent
  - mcp__porygon__validate_image
  - mcp__porygon__list_stamps
  - mcp__porygon__list_maps
  - mcp__porygon__compose_map
  - mcp__porygon__extract_stamp
  - mcp__porygon__get_connections
  - mcp__porygon__read_blockdata
---

# map-from-image-semantic

Per-cell pixel matching (`map-from-image-existing`) shatters structured objects on foreign
or imperfect sources, because a pokeemerald building is a fixed mosaic of ~25 specific
metatiles and each cell is matched independently. This skill takes the other path: **you
look at the image and describe it**; porygon fills terrain and stamps multi-tile objects as
whole units, so houses/labs/marts stay coherent. Trades pixel fidelity for structural
coherence - the right trade for "recreate the gist of this place" from any source.

## When to use which
- **Tile-native pokeemerald-style rip** (exact 16px grid) -> `map-from-image-existing` (near-exact copy).
- **Foreign game / screenshot / upscaled / not tile-aligned** -> this skill (coherent equivalent).

## Workflow

1. **Look at the image.** Read it. Identify the grid you'll target (in metatiles, e.g. 20x18),
   the terrain (grass field, water, sand, forest border), and the discrete objects (houses,
   a lab, a mart, a Pokemon Center) with their approximate cell positions.
2. **See the vocabulary.** `list_stamps` for available objects, `list_maps` to choose a
   neighbour to link to (and the direction it sits from the new town). If the image has an
   object with no matching stamp, either map it to the nearest one (a castle -> a large
   building stamp) or `extract_stamp` one from an existing map region.
3. **Write a MapSpec** (JSON) describing what you saw:
   ```json
   {
     "name": "MyTown",
     "primary_tileset": "gTileset_General", "secondary_tileset": "gTileset_Petalburg",
     "width": 20, "height": 18,
     "base_terrain": "grass", "border_terrain": "tree", "border_thickness": 2,
     "regions": [
       {"terrain": "water", "rect": [13, 4, 5, 4]},
       {"stamp": "tree_grove", "rect": [2, 9]}
     ],
     "objects": [{"stamp": "house", "x": 3, "y": 4}, {"stamp": "lab", "x": 6, "y": 10}],
     "decorations": [{"terrain": "flower", "x": 4, "y": 14}],
     "link": {"to": "MAP_LITTLEROOT_TOWN", "dir": "up", "offset": 0}
   }
   ```
   Terrain classes and stamps must exist for the tileset pair (`list_stamps`; terrain is
   grass/tall_grass/sand/water/flower/tree for general+petalburg). Stamp `x,y` is the
   top-left cell; keep stamps inside the border.
   - **Water gets real shorelines automatically.** Just place a `water` region as a
     rectangle (or several, for a river/strips) - porygon autotiles a rocky bank + corners
     around it. Don't try to hand-place edge tiles; a plain rectangle is correct input.
   - **macro-region stamps** (`{"stamp": <name>, "rect": [x, y]}` in `regions`) drop a whole
     real-map chunk in verbatim (e.g. `tree_grove`, `ledge_h`) for discrete natural features
     a flood-fill can't make. They're the `region`-tagged entries in `list_stamps`.
4. **Compose.** `compose_map(spec)`. It writes the layout + walkable map, wires the
   reciprocal connection, and returns a `match_preview.png` + any `warnings`.
5. **Review + iterate.** Read `match_preview.png` and compare to the source. Adjust object
   positions / terrain regions and re-run (use a fresh `name` or remove the prior map). For a
   foreign image, aim for a faithful *layout*, not pixel identity.

## Honest framing
- This produces a **coherent equivalent**, not a pixel copy - that's the point for foreign art.
- Buildings are **solid with walkable doors**; you cannot enter them (no interiors in v1).
- Water autotiling banks **convex** edges/corners cleanly; deeply **concave** river bends fall
  back to plain water (no inner-corner nub yet). Rectangular ponds and straight strips are ideal.
- Terrain ids assume a vanilla `gTileset_General`; stamps are recipe-resolved so they adapt
  to the project's own art. Without a `link`, the map is created but not reachable.
