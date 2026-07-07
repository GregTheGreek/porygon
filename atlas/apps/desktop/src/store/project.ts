import { create } from 'zustand';
import * as api from '../lib/api';
import type { OpenProject, Recent } from '../lib/api';

// Reflects whether the on-disk copy is up to date with the in-memory one.
export type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

const AUTOSAVE_DELAY_MS = 1000;

type ProjectState = {
  open: OpenProject | null;
  recents: Recent[];
  status: SaveStatus;
  error: string | null;

  loadRecents: () => Promise<void>;
  createProject: (location: string, name: string) => Promise<void>;
  openProject: (dir: string) => Promise<void>;
  close: () => void;
  rename: (name: string) => void;
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

  return {
    open: null,
    recents: [],
    status: 'idle',
    error: null,

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
        set({ open, status: 'saved', error: null });
        await get().loadRecents();
      } catch (e) {
        set({ error: String(e) });
      }
    },

    openProject: async (dir) => {
      try {
        const open = await api.openProject(dir);
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
  };
});
