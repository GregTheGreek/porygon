# Porygon

> Porygon is to Porytiles what Figma is to SVG.

Porygon is a desktop app for authoring reusable gameplay **objects** for
pokeemerald-family tilesets. You paint what a thing *is* - a tree, a rock, a
fence - and Porygon compiles that intent into engine assets Porytiles and
Porymap already understand. You never touch metatiles, tile IDs, layer PNGs,
priorities, or behavior tables.

The internal codename for this project is **Atlas**; the product ships as
**Porygon**. You will see "Atlas" in directory names, the Rust crate, and the
planning documents, and "Porygon" everywhere in the UI.

---

## What Porygon is (and is not)

Porygon is an **object authoring platform**. It sits between your art tool and
the Pokemon toolchain:

```
Aseprite / Photoshop  ->  Porygon  ->  Porytiles  ->  Porymap  ->  Game build
```

It does not replace any of those tools. Porytiles stays the compiler, Porymap
stays the map editor, and your art tool stays where you draw pixels. Porygon is
the missing authoring layer that turns finished artwork plus gameplay intent
into compiled tileset assets.

Map editing, tile animation, and a generic multi-engine plugin API are
deliberately out of scope for this release (see `docs/beta-checklist.md`).

---

## Core concepts, in artist terms

**Object.** The thing you author: artwork plus metadata, an anchor, a collision
layer, an occlusion layer, variants, and optional child objects. Objects are
reusable and composable. An Object knows nothing about engine formats.

**Anchor.** The world-space point where an Object attaches to the map, snapped
to the 16px metatile grid. Placement, child transforms, and runtime positioning
all derive from it. A free-floating anchor would allow placements the engine
cannot honor, so it always snaps.

**Collision.** Painted directly on the 16x16 grid, one value per metatile:
Walkable, Blocked, or Custom. Custom opens a dropdown of semantic tags (Tall
Grass, Water, Ledge, Ice, Sand, and so on). The tag vocabulary comes from the
engine, not from Porygon, and each tag maps to a real `MB_*` behavior at export.

**Occlusion.** Painted directly. It means exactly one thing: "the player should
appear behind this." The exporter decides how that becomes engine layer data.

**Variants.** Artwork variations of one Object that share all metadata: a tree
with Summer, Autumn, Winter, and Dead variants. Only the pixels change. Every
Object has at least one variant.

**Scene children.** An Object can contain child Objects (a house with a roof, a
door, windows, a fence). Porygon keeps the hierarchy while you author; the
exporter flattens it. Cycles are refused.

**Tileset.** A named collection of Objects compiled together. The Tileset is the
compile primitive: the engine's shared budgets live here, never on a single
Object. The same Object can be green in one Tileset and red in another.

**Budgets.** A secondary tileset has hard limits, shown as live meters in the
Tileset view: 7 secondary palettes, 512 tiles, 512 metatiles, and 15 usable
colors per 8x8 tile. Porygon predicts these before ever running Porytiles,
because exceeding the palette budget crashes Porytiles outright.

**The three validity tiers.** Porygon reports every problem at the tier where it
can be fixed:

- **Tier 1 - Object validity** (authoring time, fixed on the Canvas): is the
  Object internally coherent? Artwork aligned to the 16px grid, anchor
  grid-snapped, masks well-formed.
- **Tier 2 - Tileset validity** (compile time, fixed in the Tileset view): do
  these Objects fit together within the shared budgets? Computed continuously by
  Porygon, never presented as an Object error.
- **Tier 3 - Export validity** (round-trip time): did Porytiles accept the
  output? Every toolchain error is mapped back to a Tileset-level message in
  artist terms. Raw compiler output never reaches you.

---

## Quickstart

1. **Create or open a project.** A project is a folder containing a
   `project.json` manifest plus an `objects/` directory of artwork. Everything
   autosaves.
2. **Import artwork.** Import a PNG as a new Object, or drag PNGs onto the
   window. Artwork must be a multiple of 16px on both sides; Porygon flags
   off-grid artwork as a Tier 1 problem.
3. **Paint semantics.** Switch to the Collision tool (C) and paint which
   metatiles block the player. Switch to the Occlusion tool (O) and paint where
   the player should walk behind the Object.
