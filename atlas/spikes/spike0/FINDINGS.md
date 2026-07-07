# Spike 0 Findings: Porytiles 1.0.0 as the Atlas compiler backend

> Empirical results from the Spike 0 end-to-end proof (2026-07-07).
> Everything below was observed against a scratch worktree of pokeemerald-expansion.
> Unverifiable items (runtime render order, Porymap runtime behavior) are flagged.

Binary: `/opt/homebrew/bin/porytiles`, version `1.0.0 2026.06.05`. Base game auto-detected as `pokeemerald-expansion` on every call.

Seed artifacts in this directory: `mkpng.py` (stdlib zlib+struct PNG encoder + tree generator - Pillow was unavailable), `mkerr.py` (four error-case generators), `decode.py` (bin decoder), `tree_tileset/` (final compiled src+bin snapshot), `PREFAB-FINDINGS.md` (Porymap prefab format research).

## TL;DR - top findings

1. **compiler.md's layer/occlusion model is correct.** Layer type is NOT an authored field - Porytiles **infers** it from which of the three layer PNGs carry pixels: middle+top -> `NORMAL`, bottom+middle -> `COVERED`, bottom+top -> `SPLIT`. The tree canopy (painted middle+top) compiled to `layerType=0 NORMAL`; the trunk (bottom+middle) to `layerType=1 COVERED`. Exact match with the predicted decomposition.
2. **3+ depth planes is a hard, detected failure** in the default dual engine - but Porytiles surfaces an escape hatch compiler.md omitted: **triple-layer metatiles** (`NUM_TILES_PER_METATILE=12`). "At most two depth planes" is a property of the default 8-tiles/metatile config, not absolute.
3. **BUG / robustness gap: exceeding the palette budget PANICS** (SIGABRT, exit 134) with assertion `tileset_compiler.cpp:1228: color_index_map.size() > count_limit - this should have already been validated by pipeline_step_validate_input`. No clean diagnostic. **Atlas must predict palette feasibility in Tier 2** and sandbox the compiler call.
4. **`import-tileset` is currently unusable here.** Fails for every pre-existing tileset (primary and secondary, with/without path overrides) at `root cause: Could not resolve artifact paths`. The source format was therefore learned from `create-tileset` (which works), not from decompiling a stock tileset.
5. **Compilation is deterministic** - byte-identical bins/png/pals across repeat compiles; restore-then-recompile reproduced `metatiles.bin` sha `cdbb7e789721809e7298ac5c28234f061ae20376`.
6. **A secondary cannot stand alone** - it needs a *Porytiles-managed* partner primary (auto via map layouts, or `--primary-pairing-mode manual --primary-pairing-partners <primary>`). Pairing flags are NOT persisted; repeat them on every `compile-tileset`.

## Working command sequence

```bash
# 1. Bootstrap a managed PRIMARY (partner for any secondary)
porytiles create-tileset gTileset_AtlasBase -C "$PROJECT"
# 2. Bootstrap the managed SECONDARY, paired to the primary
porytiles create-tileset gTileset_AtlasSpike --secondary \
  --primary-pairing-mode manual --primary-pairing-partners gTileset_AtlasBase -C "$PROJECT"
# 3. Author source: overwrite bottom.png/middle.png/top.png/attributes.csv in
#    data/tilesets/secondary/atlas_spike/porytiles_src/
# 4. Compile (pairing flags MUST be repeated)
porytiles compile-tileset gTileset_AtlasSpike \
  --primary-pairing-mode manual --primary-pairing-partners gTileset_AtlasBase -C "$PROJECT"
```

## Porytiles source format (what the Atlas exporter must generate)

**A. Management dir `porytiles/` at project root:**
`porytiles/tilesets/<gSymbol>/tileset-manifest.json` (`{"imported": false, "version": 1}`) and `tileset.cache.json` (flat `relpath -> md5hex` of every managed file; Porytiles maintains it - its presence is what makes a tileset "managed").

**B. Assets `data/tilesets/<primary|secondary>/<slug>/`** - symbol-to-slug strips `gTileset_` and converts CamelCase to snake_case (`gTileset_AtlasSpike` -> `atlas_spike`):

```text
<slug>/porytiles_src/   <- Atlas WRITES these
    bottom.png middle.png top.png   # layer PNGs, RGBA 8-bit non-interlaced
    attributes.csv
    anim/anim.json, anim/<name>/{key,center,left,right}.png   # optional
<slug>/porytiles_bin/   <- Porytiles WRITES these (Porymap-ready)
    metatiles.bin  metatile_attributes.bin  tiles.png (indexed)
    palettes/00.pal .. 15.pal   # JASC-PAL, all 16 slots always present
```

