# Atlas Implementation Plan

> Build Atlas in small, fully functional milestones.
>
> Every milestone should produce a working application.
>
> Atlas should always remain in a shippable state.

Version: 1.1

> **Naming:** Atlas is the internal codename. The product ships as **Porygon**.

Changes from 1.0:

* Spike 0 is the first coding task, before any application code
* Project system (save/load) moved from Milestone 10 to Milestone 2
* Undo made foundational (Milestone 4), not a per-feature deliverable
* Tilesets added as a milestone (compile primitive)
* Export path moved before Scene Graph and Variants (riskiest work first)
* Generic plugin system removed from MVP; pokemon_emerald is built concretely
* Crate layout simplified from five crates to one, plus the frontend

---

# Philosophy

The Bible defines **what** Atlas should become.

`compiler.md` defines the **math** of the export path.

This document defines **how** we get there.

The implementation strategy follows a few simple rules:

* Build the smallest useful thing first.
* De-risk the hardest problem before building on top of it.
* Never build speculative architecture.
* Prefer working software over perfect abstractions.
* Keep the feedback loop under a few seconds.
* Every milestone should be demoable.

The architecture should evolve naturally as the product evolves.

---

# Definition of Done

Every milestone must:

* Compile
* Be testable by a human
* Include automated tests where practical
* Update documentation if required
* Not break previous functionality

No incomplete features.

No TODO-driven architecture.

---

# Repository Structure

Atlas is a subpackage of the **porygon** repository, which also contains the porygon MCP plugin (Python, under `mcp/`). Adding Atlas makes the repo mixed Python + Rust.

```text
porygon/                    existing repo (Claude Code plugin + MCP server)

    mcp/                    existing Python package "porygon" (unchanged)

    atlas/                  the Atlas subpackage

        apps/
            desktop/        React + TypeScript + Vite + PixiJS + Tauri shell

        crates/
            atlas/          single Rust crate
                            - project model + serialization (serde)
                            - filesystem
                            - process spawning (Porytiles)
                            - pokemon_emerald module (engine logic)

        spikes/
            spike0/         disposable; never imported by real code

        plans/              bible.md, implementation.md, compiler.md

        examples/
```

One frontend. One Rust crate.

Deferred to Milestone 1+ (config only, do not do early): `ci.yml` gains a Rust job, and `release-please-config.json` gains an `atlas` package entry (`release-type: rust`, `include-component-in-tag: true`) so Atlas releases are versioned independently of the plugin.

`pokemon_emerald` starts as a **module** inside the crate, not a plugin.

It is extracted into a plugin API only when a second engine target exists.

Split the crate only when it hurts, not before.

---

# Technology

Desktop

* Tauri

Frontend

* React
* TypeScript
* Vite

Canvas

* PixiJS

State

* Zustand

Backend

* Rust (one crate)

Serialization

* serde

Project Files

* JSON, one directory per project

Testing

* Vitest
* Rust unit tests

No database.

Projects remain filesystem based.

---

# MVP Goal

By the end of MVP a user should be able to:

* Import artwork
* Create reusable Objects
* Paint collision
* Paint occlusion
* Move a grid-locked player around
* Assemble Objects into a Tileset with live budget meters
* Export to Pokémon
* Place the generated metatiles in Porymap

Nothing more.

---

# Spike 0

## End-to-End Proof

**Status: DONE (2026-07-07).** Findings in `../spikes/spike0/FINDINGS.md`; `compiler.md` is at v1.0. Deferred confirmations (tracked as compiler.md Residual Risks): runtime occlusion visual in an emulator, and the in-app Porymap prefab check.

**This is the first coding task. Not the app.**

Hardcoded. Ugly. Disposable. Lives in `spikes/spike0/`, never imported by real code.

Goal

Prove the export path exists before building ten milestones on top of it.

Steps

```text
Hardcoded tree PNG + hand-written masks

↓

Hand-written exporter (throwaway script)

↓

Porytiles

↓

Porymap
```

Exit criteria

1. Hand-decompose one tree into Porytiles input layers plus attributes, guided by the rules drafted in `compiler.md`.
2. Invoke Porytiles headlessly; capture its full CLI surface and error output.
3. Load the generated tileset in Porymap and place the tree.
4. Test one Porymap prefab entry; confirm or reject the prefab emission path.
5. Confirm or correct every "verify in Spike 0" constraint listed in `compiler.md`.
6. Verify the generated output against a real pokeemerald project using the porygon MCP tools (`read_metatile_attributes`, `read_blockdata`, `build`).

Deliverable

The updated `compiler.md`, not code.

Every open question in `compiler.md` marked "Spike 0" gets an answer.

If the spike reveals the decomposition model is wrong, we fix the plan now, for the cost of a week instead of a quarter.

---

# Milestone 1

## Project Skeleton

Goal

Create a clean desktop application.

Deliverables

* Tauri project
* React frontend
* Rust backend (single crate)
* Basic layout
* Dark theme
* Docked panels

Success

Application launches.

---

# Milestone 2

## Project System

Goal

Save work from day one.

Everything that follows creates data; none of it should be losable.

Deliverables

* Project file format (JSON, one directory per project)
* Save
* Load
* Autosave
* Recent Projects

Success

Projects survive restart.

