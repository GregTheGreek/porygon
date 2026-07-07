import { create } from 'zustand';
import * as api from '../lib/api';
import type {
  Anchor,
  AtlasObject,
  Collision,
  CollisionValue,
  CompileResult,
  ComposedObject,
  ExportResult,
  Occlusion,
  OpenProject,
  Recent,
  Tileset,
  TilesetBudget,
} from '../lib/api';
import { useCanvasStore } from './canvas';
import { useHistory } from './history';
import { usePreferences } from './preferences';

// Reflects whether the on-disk copy is up to date with the in-memory one.
export type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

// Which inline name field is currently being edited (M14). Set by a keyboard
// shortcut (F2/Enter) or a context menu; the owning row/field watches this and
// enters edit mode. View state, never persisted.
export type RenameTarget =
  | { kind: 'object'; id: string }
  | { kind: 'tileset'; id: string }
  | { kind: 'variant'; objectId: string; variantId: string };

// Modifiers on an Object Library click, deciding how the multi-selection set
// changes (M14). `meta` is cmd/ctrl (toggle), `shift` is a range extend.
export type ClickModifiers = { meta: boolean; shift: boolean };

// Fallback autosave debounce if preferences have not loaded yet.
const AUTOSAVE_DELAY_MS = 1000;

// Derive a default object name from a PNG path (basename without extension).
function fileStem(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? 'Object';
  return base.replace(/\.png$/i, '') || 'Object';
}

// Mirrors `snap` in crates/atlas/src/object.rs: round a pixel coordinate to the
// nearest 16px metatile-grid line (Rust integer division = floor for u32).
const GRID = 16;
const snapToGrid = (v: number) => Math.floor((v + GRID / 2) / GRID) * GRID;

const clamp = (v: number, lo: number, hi: number) =>
  Math.min(Math.max(v, lo), hi);

// Editor bound for a child placement offset, in pixels. Keeps the composed
// bounding box comfortably inside the Rust-side composition cap (scene.rs);
// an input bound like the anchor clamp, not a validity rule.
const CHILD_OFFSET_LIMIT = 1024;

// True when placing `childId` under `parentId` would make an object contain
// itself, directly or transitively: parentId reachable from childId through
// children. Mirrors the Rust guards (scene.rs flatten, validity.rs Tier 1);
// this is the mutation-path enforcement - the edit is refused outright.
export function wouldCreateCycle(
  objects: AtlasObject[],
  parentId: string,
  childId: string,
): boolean {
  if (parentId === childId) return true;
  const byId = new Map(objects.map((o) => [o.id, o]));
  const stack = [childId];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (id === parentId) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const c of byId.get(id)?.children ?? []) stack.push(c.object_id);
  }
  return false;
}

// Composed-space -> parent-space index mapping for paint strokes (M12). When
// children are shown, the canvas paints on the COMPOSED grid, but painted
// data always lives on the parent object's own grid, so stroke indices
// translate back through the parent's origin in composed space. Indices
// outside the parent's footprint are dropped (the engine's paint bounds
// already prevent them; this is the mapping-side backstop).
function mapComposedCells(
  composed: ComposedObject,
  obj: AtlasObject,
  indices: number[],
): number[] {
  const compCols = Math.ceil(composed.width / GRID);
  const parentCols = Math.ceil(obj.width / GRID);
  const parentRows = Math.ceil(obj.height / GRID);
  const offCol = Math.floor(composed.origin_x / GRID);
  const offRow = Math.floor(composed.origin_y / GRID);
  const out: number[] = [];
  for (const i of indices) {
    const col = (i % compCols) - offCol;
    const row = Math.floor(i / compCols) - offRow;
    if (col < 0 || row < 0 || col >= parentCols || row >= parentRows) continue;
    out.push(row * parentCols + col);
  }
  return out;
}

function mapComposedPixels(
  composed: ComposedObject,
  obj: AtlasObject,
  indices: number[],
): number[] {
  const out: number[] = [];
  for (const i of indices) {
    const x = (i % composed.width) - composed.origin_x;
    const y = Math.floor(i / composed.width) - composed.origin_y;
    if (x < 0 || y < 0 || x >= obj.width || y >= obj.height) continue;
    out.push(y * obj.width + x);
  }
  return out;
}

