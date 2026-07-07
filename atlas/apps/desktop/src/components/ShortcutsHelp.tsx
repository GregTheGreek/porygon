import { useEffect } from 'react';
import { buildCommands } from '../commands';
import { formatShortcut } from '../lib/shortcuts';
import { useUiStore } from '../store/ui';

// The keyboard shortcuts help sheet (M14), opened with cmd+/ or ?. It is
// generated from the same command registry the palette and shortcuts use, so it
// can never list a stale binding. Grouped by the registry's group field.
export function ShortcutsHelp() {
  const open = useUiStore((s) => s.helpOpen);
  const close = useUiStore((s) => s.closeHelp);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || ((e.metaKey || e.ctrlKey) && e.key === '/')) {
        e.preventDefault();
        close();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, close]);

  if (!open) return null;

  // Only commands that have a shortcut belong on the cheatsheet.
  const withKeys = buildCommands().filter((c) => c.shortcut);
  const groups: string[] = [];
  for (const c of withKeys) if (!groups.includes(c.group)) groups.push(c.group);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-8"
      onMouseDown={close}
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        className="max-h-[80vh] w-full max-w-xl overflow-auto rounded-lg border border-bg-border bg-bg-raised p-5 shadow-2xl"
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-fg">Keyboard Shortcuts</h2>
          <button
            type="button"
            onClick={close}
            title="Close"
            className="rounded px-2 py-0.5 text-xs text-fg-subtle hover:bg-bg-input hover:text-fg"
          >
            Esc
          </button>
        </div>

        <div className="grid grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-2">
          {groups.map((group) => (
            <div key={group}>
              <h3 className="mb-1.5 text-xs uppercase tracking-wide text-fg-muted">{group}</h3>
              <ul className="space-y-1">
                {withKeys
                  .filter((c) => c.group === group)
                  .map((c) => (
                    <li key={c.id} className="flex items-center justify-between gap-3 text-sm">
                      <span className="min-w-0 flex-1 truncate text-fg-muted">{c.title}</span>
                      {c.shortcut && (
                        <span className="shrink-0 rounded border border-bg-border bg-bg-input px-1.5 py-0.5 font-mono text-xs text-fg-subtle">
                          {formatShortcut(c.shortcut)}
                        </span>
                      )}
                    </li>
                  ))}
              </ul>
            </div>
          ))}
        </div>

        <p className="mt-4 text-xs text-fg-subtle">
          Canvas zoom: {formatShortcut({ mod: true, key: '=' })} /{' '}
          {formatShortcut({ mod: true, key: '-' })} zoom,{' '}
          {formatShortcut({ mod: true, key: '0' })} fit,{' '}
          {formatShortcut({ mod: true, key: '1' })} 100%. In Play mode, arrows or WASD walk.
        </p>
      </div>
    </div>
  );
}
