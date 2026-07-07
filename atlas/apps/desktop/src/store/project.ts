import { create } from 'zustand';
import * as api from '../lib/api';
import type {
  Anchor,
  AtlasObject,
  Collision,
  CollisionValue,
  Occlusion,
  OpenProject,
  Recent,
  Tileset,
  TilesetBudget,
} from '../lib/api';
import { useCanvasStore } from './canvas';
import { useHistory } from './history';

// Reflects whether the on-disk copy is up to date with the in-memory one.
export type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

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

type ProjectState = {
  open: OpenProject | null;
  recents: Recent[];
  status: SaveStatus;
  error: string | null;

  // Which object's artwork is shown on the Canvas. Selection is view state and
  // is deliberately not undoable.
  selectedObjectId: string | null;
  importing: boolean;

  // Which Tileset is open in the Builder (center region). Mutually exclusive
  // with an object selection: opening one clears the other. View state, not
  // undoable.
  selectedTilesetId: string | null;

  loadRecents: () => Promise<void>;
  createProject: (location: string, name: string) => Promise<void>;
  openProject: (dir: string) => Promise<void>;
  close: () => void;
  rename: (name: string) => void;

  selectObject: (id: string | null) => Promise<void>;
  importObject: () => Promise<void>;
  renameObject: (id: string, name: string) => void;
  duplicateObject: (id: string) => Promise<void>;
  deleteObject: (id: string) => Promise<void>;

  // Inspector metadata edits (M5). All undoable.
  setObjectCategory: (id: string, category: string) => void;
  addObjectTag: (id: string, tag: string) => void;
  removeObjectTag: (id: string, tag: string) => void;
  setObjectAnchor: (id: string, x: number, y: number) => void;

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

  // Persist the project, then compute the Tier 2 budget for a tileset. Saving
  // first is required: the Rust budget command reads member artwork and the
  // saved membership from disk, so it must see the latest state.
  computeTilesetBudget: (tilesetId: string) => Promise<TilesetBudget>;
};

export const useProjectStore = create<ProjectState>((set, get) => {
  // Debounce timer for autosave, kept in the closure rather than in state so a
  // pending save never triggers a re-render.
  let saveTimer: ReturnType<typeof setTimeout> | null = null;

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
    saveTimer = setTimeout(() => {
      void flushSave();
    }, AUTOSAVE_DELAY_MS);
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

  // Leaving a project: drop objects, selection, undo history, and the Canvas.
  const resetSession = () => {
    useHistory.getState().clear();
    useCanvasStore.getState().clear();
    set({ selectedObjectId: null, selectedTilesetId: null, importing: false });
  };

  return {
    open: null,
    recents: [],
    status: 'idle',
    error: null,
    selectedObjectId: null,
    importing: false,
    selectedTilesetId: null,

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
        if (current) void api.saveProject(current.path, current.project);
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

    selectObject: async (id) => {
      // Opening an object closes any open Tileset Builder (center is one view).
      set({ selectedObjectId: id, selectedTilesetId: id === null ? get().selectedTilesetId : null });
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
      try {
        const art = await api.readObjectArtwork(current.path, id);
        // Guard against a fast re-selection while the read was in flight.
        if (get().selectedObjectId !== id) return;
        useCanvasStore.getState().setArtwork({
          name: obj.name,
          width: art.width,
          height: art.height,
          url: `data:image/png;base64,${art.data}`,
        });
      } catch (e) {
        set({ error: String(e) });
      }
    },

    importObject: async () => {
      const current = get().open;
      if (!current) return;
      const source = await api.pickPngFile();
      if (!source) return;
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

      const scrubMembership = () => {
        for (const t of affected) {
          patchTileset(
            t.id,
            { members: t.members.filter((m) => m !== id) },
          );
        }
      };
      const restoreMembership = () => {
        for (const t of affected) patchTileset(t.id, { members: t.members });
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

    paintCollision: (id, indices, value) => {
      const obj = get().open?.project.objects.find((o) => o.id === id);
      if (!obj || indices.length === 0) return;

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

    computeTilesetBudget: async (tilesetId) => {
      const current = get().open;
      if (!current) throw new Error('No project open.');
      // Persist first: the Rust budget command reads membership and member
      // artwork from disk, so it must see the latest state. Cancel the pending
      // debounced save (this write supersedes it).
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
      }
      const project = await api.saveProject(current.path, current.project);
      set((s) => ({ open: s.open ? { ...s.open, project } : null }));
      return api.getTilesetBudget(current.path, tilesetId);
    },
  };
});
