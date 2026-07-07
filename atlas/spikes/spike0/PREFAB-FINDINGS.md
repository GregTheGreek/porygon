# Porymap Prefab Feature - Research Findings

Research date: 2026-07-07. Source of truth: Porymap `master` branch source code (fetched raw from github.com) and official docs. Local copies of fetched sources in `porymap-src/` next to this file.

## 1. Version history and stability

**Confirmed:**

- Prefabs were introduced in **Porymap 5.0.0 (2022-10-30)**. Changelog entry under 5.0.0 "Added": "Add prefab support".
  Source: https://github.com/huderlem/porymap/blob/master/CHANGELOG.md
- The latest release at time of research is **6.3.1 (2026-04-12)** (top of the same changelog), and the prefab implementation (`src/ui/prefab.cpp`, `include/ui/prefab.h`) is present and actively maintained on `master`. The changelog's only prefab "Added" entry is the 5.0.0 one; no format-breaking prefab changes are called out in later versions.
- The official manual documents prefabs as a normal, supported feature: "Prefabs, or 'prefabricated selections', are a way to optimize your map-editing workflow by defining pre-built metatile selections."
  Source: https://huderlem.github.io/porymap/manual/editing-map-tiles.html

**Inference:** the on-disk format appears stable since 5.0.0 - the default prefab resources (`resources/text/prefabs_default_emerald.json` etc.) shipped with master use exactly the schema below, and the loader is tolerant (skips unknown/invalid entries rather than erroring). I did not diff the 5.0.0 tag against master field-by-field.

## 2. On-disk format

**Confirmed** from `Prefab::loadPrefabs()` / `Prefab::savePrefabs()` in
https://github.com/huderlem/porymap/blob/master/src/ui/prefab.cpp

### Location

