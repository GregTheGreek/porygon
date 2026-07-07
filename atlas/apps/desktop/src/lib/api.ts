import { invoke } from '@tauri-apps/api/core';
import { open as openDialog } from '@tauri-apps/plugin-dialog';

// Mirrors the serde structs in crates/atlas/src/object.rs. Anchor stays on the
// 16px grid: Rust snaps the import default; Inspector edits snap in the store
// via the same round-to-nearest rule (see snapToGrid in store/project.ts).
export type Anchor = {
  x: number;
  y: number;
};

// One collision cell's value. Mirrors CollisionValue in crates/atlas/src/
// collision.rs (serde external tagging: unit variants are plain strings, the
// tagged variant is an object). `Walkable` is only used as a paint/erase value;
// it is never stored in the sparse map (its absence means Walkable).
export type CollisionValue = 'Walkable' | 'Blocked' | { Custom: string };

// Painted collision on the 16px grid. Sparse: only non-Walkable cells, keyed by
// row-major cell index (as a string, since JSON object keys are strings).
export type Collision = { cells: Record<string, CollisionValue> };

// Painted occlusion at pixel granularity. Mirrors Occlusion in crates/atlas/src/
// occlusion.rs (serde BTreeSet<u32> -> JSON array). Sparse: only occluding pixel
// indices (row-major y*width+x). Absence means "renders in front of the player".
export type Occlusion = { pixels: number[] };

// One child instance placed on an Object (M12). Mirrors ChildPlacement in
// crates/atlas/src/object.rs: `object_id` references another Object; `x`/`y`
// are the signed offset in pixels (16px-grid-snapped) from the parent's anchor
// to the child's anchor. Translation only.
export type ChildPlacement = {
  object_id: string;
  x: number;
  y: number;
};

// One named artwork variant of an Object (M13). Mirrors Variant in
// crates/atlas/src/object.rs. Only the artwork changes between variants; all
// metadata, collision, occlusion, children, and dimensions are shared.
export type Variant = {
  id: string;
  name: string;
};

// A reusable authoring Object. Metadata only; artwork pixels live on disk under
// the project's `objects/<id>/` directory and are fetched via readObjectArtwork.
export type AtlasObject = {
  id: string;
  name: string;
  width: number;
  height: number;
  anchor: Anchor;
  category: string;
  tags: string[];
  collision: Collision;
  occlusion: Occlusion;
  children: ChildPlacement[];
  // Named artwork variants (M13). Never empty; `active_variant` is the id of the
  // one shown on the canvas and consumed by budgets, export, and play.
  variants: Variant[];
  active_variant: string;
};

