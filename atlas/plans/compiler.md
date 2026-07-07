# Atlas Compiler

> This is the math document. It is the technical center of gravity of Atlas.

**Version:** 0.1 (Draft - to be validated by Spike 0)

> **Naming:** Atlas is the internal codename. The product ships as **Porygon**.

This document answers exactly one question:

> **How does flat artwork plus semantic masks become valid Porytiles input, and what do we tell the artist when it cannot?**

Every other document in `plans/` hangs off this answer.

If a rule here is wrong, the product design is wrong.

Constraints marked **[verify: Spike 0]** are believed correct but must be confirmed against real Porytiles and pokeemerald behavior before being treated as fact.

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

---

# Target

A Porytiles source project:

* Layer PNGs (bottom / middle / top), laid out on the metatile grid
* Metatile attributes (behavior, layer type)
* Whatever additional inputs Porytiles requires **[verify: Spike 0 - capture the full input surface]**

Porytiles then produces the pokeemerald tileset: `tiles.png`, palettes, `metatiles.bin`, `metatile_attributes.bin`.

Atlas never generates those final assets directly.

Porytiles is the canonical compiler. Atlas generates its input.

---

# Engine Constraints

These are the walls the decomposition must respect.

All numbers are pokeemerald defaults. **[verify: Spike 0]**

## Geometry

* A metatile is 16x16 px, composed of 8x8 px tiles (2x2 per layer).
* Each metatile renders **two** layers, chosen from three logical layers via its layer type:
  * NORMAL: middle + top
  * COVERED: bottom + middle
  * SPLIT: bottom + top
* Consequence: **a metatile has at most two depth planes.** A third depth plane within one metatile is unrepresentable.

## Priority / occlusion mechanism

* "Player renders behind" is achieved by placing pixels on a layer that renders above sprites.
* Within an occluding tile, non-occluding pixels can be transparent, so occlusion boundaries do **not** need to align to tile edges - the same 8x8 cell can hold occluding pixels on the top layer and non-occluding pixels on a lower layer.
* The depth *choice* is per layer per metatile; the pixel *split* is free. **[verify: Spike 0 - confirm the exact render order of layers vs sprites for each layer type]**

## Palettes

* Each 8x8 tile uses exactly one 16-color palette (15 usable colors + transparency).
* A single tile whose pixels need more than 15 colors is unrepresentable.
* Total palettes per tileset are limited: 6 in a primary tileset, 7 in a secondary (13 total for a map). **[verify: Spike 0]**
* Porytiles owns palette assignment; Atlas owns predicting whether assignment can succeed (Tier 2 budgets).

## Tiles and metatiles

* Primary tileset: 512 tiles, 512 metatiles. Secondary: 512 tiles, 512 metatiles. **[verify: Spike 0]**
* Porytiles deduplicates tiles (including flips); Atlas budget prediction should model dedup conservatively.

## Behaviors

* Each metatile carries one behavior value.
* Atlas collision tags (Walkable / Blocked / Tall Grass / Water / Ledge / ...) map to behavior values.
* The mapping table lives in the pokemon_emerald module. Core never sees it.

---

# The Decomposition Algorithm

Sketch. Spike 0 hand-executes this on one tree; Milestone 10 implements it.

```text
For each Object in the Tileset:

1. Flatten the scene graph into one artwork + one collision mask + one occlusion mask.

2. Slice artwork into 16x16 metatile cells aligned to the anchor grid.

3. For each metatile cell:

   a. Split pixels by the occlusion mask:
      occluding pixels    -> the "above player" plane
      non-occluding pixels -> the "below player" plane

   b. Count distinct depth planes required.
      0 or 1 plane: trivial.
      2 planes: assign to the two layers of an appropriate layer type.
      3+ planes: UNREPRESENTABLE -> Tier 2 diagnostic.

   c. Choose layer type (NORMAL / COVERED / SPLIT) per metatile.
      Heuristic to be determined by Spike 0.

   d. Derive behavior from the collision tag via the plugin mapping.

4. Lay out all metatiles into the Porytiles layer PNGs.

5. Predict budgets:
   distinct-color analysis per tile -> palette feasibility
   deduplicated tile count          -> tile budget
   metatile count                   -> metatile budget

6. Emit:
   layer PNGs + attributes          (Porytiles input)
   one .atlasobject per Object      (Compiled Object: object -> metatile mapping)
   prefab entries                   (if Spike 0 confirms the format)
```