- Per-project, a single JSON file. Default path: `prefabs.json` in the project root.
  - Source (prefab.cpp line 19): `const QString defaultFilepath = "prefabs.json";`
  - Relative paths are resolved against the project directory: `filepath = QDir::cleanPath(projectConfig.projectDir() + QDir::separator() + filepath);`
  - Docs: "Prefab data is saved to a JSON file. It defaults to `<project_root>/prefabs.json`." (https://huderlem.github.io/porymap/manual/editing-map-tiles.html)

### Schema

The file is a **top-level JSON array** (not an object) of prefab objects:

```json
[
  {
    "name": "string (optional, may be empty)",
    "width": 1,
    "height": 1,
    "primary_tileset": "gTileset_General or empty string",
    "secondary_tileset": "gTileset_Petalburg or empty string",
    "metatiles": [
      {
        "x": 0,
        "y": 0,
        "metatile_id": 40,
        "collision": 0,
        "elevation": 3
      }
    ]
  }
]
```

Field semantics, from the loader (prefab.cpp lines 46-86):

| Field | Type | Rules |
|---|---|---|
| `width`, `height` | int | Prefab dimensions in metatiles. Entry is **silently skipped** if `width <= 0 || height <= 0`. |
| `name` | string | Display name. May be empty. |
| `primary_tileset` | string | Tileset label (e.g. `gTileset_General`). Empty string = "matches any primary tileset". |
| `secondary_tileset` | string | Same, for the secondary tileset. |
| `metatiles` | array | **Sparse** cell list. Cells not listed stay disabled (transparent - they do not paint). 23 of the 71 default emerald prefabs are sparse. |
| `metatiles[].x`, `.y` | int | Position within the prefab grid. Cell skipped if out of `[0, width)` x `[0, height)`. |
| `metatiles[].metatile_id` | int | Skipped if `< 0` or `>= Project::getNumMetatilesTotal()`. |
| `metatiles[].collision` | int | Collision value painted with the cell. Missing key parses as 0. |
| `metatiles[].elevation` | int | Elevation painted with the cell. Missing key parses as 0. |

There is no grid/2D array representation - the layout is expressed entirely by the per-cell `x`/`y` coordinates. There are no `id`, `version`, or wrapper-object fields anywhere in the format (verified against all 71 entries in `resources/text/prefabs_default_emerald.json`: prefab keys are exactly `{name, width, height, primary_tileset, secondary_tileset, metatiles}`, metatile keys exactly `{x, y, metatile_id, collision, elevation}`).
Source: https://github.com/huderlem/porymap/blob/master/resources/text/prefabs_default_emerald.json

Integer parsing goes through `ParseUtil::jsonToInt` -> `gameStringToInt` -> `QString::toInt(ok, 0)`, so on master a JSON **string** like `"0x200"` is also accepted for numeric fields (base-0 parse). The default files and Porymap's own writer use plain decimal JSON numbers; emit decimal numbers for safety.
Source: https://github.com/huderlem/porymap/blob/master/src/core/parseutil.cpp (`jsonToInt`, `gameStringToInt`).

## 3. Pointing Porymap at the file

**Confirmed:** setting lives in **`porymap.project.cfg`** (the shared, version-controllable project config), key `prefabs_filepath`. There is also `prefabs_import_prompted` (bool) which records whether the "import default prefabs?" dialog was already shown.

From https://github.com/huderlem/porymap/blob/master/src/config.cpp:

```cpp
} else if (key == "prefabs_filepath") {
    this->prefabFilepath = value;
} else if (key == "prefabs_import_prompted") {
    this->prefabImportPrompted = getConfigBool(key, value);
...
map.insert("prefabs_filepath", this->prefabFilepath);
map.insert("prefabs_import_prompted", QString::number(this->prefabImportPrompted));
```

Docs (https://huderlem.github.io/porymap/manual/settings-and-options.html): "`Prefabs Path` is the file path to a `.json` file that contains definitions of prefabs. ... If no path is specified prefabs will be saved to a new `prefabs.json` file in the root project folder." In the UI this is `Options > Project Settings... > General > Prefabs Path`.

Behavior when the key is **empty/missing**: `loadPrefabs()` returns immediately (no prefabs loaded); on first save, Porymap sets it to `prefabs.json`. So an external generator should both write the JSON file and ensure `prefabs_filepath=prefabs.json` (or your chosen path) is present in `porymap.project.cfg`, and ideally set `prefabs_import_prompted=1` to suppress the default-import dialog (see gotchas).

## 4. Tileset binding

**Confirmed** from `Prefab::getPrefabsForTilesets()` and `Prefab::addPrefab()` (prefab.cpp lines 148-160, 260-284):

- A prefab carries a `primary_tileset` and a `secondary_tileset` label. A prefab is shown for the currently open layout only if each non-empty label **exactly matches** the layout's corresponding tileset label. Empty string is a wildcard:
  ```cpp
  // Prefabs are only valid for the tileset(s) from which they were created.
  // If, say, no metatiles in the prefab are from the primary tileset, then
  // any primary tileset is valid for that prefab.
  if ((item.primaryTileset.isEmpty() || item.primaryTileset == primaryTileset) &&
      (item.secondaryTileset.isEmpty() || item.secondaryTileset == secondaryTileset))
  ```
- Docs agree: "Prefabs are designated for whichever primary and secondary tilesets were used to create them. As such, any prefabs using tilesets that are incompatible with the currently-opened map will be hidden from the Prefab list." (https://huderlem.github.io/porymap/manual/editing-map-tiles.html)
- **Yes, prefabs can reference secondary-tileset metatiles.** Metatile IDs `>= Project::getNumMetatilesPrimary()` are secondary-tileset metatiles; when Porymap itself creates a prefab it sets the tileset fields based on the ID ranges actually used:
  ```cpp
  if (metatile.metatileId < Project::getNumMetatilesPrimary()) {
      usesPrimaryTileset = true;
  } else if (metatile.metatileId < Project::getNumMetatilesTotal()) {
      usesSecondaryTileset = true;
  }
  ```
  For a default pokeemerald project the primary/secondary boundary is 512 (0x200), so IDs 0x200 and up are secondary. These bounds are project-configurable in modern Porymap (`getNumMetatilesTotal()` is `Block::getMaxMetatileId() + 1`, derived from the project's metatile ID mask; default total 1024). The shipped `prefabs_default_emerald.json` has secondary-only prefabs, e.g. "Player House" with `"secondary_tileset": "gTileset_Petalburg"` and metatile IDs 520+.
- Mixed prefabs (both tilesets) are fine: both fields are then non-empty and both must match.

## 5. Gotchas for external generation

**Confirmed:**

1. **Porymap rewrites the whole file.** `savePrefabs()` re-serializes every prefab from memory and overwrites the file whenever a prefab is added or deleted in the UI. Consequences:
   - JSON comments, custom formatting, and any extra/unknown fields you add will be **lost** on the first UI edit.
   - Porymap's writer emits keys in the order `name, width, height, primary_tileset, secondary_tileset, metatiles` and cells row-major (y outer, x inner); do not rely on your own ordering surviving.
   - Hex-string IDs would be rewritten as decimal numbers.
2. **No id fields, no versioning.** The `QUuid id` in `PrefabItem` is generated fresh at load time (`QUuid::createUuid()`) and never persisted. Do not emit an `id` field; it would be ignored and dropped. There is no schema-version field, and the loader does no version check.
3. **Silent skipping, not errors.** Invalid entries (non-positive dims, out-of-range coords, out-of-range metatile IDs) are dropped without any message. Only a non-array/empty file produces a log warning ("Prefabs array is empty or missing"). Validate your output yourself; Porymap will not tell you which entry it rejected.
4. **Metatile ID bounds are project-dependent.** `metatile_id >= Project::getNumMetatilesTotal()` cells are dropped at load. If the target project has customized `NUM_METATILES_IN_PRIMARY` or the metatile ID mask, the primary/secondary boundary and total differ from vanilla 512/1024.
5. **Tileset labels must match exactly** (string comparison against `layout->tileset_primary_label` / `tileset_secondary_label`, e.g. `gTileset_General`). A typo makes the prefab invisible for every map, with no warning.
6. **Default-import prompt.** If `prefabs_import_prompted` is not set to `1` in `porymap.project.cfg`, Porymap will ask the user to import default prefabs the first time the Prefabs tab is opened, and accepting **overwrites** the file at `prefabs_filepath` ("This will overwrite any existing prefabs in ..."). An external generator should set `prefabs_import_prompted=1` alongside `prefabs_filepath`.
7. **Collision/elevation are painted too.** Prefab painting is not tiles-only: each enabled cell carries `collision` and `elevation` that get stamped onto the map (`selection.hasCollision = true` is forced at load). Emit sensible values (vanilla convention: passable ground is collision 0 / elevation 3; impassable is collision 1).
8. **Sparse cells are a feature.** Omitting a cell from `metatiles` makes it transparent (nothing painted there), which is exactly right for irregular objects like trees overlapping other terrain.

**Inference (not verified by running Porymap):** because `loadPrefabs()` runs at project open / prefab UI init only, edits to `prefabs.json` made while Porymap has the project open will not be picked up until reload, and could be clobbered by a subsequent in-UI prefab add/delete. Generate the file while Porymap is closed, or accept last-writer-wins.

## Example: 2x3 tree prefab (secondary tileset, metatiles 0x200-0x205)

A 2-wide, 3-tall tree using hypothetical secondary-tileset metatiles 0x200-0x205 (decimal 512-517) from a custom secondary tileset `gTileset_MyForest`. Canopy rows are passable-behind (collision 0), trunk row is solid (collision 1). `primary_tileset` is empty because no primary metatiles are used, so the prefab appears for any map whose secondary tileset is `gTileset_MyForest`.

```json
[
  {
    "name": "Big Tree",
    "width": 2,
    "height": 3,
    "primary_tileset": "",
    "secondary_tileset": "gTileset_MyForest",
    "metatiles": [
      { "x": 0, "y": 0, "metatile_id": 512, "collision": 0, "elevation": 0 },
      { "x": 1, "y": 0, "metatile_id": 513, "collision": 0, "elevation": 0 },
      { "x": 0, "y": 1, "metatile_id": 514, "collision": 0, "elevation": 0 },
      { "x": 1, "y": 1, "metatile_id": 515, "collision": 0, "elevation": 0 },
      { "x": 0, "y": 2, "metatile_id": 516, "collision": 1, "elevation": 0 },
      { "x": 1, "y": 2, "metatile_id": 517, "collision": 1, "elevation": 0 }
    ]
  }
]
```

(512 = 0x200 ... 517 = 0x205. Decimal is what Porymap itself writes; hex strings like `"0x200"` parse on current master but are not future-proof and get rewritten to decimal.)

And in `porymap.project.cfg`:

```
prefabs_filepath=prefabs.json
prefabs_import_prompted=1
```

## Source index

- Changelog (versions): https://github.com/huderlem/porymap/blob/master/CHANGELOG.md
- Loader/writer (schema of record): https://github.com/huderlem/porymap/blob/master/src/ui/prefab.cpp
- Data model: https://github.com/huderlem/porymap/blob/master/include/ui/prefab.h
- Config keys: https://github.com/huderlem/porymap/blob/master/src/config.cpp
- Shipped example data: https://github.com/huderlem/porymap/blob/master/resources/text/prefabs_default_emerald.json
- Int parsing: https://github.com/huderlem/porymap/blob/master/src/core/parseutil.cpp
- Metatile bounds: https://github.com/huderlem/porymap/blob/master/include/project.h
- Manual, prefabs section: https://huderlem.github.io/porymap/manual/editing-map-tiles.html
- Manual, project settings: https://huderlem.github.io/porymap/manual/settings-and-options.html
