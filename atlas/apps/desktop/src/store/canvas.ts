import { create } from 'zustand';

// The artwork currently shown on the Canvas, as a ready-to-display data URL
// plus display metadata. Driven by the selected Object (see store/project.ts):
// selecting an object loads its artwork here; deselecting or closing clears it.
export type CanvasArtwork = {
  name: string;
  width: number;
  height: number;
  url: string;
};

type CanvasState = {
  artwork: CanvasArtwork | null;
  // True when the artwork is clicked/selected on the Canvas; drives the outline.
  selected: boolean;

  setArtwork: (artwork: CanvasArtwork | null) => void;
  setSelected: (selected: boolean) => void;
  clear: () => void;
};

export const useCanvasStore = create<CanvasState>((set) => ({
  artwork: null,
  selected: false,

  setArtwork: (artwork) => set({ artwork, selected: false }),
  setSelected: (selected) => set({ selected }),
  clear: () => set({ artwork: null, selected: false }),
}));
