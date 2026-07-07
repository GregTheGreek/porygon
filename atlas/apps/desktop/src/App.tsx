import { useEffect, useState } from 'react';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { Toolbar } from './components/Toolbar';
import { Workspace } from './components/Workspace';
import { StartScreen } from './components/StartScreen';
import { CommandPalette } from './components/CommandPalette';
import { ShortcutsHelp } from './components/ShortcutsHelp';
import { Preferences } from './components/Preferences';
import { ContextMenuHost } from './components/ContextMenu';
import { getAppVersion } from './lib/api';
import { useProjectStore } from './store/project';
import { useCanvasStore } from './store/canvas';
import { usePreferences } from './store/preferences';
import { useUiStore } from './store/ui';
import { useGlobalShortcuts } from './hooks/useGlobalShortcuts';

// No project open -> start screen (create/open/recents). A project open -> the
// M1 four-region workspace. We deliberately do not auto-open the last project
// on launch; recents are one click away.
export function App() {
  const [version, setVersion] = useState('');
  const open = useProjectStore((s) => s.open);
  const loadRecents = useProjectStore((s) => s.loadRecents);
  const importObjectFromPath = useProjectStore((s) => s.importObjectFromPath);
  const clearCanvas = useCanvasStore((s) => s.clear);
  const loadPreferences = usePreferences((s) => s.load);
  const dropActive = useUiStore((s) => s.dropActive);
  const setDropActive = useUiStore((s) => s.setDropActive);

  // The whole app-level keyboard map, driven by the command registry (M14).
  useGlobalShortcuts();

  useEffect(() => {
    getAppVersion()
      .then(setVersion)
      .catch(() => setVersion(''));
    void loadRecents();
    void loadPreferences();
  }, [loadRecents, loadPreferences]);

  // Artwork is session-scoped: drop it when the project closes so it does not
  // bleed into the next one. (Autosave keeps `open` truthy, so this only fires
  // on a real close.)
  useEffect(() => {
    if (!open) clearCanvas();
  }, [open, clearCanvas]);

  // Finder file-drop import (M14): dropping PNGs onto the window imports each as
  // an object. Non-PNG paths are rejected with a message (store handles that).
  // Uses Tauri's OS-level drag-drop events, which the webview enables by default.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void getCurrentWebview()
      .onDragDropEvent(async (event) => {
        const p = event.payload;
        if (p.type === 'enter' || p.type === 'over') {
          setDropActive(true);
        } else if (p.type === 'leave') {
          setDropActive(false);
        } else if (p.type === 'drop') {
          setDropActive(false);
          for (const path of p.paths) {
            await importObjectFromPath(path);
          }
        }
      })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [importObjectFromPath, setDropActive]);

  return (
    <div className="flex h-full flex-col overflow-hidden bg-bg font-sans text-fg">
      <Toolbar version={version} />
      {open ? <Workspace /> : <StartScreen />}

      {/* App-global overlays (M14). */}
      <CommandPalette />
      <ShortcutsHelp />
      <Preferences />
      <ContextMenuHost />

      {open && dropActive && (
        <div className="pointer-events-none fixed inset-0 z-40 flex items-center justify-center border-2 border-dashed border-accent bg-accent/10">
          <p className="rounded-md bg-bg-raised px-4 py-2 text-sm text-fg shadow-lg">
            Drop a PNG to import it as an object
          </p>
        </div>
      )}
    </div>
  );
}
