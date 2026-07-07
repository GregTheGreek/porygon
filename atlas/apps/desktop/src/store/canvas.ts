import { create } from 'zustand';
import type { CollisionValue } from '../lib/api';

// The artwork currently shown on the Canvas, as a ready-to-display data URL
// plus display metadata. Driven by the selected Object (see store/project.ts):
// selecting an object loads its artwork here; deselecting or closing clears it.
export type CanvasArtwork = {
  name: string;
  width: number;
  height: number;
  url: string;
};

// What the Canvas brush edits. Select is the default pointer behavior (pan,
// zoom, pick); Collision turns left-drag into painting on the 16px grid.
export type PaintMode = 'select' | 'collision';

type CanvasState = {
  artwork: CanvasArtwork | null;
  // True when the artwork is clicked/selected on the Canvas; drives the outline.
  selected: boolean;

  // Collision-layer editing state (M6). All view/tool state, not undoable; the
  // painted data itself lives on the Object (see store/project.ts).
  paintMode: PaintMode;
  // The overlay's visibility, independent of paint mode (a Select-mode user can
  // still see collision).
  collisionVisible: boolean;
  // The value the brush paints. 'Walkable' erases (removes the cell).
  paintValue: CollisionValue;

  setArtwork: (artwork: CanvasArtwork | null) => void;
  setSelected: (selected: boolean) => void;
  setPaintMode: (mode: PaintMode) => void;
  setCollisionVisible: (visible: boolean) => void;
  setPaintValue: (value: CollisionValue) => void;
  clear: () => void;
};

export const useCanvasStore = create<CanvasState>((set) => ({
  artwork: null,
  selected: false,
  paintMode: 'select',
  collisionVisible: true,
  paintValue: 'Blocked',

  setArtwork: (artwork) => set({ artwork, selected: false }),
  setSelected: (selected) => set({ selected }),
  setPaintMode: (paintMode) => set({ paintMode }),
  setCollisionVisible: (collisionVisible) => set({ collisionVisible }),
  setPaintValue: (paintValue) => set({ paintValue }),
  // Leaving a project resets the tool back to a neutral state.
  clear: () =>
    set({
      artwork: null,
      selected: false,
      paintMode: 'select',
      collisionVisible: true,
      paintValue: 'Blocked',
    }),
}));
