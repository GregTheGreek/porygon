import { useEffect, useState } from 'react';
import { Toolbar } from './components/Toolbar';
import { Workspace } from './components/Workspace';
import { StartScreen } from './components/StartScreen';
import { getAppVersion } from './lib/api';
import { useProjectStore } from './store/project';
import { useCanvasStore } from './store/canvas';
import { useHistory } from './store/history';

// No project open -> start screen (create/open/recents). A project open -> the
// M1 four-region workspace. We deliberately do not auto-open the last project
// on launch; recents are one click away.
export function App() {
  const [version, setVersion] = useState('');
  const open = useProjectStore((s) => s.open);
  const loadRecents = useProjectStore((s) => s.loadRecents);
  const clearCanvas = useCanvasStore((s) => s.clear);

  useEffect(() => {
    getAppVersion()
      .then(setVersion)
      .catch(() => setVersion(''));
    void loadRecents();
  }, [loadRecents]);

  // Artwork is session-scoped: drop it when the project closes so it does not
  // bleed into the next one. (Autosave keeps `open` truthy, so this only fires
  // on a real close.)
  useEffect(() => {
    if (!open) clearCanvas();
  }, [open, clearCanvas]);

  // Global undo/redo (cmd/ctrl+Z, shift for redo). Same input-field guard the
  // Canvas uses, so it never fires while the user is typing in a rename field.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)
      ) {
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        const history = useHistory.getState();
        if (e.shiftKey) void history.redo();
        else void history.undo();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <div className="flex h-full flex-col overflow-hidden bg-bg font-sans text-fg">
      <Toolbar version={version} />
      {open ? <Workspace /> : <StartScreen />}
    </div>
  );
}
