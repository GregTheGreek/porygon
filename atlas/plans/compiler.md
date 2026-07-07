# Atlas Compiler

> This is the math document. It is the technical center of gravity of Atlas.

**Version:** 1.0 (validated by Spike 0, 2026-07-07 - see `../spikes/spike0/FINDINGS.md`)

> **Naming:** Atlas is the internal codename. The product ships as **Porygon**.

This document answers exactly one question:

> **How does flat artwork plus semantic masks become valid Porytiles input, and what do we tell the artist when it cannot?**

Every other document in `plans/` hangs off this answer.

Every constraint below was verified empirically against porytiles 1.0.0 and pokeemerald-expansion in Spike 0, except the items in **Residual Risks**.

---

# Toolchain

Pinned: **porytiles 1.0.0** (`2026.06.05` build).

Porytiles 1.0 operates **in-place on the decomp project**. There is no standalone "Porytiles project" to generate. Instead:

* Porytiles reads all engine constants from the project's `include/fieldmap.h` (with a provenance chain: CLI flag > YAML > header define > default).
* It auto-detects the base game (pokeemerald, pokeemerald-expansion, pokefirered, pokeruby).
* A "managed" tileset has source assets in `porytiles_src/` which Porytiles compiles into Porymap-ready binaries in `porytiles_bin/`, and Porytiles wires the registration C code (`graphics.h`, `metatiles.h`, `headers.h`, `tileset_anims.c/h`) itself.

Atlas therefore never guesses budgets: it reads the same headers (or runs `porytiles dump-tileset-config`).

---

# Inputs

## An Atlas Object

* Flat artwork (RGBA PNG, dimensions multiple of 16px)
* Collision mask (one value per 16x16 cell: Walkable / Blocked / Custom tag)
* Occlusion mask (pixel-level: "player renders behind these pixels")
* Anchor (16px grid-snapped)
* Metadata

## An Atlas Tileset

* An ordered set of Objects compiled together
* The unit of compilation, budgeting, and export
* MVP target: a **secondary** tileset, paired with a Porytiles-managed partner primary (a secondary cannot compile standalone; pairing flags must be passed on every compile - they are not persisted)

---

# Target

The Porytiles source format for one managed tileset, inside the user's decomp project:

```text
porytiles/tilesets/<gSymbol>/          management dir (manifest + cache; created by create-tileset)

data/tilesets/secondary/<slug>/porytiles_src/     <- Atlas writes these
    bottom.png  middle.png  top.png    layer PNGs: grid of 16x16 metatiles, row-major,
                                       RGBA 8-bit non-interlaced, dims multiple of 8
                                       (Atlas enforces 16), transparency = magenta 255,0,255
    attributes.csv                     header exactly "id,behavior"; sparse rows;
                                       behavior = MB_* enum NAMES from
                                       include/constants/metatile_behaviors.h;
                                       id = 0-based metatile index in row-major order
    anim/                              optional (post-MVP; Porytiles supports animation)
```

Symbol-to-slug: strip `gTileset_`, CamelCase to snake_case (`gTileset_AtlasSpike` -> `atlas_spike`).

Compilation command sequence (verified):

```bash
porytiles create-tileset gTileset_<Primary> -C <project>
porytiles create-tileset gTileset_<Name> --secondary \
  --primary-pairing-mode manual --primary-pairing-partners gTileset_<Primary> -C <project>
# ... Atlas writes porytiles_src/ ...
porytiles compile-tileset gTileset_<Name> \
  --primary-pairing-mode manual --primary-pairing-partners gTileset_<Primary> -C <project>
```

Porytiles then produces `porytiles_bin/`: `metatiles.bin`, `metatile_attributes.bin`, indexed `tiles.png`, `palettes/00-15.pal` (JASC-PAL), plus the C registration edits. Atlas never generates those - Porytiles is the canonical compiler; Atlas generates its input.

---

# Engine Constraints

All values verified against pokeemerald-expansion's `include/fieldmap.h` and `include/global.fieldmap.h`, and observed in compiled output.

## Geometry and layers

* A metatile is 16x16 px, composed of 8x8 px tiles; `NUM_TILES_PER_METATILE = 8` means two layers of 2x2 tiles.
* Each metatile renders **two** of the three logical layers, recorded as its layer type:
  * `NORMAL = 0`: middle + top
  * `COVERED = 1`: bottom + middle
  * `SPLIT = 2`: bottom + top
