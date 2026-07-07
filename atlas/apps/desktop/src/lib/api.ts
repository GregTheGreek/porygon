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
// to: 'Object' (Tier 1, authoring) or 'Tileset' (Tier 2, budgets). Mirrors
// validity.rs.
export type Problem = {
  tier: 'Object' | 'Tileset';
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

// Mirrors the serde structs in crates/atlas/src/project.rs. Rust owns the
// schema; these types just describe what crosses the IPC boundary.
export type Project = {
  format_version: number;
  name: string;
  created: number;
  modified: number;
  objects: AtlasObject[];
  tilesets: Tileset[];
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

/// Read an Object's stored artwork (base64 + dimensions) for the Canvas.
export async function readObjectArtwork(
  projectPath: string,
  id: string,
): Promise<Artwork> {
  return invoke<Artwork>('read_object_artwork', { projectPath, id });
}

/// The custom collision-tag vocabulary from the pokemon_emerald engine module.
/// Populates the Custom-tag dropdown; never hardcoded in the frontend.
export async function getCollisionTags(): Promise<CollisionTag[]> {
  return invoke<CollisionTag[]>('collision_tags');
}

/// Tier 1 (Object) validity problems for an Object, in artist terms.
export async function getObjectProblems(object: AtlasObject): Promise<Problem[]> {
  return invoke<Problem[]>('object_problems', { object });
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