type ProjectState = {
  open: OpenProject | null;
  recents: Recent[];
  status: SaveStatus;
  error: string | null;

  // Which object's artwork is shown on the Canvas. This is the PRIMARY
  // selection: the Canvas and Inspector always follow it. Selection is view
  // state and is deliberately not undoable.
  selectedObjectId: string | null;
  // The full multi-selection set (M14), including the primary. Bulk operations
  // (delete, add-to-tileset) act on this whole set; the single-selection
  // Canvas/Inspector flow reads `selectedObjectId` (the last-clicked member).
  // Always kept consistent: `selectedObjectId` is null iff this is empty, and
  // whenever it is non-null it appears in this array.
  selectedObjectIds: string[];
  // The inline name field currently open for editing, or null (M14).
  renaming: RenameTarget | null;
  importing: boolean;

  // The composed view of the selected object when it has children (M12):
  // flattened artwork/collision/occlusion from Rust, the single source of
  // truth shared with budgets and export. Null when the selected object has
  // no children (the raw single-object path applies). View state.
  composed: ComposedObject | null;
  composeError: string | null;
  // Index into the selected object's `children` whose footprint is
  // highlighted on the canvas. View state, not undoable.
  selectedChildIndex: number | null;

  // Which Tileset is open in the Builder (center region). Mutually exclusive
  // with an object selection: opening one clears the other. View state, not
  // undoable.
  selectedTilesetId: string | null;

  // Tier 2/3 derived state for the selected tileset, lifted into the store so
  // the Tileset Builder and the shared Problems panel read one source of truth.
  // Cleared whenever the selection or membership changes (would be stale).
  budget: TilesetBudget | null;
  budgetComputing: boolean;
  budgetError: string | null;
  compileResult: CompileResult | null;
  compiling: boolean;
  compileError: string | null;

  loadRecents: () => Promise<void>;
  createProject: (location: string, name: string) => Promise<void>;
  openProject: (dir: string) => Promise<void>;
  close: () => void;
  rename: (name: string) => void;
  // Flush any pending debounced save immediately (cmd+S / palette). Resolves
  // once the on-disk copy is up to date.
  saveNow: () => Promise<void>;

  selectObject: (id: string | null) => Promise<void>;
  // A click in the Object Library, applying the multi-select rules (M14). Plain
  // click replaces the selection; cmd/ctrl toggles; shift extends a range.
  clickObject: (id: string, mods: ClickModifiers) => Promise<void>;
  // Move the primary selection up/down the library list (keyboard nav, M14).
  selectAdjacentObject: (delta: number) => void;
  beginRename: (target: RenameTarget) => void;
  endRename: () => void;
  importObject: () => Promise<void>;
  // Import a PNG at a known path (Finder file-drop, M14). Rejects non-PNG paths
  // with a clear message and requires an open project.
  importObjectFromPath: (path: string) => Promise<void>;
  renameObject: (id: string, name: string) => void;
  duplicateObject: (id: string) => Promise<void>;
  deleteObject: (id: string) => Promise<void>;
  // Delete every object in the set as a sequence of undoable deletes (M14).
  bulkDeleteObjects: (ids: string[]) => Promise<void>;
  // Add every object in the set to a tileset (M14 bulk add-to-tileset).
  bulkAddToTileset: (tilesetId: string, ids: string[]) => void;

  // Variant edits (M13). All undoable, all through autosave. Only artwork
  // differs between variants; switching one changes the active artwork on the
  // canvas and everything downstream (budgets, export, play). Import/duplicate
  // touch the filesystem via Rust; switch/rename/delete are metadata edits.
  addVariant: (objectId: string) => Promise<void>;
  duplicateVariant: (objectId: string, variantId: string) => Promise<void>;
  switchVariant: (objectId: string, variantId: string) => void;
  renameVariant: (objectId: string, variantId: string, name: string) => void;
  deleteVariant: (objectId: string, variantId: string) => Promise<void>;

  // Inspector metadata edits (M5). All undoable.
  setObjectCategory: (id: string, category: string) => void;
  addObjectTag: (id: string, tag: string) => void;
  removeObjectTag: (id: string, tag: string) => void;
  setObjectAnchor: (id: string, x: number, y: number) => void;

  // Scene-graph edits (M12). All undoable, all through autosave. Placements
  // are addressed by index into the parent's `children`. addObjectChild
  // refuses a placement that would create a cycle.
  addObjectChild: (parentId: string, childObjectId: string) => void;
  removeObjectChild: (parentId: string, index: number) => void;
  setObjectChildOffset: (parentId: string, index: number, x: number, y: number) => void;
  // Highlight one child's footprint on the canvas. View state.
  selectChild: (index: number | null) => void;
  // Recompute the composed view for the selected object (null when it has no
  // children). Driven by the Canvas whenever project objects change.
  refreshComposed: () => Promise<void>;

  // Collision painting (M6). One command per brush stroke; the Canvas engine
  // reports the cells a stroke touched and the value to apply.
  paintCollision: (id: string, indices: number[], value: CollisionValue) => void;

  // Occlusion painting (M7). Same stroke-batched shape as collision; the Canvas
  // engine reports the pixel indices a stroke touched and whether they become
  // occluding (true) or erased (false).
  paintOcclusion: (id: string, indices: number[], occluding: boolean) => void;

  // Tileset CRUD + membership (M9). All undoable, all through autosave. A
  // Tileset owns no files, so these are plain list edits (no Rust round-trip
  // except minting the UUID, for parity with Object import).
  selectTileset: (id: string | null) => void;
  createTileset: () => Promise<void>;
  renameTileset: (id: string, name: string) => void;
  deleteTileset: (id: string) => void;
  addTilesetMember: (tilesetId: string, objectId: string) => void;
  removeTilesetMember: (tilesetId: string, objectId: string) => void;
  // Reorder members within a tileset (M14 drag-to-reorder). Order matters for
  // layout, so this is an undoable project edit like the other membership ops.
  reorderTilesetMember: (tilesetId: string, from: number, to: number) => void;

  // Persist the project, then compute the Tier 2 budget for a tileset and store
  // it. Saving first is required: the Rust budget command reads member artwork
  // and the saved membership from disk, so it must see the latest state. Guards
  // against a stale write when the selection changes mid-flight.
  refreshTilesetBudget: (tilesetId: string) => Promise<void>;

  // Persist the project, then export the tileset to a destination directory
  // (M10). Not undoable: export writes outside the project and never touches
  // project data, so nothing lands in the history stack.
  exportTileset: (tilesetId: string, destDir: string) => Promise<ExportResult>;

  // The persisted per-project compile target (a decomp project directory).
  // Plain project edit + save; not undoable (it is a target, not content).
  setCompileTarget: (dir: string) => void;

  // Persist the project, then compile the tileset with Porytiles into the
  // stored compile target (M11): export -> create/compile -> prefabs. Stores
  // the mapped result; a pre-flight throw (bad binary etc.) lands in
  // compileError. Not undoable: it writes outside the project.
  compileTileset: (tilesetId: string) => Promise<void>;
};

