# Map from image

Turn an image into a tileset + layout using the `map-from-image` skill.

1. `porytiles_status` - if absent, `brew install grunt-lucas/porytiles/porytiles` first.
2. `validate_image $IMAGE` - dims must be a multiple of 16px.
3. `image_to_map $IMAGE $NAME` - builds a new tileset + layout (collision passable for review).
4. Open the new layout in Porymap, load `porymap-scripts/porygon-collision-overlay.js`, confirm collision (Ctrl+Shift+C), save. For a tricky map, spawn `map-architect`.

Note: the tileset is viewable in Porymap immediately; building into the ROM needs the new tileset registered in C (not automated).
