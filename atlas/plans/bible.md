# Atlas Bible

> **Atlas is to Porytiles what Figma is to SVG.**
>
> Atlas is a semantic object editor with deterministic compilation.
>
> You don't author engine assets. You author gameplay objects.

**Version:** 1.1
**Status:** Locked (MVP Foundation)

> **Naming:** Atlas is the internal codename (directories, crates, these documents). The product ships as **Porygon**.

Changes from 1.0:

* Added Tilesets and Export Targets to the project model
* Objects are the authoring primitive; Tilesets are the compile primitive
* Defined the three validity tiers: Object, Tileset, Export
* Defined Anchor
* Runtime preview is grid-locked to Emerald movement rules
* Collision tags are plugin-provided
* Animation and map editing are explicit MVP non-goals
* Added `compiler.md` as the technical companion document

---

# Vision

Atlas is not a graphics editor.

Atlas is not a map editor.

Atlas is not a ROM hacking tool.

Atlas is an **Object Authoring Platform**.

Artists should create reusable gameplay objects.

Atlas compiles those objects into engine-specific assets.

Engine formats are implementation details.

---

# Mission

Modern Pokémon development has excellent map editing through Porymap.

What it lacks is an intuitive way to author assets.

Today, artists must understand:

* Metatiles
* Top / Middle / Bottom layers
* Tile priorities
* Behavior tables
* Palette limitations

These are compiler concerns.

They should not be creative concerns.

Atlas removes that complexity while remaining completely compatible with the existing ecosystem.

---

# Relationship with Existing Tools

Atlas does **not** replace existing tools.

Instead:

```text
Aseprite / Photoshop
          │
          ▼
       Atlas
          │
          ▼
Pokémon Export Plugin
          │
          ▼
     Porytiles
          │
          ▼
      Porymap
          │
          ▼
      Game Build
```

Atlas is the authoring experience.

Porytiles remains the compiler.

Porymap remains the map editor.

This is a deliberate architectural decision.

---

# Product Philosophy

Current Pokémon tooling exposes engine implementation.

Atlas exposes gameplay intent.

The artist should never ask:

* Which metatile?
* Which priority?
* Which layer?
* Which tile ID?

Instead they ask:

* Is this a tree?
* Can the player walk here?
* Should the player disappear behind this?
* Does this feel correct?

Atlas translates those answers into engine assets.

---

# Core Principles

## Objects, Not Tiles

Everything the artist authors is an Object.

Examples:

* Tree
* Rock
* Cliff
* Fence
* Bridge
* House
* Water
* Flower

Objects are reusable.

Objects are composable.

Objects may contain child objects.

Example:

```text
House
├── Roof
├── Chimney
├── Door
├── Windows
├── Sign
├── Fence
└── Flowers
```

Internally this is represented as a Scene Graph.

---

## Objects Are Authored. Tilesets Are Compiled.

This is the most important structural rule in Atlas.

An Object is valid or invalid on its own terms.

But Objects never export alone.

The engine's shared budgets - palettes, tiles, metatiles - exist at the **Tileset** level.

So:

* The Object is the authoring primitive.
* The Tileset is the compile primitive.
* The Export Target consumes Tilesets.

```text
Object

↓

Tileset Builder

↓

Exporter

↓

Porytiles
```

Ten Objects can each be perfect in isolation and still be impossible together.

That is never an Object error.

It is a Tileset compilation error.

See **Validity Tiers** below.

---

## Semantic First

Atlas stores meaning.

The exporter stores implementation.

Atlas never asks users to author:

* top.png
* middle.png
* bottom.png
* metatile IDs
* priority tables

Instead an object stores:

* Artwork
* Collision
* Occlusion
* Anchor
* Metadata
* Variants
* Children

Everything else is generated.

---

## Gameplay First

Atlas validates gameplay.

Not compiler output.

Every editing decision should answer:

> "Will this behave correctly in-game?"

rather than

> "Did I generate the correct engine data?"

---

## Continuous Compilation

Every edit immediately updates:

```text
Object

↓

Preview Compiler

↓

Runtime Preview
```

At the Tileset level, every edit immediately updates the budget meters:

* Palette usage
* Tile usage
* Metatile usage

Export simply writes the latest compiled state.

---

## Engine Agnostic

Atlas Core contains zero Pokémon knowledge.

Everything engine-specific lives in the engine plugin, including:

