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
// zoom, pick); Collision paints on the 16px grid; Occlusion paints per pixel
// (occlusion is pixel-level - see occlusion.rs / compiler.md).
export type PaintMode = 'select' | 'collision' | 'occlusion';

// The occlusion brush size in artwork pixels (a centered square). Occlusion is
// pixel-level, so a 1px brush is precise but slow; the larger sizes make broad
// canopies quick to cover.
export const OCCLUSION_BRUSH_SIZES = [1, 4, 8] as const;

type CanvasState = {
  artwork: CanvasArtwork | null;
  // True when the artwork is clicked/selected on the Canvas; drives the outline.
  selected: boolean;

  // Collision-layer editing state (M6). All view/tool state, not undoable; the
  // painted data itself lives on the Object (see store/project.ts).
  paintMode: PaintMode;
  // The collision overlay's visibility, independent of paint mode (a Select-mode
  // user can still see collision).
  collisionVisible: boolean;
  // The value the collision brush paints. 'Walkable' erases (removes the cell).
  paintValue: CollisionValue;

  // Occlusion-layer editing state (M7). Same shape as collision: tool state
  // here, painted pixels on the Object.
  // The occlusion overlay's visibility, independent of paint mode and of the
  // collision toggle.
  occlusionVisible: boolean;
  // When true the occlusion brush erases (removes occluding pixels).
  occlusionErase: boolean;
  // The occlusion brush's square side in artwork pixels.
  occlusionBrushSize: number;
  // The preview marker: a player-sized placeholder rendered between the below-
  // player artwork and the occluding pixels, so the artist sees what draws over
  // the player. Independent of paint mode and both visibility toggles.
  previewEnabled: boolean;

  setArtwork: (artwork: CanvasArtwork | null) => void;
  setSelected: (selected: boolean) => void;
  setPaintMode: (mode: PaintMode) => void;
  setCollisionVisible: (visible: boolean) => void;
  setPaintValue: (value: CollisionValue) => void;
  setOcclusionVisible: (visible: boolean) => void;
  setOcclusionErase: (erase: boolean) => void;
  setOcclusionBrushSize: (size: number) => void;
  setPreviewEnabled: (enabled: boolean) => void;
  clear: () => void;
};

export const useCanvasStore = create<CanvasState>((set) => ({
  artwork: null,
  selected: false,
  paintMode: 'select',
  collisionVisible: true,
  paintValue: 'Blocked',
  occlusionVisible: true,
  occlusionErase: false,
  occlusionBrushSize: 4,
  previewEnabled: false,

  setArtwork: (artwork) => set({ artwork, selected: false }),
  setSelected: (selected) => set({ selected }),
  setPaintMode: (paintMode) => set({ paintMode }),
  setCollisionVisible: (collisionVisible) => set({ collisionVisible }),
  setPaintValue: (paintValue) => set({ paintValue }),
  setOcclusionVisible: (occlusionVisible) => set({ occlusionVisible }),
  setOcclusionErase: (occlusionErase) => set({ occlusionErase }),
  setOcclusionBrushSize: (occlusionBrushSize) => set({ occlusionBrushSize }),
  setPreviewEnabled: (previewEnabled) => set({ previewEnabled }),
  // Leaving a project resets the tool back to a neutral state.
  clear: () =>
    set({
      artwork: null,
      selected: false,
      paintMode: 'select',
      collisionVisible: true,
      paintValue: 'Blocked',
      occlusionVisible: true,
      occlusionErase: false,
      occlusionBrushSize: 4,
      previewEnabled: false,
    }),
}));