Stock (unmanaged) tilesets instead keep bins directly in `data/tilesets/secondary/<slug>/` with no `porytiles_*` subdirs.

**C. Generated header:** `include/porytiles_generated/tilesets/<slug>/generated_anim_code.h`

**D. Registration edits Porytiles makes (Atlas relies on them):** `src/data/tilesets/graphics.h` (`gTilesetTiles_PorytilesManaged_<Name>[]` INCBIN of `porytiles_bin/tiles.4bpp.lz`; palettes as `.gbapal` - note the `PorytilesManaged_` infix and `.4bpp.lz`/`.gbapal` build forms vs stock `INCGFX ... .4bpp.fastSmol`), `metatiles.h`, `headers.h` (the `struct Tileset`), and `tileset_anims.c`/`.h`.

**attributes.csv:** header must be exactly `id,behavior` or FireRed's `id,behavior,terrainType,encounterType` (4-col rejected on non-FireRed base). Rows sparse. `behavior` values are `MB_*` enum **names** resolved against `include/constants/metatile_behaviors.h` (not numbers). **No layer-type column exists.** `id` = 0-based metatile index in layer-PNG row-major order.

**Layer PNG geometry:** grid of 16x16 metatiles, row-major. Bootstrap default 128x16; width is not fixed - the tree used **32x48** (2x3 = 6 metatiles). Hard rule: each dimension must be a **multiple of 8** (tile size), enforced at tileize (16 is the safe artist-facing rule). All three layer PNGs must exist; empty = all-transparent. Palette index 0 / transparency sentinel is magenta `255 0 255`.

## Verified engine constants (from `include/fieldmap.h`)

| Constant | Value | Note |
|---|---|---|
| NUM_TILES_IN_PRIMARY | 512 | secondary tiles = 512 |
| NUM_TILES_TOTAL | 1024 | |
| NUM_METATILES_IN_PRIMARY | 512 | secondary metatiles = 512 |
| NUM_METATILES_TOTAL | 1024 | |
| NUM_PALS_IN_PRIMARY | 6 | primary pals = indices 0-5 |
| NUM_PALS_TOTAL | 13 | secondary pals = 7 (indices 6-12) |
| NUM_TILES_PER_METATILE | 8 | dual-layer; 12 = triple |
| metatile-attr-size | 2 | u16/metatile (Emerald); FireRed = 4 |

compiler.md's "6 primary / 7 secondary / 13 total" palettes and 512/512 tiles/metatiles are all **confirmed**. The observed tree used secondary palettes 6-9.

## metatile_attributes.bin encoding (Emerald, 2 bytes/metatile)

From `include/global.fieldmap.h`: `METATILE_ATTR_BEHAVIOR_MASK 0x00FF` (bits 0-7), `METATILE_ATTR_LAYER_MASK 0xF000` (bits 12-15, shift 12). Enum `NORMAL=0` (middle+top), `COVERED=1` (bottom+middle), `SPLIT=2` (bottom+top).

**Correction to compiler.md's [verify] note** ("behavior bits 0-8 ... layer type bits 12-13"): for **Emerald** behavior is bits **0-7** (`0x00FF`); bits 0-8 (`0x1FF`) is the *FireRed* mask. The layer field is 4 bits wide (`0xF000`, bits 12-15), only values 0-2 used. Round-trip verified: `0,MB_TALL_GRASS` (enum index 2) -> metatile 0 `attr=0x0002`. Behavior (from CSV) and layer type (inferred from artwork) occupy disjoint fields, set independently.

## metatiles.bin decode of the compiled tree (6 metatiles, 96 bytes)

Each metatile = 8 u16 (tile id bits 0-9, hflip bit 10, vflip bit 11, palette bits 12-15):

```text
metatile 0-3 (canopy) attr=0x0000  layerType=0 NORMAL (mid+top)
metatile 4-5 (trunk)  attr=0x1000  layerType=1 COVERED (bot+mid)
```

Canopy painted middle+top -> NORMAL (top = above-sprite plane); trunk painted bottom+middle -> COVERED (both below). Exactly compiler.md's decomposition. Tile ids are **global** - they start at 513 (primary owns 0-511; id 0 = shared transparent tile in the trunk's empty columns). **Dedup incl. flips confirmed:** canopy tile 513 reused across metatiles 0-3 as `--/H-/-V/HV` (raw 0x7201/0x7601/0x7A01/0x7E01). Porytiles also emitted a `[true-color-multi-palette-tile]` remark when one shape appeared on two palettes.

## Error surface catalog

