# Troubleshooting

If something goes wrong, Porygon tries to tell you at the tier where you can fix
it, in plain language. This page explains the tiers, the compile failures you
are most likely to hit, and where Porygon keeps its files.

## The error tiers

Every problem Porygon reports belongs to one of three tiers. The Problems panel
groups them, and each points at where the fix lives.

- **Tier 1 - Object.** The Object is not internally coherent. Fixed on the
  Canvas. Example: artwork whose width or height is not a multiple of 16px.
  Message: "This artwork doesn't fit the tile grid. Extend the canvas to the
  next 16px boundary."
- **Tier 2 - Tileset.** The Objects do not fit together within the engine's
  shared budgets. Fixed in the Tileset view by removing an Object, sharing
  colors, or simplifying artwork. Porygon computes these before running
  Porytiles, so you see them as live meters, not as a crash.
- **Tier 3 - Export.** Porytiles rejected the output despite passing Tier 2.
  Porygon maps the toolchain error back to a Tileset-level message. Every Tier 3
  occurrence is a gap in Porygon's Tier 2 prediction; the raw compiler output is
  kept in the problem's details for reporting, but the headline stays in artist
  terms.

## Common compile failures

**"Porytiles was not found" / "needs Porytiles 1.0.0 but found X".**
Compile is disabled until the pinned version (1.0.0) is present. The default
lookup path is `/opt/homebrew/bin/porytiles`. Install Porytiles 1.0.0, or use
"Locate Porytiles..." in the Tileset view (or Preferences) to point Porygon at
the right binary. Export does not need Porytiles, only Compile does.

**"The destination folder does not exist."**
The compile target (the decomp project directory) is missing or was moved.
Re-select a valid pokeemerald or pokeemerald-expansion directory.

**A palette / color-group problem (Tier 2).**
"This tileset uses too many color groups" or "This small area uses too many
colors for the hardware." A secondary tileset gets 7 palettes, and each 8x8 tile
must fit one 15-color palette. This is the one budget Porytiles cannot fail
gracefully on: exceeding it crashes Porytiles (SIGABRT). Porygon predicts it and
refuses first, listing the contributing Objects. Remove an Object, or align
colors between the highlighted Objects.

**"This tileset has too much unique detail" (tiles) / "too many 16x16 blocks"
(metatiles).**
You are over the 512-tile or 512-metatile budget. Reuse artwork across Objects,
simplify detail, or remove an Object. The tile meter shows a range: the lower
number is what Porytiles actually emits after flip-aware deduplication.

**An unknown collision tag.**
An Object carries a Custom collision tag that is not in the engine vocabulary
(usually from a hand-edited `project.json`). Repaint the cell with a tag from
the dropdown.

**Occlusion depth conflict (Tier 2).**
"This area needs the player to be both in front of and behind things in too
small a space. Simplify the overlap here." Reduce the layered overlap in the
highlighted region.

## The scratch-copy warning for compile targets

Compile writes generated tileset assets and a `prefabs.json` into the decomp
project you point it at, and it edits `porymap.project.cfg` to wire prefabs in.
Point Compile at a **scratch copy** of your decomp project, never at a pristine
checkout. Porytiles regenerates files in place, and Porymap can rewrite
`prefabs.json` on its own UI edits, so treat the compile target as disposable
output, not as source you care about.

## Where Porygon keeps files

**Projects** are plain folders you choose, each with a `project.json` manifest
and an `objects/` directory. Move or back them up like any other folder. A
soft-deleted Object is moved to a `.trash/` subfolder so undo can restore it.

**App settings and the recent-projects list** live in the macOS app-config
directory, separate from any project:

- `~/Library/Application Support/tech.gregmarkou.porygon/settings.json`
- `~/Library/Application Support/tech.gregmarkou.porygon/recents.json`

`settings.json` holds the Porytiles binary override, the autosave debounce, and
the default grid visibility. If either file is missing or corrupt, Porygon
loads defaults rather than failing, so deleting them is a safe reset. Stale
recent entries (projects whose folder no longer exists) are pruned automatically
on launch.
