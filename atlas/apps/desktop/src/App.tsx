import { useEffect, useState } from 'react';
import { Toolbar } from './components/Toolbar';
import { Workspace } from './components/Workspace';
import { StartScreen } from './components/StartScreen';
import { getAppVersion } from './lib/api';
import { useProjectStore } from './store/project';
import { useCanvasStore } from './store/canvas';

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

  return (
    <div className="flex h-full flex-col overflow-hidden bg-bg font-sans text-fg">
      <Toolbar version={version} />
      {open ? <Workspace /> : <StartScreen />}
    </div>
  );
}
