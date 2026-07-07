import { useEffect, useState } from 'react';
import { pickFile, verifyPorytiles, type BinaryStatus } from '../lib/api';
import {
  MIN_AUTOSAVE_MS,
  MAX_AUTOSAVE_MS,
  usePreferences,
} from '../store/preferences';
import { useUiStore } from '../store/ui';

// The Preferences dialog (M14): the proper home for the Porytiles binary path
// (previously only reachable from a compile error) plus the two settings that
// already had backing behavior - autosave pacing and default grid visibility.
// Persisted app-side via settings.rs. Deliberately small: no preference exists
// here without a behavior behind it.
export function Preferences() {
  const open = useUiStore((s) => s.preferencesOpen);
  const close = useUiStore((s) => s.closePreferences);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, close]);

  if (!open) return null;
  return <Dialog onClose={close} />;
}

function Dialog({ onClose }: { onClose: () => void }) {
  const settings = usePreferences((s) => s.settings);
  const save = usePreferences((s) => s.save);

  const [binary, setBinary] = useState<BinaryStatus | null>(null);
  const [debounceDraft, setDebounceDraft] = useState(String(settings.autosave_debounce_ms));

  useEffect(() => {
    setDebounceDraft(String(settings.autosave_debounce_ms));
  }, [settings.autosave_debounce_ms]);

  const refreshBinary = () => {
    verifyPorytiles()
      .then(setBinary)
      .catch((e) => setBinary({ ok: false, path: '', version: null, message: String(e) }));
  };
  useEffect(refreshBinary, []);

  const locatePorytiles = async () => {
    const path = await pickFile('Locate the porytiles binary');
    if (!path) return;
    await save({ porytiles_path: path });
    refreshBinary();
  };

  const useDefaultPorytiles = async () => {
    await save({ porytiles_path: null });
    refreshBinary();
  };

  const commitDebounce = () => {
    const parsed = Number(debounceDraft);
    if (Number.isFinite(parsed)) {
      void save({ autosave_debounce_ms: Math.round(parsed) });
    } else {
      setDebounceDraft(String(settings.autosave_debounce_ms));
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-8"
      onMouseDown={onClose}
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-lg border border-bg-border bg-bg-raised p-5 shadow-2xl"
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-fg">Preferences</h2>
          <button
            type="button"
            onClick={onClose}
            title="Close"
            className="rounded px-2 py-0.5 text-xs text-fg-subtle hover:bg-bg-input hover:text-fg"
          >
            Esc
          </button>
        </div>

        <div className="space-y-5">
          <section>
            <h3 className="text-xs uppercase tracking-wide text-fg-muted">Porytiles binary</h3>
            <p className="mt-1 truncate font-mono text-xs text-fg-subtle" title={binary?.path}>
              {binary?.path || 'Default location'}
            </p>
            {binary && (
              <p className={`mt-1 text-xs ${binary.ok ? 'text-green-300' : 'text-amber-300'}`}>
                {binary.ok
                  ? `Ready${binary.version ? ` (v${binary.version})` : ''}`
                  : binary.message}
              </p>
            )}
            <div className="mt-2 flex items-center gap-2">
              <button
                type="button"
                onClick={() => void locatePorytiles()}
                className="rounded border border-bg-border bg-bg-input px-2.5 py-1 text-xs text-fg hover:border-accent"
              >
                Locate…
              </button>
              {settings.porytiles_path && (
                <button
                  type="button"
                  onClick={() => void useDefaultPorytiles()}
                  className="rounded px-2 py-1 text-xs text-fg-subtle hover:bg-bg-input hover:text-fg"
                >
                  Use default
                </button>
              )}
            </div>
          </section>

          <section>
            <label className="block text-xs uppercase tracking-wide text-fg-muted">
              Autosave delay
            </label>
            <div className="mt-1 flex items-center gap-2">
              <input
                type="number"
                value={debounceDraft}
                min={MIN_AUTOSAVE_MS}
                max={MAX_AUTOSAVE_MS}
                step={250}
                onChange={(e) => setDebounceDraft(e.target.value)}
                onBlur={commitDebounce}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.currentTarget.blur();
                }}
                className="w-28 rounded border border-bg-border bg-bg-input px-2 py-1 font-mono text-sm text-fg outline-none focus:border-accent"
              />
              <span className="text-xs text-fg-subtle">
                ms after an edit ({MIN_AUTOSAVE_MS}–{MAX_AUTOSAVE_MS})
              </span>
            </div>
          </section>

          <section>
            <label className="flex items-center gap-2 text-sm text-fg">
              <input
                type="checkbox"
                checked={settings.default_grid}
                onChange={(e) => void save({ default_grid: e.target.checked })}
                className="accent-accent"
              />
              Show the 16px metatile grid by default
            </label>
          </section>
        </div>
      </div>
    </div>
  );
}
