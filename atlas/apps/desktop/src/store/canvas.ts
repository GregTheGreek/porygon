import { create } from 'zustand';
import * as api from '../lib/api';

// The artwork currently on the Canvas, as a ready-to-display data URL plus the
// metadata the Inspector shows. Session-scoped: importing replaces it, closing
// the project clears it. Persistence arrives with the Object model (M4).
export type CanvasArtwork = {
  name: string;
  width: number;
  height: number;
  url: string;
};

type CanvasState = {
  artwork: CanvasArtwork | null;
  // True when the artwork is selected on the Canvas; drives the Inspector.
  selected: boolean;
  error: string | null;
  importing: boolean;

  // Pick a PNG, read it through Rust, and put it on the Canvas.
  importArtwork: () => Promise<void>;
  setSelected: (selected: boolean) => void;
  clear: () => void;
};

export const useCanvasStore = create<CanvasState>((set) => ({
  artwork: null,
  selected: false,
  error: null,
  importing: false,

  importArtwork: async () => {
    try {
      const path = await api.pickPngFile();
      if (!path) return;
      set({ importing: true, error: null });
      const art = await api.readArtwork(path);
      set({
        artwork: {
          name: art.name,
          width: art.width,
          height: art.height,
          url: `data:image/png;base64,${art.data}`,
        },
        selected: false,
        importing: false,
      });
    } catch (e) {
      set({ error: String(e), importing: false });
    }
  },

  setSelected: (selected) => set({ selected }),
  clear: () => set({ artwork: null, selected: false, error: null }),
}));
