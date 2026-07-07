import { create } from 'zustand';
import * as api from '../lib/api';
import type { AtlasObject, OpenProject, Recent } from '../lib/api';
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

type ProjectState = {
  open: OpenProject | null;
  recents: Recent[];
  status: SaveStatus;
  error: string | null;

  // Which object's artwork is shown on the Canvas. Selection is view state and
  // is deliberately not undoable.
  selectedObjectId: string | null;
  importing: boolean;

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

  const setObjectName = (id: string, name: string) => {
    set((s) =>
      s.open
        ? {
            open: {
              ...s.open,
              project: {
                ...s.open.project,
                objects: s.open.project.objects.map((o) =>
                  o.id === id ? { ...o, name } : o,
                ),
              },
            },
          }
        : s,
    );
    // Keep the Canvas label in sync when the shown object is renamed.
    const canvas = useCanvasStore.getState();
    if (get().selectedObjectId === id && canvas.artwork) {
      canvas.setArtwork({ ...canvas.artwork, name });
    }
  };

  // Leaving a project: drop objects, selection, undo history, and the Canvas.
  const resetSession = () => {
    useHistory.getState().clear();
    useCanvasStore.getState().clear();
    set({ selectedObjectId: null, importing: false });
  };

  return {
    open: null,
    recents: [],
    status: 'idle',
    error: null,
    selectedObjectId: null,
    importing: false,

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
      set({ selectedObjectId: id });
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
      try {
        await api.trashObject(current.path, id);
        removeObject(id);
        scheduleSave();
        useHistory.getState().push({
          label: 'Delete object',
          undo: async () => {
            await api.restoreObject(current.path, id);
            insertObjectAt(obj, index);
            scheduleSave();
            await get().selectObject(id);
          },
          redo: async () => {
            await api.trashObject(current.path, id);
            removeObject(id);
            scheduleSave();
          },
        });
      } catch (e) {
        set({ error: String(e) });
      }
    },
  };
});