* **Layer type is never authored.** Porytiles infers it per metatile from which layer PNGs carry non-transparent pixels there. Painting all three layers in one metatile is the only illegal combination.
* Consequence: at most two depth planes per metatile **in the default config**. Porytiles offers triple-layer metatiles (`NUM_TILES_PER_METATILE = 12`) as an engine-level escape hatch; Atlas MVP does not use it, but the diagnostic can mention it exists.

## Priority / occlusion

* "Player renders behind" = put those pixels on the **top** layer; top renders above sprites. The Atlas occlusion mask therefore maps directly: occluding pixels -> top layer PNG, everything else -> middle (and bottom for under-detail).
* Occlusion boundaries need not align to tile edges - within a cell, non-occluding pixels are simply transparent on the top layer.
* Verified at the data level (Spike 0's canopy compiled to NORMAL with canopy pixels on top). Visual runtime confirmation is a residual risk (below).

## Palettes

* Each 8x8 tile uses exactly one 16-color palette (15 usable + transparency). More than 15 distinct colors in one tile is a clean Porytiles error.
* Budgets: 6 primary palettes (slots 0-5), 7 secondary (slots 6-12), 13 total.
* **Critical:** exceeding the palette budget makes porytiles 1.0.0 **panic** (SIGABRT, exit 134, internal assertion) rather than emit a diagnostic. Tier 2 palette-feasibility prediction is a hard requirement, and the Porytiles invocation must be sandboxed (crash-tolerant).

## Tiles and metatiles

* 512 tiles / 512 metatiles each for primary and secondary (1024 / 1024 total).
* Tile IDs in `metatiles.bin` are global: secondary tiles start at 512+; tile 0 is the shared transparent tile.
* Porytiles deduplicates tiles by shape including h/v flips (verified: one canopy tile served four corners via flip flags). Tier 2 tile-count prediction: distinct shapes ignoring flips = lower bound, counting flips = upper bound.

## Attributes encoding (Emerald: 2 bytes per metatile)

* Behavior: bits 0-7 (`METATILE_ATTR_BEHAVIOR_MASK 0x00FF`). (FireRed uses a wider mask and 4-byte attributes - not our target.)
* Layer type: bits 12-15 (`METATILE_ATTR_LAYER_MASK 0xF000`), values 0-2.
* Behavior comes from `attributes.csv` (plugin maps Atlas collision tags to `MB_*` names); layer type comes from the artwork decomposition. Disjoint fields, set independently. Round-trip verified.

---

# The Decomposition Algorithm

Verified end-to-end in Spike 0 on a 2x3-metatile tree.

```text
For each Object in the Tileset:

1. Flatten the scene graph into one artwork + one collision mask + one occlusion mask.

2. Slice artwork into 16x16 metatile cells aligned to the anchor grid.

3. For each metatile cell, route pixels to layer PNGs:
      occluding pixels                  -> top.png
      non-occluding pixels              -> middle.png
      (bottom.png reserved for under-detail; MVP may leave it empty per cell)
   Porytiles infers the layer type from the result:
      middle+top    -> NORMAL   (canopy case: top renders above the player)
      bottom+middle -> COVERED  (trunk case: all below the player)
      bottom+top    -> SPLIT
   A cell needing all three layers is UNREPRESENTABLE -> Tier 2 diagnostic.
   There is no layer-type heuristic to design - the routing IS the choice.

4. Lay out all metatiles into the three layer PNGs (row-major, shared grid).

5. Emit attributes.csv: collision tags -> MB_* behavior names via the plugin mapping.

6. Predict budgets (Tier 2, BEFORE invoking Porytiles):
   distinct colors per 8x8 tile   -> per-tile 15-color check
   palette packing feasibility    -> MANDATORY (Porytiles panics past the budget)
   deduplicated tile count        -> tile budget (bounds via flip-aware dedup)
   metatile count                 -> metatile budget

7. Invoke: create-tileset (once) + compile-tileset (sandboxed subprocess;
   treat exit 134/SIGABRT as "budget prediction failed us" and report in Tier 2 terms).

8. Emit:
   one .atlasobject per Object    (Compiled Object: object -> global metatile IDs)
   prefabs.json entries           (see Prefabs below)
```

Determinism requirement: verified - Porytiles output is byte-identical across repeat compiles for the same input. Atlas must preserve this by keeping its own layout stable (object order, metatile order, stable PNG encoding). Re-exporting an unchanged project must produce an empty diff.

---

# Unrepresentable Cases

The second half of the core question: **what do we tell the artist when it cannot?**

Every failure is reported at the correct validity tier, in artist terms, anchored to a location the artist can see: **highlighted region + plain explanation + suggested fix.** Raw Porytiles output never reaches the artist.

Spike 0 fact that shapes this section: Porytiles' clean errors are structured (`fatal` -> `caused by` -> `root cause`, greppable `[tags]`) but often carry **no metatile/tile coordinates**, and the palette-budget case crashes outright. So Tier 2 prediction inside Atlas is not an optimization - it is the only way to give the artist a located, actionable message.

## Tier 1 - Object validity (authoring time, fixed on the Canvas)

| Case | Artist-facing message |
|---|---|
| Artwork not a multiple of 16px | "This artwork doesn't fit the tile grid. Extend the canvas to the next 16px boundary." |
| Anchor off-grid | Prevented by the editor; anchor snaps. |
| Collision cell painted outside artwork | Prevented by the editor. |

## Tier 2 - Tileset validity (compile time, fixed in the Tileset view; computed by Atlas, not Porytiles)

| Case | Artist-facing message |
|---|---|
| Three depth planes in one 16x16 cell | "This area needs the player to be both in front of and behind things in too small a space. Simplify the overlap here." (region highlighted) |
| More than 15 colors in one 8x8 tile | "This small area uses too many colors for the hardware. Reduce colors here." (region highlighted) |
| Palette budget exceeded (max 7 secondary palettes) | "This tileset uses too many color groups. Remove an object or align colors between these objects." (contributing objects listed). MANDATORY pre-check: Porytiles crashes on this case. |
| Tile budget exceeded (512) | "This tileset has too much unique detail. Reuse artwork or remove an object." (largest contributors listed) |
| Metatile budget exceeded (512) | "This tileset has too many 16x16 blocks. Remove an object." |

Budget cases are **never** Object errors. The same Object can be green in one Tileset and red in another.

## Tier 3 - Export validity (round-trip time)

Anything Porytiles rejects that Tier 2 failed to predict. Parse the `root cause` line and `[tag]` blocks; map to the best available artist-facing diagnostic. Treat SIGABRT/exit 134 as a Tier 2 prediction bug, log it, and show the palette-budget message.

Every Tier 3 occurrence is a bug in our Tier 2 prediction: log it and improve the predictor. The long-term goal is that Tier 3 never fires.

---

# Compiled Objects and Prefabs

Alongside Porytiles input, the exporter emits one Compiled Object per Object (`tree.atlasobject`): the mapping from the Object to its **global** metatile IDs (secondary IDs start at 512), arrangement, dimensions, and anchor.

First consumer: **Porymap prefabs** - confirmed viable (format verified against Porymap source, stable 5.0.0 through 6.3.1; see `../spikes/spike0/PREFAB-FINDINGS.md`):

* `<project>/prefabs.json`: top-level JSON array of `{name, width, height, primary_tileset, secondary_tileset, metatiles[]}` with sparse `{x, y, metatile_id, collision, elevation}` cells.
* Bonus: prefab cells stamp collision/elevation onto the map, so Atlas's painted collision semantics carry into Porymap placement (vanilla passable = collision 0, elevation 3).
* Wiring: `porymap.project.cfg` needs `prefabs_filepath` set and `prefabs_import_prompted=1` (else Porymap's first-open dialog may overwrite the file with defaults).
* Rules for emission: plain decimal IDs, only known fields (Porymap rewrites the whole file on UI edits and silently drops invalid entries - Atlas validates before writing); generate while Porymap is closed.

---

# Residual Risks

1. **Runtime occlusion visual.** The layer-type data is verified; the actual "player walks behind the canopy" frame has not been observed in an emulator. Confirm once by wiring the spike tileset into a map and running the ROM (the porygon MCP playtester tooling can drive this). Low risk: the mechanism is core engine behavior.
2. **`import-tileset` / `decompile-tileset` are broken** in porytiles 1.0.0 against stock tilesets ("Could not resolve artifact paths", reproduced on multiple tilesets and configs). Irrelevant to the MVP export path (create-tileset works), but it blocks any future "import an existing tileset into Atlas" feature. Track upstream.
3. **Porymap in-app prefab check** pending a Porymap install; format is source-verified.