* The export pipeline
* The budget definitions
* The collision tag vocabulary

Future plugins could target:

* Pokémon Emerald
* Pokémon FireRed
* RMXP
* Godot
* Unity
* LDtk
* Tiled

---

# Project Model

A Project contains:

```text
Project

├── Objects          authored, reusable, composable

├── Tilesets         assembled from Objects, compiled, budgeted

└── Export Targets   engine + toolchain configuration per Tileset
```

Objects are authored once.

Tilesets are assembled from Objects.

Exporters consume Tilesets.

**Maps are deliberately absent from the MVP model.**

Porymap edits maps.

Atlas may grow a map concept post-MVP.

The slot is reserved.

The code is not.

---

# User Workflow

Creating an object is intentionally simple.

Import artwork.

↓

Atlas creates an Object.

↓

Edit metadata.

↓

Test gameplay.

↓

Add to a Tileset.

↓

Export.

No wizard.

No conversion flow.

No hidden steps.

---

# Workspace

Atlas consists of four permanent regions.

```text
--------------------------------------------------------

Toolbar

--------------------------------------------------------

Object Library | Canvas | Inspector

--------------------------------------------------------

Runtime | Problems | Export

--------------------------------------------------------
```

Everything happens within this workspace.

No modal editors.

No wizard screens.

No disconnected tools.

---

# Canvas

The Canvas is the source of truth.

Everything is edited directly on the artwork.

Atlas displays editable overlays:

* Artwork
* Collision
* Occlusion
* Guides
* Grid
* Runtime

These are editor layers.

Not engine layers.

Switching overlays changes what the brush edits.

The workspace itself never changes.

---

# Inspector

The Inspector edits object metadata.

Examples:

* Name
* Category
* Tags
* Variants
* Anchor
* Gameplay Behavior
* Export Options

The Inspector never exposes Pokémon implementation details.

---

# Runtime Preview

The Runtime Preview is the centerpiece of Atlas.

Every object includes a miniature playable environment.

The runtime is **not** a physics engine.

It emulates Emerald movement rules exactly:

```text
16x16 grid movement

↓

Tile collision

↓

Priority

↓

Object overlap
```

No free movement.

No pixel collision.

If Emerald walks on a grid, Atlas walks on a grid.

A small player character can be moved using:

* Drag (snapped to grid)
* Keyboard (WASD / Arrow Keys)

The runtime immediately reflects:

* Collision
* Occlusion
* Rendering priority
* Anchor placement
* Object dimensions

As the user paints collision...

The player stops.

As the user paints occlusion...

The player walks behind leaves, roofs or bridges.

This becomes the primary validation tool.

The artist validates gameplay - not generated assets.

If the preview would behave differently from the GBA, the preview is wrong.

---

# Object Model

Projects contain Objects.

Objects contain:

* Artwork
* Metadata
* Anchor
* Collision Layer
* Occlusion Layer
* Variants
* Children

Objects know nothing about engine formats.

---

# Anchor

The Anchor is:

> The world-space point where the object is attached to the map.

Equivalent to a Unity Pivot or a Godot Origin.

Everything derives from it:

* Placement
* Child transforms
* Runtime positioning

The Anchor snaps to the 16px metatile grid.

A free-floating anchor would allow placements the engine cannot honor.

This is enforced at authoring time (Object validity).

---

# Scene Graph

Objects form a Scene Graph.

Children inherit transforms.

Children may override metadata.

Example:

```text
House

├── Roof

├── Door

├── Window

├── Window

├── Fence

└── Flowers
```

The exporter flattens the graph.

Atlas never does.

---

# Semantic Layers

Atlas exposes only semantic layers.

* Artwork
* Collision
* Occlusion
* Guides
* Grid
* Runtime

Concepts such as:

* Top Layer
* Middle Layer
* Bottom Layer

never appear within the editor.

They are exporter responsibilities.

---

# Collision

Collision is painted directly, on the 16x16 grid.

The engine resolves collision per metatile, so Atlas paints per metatile.

Supported values:

* Walkable
* Blocked
* Custom

Custom opens a dropdown of semantic tags:

* Tall Grass
* Water
* Warp
* Ledge
* Counter
* ...

**The tag vocabulary is supplied by the engine plugin, not by Atlas Core.**

Core knows only that a collision cell carries an opaque semantic tag.

