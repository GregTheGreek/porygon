// The single command registry (M14). The command palette, the global keyboard
// shortcuts, the help overlay, and (where sensible) context menus all consume
// this one list, so a command's title, shortcut, availability, and behavior are
// declared exactly once. Commands are plain data built fresh on demand:
// `enabled` and `run` read the live stores via getState(), so a registry built
// at palette-open time is always current without any reactive wiring.

import * as api from './lib/api';
import type { Shortcut } from './lib/shortcuts';
import { useCanvasStore } from './store/canvas';
import { useHistory } from './store/history';
import { useProjectStore } from './store/project';
import { useUiStore } from './store/ui';

export type Command = {
  id: string;
  title: string;
  group: string;
  shortcut?: Shortcut;
  // Extra words to match in the palette fuzzy search (never displayed).
  keywords?: string;
  enabled: () => boolean;
  run: () => void | Promise<void>;
};

const proj = () => useProjectStore.getState();
const canvas = () => useCanvasStore.getState();
const ui = () => useUiStore.getState();
const hist = () => useHistory.getState();

const hasProject = () => proj().open !== null;
const primaryObject = () => {
  const s = proj();
  return s.selectedObjectId
    ? s.open?.project.objects.find((o) => o.id === s.selectedObjectId) ?? null
    : null;
};
const hasArtwork = () => canvas().artwork !== null;

const cycleVariant = (delta: number) => {
  const obj = primaryObject();
  if (!obj || obj.variants.length < 2) return;
  const idx = obj.variants.findIndex((v) => v.id === obj.active_variant);
  const nextIdx = (idx + delta + obj.variants.length) % obj.variants.length;
  const target = obj.variants[nextIdx];
  if (target) proj().switchVariant(obj.id, target.id);
};

