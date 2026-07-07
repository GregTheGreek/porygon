import { useEffect, useMemo, useRef, useState } from 'react';
import { buildCommands, type Command } from '../commands';
import { formatShortcut } from '../lib/shortcuts';
import { useUiStore } from '../store/ui';

// The cmd+K command palette (M14): a fuzzy search over the command registry,
// showing only commands available in the current context. Keyboard-first:
// type to filter, up/down to move, Enter to run, Escape (or cmd+K) to close.
export function CommandPalette() {
  const open = useUiStore((s) => s.paletteOpen);
  if (!open) return null;
  return <Palette />;
}

// A subsequence fuzzy match. Returns a score (higher = better, adjacency
// rewarded) or null when the query is not a subsequence of the text.
function fuzzyScore(query: string, text: string): number | null {
  if (!query) return 0;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  let qi = 0;
  let score = 0;
  let last = -2;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      score += ti === last + 1 ? 2 : 1;
      last = ti;
      qi++;
    }
  }
  return qi === q.length ? score : null;
}

function Palette() {
  const close = useUiStore((s) => s.closePalette);
  const toggle = useUiStore((s) => s.togglePalette);
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);

  // Snapshot the enabled commands once on open; contexts do not shift while the
  // palette holds the keyboard.
  const commands = useMemo(() => buildCommands().filter((c) => c.enabled()), []);

  const results = useMemo(() => {
    if (!query.trim()) return commands;
    return commands
      .map((c) => ({ c, s: fuzzyScore(query.trim(), `${c.title} ${c.keywords ?? ''}`) }))
      .filter((r): r is { c: Command; s: number } => r.s !== null)
      .sort((a, b) => b.s - a.s)
      .map((r) => r.c);
  }, [commands, query]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  useEffect(() => {
    setActive(0);
  }, [query]);

  const run = (cmd: Command | undefined) => {
    if (!cmd) return;
    close();
    void cmd.run();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      toggle();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => (results.length ? (a + 1) % results.length : 0));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => (results.length ? (a - 1 + results.length) % results.length : 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      run(results[active]);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-[12vh]"
      onMouseDown={close}
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
        className="w-full max-w-lg overflow-hidden rounded-lg border border-bg-border bg-bg-raised shadow-2xl"
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Type a command…"
          className="w-full border-b border-bg-border bg-transparent px-4 py-3 text-sm text-fg outline-none placeholder:text-fg-subtle"
        />
        <ul className="max-h-80 overflow-auto py-1">
          {results.length === 0 ? (
            <li className="px-4 py-3 text-sm text-fg-subtle">No matching commands.</li>
          ) : (
            results.map((cmd, i) => (
              <li key={cmd.id}>
                <button
                  type="button"
                  onMouseEnter={() => setActive(i)}
                  onClick={() => run(cmd)}
                  className={`flex w-full items-center gap-3 px-4 py-2 text-left text-sm ${
                    active === i ? 'bg-accent/25 text-fg' : 'text-fg-muted'
                  }`}
                >
                  <span className="min-w-0 flex-1 truncate">{cmd.title}</span>
                  <span className="shrink-0 text-xs uppercase tracking-wide text-fg-subtle">
                    {cmd.group}
                  </span>
                  {cmd.shortcut && (
                    <span className="shrink-0 rounded border border-bg-border bg-bg-input px-1.5 py-0.5 font-mono text-xs text-fg-subtle">
                      {formatShortcut(cmd.shortcut)}
                    </span>
                  )}
                </button>
              </li>
            ))
          )}
        </ul>
      </div>
    </div>
  );
}