The Pokémon plugin provides the tag list and owns the mapping to behavior values.

Core never learns what a ledge is.

---

# Occlusion

Occlusion is painted directly.

The meaning is simple:

> "The player should appear behind this."

The exporter determines how this is represented within the target engine.

How that translation works - and when it cannot - is the subject of `compiler.md`.

---

# Variants

Objects support variants.

Example:

Tree

* Summer
* Autumn
* Winter
* Dead

Variants share metadata.

Only artwork changes.

---

# Tilesets

A Tileset is a named collection of Objects compiled together.

Example:

```text
Forest Tileset

├── Tree A

├── Tree B

├── Flowers

├── Grass

└── Rock
```

The Tileset Builder continuously computes:

* Palette usage
* Tile usage
* Metatile usage

Budgets are defined by the engine plugin.

Budget meters live in the Tileset view, never in the Object editor.

An artist creating an Object never sees an engine budget.

An artist assembling a Tileset always does.

---

# Validity Tiers

Atlas distinguishes three tiers of validity.

This distinction is what lets Atlas hide engine constraints during authoring while still surfacing them at the right moment.

## Tier 1: Object Validity

Authoring-time.

Is the object internally coherent?

* Artwork dimensions align to the 16px grid
* Anchor is set and grid-snapped
* Collision and occlusion masks are well-formed

An invalid Object is fixed on the Canvas.

## Tier 2: Tileset Validity

Compile-time.

Do these Objects fit together within the engine's shared budgets?

* Palette budget
* Tile budget
* Metatile budget

Computed continuously by the Tileset Builder.

A Tileset error is never presented as an Object error.

The fix is at the Tileset level: remove an object, share a palette, simplify artwork.

## Tier 3: Export Validity

Round-trip-time.

Did the native toolchain accept our output?

* Porytiles compiled without errors
* Output loads in Porymap

Every toolchain error is mapped back to a Tileset-level diagnostic in artist terms.

Raw compiler output never reaches the Problems panel.

---

# Export Architecture

Atlas exports through plugins.

```text
Tileset

↓

Exporter Plugin

↓

Intermediate Project

↓

Native Toolchain

↓

Validation

↓

Finished Assets
```

Atlas never generates final engine assets directly.

The exporter also emits a Compiled Object artifact per Object:

```text
tree.atlasobject
```

The Compiled Object records how the Object maps onto the generated assets.

It is the stable intermediate that future integrations consume.

Porymap prefab emission is one projection of it (see `compiler.md`).

---

# Pokémon Plugin

The Pokémon plugin is responsible for:

* Flattening Scene Graphs
* Building Tilesets within budgets
* Generating a Porytiles project
* Invoking Porytiles
* Validating output
* Mapping toolchain errors to artist-facing diagnostics
* Producing assets ready for Porymap
* Providing the collision tag vocabulary
* Providing the budget definitions

Porytiles remains the canonical compiler.

Atlas remains the canonical authoring experience.

---

# Engineering Principles

Keep the core small.

Prefer composition over inheritance.

Everything is undoable.

Everything is autosaved.

Compilation is deterministic.

The compiler should be pure.

Plugins own engine complexity.

Avoid hidden state.

Prefer readable code over clever code.

Optimize developer experience over premature optimization.

---

# Non Goals

Atlas will never replace:

* Aseprite
* Photoshop
* Porytiles
* Porymap

Atlas complements them.

**Explicit MVP non-goals:**

* Tile animation (water, flowers). Animated objects export as static artwork in MVP.
* Map editing. Maps are a post-MVP concept.
* A generic plugin API. The Pokémon exporter is built concretely first; the API is extracted when a second engine target exists.

---

# Success Criteria

A brand-new contributor should be able to:

1. Import a PNG.
2. Paint collision.
3. Paint occlusion.
4. Move the player around the object.
5. Verify gameplay visually.
6. Add the object to a Tileset.
7. Click Export.
8. Open Porymap.
9. Place the object's metatiles immediately.

Without ever learning:

* Metatiles (beyond placing them)
* Layer PNGs
* Tile priorities
* Tile IDs
* Behavior tables

**Known MVP limitation:** in Porymap the user places generated metatiles, not Objects. If the Porymap prefab investigation (Spike 0) pans out, exported Objects become placeable as single prefabs and this limitation disappears.

If a user never needs to discover engine concepts, Atlas has achieved its goal.