export const useProjectStore = create<ProjectState>((set, get) => {
  // Debounce timer for autosave, kept in the closure rather than in state so a
  // pending save never triggers a re-render.
  let saveTimer: ReturnType<typeof setTimeout> | null = null;

  // Monotonic ticket for compose requests, so an older in-flight result can
  // never overwrite a newer one (strokes can queue several recomposes).
  let composeSeq = 0;

  const flushSave = async () => {
    const current = get().open;
    if (!current) return;
    set({ status: 'saving' });
    try {
      const project = await api.saveProject(current.path, current.project);
      set((s) => ({
        status: 'saved',
        error: null,
        open: s.open ? { ...s.open, project } : null,
      }));
    } catch (e) {
      set({ status: 'error', error: String(e) });
    }
  };

  const scheduleSave = () => {
    if (saveTimer) clearTimeout(saveTimer);
    // Debounce is a preference (M14); fall back to the shipped default until
    // preferences load.
    const delay = usePreferences.getState().settings.autosave_debounce_ms || AUTOSAVE_DELAY_MS;
    saveTimer = setTimeout(() => {
      void flushSave();
    }, delay);
  };

  // Persist immediately, superseding any pending debounced save, and return the
  // saved project. Used before Rust calls that read the project from disk
  // (budget, export, compile), so they always see the latest membership.
  const persistNow = async () => {
    const current = get().open;
    if (!current) return null;
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    const project = await api.saveProject(current.path, current.project);
    set((s) => ({ open: s.open ? { ...s.open, project } : null }));
    return project;
  };

  // Reload the canvas artwork for a shown object after its active variant
  // changed (M13). A childless object reads its active variant directly; an
  // object with children re-composes (composeObject reads the active variant
  // per object). No-op when the object is not the one on the canvas.
  const reloadActiveArtwork = async (objectId: string) => {
    if (get().selectedObjectId !== objectId) return;
    const current = get().open;
    const obj = current?.project.objects.find((o) => o.id === objectId);
    if (!current || !obj) return;
    if (obj.children.length > 0) {
      await get().refreshComposed();
      return;
    }
    try {
      const art = await api.readObjectArtwork(current.path, objectId, obj.active_variant);
      if (get().selectedObjectId !== objectId) return;
      useCanvasStore.getState().setArtwork({
        objectId,
        name: obj.name,
        width: art.width,
        height: art.height,
        url: `data:image/png;base64,${art.data}`,
      });
    } catch (e) {
      set({ error: String(e) });
    }
  };

  // Load an object's artwork onto the Canvas and make it the primary selection,
  // without touching the multi-selection set (its callers own that). Opening an
  // object closes any open Tileset Builder (the centre is one view).
  const showObject = async (id: string | null) => {
    set({
      selectedObjectId: id,
      selectedTilesetId: id === null ? get().selectedTilesetId : null,
      composed: null,
      composeError: null,
      selectedChildIndex: null,
    });
    const canvas = useCanvasStore.getState();
    if (id === null) {
      canvas.setArtwork(null);
      return;
    }
    const current = get().open;
    const obj = current?.project.objects.find((o) => o.id === id);
    if (!current || !obj) {
      canvas.setArtwork(null);
      return;
    }
    // An object with children shows COMPOSED: refreshComposed (driven by the
    // Canvas whenever objects or the selection change) supplies the artwork, so
    // the raw read is skipped to avoid a flash of the parent alone.
    if (obj.children.length > 0) return;
    try {
      const art = await api.readObjectArtwork(current.path, id, obj.active_variant);
      // Guard against a fast re-selection while the read was in flight.
      if (get().selectedObjectId !== id) return;
      useCanvasStore.getState().setArtwork({
        objectId: id,
        name: obj.name,
        width: art.width,
        height: art.height,
        url: `data:image/png;base64,${art.data}`,
      });
    } catch (e) {
      set({ error: String(e) });
    }
  };

  // Shared import path for the Import button and Finder file-drop. Copies the
  // PNG into the project as a new Object, selects it, and pushes the undo.
  const importObjectFrom = async (source: string) => {
    const current = get().open;
    if (!current) return;
    set({ importing: true, error: null });
    try {
      const obj = await api.importObject(current.path, source, fileStem(source));
      addObject(obj);
      scheduleSave();
      await get().selectObject(obj.id);
      useHistory.getState().push({
        label: 'Import object',
        undo: async () => {
          await api.trashObject(current.path, obj.id);
          removeObject(obj.id);
          scheduleSave();
        },
        redo: async () => {
          await api.restoreObject(current.path, obj.id);
          addObject(obj);
          scheduleSave();
          await get().selectObject(obj.id);
        },
      });
    } catch (e) {
      set({ error: String(e) });
    } finally {
      set({ importing: false });
    }
  };

  // --- Object list mutators. Pure state edits; callers schedule the save and
  // push the undo command. Object metadata lives inside open.project.objects,
  // so editing it and saving the project persists everything in one write.

  const addObject = (obj: AtlasObject) =>
    set((s) =>
      s.open
        ? {
            open: {
              ...s.open,
              project: {
                ...s.open.project,
                objects: [...s.open.project.objects, obj],
              },
            },
          }
        : s,
    );

  const insertObjectAt = (obj: AtlasObject, index: number) =>
    set((s) => {
      if (!s.open) return s;
      const objects = [...s.open.project.objects];
      objects.splice(index, 0, obj);
      return { open: { ...s.open, project: { ...s.open.project, objects } } };
    });

  const removeObject = (id: string) => {
    set((s) =>
      s.open
        ? {
            open: {
              ...s.open,
              project: {
                ...s.open.project,
                objects: s.open.project.objects.filter((o) => o.id !== id),
              },
            },
          }
        : s,
    );
    // Drop the id from the multi-selection set and close any rename of it.
    set((s) => ({
      selectedObjectIds: s.selectedObjectIds.filter((x) => x !== id),
      renaming:
        s.renaming?.kind === 'object' && s.renaming.id === id ? null : s.renaming,
    }));
    // Deleting the shown object clears the Canvas and selection.
    if (get().selectedObjectId === id) {
      set({ selectedObjectId: null });
      useCanvasStore.getState().setArtwork(null);
    }
  };

  const patchObject = (id: string, patch: Partial<AtlasObject>) =>
    set((s) =>
      s.open
        ? {
            open: {
              ...s.open,
              project: {
                ...s.open.project,
                objects: s.open.project.objects.map((o) =>
                  o.id === id ? { ...o, ...patch } : o,
                ),
              },
            },
          }
        : s,
    );

  const setObjectName = (id: string, name: string) => {
    patchObject(id, { name });
    // Keep the Canvas label in sync when the shown object is renamed.
    const canvas = useCanvasStore.getState();
    if (get().selectedObjectId === id && canvas.artwork) {
      canvas.setArtwork({ ...canvas.artwork, name });
    }
  };

  // Shared shape of every metadata edit: apply, schedule the autosave, and
  // push an undo command that re-applies or reverses the same patch.
  const commitPatch = (
    label: string,
    id: string,
    previous: Partial<AtlasObject>,
    next: Partial<AtlasObject>,
  ) => {
    patchObject(id, next);
    scheduleSave();
    useHistory.getState().push({
      label,
      undo: () => {
        patchObject(id, previous);
        scheduleSave();
      },
      redo: () => {
        patchObject(id, next);
        scheduleSave();
      },
    });
  };

  // --- Tileset list mutators, paralleling the object ones. Tilesets live in
  // open.project.tilesets, so editing them and saving persists in one write.

  const addTileset = (tileset: Tileset) =>
    set((s) =>
      s.open
        ? {
            open: {
              ...s.open,
              project: {
                ...s.open.project,
                tilesets: [...s.open.project.tilesets, tileset],
              },
            },
          }
        : s,
    );

  const insertTilesetAt = (tileset: Tileset, index: number) =>
    set((s) => {
      if (!s.open) return s;
      const tilesets = [...s.open.project.tilesets];
      tilesets.splice(index, 0, tileset);
      return { open: { ...s.open, project: { ...s.open.project, tilesets } } };
    });

  const removeTileset = (id: string) => {
    set((s) =>
      s.open
        ? {
            open: {
              ...s.open,
              project: {
                ...s.open.project,
                tilesets: s.open.project.tilesets.filter((t) => t.id !== id),
              },
            },
          }
        : s,
    );
    if (get().selectedTilesetId === id) set({ selectedTilesetId: null });
  };

  const patchTileset = (id: string, patch: Partial<Tileset>) =>
    set((s) =>
      s.open
        ? {
            open: {
              ...s.open,
              project: {
                ...s.open.project,
                tilesets: s.open.project.tilesets.map((t) =>
                  t.id === id ? { ...t, ...patch } : t,
                ),
              },
            },
          }
        : s,
    );

  // Drop the Tier 2/3 derived state: it belongs to one tileset+membership and
  // is stale the moment either changes.
  const clearTilesetDerived = () =>
    set({
      budget: null,
      budgetComputing: false,
      budgetError: null,
      compileResult: null,
      compiling: false,
      compileError: null,
    });

  // Leaving a project: drop objects, selection, undo history, and the Canvas.
  const resetSession = () => {
    useHistory.getState().clear();
    useCanvasStore.getState().clear();
    clearTilesetDerived();
    set({
      selectedObjectId: null,
      selectedObjectIds: [],
      renaming: null,
      selectedTilesetId: null,
      importing: false,
      composed: null,
      composeError: null,
      selectedChildIndex: null,
    });
  };

  return {
    open: null,
    recents: [],
    status: 'idle',
    error: null,
    selectedObjectId: null,
    selectedObjectIds: [],
    renaming: null,
    importing: false,
    composed: null,
    composeError: null,
    selectedChildIndex: null,
    selectedTilesetId: null,
    budget: null,
    budgetComputing: false,
    budgetError: null,
    compileResult: null,
    compiling: false,
    compileError: null,

    loadRecents: async () => {
      try {
        set({ recents: await api.getRecentProjects() });
      } catch (e) {
        set({ error: String(e) });
      }
    },

    createProject: async (location, name) => {
      try {
        const open = await api.createProject(location, name);
        resetSession();
        set({ open, status: 'saved', error: null });
        await get().loadRecents();
      } catch (e) {
        set({ error: String(e) });
      }
    },

    openProject: async (dir) => {
      try {
        const open = await api.openProject(dir);
        resetSession();
        set({ open, status: 'saved', error: null });
        await get().loadRecents();
      } catch (e) {
        set({ error: String(e) });
      }
    },

    close: () => {
      // Flush a pending autosave before leaving so no edit is lost.
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
        const current = get().open;
        // Best-effort final flush. The session is torn down regardless; swallow
        // so a failed write cannot surface as an unhandled rejection after the
        // project is already gone from the UI.
        if (current) {
          void api
            .saveProject(current.path, current.project)
            .catch(() => undefined);
        }
      }
      resetSession();
      set({ open: null, status: 'idle', error: null });
    },

    rename: (name) => {
      set((s) =>
        s.open
          ? {
              open: { ...s.open, project: { ...s.open.project, name } },
              status: 'idle',
            }
          : s,
      );
      scheduleSave();
    },

    saveNow: async () => {
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
      }
      await flushSave();
    },

    selectObject: async (id) => {
      // A programmatic single-select collapses the multi-selection to just this
      // object (or clears it). The multi-select path is clickObject.
      set({ selectedObjectIds: id === null ? [] : [id] });
      await showObject(id);
    },

    clickObject: async (id, mods) => {
      const objects = get().open?.project.objects ?? [];
      if (!objects.some((o) => o.id === id)) return;
      const currentIds = get().selectedObjectIds;
      const primary = get().selectedObjectId;

      let nextIds: string[];
      let nextPrimary: string | null;

      if (mods.meta) {
        // Toggle: add if absent (becomes primary), remove if present (primary
        // falls back to the last remaining member, or null).
        if (currentIds.includes(id)) {
          nextIds = currentIds.filter((x) => x !== id);
          nextPrimary = nextIds.at(-1) ?? null;
        } else {
          nextIds = [...currentIds, id];
          nextPrimary = id;
        }
      } else if (mods.shift) {
        // Range from the primary (anchor) to the clicked id, in list order.
        const order = objects.map((o) => o.id);
        const anchor = primary ?? id;
        const a = order.indexOf(anchor);
        const b = order.indexOf(id);
        const [lo, hi] = a <= b ? [a, b] : [b, a];
        nextIds = order.slice(lo, hi + 1);
        nextPrimary = id;
      } else {
        nextIds = [id];
        nextPrimary = id;
      }

      set({ selectedObjectIds: nextIds });
      await showObject(nextPrimary);
    },

    selectAdjacentObject: (delta) => {
      const objects = get().open?.project.objects ?? [];
      if (objects.length === 0) return;
      const cur = get().selectedObjectId;
      const idx = objects.findIndex((o) => o.id === cur);
      const nextIdx =
        idx === -1
          ? delta > 0
            ? 0
            : objects.length - 1
          : clamp(idx + delta, 0, objects.length - 1);
      const target = objects[nextIdx];
      if (target) void get().selectObject(target.id);
    },

    beginRename: (target) => set({ renaming: target }),
    endRename: () => set({ renaming: null }),

    importObject: async () => {
      if (!get().open) return;
      const source = await api.pickPngFile();
      if (!source) return;
      await importObjectFrom(source);
    },

    importObjectFromPath: async (path) => {
      if (!get().open) {
        set({ error: 'Open or create a project before importing artwork.' });
        return;
      }
      if (!/\.png$/i.test(path)) {
        set({ error: 'Only PNG files can be imported as objects.' });
        return;
      }
      await importObjectFrom(path);
    },

    renameObject: (id, name) => {
      const current = get().open;
      const obj = current?.project.objects.find((o) => o.id === id);
      if (!obj) return;
      const previous = obj.name;
      const next = name.trim();
      if (!next || next === previous) return;

      setObjectName(id, next);
      scheduleSave();
      useHistory.getState().push({
        label: 'Rename object',
        undo: () => {
          setObjectName(id, previous);
          scheduleSave();
        },
        redo: () => {
          setObjectName(id, next);
          scheduleSave();
        },
      });
    },

    duplicateObject: async (id) => {
      const current = get().open;
      const source = current?.project.objects.find((o) => o.id === id);
      if (!current || !source) return;
      try {
        const copy = await api.duplicateObject(current.path, source);
        addObject(copy);
        scheduleSave();
        await get().selectObject(copy.id);
        useHistory.getState().push({
          label: 'Duplicate object',
          undo: async () => {
            await api.trashObject(current.path, copy.id);
            removeObject(copy.id);
            scheduleSave();
          },
          redo: async () => {
            await api.restoreObject(current.path, copy.id);
            addObject(copy);
            scheduleSave();
            await get().selectObject(copy.id);
          },
        });
      } catch (e) {
        set({ error: String(e) });
      }
    },

    deleteObject: async (id) => {
      const current = get().open;
      if (!current) return;
      const index = current.project.objects.findIndex((o) => o.id === id);
      const obj = current.project.objects[index];
      if (!obj) return;
      // Snapshot tileset membership so a delete also scrubs the id from every
      // Tileset (bible: an Object may belong to several) and undo restores it.
      // Only tilesets that actually contained the id are captured/restored.
      const affected = current.project.tilesets
        .filter((t) => t.members.includes(id))
        .map((t) => ({ id: t.id, members: [...t.members] }));

      // Same story for child placements (M12): parents referencing the
      // deleted object lose those placements, and undo restores them.
      const affectedParents = current.project.objects
        .filter((o) => o.id !== id && o.children.some((c) => c.object_id === id))
        .map((o) => ({ id: o.id, children: [...o.children] }));

      const scrubMembership = () => {
        for (const t of affected) {
          patchTileset(
            t.id,
            { members: t.members.filter((m) => m !== id) },
          );
        }
        for (const p of affectedParents) {
          patchObject(p.id, {
            children: p.children.filter((c) => c.object_id !== id),
          });
        }
      };
      const restoreMembership = () => {
        for (const t of affected) patchTileset(t.id, { members: t.members });
        for (const p of affectedParents) {
          patchObject(p.id, { children: p.children });
        }
      };

      try {
        await api.trashObject(current.path, id);
        removeObject(id);
        scrubMembership();
        scheduleSave();
        useHistory.getState().push({
          label: 'Delete object',
          undo: async () => {
            await api.restoreObject(current.path, id);
            insertObjectAt(obj, index);
            restoreMembership();
            scheduleSave();
            await get().selectObject(id);
          },
          redo: async () => {
            await api.trashObject(current.path, id);
            removeObject(id);
            scrubMembership();
            scheduleSave();
          },
        });
      } catch (e) {
        set({ error: String(e) });
      }
    },

    bulkDeleteObjects: async (ids) => {
      // Sequential single deletes: each is its own undoable command (the
      // history model is per-command), so the artist undoes them one at a time.
      // Snapshot the ids first, since deleteObject prunes the selection set.
      for (const id of [...ids]) {
        await get().deleteObject(id);
      }
    },

    bulkAddToTileset: (tilesetId, ids) => {
      for (const id of ids) get().addTilesetMember(tilesetId, id);
    },

    addVariant: async (objectId) => {
      const current = get().open;
      const obj = current?.project.objects.find((o) => o.id === objectId);
      if (!current || !obj) return;
      const source = await api.pickPngFile();
      if (!source) return;
      set({ importing: true, error: null });
      try {
        // Rust validates the size matches and writes the variant PNG.
        const variant = await api.importVariant(current.path, obj, source, fileStem(source));
        const fresh = get().open?.project.objects.find((o) => o.id === objectId);
        if (!fresh) return;
        const prevVariants = fresh.variants;
        const prevActive = fresh.active_variant;
        const nextVariants = [...prevVariants, variant];
        const apply = (variants: typeof nextVariants, active: string) => {
          patchObject(objectId, { variants, active_variant: active });
          scheduleSave();
          void reloadActiveArtwork(objectId);
        };
        apply(nextVariants, variant.id);
        useHistory.getState().push({
          label: 'Add variant',
          undo: () => apply(prevVariants, prevActive),
          redo: () => apply(nextVariants, variant.id),
        });
      } catch (e) {
        set({ error: String(e) });
      } finally {
        set({ importing: false });
      }
    },

    duplicateVariant: async (objectId, variantId) => {
      const current = get().open;
      const obj = current?.project.objects.find((o) => o.id === objectId);
      const source = obj?.variants.find((v) => v.id === variantId);
      if (!current || !obj || !source) return;
      try {
        const variant = await api.duplicateVariant(
          current.path,
          obj,
          variantId,
          `${source.name} copy`,
        );
        const fresh = get().open?.project.objects.find((o) => o.id === objectId);
        if (!fresh) return;
        const prevVariants = fresh.variants;
        const prevActive = fresh.active_variant;
        const nextVariants = [...prevVariants, variant];
        const apply = (variants: typeof nextVariants, active: string) => {
          patchObject(objectId, { variants, active_variant: active });
          scheduleSave();
          void reloadActiveArtwork(objectId);
        };
        apply(nextVariants, variant.id);
        useHistory.getState().push({
          label: 'Duplicate variant',
          undo: () => apply(prevVariants, prevActive),
          redo: () => apply(nextVariants, variant.id),
        });
      } catch (e) {
        set({ error: String(e) });
      }
    },

    switchVariant: (objectId, variantId) => {
      const obj = get().open?.project.objects.find((o) => o.id === objectId);
      if (!obj || obj.active_variant === variantId) return;
      if (!obj.variants.some((v) => v.id === variantId)) return;
      const previous = obj.active_variant;
      const apply = (vid: string) => {
        patchObject(objectId, { active_variant: vid });
        scheduleSave();
        void reloadActiveArtwork(objectId);
      };
      apply(variantId);
      useHistory.getState().push({
        label: 'Switch variant',
        undo: () => apply(previous),
        redo: () => apply(variantId),
      });
    },

    renameVariant: (objectId, variantId, name) => {
      const obj = get().open?.project.objects.find((o) => o.id === objectId);
      const variant = obj?.variants.find((v) => v.id === variantId);
      if (!obj || !variant) return;
      const next = name.trim();
      if (!next || next === variant.name) return;
      const nextVariants = obj.variants.map((v) =>
        v.id === variantId ? { ...v, name: next } : v,
      );
      commitPatch('Rename variant', objectId, { variants: obj.variants }, { variants: nextVariants });
    },

    deleteVariant: async (objectId, variantId) => {
      const current = get().open;
      const obj = current?.project.objects.find((o) => o.id === objectId);
      // Refuse the last variant (mirrors the Rust guard, keeps the delete
      // button disabled).
      if (!current || !obj || obj.variants.length <= 1) return;
      const prevVariants = obj.variants;
      const prevActive = obj.active_variant;
      try {
        // Rust owns the rule (last-variant refusal, active reassignment) and
        // returns the updated object; the PNG is left on disk (recoverable).
        const updated = await api.deleteVariant(obj, variantId);
        const apply = (variants: typeof prevVariants, active: string) => {
          patchObject(objectId, { variants, active_variant: active });
          scheduleSave();
          void reloadActiveArtwork(objectId);
        };
        apply(updated.variants, updated.active_variant);
        useHistory.getState().push({
          label: 'Delete variant',
          undo: () => apply(prevVariants, prevActive),
          redo: () => apply(updated.variants, updated.active_variant),
        });
      } catch (e) {
        set({ error: String(e) });
      }
    },

    setObjectCategory: (id, category) => {
      const obj = get().open?.project.objects.find((o) => o.id === id);
      if (!obj) return;
      const next = category.trim();
      if (next === obj.category) return;
      commitPatch('Edit category', id, { category: obj.category }, { category: next });
    },

    addObjectTag: (id, tag) => {
      const obj = get().open?.project.objects.find((o) => o.id === id);
      if (!obj) return;
      const next = tag.trim();
      // Ignore empties and duplicates (exact match after trimming).
      if (!next || obj.tags.includes(next)) return;
      commitPatch('Add tag', id, { tags: obj.tags }, { tags: [...obj.tags, next] });
    },

    removeObjectTag: (id, tag) => {
      const obj = get().open?.project.objects.find((o) => o.id === id);
      if (!obj || !obj.tags.includes(tag)) return;
      commitPatch(
        'Remove tag',
        id,
        { tags: obj.tags },
        { tags: obj.tags.filter((t) => t !== tag) },
      );
    },

    setObjectAnchor: (id, x, y) => {
      const obj = get().open?.project.objects.find((o) => o.id === id);
      if (!obj || !Number.isFinite(x) || !Number.isFinite(y)) return;
      // Clamp to the artwork bounds first, then snap to the metatile grid
      // (matching Rust's snap(), which may land one grid line past the edge).
      const next: Anchor = {
        x: snapToGrid(clamp(Math.round(x), 0, obj.width)),
        y: snapToGrid(clamp(Math.round(y), 0, obj.height)),
      };
      if (next.x === obj.anchor.x && next.y === obj.anchor.y) return;
      commitPatch('Edit anchor', id, { anchor: obj.anchor }, { anchor: next });
    },

    addObjectChild: (parentId, childObjectId) => {
      const current = get().open;
      const obj = current?.project.objects.find((o) => o.id === parentId);
      if (!current || !obj) return;
      if (!current.project.objects.some((o) => o.id === childObjectId)) return;
      // Cycle guard: an object can never contain itself, directly or
      // transitively. The Rust flatten/validity guards back this up.
      if (wouldCreateCycle(current.project.objects, parentId, childObjectId)) return;
      // Default offset (0, 0): the child's anchor lands on the parent's.
      const next = [...obj.children, { object_id: childObjectId, x: 0, y: 0 }];
      commitPatch('Add child', parentId, { children: obj.children }, { children: next });
      set({ selectedChildIndex: next.length - 1 });
    },

    removeObjectChild: (parentId, index) => {
      const obj = get().open?.project.objects.find((o) => o.id === parentId);
      if (!obj || index < 0 || index >= obj.children.length) return;
      const next = obj.children.filter((_, i) => i !== index);
      commitPatch('Remove child', parentId, { children: obj.children }, { children: next });
      set({ selectedChildIndex: null });
    },

    setObjectChildOffset: (parentId, index, x, y) => {
      const obj = get().open?.project.objects.find((o) => o.id === parentId);
      const child = obj?.children[index];
      if (!obj || !child || !Number.isFinite(x) || !Number.isFinite(y)) return;
      // Clamp to the editor bound, then snap to the metatile grid (the same
      // round-to-nearest rule as the anchor; snapToGrid handles negatives).
      const nx = snapToGrid(clamp(Math.round(x), -CHILD_OFFSET_LIMIT, CHILD_OFFSET_LIMIT));
      const ny = snapToGrid(clamp(Math.round(y), -CHILD_OFFSET_LIMIT, CHILD_OFFSET_LIMIT));
      if (nx === child.x && ny === child.y) return;
      const next = obj.children.map((c, i) =>
        i === index ? { ...c, x: nx, y: ny } : c,
      );
      commitPatch('Move child', parentId, { children: obj.children }, { children: next });
    },

    selectChild: (index) => set({ selectedChildIndex: index }),

    refreshComposed: async () => {
      const current = get().open;
      const id = get().selectedObjectId;
      const obj = current?.project.objects.find((o) => o.id === id);
      if (!current || !id || !obj || obj.children.length === 0) {
        const hadComposed = get().composed !== null;
        set({ composed: null, composeError: null });
        // Losing the last child (remove, undo) drops back to raw artwork.
        if (hadComposed && current && id && obj) {
          try {
            const art = await api.readObjectArtwork(current.path, id, obj.active_variant);
            if (get().selectedObjectId !== id) return;
            useCanvasStore.getState().setArtwork({
              objectId: id,
              name: obj.name,
              width: art.width,
              height: art.height,
              url: `data:image/png;base64,${art.data}`,
            });
          } catch (e) {
            set({ error: String(e) });
          }
        }
        return;
      }
      const seq = ++composeSeq;
      try {
        const composed = await api.composeObject(current.path, current.project, id);
        if (seq !== composeSeq || get().selectedObjectId !== id) return;
        set({ composed, composeError: null });
        // Push the flattened artwork to the canvas only when the pixels
        // actually changed (paints change overlays, not artwork), so the
        // texture is not reloaded per stroke.
        const canvas = useCanvasStore.getState();
        const url = `data:image/png;base64,${composed.art_data}`;
        if (canvas.artwork?.url !== url || canvas.artwork?.objectId !== id) {
          canvas.setArtwork({
            objectId: id,
            name: obj.name,
            width: composed.width,
            height: composed.height,
            url,
          });
        }
      } catch (e) {
        if (seq === composeSeq && get().selectedObjectId === id) {
          set({ composeError: String(e), composed: null });
        }
      }
    },

    paintCollision: (id, indices, value) => {
      const obj = get().open?.project.objects.find((o) => o.id === id);
      if (!obj || indices.length === 0) return;

      // When the composed view is shown, the stroke arrives in composed-grid
      // indices; translate back to the parent's own grid (M12).
      const composed = get().selectedObjectId === id ? get().composed : null;
      if (composed) {
        indices = mapComposedCells(composed, obj, indices);
        if (indices.length === 0) return;
      }

      // A stroke is one undo step: snapshot the sparse map, apply every touched
      // cell, and commit before/after as a single command. The map is small
      // (only non-Walkable cells) so snapshotting the whole thing is cheap and
      // keeps undo trivially correct.
      const before = obj.collision?.cells ?? {};
      const after = { ...before };
      const erase = value === 'Walkable';
      for (const i of indices) {
        const key = String(i);
        if (erase) delete after[key];
        else after[key] = value;
      }

      const prev: Collision = { cells: before };
      const nextCollision: Collision = { cells: after };
      commitPatch('Paint collision', id, { collision: prev }, { collision: nextCollision });
    },

    paintOcclusion: (id, indices, occluding) => {
      const obj = get().open?.project.objects.find((o) => o.id === id);
      if (!obj || indices.length === 0) return;

      // Composed-pixel indices translate back to the parent's own pixel
      // space, mirroring paintCollision (M12).
      const composed = get().selectedObjectId === id ? get().composed : null;
      if (composed) {
        indices = mapComposedPixels(composed, obj, indices);
        if (indices.length === 0) return;
      }

      // A stroke is one undo step: snapshot the sparse pixel set, apply every
      // touched pixel, and commit before/after as a single command (mirrors
      // paintCollision). The set holds only occluding pixels, so adding puts an
      // index in and erasing removes it.
      const before = obj.occlusion?.pixels ?? [];
      const set = new Set(before);
      for (const i of indices) {
        if (occluding) set.add(i);
        else set.delete(i);
      }
      // Sort so the payload is stable regardless of stroke order; Rust's
      // BTreeSet normalises anyway, but a stable array keeps undo/redo diffs tidy.
      const after = [...set].sort((a, b) => a - b);

      const prev: Occlusion = { pixels: before };
      const nextOcclusion: Occlusion = { pixels: after };
      commitPatch('Paint occlusion', id, { occlusion: prev }, { occlusion: nextOcclusion });
    },

    selectTileset: (id) => {
      // Switching tilesets invalidates the Tier 2/3 derived state.
      if (id !== get().selectedTilesetId) clearTilesetDerived();
      // Opening a Tileset closes any open object (they share the center view).
      set({ selectedTilesetId: id });
      if (id !== null && get().selectedObjectId !== null) {
        set({ selectedObjectId: null });
        useCanvasStore.getState().setArtwork(null);
      }
    },

    createTileset: async () => {
      const current = get().open;
      if (!current) return;
      const count = current.project.tilesets.length;
      try {
        const tileset = await api.createTileset(`Tileset ${count + 1}`);
        addTileset(tileset);
        scheduleSave();
        get().selectTileset(tileset.id);
        useHistory.getState().push({
          label: 'Create tileset',
          undo: () => {
            removeTileset(tileset.id);
            scheduleSave();
          },
          redo: () => {
            addTileset(tileset);
            scheduleSave();
            get().selectTileset(tileset.id);
          },
        });
      } catch (e) {
        set({ error: String(e) });
      }
    },

    renameTileset: (id, name) => {
      const tileset = get().open?.project.tilesets.find((t) => t.id === id);
      if (!tileset) return;
      const next = name.trim();
      const previous = tileset.name;
      if (!next || next === previous) return;
      patchTileset(id, { name: next });
      scheduleSave();
      useHistory.getState().push({
        label: 'Rename tileset',
        undo: () => {
          patchTileset(id, { name: previous });
          scheduleSave();
        },
        redo: () => {
          patchTileset(id, { name: next });
          scheduleSave();
        },
      });
    },

    deleteTileset: (id) => {
      const current = get().open;
      const index = current?.project.tilesets.findIndex((t) => t.id === id) ?? -1;
      const tileset = current?.project.tilesets[index];
      if (!tileset) return;
      removeTileset(id);
      scheduleSave();
      useHistory.getState().push({
        label: 'Delete tileset',
        undo: () => {
          insertTilesetAt(tileset, index);
          scheduleSave();
        },
        redo: () => {
          removeTileset(id);
          scheduleSave();
        },
      });
    },

    addTilesetMember: (tilesetId, objectId) => {
      const tileset = get().open?.project.tilesets.find((t) => t.id === tilesetId);
      if (!tileset || tileset.members.includes(objectId)) return;
      const previous = tileset.members;
      const next = [...previous, objectId];
      patchTileset(tilesetId, { members: next });
      set({ compileResult: null, compileError: null });
      scheduleSave();
      useHistory.getState().push({
        label: 'Add to tileset',
        undo: () => {
          patchTileset(tilesetId, { members: previous });
          scheduleSave();
        },
        redo: () => {
          patchTileset(tilesetId, { members: next });
          scheduleSave();
        },
      });
    },

    removeTilesetMember: (tilesetId, objectId) => {
      const tileset = get().open?.project.tilesets.find((t) => t.id === tilesetId);
      if (!tileset || !tileset.members.includes(objectId)) return;
      const previous = tileset.members;
      const next = previous.filter((m) => m !== objectId);
      patchTileset(tilesetId, { members: next });
      set({ compileResult: null, compileError: null });
      scheduleSave();
      useHistory.getState().push({
        label: 'Remove from tileset',
        undo: () => {
          patchTileset(tilesetId, { members: previous });
          scheduleSave();
        },
        redo: () => {
          patchTileset(tilesetId, { members: next });
          scheduleSave();
        },
      });
    },

    reorderTilesetMember: (tilesetId, from, to) => {
      const tileset = get().open?.project.tilesets.find((t) => t.id === tilesetId);
      if (!tileset) return;
      const count = tileset.members.length;
      if (from < 0 || to < 0 || from >= count || to >= count || from === to) return;
      const previous = tileset.members;
      const moved = previous[from];
      if (moved === undefined) return;
      const next = [...previous];
      next.splice(from, 1);
      next.splice(to, 0, moved);
      patchTileset(tilesetId, { members: next });
      set({ compileResult: null, compileError: null });
      scheduleSave();
      useHistory.getState().push({
        label: 'Reorder tileset',
        undo: () => {
          patchTileset(tilesetId, { members: previous });
          scheduleSave();
        },
        redo: () => {
          patchTileset(tilesetId, { members: next });
          scheduleSave();
        },
      });
    },

    refreshTilesetBudget: async (tilesetId) => {
      const current = get().open;
      if (!current) return;
      set({ budgetComputing: true });
      try {
        const project = await persistNow();
        if (!project) return;
        const budget = await api.getTilesetBudget(current.path, tilesetId);
        // Guard a stale write: the artist may have switched tilesets in flight.
        if (get().selectedTilesetId !== tilesetId) return;
        set({ budget, budgetError: null });
      } catch (e) {
        if (get().selectedTilesetId === tilesetId) {
          set({ budgetError: String(e) });
        }
      } finally {
        if (get().selectedTilesetId === tilesetId) set({ budgetComputing: false });
      }
    },

    exportTileset: async (tilesetId, destDir) => {
      const current = get().open;
      if (!current) throw new Error('No project open.');
      const project = await persistNow();
      if (!project) throw new Error('No project open.');
      return api.exportTileset(current.path, tilesetId, destDir);
    },

    setCompileTarget: (dir) => {
      set((s) =>
        s.open
          ? {
              open: {
                ...s.open,
                project: { ...s.open.project, compile_target: dir },
              },
            }
          : s,
      );
      scheduleSave();
    },

    compileTileset: async (tilesetId) => {
      const current = get().open;
      if (!current) return;
      const decompDir = current.project.compile_target;
      if (!decompDir) {
        set({ compileError: 'Choose a target decomp project first.' });
        return;
      }
      set({ compiling: true, compileError: null, compileResult: null });
      try {
        // Persist first: the Rust compiler reads membership and artwork from
        // disk. (This also writes the just-picked compile target.)
        const project = await persistNow();
        if (!project) return;
        const result = await api.compileTileset(current.path, tilesetId, decompDir);
        if (get().selectedTilesetId !== tilesetId) return;
        set({ compileResult: result });
      } catch (e) {
        if (get().selectedTilesetId === tilesetId) set({ compileError: String(e) });
      } finally {
        if (get().selectedTilesetId === tilesetId) set({ compiling: false });
      }
    },
  };
});
