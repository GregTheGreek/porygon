import { create } from 'zustand';
import type { CollisionValue } from '../lib/api';

// The artwork currently shown on the Canvas, as a ready-to-display data URL
// plus display metadata. Driven by the selected Object (see store/project.ts):
// selecting an object loads its artwork here; deselecting or closing clears it.
// `objectId` identifies the Object the pixels belong to, so a recompose of the
// same object (M12) can preserve the view instead of re-fitting.
export type CanvasArtwork = {
  objectId?: string;
  name: string;
  width: number;
  height: number;
  url: string;
};

// What the Canvas brush edits. Select is the default pointer behavior (pan,
// zoom, pick); Collision paints on the 16px grid; Occlusion paints per pixel
// (occlusion is pixel-level - see occlusion.rs / compiler.md). Play (M8) is
// the runtime preview: a playable mode, not a brush - the pointer is inert and
// the keyboard walks a player on the grid. Play state itself is ephemeral and
// lives in the Canvas engine, never here or in the project.
export type PaintMode = 'select' | 'collision' | 'occlusion' | 'play';

// The occlusion brush size in artwork pixels (a centered square). Occlusion is
// pixel-level, so a 1px brush is precise but slow; the larger sizes make broad
// canopies quick to cover.
export const OCCLUSION_BRUSH_SIZES = [1, 4, 8] as const;

// The canvas preview backdrop (P2.1): what shows BEHIND the selected object's
// artwork so the artist can judge how it reads on different ground. Pure view
// state - never saved, never exported, never part of any Object or Tileset.
// 'none' is the plain empty canvas; 'checker' is the transparency checker as an
// explicit opt-in; 'color' fills a flat color; 'object' tiles another library
// object's active artwork underneath (the rock-on-sand preview).
export type BackdropKind = 'none' | 'checker' | 'color' | 'object';

// A flat-color preset. Sensible grounds a prop typically sits on; `custom` is
// the free color chosen with the native picker. Values are plain hex strings.
export const BACKDROP_COLOR_PRESETS = [
  { id: 'grass', label: 'Grass', color: '#5a8f3c' },
  { id: 'sand', label: 'Sand', color: '#d9c48a' },
  { id: 'water', label: 'Water', color: '#4a7fb5' },
  { id: 'dirt', label: 'Dirt', color: '#8a6b4a' },
] as const;

export type Backdrop = {
  kind: BackdropKind;
  // The flat color when kind is 'color' (hex string, e.g. '#5a8f3c').
  color: string;
  // The library object tiled underneath when kind is 'object'; null falls back
  // to no backdrop (also used when the chosen object is deleted).
  objectId: string | null;
};

const DEFAULT_BACKDROP: Backdrop = {
  kind: 'none',
  color: BACKDROP_COLOR_PRESETS[0].color,
  objectId: null,
};

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

  // Grid visibility (M14): lifted out of the Canvas component so keyboard
  // shortcuts, the command palette, and the default-grid preference can drive
  // it. `grid8` is the 8px tile grid; `grid16` the 16px metatile grid. These
  // are UI/view preferences, not project data, so they persist across project
  // switches (they are seeded once from preferences on load).
  grid8: boolean;
  grid16: boolean;

  // The preview backdrop (P2.1). A canvas-view setting like the grids: it
  // survives selection changes (switching objects keeps the chosen ground) and
  // is reset only on project close.
  backdrop: Backdrop;

  setArtwork: (artwork: CanvasArtwork | null) => void;
  setSelected: (selected: boolean) => void;
  setPaintMode: (mode: PaintMode) => void;
  setCollisionVisible: (visible: boolean) => void;
  setPaintValue: (value: CollisionValue) => void;
  setOcclusionVisible: (visible: boolean) => void;
  setOcclusionErase: (erase: boolean) => void;
  setOcclusionBrushSize: (size: number) => void;
  setPreviewEnabled: (enabled: boolean) => void;
  setGrid8: (visible: boolean) => void;
  setGrid16: (visible: boolean) => void;
  toggleGrid8: () => void;
  toggleGrid16: () => void;
  // Backdrop setters (P2.1). setBackdropKind switches what shows behind the
  // artwork; setBackdropColor and setBackdropObject adjust the params for the
  // 'color' and 'object' kinds without changing the kind.
  setBackdropKind: (kind: BackdropKind) => void;
  setBackdropColor: (color: string) => void;
  setBackdropObject: (objectId: string | null) => void;
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
  grid8: false,
  grid16: false,
  backdrop: DEFAULT_BACKDROP,

  setArtwork: (artwork) => set({ artwork, selected: false }),
  setSelected: (selected) => set({ selected }),
  setPaintMode: (paintMode) => set({ paintMode }),
  setCollisionVisible: (collisionVisible) => set({ collisionVisible }),
  setPaintValue: (paintValue) => set({ paintValue }),
  setOcclusionVisible: (occlusionVisible) => set({ occlusionVisible }),
  setOcclusionErase: (occlusionErase) => set({ occlusionErase }),
  setOcclusionBrushSize: (occlusionBrushSize) => set({ occlusionBrushSize }),
  setPreviewEnabled: (previewEnabled) => set({ previewEnabled }),
  setGrid8: (grid8) => set({ grid8 }),
  setGrid16: (grid16) => set({ grid16 }),
  toggleGrid8: () => set((s) => ({ grid8: !s.grid8 })),
  toggleGrid16: () => set((s) => ({ grid16: !s.grid16 })),
  setBackdropKind: (kind) => set((s) => ({ backdrop: { ...s.backdrop, kind } })),
  setBackdropColor: (color) => set((s) => ({ backdrop: { ...s.backdrop, color } })),
  setBackdropObject: (objectId) => set((s) => ({ backdrop: { ...s.backdrop, objectId } })),
  // Leaving a project resets the tool back to a neutral state. Grid visibility
  // is a UI preference, not project state, so it is deliberately not reset here.
  // The backdrop IS reset: an 'object' backdrop references a project object id
  // that would be stale in the next project.
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
      backdrop: DEFAULT_BACKDROP,
    }),
}));
