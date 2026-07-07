# Public Beta Checklist

The state of Porygon at the MVP public-beta line: what is built, what is
deliberately left out, and the release work that lives outside this milestone.

## Done - the 15 milestones

1. **M1 Project Skeleton** - Tauri 2 + React + Vite shell with a dark, docked
   panel layout that launches.
2. **M2 Project System** - JSON project format (one directory per project),
   save, load, autosave, and recent projects.
3. **M3 Canvas** - PNG import, zoom, pan, 8px and 16px pixel grids, and object
   selection on a PixiJS canvas.
4. **M4 Object Model** - Objects (name, artwork, anchor, UUID), an Object library
   (import, delete, rename, duplicate), on a command-based undo foundation.
5. **M5 Inspector** - live metadata editing (name, category, tags, anchor) with
   no dialogs.
6. **M6 Collision Layer** - per-metatile collision painting (Walkable, Blocked,
   Custom), the Custom tag vocabulary supplied by the engine module, and the
   start of Tier 1 Object validity.
7. **M7 Occlusion Layer** - occlusion painting with brush, erase, visibility
   toggle, and preview.
8. **M8 Runtime Preview** - a grid-locked player with Emerald movement rules,
   per-metatile collision response, occlusion rendering, camera, and reset.
9. **M9 Tilesets** - Tileset CRUD, continuous palette/tile/metatile budget
   meters, and Tier 2 Tileset diagnostics in artist terms.
10. **M10 Pokemon Exporter** - the `compiler.md` decomposition to a Porytiles
    source tree plus one `.atlasobject` per Object, byte-identical across runs.
11. **M11 Porytiles Integration** - version-pinned Porytiles invocation, error
    capture and parsing, Tier 3 mapping to artist-facing diagnostics, the
    Problems panel wired to all three tiers, and Porymap prefab emission.
12. **M12 Scene Graph** - object parenting, hierarchy, child transforms,
    selection, exporter flattening, and cycle refusal.
13. **M13 Variants** - create, duplicate, switch, and delete artwork variants
    that share metadata.
14. **M14 Polish** - keyboard shortcuts, context menus, drag-and-drop import,
    multi-select, tooltips, Preferences, and a command palette.
15. **M15 Public Beta** - this milestone: stability audit and fixes,
    documentation (this file, `README.md`, `docs/troubleshooting.md`),
    performance sanity, and the version surface. A hardening milestone, not a
    feature milestone.

## Deliberately deferred

These are out of scope for the MVP by design, not oversights.

**From `compiler.md` residual risks:**

- **Runtime occlusion visual.** The layer-type data is verified, but the actual
  "player walks behind the canopy" frame has not been observed in an emulator.
  Low risk (core engine behavior); confirm once by running the spike tileset in
  a ROM.
- **In-app Porymap prefab check.** The prefab format is source-verified against
  Porymap; a live in-app check awaits a Porymap install.
- (`import-tileset` / `decompile-tileset` being broken in Porytiles 1.0.0 is
  tracked upstream and is irrelevant to the export path, which uses
  `create-tileset`.)

**Budget model simplifications (Tier 2):**

- **Primary-palette sharing.** Porygon targets a secondary tileset and budgets it
  in isolation. It does not model sharing colors or tiles with the primary
  tileset to reclaim budget.
- **`fieldmap.h` budget reading.** The engine constants (7 palettes, 512 tiles,
  512 metatiles, 15 colors per tile) are the verified vanilla values baked in
  from Spike 0. Porygon does not read the target project's `include/fieldmap.h`,
  so a decomp with modified constants is not accounted for.

**Bible non-goals:**

- **Tile animation** (water, flowers). Animated objects export as static
  artwork in the MVP.
- **Maps inside Porygon.** Map editing stays in Porymap; it is a post-MVP
  concept.
- **A generic multi-engine plugin API.** The Pokemon exporter is built
  concretely; the API is extracted only when a second engine target exists.

## Release blockers outside this milestone

These are required to ship but are explicitly not part of M15. Tracked in
GitHub issue #20:

- **Real bundle identifier and app icon.** Replace the placeholder identity and
  icon set before a public release.
- **CI Rust job.** Add a Rust job to `ci.yml` so the crate is checked, tested,
  and linted on every change.
- **release-please Atlas entry.** Add an `atlas` package entry
  (`release-type: rust`, `include-component-in-tag: true`) so Porygon is
  versioned independently of the porygon MCP plugin.

Do not perform the release work as part of this milestone; it is listed here so
it is not forgotten.