The file format decision is made now, while migrating is cheap.

---

# Milestone 3

## Canvas

Goal

Display artwork.

Deliverables

* PNG import
* Zoom
* Pan
* Pixel grid (8px and 16px)
* Object selection

Success

Users can inspect artwork naturally.

---

# Milestone 4

## Object Model

Goal

Introduce Objects, on an undoable foundation.

Deliverables

Object

* Name
* Artwork
* Metadata
* Anchor (16px grid-snapped)
* UUID

Object Library

* Import
* Delete
* Rename
* Duplicate

Undo system

* Command-based or immutable-state; chosen now, applied to every future edit

Success

Projects contain reusable Objects.

Every mutation is undoable.

---

# Milestone 5

## Inspector

Goal

Metadata editing.

Deliverables

Editable

* Name
* Category
* Tags
* Anchor

Live updates.

Success

No dialogs required.

---

# Milestone 6

## Collision Layer

Goal

Paint collision on the engine's grid.

Deliverables

* Collision overlay, 16x16 cells
* Values: Walkable / Blocked / Custom
* Custom tag dropdown, vocabulary supplied by the pokemon_emerald module
* Brush and erase
* Visibility toggle

Success

Collision stored with object, at metatile granularity.

Object validity checks (Tier 1) begin here.

---

# Milestone 7

## Occlusion Layer

Goal

Paint render intent.

Deliverables

* Occlusion overlay
* Brush and erase
* Visibility toggle
* Preview

Success

Object now contains full gameplay semantics.

---

# Milestone 8

## Runtime Preview

Goal

Playable preview that matches Emerald.

Deliverables

* Player sprite
* Grid-locked 16px movement (no free movement, no pixel collision)
* Collision response per metatile
* Occlusion rendering
* Camera
* Reset

Success

Users validate gameplay visually.

If the preview would behave differently from the GBA, the preview is wrong.

This milestone is the first "wow" moment.

---

# Milestone 9

## Tilesets

Goal

Introduce the compile primitive.

Deliverables

* Create / rename / delete Tilesets
* Add / remove Objects
* Tileset Builder computing continuously:
  * Palette usage
  * Tile usage
  * Metatile usage
* Budget meters in the Tileset view
* Tileset validity diagnostics (Tier 2), in artist terms

Success

Ten Objects that fit individually but not together produce a clear Tileset-level error, before export is ever attempted.

---

# Milestone 10

## Pokémon Exporter

Goal

Implement `compiler.md`.

Deliverables

```text
Tileset

↓

Decomposition (per compiler.md)

↓

Porytiles project on disk

↓

Compiled Object artifacts (.atlasobject)
```

Success

Generated Porytiles project mirrors what a human expert would author by hand.

Deterministic: same input produces byte-identical output.

---

# Milestone 11

## Porytiles Integration

Goal

Close the export loop.

Deliverables

* Invoke Porytiles (version-pinned)
* Capture and parse errors
* Map every toolchain error to a Tileset-level diagnostic in artist terms (Tier 3)
* Problems panel wired to all three validity tiers
* Porymap prefab emission, if Spike 0 confirmed the path

Success

Export produces assets that load in Porymap.

Raw compiler output never reaches the artist.

---

# Milestone 12

## Scene Graph

Goal

Objects contain children.

Deliverables

* Parenting
* Hierarchy
* Transforms
* Selection
* Exporter flattening

Success

Complex objects become possible.

---

# Milestone 13

## Variants

Goal

Support artwork variations.

Deliverables

* Create Variant
* Duplicate
* Switch
* Delete
* Shared metadata

Success

Seasonal assets become trivial.

---

# Milestone 14

## Polish

Goal

Professional editor experience.

Deliverables

* Keyboard shortcuts
* Context menus
* Drag and drop
* Multi-select
* Tooltips
* Preferences
* Command palette

Success

Atlas feels cohesive.

---

# Milestone 15

## Public Beta

Goal

Ship.

Requirements

* Stable
* Documented
* Export compatible
* Responsive
* Reliable

Ready for community feedback.

---

# Post-MVP (explicitly deferred)

* Generic plugin API - extracted from pokemon_emerald when a second engine target exists
* Tile animation
* Maps inside Atlas
* Direct Porymap integration beyond prefabs

---

# Engineering Rules

Never duplicate engine logic.

Push engine-specific behavior into the engine module.

Prefer composition.

Keep files small.

Avoid unnecessary abstraction.

Every feature should reduce complexity.

If something makes Atlas feel more like a ROM hacking tool -

it is probably the wrong abstraction.

---

# Coding Agent Guidelines

Model convention: dev/implementation agents run on **Opus**; planning, architecture, and review run on **Fable**.

When implementing:

Always prefer simple implementations.

Avoid creating generic systems before there are multiple use cases.

Write code that another engineer can understand in five minutes.

Optimize only after measuring.

Leave clear extension points but avoid speculative architecture.

Every pull request should improve the product in a visible way.

---

# Immediate Next Task

**Milestone 1: Project Skeleton.**

Spike 0 is complete; `compiler.md` v1.0 is the contract the exporter (Milestone 10) implements.

Continue sequentially through the roadmap.

The implementation should continuously reflect the Atlas Bible rather than attempting to predict every future requirement.
