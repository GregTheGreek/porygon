import { create } from 'zustand';
import * as api from '../lib/api';
import type { Settings } from '../lib/api';
import { useCanvasStore } from './canvas';

// App-level preferences, backed by settings.rs (persisted app-side, like
// recents). This store is the single frontend home for everything the
// Preferences dialog edits; the project store reads the autosave debounce from
// here, and the canvas store's default grid visibility is seeded on load.
const DEFAULTS: Settings = {
  porytiles_path: null,
  autosave_debounce_ms: 1000,
  default_grid: false,
};

// Mirror the clamp range enforced in settings.rs, for the dialog's input hints.
export const MIN_AUTOSAVE_MS = 250;
export const MAX_AUTOSAVE_MS = 10000;

type PreferencesState = {
  settings: Settings;
  loaded: boolean;
  load: () => Promise<void>;
  // Persist a partial change; Rust normalizes and returns the saved settings.
  save: (patch: Partial<Settings>) => Promise<void>;
};

export const usePreferences = create<PreferencesState>((set, get) => ({
  settings: DEFAULTS,
  loaded: false,

  load: async () => {
    try {
      const settings = await api.getSettings();
      set({ settings, loaded: true });
      // Seed the canvas default grid visibility from the loaded preference.
      useCanvasStore.getState().setGrid16(settings.default_grid);
    } catch {
      set({ settings: DEFAULTS, loaded: true });
    }
  },

  save: async (patch) => {
    const next = { ...get().settings, ...patch };
    try {
      const saved = await api.saveSettings(next);
      set({ settings: saved });
      if (patch.default_grid !== undefined) {
        useCanvasStore.getState().setGrid16(saved.default_grid);
      }
    } catch {
      // Keep the optimistic value so the dialog does not flicker; a failed
      // write is rare (config dir) and surfaces on the next load.
      set({ settings: next });
    }
  },
}));