4. **Preview in play mode.** Press P to drop a grid-locked player onto the
   canvas and walk around with the arrow keys. Movement, collision response, and
   occlusion match Emerald's rules. If it behaves differently from the GBA, the
   preview is wrong, not the game.
5. **Build a Tileset.** Create a Tileset and add Objects to it. The budget meters
   update as you go. Fix any Tier 2 problems the Problems panel reports.
6. **Export or compile.**
   - **Export** writes a Porytiles-ready source tree (`bottom.png`, `middle.png`,
     `top.png`, `attributes.csv`) plus one `.atlasobject` per Object into a
     folder you choose. It does not run Porytiles.
   - **Compile** runs Porytiles into a pokeemerald decomp project and adds one
     Porymap prefab per Object. Point it at a scratch copy of your project, never
     at a pristine checkout (see `docs/troubleshooting.md`).
7. **Place in Porymap.** Open the decomp project in Porymap and place the
   generated metatiles. If prefabs are wired, exported Objects appear as
   placeable prefabs with their collision and elevation already stamped.

---

## Requirements

- **macOS.** This is the only platform built and tested for the beta.
- **Porytiles 1.0.0.** Porygon pins this exact version and refuses others.
  The default path is `/opt/homebrew/bin/porytiles`; override it in Preferences
  if yours lives elsewhere. Only needed for Compile, not for Export.
- **A pokeemerald or pokeemerald-expansion project.** Compile writes generated
  tileset assets into a decomp project's directory tree.
- **Porymap 5+** to use the emitted prefabs (`prefabs.json`). The prefab format
  is verified stable from Porymap 5.0.0 through 6.3.1.

---

## Keyboard shortcuts

Modifier is Cmd on macOS. Press Cmd+/ in the app for the live cheat sheet, or
Cmd+K for the command palette.

| Action | Shortcut |
|---|---|
| Command palette | Cmd+K |
| Keyboard shortcuts help | Cmd+/ |
| Preferences | Cmd+, |
| Save now | Cmd+S |
| Undo / Redo | Cmd+Z / Cmd+Shift+Z |
| Select tool | V |
| Collision tool | C |
| Occlusion tool | O |
| Play mode | P |
| Rename Object | F2 |
| Delete Object(s) | Cmd+Backspace |
| Previous / Next Object | Up / Down |
| Previous / Next variant | [ / ] |
| Toggle metatile grid (16px) | G |
| Toggle tile grid (8px) | Shift+G |
| Toggle collision overlay | Shift+C |
| Toggle occlusion overlay | Shift+O |
| Toggle player preview | Shift+P |

---

## Development

### Workspace layout

```
atlas/
  apps/
    desktop/        React + TypeScript + Vite frontend (PixiJS canvas, Zustand)
  crates/
    atlas/          single Rust crate: project model, filesystem, Porytiles
                    process spawning, and the pokemon_emerald engine module;
                    also the Tauri 2 shell entry point
  plans/            bible.md (product), implementation.md (roadmap),
                    compiler.md (export math)
  docs/             troubleshooting.md, beta-checklist.md
  spikes/           disposable Spike 0 proof-of-concept; never imported
```

One frontend, one Rust crate. `pokemon_emerald` is a module inside the crate,
not a plugin; it is extracted into a plugin API only if a second engine target
ever exists.

### Build and test

Rust (run from `atlas/`):

```bash
cargo check --workspace
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
```

Frontend (run from `atlas/apps/desktop/`):

```bash
pnpm install
pnpm typecheck
pnpm build
```

Full desktop app (run from `atlas/crates/atlas/`):

```bash
cargo tauri build --debug --no-bundle
```

Dependencies are pinned to exact versions on both sides. Do not introduce
version ranges.

### Where the plans live

- `plans/bible.md` - the product vision and locked MVP scope.
- `plans/implementation.md` - the milestone roadmap (M1 through M15).
- `plans/compiler.md` - the decomposition math and the export contract, plus the
  residual risks still tracked after Spike 0.

### Settings and recents

Porygon stores app-level settings (`settings.json`) and the recent-projects list
(`recents.json`) in the OS app-config directory, separate from any project. See
`docs/troubleshooting.md` for the exact location.
