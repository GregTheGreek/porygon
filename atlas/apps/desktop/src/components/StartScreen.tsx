import { useState } from 'react';
import { useProjectStore } from '../store/project';
import { pickDirectory } from '../lib/api';

// Shown when no project is open: create/open actions plus the recents list.
export function StartScreen() {
  const recents = useProjectStore((s) => s.recents);
  const error = useProjectStore((s) => s.error);
  const createProject = useProjectStore((s) => s.createProject);
  const openProject = useProjectStore((s) => s.openProject);
  const [name, setName] = useState('');

  const handleCreate = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const location = await pickDirectory('Choose where to create the project');
    if (!location) return;
    await createProject(location, trimmed);
  };

  const handleOpen = async () => {
    const dir = await pickDirectory('Open a project folder');
    if (!dir) return;
    await openProject(dir);
  };

  return (
    <div className="flex min-h-0 flex-1 items-center justify-center bg-bg p-8">
      <div className="w-full max-w-md">
        <h1 className="text-2xl font-semibold text-fg">Porygon</h1>
        <p className="mt-1 text-sm text-fg-subtle">Object Authoring</p>

        <div className="mt-8 space-y-3">
          <div className="flex gap-2">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleCreate();
              }}
              placeholder="New project name"
              className="min-w-0 flex-1 rounded border border-bg-border bg-bg-input px-3 py-2 text-sm text-fg outline-none placeholder:text-fg-subtle focus:border-accent"
            />
            <button
              type="button"
              onClick={() => void handleCreate()}
              disabled={!name.trim()}
              className="shrink-0 rounded bg-accent px-3 py-2 text-sm font-medium text-white disabled:opacity-40"
            >
              Create Project
            </button>
          </div>

          <button
            type="button"
            onClick={() => void handleOpen()}
            className="w-full rounded border border-bg-border bg-bg-raised px-3 py-2 text-sm font-medium text-fg hover:border-accent"
          >
            Open Project
          </button>
        </div>

        {error && (
          <p className="mt-4 rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300">
            {error}
          </p>
        )}

        <div className="mt-8">
          <h2 className="text-xs font-medium uppercase tracking-wide text-fg-muted">
            Recent Projects
          </h2>
          {recents.length === 0 ? (
            <p className="mt-2 text-sm text-fg-subtle">No recent projects.</p>
          ) : (
            <ul className="mt-2 space-y-1">
              {recents.map((r) => (
                <li key={r.path}>
                  <button
                    type="button"
                    onClick={() => void openProject(r.path)}
                    className="w-full rounded px-2 py-1.5 text-left hover:bg-bg-raised"
                  >
                    <span className="block truncate text-sm text-fg">
                      {r.name}
                    </span>
                    <span className="block truncate font-mono text-xs text-fg-subtle">
                      {r.path}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