Structure: `remark/note/warning [<tag>]:` blocks, then `fatal:` -> `caused by:` chain -> `root cause:`. Tags are greppable; CSV/behavior/dimension errors carry locations; **color and layer-mode errors carry no metatile coordinate**.

- **(a) >15 colors in one 8x8 tile** - CLEAN, exit 1. `note [tile-color-count-violation]` lists each `R G B -> N pixel(s)`, root cause `Found tile(s) with more than 15 unique non-transparent pixels.` No tile coordinate.
- **(b) Palette budget exceeded** - **PANIC, exit 134** (the critical one). `tileset_compiler.cpp:1228: color_index_map.size() > count_limit - this should have already been validated by pipeline_step_validate_input`, backtrace through `pipeline_helper_run_pal_packing()`. Not a clean error - Atlas must predict this and not pass it through naively. (Caveat: one construction confirmed; the assertion is in pal-packing/count-limit but not every overflow shape was enumerated.)
- **(c) Dims not multiple of 8** (30x48) - CLEAN, exit 1. Root cause `image dimensions must be a multiple of 8, got 30x48`. Note: **8**, not 16.
- **(d) 3+ planes** (all three layers painted) - CLEAN, exit 1. `note [layer-mode-violation]: Implied layer mode is 'dual'. ... Consider enabling triple-layer metatiles ... set 'Number Of Tiles Per Metatile' = '12'`, root cause `Found metatile(s) with mismatched implied layer mode.` Confirms the wall AND the triple escape hatch; carries fieldmap.h:17.
- **(e bonus) Unknown behavior name** - CLEAN, best-located: `attributes.csv:3: unknown metatile behavior 'MB_TREE'`, root cause references `metatile_behaviors.h`.

Net: Atlas should own Tier-2 prediction for colors-per-tile, palette budget, tile/metatile budgets, and 3-plane detection; treat Porytiles errors as a Tier-3 backstop only for cleanly-failing cases, sandboxed against the palette panic.

## Determinism

Confirmed byte-identical across repeat compiles and across a restore-then-recompile (`metatiles.bin` sha `cdbb7e78...`). Re-export of unchanged input is byte-stable.

## Open Questions - answers

1. **Input surface / version:** pin **porytiles 1.0.0**; files = 3 layer PNGs + `attributes.csv` (+ optional `anim/`) under `<slug>/porytiles_src/` plus the `porytiles/` mgmt dir; CLI as above; config auto-detected from repo headers.
2. **Render order vs sprites:** layer-type *data* fully confirmed; the "top renders above player" visual rests on fieldmap enum comments + pokeemerald priority - **the ROM was not run**. Recommend a quick emulator confirmation before locking compiler.md past 1.0.
3. **Layer-type heuristic:** resolved and simpler than expected - the exporter picks layer type *implicitly* by choosing which layer PNGs to paint. No heuristic to design; all-three-occupied is the only illegal combo.
4. **Budgets:** confirmed (table above).
5. **Error reporting / Tier-2 need:** structured chains with tags; some locations, coords often absent; palette budget CRASHES -> Atlas must do real Tier-2 prediction.
6. **Prefab format:** see `PREFAB-FINDINGS.md` (verified vs Porymap master). Viable: top-level JSON array of sparse `{x,y,metatile_id,collision,elevation}` cells + `primary_tileset`/`secondary_tileset` labels, `<root>/prefabs.json` wired via `porymap.project.cfg` `prefabs_filepath`. The tree's global metatile ids 512-517 line up exactly with that doc's 2x3 tree example - prefab emission is on the table.
7. **Primary vs secondary:** both supported, but secondary is **not standalone** - needs a managed partner primary. MVP target = secondary paired to a managed primary; document the requirement.
8. **Tile dedup:** dedup by shape with h/v flip flags (bits 10/11); one base tile served 4 flipped canopy corners. Palette is per-entry (bits 12-15). Conservative Tier-2: count distinct shapes; ignore flips for a lower bound, count them for an upper bound.

## Could NOT verify

- Runtime occlusion (needs emulator; data is correct, visual inferred).
- `import-tileset`/`decompile-tileset` on stock tilesets (blocked by "Could not resolve artifact paths"; reproduced on Petalburg and General, with/without overrides, and after adding a `porytiles_bin/` subdir - root cause not isolated). So no populated real-world `attributes.csv` was observed; CSV schema taken from `create-tileset` + the binary's header-validation strings. Risk only if Atlas must round-trip existing tilesets (not an MVP requirement).
- Whether the palette panic covers all overflow shapes.
- Triple-layer mode end-to-end (only the dual-mode rejection that names it was seen).