Determinism requirement: same Tileset input produces byte-identical output.

Stable ordering everywhere - object order, metatile layout, tile numbering.

Re-exporting an unchanged project must produce an empty diff.

---

# Unrepresentable Cases

The second half of the core question: **what do we tell the artist when it cannot?**

Every failure is reported at the correct validity tier, in artist terms, anchored to a location the artist can see.

The message format is always: **highlighted region + plain explanation + suggested fix.**

Raw Porytiles output never reaches the artist.

## Tier 1 - Object validity (authoring time, fixed on the Canvas)

| Case | Artist-facing message |
|---|---|
| Artwork not a multiple of 16px | "This artwork doesn't fit the tile grid. Extend the canvas to the next 16px boundary." |
| Anchor off-grid | Prevented by the editor; anchor snaps. |
| Collision cell painted outside artwork | Prevented by the editor. |

## Tier 2 - Tileset validity (compile time, fixed in the Tileset view)

| Case | Artist-facing message |
|---|---|
| Three or more depth planes in one 16x16 cell | "This area needs the player to be both in front of and behind things in too small a space. Simplify the overlap here." (region highlighted) |
| More than 15 colors in one 8x8 tile | "This small area uses too many colors for the hardware. Reduce colors here." (region highlighted) |
| Palette budget exceeded across the Tileset | "This tileset uses too many color groups. Remove an object or align colors between these objects." (contributing objects listed) |
| Tile budget exceeded | "This tileset has too much unique detail. Reuse artwork or remove an object." (largest contributors listed) |
| Metatile budget exceeded | "This tileset has too many 16x16 blocks. Remove an object." |

Budget cases are **never** Object errors.

The same Object can be green in one Tileset and red in another.

## Tier 3 - Export validity (round-trip time)

Anything Porytiles rejects that Tier 2 failed to predict.

Every Tier 3 occurrence is a bug in our Tier 2 prediction: log it, map it to the best available artist-facing diagnostic, and improve the predictor.

The long-term goal is that Tier 3 never fires.

---

# Compiled Objects and Prefabs

Alongside Porytiles input, the exporter emits one Compiled Object per Object:

```text
tree.atlasobject
```

Contents: the mapping from the Object to its generated metatiles (IDs, arrangement, dimensions, anchor).

This is the stable intermediate for anything downstream that wants to treat exports as objects rather than tile soup.

First consumer: **Porymap prefabs.** Porymap 5+ supports prefabs (named multi-metatile selections placeable as a unit). If the format holds up **[verify: Spike 0]**, the exporter emits a prefab entry per Compiled Object, and "place the tree as a tree" works in stock Porymap.

If the format doesn't hold up, Compiled Objects still exist; prefab emission is dropped from MVP and the Porymap limitation stands as documented in the Bible.

---

# Open Questions for Spike 0

1. Porytiles input surface: exact CLI, required files, attribute format, version to pin.
2. Layer render order vs sprites per layer type; confirm the occlusion mechanism described above.
3. Layer type selection heuristic: when to prefer NORMAL vs COVERED vs SPLIT.
4. Exact budget numbers: palettes (primary/secondary), tiles, metatiles.
5. How Porytiles reports errors; how much Tier 2 prediction is needed vs parsing Porytiles output.
6. Porymap prefab format: confirm or reject prefab emission.
7. Primary vs secondary tileset handling: does MVP target secondary tilesets only, or both?
8. Tile dedup behavior (flips, palette-swaps): how conservative must the Tier 2 tile-count prediction be?

Spike 0's deliverable is this document at version 1.0, with every **[verify]** marker resolved.
