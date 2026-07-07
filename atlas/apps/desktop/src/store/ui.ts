import { create } from 'zustand';

// One item in a context menu. A separator renders a divider (its other fields
// are ignored). `submenu` opens a nested list on hover/right-arrow. `run` is
// invoked on click/Enter and the menu closes afterwards.
export type MenuItem =
  | { separator: true }
  | {
      separator?: false;
      label: string;
      onClick?: () => void;
      disabled?: boolean;
      danger?: boolean;
      submenu?: MenuItem[];
    };

export type ContextMenuState = {
  x: number;
  y: number;
  items: MenuItem[];
};

// Transient, app-global UI overlays that are not project data: the command
// palette, the shortcuts help sheet, the Preferences dialog, the single open
// context menu, and the file-drop hover highlight. Kept out of the project
// store so none of it is undoable or persisted.
type UiState = {
  paletteOpen: boolean;
  helpOpen: boolean;
  preferencesOpen: boolean;
  contextMenu: ContextMenuState | null;
  // True while a file is dragged over the window (for the drop-hint overlay).
  dropActive: boolean;

  openPalette: () => void;
  closePalette: () => void;
  togglePalette: () => void;
  openHelp: () => void;
  closeHelp: () => void;
  toggleHelp: () => void;
  openPreferences: () => void;
  closePreferences: () => void;
  openContextMenu: (x: number, y: number, items: MenuItem[]) => void;
  closeContextMenu: () => void;
  setDropActive: (active: boolean) => void;
  // True when any modal-ish overlay owns the keyboard, so global single-key
  // shortcuts stand down (the overlay handles Escape/arrows itself).
  anyOverlayOpen: () => boolean;
};

export const useUiStore = create<UiState>((set, get) => ({
  paletteOpen: false,
  helpOpen: false,
  preferencesOpen: false,
  contextMenu: null,
  dropActive: false,

  openPalette: () => set({ paletteOpen: true, helpOpen: false, contextMenu: null }),
  closePalette: () => set({ paletteOpen: false }),
  togglePalette: () => set((s) => ({ paletteOpen: !s.paletteOpen, helpOpen: false })),
  openHelp: () => set({ helpOpen: true, paletteOpen: false, contextMenu: null }),
  closeHelp: () => set({ helpOpen: false }),
  toggleHelp: () => set((s) => ({ helpOpen: !s.helpOpen, paletteOpen: false })),
  openPreferences: () => set({ preferencesOpen: true, contextMenu: null }),
  closePreferences: () => set({ preferencesOpen: false }),
  openContextMenu: (x, y, items) => set({ contextMenu: { x, y, items } }),
  closeContextMenu: () => set({ contextMenu: null }),
  setDropActive: (dropActive) => set({ dropActive }),
  anyOverlayOpen: () => {
    const s = get();
    return s.paletteOpen || s.helpOpen || s.preferencesOpen || s.contextMenu !== null;
  },
}));