// A direct child's flattened footprint in composed space, for the canvas
// selection highlight. Mirrors ChildFootprint in crates/atlas/src/scene.rs;
// index-aligned with the parent's `children` (null = missing object).
export type ChildFootprint = {
  object_id: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

// The composed view of one Object for the canvas (M12): flattened artwork as
// base64 PNG plus composed collision/occlusion, the anchor and the parent's
// origin in composed space. Mirrors ComposedObject in crates/atlas/src/scene.rs.
export type ComposedObject = {
  width: number;
  height: number;
  anchor: Anchor;
  origin_x: number;
  origin_y: number;
  art_data: string;
  collision: Collision;
  occlusion: Occlusion;
  children: (ChildFootprint | null)[];
};

// One entry in the engine's custom collision-tag vocabulary (from the
// pokemon_emerald module). `tag` is the opaque id stored on a Custom cell;
// `behavior` is the MB_* name it compiles to (shown for reference only).
export type CollisionTag = {
  tag: string;
  label: string;
  behavior: string;
};

// A validity problem, in artist terms. `tier` is the validity tier it belongs
// to: 'Object' (Tier 1, authoring), 'Tileset' (Tier 2, budgets), or 'Export'
// (Tier 3, a mapped Porytiles outcome). Mirrors validity.rs.
export type Problem = {
  tier: 'Object' | 'Tileset' | 'Export';
  message: string;
};

// A named, ordered set of member Object ids compiled together. Mirrors
// tileset.rs. An Object id may appear in several Tilesets (membership is a
// reference, not ownership).
export type Tileset = {
  id: string;
  name: string;
  members: string[];
};

// A usage meter (used against total). Over budget when used > total.
export type Meter = { used: number; total: number };

// The tile meter carries a range: used_min is the flip-aware count Porytiles
// actually emits; used_max is the flip-naive upper bound (compiler.md).
export type TileMeter = { used_min: number; used_max: number; total: number };

// The Tier 2 budget report for one tileset. Mirrors budgets.rs TilesetBudget.
export type TilesetBudget = {
  palettes: Meter;
  tiles: TileMeter;
  metatiles: Meter;
  problems: Problem[];
};

// Result of a tileset export: the directory the artifacts were written to.
// Mirrors ExportResult in crates/atlas/src/exporter.rs.
export type ExportResult = { path: string };

// App-level settings. Mirrors settings.rs. `porytiles_path` null = use default.
export type Settings = { porytiles_path: string | null };

// Result of checking the Porytiles binary. Mirrors porytiles.rs BinaryStatus.
export type BinaryStatus = {
  ok: boolean;
  path: string;
  version: string | null;
  message: string;
};

// Where prefabs were written and how many. Mirrors prefabs.rs PrefabResult.
export type PrefabResult = { prefabs_path: string; written: number };

// Outcome of a Porytiles compile. Mirrors porytiles.rs CompileResult. On
// success `problems` is empty and the written paths are populated; on a
// toolchain failure `problems` holds the Tier 3 diagnostics and `details`
// carries the raw compiler report (shown only in an expander, never as the
// primary message).
export type CompileResult = {
  success: boolean;
  primary_symbol: string;
  secondary_symbol: string;
  tileset_bin_dir: string | null;
  prefabs: PrefabResult | null;
  problems: Problem[];
  details: string | null;
};

// Mirrors the serde structs in crates/atlas/src/project.rs. Rust owns the
// schema; these types just describe what crosses the IPC boundary.
export type Project = {
  format_version: number;
  name: string;
  created: number;
  modified: number;
  objects: AtlasObject[];
  tilesets: Tileset[];
  // Target decomp project directory for Porytiles compilation (M11), persisted
  // so re-compiles are one click. null until the artist picks one.
  compile_target: string | null;
};

export type OpenProject = {
  path: string;
  project: Project;
};

export type Recent = {
  path: string;
  name: string;
};

// A validated PNG read for the Canvas. `data` is base64 of the raw file;
// build a `data:image/png;base64,${data}` URL to display it. Session-scoped:
// nothing is persisted (Objects, M4, own artwork).
export type Artwork = {
  name: string;
  width: number;
  height: number;
  data: string;
};

/// Reads the crate version from the Rust side. Proves the IPC bridge works.
export async function getAppVersion(): Promise<string> {
  return invoke<string>('app_version');
}

/// Create `<location>/<name>` on disk and open it.
export async function createProject(
  location: string,
  name: string,
): Promise<OpenProject> {
  return invoke<OpenProject>('create_project', { location, name });
}

/// Open an existing project directory.
export async function openProject(dir: string): Promise<OpenProject> {
  return invoke<OpenProject>('open_project', { dir });
}

/// Persist project state; returns it with a refreshed `modified` timestamp.
export async function saveProject(
  path: string,
  project: Project,
): Promise<Project> {
  return invoke<Project>('save_project', { path, project });
}

/// Recent projects, most-recent-first, with dead paths already pruned.
export async function getRecentProjects(): Promise<Recent[]> {
  return invoke<Recent[]>('get_recent_projects');
}

/// Native directory picker. Returns null if the user cancels.
export async function pickDirectory(title: string): Promise<string | null> {
  const result = await openDialog({ directory: true, multiple: false, title });
  return typeof result === 'string' ? result : null;
}

/// Native file picker (no extension filter), for choosing an executable such
/// as the Porytiles binary. Returns null if the user cancels.
export async function pickFile(title: string): Promise<string | null> {
  const result = await openDialog({ directory: false, multiple: false, title });
  return typeof result === 'string' ? result : null;
}

/// Native PNG file picker. Returns null if the user cancels.
export async function pickPngFile(): Promise<string | null> {
  const result = await openDialog({
    multiple: false,
    title: 'Import PNG artwork',
    filters: [{ name: 'PNG image', extensions: ['png'] }],
  });
  return typeof result === 'string' ? result : null;
}

/// Read, validate, and load a PNG through Rust (no fs plugin needed).
export async function readArtwork(path: string): Promise<Artwork> {
  return invoke<Artwork>('read_artwork', { path });
}

/// Import a PNG as a new Object; copies the artwork into the project directory.
export async function importObject(
  projectPath: string,
  sourcePng: string,
  name: string,
): Promise<AtlasObject> {
  return invoke<AtlasObject>('import_object', { projectPath, sourcePng, name });
}

/// Duplicate an Object (new UUID, copied artwork). Rust returns the new Object.
export async function duplicateObject(
  projectPath: string,
  source: AtlasObject,
): Promise<AtlasObject> {
  return invoke<AtlasObject>('duplicate_object', { projectPath, source });
}

/// Soft-delete an Object's artwork directory (moved to `.trash`, undoable).
export async function trashObject(projectPath: string, id: string): Promise<void> {
  return invoke<void>('trash_object', { projectPath, id });
}

/// Restore a soft-deleted Object's artwork directory (undo of a delete).
export async function restoreObject(projectPath: string, id: string): Promise<void> {
  return invoke<void>('restore_object', { projectPath, id });
}

/// Read an Object variant's stored artwork (base64 + dimensions) for the
/// Canvas. `variantId` selects the variant (M13); pass the object's active one.
export async function readObjectArtwork(
  projectPath: string,
  id: string,
  variantId: string,
): Promise<Artwork> {
  return invoke<Artwork>('read_object_artwork', { projectPath, id, variantId });
}

/// Import a PNG as a new variant of `object` (M13). Copies the artwork into the
/// project and returns the new Variant. Rejects (throws) a size mismatch.
export async function importVariant(
  projectPath: string,
  object: AtlasObject,
  sourcePng: string,
  name: string,
): Promise<Variant> {
  return invoke<Variant>('import_variant', { projectPath, object, sourcePng, name });
}

/// Duplicate one of `object`'s variants (M13); copies its artwork to a fresh
/// file and returns the new Variant.
export async function duplicateVariant(
  projectPath: string,
  object: AtlasObject,
  variantId: string,
  name: string,
): Promise<Variant> {
  return invoke<Variant>('duplicate_variant', { projectPath, object, variantId, name });
}

/// Remove a variant from `object` (M13), returning the updated Object. Throws
/// on the last variant; reassigns the active variant when the active one is
/// removed. The variant's PNG is left on disk (recoverable).
export async function deleteVariant(
  object: AtlasObject,
  variantId: string,
): Promise<AtlasObject> {
  return invoke<AtlasObject>('delete_variant', { object, variantId });
}

/// The custom collision-tag vocabulary from the pokemon_emerald engine module.
/// Populates the Custom-tag dropdown; never hardcoded in the frontend.
export async function getCollisionTags(): Promise<CollisionTag[]> {
  return invoke<CollisionTag[]>('collision_tags');
}

/// Tier 1 (Object) validity problems for an Object, in artist terms.
/// `objects` is the project's object list: the M12 cycle check follows
/// child references.
export async function getObjectProblems(
  object: AtlasObject,
  objects: AtlasObject[],
): Promise<Problem[]> {
  return invoke<Problem[]>('object_problems', { object, objects });
}

/// Compose an Object with its children for the canvas (M12). The in-memory
/// project is passed so unsaved edits are composed too; only the immutable
/// artwork pixels are read from disk. Same flattening path as budgets/export.
export async function composeObject(
  projectPath: string,
  project: Project,
  objectId: string,
): Promise<ComposedObject> {
  return invoke<ComposedObject>('compose_object', { projectPath, project, objectId });
}

/// Mint a fresh, empty Tileset (new UUID minted in Rust, like Object import).
export async function createTileset(name: string): Promise<Tileset> {
  return invoke<Tileset>('create_tileset', { name });
}

/// Tier 2 budget prediction for one tileset: palette/tile/metatile meters plus
/// budget problems in artist terms. Reads member artwork from disk, so the
/// caller must persist the project first (see store computeTilesetBudget).
export async function getTilesetBudget(
  projectPath: string,
  tilesetId: string,
): Promise<TilesetBudget> {
  return invoke<TilesetBudget>('tileset_budget', { projectPath, tilesetId });
}

/// Export a tileset's Porytiles source tree plus .atlasobject artifacts into
/// `<destDir>/<tileset-slug>/`. Refuses without writing anything when the
/// tileset has validity problems. Writes outside the project; not undoable.
export async function exportTileset(
  projectPath: string,
  tilesetId: string,
  destDir: string,
): Promise<ExportResult> {
  return invoke<ExportResult>('export_tileset', { projectPath, tilesetId, destDir });
}

/// The persisted app settings (currently just the Porytiles binary path).
export async function getSettings(): Promise<Settings> {
  return invoke<Settings>('get_settings');
}

/// Override the Porytiles binary path (pass null to clear back to default).
export async function setPorytilesPath(path: string | null): Promise<Settings> {
  return invoke<Settings>('set_porytiles_path', { path });
}

/// Check the configured Porytiles binary: present and exactly the pinned
/// version? Drives the compile-readiness UI. Never throws for a bad binary.
export async function verifyPorytiles(): Promise<BinaryStatus> {
  return invoke<BinaryStatus>('verify_porytiles');
}

/// Compile a tileset with Porytiles into the target decomp project (M11):
/// export -> create/compile -> prefabs. Returns success with written paths or a
/// mapped Tier 3 problem. Throws only for pre-flight failures (bad binary,
/// Tier 1/2 gate, filesystem). The caller persists the project first.
export async function compileTileset(
  projectPath: string,
  tilesetId: string,
  decompDir: string,
): Promise<CompileResult> {
  return invoke<CompileResult>('compile_tileset', { projectPath, tilesetId, decompDir });
}