// Build the full command list against current app state. Titles that depend on
// state (e.g. the delete count) are resolved here.
export function buildCommands(): Command[] {
  const selectionCount = proj().selectedObjectIds.length;
  const deleteTitle =
    selectionCount > 1 ? `Delete ${selectionCount} Objects` : 'Delete Object';

  return [
    // --- Project ---
    {
      id: 'project.open',
      title: 'Open Project…',
      group: 'Project',
      enabled: () => true,
      run: async () => {
        const dir = await api.pickDirectory('Open a project folder');
        if (dir) await proj().openProject(dir);
      },
    },
    {
      id: 'project.save',
      title: 'Save Now',
      group: 'Project',
      shortcut: { mod: true, key: 's' },
      keywords: 'write flush',
      enabled: hasProject,
      run: () => proj().saveNow(),
    },
    {
      id: 'project.close',
      title: 'Close Project',
      group: 'Project',
      enabled: hasProject,
      run: () => proj().close(),
    },
    {
      id: 'app.preferences',
      title: 'Preferences…',
      group: 'Project',
      shortcut: { mod: true, key: ',' },
      keywords: 'settings options porytiles autosave grid',
      enabled: () => true,
      run: () => ui().openPreferences(),
    },

    // --- Objects ---
    {
      id: 'object.import',
      title: 'Import Object…',
      group: 'Objects',
      keywords: 'png artwork add new',
      enabled: hasProject,
      run: () => proj().importObject(),
    },
    {
      id: 'object.duplicate',
      title: 'Duplicate Object',
      group: 'Objects',
      enabled: () => primaryObject() !== null,
      run: () => {
        const id = proj().selectedObjectId;
        if (id) return proj().duplicateObject(id);
      },
    },
    {
      id: 'object.rename',
      title: 'Rename Object',
      group: 'Objects',
      shortcut: { key: 'F2' },
      enabled: () => primaryObject() !== null,
      run: () => {
        const id = proj().selectedObjectId;
        if (id) proj().beginRename({ kind: 'object', id });
      },
    },
    {
      id: 'object.delete',
      title: deleteTitle,
      group: 'Objects',
      shortcut: { mod: true, key: 'Backspace' },
      enabled: () => proj().selectedObjectIds.length > 0,
      run: () => proj().bulkDeleteObjects(proj().selectedObjectIds),
    },
    {
      id: 'object.selectNext',
      title: 'Select Next Object',
      group: 'Objects',
      shortcut: { key: 'ArrowDown' },
      // Arrows drive the player in play mode; library nav yields to it.
      enabled: () =>
        hasProject() &&
        (proj().open?.project.objects.length ?? 0) > 0 &&
        canvas().paintMode !== 'play',
      run: () => proj().selectAdjacentObject(1),
    },
    {
      id: 'object.selectPrev',
      title: 'Select Previous Object',
      group: 'Objects',
      shortcut: { key: 'ArrowUp' },
      enabled: () =>
        hasProject() &&
        (proj().open?.project.objects.length ?? 0) > 0 &&
        canvas().paintMode !== 'play',
      run: () => proj().selectAdjacentObject(-1),
    },

    // --- Tilesets ---
    {
      id: 'tileset.create',
      title: 'New Tileset',
      group: 'Tilesets',
      enabled: hasProject,
      run: () => proj().createTileset(),
    },
    {
      id: 'tileset.compile',
      title: 'Compile Current Tileset',
      group: 'Tilesets',
      keywords: 'porytiles build',
      enabled: () => {
        const s = proj();
        const t = s.open?.project.tilesets.find((t) => t.id === s.selectedTilesetId);
        return !!t && t.members.length > 0;
      },
      run: () => {
        const id = proj().selectedTilesetId;
        if (id) return proj().compileTileset(id);
      },
    },
    {
      id: 'tileset.export',
      title: 'Export Current Tileset…',
      group: 'Tilesets',
      enabled: () => {
        const s = proj();
        const t = s.open?.project.tilesets.find((t) => t.id === s.selectedTilesetId);
        return !!t && t.members.length > 0;
      },
      run: async () => {
        const id = proj().selectedTilesetId;
        if (!id) return;
        const dest = await api.pickDirectory('Choose where to export the tileset');
        if (!dest) return;
        try {
          await proj().exportTileset(id, dest);
        } catch (e) {
          useProjectStore.setState({ error: String(e) });
        }
      },
    },

    // --- Canvas tools (need artwork on the canvas) ---
    {
      id: 'canvas.select',
      title: 'Select Tool',
      group: 'Canvas',
      shortcut: { key: 'v' },
      enabled: hasArtwork,
      run: () => canvas().setPaintMode('select'),
    },
    {
      id: 'canvas.collision',
      title: 'Collision Tool',
      group: 'Canvas',
      shortcut: { key: 'c' },
      enabled: hasArtwork,
      run: () => canvas().setPaintMode('collision'),
    },
    {
      id: 'canvas.occlusion',
      title: 'Occlusion Tool',
      group: 'Canvas',
      shortcut: { key: 'o' },
      enabled: hasArtwork,
      run: () => canvas().setPaintMode('occlusion'),
    },
    {
      id: 'canvas.play',
      title: 'Play Mode',
      group: 'Canvas',
      shortcut: { key: 'p' },
      keywords: 'walk test runtime',
      enabled: hasArtwork,
      run: () => canvas().setPaintMode('play'),
    },

    // --- View toggles ---
    {
      id: 'view.grid16',
      title: 'Toggle Metatile Grid (16px)',
      group: 'View',
      shortcut: { key: 'g' },
      enabled: () => true,
      run: () => canvas().toggleGrid16(),
    },
    {
      id: 'view.grid8',
      title: 'Toggle Tile Grid (8px)',
      group: 'View',
      shortcut: { shift: true, key: 'g' },
      enabled: () => true,
      run: () => canvas().toggleGrid8(),
    },
    {
      id: 'view.collisionOverlay',
      title: 'Toggle Collision Overlay',
      group: 'View',
      shortcut: { shift: true, key: 'c' },
      enabled: () => true,
      run: () => canvas().setCollisionVisible(!canvas().collisionVisible),
    },
    {
      id: 'view.occlusionOverlay',
      title: 'Toggle Occlusion Overlay',
      group: 'View',
      shortcut: { shift: true, key: 'o' },
      enabled: () => true,
      run: () => canvas().setOcclusionVisible(!canvas().occlusionVisible),
    },
    {
      id: 'view.preview',
      title: 'Toggle Player Preview',
      group: 'View',
      shortcut: { shift: true, key: 'p' },
      enabled: () => true,
      run: () => canvas().setPreviewEnabled(!canvas().previewEnabled),
    },
    {
      id: 'view.nextVariant',
      title: 'Next Variant',
      group: 'View',
      shortcut: { key: ']' },
      enabled: () => (primaryObject()?.variants.length ?? 0) > 1,
      run: () => cycleVariant(1),
    },
    {
      id: 'view.prevVariant',
      title: 'Previous Variant',
      group: 'View',
      shortcut: { key: '[' },
      enabled: () => (primaryObject()?.variants.length ?? 0) > 1,
      run: () => cycleVariant(-1),
    },

    // --- Edit / App ---
    {
      id: 'edit.undo',
      title: 'Undo',
      group: 'Edit',
      shortcut: { mod: true, key: 'z' },
      enabled: () => hist().past.length > 0,
      run: () => hist().undo(),
    },
    {
      id: 'edit.redo',
      title: 'Redo',
      group: 'Edit',
      shortcut: { mod: true, shift: true, key: 'z' },
      enabled: () => hist().future.length > 0,
      run: () => hist().redo(),
    },
    {
      id: 'app.commandPalette',
      title: 'Command Palette',
      group: 'Help',
      shortcut: { mod: true, key: 'k' },
      enabled: () => true,
      run: () => ui().togglePalette(),
    },
    {
      id: 'app.shortcuts',
      title: 'Keyboard Shortcuts',
      group: 'Help',
      shortcut: { mod: true, key: '/' },
      keywords: 'help keys cheatsheet',
      enabled: () => true,
      run: () => ui().toggleHelp(),
    },
  ];
}
